'use strict';
/**
 * services/financeiroService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Controle financeiro integrado com vendas e estoque.
 *
 * Fluxo automático:
 *   Venda finalizada → registrarReceita (evento venda:finalizada)
 *   Venda cancelada  → registrarEstorno  (evento venda:cancelada)
 *   Entrada estoque  → registrarDespesa  (custo de compra)
 *
 * Modelo de lançamento:
 *   {
 *     id:        string
 *     tipo:      'receita' | 'despesa' | 'estorno'
 *     categoria: string  ('venda', 'compra', 'avaria', 'ajuste', 'outro')
 *     descricao: string
 *     valor:     number  (sempre positivo; tipo define o sinal)
 *     formaPgto: string?
 *     referencia:string? (vendaId, movimentacaoId, etc.)
 *     operador:  string
 *     data:      string  (ISO)
 *     dataCurta: string  (YYYY-MM-DD)
 *     hora:      string
 *   }
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Registrar lançamento ──────────────────────────────────────────
  function _lancar({ tipo, categoria, descricao, valor, formaPgto = '', referencia = '', extra = {} }) {
    if (!valor || valor <= 0) return null;

    const lancamento = {
      id:         Utils.generateId(),
      tipo,       // 'receita' | 'despesa' | 'estorno'
      categoria,  // 'venda' | 'compra' | 'avaria' | 'outro'
      descricao,
      valor:      Number(valor),
      formaPgto,
      referencia,
      operador:   AuthService.getNome(),
      data:       Utils.nowISO(),
      dataCurta:  Utils.todayISO(),
      hora:       Utils.nowTime(),
      ...extra,
    };

    Store.mutateFinanceiro(fin => { fin.unshift(lancamento); });
    EventBus.emit('financeiro:lancado', lancamento);
    return lancamento;
  }

  // ── Receitas ──────────────────────────────────────────────────────

  /** Registra receita de uma venda */
  function registrarReceita(venda) {
    return _lancar({
      tipo:       'receita',
      categoria:  'venda',
      descricao:  `Venda #${venda.id.slice(-6)} — ${venda.itens?.length || 0} item(ns)`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
      extra: {
        lucro:   venda.lucro || 0,
        itens:   venda.itens?.length || 0,
        vendaId: venda.id,
      },
    });
  }

  /** Registra estorno de uma venda cancelada */
  function registrarEstorno(venda) {
    return _lancar({
      tipo:       'estorno',
      categoria:  'cancelamento',
      descricao:  `Estorno venda #${venda.id.slice(-6)}`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
    });
  }

  // ── Despesas ──────────────────────────────────────────────────────

  /** Registra despesa manualmente */
  function registrarDespesa({ descricao, valor, categoria = 'outro', formaPgto = '', referencia = '' }) {
    return _lancar({ tipo: 'despesa', categoria, descricao, valor, formaPgto, referencia });
  }

  /** Registra custo de entrada de estoque */
  function registrarCustoCompra(mov) {
    const custo = Math.abs(mov.custo || 0) * Math.abs(mov.quantidade || 0);
    if (!custo) return null;
    return _lancar({
      tipo:       'despesa',
      categoria:  'compra',
      descricao:  `Compra: ${mov.nomeProduto} (${Math.abs(mov.quantidade)} un.)`,
      valor:      custo,
      referencia: mov.id,
    });
  }

  // ── Consultas ─────────────────────────────────────────────────────

  function getLancamentos({ tipo, categoria, dataDe, dataAte, limit = 500 } = {}) {
    let fin = Store.getFinanceiro();
    if (tipo)      fin = fin.filter(l => l.tipo      === tipo);
    if (categoria) fin = fin.filter(l => l.categoria === categoria);
    if (dataDe)    fin = fin.filter(l => l.dataCurta >= dataDe);
    if (dataAte)   fin = fin.filter(l => l.dataCurta <= dataAte);
    return fin.slice(0, limit);
  }

  function getCaixaDia(data = Utils.todayISO()) {
    const lancamentos = getLancamentos({ dataDe: data, dataAte: data });

    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const estornos = lancamentos.filter(l => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);

    // Agrupamento por forma de pagamento (receitas)
    const porForma = {};
    lancamentos.filter(l => l.tipo === 'receita').forEach(l => {
      const f = l.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + l.valor;
    });

    return {
      data,
      receitas,
      despesas,
      estornos,
      saldo:  receitas - despesas - estornos,
      lucro,
      lancamentos,
      porForma,
    };
  }

  function getFluxoCaixa(dataDe, dataAte) {
    // Agrupa por dia
    const dias = {};
    getLancamentos({ dataDe, dataAte }).forEach(l => {
      if (!dias[l.dataCurta]) {
        dias[l.dataCurta] = { data: l.dataCurta, receitas: 0, despesas: 0, estornos: 0, lucro: 0 };
      }
      if (l.tipo === 'receita') { dias[l.dataCurta].receitas += l.valor; dias[l.dataCurta].lucro += (l.lucro || 0); }
      if (l.tipo === 'despesa') dias[l.dataCurta].despesas += l.valor;
      if (l.tipo === 'estorno') dias[l.dataCurta].estornos += l.valor;
    });

    return Object.values(dias)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map(d => ({ ...d, saldo: d.receitas - d.despesas - d.estornos }));
  }

  function getResumoMes(ano = new Date().getFullYear(), mes = new Date().getMonth() + 1) {
    const dataDe = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const dataAte = `${ano}-${String(mes).padStart(2,'0')}-31`;
    const caixa  = getCaixaDia(dataDe); // usa range
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);
    return { mes: `${ano}-${String(mes).padStart(2,'0')}`, receitas, despesas, saldo: receitas - despesas, lucro };
  }

  // Exportar CSV
  function exportarCSV(dataDe, dataAte) {
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const header = ['data','hora','tipo','categoria','descricao','valor','formaPgto','operador'];
    const rows = lancamentos.map(l =>
      header.map(k => `"${String(l[k] !== undefined ? l[k] : '').replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    Utils.downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8', `financeiro_${Utils.todayISO()}.csv`);
  }

  // ── Hooks automáticos ─────────────────────────────────────────────
  EventBus.on('venda:finalizada',     venda => registrarReceita(venda));
  EventBus.on('venda:cancelada',      ({ vendaId }) => {
    const venda = window.CH.Store.getVendas().find(v => v.id === vendaId);
    if (venda) registrarEstorno(venda);
  });
  EventBus.on('estoque:movimentado',  mov => {
    if (mov.tipo === 'entrada') registrarCustoCompra(mov);
  });

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.FinanceiroService = {
    registrarReceita,
    registrarEstorno,
    registrarDespesa,
    registrarCustoCompra,
    getLancamentos,
    getCaixaDia,
    getFluxoCaixa,
    getResumoMes,
    exportarCSV,
  };

  console.info('%c FinanceiroService ✓  (Integrado com vendas + estoque)', 'color:#10b981');
})();
