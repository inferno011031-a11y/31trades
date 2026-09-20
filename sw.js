/* ============================================================================
   BATTLEXJOURNAL — Ultra-Low Latency Service Worker
   Fast Cache-First & Stale-While-Revalidate Strategy for Core Assets
   ============================================================================ */
const CACHE_NAME = 'battlex-v3';
const STATIC_ASSETS = [
  '/assets/tokens.css',
  '/assets/tailwind-compiled.css',
  '/assets/trademind-theme.css',
  '/assets/lucide.min.js',
  '/assets/sidebar-nav.js',
  '/assets/favicon.png',
  '/src/core/index.js',
  '/src/merge.js',
  '/core.js',
  '/connection.js'
];

// Precache with `cache: 'reload'`: a CACHE_NAME bump must pull the DEPLOYED files,
// not whatever the browser still considers fresh under a max-age=86400 response
// header. Without it a release can precache the previous build of core.js and keep
// serving it long after the fix shipped. Individual failures are tolerated (an
// asset that 404s must not abort the whole install).
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(STATIC_ASSETS.map(url =>
        fetch(new Request(url, { cache: 'reload' }))
          .then(res => { if (res && res.status === 200) return cache.put(url, res); })
          .catch(() => {}))))
      .then(() => self.skipWaiting())
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
