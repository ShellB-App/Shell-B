// Notifications (server/notify.py): Web Push subscription for this device, the owner's per-kind preferences,
// and a tab-only fallback. Imported for its side effects in main.tsx: it routes notification clicks (the service
// worker posts { type: 'shellb-open', route }) and runs the hidden-tab poller when this device uses it.
import { req } from './api';

export type NotifyLevel = 'off' | 'attention' | 'all';
export interface NotifyKind { id: string; label: string; hint: string; default: NotifyLevel }
export interface NotifyPrefs { levels: Record<string, NotifyLevel>; details: boolean; kinds: NotifyKind[] }
export interface PushDevice {
  id: string; label: string; service: string; hash: string; created: number;
  /** the push service (Google, Mozilla, Apple) accepted a message for this device */
  lastOk: number; lastError: string;
  /** the device's own service worker confirmed it showed one, or said why it couldn't (server/notify.py /ack) */
  lastShown: number; shownError: string;
}
export interface PushResult { id: string; ok: boolean; status: number; error: string; removed: boolean }

export const notifyApi = {
  key: () => req<{ publicKey: string }>('/api/notify/key'),
  prefs: () => req<NotifyPrefs>('/api/notify/prefs'),
  setPrefs: (p: { levels?: Record<string, NotifyLevel>; details?: boolean }) =>
    req<NotifyPrefs>('/api/notify/prefs', { method: 'PUT', body: JSON.stringify(p) }),
  devices: () => req<PushDevice[]>('/api/notify/devices'),
  subscribe: (subscription: PushSubscriptionJSON, label: string) =>
    req<PushDevice>('/api/notify/subscribe', { method: 'POST', body: JSON.stringify({ subscription, label }) }),
  unsubscribe: (endpoint: string) =>
    req<{ ok: boolean }>('/api/notify/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  removeDevice: (id: string) => req<{ ok: boolean }>(`/api/notify/devices/${id}`, { method: 'DELETE' }),
  test: (id?: string) => req<{ sent: number; results: PushResult[] }>('/api/notify/test', { method: 'POST', body: JSON.stringify(id ? { id } : {}) }),
};

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Why push can't work here, or null when it can. */
export function pushBlocker(): 'insecure' | 'ios-install' | 'unsupported' | null {
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !standalone()) return 'ios-install';  // iOS only allows Web Push in a Home Screen app
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return null;
}

export function deviceLabel(ua = navigator.userAgent) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Same short hash the server shows per device, to mark "this device" in the list. */
export async function endpointHash(endpoint: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const b64uBytes = (s: string) => {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, ch => ch.charCodeAt(0));
};

const registration = () => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushBlocker()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission, subscribe with the server's VAPID key and register this device. */
export async function enablePush(): Promise<PushDevice> {
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    throw new Error('permission-denied');
  }
  const { publicKey } = await notifyApi.key();
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with another key (e.g. data/notify was reset) can't receive our pushes
  const key = sub?.options.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(publicKey) });
  return notifyApi.subscribe(sub.toJSON(), deviceLabel());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await notifyApi.unsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

// ── tab-only fallback ──────────────────────────────────────────────────────
// For devices without push (no push service reachable, or plain http://localhost): while a Shell:B tab is open
// but hidden, poll the server's recent-notification ring and show them through the service worker.

const TAB_KEY = 'shellb.notify.tab';
const POLL_MS = 20000;
export const tabFallback = {
  get: () => { try { return localStorage.getItem(TAB_KEY) === '1'; } catch { return false; } },
  set: (on: boolean) => {
    try { if (on) localStorage.setItem(TAB_KEY, '1'); else localStorage.removeItem(TAB_KEY); } catch { /* storage blocked */ }
    startTabFallback();
  },
};

interface Recent { t: string; b?: string; r: string; tag: string; k: string; ts: number }
let timer: number | undefined;
let since = 0;

async function show(m: Recent) {
  const opts = { body: m.b ?? '', tag: m.tag, data: { route: m.r }, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' };
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
  if (reg) return reg.showNotification(m.t, opts);
  const n = new Notification(m.t, opts);
  n.onclick = () => { window.focus(); location.hash = m.r; n.close(); };
}

async function poll() {
  try {
    const r = await fetch(`/api/notify/recent?since=${since}`);
    if (!r.ok) return;
    const { now, items } = await r.json() as { now: number; items: Recent[] };
    const first = since === 0;
    since = Math.max(since, now);
    if (first || !document.hidden) return;  // only what happened while she wasn't looking at this tab
    for (const m of items) await show(m);
  } catch { /* offline or signed out: try again next round */ }
}

export async function startTabFallback() {
  window.clearInterval(timer);
  timer = undefined;
  since = 0;
  if (!tabFallback.get() || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (await currentSubscription().catch(() => null)) return;  // push already covers this device
  poll();
  timer = window.setInterval(poll, POLL_MS);
}

if (typeof window !== 'undefined') {
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; route?: string } | null;
    if (d?.type === 'shellb-open' && typeof d.route === 'string' && d.route.startsWith('#/')) location.hash = d.route;
  });
  startTabFallback();
}
