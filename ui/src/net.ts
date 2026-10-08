import { useSyncExternalStore } from 'react';

/**
 * Whether the Spark answers. api.ts reports every request: a fetch that throws (not an abort) means the server or the
 * network is gone, and any response means it's back. While it's down this probes every few seconds, so the banner
 * (components/ConnectionBanner.tsx) clears on its own when the box wakes up or the laptop rejoins the network.
 */
let down = false;
let timer: number | undefined;
const listeners = new Set<() => void>();

function set(d: boolean) {
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
