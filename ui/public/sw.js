const CACHE_NAME = 'shellb-v1';
// Share → Shell:B (manifest share_target) stashes what was shared here until the page takes it (src/desktop.ts)
const SHARE_CACHE = 'shellb-share';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== SHARE_CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// The share sheet POSTs the shared files and text here. Keep them in SHARE_CACHE and open the app on them; the page
// reads and deletes them (src/desktop.ts readShare). The server never sees this request.
const receiveShare = async (request) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    const str = (k) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((f, i) => cache.put(`/__share/${id}/${i}`, new Response(f, {
      headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || `shared-${i}`) },
    }))));
    await cache.put(`/__share/${id}/meta`, new Response(JSON.stringify({ title: str('title'), text: str('text'), url: str('url'), count: files.length }),
      { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    return Response.redirect('/#/', 303);
  }
  return Response.redirect(`/?share=${id}`, 303);
};

// Shown when Shell:B can't be reached and this device has never cached the app (first visit, or cleared site data).
const offlinePage = () => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a0d1f"><title>Shell:B · offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0d1f;color:#e5e7eb;font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:22rem;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#9ca3af;margin:0 0 20px}
button{font:inherit;color:#fff;background:#7c3aed;border:0;border-radius:10px;padding:8px 18px;cursor:pointer}</style></head>
<body><main><h1>Can’t reach Shell:B</h1><p>The Spark may be asleep, restarting or on another network. This page reloads by itself when it answers.</p>
<button onclick="location.reload()">Try again</button></main>
<script>setInterval(()=>fetch('/api/auth/me',{cache:'no-store'}).then(()=>location.reload(),()=>{}),5000);addEventListener('online',()=>location.reload())</script>
</body></html>`, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;
  
  // Don't cache API requests
  if (url.pathname.startsWith('/api/')) return;
  
  // Don't cache browser extensions or external non-http
  if (!url.protocol.startsWith('http')) return;

  // Network-first for HTML to ensure we always try to get the latest app version
  if (event.request.headers.get('accept')?.includes('text/html') || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).then((response) => {
        // one copy of the page is enough: launches add ?share=… and ?open, which would each cache another
        if (response && response.status === 200 && !url.search) {
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
        return offlinePage();
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

// tell the server what happened on this device (server/notify.py /ack): it otherwise only knows the push service took it
const reportPush = async (shown, reason) => {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/notify/ack', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, shown, reason: reason || '' }),
    });
  } catch (e) { /* offline or signed out: nothing to report to */ }
};

// The installed app's icon badge, between visits: the same sum the app rail shows (src/installedApp.ts). The open app
// keeps it exact; here a push re-reads it, or shows a plain dot if the server can't say.
const syncBadge = async () => {
  if (!self.navigator.setAppBadge) return;
  try {
    const r = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    const n = ((s.activity && s.activity.pending) || 0) + ((s.activity && s.activity.unread) || 0) + (s.memoryPending || 0);
    await (n ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge());
  } catch (e) {
    await self.navigator.setAppBadge().catch(() => {});
  }
};

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = {}; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // she's looking at Shell:B on this device right now: the Activity badge is enough (a test always shows)
    if (m.k !== 'test') await syncBadge();
    if (m.k !== 'test' && wins.some((c) => c.focused && c.visibilityState === 'visible')) {
      await reportPush(false, 'skipped: Shell:B was open and focused on this device');
      return;
    }
    if (self.Notification && self.Notification.permission !== 'granted') {
      await reportPush(false, `notification permission is "${self.Notification.permission}" for this site`);
    }
    try {
      await self.registration.showNotification(m.t || 'Shell:B', {
      body: m.b || '',
      tag: m.tag || undefined,
      data: { route: typeof m.r === 'string' && m.r.startsWith('#/') ? m.r : '#/activity' },
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      requireInteraction: m.k === 'approval' || m.k === 'question',
      timestamp: Date.now(),
    });
    } catch (e) {
      await reportPush(false, `the browser couldn't show it: ${e && e.message ? e.message : e}`);
      return;
    }
    await reportPush(true);
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
