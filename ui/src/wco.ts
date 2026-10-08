import { useSyncExternalStore } from 'react';

/**
 * Window Controls Overlay: the installed desktop app (manifest `display_override`) hides the browser's title bar and
 * leaves the minimise/maximise/close buttons floating over the page. While it's on, <html> gets the `wco` class, which
 * moves the page below Shell:B's own strip (components/TitleBar.tsx, index.css). The owner can switch it off from the
 * chevron in the strip, which brings the normal title bar back and fires the media query's change event.
 * `?shot&wco` fakes it in an ordinary browser so headless screenshots can check the layout.
 */
const mq = typeof window !== 'undefined' ? window.matchMedia?.('(display-mode: window-controls-overlay)') : undefined;
const forced = typeof window !== 'undefined' && /[?&]shot\b/.test(location.search) && /[?&]wco\b/.test(location.search);

const active = () => forced || !!mq?.matches;
const apply = () => document.documentElement.classList.toggle('wco', active());

if (typeof document !== 'undefined') {
  apply();
  mq?.addEventListener('change', apply);
}

function subscribe(cb: () => void) {
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}

export const useWindowControlsOverlay = () => useSyncExternalStore(subscribe, active, () => false);
