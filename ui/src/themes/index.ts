// Themes. Each one is a stylesheet in this folder scoped to html[data-skin='<id>'] that overrides the CSS variables (and,
// if it likes, the chrome) of the base look in index.css. Classic *is* that base, so it sets no data-skin at all.
// Light/dark is a separate switch (the html class); a theme that has no design for a mode falls back to Classic there.
// A theme can also ask for particles (`ambient`), drawn by ./Ambient.tsx behind the app.
//
// To add a theme: write <id>.css here, import it below, and add an entry to THEMES. index.html's boot script repeats the
// theme ids and DEFAULT_THEME so the right theme paints before React loads: keep the two in step.
//
// Custom themes ('custom:<id>') are designed by Shell:B in chat and kept on the server (server/themes.py); ./custom.ts
// turns one into a stylesheet that's injected as a <style>, with data-skin='custom'. The list and the active theme's CSS
// are cached in localStorage so the boot script can paint a custom theme before React loads, too.
//
// The choice lives in localStorage ('shellb.skin', the old skin key, so existing picks carry over). When the server's
// settings know a `theme` key it is also saved there, and the server's value wins on load so it follows you across devices.
import { useSyncExternalStore } from 'react';
import { req } from '../api';
import type { AmbientKind } from './Ambient';
import { customCss, FONT_STACKS, type CustomTheme } from './custom';
import './ambient.css';
import './synthwave.css';
import './synthfield.css';
import './normandy.css';
import './sakura.css';
import './pandora.css';
import './rain.css';
import './abyss.css';
import './arrakis.css';
import './borealis.css';
import './ghibli.css';

export type BuiltinTheme = 'synthfield' | 'synthwave' | 'normandy' | 'sakura' | 'pandora' | 'rain' | 'abyss' | 'arrakis' | 'borealis' | 'ghibli' | 'classic';
export type ThemeId = BuiltinTheme | `custom:${string}`;
export type Mode = 'dark' | 'light';
export type { CustomTheme };

/** Colours for the picker's thumbnail: page, panel, text, then the theme's accent inks (drawn as a stripe). */
export interface Swatch { bg: string; panel: string; text: string; inks: string[] }

