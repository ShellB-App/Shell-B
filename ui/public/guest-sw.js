// Shell:B Guest's service worker (served by server/guest_app.py). It makes the app installable and keeps the shell
// (guest.html and its hashed assets) for a quick start; /api is never cached, and there's no push.
const CACHE = 'shellb-guest-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shellb-guest-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {  // network first, so a deploy shows up at once; the cached page when offline
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return r;
    }).catch(() => caches.match('/').then(r => r || Response.error())));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {  // content-hashed: cache first
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    })));
  }
});
