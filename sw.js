// CH Geladas PDV — Service Worker v4
// Cache estratégico: App Shell + Network-first para dados

const CACHE_VERSION = 'ch-geladas-v8';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;

// ── App Shell (cache-first) ───────────────────────────────────────
const APP_SHELL = [
  './',
  './index.html',
  './vendas.html',
  './estoque.html',
  './financeiro.html',
  './comanda.html',
  './delivery.html',
  './fiado.html',
  './ponto.html',
  './cardapio.html',
  './manifest.json',
  './core.js',
  // Services
  './services/syncService.js',
  './services/auditService.js',
  './services/syncMonitor.js',
  './services/backupService.js',
  './services/estoqueService.js',
  './services/vendasService.js',
  './services/financeiroService.js',
  './services/userService.js',
  // Icons
  './icon-72.png',
  './icon-96.png',
  './icon-128.png',
  './icon-144.png',
  './icon-152.png',
  './icon-192.png',
  './icon-384.png',
  './icon-512.png',
];

// ── Install: pré-cacheia App Shell ───────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
  console.info('[SW] v4 instalado — App Shell em cache.');
});

// ── Activate: limpa caches antigos ───────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => {
            console.info('[SW] Removendo cache antigo:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estratégia por tipo de recurso ─────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requisições não-GET e fora da origem
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin && !_isFirebaseSDK(url)) return;

  // ── Firebase SDK (CDN) — cache-first ──────────────────────────
  if (_isFirebaseSDK(url)) {
    event.respondWith(_cacheFirst(request, API_CACHE));
    return;
  }

  // ── App Shell (HTML, JS, CSS, icons) — stale-while-revalidate ─
  if (_isAppShell(url)) {
    event.respondWith(_staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // ── Resto — network-first com fallback ────────────────────────
  event.respondWith(_networkFirst(request, STATIC_CACHE));
});

// ── Estratégias de cache ──────────────────────────────────────────

/** Cache-first: usa cache se disponível, busca rede se não */
async function _cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

/** Network-first: tenta rede, usa cache se falhar */
async function _networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

/** Stale-while-revalidate: responde do cache imediatamente, atualiza em background */
async function _staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

// ── Helpers ──────────────────────────────────────────────────────
function _isFirebaseSDK(url) {
  return url.hostname === 'www.gstatic.com' || url.hostname.includes('firebaseapp.com');
}

function _isAppShell(url) {
  const path = url.pathname;
  return path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css') ||
         path.endsWith('.png')  || path.endsWith('.json') || path === '/' || path === '';
}

// ── Notificação de update para o app ─────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
