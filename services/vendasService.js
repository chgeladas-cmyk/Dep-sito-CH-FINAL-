'use strict';
/**
 * services/vendasService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de domínio para vendas.
 *
 * Integração automática:
 *   Venda finalizada → EstoqueService.baixarEstoqueVenda (Firebase Transaction)
 *                   → FinanceiroService.registrarReceita
 *                   → AuditService.auditarVenda
 *                   → TelegramService.notificarVenda
 *
 * Requer: core.js + estoqueService.js + financeiroService.js carregados antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, CartService } = window.CH;

  // ════════════════════════════════════════════════════════════════
  //  FINALIZAR VENDA (substitui CartService.finalize)
  // ════════════════════════════════════════════════════════════════

  /**
   * Finaliza uma venda com integração total:
   *   1. Cria o registro de venda
   *   2. Para cada item: baixa estoque via Firebase Transaction
   *   3. Registra no financeiro
   *   4. Emite evento para Telegram, Auditoria etc.
   *
   * @param {CartService|object} cart - instância do CartService ou objeto {itens, total, ...}
   * @param {string} formaPgto
   * @returns {Promise<object>} venda finalizada
   */
  async function finalizarVenda(cart, formaPgto) {
    const itens    = cart.getItems ? cart.getItems()    : (cart.itens    || []);
    const total    = cart.getTotal ? cart.getTotal()    : (cart.total    || 0);
    const subtotal = cart.getSubtotal ? cart.getSubtotal() : (cart.subtotal || total);
    const desconto = cart.getDesconto ? cart.getDesconto() : (cart.desconto || 0);

    if (!itens.length) throw new Error('Carrinho vazio');

    const lucro = itens.reduce((s, i) => s + (i.preco - (i.custo || 0)) * i.qtd, 0) - desconto;

    const venda = {
      id:        Utils.generateId(),
      dataCurta: Utils.todayISO(),
      data:      Utils.today(),
      hora:      Utils.nowTime(),
      criadoEm:  Utils.nowISO(),
      itens,
      total,
      subtotal,
      desconto,
      lucro,
      formaPgto: formaPgto || 'Dinheiro',
      origem:    'PDV',
      operador:  AuthService.getNome(),
      role:      AuthService.getRole(),
      status:    'concluida',
      _fbSynced: false,
    };

    // 1. Salva venda no Store
    Store.mutateVendas(vendas => { vendas.unshift(venda); });

    // 2. Baixa estoque via Firebase Transaction para cada item
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      const erros = [];
      for (const item of itens) {
        try {
          // Calcula quantas unidades reais sair do estoque
          const prod  = EstoqueService.getProduto(item.prodId);
          const qtdUn = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (prod?.packs?.find(pk => pk.label === item.label)?.qtd || 1);

          await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
        } catch(e) {
          erros.push({ item: item.nome, erro: e.message });
          console.warn(`[Vendas] Baixa de estoque falhou para "${item.nome}":`, e.message);
        }
      }
      if (erros.length) {
        // Registra no audit mas não bloqueia a venda
        console.warn('[Vendas] Estoque com erros parciais:', erros);
      }
    } else {
      // Fallback: baixa direta no Store (sem transaction)
      Store.mutateEstoque(estoque => {
        itens.forEach(item => {
          const prod = estoque.find(p => p.id === item.prodId);
          if (!prod) return;
          const qtdDesconto = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
          prod.qtdUn        = Math.max(0, (prod.qtdUn || 0) - qtdDesconto);
          prod.estoqueAtual = prod.qtdUn;
        });
      });
    }

    // 3. Integra com financeiro
    const FinanceiroService = window.CH.FinanceiroService;
    if (FinanceiroService) {
      FinanceiroService.registrarReceita(venda);
    }

    // 4. Limpa carrinho
    if (cart.clear) cart.clear();

    // 5. Emite evento (Telegram, Audit, etc. ouvem)
    EventBus.emit('venda:finalizada', venda);

    return venda;
  }

  // ════════════════════════════════════════════════════════════════
  //  CANCELAR VENDA
  // ════════════════════════════════════════════════════════════════

  async function cancelarVenda(vendaId) {
    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda)  throw new Error(`Venda ${vendaId} não encontrada`);
    if (venda.status === 'cancelada') throw new Error('Venda já cancelada');

    // Estorna estoque
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      await EstoqueService.cancelarVenda(vendaId, venda.itens || []);
    }

    // Atualiza status
    Store.mutateVendas(vendas => {
      const v = vendas.find(v => v.id === vendaId);
      if (v) { v.status = 'cancelada'; v.canceladaEm = Utils.nowISO(); v.canceladaPor = AuthService.getNome(); }
    });

    // Estorna financeiro
    const FinanceiroService = window.CH.FinanceiroService;
    if (FinanceiroService) {
      FinanceiroService.registrarEstorno(venda);
    }

    EventBus.emit('venda:cancelada', { vendaId, operador: AuthService.getNome() });
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ════════════════════════════════════════════════════════════════

  function getVendasPeriodo(dataDe, dataAte) {
    return Store.getVendas().filter(v =>
      v.dataCurta >= dataDe && v.dataCurta <= dataAte
    );
  }

  function getVendasHoje() {
    const hoje = Utils.todayISO();
    return getVendasPeriodo(hoje, hoje);
  }

  function getResumoHoje() {
    const vendas  = getVendasHoje().filter(v => v.status !== 'cancelada');
    const total   = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const lucro   = vendas.reduce((s, v) => s + (v.lucro || 0), 0);
    const qtdItens= vendas.reduce((s, v) => s + (v.itens?.reduce((si, i) => si + i.qtd, 0) || 0), 0);

    // Agrupamento por forma de pagamento
    const porForma = {};
    vendas.forEach(v => {
      const f = v.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + v.total;
    });

    return {
      quantidade:  vendas.length,
      total,
      lucro,
      qtdItens,
      ticketMedio: vendas.length ? total / vendas.length : 0,
      porForma,
    };
  }

  function getResumoSemana() {
    const hoje   = new Date();
    const dom    = new Date(hoje);
    dom.setDate(hoje.getDate() - hoje.getDay());
    const dataDe = dom.toISOString().slice(0, 10);
    const vendas = getVendasPeriodo(dataDe, Utils.todayISO()).filter(v => v.status !== 'cancelada');
    return {
      quantidade: vendas.length,
      total:      vendas.reduce((s, v) => s + v.total, 0),
      lucro:      vendas.reduce((s, v) => s + (v.lucro || 0), 0),
    };
  }

  function getProdutosMaisVendidos(limite = 10, periodo = 30) {
    const dataMinima = new Date();
    dataMinima.setDate(dataMinima.getDate() - periodo);
    const dataDe = dataMinima.toISOString().slice(0, 10);

    const vendas = getVendasPeriodo(dataDe, Utils.todayISO()).filter(v => v.status !== 'cancelada');
    const mapa   = {};

    vendas.forEach(venda => {
      venda.itens?.forEach(item => {
        if (!mapa[item.prodId]) {
          mapa[item.prodId] = { prodId: item.prodId, nome: item.nome, qtd: 0, total: 0 };
        }
        mapa[item.prodId].qtd   += item.qtd;
        mapa[item.prodId].total += item.preco * item.qtd;
      });
    });

    return Object.values(mapa)
      .sort((a, b) => b.qtd - a.qtd)
      .slice(0, limite);
  }

  // ── Plugar CartService (sobrescreve finalize) ─────────────────────
  // CartService.finalize() agora delega para cá automaticamente
  // (já está configurado no core.js via check de window.CH.VendasService)

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.VendasService = {
    finalizarVenda,
    cancelarVenda,
    getVendasPeriodo,
    getVendasHoje,
    getResumoHoje,
    getResumoSemana,
    getProdutosMaisVendidos,
  };

  console.info('%c VendasService ✓  (Transactions + Estoque + Financeiro)', 'color:#10b981');
})();
