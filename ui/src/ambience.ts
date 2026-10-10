import { useEffect, useState } from 'react';

// Per-browser display extras (startup animation, screensaver). Like the theme and skin they live in
// localStorage, so a phone and a desktop can differ.
export type SplashMode = 'off' | 'session' | 'always';
/** A built-in style, or `studio:<project id>` for a screensaver made in the Studio (a Screensaver project's index.html). */
export type SaverStyle = 'synthwave' | 'starfield' | 'bounce' | SceneStyle | `studio:${string}`;
/** Scenes built from the themes' scenery and particles (components/Screensaver.tsx, ambience.css). */
export type SceneStyle = 'meadow' | 'aurora' | 'rain' | 'abyss' | 'sakura' | 'dunes';

export interface AmbiencePrefs {
  splash: SplashMode;
  saverMinutes: number;  // 0 = screensaver off
  saverStyle: SaverStyle;
  saverClock: boolean;
}

const KEY = 'shellb.ambience';
const EVENT = 'shellb-ambience';
export const PREVIEW_SPLASH = 'shellb-splash-preview';
export const PREVIEW_SAVER = 'shellb-saver-preview';

export const AMBIENCE_DEFAULTS: AmbiencePrefs = { splash: 'session', saverMinutes: 10, saverStyle: 'synthwave', saverClock: true };
export const SAVER_STYLES: { id: SaverStyle; label: string }[] = [
  { id: 'synthwave', label: 'Synthwave horizon' },
  { id: 'starfield', label: 'Starfield warp' },
  { id: 'bounce', label: 'Bouncing logo' },
  { id: 'meadow', label: 'Firefly meadow' },
  { id: 'aurora', label: 'Northern lights' },
  { id: 'rain', label: 'Rain on the window' },
  { id: 'abyss', label: 'Deep sea' },
  { id: 'sakura', label: 'Night sakura' },
  { id: 'dunes', label: 'Arrakis dusk' },
];
export const SAVER_MINUTES = [0, 1, 2, 5, 10, 15, 30, 60];
/** The Studio project behind a screensaver style, or null for a built-in one. */
export const studioSaverId = (style: string) => (/^studio:[\w-]+$/.test(style) ? style.slice(7) : null);

export function loadAmbience(): AmbiencePrefs {
  try { return { ...AMBIENCE_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return AMBIENCE_DEFAULTS; }
}

export function saveAmbience(patch: Partial<AmbiencePrefs>) {
  const next = { ...loadAmbience(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function useAmbience(): AmbiencePrefs {
  const [prefs, setPrefs] = useState(loadAmbience);
  useEffect(() => {
    const on = (e: Event) => setPrefs((e as CustomEvent<AmbiencePrefs>).detail);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setPrefs(loadAmbience()); };
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', onStorage); };
  }, []);
  return prefs;
}

// Headless screenshots (?shot) and the standalone artifact viewer get neither extra.
// For screenshots of the extras themselves: ?shot&ambience=splash, or ?shot&ambience=saver[:style] (style may be studio:<id>).
// PREVIEW_SAVER can carry a style in its detail to preview that one instead of the saved one (the Studio's Preview button).
export const ambienceShot = () => /[?&]ambience=([\w:-]+)/.exec(location.search)?.[1] ?? '';
export const ambienceSuppressed = () => /[?&]shot\b/.test(location.search) || /^#\/view\//.test(location.hash);
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
