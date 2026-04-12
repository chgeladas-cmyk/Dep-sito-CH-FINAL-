'use strict';
/**
 * services/syncService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Fila de sincronização offline persistente.
 *
 * Problema resolvido:
 *   Se a internet cair durante uma operação, os dados ficam na fila.
 *   Quando a conexão voltar, a fila é processada automaticamente,
 *   com retry exponencial (1s → 3s → 10s → 30s → 60s).
 *
 * Estrutura de cada item na fila:
 *   {
 *     id:              string (UUID)
 *     acao:            'salvar' | 'deletar'
 *     colecao:         string (ex: 'estoque', 'vendas')
 *     dados:           any    (payload a sincronizar)
 *     tentativas:      number (0..MAX_RETRY)
 *     status:          'pendente' | 'processando' | 'concluido' | 'erro'
 *     timestamp:       string ISO (quando foi enfileirado)
 *     proximaTentativa:number  (ms epoch — quando pode tentar novamente)
 *     ultimoErro:      string? (mensagem do último erro)
 *   }
 *
 * Requer: core.js carregado antes (window.CH disponível)
 */

(function () {
  const { Utils, EventBus, FirebaseService } = window.CH;

  const QUEUE_KEY   = window.CH.CONSTANTS.DB.SYNC_QUEUE;
  const MAX_RETRY   = 5;
  const MAX_ITEMS   = window.CH.CONSTANTS.MAX_SYNC_QUEUE;
  // Atrasos em ms para cada tentativa (exponential backoff)
  const RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000, 60_000];

  let _processing = false;
  let _timer      = null;

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
  // Se já há um item pendente para a mesma coleção/ação, atualiza os dados
  // em vez de enfileirar de novo. Isso evita spam de sincronizações.
  function _colapsar(q, acao, colecao, dados) {
    const idx = q.findIndex(i =>
      i.status === 'pendente' &&
      i.acao    === acao &&
      i.colecao === colecao
    );
    if (idx >= 0) {
      q[idx].dados     = dados;
      q[idx].timestamp = Utils.nowISO();
      return true; // colapsado
    }
    return false; // não colapsado, precisa adicionar
  }

  // ── Enfileirar ───────────────────────────────────────────────────
  function enqueue(acao, colecao, dados) {
    const q = _loadQueue();

    // Colapsa se possível
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
      // salvar() retorna false em caso de erro sem lançar exceção —
      // precisamos lançar para que o mecanismo de retry funcione.
      if (!ok) throw new Error(`Firestore rejeitou: ${item.colecao}`);
    } else if (item.acao === 'deletar') {
      // reservado para futuro (ex: deletar comanda)
      console.warn('[SyncQueue] Ação deletar ainda não implementada');
    }
  }

  // ── Processar fila completa ──────────────────────────────────────
  async function processar() {
    if (_processing) return;

    const fbOk = await FirebaseService.init();
    if (!fbOk) {
      console.info('[SyncQueue] Firebase não disponível — reagendando em 15s.');
      _scheduleProcess(15_000); // ← retry automático; sem isso itens ficam presos para sempre
      return;
    }

    _processing = true;

    try {
      const q = _loadQueue();
      const agora = Date.now();

      const pendentes = q.filter(i =>
        i.status    === 'pendente' &&
        i.tentativas < MAX_RETRY  &&
        agora        >= (i.proximaTentativa || 0)
      );

      if (!pendentes.length) {
        _processing = false;
        return;
      }

      console.info(`[SyncQueue] Processando ${pendentes.length} item(ns)...`);

      for (const item of pendentes) {
        // Marca como processando na fila (salva antes de tentar)
        item.status = 'processando';
        _saveQueue(q);

        try {
          await _processItem(item);
          item.status    = 'concluido';
          item.ultimoErro = null;
          EventBus.emit('sync:ok', item.colecao);
          EventBus.emit(`sync:ok:${item.colecao}`);
          console.info(`[SyncQueue] ✓ ${item.colecao} (${item.acao})`);
        } catch(e) {
          item.tentativas++;
          item.ultimoErro      = e.message || String(e);
          const delay          = RETRY_DELAYS[item.tentativas - 1] ?? 60_000;
          item.proximaTentativa = Date.now() + delay;
          item.status          = item.tentativas >= MAX_RETRY ? 'erro' : 'pendente';
          console.warn(
            `[SyncQueue] ✗ ${item.colecao} — tentativa ${item.tentativas}/${MAX_RETRY}`,
            `— próxima em ${delay/1000}s:`, e.message
          );
          EventBus.emit('sync:error', { colecao: item.colecao, erro: e.message, tentativa: item.tentativas });
        }
      }

      // Limpar concluídos e erros definitivos; manter pendentes e processando
      const finalQueue = q.filter(i => i.status === 'pendente' || i.status === 'processando');
      _saveQueue(finalQueue);

      // Se ainda há pendentes, agendar nova tentativa
      const pendentesRestantes = finalQueue.filter(i => i.status === 'pendente');
      if (pendentesRestantes.length > 0) {
        const proximaEm = Math.min(...pendentesRestantes.map(i => i.proximaTentativa || 0));
        const delay     = Math.max(500, proximaEm - Date.now());
        _scheduleProcess(delay);
        UIService_setDot(false);
      } else {
        UIService_setDot(true);
      }

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

  // Limpa erros definitivos manualmente (para retry manual)
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
    console.info('[SyncQueue] Fila limpa.');
  }

  // ── Integração com pending sync do core.js ──────────────────────
  // Processa colecoes que foram enfileiradas antes deste service carregar
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

  // Reset de itens que ficaram presos como 'processando' por crash/reload da página.
  // Sem este reset, esses itens nunca seriam retentados.
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

  // Notificações de dot no UI
  function UIService_setDot(ok, msg) {
    window.CH?.UIService?.setSyncDot?.(ok, msg);
  }

  // ── Eventos ──────────────────────────────────────────────────────
  window.addEventListener('online', () => {
    console.info('[SyncQueue] Online — processando fila pendente...');
    UIService_setDot(false, 'Sincronizando...');
    processar();
  });

  EventBus.on('firebase:ready', () => {
    _drainPendingSync();
    processar();
  });

  EventBus.on('auth:login', () => {
    setTimeout(processar, 1000);
  });

  // Processar ao iniciar (se online)
  if (navigator.onLine) {
    setTimeout(() => { _resetProcessando(); _drainPendingSync(); processar(); }, 3000);
  } else {
    setTimeout(_resetProcessando, 1000); // reset mesmo offline
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.SyncQueue = {
    enqueue,
    processar,
    getStatus,
    reenviarErros,
    limparFila,
  };

  console.info('%c SyncQueue ✓', 'color:#10b981');
})();
