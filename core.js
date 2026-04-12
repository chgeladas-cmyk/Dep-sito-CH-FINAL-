'use strict';
/**
 * core.js v4 — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Núcleo limpo. Lógica de domínio nos serviços:
 *   services/estoqueService.js  → movimentações + transações Firebase
 *   services/vendasService.js   → venda integrada com estoque
 *   services/financeiroService.js → financeiro integrado com vendas
 *   services/syncService.js     → fila offline robusta com retry
 *   services/auditService.js    → auditoria completa (antes/depois)
 *
 * RETROCOMPATÍVEL: window.CH mantém todos os nomes anteriores.
 */

/* ╔═══════════════════════════════════════════════════════════╗
   ║  1. CONSTANTS                                             ║
   ╚═══════════════════════════════════════════════════════════╝ */
const CONSTANTS = Object.freeze({

  DB: Object.freeze({
    ESTOQUE:        'CH_ESTOQUE',
    VENDAS:         'CH_VENDAS',
    COMANDAS:       'CH_COMANDAS',
    FIADO:          'CH_FIADO',
    PONTO:          'CH_PONTO',
    PEDIDOS:        'CH_PEDIDOS',
    CONFIG:         'CH_CONFIG',
    AUDITORIA:      'CH_AUDITORIA',
    MOVIMENTACOES:  'CH_MOVIMENTACOES',
    CATEGORIAS:     'CH_CATEGORIAS',
    FORNECEDORES:   'CH_FORNECEDORES',
    FINANCEIRO:     'CH_FINANCEIRO',
    SYNC_QUEUE:     'CH_SYNC_QUEUE',
  }),

  LEGACY_KEY:  'CH_GELADAS_DB_ENTERPRISE',
  SESSION_KEY: 'CH_SESSION',

  LOCALE:   'pt-BR',
  CURRENCY: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  LOW_STOCK: 3,

  MAX_VENDAS:        5_000,
  MAX_REGISTROS:     5_000,
  MAX_PONTO:         1_000,
  MAX_PEDIDOS:       2_000,
  MAX_AUDITORIA:     5_000,
  MAX_COMANDAS:      2_000,
  MAX_MOVIMENTACOES: 10_000,
  MAX_FINANCEIRO:    5_000,
  MAX_SYNC_QUEUE:    500,

  PIN_HASH: Object.freeze({
    ADMIN: '7a3e6b16cb75f48fb897eff3ae732f3154f6d203b53f33660f01b4c3b6bc2df9',
    PDV:   'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
  }),

  PERMISSOES: Object.freeze({
    pdv: Object.freeze({
      ler:      ['estoque', 'config'],
      escrever: ['vendas'],
    }),
    admin: Object.freeze({
      ler:      ['estoque','vendas','comandas','fiado','ponto','pedidos','config','auditoria','movimentacoes','categorias','fornecedores','financeiro'],
      escrever: ['estoque','vendas','comandas','fiado','ponto','pedidos','config','auditoria','movimentacoes','categorias','fornecedores','financeiro'],
    }),
  }),

  TIPOS_MOVIMENTACAO: Object.freeze(['entrada','venda','avaria','ajuste','transferencia','cancelamento','inventario']),
  ROLES:              Object.freeze(['admin','gerente','operador','entregador','pdv']),
});

/* ╔═══════════════════════════════════════════════════════════╗
   ║  2. UTILS                                                 ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Utils = Object.freeze({
  formatCurrency(v) {
    return new Intl.NumberFormat(CONSTANTS.LOCALE, {
      style: 'currency', currency: 'BRL', ...CONSTANTS.CURRENCY,
    }).format(Number(v) || 0);
  },
  todayISO()   { return new Date().toISOString().slice(0, 10); },
  today()      { return new Date().toLocaleDateString('pt-BR'); },
  nowTime()    { return new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }); },
  nowFull()    { return new Date().toLocaleString('pt-BR'); },
  nowISO()     { return new Date().toISOString(); },
  generateId() { return crypto.randomUUID?.() ?? ('id_' + Date.now() + '_' + Math.random().toString(36).slice(2)); },

  // Retorna a semana ISO (YYYY-Www) da data
  weekISO(date = new Date()) {
    const d  = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dn = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dn);
    const y  = d.getUTCFullYear();
    const w  = Math.ceil(((d - new Date(Date.UTC(y,0,1))) / 86400000 + 1) / 7);
    return `${y}-W${String(w).padStart(2,'0')}`;
  },

  downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  },
  openWhatsApp(number, message) {
    window.open(`https://wa.me/${String(number).replace(/\D/g,'')}?text=${encodeURIComponent(message)}`, '_blank');
  },
  copyToClipboard(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const ta = Object.assign(document.createElement('textarea'), { value:text, style:'position:fixed;opacity:0' });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    return Promise.resolve();
  },
  deepClone(obj) {
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
  },
});

/* ╔═══════════════════════════════════════════════════════════╗
   ║  3. CRYPTO                                                ║
   ╚═══════════════════════════════════════════════════════════╝ */