/** Particles behind the app (./Ambient.tsx). `extra` colours a secondary layer (Pandora's spores). */
export interface AmbientConfig { kind: AmbientKind; colors?: string[]; extra?: string[]; density?: number;
  /** 'normal' paints instead of adding light: glows vanish on a light page */
  blend?: 'normal' }

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  blurb: string;
  modes: Mode[];
  /** heading face for the thumbnail */
  font?: string;
  /** square corners in the thumbnail */
  hard?: boolean;
  /** pill buttons and big radii in the thumbnail */
  round?: boolean;
  swatch: Partial<Record<Mode, Swatch>>;
  ambient?: Partial<Record<Mode, AmbientConfig>>;
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'synthfield', label: 'Synthfield', modes: ['dark', 'light'], hard: true, font: "'Barlow Condensed', sans-serif",
    blurb: 'Synthwave night drawn like a Starfield ship console: hard panels, condensed caps, the sunset stripe.',
    swatch: {
      dark: { bg: '#0a0d1f', panel: '#10142b', text: '#f1ecdf', inks: ['#3d7bff', '#ff3d7f', '#ff7a2f', '#ffc23d'] },
      light: { bg: '#ebe6d9', panel: '#f6f2e8', text: '#15172a', inks: ['#3d7bff', '#ff3d7f', '#ff7a2f', '#ffc23d'] },
    },
  },
  {
    id: 'synthwave', label: 'Synthwave', modes: ['dark', 'light'],
    blurb: 'Neon violet and hot pink on deep indigo, a sunset gradient and a glowing grid floor. Light is vaporwave daylight, a striped sun sinking into a pink grid.',
    swatch: {
      dark: { bg: '#120a24', panel: '#190e33', text: '#f6ecff', inks: ['#a855f7', '#ff2e97', '#ff7a3d', '#22d3ee'] },
      light: { bg: '#fbf3ff', panel: '#fff9ff', text: '#2a1640', inks: ['#7c3aed', '#e0338a', '#f2703f', '#0e7490'] },
    },
  },
  {
    id: 'normandy', label: 'Normandy', modes: ['dark', 'light'], hard: true, font: "'Barlow Condensed', sans-serif",
    blurb: 'Mass Effect shore leave: a gas giant and a lens-flared star over a dark treeline, fireflies blinking on their own, holo panels in Alliance blue and omni-tool amber.',
    swatch: {
      dark: { bg: '#070b14', panel: '#0c1220', text: '#e8f1fb', inks: ['#3aa0ff', '#8fe4ff', '#ff9a1f', '#e3f77a'] },
      light: { bg: '#eef3f8', panel: '#f8fbfd', text: '#0f1d2e', inks: ['#1f6fd1', '#2b84cc', '#b35500', '#e0a520'] },
    },
    ambient: { dark: { kind: 'fireflies' }, light: { kind: 'motes', colors: ['#d9a441', '#c9a24f', '#9db9d6'], blend: 'normal', density: 0.7 } },
  },
  {
    id: 'sakura', label: 'Sakura', modes: ['light', 'dark'], font: "'Shippori Mincho', serif",
    blurb: 'Sumi ink on washi paper: a blossoming branch, an ensō, brush calligraphy and a vermilion seal, with petals tumbling on the wind. Dark is yozakura, the same scene by lantern light.',
    swatch: {
      light: { bg: '#f4eee3', panel: '#fbf7f0', text: '#1f1a17', inks: ['#1f1a17', '#c0392b', '#f3b0c3'] },
      dark: { bg: '#15121a', panel: '#1c1820', text: '#f1e9e4', inks: ['#f1e9e4', '#e0564a', '#f3b0c3'] },
    },
    ambient: {
      light: { kind: 'petals', colors: ['#f6bccd', '#f2a7bd', '#fad4df'] },
      dark: { kind: 'petals', colors: ['#f7cdd9', '#efb3c6', '#fde3ea'], density: 0.85 },
    },
  },
  {
    id: 'pandora', label: 'Pandora', modes: ['dark', 'light'], round: true, font: "'Josefin Sans', sans-serif",
    blurb: 'Night in the Pandoran rainforest: floating mountains under Polyphemus, bioluminescent ferns, and woodsprites drifting through the spores.',
    swatch: {
      dark: { bg: '#04121a', panel: '#071b25', text: '#e4fbff', inks: ['#3ff0e0', '#5b8cff', '#b07cff', '#ff5fd8'] },
      light: { bg: '#eef7f2', panel: '#f7fcf9', text: '#0d2620', inks: ['#0b8077', '#1f78b8', '#6b3fd1', '#b8327f'] },
    },
    ambient: {
      dark: { kind: 'woodsprites', extra: ['#3ff0e0', '#3ff0e0', '#b07cff', '#ff5fd8'] },
      light: { kind: 'woodsprites', colors: ['#4fb8ae', '#6cc6bd'], extra: ['#2aa79b', '#8a6fd8', '#d07ab0'], blend: 'normal', density: 0.8 },
    },
  },
  {
    id: 'rain', label: 'Rainy Night', modes: ['dark', 'light'], round: true, font: "'Cormorant Garamond', serif",
    blurb: 'A city through a wet window: the skyline melts into bokeh, beads of rain slide down the glass, sodium amber and a red neon sign.',
    swatch: {
      dark: { bg: '#0a0e17', panel: '#0f1522', text: '#ebeff6', inks: ['#ffb35c', '#ff5f7e', '#5fd4e8'] },
      light: { bg: '#e8ecf0', panel: '#f5f7f9', text: '#18202d', inks: ['#c0392b', '#2b6cb0', '#a5581c'] },
    },
    ambient: {
      dark: { kind: 'rain', extra: ['#ffb347', '#ff9a4a', '#ff5a6f', '#5fd4e8', '#ffe08a', '#ff7ad9'] },
      light: { kind: 'rain', colors: ['#ffffff', '#f3e6d8', '#dfe8f2'], extra: ['#e06a55', '#e8a45a', '#7aa3c8', '#d8584a'], blend: 'normal' },
    },
  },
  {
    id: 'abyss', label: 'Deep Sea', modes: ['dark', 'light'], round: true, font: "'Sora', sans-serif",
    blurb: 'Three kilometres down: shafts of the last sunlight, a whale passing, jellyfish pulsing through marine snow, plankton that sparks where you move.',
    swatch: {
      dark: { bg: '#020814', panel: '#061024', text: '#dcecff', inks: ['#4fd8ff', '#7fb4ff', '#b28bff', '#ff7ad9'] },
      light: { bg: '#e7f7fb', panel: '#f4fcfe', text: '#062a3a', inks: ['#0077a8', '#1f8fc4', '#6b45c9', '#e3c99b'] },
    },
    ambient: { dark: { kind: 'abyss' }, light: { kind: 'shallows', colors: ['#9a7be0', '#e07ab8', '#5f9fe0'], extra: ['#ffffff', '#e8fbff'] } },
  },
  {
    id: 'arrakis', label: 'Arrakis', modes: ['dark', 'light'], hard: true, font: "'Syncopate', sans-serif",
    blurb: 'Dune at dusk: twin moons over the Shield Wall, dunes catching the last light, sand streaming on the wind. Spice orange, blue-within-blue.',
    swatch: {
      dark: { bg: '#17131d', panel: '#1f1a24', text: '#f3e6d3', inks: ['#c2551a', '#e2731d', '#f2b45a', '#4f8dff'] },
      light: { bg: '#f5ead8', panel: '#fbf4e8', text: '#2b1a0e', inks: ['#9a420a', '#b04d0c', '#d9a66c', '#2459c9'] },
    },
    ambient: { dark: { kind: 'sand' }, light: { kind: 'sand', colors: ['#b98b5a', '#a87a4a', '#caa274'] } },
  },
  {
    id: 'borealis', label: 'Borealis', modes: ['dark', 'light'], round: true, font: "'Outfit', sans-serif",
    blurb: 'Arctic night: aurora curtains rippling green to violet over snowy mountains and pines, snow falling, frost on glass.',
    swatch: {
      dark: { bg: '#071223', panel: '#0b1830', text: '#eaf4ff', inks: ['#5dffb0', '#3fe0d0', '#b07cff'] },
      light: { bg: '#eef4fa', panel: '#f8fbfe', text: '#0d1e33', inks: ['#0a7a52', '#0f7f8f', '#6a3fd1'] },
    },
    ambient: { dark: { kind: 'aurora', extra: ['#ffffff', '#e6f2ff'], density: 0.8 }, light: { kind: 'snow', colors: ['#ffffff', '#d6e4f3'] } },
  },
  {
    id: 'ghibli', label: 'Ghibli Autumn', modes: ['light', 'dark'], round: true, font: "'Zen Maru Gothic', sans-serif",
    blurb: 'A painted valley in late autumn: towering clouds, gold hills, a great tree and a red-roofed cottage, maple leaves spinning down. Dark is the same valley at dusk.',
    swatch: {
      light: { bg: '#f6efdf', panel: '#fcf7ec', text: '#2e2a22', inks: ['#c24e29', '#d98a35', '#5f7a3a', '#8fc0e4'] },
      dark: { bg: '#1c1814', panel: '#24201a', text: '#f3ead8', inks: ['#e8743f', '#eda04a', '#a9c27a', '#7a4a5a'] },
    },
    ambient: { light: { kind: 'leaves' }, dark: { kind: 'leaves', density: 0.7 } },
  },
  {
    id: 'classic', label: 'Classic', modes: ['dark', 'light'],
    blurb: 'The original warm neutral look with terracotta accents. Quiet, no backdrop.',
    swatch: {
      dark: { bg: '#191919', panel: '#202020', text: '#f0eee9', inks: ['#c96442', '#da7756'] },
      light: { bg: '#faf8f5', panel: '#f3efe9', text: '#1a1815', inks: ['#b5532f', '#c96442'] },
    },
  },
];

