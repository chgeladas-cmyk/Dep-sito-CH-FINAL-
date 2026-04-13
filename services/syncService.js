'use strict';
/**
 * services/syncService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Fila de sincronização offline persistente.
 *
 * BUGS CORRIGIDOS (v2):
 *   1. Race condition: firebase:ready re-entrante — guard duplo adicionado
 *   2. UIService_setDot nunca resolvia para "ok" quando fila era processada com backoff
 *   3. Itens presos como 'processando' dentro da mesma sessão (crash no loop)
 *   4. _colapsar colapsa vendas (não deve — cada venda é única)
 */

(function () {
  const { Utils, EventBus, FirebaseService } = window.CH;

  const QUEUE_KEY   = window.CH.CONSTANTS.DB.SYNC_QUEUE;
  const MAX_RETRY   = 5;
  const MAX_ITEMS   = window.CH.CONSTANTS.MAX_SYNC_QUEUE;
  const RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000, 60_000];

  let _processing     = false;
  let _timer          = null;
  let _firebaseReady  = false; // guard para evitar re-entrada via firebase:ready

  // ── Persistência da fila ─────────────────────────────────────────
  function _loadQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch { return []; }
  }

  function _saveQueue(q) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(0, MAX_ITEMS)));
    } catch(e) {
      console.warn('[SyncQueue] Falha ao salvar fila:', e);
    }
  }

  // ── Colapsar itens duplicados ────────────────────────────────────
  // Vendas NUNCA são colapsadas (cada venda é um documento único).
  // Outros módulos (estoque, config, fiado, etc.) sobrescrevem o pendente.
  function _colapsar(q, acao, colecao, dados) {
    if (colecao === 'vendas') return false; // FIX: vendas nunca colapsam
    const idx = q.findIndex(i =>
      i.status   === 'pendente' &&
      i.acao     === acao &&
      i.colecao  === colecao
    );
    if (idx >= 0) {
      q[idx].dados     = dados;
      q[idx].timestamp = Utils.nowISO();
      return true;
    }
    return false;
  }

  // ── Enfileirar ───────────────────────────────────────────────────
  function enqueue(acao, colecao, dados) {
    const q = _loadQueue();

    if (!_colapsar(q, acao, colecao, dados)) {
      q.push({
        id:               Utils.generateId(),
        acao,
        colecao,
        dados,
        tentativas:       0,
        status:           'pendente',
        timestamp:        Utils.nowISO(),
        proximaTentativa: Date.now(),
        ultimoErro:       null,
      });
    }

    _saveQueue(q);
    UIService_setDot(false);
    _scheduleProcess(500);
  }

  // ── Processar um item ────────────────────────────────────────────
  async function _processItem(item) {
    if (item.acao === 'salvar') {
      const ok = await FirebaseService.salvar(item.colecao, item.dados);
      if (!ok) throw new Error(`Firestore rejeitou: ${item.colecao}`);
    } else if (item.acao === 'deletar') {
      console.warn('[SyncQueue] Ação deletar ainda não implementada');
    }
  }

  // ── Processar fila completa ──────────────────────────────────────
  async function processar() {
    if (_processing) return;

    const fbOk = await FirebaseService.init();
    if (!fbOk) {
      console.info('[SyncQueue] Firebase não disponível — reagendando em 15s.');
      _scheduleProcess(15_000);
      return;
    }

    _processing = true;

    try {
      // FIX: reseta qualquer 'processando' preso ANTES de iniciar o loop
      // (cobre crash dentro do loop na mesma sessão)
      let q = _loadQueue();
      let hasStuck = false;
      q.forEach(i => {
        if (i.status === 'processando') {
          i.status           = 'pendente';
          i.proximaTentativa = Date.now();
          hasStuck = true;
        }
      });
      if (hasStuck) _saveQueue(q);

      q = _loadQueue();
      const agora = Date.now();

      const pendentes = q.filter(i =>
        i.status    === 'pendente' &&
        i.tentativas < MAX_RETRY  &&
        agora        >= (i.proximaTentativa || 0)
      );

      if (!pendentes.length) {
        // FIX: mesmo sem itens prontos agora, verifica se fila está zerada
        const totalPendentes = q.filter(i => i.status === 'pendente').length;
        if (totalPendentes === 0) {
          UIService_setDot(true); // fila vazia = sincronizado
        } else {
          // Há itens mas todos em backoff — agenda para o mais próximo
          const proximaEm = Math.min(...q
            .filter(i => i.status === 'pendente')
            .map(i => i.proximaTentativa || 0)
          );
          const delay = Math.max(1000, proximaEm - Date.now());
          _scheduleProcess(delay);
        }
        _processing = false;
        return;
      }

      console.info(`[SyncQueue] Processando ${pendentes.length} item(ns)...`);

      for (const item of pendentes) {
        item.status = 'processando';
        _saveQueue(q);

        try {
          await _processItem(item);
          item.status     = 'concluido';
          item.ultimoErro = null;
          EventBus.emit('sync:ok', item.colecao);
          EventBus.emit(`sync:ok:${item.colecao}`);
          console.info(`[SyncQueue] ✓ ${item.colecao} (${item.acao})`);
        } catch(e) {
          item.tentativas++;
          item.ultimoErro       = e.message || String(e);
          const delay           = RETRY_DELAYS[item.tentativas - 1] ?? 60_000;
          item.proximaTentativa = Date.now() + delay;
          item.status           = item.tentativas >= MAX_RETRY ? 'erro' : 'pendente';
          console.warn(
            `[SyncQueue] ✗ ${item.colecao} — tentativa ${item.tentativas}/${MAX_RETRY}`,
            `— próxima em ${delay/1000}s:`, e.message
          );
          EventBus.emit('sync:error', { colecao: item.colecao, erro: e.message, tentativa: item.tentativas });
        }
      }

      // Remove concluídos e erros definitivos
      const finalQueue = q.filter(i => i.status === 'pendente');
      _saveQueue(finalQueue);

      if (finalQueue.length > 0) {
        const proximaEm = Math.min(...finalQueue.map(i => i.proximaTentativa || 0));
        const delay     = Math.max(500, proximaEm - Date.now());
        _scheduleProcess(delay);
        UIService_setDot(false);
      } else {
        UIService_setDot(true); // FIX: garante que o dot vira verde quando fila esvazia
      }

    } catch(e) {
      // FIX: captura erros inesperados no loop e reseta _processing corretamente
      console.error('[SyncQueue] Erro inesperado no loop:', e);
    } finally {
      _processing = false;
    }
  }

  function _scheduleProcess(delay = 2000) {
    clearTimeout(_timer);
    _timer = setTimeout(processar, delay);
  }

  // ── Status da fila ───────────────────────────────────────────────
  function getStatus() {
    const q = _loadQueue();
    return {
      total:       q.length,
      pendentes:   q.filter(i => i.status === 'pendente').length,
      processando: q.filter(i => i.status === 'processando').length,
      erros:       q.filter(i => i.status === 'erro').length,
      concluidos:  q.filter(i => i.status === 'concluido').length,
      itens:       q,
    };
  }

  function reenviarErros() {
    const q = _loadQueue();
    let count = 0;
    q.forEach(i => {
      if (i.status === 'erro') {
        i.status           = 'pendente';
        i.tentativas       = 0;
        i.proximaTentativa = Date.now();
        count++;
      }
    });
    _saveQueue(q);
    if (count > 0) {
      console.info(`[SyncQueue] ${count} item(ns) de erro reenviados para fila.`);
      _scheduleProcess(500);
    }
    return count;
  }

  function limparFila() {
    _saveQueue([]);
    UIService_setDot(true);
    console.info('[SyncQueue] Fila limpa.');
  }

  // ── Integração com pending sync do core.js ──────────────────────
  function _drainPendingSync() {
    const pending = window._pendingSync || [];
    if (pending.length) {
      pending.forEach(col => {
        const getter = `get${col.charAt(0).toUpperCase()}${col.slice(1)}`;
        const dados  = window.CH.Store[getter]?.();
        if (dados != null) enqueue('salvar', col, dados);
      });
      window._pendingSync = [];
    }
  }

  function _resetProcessando() {
    const q = _loadQueue();
    let changed = false;
    q.forEach(i => {
      if (i.status === 'processando') {
        i.status           = 'pendente';
        i.proximaTentativa = Date.now();
        changed = true;
      }
    });
    if (changed) {
      _saveQueue(q);
      console.info('[SyncQueue] Itens "processando" resetados para "pendente" após reload.');
    }
  }

  function UIService_setDot(ok, msg) {
    window.CH?.UIService?.setSyncDot?.(ok, msg);
  }

  // ── Eventos ──────────────────────────────────────────────────────
  window.addEventListener('online', () => {
    console.info('[SyncQueue] Online — processando fila pendente...');
    UIService_setDot(false, 'Sincronizando...');
    processar();
  });

  // FIX: guard _firebaseReady evita processar() re-entrante quando
  // firebase:ready é emitido de dentro de FirebaseService.init() chamado
  // pelo próprio processar() — causava duas instâncias concorrentes.
  EventBus.on('firebase:ready', () => {
    if (_firebaseReady) return;
    _firebaseReady = true;
    _drainPendingSync();
    processar();
  });

  EventBus.on('auth:login', () => {
    setTimeout(processar, 1000);
  });

  // Processar ao iniciar (se online)
  if (navigator.onLine) {
    setTimeout(() => { _resetProcessando(); _drainPendingSync(); processar(); }, 1000);
  } else {
    setTimeout(_resetProcessando, 1000);
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.SyncQueue = {
    enqueue,
    processar,
    getStatus,
    reenviarErros,
    limparFila,
  };

  console.info('%c SyncQueue ✓ v2', 'color:#10b981');
})();
