import { useSyncExternalStore } from 'react';

/**
 * The overlay: a small always-on-top window (Document Picture-in-Picture, Chromium 116+) that stays over other apps,
 * so you can talk to Shell:B while it looks at your screen. App.tsx renders components/Overlay.tsx into it with a
 * portal, so it shares the main window's chat state. It copies the page's stylesheets and keeps <html>'s theme
 * classes in sync. Opening it needs a click or key press (user activation); it closes with its own close button,
 * closeOverlay(), or when the main window goes away.
 */

interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number; disallowReturnToOpener?: boolean; preferInitialWindowPlacement?: boolean }): Promise<Window>;
  window: Window | null;
}

const pip = () => (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture;
export const overlaySupported = () => !!pip() && window.isSecureContext;

let win: Window | null = null;
const subs = new Set<() => void>();
const publish = () => subs.forEach(f => f());

export function useOverlayWindow(): Window | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => win);
}

function copyStyles(to: Document) {
  // the rules themselves, so the overlay is styled at once and needs no fetch; a sheet that can't be read
  // (another origin) is linked again
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const s = to.createElement('style');
      s.textContent = Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
      to.head.appendChild(s);
    } catch {
      if (!sheet.href) continue;
      const l = to.createElement('link');
      l.rel = 'stylesheet';
      l.href = sheet.href;
      to.head.appendChild(l);
    }
  }
}

/** <html>'s classes (dark/light, wco, dj-live), data-skin and inline theme variables follow the main window. */
function mirrorRoot(to: Document): () => void {
  const sync = () => {
    const from = document.documentElement;
    for (const a of Array.from(to.documentElement.attributes)) if (!from.hasAttribute(a.name)) to.documentElement.removeAttribute(a.name);
    for (const a of Array.from(from.attributes)) to.documentElement.setAttribute(a.name, a.value);
    to.documentElement.classList.remove('wco');  // the overlay has no custom title bar
    to.documentElement.classList.add('shellb-overlay');
  };
  sync();
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true });
  return () => mo.disconnect();
}

export async function openOverlay(): Promise<Window> {
  if (win) { win.focus(); return win; }
  const api = pip();
  if (!api || !window.isSecureContext) throw new Error('The overlay needs Chrome or Edge over HTTPS.');
  let size = { width: 380, height: 520 };
  try { size = { ...size, ...JSON.parse(localStorage.getItem('shellb.overlay.size') || '{}') }; } catch { /* first time */ }
  const w = await api.requestWindow({ ...size, preferInitialWindowPlacement: false });
  w.document.title = 'Shell:B';
  copyStyles(w.document);
  const stop = mirrorRoot(w.document);
  const root = w.document.createElement('div');
  root.id = 'overlay-root';
  root.className = 'h-full';
  w.document.body.appendChild(root);
  w.addEventListener('resize', () => {
    try { localStorage.setItem('shellb.overlay.size', JSON.stringify({ width: w.innerWidth, height: w.innerHeight })); } catch { /* private mode */ }
  });
  w.addEventListener('pagehide', () => { stop(); if (win === w) { win = null; publish(); } }, { once: true });
  win = w;
  publish();
  return w;
}

export function closeOverlay() { win?.close(); }

export const toggleOverlay = () => (win ? (closeOverlay(), Promise.resolve(null)) : openOverlay());