const CryptoService = {
  async sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  },
  async validatePin(pin) {
    if (!pin) return null;
    const hash = await this.sha256(String(pin).trim());
    const cfg  = Store.getConfig();
    if (cfg?.pinHashAdmin && hash === cfg.pinHashAdmin) return 'admin';
    if (cfg?.pinHashPdv   && hash === cfg.pinHashPdv)   return 'pdv';
    if (hash === CONSTANTS.PIN_HASH.ADMIN) return 'admin';
    if (hash === CONSTANTS.PIN_HASH.PDV)   return 'pdv';
    return null;
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  4. EVENT BUS                                             ║
   ╚═══════════════════════════════════════════════════════════╝ */
const EventBus = (() => {
  const _l = {};
  return {
    on(ev, fn)   { (_l[ev] = _l[ev] || []).push(fn); },
    off(ev, fn)  { _l[ev] = (_l[ev] || []).filter(f => f !== fn); },
    once(ev, fn) {
      const wrapper = (...args) => { fn(...args); this.off(ev, wrapper); };
      this.on(ev, wrapper);
    },
    emit(ev, ...args) {
      (_l[ev] || []).forEach(fn => { try { fn(...args); } catch(e) { console.error('[EB]', ev, e); } });
    },
  };
})();

/* ╔═══════════════════════════════════════════════════════════╗
   ║  5. STORE — cache local + FIFO limits                     ║
   ╚═══════════════════════════════════════════════════════════╝ */
const Store = (() => {
  const _cache = {};

  const _key = {
    estoque:       CONSTANTS.DB.ESTOQUE,
    vendas:        CONSTANTS.DB.VENDAS,
    comandas:      CONSTANTS.DB.COMANDAS,
    fiado:         CONSTANTS.DB.FIADO,
    ponto:         CONSTANTS.DB.PONTO,
    pedidos:       CONSTANTS.DB.PEDIDOS,
    config:        CONSTANTS.DB.CONFIG,
    auditoria:     CONSTANTS.DB.AUDITORIA,
    movimentacoes: CONSTANTS.DB.MOVIMENTACOES,
    categorias:    CONSTANTS.DB.CATEGORIAS,
    fornecedores:  CONSTANTS.DB.FORNECEDORES,
    financeiro:    CONSTANTS.DB.FINANCEIRO,
  };

  const _empty = {
    estoque:[], vendas:[], comandas:[], fiado:[],
    ponto:[], pedidos:[], auditoria:[], config:{},
    movimentacoes:[], categorias:[], fornecedores:[], financeiro:[],
  };

  const _limits = {
    vendas: CONSTANTS.MAX_VENDAS, ponto: CONSTANTS.MAX_PONTO,
    pedidos: CONSTANTS.MAX_PEDIDOS, auditoria: CONSTANTS.MAX_AUDITORIA,
    comandas: CONSTANTS.MAX_COMANDAS, movimentacoes: CONSTANTS.MAX_MOVIMENTACOES,
    financeiro: CONSTANTS.MAX_FINANCEIRO,
  };

  function _read(col) {
    if (_cache[col] !== undefined) return _cache[col];
    try {
      const raw = localStorage.getItem(_key[col]);
      _cache[col] = raw ? JSON.parse(raw) : Utils.deepClone(_empty[col]);
    } catch { _cache[col] = Utils.deepClone(_empty[col]); }
    return _cache[col];
  }

  function _write(col, data) {
    _cache[col] = data;
    try { localStorage.setItem(_key[col], JSON.stringify(data)); }
    catch(e) { console.error('[Store] write:', col, e); }
  }

  function _notify(col) {
    EventBus.emit('store:updated', col);
    EventBus.emit(`store:${col}`);
  }

  function _mutate(col, fn) {
    const data = _read(col);
    fn(data);
    const limit = _limits[col];
    const final = (limit && Array.isArray(data)) ? data.slice(0, limit) : data;
    _write(col, final);
    _notify(col);
    // Notifica SyncQueue se disponível (carregado depois)
    if (window.CH?.SyncQueue) window.CH.SyncQueue.enqueue('salvar', col, final);
    else window._pendingSync?.push(col);
  }

  function _migrarLegacy() {
    const raw = localStorage.getItem(CONSTANTS.LEGACY_KEY);
    if (!raw) return;
    const jaExiste = Object.values(_key).some(k => !!localStorage.getItem(k));
    if (jaExiste) return;
    try {
      const old = JSON.parse(raw);
      if (Array.isArray(old.estoque)  && old.estoque.length)  _write('estoque',  old.estoque);
      if (Array.isArray(old.vendas)   && old.vendas.length)   _write('vendas',   old.vendas);
      if (Array.isArray(old.comandas) && old.comandas.length) _write('comandas', old.comandas);
      if (Array.isArray(old.fiado)    && old.fiado.length)    _write('fiado',    old.fiado);
      if (Array.isArray(old.ponto)    && old.ponto.length)    _write('ponto',    old.ponto);
      if (Array.isArray(old.pedidos)  && old.pedidos.length)  _write('pedidos',  old.pedidos);
      if (old.config && typeof old.config === 'object')        _write('config',   old.config);
      console.info('[Store] Banco legado migrado.');
    } catch(e) { console.warn('[Store] Migração falhou:', e); }
  }

  window.addEventListener('storage', e => {
    const col = Object.entries(_key).find(([,k]) => k === e.key)?.[0];
    if (col) { delete _cache[col]; _notify(col); }
  });

  _migrarLegacy();

  return {
    getEstoque()       { return _read('estoque'); },
    getVendas()        { return _read('vendas'); },
    getComandas()      { return _read('comandas'); },
    getFiado()         { return _read('fiado'); },
    getPonto()         { return _read('ponto'); },
    getPedidos()       { return _read('pedidos'); },
    getConfig()        { return _read('config'); },
    getAuditoria()     { return _read('auditoria'); },
    getMovimentacoes() { return _read('movimentacoes'); },
    getCategorias()    { return _read('categorias'); },
    getFornecedores()  { return _read('fornecedores'); },
    getFinanceiro()    { return _read('financeiro'); },

    getVendasHoje() {
      const hoje = Utils.todayISO();
      return this.getVendas().filter(v => v.dataCurta === hoje);
    },
    getLowStock() {
      const thr = this.getConfig()?.alertaEstoque || CONSTANTS.LOW_STOCK;
      return this.getEstoque().filter(p => p.qtdUn > 0 && p.qtdUn <= thr);
    },
    getOutOfStock()    { return this.getEstoque().filter(p => (p.qtdUn||0) <= 0); },
    getInvestimento()  { return this.getConfig()?.investimento || 0; },

    mutateEstoque(fn)       { _mutate('estoque',       fn); },
    mutateVendas(fn)        { _mutate('vendas',        fn); },
    mutateComandas(fn)      { _mutate('comandas',      fn); },
    mutateFiado(fn)         { _mutate('fiado',         fn); },
    mutatePonto(fn)         { _mutate('ponto',         fn); },
    mutatePedidos(fn)       { _mutate('pedidos',       fn); },
    mutateConfig(fn)        { _mutate('config',        fn); },
    mutateAuditoria(fn)     { _mutate('auditoria',     fn); },
    mutateMovimentacoes(fn) { _mutate('movimentacoes', fn); },
    mutateCategorias(fn)    { _mutate('categorias',    fn); },
    mutateFornecedores(fn)  { _mutate('fornecedores',  fn); },
    mutateFinanceiro(fn)    { _mutate('financeiro',    fn); },

    invalidate(col) {
      if (col) delete _cache[col];
      else Object.keys(_cache).forEach(k => delete _cache[k]);
    },

    // Escrita direta sem sync (uso interno do Firebase pull)
    _writeRaw(col, data) { _write(col, data); _notify(col); },

    // ── #4: Firestore como principal ──────────────────────────────
    // localStorage = cache de trabalho offline
    // Firestore    = fonte da verdade
    // Estratégia: purge periódico de dados antigos do localStorage
    //             (Firestore os mantém; localmente só mantemos recentes)

    /**
     * Remove dados antigos do localStorage para liberar espaço.
     * Vendas/financeiro/auditoria/movimentações: mantém só os últimos N dias.
     * Estoque/config/fiado/comandas: não purga (dados operacionais ativos).
     */
    purgeOldData({ diasVendas = 30, diasFinanceiro = 30, diasAuditoria = 7, diasMovimentacoes = 14 } = {}) {
      const corte = (dias) => {
        const d = new Date();
        d.setDate(d.getDate() - dias);
        return d.toISOString().slice(0, 10);
      };

      let purged = {};

      // Vendas: mantém apenas as dos últimos N dias + as não sincronizadas
      const vendasAntes = _read('vendas').length;
      const cortaVendas = corte(diasVendas);
      const vendasFiltradas = _read('vendas').filter(v =>
        (v.dataCurta >= cortaVendas) || !v._fbSynced
      );
      if (vendasFiltradas.length < vendasAntes) {
        _write('vendas', vendasFiltradas);
        purged.vendas = vendasAntes - vendasFiltradas.length;
      }

      // Financeiro: mantém últimos N dias
      const finAntes = _read('financeiro').length;
      const cortaFin = corte(diasFinanceiro);
      const finFiltrado = _read('financeiro').filter(l => l.dataCurta >= cortaFin);
      if (finFiltrado.length < finAntes) {
        _write('financeiro', finFiltrado);
        purged.financeiro = finAntes - finFiltrado.length;
      }

      // Auditoria: mantém últimos N dias
      const audAntes = _read('auditoria').length;
      const cortaAud = corte(diasAuditoria);
      const audFiltrada = _read('auditoria').filter(r => r.dataCurta >= cortaAud);
      if (audFiltrada.length < audAntes) {
        _write('auditoria', audFiltrada);
        purged.auditoria = audAntes - audFiltrada.length;
      }

      // Movimentações: mantém últimos N dias
      const movAntes = _read('movimentacoes').length;
      const cortaMov = corte(diasMovimentacoes);
      const movFiltradas = _read('movimentacoes').filter(m => m.dataCurta >= cortaMov);
      if (movFiltradas.length < movAntes) {
        _write('movimentacoes', movFiltradas);
        purged.movimentacoes = movAntes - movFiltradas.length;
      }

      // Invalida cache para recarregar
      ['vendas','financeiro','auditoria','movimentacoes'].forEach(c => delete _cache[c]);

      const total = Object.values(purged).reduce((s, n) => s + n, 0);
      if (total > 0) {
        console.info('[Store] Purge localStorage:', purged, `— ${total} registros removidos (estão no Firestore)`);
        EventBus.emit('store:purged', purged);
      }
      return purged;
    },

    /**
     * Uso atual do localStorage em KB e % dos coleções do sistema.
     */
    getLocalStorageUsage() {
      const cols = Object.entries(_key);
      let totalBytes = 0;
      const detalhes = {};
      cols.forEach(([col, key]) => {
        const raw = localStorage.getItem(key) || '';
        const bytes = new Blob([raw]).size;
        totalBytes += bytes;
        detalhes[col] = { kb: (bytes / 1024).toFixed(1), registros: Array.isArray(_read(col)) ? _read(col).length : 1 };
      });
      // localStorage tem ~5MB de limite na maioria dos browsers
      const limitKB = 5 * 1024;
      const usadoKB = totalBytes / 1024;
      return {
        usadoKB:   usadoKB.toFixed(1),
        limitKB,
        percentual: ((usadoKB / limitKB) * 100).toFixed(1),
        detalhes,
        alerta:    usadoKB > limitKB * 0.7, // alerta acima de 70%
      };
    },

    /**
     * Hidrata o Store a partir do Firestore para coleções que estão vazias
     * ou desatualizadas no localStorage. Chamado após login.
     * Não bloqueia — executa em background.
     */
    async hydrateAsync(cols) {
      // Aguarda FirebaseService estar disponível
      if (typeof FirebaseService === 'undefined' || !FirebaseService.isReady) return;
      const ok = await FirebaseService.init().catch(() => false);
      if (!ok) return;

      const role = typeof AuthService !== 'undefined' ? AuthService.getRole() : null;
      if (!role) return;

      const permitidas = CONSTANTS.PERMISSOES[role]?.ler || [];
      const alvo = (cols || permitidas).filter(c => permitidas.includes(c));

      for (const col of alvo) {
        try {
          const local = _read(col);
          // Só hidrata se estiver vazio (primeira vez ou após purge)
          const vazio = Array.isArray(local) ? local.length === 0 : Object.keys(local || {}).length === 0;
          if (!vazio) continue;

          const remoto = await FirebaseService.ler(col);
          if (!remoto) continue;

          if (col === 'vendas' && Array.isArray(remoto)) {
            _write('vendas', remoto.slice(0, _limits.vendas));
          } else {
            _write(col, remoto);
          }
          delete _cache[col];
          _notify(col);
          console.info(`[Store] Hidratado do Firestore: ${col} (${Array.isArray(remoto) ? remoto.length : 1} registros)`);
        } catch(e) {
          console.warn(`[Store] Hidratação falhou para ${col}:`, e.message);
        }
      }
    },

    // API legada de mutate via proxy (mantida para compatibilidade)
    mutate(fn) {
      const map = {
        estoque:'estoque', vendas:'vendas', comandas:'comandas',
        fiado:'fiado', ponto:'ponto', pedidos:'pedidos',
        config:'config', auditEstoque:'auditoria', auditLog:'auditoria',
        movimentacoes:'movimentacoes', caixa:'vendas', inventario:'estoque',
      };
      const proxy = new Proxy({}, {
        get(_, prop) { const col = map[prop]; return col ? _read(col) : undefined; },
        set(_, prop, value) {
          const col = map[prop];
          if (!col) return true;
          const limit = _limits[col];
          const final = (limit && Array.isArray(value)) ? value.slice(0, limit) : value;
          _write(col, final); _notify(col);
          if (window.CH?.SyncQueue) window.CH.SyncQueue.enqueue('salvar', col, final);
          return true;
        },
      });
      fn(proxy);
      EventBus.emit('store:updated');
    },

    Selectors: {
      getEstoque()       { return Store.getEstoque(); },
      getVendas()        { return Store.getVendas(); },
      getPonto()         { return Store.getPonto(); },
      getPedidos()       { return Store.getPedidos(); },
      getComandas()      { return Store.getComandas(); },
      getFiado()         { return Store.getFiado(); },
      getMovimentacoes() { return Store.getMovimentacoes(); },
      getCategorias()    { return Store.getCategorias(); },
      getFornecedores()  { return Store.getFornecedores(); },
      getFinanceiro()    { return Store.getFinanceiro(); },
      getConfig()        { return Store.getConfig(); },
      getInvestimento()  { return Store.getInvestimento(); },
      getLowStock()      { return Store.getLowStock(); },
      getOutOfStock()    { return Store.getOutOfStock(); },
      getVendasHoje()    { return Store.getVendasHoje(); },
    },
  };
})();

/* ╔═══════════════════════════════════════════════════════════╗
   ║  6. FIREBASE SERVICE — expandido com runTransaction       ║
   ╚═══════════════════════════════════════════════════════════╝ */
const FirebaseService = (() => {
  const CONFIG = {
    apiKey:            'AIzaSyB49Pk_XrqQIm-ZNBPxCwtRjgQ_UznpRbs',
    authDomain:        'chgeladasv2.firebaseapp.com',
    projectId:         'chgeladasv2',
    storageBucket:     'chgeladasv2.firebasestorage.app',
    messagingSenderId: '286142126994',
    appId:             '1:286142126994:web:c138e076d6fa3707a33f4b',
    measurementId:     'G-K9G86L4WV1',
  };

  let _db = null, _auth = null, _fb = null;
  let _ready = false, _adminToken = null;
  let _unsubscribers = [];

  async function init() {
    if (_ready) return true;
    if (!CONFIG.apiKey) { console.info('[Firebase] Sem config — offline.'); return false; }
    try {
      const { initializeApp, getApps, getApp } =
        await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      _fb   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const auth = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

      const app = getApps().length ? getApp() : initializeApp(CONFIG);
      _db   = _fb.getFirestore(app);
      _auth = auth.getAuth(app);

      if (!_auth.currentUser) {
        await auth.signInAnonymously(_auth);
        console.info('[Firebase] ✓ Auth anônima. UID:', _auth.currentUser?.uid);
      }

      _ready = true;
      console.info('[Firebase] ✓ Projeto:', CONFIG.projectId);
      EventBus.emit('firebase:ready');
      _subscribeRealtime();
      return true;
    } catch(e) {
      console.warn('[Firebase] Falha:', e.message);
      return false;
    }
  }

  function _subscribeRealtime() {
    _unsubscribers.forEach(fn => { try { fn(); } catch(_) {} });
    _unsubscribers = [];
    const role = AuthService.getRole();
    if (!role || !_db || !_fb) return;

    const colsRT = role === 'admin'
      ? ['estoque', 'config', 'fiado', 'comandas', 'pedidos']
      : ['estoque', 'config'];

    colsRT.forEach(col => {
      try {
        const unsub = _fb.onSnapshot(
          _fb.doc(_db, 'ch_dados', col),
          snap => {
            if (!snap.exists()) return;
            const dados = snap.data()?.dados;
            if (!dados) return;
            const key = CONSTANTS.DB[col.toUpperCase()];
            if (!key) return;
            try { localStorage.setItem(key, JSON.stringify(dados)); } catch(_) {}
            Store.invalidate(col);
            EventBus.emit('store:updated', col);
            EventBus.emit(`store:${col}`);
            EventBus.emit('sync:ok', col);
          },
          err => console.warn('[RT]', col, err.code)
        );
        _unsubscribers.push(unsub);
      } catch(e) { console.warn('[RT] subscribe falhou:', col, e.message); }
    });
  }

  async function gerarAdminToken(pin) {
    if (!_auth?.currentUser) return null;
    const uid = _auth.currentUser.uid;
    const raw = `${uid}:${pin}:ch_geladas_admin`;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    _adminToken = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    return _adminToken;
  }

  async function salvar(colName, dados) {
    if (!_ready || !_db || !_fb) return false;
    try {
      if (colName === 'vendas') {
        const pendentes = Array.isArray(dados)
          ? dados.filter(v => v?.id && !v._fbSynced).slice(0, 50)
          : [];
        if (!pendentes.length) return true;
        const batch = _fb.writeBatch(_db);
        pendentes.forEach(venda => {
          const ref = _fb.doc(_db, 'vendas', venda.id);
          batch.set(ref, { ...venda, _fbSynced: true, syncedAt: Utils.nowISO() });
        });
        await batch.commit();
        const key = CONSTANTS.DB.VENDAS;
        try {
          const vendasLocal = JSON.parse(localStorage.getItem(key) || '[]');
          const ids = new Set(pendentes.map(v => v.id));
          vendasLocal.forEach(v => { if (ids.has(v.id)) v._fbSynced = true; });
          localStorage.setItem(key, JSON.stringify(vendasLocal));
          Store.invalidate('vendas');
        } catch(_) {}
        console.info(`[Firebase] ✓ ${pendentes.length} venda(s) sincronizadas.`);
      } else {
        const docData = { dados, ts: Utils.nowISO() };
        if (_adminToken) docData.adminToken = _adminToken;
        await _fb.setDoc(_fb.doc(_db, 'ch_dados', colName), docData);
      }
      return true;
    } catch(e) {
      console.warn('[Firebase] Salvar falhou:', colName, e.code || e.message);
      return false;
    }
  }

  async function ler(colName) {
    if (!_ready || !_db || !_fb) return null;
    try {
      if (colName === 'vendas') {
        const snap = await _fb.getDocs(
          _fb.query(_fb.collection(_db, 'vendas'), _fb.orderBy('criadoEm','desc'), _fb.limit(1000))
        );
        return snap.docs.map(d => ({ ...d.data(), _fbSynced: true }));
      } else {
        const snap = await _fb.getDoc(_fb.doc(_db, 'ch_dados', colName));
        return snap.exists() ? snap.data().dados : null;
      }
    } catch(e) {
      console.warn('[Firebase] Ler falhou:', colName, e.code || e.message);
      return null;
    }
  }

  // ── Métodos de baixo nível expostos aos services ──────────────────
  function _requireReady() {
    if (!_ready || !_db || !_fb) throw new Error('Firebase não inicializado. Chame await FirebaseService.init() primeiro.');
  }

  async function runTransaction(fn) {
    _requireReady();
    return _fb.runTransaction(_db, fn);
  }

  function docRef(colPath, docId) {
    _requireReady();
    return docId
      ? _fb.doc(_db, colPath, docId)
      : _fb.doc(_db, colPath);
  }

  function colRef(colPath) {
    _requireReady();
    return _fb.collection(_db, colPath);
  }

  function newDocRef(colPath) {
    _requireReady();
    return _fb.doc(_fb.collection(_db, colPath));
  }

  function getBatch() {
    _requireReady();
    return _fb.writeBatch(_db);
  }

  function serverTimestamp() {
    _requireReady();
    return _fb.serverTimestamp();
  }

  return {
    init, salvar, ler,
    isReady: () => _ready,
    getUID:  () => _auth?.currentUser?.uid || null,
    getConfig: () => ({ ...CONFIG }),
    setConfig(c) { Object.assign(CONFIG, c); Store.mutateConfig(cfg => { cfg.firebase = { ...c }; }); },
    gerarAdminToken,
    getAdminToken:     () => _adminToken,
    clearAdminToken:   () => { _adminToken = null; },
    subscribeRealtime: _subscribeRealtime,

    // Novos — para uso pelos services
    runTransaction,
    docRef,
    colRef,
    newDocRef,
    getBatch,
    serverTimestamp,
  };
})();

/* ╔═══════════════════════════════════════════════════════════╗
   ║  7. SYNC SERVICE (legado — novo em services/syncService)  ║
   ╚═══════════════════════════════════════════════════════════╝ */
const SyncService = (() => {
  const _fila  = new Set();
  let   _timer = null;
  const DEBOUNCE = 1500;

  function _podeEscrever(col) {
    const role = AuthService.getRole();
    return role ? (CONSTANTS.PERMISSOES[role]?.escrever?.includes(col) ?? false) : false;
  }

  function push(col) {
    if (!_podeEscrever(col)) return;
    _fila.add(col);
    clearTimeout(_timer);
    _timer = setTimeout(_flush, DEBOUNCE);
  }

  async function _flush() {
    if (!_fila.size) return;
    const ok = await FirebaseService.init();
    if (!ok) { _fila.clear(); return; }
    for (const col of _fila) {
      if (!_podeEscrever(col)) continue;
      const dados = Store[`get${col.charAt(0).toUpperCase()+col.slice(1)}`]?.();
      if (dados == null) continue;
      const sucesso = await FirebaseService.salvar(col, dados);
      if (sucesso) EventBus.emit('sync:ok', col);
    }
    _fila.clear();
  }

  async function pull(cols) {
    const role = AuthService.getRole();
    if (!role) return;
    const alvo = cols || CONSTANTS.PERMISSOES[role].ler;
    const ok   = await FirebaseService.init();
    if (!ok) return;

    for (const col of alvo) {
      const dados = await FirebaseService.ler(col);
      if (dados == null) continue;
      if (col === 'vendas') {
        const localVendas = Store.getVendas();
        const localIds    = new Set(localVendas.map(v => v.id));
        const novas       = dados.filter(v => v.id && !localIds.has(v.id));
        if (novas.length > 0) {
          const merged = [...novas, ...localVendas]
            .sort((a, b) => (b.criadoEm||'') > (a.criadoEm||'') ? 1 : -1)
            .slice(0, CONSTANTS.MAX_VENDAS);
          Store._writeRaw('vendas', merged);
          console.info(`[Sync] Merge: +${novas.length} vendas do Firebase.`);
        }
      } else {
        const key = CONSTANTS.DB[col.toUpperCase()];
        if (key) { try { localStorage.setItem(key, JSON.stringify(dados)); } catch(_) {} }
        Store.invalidate(col);
      }
      EventBus.emit('store:updated', col);
      EventBus.emit(`store:${col}`);
    }
    EventBus.emit('sync:pull:done');
    console.info('[Sync] Pull concluído para role:', role);
  }

  return { push, pull, flush: _flush };
})();

/* ╔═══════════════════════════════════════════════════════════╗
   ║  8. AUTH SERVICE                                          ║
   ╚═══════════════════════════════════════════════════════════╝ */
const AuthService = {
  _session: null,

  _load() {
    if (this._session) return this._session;
    try {
      const raw = sessionStorage.getItem(CONSTANTS.SESSION_KEY);
      this._session = raw ? JSON.parse(raw) : null;
    } catch { this._session = null; }
    return this._session;
  },

  isLogged() { return !!(this._load()?.role); },
  isAdmin()  { return this._load()?.role === 'admin'; },
  getRole()  { return this._load()?.role || null; },
  getNome()  { return this._load()?.nome || 'Colaborador'; },
  getUID()   { return FirebaseService.getUID(); },

  canWrite(col) {
    const role = this.getRole();
    return role ? (CONSTANTS.PERMISSOES[role]?.escrever?.includes(col) ?? false) : false;
  },
  canRead(col) {
    const role = this.getRole();
    return role ? (CONSTANTS.PERMISSOES[role]?.ler?.includes(col) ?? false) : false;
  },

  async login(pin) {
    const role = await CryptoService.validatePin(pin);
    if (!role) return false;
    const session = { role, nome: role === 'admin' ? 'Administrador' : 'Colaborador', loginAt: Date.now() };
    sessionStorage.setItem(CONSTANTS.SESSION_KEY, JSON.stringify(session));
    this._session = session;
    if (role === 'admin') {
      await FirebaseService.init();
      await FirebaseService.gerarAdminToken(String(pin).trim());
    } else {
      FirebaseService.clearAdminToken();
    }
    setTimeout(() => FirebaseService.init().then(() => FirebaseService.subscribeRealtime()), 300);
    setTimeout(() => SyncService.pull(), 800);

    // #4: Purge dados antigos do localStorage + hidrata coleções vazias do Firestore
    setTimeout(() => {
      Store.purgeOldData();
      const uso = Store.getLocalStorageUsage();
      if (uso.alerta) {
        console.warn(`[Store] localStorage em ${uso.percentual}% (${uso.usadoKB}KB) — considere purge manual`);
      }
    }, 2000);
    setTimeout(() => Store.hydrateAsync(), 3000);

    EventBus.emit('auth:login', { role });
    return true;
  },

  logout() {
    sessionStorage.removeItem(CONSTANTS.SESSION_KEY);
    this._session = null;
    FirebaseService.clearAdminToken();
    EventBus.emit('auth:logout');
  },

  guard(redirectTo = 'index.html') {
    if (!this.isLogged()) { location.href = redirectTo; return false; }
    return true;
  },
};

/* ╔═══════════════════════════════════════════════════════════╗
   ║  9. UI SERVICE                                            ║
   ╚═══════════════════════════════════════════════════════════╝ */
const UIService = {
  _toastTimer: null,

  showToast(title, sub = '', type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const icons  = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
    const colors = {
      success:'bg-emerald-500/20 text-emerald-400',
      error:  'bg-red-500/20 text-red-400',
      warning:'bg-amber-500/20 text-amber-400',
      info:   'bg-blue-500/20 text-blue-400',
    };
    const iconEl  = document.getElementById('toastIcon');
    const titleEl = document.getElementById('toastMsg');
    const subEl   = document.getElementById('toastSub');
    if (iconEl)  { iconEl.className = `w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-black ${colors[type]}`; iconEl.textContent = icons[type]; }
    if (titleEl) titleEl.textContent = title;
    if (subEl)   subEl.textContent   = sub;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  },

  openModal(id)  { document.getElementById(id)?.classList.add('open'); },
  closeModal(id) { document.getElementById(id)?.classList.remove('open'); },

  startClock(id = 'clock') {
    const tick = () => { const el = document.getElementById(id); if (el) el.textContent = new Date().toLocaleTimeString('pt-BR'); };
    tick(); setInterval(tick, 1000);
  },

  setSyncDot(ok, msg = '') {
    const dot = document.getElementById('syncDot');
    if (!dot) return;
    dot.style.display    = 'block';
    dot.style.background = ok ? '#10b981' : '#f59e0b';
    dot.title            = ok ? 'Sincronizado' : (msg || 'Sync pendente...');
  },

  showOfflineBanner(show) {
    let banner = document.getElementById('offlineBanner');
    if (!banner && show) {
      banner = document.createElement('div');
      banner.id = 'offlineBanner';
      banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#f59e0b;color:#000;text-align:center;padding:6px;font-size:13px;font-weight:600;z-index:9999';
      banner.textContent = '⚠ Sem internet — operando offline. Dados serão sincronizados ao reconectar.';
      document.body.appendChild(banner);
    } else if (banner && !show) {
      banner.remove();
    }
  },
};

EventBus.on('sync:ok',        () => UIService.setSyncDot(true));
EventBus.on('sync:pull:done', () => UIService.setSyncDot(true));
window.addEventListener('offline', () => UIService.showOfflineBanner(true));
window.addEventListener('online',  () => UIService.showOfflineBanner(false));

/* ╔═══════════════════════════════════════════════════════════╗
   ║  10. CART SERVICE                                         ║
   ╚═══════════════════════════════════════════════════════════╝ */
const CartService = (() => {
  let _items = [], _desconto = 0, _pgtos = [], _formaPgto = '';

  return {
    getItems()     { return [..._items]; },
    getCount()     { return _items.reduce((s, i) => s + i.qtd, 0); },
    getSubtotal()  { return _items.reduce((s, i) => s + i.preco * i.qtd, 0); },
    getTotal()     { return Math.max(0, this.getSubtotal() - _desconto); },
    getDesconto()  { return _desconto; },
    setDesconto(v) { _desconto = Math.max(0, Number(v) || 0); },
    setFormaPgto(f){ _formaPgto = f; },
    addPagamento(forma, valor) { _pgtos.push({ forma, valor }); },
    clearPagamentos() { _pgtos = []; _formaPgto = ''; },

    add(prod, qtd = 1, label = 'UNID', preco = null) {
      const p   = Number(preco ?? prod.precoUn) || 0;
      const idx = _items.findIndex(i => i.prodId === prod.id && i.label === label);
      if (idx >= 0) _items[idx].qtd += qtd;
      else _items.push({ prodId:prod.id, nome:prod.nome, preco:p, custo:prod.custoUn||0, label, qtd });
      EventBus.emit('cart:updated');
    },

    remove(idx)         { _items.splice(idx,1); EventBus.emit('cart:updated'); },
    updateQty(idx, qtd) {
      if (qtd <= 0) this.remove(idx);
      else { _items[idx].qtd = qtd; EventBus.emit('cart:updated'); }
    },
    clear() { _items = []; _desconto = 0; _pgtos = []; _formaPgto = ''; EventBus.emit('cart:updated'); },
    isEmpty() { return !_items.length; },

    finalize(formaPgto) {
      if (this.isEmpty()) return null;

      // Delega ao VendasService se disponível (transação Firebase)
      if (window.CH?.VendasService) {
        return window.CH.VendasService.finalizarVenda(this, formaPgto);
      }

      // Fallback legado
      const itens    = this.getItems();
      const total    = this.getTotal();
      const subtotal = this.getSubtotal();
      const desconto = this.getDesconto();
      const lucro    = itens.reduce((s,i) => s + (i.preco - i.custo)*i.qtd, 0) - desconto;

      const venda = {
        id: Utils.generateId(), dataCurta: Utils.todayISO(),
        data: Utils.today(), hora: Utils.nowTime(), criadoEm: Utils.nowISO(),
        itens, total, subtotal, desconto, lucro,
        formaPgto: formaPgto || _formaPgto || 'Dinheiro',
        origem: 'PDV', operador: AuthService.getNome(),
        role: AuthService.getRole(), _fbSynced: false,
      };

      Store.mutateVendas(vendas => { vendas.unshift(venda); });
      Store.mutateEstoque(estoque => {
        itens.forEach(item => {
          const prod = estoque.find(p => p.id === item.prodId);
          if (!prod) return;
          const qtdDesconto = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
          prod.qtdUn = Math.max(0, (prod.qtdUn||0) - qtdDesconto);
        });
      });
      Store.mutateAuditoria(audit => {
        audit.unshift({ tipo:'venda', id:venda.id, total, formaPgto:venda.formaPgto, operador:venda.operador, criadoEm:venda.criadoEm });
      });
      this.clear();
      EventBus.emit('venda:finalizada', venda);
      return venda;
    },
  };
})();

/* ╔═══════════════════════════════════════════════════════════╗
   ║  11. TELEGRAM SERVICE                                     ║
   ╚═══════════════════════════════════════════════════════════╝ */
const TelegramService = (() => {
  const API = 'https://api.telegram.org/bot';

  function _cfg()   { return Store.getConfig()?.telegram || {}; }
  function _ativo() { const c = _cfg(); return !!(c.ativo && c.botToken && c.chatId); }

  async function enviar(texto) {
    if (!_ativo()) return false;
    const { botToken, chatId } = _cfg();
    try {
      const res  = await fetch(`${API}${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ chat_id:chatId, text:texto, parse_mode:'HTML' }),
      });
      const json = await res.json();
      if (!json.ok) console.warn('[Telegram] Erro:', json.description);
      return json.ok;
    } catch(e) { console.warn('[Telegram] Falha:', e.message); return false; }
  }

  function _emoji(forma) {
    const map = { dinheiro:'💵', pix:'📱', cartao:'💳', credito:'💳', debito:'💳', fiado:'📋', misto:'🔀' };
    return map[(forma||'').toLowerCase()] || '💰';
  }

  async function notificarVenda(venda) {
    if (!_ativo()) return;
    const itensTexto = venda.itens.map(i => `  • ${i.nome}${i.label!=='UNID'?` (${i.label})`:''} × ${i.qtd}`).join('\n');
    const desconto   = venda.desconto > 0 ? `\n🏷 <b>Desconto:</b> -${Utils.formatCurrency(venda.desconto)}` : '';
    await enviar(
      `🛒 <b>Nova Venda — CH Geladas</b>\n━━━━━━━━━━━━━━━━━━\n${itensTexto}\n` +
      `━━━━━━━━━━━━━━━━━━${desconto}\n${_emoji(venda.formaPgto)} <b>Total:</b> ${Utils.formatCurrency(venda.total)}\n` +
      `💳 <b>Pgto:</b> ${(venda.formaPgto||'—').toUpperCase()}\n🕐 <b>Hora:</b> ${venda.hora}  |  👤 ${venda.operador}`
    );
  }

  async function notificarEstoqueBaixo(produtos) {
    if (!_ativo() || !produtos.length) return;
    const lista = produtos.map(p => `  ⚠️ <b>${p.nome}</b> — ${p.qtdUn} un.`).join('\n');
    await enviar(`⚠️ <b>Estoque Baixo — CH Geladas</b>\n━━━━━━━━━━━━━━━━━━\n${lista}\n━━━━━━━━━━━━━━━━━━\nReabasteça antes de acabar!`);
  }

  async function notificarEstoqueZerado(produtos) {
    if (!_ativo() || !produtos.length) return;
    const lista = produtos.map(p => `  🚨 <b>${p.nome}</b> — ZERADO`).join('\n');
    await enviar(`🚨 <b>RUPTURA DE ESTOQUE — CH Geladas</b>\n━━━━━━━━━━━━━━━━━━\n${lista}`);
  }

  async function notificarFiado(cliente, valor, obs) {
    if (!_ativo()) return;
    await enviar(
      `📋 <b>Fiado Registrado — CH Geladas</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Cliente:</b> ${cliente}\n💸 <b>Valor:</b> ${Utils.formatCurrency(valor)}\n` +
      (obs ? `📝 <b>Obs:</b> ${obs}\n` : '') + `🕐 <b>Hora:</b> ${Utils.nowFull()}`
    );
  }

  async function testar() {
    return enviar(`✅ <b>CH Geladas PDV</b>\nNotificações Telegram configuradas!\n🕐 ${Utils.nowFull()}`);
  }

  function salvarConfig({ botToken, chatId, ativo = true }) {
    Store.mutateConfig(cfg => { cfg.telegram = { botToken:String(botToken).trim(), chatId:String(chatId).trim(), ativo }; });
  }

  return { enviar, notificarVenda, notificarEstoqueBaixo, notificarEstoqueZerado, notificarFiado, testar, salvarConfig, getConfig:_cfg, isAtivo:_ativo };
})();

// Hooks automáticos de venda
EventBus.on('venda:finalizada', async venda => {
  TelegramService.notificarVenda(venda);
  const thr      = Store.getConfig()?.alertaEstoque || 3;
  const estoque  = Store.getEstoque();
  const ids      = new Set(venda.itens.map(i => i.prodId));
  const afetados = estoque.filter(p => ids.has(p.id));
  const zerados  = afetados.filter(p => (p.qtdUn||0) <= 0);
  const baixos   = afetados.filter(p => (p.qtdUn||0) > 0 && p.qtdUn <= thr);
  if (zerados.length) TelegramService.notificarEstoqueZerado(zerados);
  if (baixos.length)  TelegramService.notificarEstoqueBaixo(baixos);
});

EventBus.on('fiado:lancado', ({ cliente, valor, obs } = {}) => {
  if (cliente && valor) TelegramService.notificarFiado(cliente, valor, obs);
});

/* ╔═══════════════════════════════════════════════════════════╗
   ║  NAMESPACE GLOBAL                                         ║
   ╚═══════════════════════════════════════════════════════════╝ */
window.CH = {
  CONSTANTS, Utils, CryptoService, EventBus,
  Store, FirebaseService, SyncService,
  AuthService, UIService, CartService, TelegramService,
  // services/ são adicionados ao window.CH quando carregados
};

window.showToast = (title, sub, type) => UIService.showToast(title, sub, type);

// Fila de pending sync (antes do SyncQueue carregar)
window._pendingSync = [];

/* ╔═══════════════════════════════════════════════════════════╗
   ║  PWA — Service Worker                                     ║
   ╚═══════════════════════════════════════════════════════════╝ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.info('[SW] Registrado:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const novoSW = reg.installing;
        novoSW?.addEventListener('statechange', () => {
          if (novoSW.state === 'installed' && navigator.serviceWorker.controller) {
            EventBus.emit('sw:update-available');
            UIService.showToast('Atualização disponível', 'Recarregue para aplicar.', 'info');
          }
        });
      });
    } catch(e) { console.warn('[SW] Falha:', e.message); }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
}

console.info(
  '%c CH Geladas core.js v4 %c Services ✓  Transactions ✓  SyncQueue ✓  Audit ✓',
  'background:#1e293b;color:#60a5fa;font-weight:bold;padding:2px 6px;border-radius:4px',
  'color:#94a3b8'
);