export const DEFAULT_THEME: ThemeId = 'synthfield';
const KEY = 'shellb.skin', LIST_KEY = 'shellb.customThemes', CSS_KEY = 'shellb.customCss';

// ── custom themes ───────────────────────────────────────────────────────────
let customs: CustomTheme[] = (() => {
  try { const v = JSON.parse(localStorage.getItem(LIST_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
})();

function customInfo(t: CustomTheme): ThemeInfo {
  const p = t.palette, mode = t.mode === 'light' ? 'light' : 'dark';
  const kind = t.particles?.kind;
  return {
    id: `custom:${t.id}`, label: t.name, blurb: t.blurb || 'Designed by Shell:B.', modes: [mode],
    font: FONT_STACKS[t.fonts?.display], hard: t.shape === 'hard', round: t.shape === 'round',
    swatch: { [mode]: { bg: p.bg, panel: p.panel, text: p.text, inks: p.inks?.length ? p.inks : [p.accent] } },
    ambient: kind && kind !== 'none' ? { [mode]: { kind, colors: t.particles.colors, density: t.particles.density } } : undefined,
  };
}

/** Shell:B's custom themes, newest first, as picker entries. */
export const customThemes = () => customs.map(customInfo);
export const customTheme = (id: string) => customs.find(t => `custom:${t.id}` === id || t.id === id);

/** Replace the cached list (after a fetch, a new design or a delete) and re-apply the active one if it changed. */
export function setCustomThemes(list: CustomTheme[]) {
  customs = Array.isArray(list) ? list : [];
  try { localStorage.setItem(LIST_KEY, JSON.stringify(customs)); } catch { /* private mode */ }
  const cur = currentTheme();
  if (cur.startsWith('custom:')) {
    if (customTheme(cur)) applyCustom(cur); else setTheme(DEFAULT_THEME);
  }
  listeners.forEach(l => l());
  window.dispatchEvent(new Event('shellb:themes'));
}

let loading: Promise<void> | null = null;
/** Fetch the custom themes from the server (deduplicated while one fetch is running). */
export function loadCustomThemes(): Promise<void> {
  loading ??= req<CustomTheme[]>('/api/themes')
    .then(setCustomThemes, () => { /* offline or an older server: keep the cache */ })
    .finally(() => { loading = null; });
  return loading;
}

function applyCustom(id: string) {
  const t = customTheme(id);
  if (!t) return false;
  const css = customCss(t);
  let el = document.getElementById('shellb-custom-theme') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'shellb-custom-theme'; document.head.appendChild(el); }
  el.textContent = css;
  try { localStorage.setItem(CSS_KEY, css); } catch { /* private mode */ }
  document.documentElement.dataset.skin = 'custom';
  document.documentElement.dataset.custom = t.id;
  return true;
}

// ── the active theme ────────────────────────────────────────────────────────
export const isThemeId = (id: string): id is ThemeId => THEMES.some(t => t.id === id) || /^custom:[\w-]{1,40}$/.test(id);
export const themeInfo = (id: string) => THEMES.find(t => t.id === id) ?? (id.startsWith('custom:') ? customThemes().find(t => t.id === id) : undefined);

export function currentTheme(): ThemeId {
  const el = document.documentElement, s = el.dataset.skin;
  if (s === 'custom' && el.dataset.custom) return `custom:${el.dataset.custom}`;
  return s && THEMES.some(t => t.id === s) ? (s as ThemeId) : 'classic';
}

const listeners = new Set<() => void>();
/** ?shot&skin=<id> (index.html) shoots one theme: the saved theme arriving from the server mustn't replace it */
const SHOT_SKIN = /[?&]shot\b/.test(location.search) && /[?&]skin=\w/.test(location.search);

export function setTheme(id: ThemeId) {
  if (!isThemeId(id) || SHOT_SKIN) return;
  const el = document.documentElement;
  if (id.startsWith('custom:')) {
    // a theme designed on another device: fetch the list, then apply it
    if (!customTheme(id)) { loadCustomThemes().then(() => { if (customTheme(id)) setTheme(id); }); return; }
    applyCustom(id);
  } else {
    delete el.dataset.custom;
    document.getElementById('shellb-custom-theme')?.remove();
    if (id === 'classic') delete el.dataset.skin; else el.dataset.skin = id;
  }
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
  listeners.forEach(l => l());
}

export function nextTheme(): ThemeId {
  const all = [...THEMES.map(t => t.id), ...customThemes().map(t => t.id)];
  return all[(all.indexOf(currentTheme()) + 1) % all.length];
}

// the moving backdrop can be switched off per browser (Settings → Appearance)
const AMBIENT_KEY = 'shellb.ambient';
let ambientOn = (() => { try { return localStorage.getItem(AMBIENT_KEY) !== 'off'; } catch { return true; } })();
const syncAmbientClass = () => document.documentElement.classList.toggle('still-backdrop', !ambientOn);
syncAmbientClass();
export function setAmbientOn(on: boolean) {
  ambientOn = on;
  try { if (on) localStorage.removeItem(AMBIENT_KEY); else localStorage.setItem(AMBIENT_KEY, 'off'); } catch { /* private mode */ }
  syncAmbientClass();
  listeners.forEach(l => l());
  window.dispatchEvent(new Event('shellb:themes'));
}
export function useAmbientOn(): boolean { return useSyncExternalStore(subscribe, () => ambientOn); }

/** The particles the active theme wants in the current mode, if any. */
export function ambientNow(): AmbientConfig | null {
  if (!ambientOn) return null;
  const mode: Mode = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const info = themeInfo(currentTheme());
  return info && info.modes.includes(mode) ? info.ambient?.[mode] ?? null : null;
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** The active theme, re-rendering when it changes. */
export function useTheme(): ThemeId { return useSyncExternalStore(subscribe, currentTheme); }
/** Shell:B's custom themes, re-rendering when the list changes. */
let snapshot = customs, infos = customThemes();
export function useCustomThemes(): ThemeInfo[] {
  return useSyncExternalStore(subscribe, () => { if (snapshot !== customs) { snapshot = customs; infos = customThemes(); } return infos; });
}

// a custom theme may have been revised on another device since this one cached it
if (currentTheme().startsWith('custom:')) setTimeout(() => { loadCustomThemes(); }, 4000);
// ?shot&skin=custom:<id> shoots a custom theme (index.html only knows the built-in ids)
const shotCustom = SHOT_SKIN ? /[?&]skin=custom(?::|%3A)([\w-]{1,40})/i.exec(location.search) : null;
if (shotCustom) loadCustomThemes().then(() => applyCustom(`custom:${shotCustom[1]}`));
