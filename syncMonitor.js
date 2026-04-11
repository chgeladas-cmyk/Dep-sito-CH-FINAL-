'use strict';
/**
 * services/syncMonitor.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Monitor visual de sync que funciona em qualquer página.
 *
 * O que faz:
 *   - Se a página já tem #syncDot: atualiza ele
 *   - Se não tem: injeta um widget flutuante no canto inferior direito
 *   - Mostra 🟢 sincronizado / 🟡 enviando / 🔴 offline
 *   - Mostra contador da fila quando há itens pendentes
 *   - Detecta online/offline automaticamente
 *   - Mostra toast quando volta online e sincroniza
 *
 * Requer: core.js + syncService.js carregados antes.
 */

(function () {
  const { EventBus, UIService } = window.CH;

  // ── Estado ────────────────────────────────────────────────────────
  let _estado   = navigator.onLine ? 'pendente' : 'offline'; // 'ok' | 'enviando' | 'pendente' | 'offline' | 'erro'
  let _fila     = 0;
  let _widget   = null;
  let _tickTimer = null;

  const COR = {
    ok:       '#10b981', // verde
    enviando: '#3b82f6', // azul
    pendente: '#f59e0b', // amarelo
    offline:  '#ef4444', // vermelho
    erro:     '#ef4444', // vermelho
  };

  const LABEL = {
    ok:       'Sincronizado',
    enviando: 'Enviando...',
    pendente: 'Aguardando sync',
    offline:  'Sem internet',
    erro:     'Erro de sync',
  };

  const ICON = {
    ok:       '🟢',
    enviando: '🔵',
    pendente: '🟡',
    offline:  '🔴',
    erro:     '🔴',
  };

  // ── Renderização ──────────────────────────────────────────────────
  function _render() {
    const cor   = COR[_estado]   || '#f59e0b';
    const label = LABEL[_estado] || _estado;
    const icon  = ICON[_estado]  || '🟡';

    // Atualiza syncDot nativo se existir na página
    const dot = document.getElementById('syncDot');
    if (dot) {
      dot.style.display    = 'block';
      dot.style.background = cor;
      dot.title            = label;
    }

    // Atualiza syncLabel se existir
    const lbl = document.getElementById('syncLabel');
    if (lbl) lbl.textContent = label;

    // Atualiza syncDotTop se existir (index.html)
    const dotTop = document.getElementById('syncDotTop');
    if (dotTop) dotTop.style.background = cor;

    // Atualiza badge de fila se existir (index.html)
    const badge = document.getElementById('syncQueueBadge');
    const count = document.getElementById('syncQueueCount');
    if (badge) {
      badge.style.display = _fila > 0 ? 'block' : 'none';
      if (count) count.textContent = _fila;
    }

    // Atualiza widget flutuante
    if (_widget) {
      const dotEl  = _widget.querySelector('.sm-dot');
      const lblEl  = _widget.querySelector('.sm-label');
      const filaEl = _widget.querySelector('.sm-fila');

      if (dotEl)  { dotEl.style.background = cor; dotEl.title = label; }
      if (lblEl)  lblEl.textContent = `${icon} ${label}`;
      if (filaEl) {
        filaEl.style.display = _fila > 0 ? 'inline' : 'none';
        filaEl.textContent   = ` · ${_fila} na fila`;
      }
    }
  }

  // ── Widget flutuante (injetado quando a página não tem syncDot) ───
  function _criarWidget() {
    const w = document.createElement('div');
    w.id    = 'chSyncMonitor';
    w.innerHTML = `
      <span class="sm-dot" style="
        display:inline-block;width:.55rem;height:.55rem;
        border-radius:50%;flex-shrink:0;transition:background .3s
      "></span>
      <span class="sm-label" style="font-size:.58rem;font-weight:700;color:#94a3b8"></span>
      <span class="sm-fila"  style="font-size:.58rem;font-weight:700;color:#f59e0b;display:none"></span>
    `;
    w.style.cssText = `
      position:fixed;bottom:1rem;right:1rem;
      display:flex;align-items:center;gap:.35rem;
      background:rgba(12,16,26,.92);
      border:1px solid rgba(255,255,255,.08);
      border-radius:2rem;padding:.35rem .75rem;
      z-index:8888;
      box-shadow:0 4px 16px rgba(0,0,0,.4);
      backdrop-filter:blur(8px);
      pointer-events:none;
      transition:opacity .3s;
    `;
    document.body.appendChild(w);
    return w;
  }

  // ── Lógica de estado ──────────────────────────────────────────────
  function _setEstado(estado, filaSize) {
    _estado = estado;
    _fila   = typeof filaSize === 'number' ? filaSize : _fila;
    _render();
  }

  function _verificarFila() {
    if (!window.CH?.SyncQueue) return;
    const status = window.CH.SyncQueue.getStatus();
    _fila = status.pendentes + status.processando;

    if (!navigator.onLine) {
      _setEstado('offline', _fila);
    } else if (status.processando > 0) {
      _setEstado('enviando', _fila);
    } else if (_fila > 0) {
      _setEstado('pendente', _fila);
    } else if (status.erros > 0) {
      _setEstado('erro', 0);
    } else {
      _setEstado('ok', 0);
    }
  }

  // ── Inicialização ─────────────────────────────────────────────────
  function _init() {
    // Só cria widget flutuante se a página não tem syncDot próprio
    if (!document.getElementById('syncDot')) {
      _widget = _criarWidget();
    }

    _verificarFila();

    // Tick periódico (a cada 5s verifica o estado da fila)
    _tickTimer = setInterval(_verificarFila, 5000);
  }

  // ── Eventos ───────────────────────────────────────────────────────
  EventBus.on('sync:ok', () => {
    _setEstado('ok', 0);
    // Pisca verde rapidamente para feedback visual
    setTimeout(_verificarFila, 2000);
  });

  EventBus.on('sync:error', ({ tentativa }) => {
    _setEstado(tentativa >= 5 ? 'erro' : 'pendente');
  });

  EventBus.on('firebase:ready', () => {
    if (navigator.onLine) _setEstado('pendente');
    setTimeout(_verificarFila, 1500);
  });

  EventBus.on('auth:login', () => {
    _setEstado('pendente');
    setTimeout(_verificarFila, 2000);
  });

  window.addEventListener('offline', () => {
    _setEstado('offline');
    UIService?.showToast('Sem internet', 'Operando offline — dados serão sincronizados ao reconectar.', 'warning');
  });

  window.addEventListener('online', () => {
    _setEstado('pendente');
    UIService?.showToast('Internet restaurada', 'Sincronizando dados...', 'info');
    setTimeout(_verificarFila, 2000);
  });

  // Inicia após DOM pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    // DOM já está pronto
    setTimeout(_init, 100);
  }

  // ── API pública ───────────────────────────────────────────────────
  window.CH.SyncMonitor = {
    getEstado:    () => _estado,
    getFila:      () => _fila,
    verificar:    _verificarFila,
    setEstado:    _setEstado,
  };

  console.info('%c SyncMonitor ✓  (global — todas as páginas)', 'color:#10b981');
})();
