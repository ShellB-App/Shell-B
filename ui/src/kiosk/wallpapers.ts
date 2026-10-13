/**
 * Kiosk Mode Wallpapers
 * Layered landscapes drawn by scripts/wallpapers.py into ./wallpapers/*.svg (re-run it rather than editing the files),
 * plus a custom image URL. Each one is anchored to the bottom edge, so the horizon survives any screen shape, and keeps
 * its top third calm for the desktop icons.
 */
import alpenglow from './wallpapers/alpenglow.svg?url';
import nightForest from './wallpapers/night-forest.svg?url';
import seaDawn from './wallpapers/sea-dawn.svg?url';
import kelpForest from './wallpapers/kelp-forest.svg?url';
import desertDusk from './wallpapers/desert-dusk.svg?url';
import auroraUrl from './wallpapers/aurora.svg?url';
import caveWall from './wallpapers/cave-wall.svg?url';
import graphite from './wallpapers/graphite.svg?url';

export interface WallpaperDef {
  id: string;
  name: string;
  category: 'landscape' | 'plain' | 'custom';
  description: string;
  /** CSS background for the picker's thumbnail. */
  preview: string;
  cssBackground: (customUrl?: string) => string;
}

export const WALLPAPER_KEY = 'shellb.kiosk.wallpaper';
export const WALLPAPER_CUSTOM_KEY = 'shellb.kiosk.wallpaper.custom';
export const WALLPAPER_DIM_KEY = 'shellb.kiosk.wallpaper.dim';

const scene = (id: string, name: string, description: string, url: string, base: string, category: WallpaperDef['category'] = 'landscape'): WallpaperDef => {
  const bg = `url("${url}") center bottom / cover no-repeat, ${base}`;
  return { id, name, category, description, preview: bg, cssBackground: () => bg };
};

export const WALLPAPERS: WallpaperDef[] = [
  scene('alpenglow', 'Alpenglow', 'Mountain ridges fading into a rose and violet dusk.', alpenglow, '#10173a'),
  scene('night-forest', 'Moonlit Forest', 'A clear night over pine hills, mist lying in the valleys.', nightForest, '#040914'),
  scene('sea-dawn', 'Dawn at Sea', 'The sun rising over a calm sea, a path of light on the water.', seaDawn, '#141f45'),
  scene('kelp-forest', 'Kelp Forest', 'Sunbeams through blue water, kelp swaying and a whale passing far off.', kelpForest, '#073654'),
  scene('desert-dusk', 'Desert Dusk', 'Sand dunes after sunset, the first star out.', desertDusk, '#1c1436'),
  scene('aurora', 'Northern Lights', 'An aurora over snowy hills and a line of pines.', auroraUrl, '#030713'),
  scene('cave-wall', 'Painted Cave', 'Horses, aurochs and hands from Lascaux on a torchlit limestone wall.', caveWall, '#4a2e1c'),
  scene('graphite', 'Graphite', 'Plain soft graphite with a little light from above.', graphite, '#0b0c10', 'plain'),
  {
    id: 'custom',
    name: 'Custom Image URL',
    category: 'custom',
    description: 'Load any high-resolution wallpaper image via HTTP/HTTPS URL.',
    preview: 'linear-gradient(135deg, #27272a 0%, #3f3f46 50%, #52525b 100%)',
    cssBackground: customUrl =>
      customUrl ? `url("${customUrl}") center / cover no-repeat, #070a12` : '#070a12',
  },
];

export const DEFAULT_WALLPAPER = 'alpenglow';
// The old vector set (until 2026-10): the plain one keeps its place, the rest fall back to the default.
const RENAMED: Record<string, string> = { minimal: 'graphite' };

export function getStoredWallpaperId(): string {
  try {
    const id = localStorage.getItem(WALLPAPER_KEY) || DEFAULT_WALLPAPER;
    const now = RENAMED[id] ?? id;
    return WALLPAPERS.some(w => w.id === now) ? now : DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;
  }
}

export function getStoredCustomUrl(): string {
  try {
    return localStorage.getItem(WALLPAPER_CUSTOM_KEY) || '';
  } catch {
    return '';
  }
}

export function getStoredWallpaperDim(): number {
  try {
    const val = localStorage.getItem(WALLPAPER_DIM_KEY);
    return val !== null ? Number(val) : 10; // the scenes are drawn dark enough up top; a touch more for contrast
  } catch {
    return 10;
  }
}

export function saveWallpaperChoice(id: string, customUrl?: string, dimPercent?: number) {
  try {
    localStorage.setItem(WALLPAPER_KEY, id);
    if (customUrl !== undefined) {
      localStorage.setItem(WALLPAPER_CUSTOM_KEY, customUrl);
    }
    if (dimPercent !== undefined) {
      localStorage.setItem(WALLPAPER_DIM_KEY, String(dimPercent));
    }
    window.dispatchEvent(new CustomEvent('shellb-kiosk-wallpaper', { detail: { id, customUrl, dimPercent } }));
  } catch {}
}
