'use strict';
/**
 * services/auditService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Auditoria completa de todas as operações do sistema.
 *
 * Modelo de cada registro:
 *   {
 *     id:        string
 *     acao:      string  ('criar', 'editar', 'deletar', 'venda', 'login', ...)
 *     modulo:    string  ('estoque', 'vendas', 'financeiro', 'auth', ...)
 *     usuario:   string  (nome do operador)
 *     role:      string  ('admin', 'pdv', ...)
 *     antes:     any?    (estado antes da operação)
 *     depois:    any?    (estado após a operação)
 *     resumo:    string? (descrição legível)
 *     data:      string  (ISO)
 *     dataCurta: string  (YYYY-MM-DD)
 *     hora:      string  (HH:MM)
 *     device:    string  (userAgent resumido)
 *     ip:        string? (não disponível no browser sem backend)
 *   }
 *
 * Requer: core.js carregado antes (window.CH disponível)
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Device fingerprint (sem dados pessoais) ──────────────────────
  function _getDevice() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua))   return 'Android';
    if (/iPhone|iPad/i.test(ua))return 'iOS';
    if (/Windows/i.test(ua))   return 'Windows';
    if (/Mac/i.test(ua))       return 'macOS';
    if (/Linux/i.test(ua))     return 'Linux';
    return 'Desconhecido';
  }

  // ── Registrar ────────────────────────────────────────────────────
  /**
   * @param {string} acao   - 'criar' | 'editar' | 'deletar' | 'venda' | 'login' | ...
   * @param {string} modulo - 'estoque' | 'vendas' | 'financeiro' | 'auth' | ...
   * @param {object} opts   - { antes, depois, resumo, extra }
   */
  function registrar(acao, modulo, opts = {}) {
    const { antes = null, depois = null, resumo = '', extra = {} } = opts;

    const reg = {
      id:        Utils.generateId(),
      acao,
      modulo,
      usuario:   AuthService.getNome(),
      role:      AuthService.getRole() || 'desconhecido',
      antes:     antes  ? _sanitize(antes)  : null,
      depois:    depois ? _sanitize(depois) : null,
      resumo:    resumo || `${acao} em ${modulo}`,
      data:      Utils.nowISO(),
      dataCurta: Utils.todayISO(),
      hora:      Utils.nowTime(),
      device:    _getDevice(),
      ...extra,
    };

    Store.mutateAuditoria(audit => {
      audit.unshift(reg);
    });

    EventBus.emit('auditoria:registrada', reg);
    return reg;
  }

  // ── Helpers de auditoria por módulo ─────────────────────────────
  function auditarEstoque(acao, produtoAntes, produtoDepois, resumo = '') {
    return registrar(acao, 'estoque', {
      antes:  produtoAntes ? _produtoResumido(produtoAntes)  : null,
      depois: produtoDepois ? _produtoResumido(produtoDepois) : null,
      resumo: resumo || _resumoEstoque(acao, produtoAntes, produtoDepois),
    });
  }

  function auditarVenda(venda) {
    return registrar('venda', 'vendas', {
      depois: {
        id:         venda.id,
        total:      venda.total,
        formaPgto:  venda.formaPgto,
        itens:      venda.itens?.length || 0,
        operador:   venda.operador,
      },
      resumo: `Venda ${Utils.formatCurrency(venda.total)} — ${venda.formaPgto} — ${venda.itens?.length || 0} item(ns)`,
    });
  }

  function auditarLogin(role) {
    return registrar('login', 'auth', {
      depois: { role },
      resumo: `Login como ${role}`,
    });
  }

  function auditarMovimentacao(mov) {
    return registrar('movimentacao', 'estoque', {
      depois: {
        produto:       mov.nomeProduto,
        tipo:          mov.tipo,
        quantidade:    mov.quantidade,
        estoqueAntes:  mov.estoqueAntes,
        estoqueDepois: mov.estoqueDepois,
      },
      resumo: `${mov.tipo} de ${Math.abs(mov.quantidade)} un. — ${mov.nomeProduto} (${mov.estoqueAntes}→${mov.estoqueDepois})`,
    });
  }

  function auditarFinanceiro(operacao, dados) {
    return registrar(operacao, 'financeiro', {
      depois: dados,
      resumo: `${operacao} financeiro: ${Utils.formatCurrency(dados?.valor || 0)}`,
    });
  }

  // ── Consultas ─────────────────────────────────────────────────────
  function getHistorico({ modulo, acao, usuario, dataDe, dataAte, limit = 200 } = {}) {
    let audit = Store.getAuditoria();

    if (modulo)  audit = audit.filter(r => r.modulo  === modulo);
    if (acao)    audit = audit.filter(r => r.acao    === acao);
    if (usuario) audit = audit.filter(r => r.usuario === usuario);
    if (dataDe)  audit = audit.filter(r => r.dataCurta >= dataDe);
    if (dataAte) audit = audit.filter(r => r.dataCurta <= dataAte);

    return audit.slice(0, limit);
  }

  function getHoje() {
    return getHistorico({ dataDe: Utils.todayISO(), dataAte: Utils.todayISO() });
  }

  function getModulos() {
    return [...new Set(Store.getAuditoria().map(r => r.modulo))];
  }

  // Exportar CSV
  function exportarCSV() {
    const audit = Store.getAuditoria();
    const header = ['data','hora','acao','modulo','usuario','role','resumo','device'];
    const rows   = audit.map(r => header.map(k => `"${String(r[k]||'').replace(/"/g,'""')}"`).join(','));
    const csv    = [header.join(','), ...rows].join('\n');
    Utils.downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8', `auditoria_${Utils.todayISO()}.csv`);
    return audit.length;
  }

  // ── Utils internos ────────────────────────────────────────────────
  function _sanitize(obj) {
    // Remove campos pesados para não inchar a auditoria
    if (!obj || typeof obj !== 'object') return obj;
    const { _fbSynced, syncedAt, ...rest } = obj;
    return rest;
  }

  function _produtoResumido(p) {
    return { id: p.id, nome: p.nome, qtdUn: p.qtdUn, precoUn: p.precoUn, custoUn: p.custoUn };
  }

  function _resumoEstoque(acao, antes, depois) {
    const nome = depois?.nome || antes?.nome || '?';
    if (acao === 'criar')  return `Produto criado: ${nome}`;
    if (acao === 'editar') {
      const diff = [];
      if (antes?.qtdUn  !== depois?.qtdUn)  diff.push(`qtd: ${antes?.qtdUn}→${depois?.qtdUn}`);
      if (antes?.precoUn !== depois?.precoUn) diff.push(`preço: ${Utils.formatCurrency(antes?.precoUn)}→${Utils.formatCurrency(depois?.precoUn)}`);
      return `Produto editado: ${nome}${diff.length ? ' — ' + diff.join(', ') : ''}`;
    }
    if (acao === 'deletar') return `Produto removido: ${nome}`;
    return `${acao}: ${nome}`;
  }

  // ── Hooks automáticos ────────────────────────────────────────────
  EventBus.on('venda:finalizada',   venda => auditarVenda(venda));
  EventBus.on('auth:login',         ({ role }) => auditarLogin(role));
  EventBus.on('estoque:movimentado',mov  => auditarMovimentacao(mov));

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.AuditService = {
    registrar,
    auditarEstoque,
    auditarVenda,
    auditarLogin,
    auditarMovimentacao,
    auditarFinanceiro,
    getHistorico,
    getHoje,
    getModulos,
    exportarCSV,
  };

  console.info('%c AuditService ✓', 'color:#10b981');
})();
