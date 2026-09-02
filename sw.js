/* ============================================================================
   BATTLEXJOURNAL — Ultra-Low Latency Service Worker
   Fast Cache-First & Stale-While-Revalidate Strategy for Core Assets
   ============================================================================ */
const CACHE_NAME = 'battlex-v2';
const STATIC_ASSETS = [
  '/assets/tokens.css',
  '/assets/tailwind-compiled.css',
  '/assets/trademind-theme.css',
  '/assets/lucide.min.js',
  '/assets/sidebar-nav.js',
  '/assets/favicon.png',
  '/src/core/index.js',
  '/core.js',
  '/connection.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // Do not intercept API calls, auth routes, or websocket connections
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // Stale-While-Revalidate for CSS, JS, fonts, and static assets
  if (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(req).then(cached => {
          const fetchPromise = fetch(req).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(req, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cached);
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // Network-First with Cache Fallback for HTML documents
  if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
        }
        return networkResponse;
      }).catch(() => caches.match(req))
    );
  }
});
