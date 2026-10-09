import { useSyncExternalStore } from 'react';
import { linkRoute } from './links';

/**
 * The installed app's ties to the operating system (manifest.webmanifest, public/sw.js). Imported for its side effects
 * in main.tsx, so launches are caught before the app has loaded:
 * - launch_handler `focus-existing`: a shortcut, a link or a file opened while Shell:B is already running comes to the
 *   open window through `launchQueue` instead of opening a second window; this moves that window to the route.
 * - protocol_handlers: a `web+shellb:` link clicked in another app opens `/?link=<url>` (links.ts says what it means).
 * - file_handlers ("Open with Shell:B") and share_target ("Share → Shell:B") hand over files and text. They wait in
 *   `incoming` until a composer takes them into a new chat (Composer.tsx, mobile/MobileComposer.tsx).
 * - the install prompt (Settings → General) and the dock/taskbar badge.
 */

export interface Incoming { files: File[]; text: string }

let pending: Incoming | null = null;
const listeners = new Set<() => void>();

function deliver(files: File[], text: string) {
  if (!files.length && !text.trim()) return;
  pending = { files: [...(pending?.files ?? []), ...files], text: [pending?.text, text].filter(Boolean).join('\n\n') };
  listeners.forEach(l => l());
}

/** Files and text handed to Shell:B from outside, or null. Taking them clears them. */
export function takeIncoming(): Incoming | null {
  const p = pending;
  pending = null;
  return p;
}

/** Start a new chat with this text waiting in the composer (e.g. "Design a theme" in Settings), as a share would. */
export function startChatWith(text: string) { deliver([], text); }

/** Called when something arrives: the app shell opens a new chat and its composer takes it. Returns the unsubscribe. */
export function onIncoming(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ── launches ────────────────────────────────────────────────────────────────

interface LaunchParams { targetURL?: string; files?: FileSystemFileHandle[] }
type LaunchQueue = { setConsumer: (cb: (p: LaunchParams) => void) => void };

function consumeLaunch(p: LaunchParams) {
  if (p.files?.length) {
    Promise.all(p.files.map(h => h.getFile())).then(files => deliver(files, '')).catch(() => {});
    return;
  }
  if (!p.targetURL) return;
  const target = new URL(p.targetURL);
  const link = target.searchParams.get('link');
  const hash = link !== null ? linkRoute(link) : target.hash;
  if (hash?.startsWith('#/') && hash !== location.hash) location.hash = hash;
}

/** The service worker stashes a share (POST /share-target) in this cache and opens `/?share=<id>`. */
const SHARE_CACHE = 'shellb-share';

async function readShare(id: string) {
  const cache = await caches.open(SHARE_CACHE);
  const meta = await cache.match(`/__share/${id}/meta`);
  if (!meta) return;
  const { title = '', text = '', url = '', count = 0 } = await meta.json() as { title?: string; text?: string; url?: string; count?: number };
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const r = await cache.match(`/__share/${id}/${i}`);
    if (!r) continue;
    files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('X-Name') ?? `shared-${i}`), { type: r.headers.get('Content-Type') ?? '' }));
  }
  await Promise.all((await cache.keys()).filter(k => new URL(k.url).pathname.startsWith(`/__share/${id}/`)).map(k => cache.delete(k)));
  // apps put the link in `text` or `url` and the page name in `title`; don't repeat what's already there
  const parts = [title, text, url].map(s => s.trim()).filter(Boolean);
  deliver(files, parts.filter((s, i) => !parts.some((o, j) => j !== i && o.length > s.length && o.includes(s))).join('\n'));
}

if (typeof window !== 'undefined') {
  (window as unknown as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(consumeLaunch);

  // launches arrive as /?share=<id> (share_target, via sw.js), /?open (file_handlers) and /?link=<url>
  // (protocol_handlers); keep the address clean
  const q = new URLSearchParams(location.search);
  const share = q.get('share');
  const link = q.get('link');
  if (share !== null || q.has('open') || link !== null) {
    history.replaceState(null, '', '/' + ((link !== null && linkRoute(link)) || location.hash || '#/'));
  }
  if (share && /^[\w-]{1,64}$/.test(share) && 'caches' in window) readShare(share).catch(() => {});
}

// ── install ─────────────────────────────────────────────────────────────────

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let installEvent: InstallEvent | null = null;
const standalone = () => typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: window-controls-overlay)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
let installed = standalone();
const installListeners = new Set<() => void>();
const changed = () => installListeners.forEach(l => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e as InstallEvent; changed(); });
  window.addEventListener('appinstalled', () => { installEvent = null; installed = true; changed(); });
}

export type InstallState = 'installed' | 'available' | 'unavailable';
const installState = (): InstallState => (installed ? 'installed' : installEvent ? 'available' : 'unavailable');

/** Whether this browser can install Shell:B as an app right now (Chromium only offers it once, until dismissed). */
export const useInstallState = () => useSyncExternalStore(
  cb => { installListeners.add(cb); return () => { installListeners.delete(cb); }; }, installState, () => 'unavailable' as InstallState);

export async function promptInstall() {
  const e = installEvent;
  if (!e) return false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  installEvent = null;
  changed();
  return outcome === 'accepted';
}

// ── badge ───────────────────────────────────────────────────────────────────

type BadgeNav = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
let lastBadge = -1;

/** The count on the dock/taskbar icon. Only the installed app shows one; elsewhere this does nothing. */
export function setBadge(n: number) {
  if (n === lastBadge) return;
  lastBadge = n;
  const nav = navigator as BadgeNav;
  (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}
