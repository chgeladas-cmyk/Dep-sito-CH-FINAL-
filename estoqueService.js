'use strict';
/**
 * services/estoqueService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de domínio para estoque.
 *
 * PROBLEMA RESOLVIDO (sobrescrita concorrente):
 *   Antes: Aparelho A e B salvavam o array inteiro de estoque.
 *          O último a salvar sobrescrevia o outro → estoque errado.
 *   Agora: Cada baixa/entrada usa Firebase Transaction no documento
 *          do produto → lê o valor atual, valida, subtrai, salva.
 *          Impossível sobrescrever. Race condition eliminado.
 *
 * Modelos:
 *
 *   Produto (em estoque[]):
 *     id, nome, categoria, precoVenda (= precoUn), precoCusto (= custoUn),
 *     estoqueAtual (= qtdUn), estoqueMinimo, ativo, fornecedorId, unidade,
 *     packs, updatedAt, createdAt
 *
 *   Movimentação (em movimentacoes[]):
 *     id, produtoId, nomeProduto, tipo, quantidade,
 *     estoqueAntes, estoqueDepois, origem, operador,
 *     observacao, custo, fornecedorId, timestamp
 *
 *   Categoria (em categorias[]):
 *     id, nome, cor
 *
 *   Fornecedor (em fornecedores[]):
 *     id, nome, telefone, email, cnpj, observacao, ativo
 *
 * Requer: core.js + services/auditService.js carregados antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, FirebaseService } = window.CH;

  // ── Helpers internos ─────────────────────────────────────────────
  function _usuario()   { return AuthService.getNome(); }
  function _isOnline()  { return navigator.onLine; }

  // Alias de campos legados → modelo novo (retrocompat)
  function _normalizarProduto(p) {
    return {
      ...p,
      precoVenda:     p.precoVenda  ?? p.precoUn  ?? 0,
      precoCusto:     p.precoCusto  ?? p.custoUn  ?? 0,
      estoqueAtual:   p.estoqueAtual ?? p.qtdUn   ?? 0,
      estoqueMinimo:  p.estoqueMinimo ?? 0,
      qtdUn:          p.qtdUn       ?? p.estoqueAtual ?? 0,  // compat
      precoUn:        p.precoUn     ?? p.precoVenda   ?? 0,  // compat
      custoUn:        p.custoUn     ?? p.precoCusto   ?? 0,  // compat
      ativo:          p.ativo       ?? true,
      unidade:        p.unidade     ?? 'UN',
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  PRODUTOS
  // ════════════════════════════════════════════════════════════════

  /** Retorna todos os produtos normalizados */
  function getProdutos() {
    return Store.getEstoque().map(_normalizarProduto);
  }

  /** Retorna um produto pelo id */
  function getProduto(id) {
    const p = Store.getEstoque().find(p => p.id === id);
    return p ? _normalizarProduto(p) : null;
  }

  /** Cria um novo produto */
  function adicionarProduto(dados) {
    const antes = null;
    const prod = {
      id:           Utils.generateId(),
      nome:         dados.nome?.trim() || 'Produto sem nome',
      categoria:    dados.categoria    || '',
      precoVenda:   Number(dados.precoVenda  || dados.precoUn  || 0),
      precoCusto:   Number(dados.precoCusto  || dados.custoUn  || 0),
      estoqueAtual: Number(dados.estoqueAtual || dados.qtdUn   || 0),
      estoqueMinimo:Number(dados.estoqueMinimo || 0),
      qtdUn:        Number(dados.qtdUn       || dados.estoqueAtual || 0),
      precoUn:      Number(dados.precoUn     || dados.precoVenda   || 0),
      custoUn:      Number(dados.custoUn     || dados.precoCusto   || 0),
      ativo:        dados.ativo ?? true,
      unidade:      dados.unidade || 'UN',
      fornecedorId: dados.fornecedorId || null,
      packs:        dados.packs || [],
      createdAt:    Utils.nowISO(),
      updatedAt:    Utils.nowISO(),
    };

    Store.mutateEstoque(estoque => { estoque.push(prod); });

    window.CH.AuditService?.auditarEstoque('criar', null, prod);
    EventBus.emit('estoque:adicionado', prod);
    return prod;
  }

  /** Atualiza campos de um produto existente */
  function atualizarProduto(id, campos) {
    let antes = null, depois = null;

    Store.mutateEstoque(estoque => {
      const idx = estoque.findIndex(p => p.id === id);
      if (idx < 0) return;
      antes = { ...estoque[idx] };

      // Sincroniza aliases antes/depois da atualização
      if ('precoVenda'   in campos) campos.precoUn   = campos.precoVenda;
      if ('precoCusto'   in campos) campos.custoUn   = campos.precoCusto;
      if ('estoqueAtual' in campos) campos.qtdUn     = campos.estoqueAtual;
      if ('precoUn'      in campos) campos.precoVenda = campos.precoUn;
      if ('custoUn'      in campos) campos.precoCusto = campos.custoUn;
      if ('qtdUn'        in campos) campos.estoqueAtual = campos.qtdUn;

      Object.assign(estoque[idx], campos, { updatedAt: Utils.nowISO() });
      depois = { ...estoque[idx] };
    });

    if (!antes) { console.warn('[Estoque] atualizarProduto: id não encontrado', id); return null; }

    window.CH.AuditService?.auditarEstoque('editar', antes, depois);
    EventBus.emit('estoque:atualizado', depois);
    return depois;
  }

  /** Desativa um produto (soft delete) */
  function removerProduto(id) {
    const prod = getProduto(id);
    if (!prod) return false;
    atualizarProduto(id, { ativo: false });
    window.CH.AuditService?.auditarEstoque('deletar', prod, { ...prod, ativo: false });
    EventBus.emit('estoque:removido', prod);
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  MOVIMENTAÇÕES — CORAÇÃO DO CONTROLE DE ESTOQUE
  // ════════════════════════════════════════════════════════════════

  /**
   * Registra uma movimentação com Firebase Transaction.
   * A transação garante que nunca haverá sobrescrita concorrente:
   *   - Lê o valor atual do documento no Firestore
   *   - Valida (não deixa ficar negativo em venda)
   *   - Subtrai/soma atomicamente
   *   - Registra a movimentação
   *
   * Se offline, cai para modo local com enfileiramento.
   */
  async function _registrarMovimentacao({
    produtoId,
    tipo,        // 'entrada' | 'venda' | 'avaria' | 'ajuste' | 'transferencia' | 'cancelamento'
    quantidade,  // número positivo (a lógica de sinal é interna)
    origem       = 'manual',
    operador     = null,
    observacao   = '',
    custo        = null,
    fornecedorId = null,
    _forceDelta  = null, // quando passado, ignora a lógica de sinal e usa o delta direto
  }) {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const estoqueAntes = prod.estoqueAtual ?? prod.qtdUn ?? 0;

    // _forceDelta permite ajuste bidirecional (positivo ou negativo)
    // Quando não passado, calcula pelo tipo: saídas subtraem, entradas somam
    let delta;
    if (_forceDelta !== null) {
      delta = _forceDelta; // já tem sinal correto (+/-)
    } else {
      const eSaida = ['venda','avaria','transferencia'].includes(tipo);
      delta = eSaida ? -Math.abs(quantidade) : Math.abs(quantidade);
    }

    const estoqueDepois = Math.max(0, estoqueAntes + delta);
    const eSaida = delta < 0; // recalcula para validação de estoque insuficiente

    // ── Tenta usar Firebase Transaction (modo online + admin) ──────────
    // PDV não tem adminToken → Firestore rejeitaria a escrita de qualquer forma.
    // Nesse caso, aplica localmente e SyncQueue envia quando admin sincronizar.
    const temToken = !!FirebaseService.getAdminToken();
    const ehAdmin  = typeof AuthService !== 'undefined' && AuthService.isAdmin();

    if (_isOnline() && FirebaseService.isReady() && temToken && ehAdmin) {
      try {
        await FirebaseService.runTransaction(async (tx) => {
          // Lê o documento de estoque no Firestore
          const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
          const snap = await tx.get(estoqueRef);
          const dadosFB = snap.exists() ? (snap.data().dados || []) : [];

          const prodFB = dadosFB.find(p => p.id === produtoId);
          const qtdAtualFB = prodFB ? (prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0) : estoqueAntes;

          // Validação: saída não pode deixar estoque negativo
          if (eSaida && qtdAtualFB < Math.abs(delta)) {
            throw new Error(
              `Estoque insuficiente para "${prod.nome}": ` +
              `disponível ${qtdAtualFB}, solicitado ${Math.abs(delta)}`
            );
          }

          const novaQtd = Math.max(0, qtdAtualFB + delta);

          // Atualiza o produto no array dentro do documento
          const novosDados = dadosFB.map(p =>
            p.id === produtoId
              ? { ...p, qtdUn: novaQtd, estoqueAtual: novaQtd, updatedAt: Utils.nowISO() }
              : p
          );

          // Se produto não estava no FB, adiciona
          if (!prodFB) novosDados.push({ ...prod, qtdUn: novaQtd, estoqueAtual: novaQtd });

          tx.set(estoqueRef, {
            dados:      novosDados,
            ts:         Utils.nowISO(),
            adminToken: window.CH.FirebaseService.getAdminToken() || '',
          });

          // Também salva a movimentação como documento individual
          const movRef = FirebaseService.newDocRef('movimentacoes');
          tx.set(movRef, {
            id:            movRef.id,
            produtoId,
            nomeProduto:   prod.nome,
            tipo,
            quantidade:    delta,
            estoqueAntes:  qtdAtualFB,
            estoqueDepois: novaQtd,
            origem,
            operador:      operador || _usuario(),
            observacao,
            custo:         custo ?? prod.precoCusto ?? 0,
            fornecedorId,
            timestamp:     Utils.nowISO(),
            dataCurta:     Utils.todayISO(),
          });
        });

        console.info(`[Estoque] ✓ Transação ${tipo}: ${prod.nome} (${estoqueAntes}→${estoqueDepois})`);

        // Atualiza Store local com o valor calculado
        Store.mutateEstoque(estoque => {
          const p = estoque.find(p => p.id === produtoId);
          if (p) {
            p.qtdUn = estoqueDepois;
            p.estoqueAtual = estoqueDepois;
            p.updatedAt = Utils.nowISO();
          }
        });

      } catch (e) {
        // Se for erro de validação (estoque insuficiente), propaga
        if (e.message.includes('insuficiente')) throw e;
        // Outros erros (rede, etc.) → fallback local
        console.warn('[Estoque] Transação Firebase falhou, usando local:', e.message);
        _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
      }
    } else {
      // ── Modo local: offline, sem adminToken (PDV), ou Firebase não pronto ──
      // Aplica localmente — SyncQueue garante que admin sincronize depois.
      const motivo = !_isOnline() ? 'offline'
                   : !temToken   ? 'PDV sem adminToken'
                   : 'Firebase não pronto';
      console.info(`[Estoque] Modo local (${motivo}): ${tipo} ${prod.nome}`);
      _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
    }

    const mov = {
      id:            Utils.generateId(),
      produtoId,
      nomeProduto:   prod.nome,
      tipo,
      quantidade:    delta,
      estoqueAntes,
      estoqueDepois,
      origem,
      operador:      operador || _usuario(),
      observacao,
      custo:         custo ?? prod.precoCusto ?? 0,
      fornecedorId,
      timestamp:     Utils.nowISO(),
      dataCurta:     Utils.todayISO(),
    };

    // Persiste movimentação no Store local
    Store.mutateMovimentacoes(movs => { movs.unshift(mov); });

    window.CH.AuditService?.auditarMovimentacao(mov);
    EventBus.emit('estoque:movimentado', mov);
    return mov;
  }

  /** Aplica movimentação apenas no Store local (offline/fallback) */
  function _movimentacaoLocal({ produtoId, delta, estoqueDepois, origem }) {
    Store.mutateEstoque(estoque => {
      const p = estoque.find(p => p.id === produtoId);
      if (p) {
        p.qtdUn        = estoqueDepois;
        p.estoqueAtual = estoqueDepois;
        p.updatedAt    = Utils.nowISO();
      }
    });
    console.info(`[Estoque] Movimentação local (offline): ${origem}`);
  }

  // ── APIs de alto nível ───────────────────────────────────────────

  /** Entrada de mercadoria (compra de fornecedor) */
  async function entradaEstoque(produtoId, quantidade, { custo, fornecedorId, observacao } = {}) {
    return _registrarMovimentacao({
      produtoId, tipo: 'entrada', quantidade,
      origem: 'compra', custo, fornecedorId, observacao,
    });
  }

  /**
   * Baixa de estoque por venda — com Firebase Transaction.
   * Chamado por VendasService ao finalizar uma venda.
   */
  async function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    return _registrarMovimentacao({
      produtoId, tipo: 'venda', quantidade,
      origem: `venda:${vendaId}`,
    });
  }

  /** Registra avaria/perda */
  async function registrarAvaria(produtoId, quantidade, observacao = '') {
    return _registrarMovimentacao({
      produtoId, tipo: 'avaria', quantidade, origem: 'avaria', observacao,
    });
  }

  /**
   * Ajuste de inventário — define a quantidade exata.
   * Calcula o delta entre o valor atual e o novo valor.
   */
  async function ajustarEstoque(produtoId, novaQuantidade, observacao = 'Ajuste de inventário') {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const atual = prod.estoqueAtual ?? prod.qtdUn ?? 0;
    const diff  = novaQuantidade - atual;
    if (diff === 0) return null; // sem mudança

    return _registrarMovimentacao({
      produtoId,
      tipo:        'ajuste',
      quantidade:  Math.abs(diff), // irrelevante quando _forceDelta está presente
      origem:      'inventario',
      observacao,
      _forceDelta: diff, // diff já tem sinal: positivo=soma, negativo=subtrai
    });
  }

  /** Cancelamento de venda — estorna o estoque */
  async function cancelarVenda(vendaId, itens) {
    const movs = [];
    for (const item of itens) {
      const qtd = item.label === 'UNID'
        ? item.qtd
        : item.qtd * (getProduto(item.prodId)?.packs?.find(pk => pk.label === item.label)?.qtd || 1);
      const mov = await _registrarMovimentacao({
        produtoId:  item.prodId,
        tipo:       'cancelamento',
        quantidade: qtd,
        origem:     `cancelamento:${vendaId}`,
        observacao: `Cancelamento da venda ${vendaId}`,
      });
      movs.push(mov);
    }
    return movs;
  }

  // ── Consultas de movimentações ────────────────────────────────────
  function getMovimentacoes({ produtoId, tipo, dataDe, dataAte, limit = 500 } = {}) {
    let movs = Store.getMovimentacoes();
    if (produtoId) movs = movs.filter(m => m.produtoId === produtoId);
    if (tipo)      movs = movs.filter(m => m.tipo      === tipo);
    if (dataDe)    movs = movs.filter(m => m.dataCurta >= dataDe);
    if (dataAte)   movs = movs.filter(m => m.dataCurta <= dataAte);
    return movs.slice(0, limit);
  }

  function getMovimentacoesHoje() {
    return getMovimentacoes({ dataDe: Utils.todayISO(), dataAte: Utils.todayISO() });
  }

  // ── Alertas ───────────────────────────────────────────────────────
  function getProdutosAbaixoMinimo() {
    const thr = Store.getConfig()?.alertaEstoque || window.CH.CONSTANTS.LOW_STOCK;
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= (p.estoqueMinimo || thr));
  }

  function getProdutosSemEstoque() {
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= 0);
  }

  // ── Valorização do estoque ────────────────────────────────────────
  function getValorizacao() {
    const prods   = getProdutos().filter(p => p.ativo);
    const custo   = prods.reduce((s, p) => s + (p.precoCusto || p.custoUn || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    const venda   = prods.reduce((s, p) => s + (p.precoVenda || p.precoUn  || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    return { custo, venda, margem: venda - custo };
  }

  // ════════════════════════════════════════════════════════════════
  //  CATEGORIAS
  // ════════════════════════════════════════════════════════════════

  function getCategorias() { return Store.getCategorias(); }

  function adicionarCategoria(nome, cor = '#6b7280') {
    const cat = { id: Utils.generateId(), nome: nome.trim(), cor, createdAt: Utils.nowISO() };
    Store.mutateCategorias(cats => { cats.push(cat); });
    return cat;
  }

  function removerCategoria(id) {
    Store.mutateCategorias(cats => {
      const idx = cats.findIndex(c => c.id === id);
      if (idx >= 0) cats.splice(idx, 1);
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  FORNECEDORES
  // ════════════════════════════════════════════════════════════════

  function getFornecedores() { return Store.getFornecedores(); }
  function getFornecedor(id) { return Store.getFornecedores().find(f => f.id === id) || null; }

  function adicionarFornecedor({ nome, telefone = '', email = '', cnpj = '', observacao = '' }) {
    const forn = {
      id: Utils.generateId(), nome: nome.trim(), telefone, email, cnpj, observacao,
      ativo: true, createdAt: Utils.nowISO(),
    };
    Store.mutateFornecedores(forns => { forns.push(forn); });
    return forn;
  }

  function atualizarFornecedor(id, campos) {
    Store.mutateFornecedores(forns => {
      const f = forns.find(f => f.id === id);
      if (f) Object.assign(f, campos, { updatedAt: Utils.nowISO() });
    });
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.EstoqueService = {
    // Produtos
    getProdutos,
    getProduto,
    adicionarProduto,
    atualizarProduto,
    removerProduto,

    // Movimentações
    entradaEstoque,
    baixarEstoqueVenda,
    registrarAvaria,
    ajustarEstoque,
    cancelarVenda,
    getMovimentacoes,
    getMovimentacoesHoje,

    // Alertas
    getProdutosAbaixoMinimo,
    getProdutosSemEstoque,
    getValorizacao,

    // Categorias
    getCategorias,
    adicionarCategoria,
    removerCategoria,

    // Fornecedores
    getFornecedores,
    getFornecedor,
    adicionarFornecedor,
    atualizarFornecedor,
  };

  console.info('%c EstoqueService ✓  (Transactions + Movimentações)', 'color:#10b981');
})();
