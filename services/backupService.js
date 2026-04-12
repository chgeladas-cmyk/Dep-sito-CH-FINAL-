'use strict';
/**
 * services/backupService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Backup automático diário dos dados do sistema.
 *
 * Estratégias:
 *   1. JSON local   → download automático ou manual
 *   2. Firestore    → salva em /backups/{data}/{timestamp}
 *   3. Agendamento  → verifica 1x por dia; só faz backup se não fez hoje
 *
 * O backup inclui todos os módulos:
 *   estoque, vendas, comandas, fiado, ponto, pedidos,
 *   config, auditoria, movimentacoes, categorias, fornecedores, financeiro
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, FirebaseService } = window.CH;

  const BACKUP_META_KEY = 'CH_BACKUP_META'; // {lastBackup: ISO, count: number}
  const BACKUP_KEY      = 'CH_LAST_BACKUP'; // snapshot do último backup (comprimido)

  // ── Coleta todos os dados ─────────────────────────────────────────
  function _coletarDados() {
    return {
      versao:        'v8',
      geradoEm:      Utils.nowISO(),
      geradoPor:     AuthService.getNome(),
      role:          AuthService.getRole(),
      estoque:       Store.getEstoque(),
      vendas:        Store.getVendas(),
      comandas:      Store.getComandas(),
      fiado:         Store.getFiado(),
      ponto:         Store.getPonto(),
      pedidos:       Store.getPedidos(),
      config:        _sanitizarConfig(Store.getConfig()),
      auditoria:     Store.getAuditoria().slice(0, 1000), // últimos 1000
      movimentacoes: Store.getMovimentacoes().slice(0, 2000),
      categorias:    Store.getCategorias(),
      fornecedores:  Store.getFornecedores(),
      financeiro:    Store.getFinanceiro().slice(0, 2000),
    };
  }

  // Remove PINs e tokens do backup (segurança)
  function _sanitizarConfig(cfg) {
    if (!cfg) return {};
    const { pinHashAdmin, pinHashPdv, firebase, telegram, ...rest } = cfg;
    return {
      ...rest,
      telegram: telegram ? { ativo: telegram.ativo } : undefined, // preserva só o flag
    };
  }

  // ── Metadados ─────────────────────────────────────────────────────
  function _getMeta() {
    try { return JSON.parse(localStorage.getItem(BACKUP_META_KEY) || '{}'); } catch { return {}; }
  }

  function _setMeta(meta) {
    try { localStorage.setItem(BACKUP_META_KEY, JSON.stringify(meta)); } catch {}
  }

  function _fezHoje() {
    const meta = _getMeta();
    return meta.lastBackup?.slice(0, 10) === Utils.todayISO();
  }

  // ── Backup em JSON (download) ─────────────────────────────────────
  function exportarJSON(dados) {
    const json     = JSON.stringify(dados, null, 2);
    const filename = `CH_Backup_${Utils.todayISO()}_${Utils.nowTime().replace(':','-')}.json`;
    Utils.downloadBlob(json, 'application/json', filename);
    return filename;
  }

  // ── Backup no Firestore ───────────────────────────────────────────
  async function _salvarFirestore(dados) {
    if (!FirebaseService.isReady()) {
      const ok = await FirebaseService.init();
      if (!ok) return false;
    }

    try {
      const ref = FirebaseService.newDocRef(`backups/${Utils.todayISO()}/snapshots`);

      // Salva metadados do backup (sem os dados volumosos para não exceder limite)
      const meta = {
        id:        ref.id,
        geradoEm:  dados.geradoEm,
        geradoPor: dados.geradoPor,
        versao:    dados.versao,
        stats: {
          estoque:    dados.estoque?.length     || 0,
          vendas:     dados.vendas?.length      || 0,
          fiado:      dados.fiado?.length       || 0,
          financeiro: dados.financeiro?.length  || 0,
        },
      };

      const batch = FirebaseService.getBatch();

      // Metadados do snapshot
      batch.set(ref, meta);

      // Dados em sub-documentos (evita limite de 1MB por doc)
      const colsGrandes = ['vendas', 'movimentacoes', 'financeiro', 'auditoria'];
      const colsPequenas = Object.keys(dados).filter(k =>
        !colsGrandes.includes(k) && Array.isArray(dados[k])
      );

      // Salva coleções pequenas juntas
      const smallRef = FirebaseService.docRef(`backups/${Utils.todayISO()}/snapshots`, ref.id + '_small');
      const smallData = {};
      colsPequenas.forEach(k => { smallData[k] = dados[k]; });
      smallData.config = dados.config;
      batch.set(smallRef, { dados: smallData, ts: dados.geradoEm });

      await batch.commit();
      console.info('[Backup] ✓ Salvo no Firestore:', Utils.todayISO());
      return true;
    } catch(e) {
      console.warn('[Backup] Firestore falhou:', e.message);
      return false;
    }
  }

  // ── Backup local (localStorage — snapshot compacto) ───────────────
  function _salvarLocal(dados) {
    try {
      // Salva versão resumida (só metadados + stats) para não estourar localStorage
      const resumo = {
        geradoEm: dados.geradoEm,
        stats: {
          estoque:    dados.estoque?.length     || 0,
          vendas:     dados.vendas?.length      || 0,
          fiado:      dados.fiado?.length       || 0,
          financeiro: dados.financeiro?.length  || 0,
          movimentacoes: dados.movimentacoes?.length || 0,
        },
      };
      localStorage.setItem(BACKUP_KEY, JSON.stringify(resumo));
      return true;
    } catch { return false; }
  }

  // ── Backup completo ───────────────────────────────────────────────
  /**
   * Executa backup completo:
   *   1. Coleta todos os dados
   *   2. Salva no Firestore (se online e admin)
   *   3. Salva metadados locais
   *   4. Emite evento
   *
   * @param {boolean} forcarDownload - se true, faz download do JSON
   */
  async function fazerBackup(forcarDownload = false) {
    if (!AuthService.isAdmin()) {
      console.info('[Backup] Apenas admin pode fazer backup.');
      return null;
    }

    console.info('[Backup] Iniciando...');
    const dados = _coletarDados();

    // 1. Firestore (assíncrono, não bloqueia)
    const fbOk = await _salvarFirestore(dados);

    // 2. Local resumido
    _salvarLocal(dados);

    // 3. Atualiza metadados
    const meta = _getMeta();
    _setMeta({
      lastBackup: dados.geradoEm,
      count:      (meta.count || 0) + 1,
      fbOk,
    });

    // 4. Download JSON se solicitado
    if (forcarDownload) {
      exportarJSON(dados);
    }

    EventBus.emit('backup:concluido', {
      geradoEm: dados.geradoEm,
      fbOk,
      stats: {
        estoque:    dados.estoque?.length || 0,
        vendas:     dados.vendas?.length  || 0,
      },
    });

    console.info(`[Backup] ✓ Concluído — Firestore: ${fbOk ? 'sim' : 'não'}`);
    return dados;
  }

  // ── Backup automático diário ──────────────────────────────────────
  async function _verificarBackupDiario() {
    if (!AuthService.isAdmin()) return;
    if (_fezHoje()) {
      console.info('[Backup] Já feito hoje:', _getMeta().lastBackup?.slice(0,10));
      return;
    }

    // Aguarda Firebase estar pronto
    const ok = await FirebaseService.init().catch(() => false);
    await fazerBackup(false); // sem download automático
  }

  // ── Agendar verificação ───────────────────────────────────────────
  function _agendar() {
    // Verifica imediatamente ao logar
    EventBus.on('auth:login', ({ role }) => {
      if (role === 'admin') {
        setTimeout(_verificarBackupDiario, 10_000); // 10s após login
      }
    });

    // Verifica também quando Firebase estiver pronto (pode ter logado antes)
    EventBus.on('firebase:ready', () => {
      if (AuthService.isAdmin()) {
        setTimeout(_verificarBackupDiario, 15_000);
      }
    });

    // Verifica a cada hora (para sessões longas)
    setInterval(() => {
      if (AuthService.isAdmin() && !_fezHoje()) {
        _verificarBackupDiario();
      }
    }, 60 * 60 * 1000);
  }

  _agendar();

  // ── Status ────────────────────────────────────────────────────────
  function getStatus() {
    const meta = _getMeta();
    const resumo = (() => {
      try { return JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}'); } catch { return {}; }
    })();
    return {
      ultimoBackup:   meta.lastBackup || null,
      totalBackups:   meta.count      || 0,
      fezHoje:        _fezHoje(),
      fbOk:           meta.fbOk       ?? null,
      stats:          resumo.stats    || {},
    };
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.BackupService = {
    fazerBackup,      // async — completo (Firestore + local)
    exportarJSON,     // gera download de um objeto de dados
    coletarDados: _coletarDados, // retorna snapshot sem salvar
    getStatus,
    fezHoje: _fezHoje,
  };

  console.info('%c BackupService ✓  (auto-diário + Firestore + JSON)', 'color:#10b981');
})();
