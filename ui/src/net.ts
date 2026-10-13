import { useSyncExternalStore } from 'react';

/**
 * Whether the Spark answers. api.ts reports every request: a fetch that throws (not an abort) means the server or the
 * network is gone, and any response means it's back. While it's down this probes every few seconds, so the banner
 * (components/ConnectionBanner.tsx) clears on its own when the box wakes up or the laptop rejoins the network.
 */
let down = false;
let timer: number | undefined;
const listeners = new Set<() => void>();

/**
 * Cloudflare Access (in front of ai.shellb.app) runs its own session. When that runs out it answers every request with
 * a redirect to its login page on another site, which a fetch can't follow, so it looks exactly like the Spark is gone
 * and the banner would wait forever. Only loading the page can sign in again: ask without following redirects, and if
 * the answer is that redirect (or Access's own 401/403; Shell:B's /api/auth/me always answers 200), reload.
 */
const EDGE_RELOAD = 'shellb.edgeLoginAt';
export async function reloadIfEdgeLogin() {
  try {
    const r = await fetch('/api/auth/me', { cache: 'no-store', redirect: 'manual' });
    if (r.type !== 'opaqueredirect' && r.status !== 401 && r.status !== 403) return;
  } catch { return; }  // really unreachable
  let last = 0;
  try { last = Number(sessionStorage.getItem(EDGE_RELOAD)) || 0; } catch { /* storage blocked */ }
  if (Date.now() - last < 60_000) return;  // just came back from the login and still turned away: don't loop
  try { sessionStorage.setItem(EDGE_RELOAD, String(Date.now())); } catch { /* storage blocked */ }
  location.reload();
}

function set(d: boolean) {
  if (d) reloadIfEdgeLogin();
  if (d === down) return;
  down = d;
  window.clearInterval(timer);
  timer = d ? window.setInterval(probe, 5000) : undefined;
  listeners.forEach(l => l());
}

export async function probe() {
  try {
    await fetch('/api/auth/me', { cache: 'no-store' });
    set(false);
  } catch {
    set(true);
  }
}

/** api.ts: a request went through (any status) or failed to reach the server. */
export function reportNet(ok: boolean, err?: unknown) {
  if (ok) set(false);
  else if (!(err instanceof DOMException && err.name === 'AbortError')) set(true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => set(true));
  window.addEventListener('online', () => { probe(); });
}

export const useServerDown = () => useSyncExternalStore(
  cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => down, () => false);
