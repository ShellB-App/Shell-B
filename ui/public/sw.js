const CACHE_NAME = 'shellb-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  
  // Don't cache API requests
  if (url.pathname.startsWith('/api/')) return;
  
  // Don't cache browser extensions or external non-http
  if (!url.protocol.startsWith('http')) return;

  // Network-first for HTML to ensure we always try to get the latest app version
  if (event.request.headers.get('accept')?.includes('text/html') || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // fallback to / if offline and specific path not cached (for SPA routing)
        const rootCached = await caches.match('/');
        if (rootCached) return rootCached;
        throw new Error('Offline');
      })
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images, vendor files)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Optionally fetch in background to update cache for next time (stale-while-revalidate)
        fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response));
          }
        }).catch(() => {}); // Ignore network errors in background
        return cachedResponse;
      }
      
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Notifications (server/notify.py, src/notify.ts) ─────────────────────────
// Push payloads are tiny JSON: { t: title, b?: body, r: hash route, tag, a: needs attention, k: kind }.

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = {}; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // she's looking at Shell:B on this device right now: the Activity badge is enough (a test always shows)
    if (m.k !== 'test' && wins.some((c) => c.focused && c.visibilityState === 'visible')) return;
    await self.registration.showNotification(m.t || 'Shell:B', {
      body: m.b || '',
      tag: m.tag || undefined,
      data: { route: typeof m.r === 'string' && m.r.startsWith('#/') ? m.r : '#/activity' },
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      requireInteraction: m.k === 'approval' || m.k === 'question',
      timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || '#/activity';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      await win.focus().catch(() => {});
      win.postMessage({ type: 'shellb-open', route });  // src/notify.ts moves the app to the route
      return;
    }
    await self.clients.openWindow('/' + route);
  })());
});

const b64uBytes = (s) => {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};

// the push service rotated this device's subscription: subscribe again and tell the server (uses the session cookie)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    let sub = event.newSubscription;
    if (!sub) {
      const { publicKey } = await (await fetch('/api/notify/key', { credentials: 'same-origin' })).json();
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(publicKey) });
    }
    await fetch('/api/notify/subscribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), replaces: old ? old.endpoint : '' }),
    });
  })());
});
