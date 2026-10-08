import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { appById, appForHash } from './apps';

type NavigationLike = { canGoBack?: boolean; canGoForward?: boolean };
const navigation = () => (window as unknown as { navigation?: NavigationLike }).navigation;

/**
 * The installed desktop app's title bar, shown only under Window Controls Overlay (see wco.ts). The whole strip drags
 * the window and double-click maximises it; the buttons opt out. An installed window has no browser toolbar, so it
 * carries Back and Forward. It also copies its background into <meta name="theme-color">, which is what Chrome paints
 * the window buttons with, so they match in every theme.
 */
export function TitleBar() {
  const [hash, setHash] = useState(location.hash);
  const [nav, setNav] = useState({ back: true, forward: false });
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setHash(location.hash);
      const n = navigation();
      setNav({ back: n?.canGoBack ?? true, forward: n?.canGoForward ?? true });
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const original = meta?.content;
    const paint = () => { if (meta && bar.current) meta.content = getComputedStyle(bar.current).backgroundColor; };
    paint();
    const themes = new MutationObserver(paint);  // light/dark and skin switches change the class and data-skin on <html>
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin'] });
    return () => { themes.disconnect(); if (meta && original) meta.content = original; };
  }, []);

  const section = appById(appForHash(hash)).label;
  const btn = 'wco-nodrag p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-35 disabled:hover:bg-transparent';

  return (
    <div ref={bar} className="wco-titlebar">
      <div className="wco-titlebar-area flex items-center gap-1 px-2">
        <button className={btn} onClick={() => history.back()} disabled={!nav.back} aria-label="Back" title="Back (Alt ←)">
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button className={btn} onClick={() => history.forward()} disabled={!nav.forward} aria-label="Forward" title="Forward (Alt →)">
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <span className="ml-1.5 text-xs font-semibold tracking-wider text-[var(--text-primary)] select-none">Shell:B</span>
        <span className="text-xs text-[var(--text-muted)] select-none truncate">· {section}</span>
      </div>
    </div>
  );
}
