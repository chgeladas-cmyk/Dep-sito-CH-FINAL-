'use strict';
/**
 * services/userService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Controle de usuários com papéis e permissões granulares.
 *
 * Papéis:
 *   admin     → acesso total
 *   gerente   → estoque, financeiro, relatórios (não altera config)
 *   operador  → vendas + consulta de estoque
 *   entregador→ delivery + consulta pedidos
 *   pdv       → apenas vendas (compatibilidade legada)
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, CryptoService } = window.CH;

  const USERS_KEY = 'CH_USERS';

  // ── Permissões por papel ──────────────────────────────────────────
  const PERMISSOES_ROLES = {
    admin: {
      label:    'Administrador',
      cor:      '#ef4444',
      acessos:  ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','config','auditoria','relatorios','usuarios'],
    },
    gerente: {
      label:    'Gerente',
      cor:      '#f59e0b',
      acessos:  ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','relatorios'],
    },
    operador: {
      label:    'Operador',
      cor:      '#3b82f6',
      acessos:  ['vendas','estoque:leitura','comandas','delivery'],
    },
    entregador: {
      label:    'Entregador',
      cor:      '#8b5cf6',
      acessos:  ['delivery','pedidos:leitura'],
    },
    pdv: {
      label:    'PDV (Caixa)',
      cor:      '#10b981',
      acessos:  ['vendas'],
    },
  };

  // ── Persistência ──────────────────────────────────────────────────
  function _loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
  }
  function _saveUsers(users) {
    try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch(e) {}
  }

  // ── CRUD de usuários ──────────────────────────────────────────────

  /** Cria um novo usuário */
  async function criarUsuario({ nome, role, pin }) {
    if (!PERMISSOES_ROLES[role]) throw new Error(`Papel inválido: ${role}`);
    if (!pin || String(pin).length < 3) throw new Error('PIN deve ter pelo menos 3 dígitos');

    const users  = _loadUsers();
    const pinHash = await CryptoService.sha256(String(pin).trim());

    // Verifica duplicata de PIN
    if (users.find(u => u.pinHash === pinHash)) {
      throw new Error('Este PIN já está em uso por outro usuário');
    }

    const user = {
      id:        Utils.generateId(),
      nome:      nome.trim(),
      role,
      pinHash,
      ativo:     true,
      criadoEm:  Utils.nowISO(),
      criadoPor: AuthService.getNome(),
    };

    users.push(user);
    _saveUsers(users);

    EventBus.emit('usuario:criado', { id: user.id, nome: user.nome, role: user.role });
    return { ...user, pinHash: undefined }; // não expõe hash
  }

  /** Atualiza dados de um usuário */
  async function atualizarUsuario(id, campos) {
    const users = _loadUsers();
    const idx   = users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error(`Usuário ${id} não encontrado`);

    if (campos.pin) {
      campos.pinHash = await CryptoService.sha256(String(campos.pin).trim());
      delete campos.pin;
    }

    Object.assign(users[idx], campos, { updatedAt: Utils.nowISO() });
    _saveUsers(users);
    return { ...users[idx], pinHash: undefined };
  }

  /** Desativa um usuário */
  function desativarUsuario(id) {
    return atualizarUsuario(id, { ativo: false });
  }

  /** Lista usuários (sem expor pinHash) */
  function getUsuarios({ apenasAtivos = true } = {}) {
    let users = _loadUsers();
    if (apenasAtivos) users = users.filter(u => u.ativo);
    return users.map(u => ({ ...u, pinHash: undefined }));
  }

  /** Valida PIN e retorna usuário (ou null) */
  async function validarPin(pin) {
    const pinHash = await CryptoService.sha256(String(pin).trim());
    const users   = _loadUsers();
    const user    = users.find(u => u.ativo && u.pinHash === pinHash);

    if (user) return { id: user.id, nome: user.nome, role: user.role };

    // Fallback: usa validação legada do core (admin/pdv hardcoded)
    const legacyRole = await window.CH.CryptoService.validatePin(pin);
    if (legacyRole) {
      return { id: 'legacy', nome: legacyRole === 'admin' ? 'Administrador' : 'Colaborador', role: legacyRole };
    }

    return null;
  }

  // ── Verificações de permissão ─────────────────────────────────────

  /** Verifica se o papel tem acesso a um módulo */
  function temAcesso(role, modulo) {
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    // 'admin' tem acesso a tudo
    if (role === 'admin') return true;
    // Verifica acesso completo ou leitura
    return perms.acessos.some(a => a === modulo || a === `${modulo}:leitura` || a.startsWith(modulo));
  }

  /** Verifica se o papel pode escrever em um módulo */
  function podeEscrever(role, modulo) {
    if (role === 'admin' || role === 'gerente') return true;
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    // Somente se tem acesso completo (sem ':leitura')
    return perms.acessos.includes(modulo);
  }

  function getRoleInfo(role) {
    return PERMISSOES_ROLES[role] || null;
  }

  function getRoles() {
    return Object.entries(PERMISSOES_ROLES).map(([id, info]) => ({ id, ...info }));
  }

  // ── Login via UserService ─────────────────────────────────────────
  /**
   * Login aprimorado que usa o banco de usuários (CH_USERS).
   * Se o usuário for legado (admin/pdv hardcoded), delega ao AuthService.
   * Se for um usuário do banco, seta a sessão diretamente.
   */
  async function login(pin) {
    const user = await validarPin(pin);
    if (!user) return false;

    if (user.id === 'legacy') {
      // Usuário legado — usa AuthService que já sabe lidar com hashes hardcoded
      return window.CH.AuthService.login(pin);
    }

    // Usuário do banco CH_USERS — seta sessão diretamente
    const session = {
      role:    user.role,
      nome:    user.nome,
      userId:  user.id,
      loginAt: Date.now(),
    };
    sessionStorage.setItem(window.CH.CONSTANTS.SESSION_KEY, JSON.stringify(session));
    window.CH.AuthService._session = session;

    // Inicia Firebase e listeners (igual ao AuthService.login)
    if (user.role === 'admin') {
      await window.CH.FirebaseService.init();
      await window.CH.FirebaseService.gerarAdminToken(String(pin).trim());
    } else {
      window.CH.FirebaseService.clearAdminToken();
    }

    setTimeout(() => {
      window.CH.FirebaseService.init().then(() => window.CH.FirebaseService.subscribeRealtime());
    }, 300);
    setTimeout(() => window.CH.SyncService.pull(), 800);

    window.CH.EventBus.emit('auth:login', { role: user.role });
    return user;
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.UserService = {
    criarUsuario,
    atualizarUsuario,
    desativarUsuario,
    getUsuarios,
    validarPin,
    login,
    temAcesso,
    podeEscrever,
    getRoleInfo,
    getRoles,
    PERMISSOES_ROLES,
  };

  console.info('%c UserService ✓  (Roles: admin, gerente, operador, entregador, pdv)', 'color:#10b981');
})();
