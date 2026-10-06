// The Worlds app's toggleable overlays: one table drives the Layers menu, the saved prefs and which world offers what.
import type { LucideIcon } from 'lucide-react';
import { Anchor, Earth, Footprints, Grid3x3, Landmark as LandmarkIcon, Plane, Rocket, Satellite, Sparkles, SunMoon, Video, Activity } from 'lucide-react';
import { getLandmarksForBody } from './landmarks';
import { getTraversesForBody } from './traverses';

export type OverlayId =
  | 'flights' | 'satellites' | 'quakes' | 'daynight' | 'grid' | 'stars'
  | 'landmarks' | 'traverses' | 'wonders' | 'shipwrecks' | 'launchsites' | 'webcams';

export interface OverlayDef {
  id: OverlayId;
  label: string;
  hint: string;
  icon: LucideIcon;
  color: string;
  group: 'Live' | 'Places' | 'Reference';
  on: (bodyId: string, globe: boolean) => boolean;
  default: boolean;
}

/** Worlds with spacecraft data (server/sky.py): TLEs for Earth, JPL Horizons tracks for the rest. */
const ORBITED = new Set(['earth', 'moon', 'mars', 'mercury']);
const earth = (b: string) => b === 'earth';

export const OVERLAYS: OverlayDef[] = [
  { id: 'flights', label: 'Flights', hint: 'Live ADS-B traffic in view', icon: Plane, color: '#38bdf8', group: 'Live', on: earth, default: false },
  { id: 'satellites', label: 'Spacecraft', hint: 'Satellites and orbiters, live tracks', icon: Satellite, color: '#d95926', group: 'Live', on: b => ORBITED.has(b), default: false },
  { id: 'quakes', label: 'Earthquakes', hint: 'USGS, magnitude 2.5+, past day', icon: Activity, color: '#facc15', group: 'Live', on: earth, default: false },
  { id: 'daynight', label: 'Day & night', hint: 'Where the Sun is up right now', icon: SunMoon, color: '#f59e0b', group: 'Live', on: earth, default: false },
  { id: 'landmarks', label: 'Landmarks', hint: 'Landing sites and major features', icon: LandmarkIcon, color: '#10b981', group: 'Places', on: b => getLandmarksForBody(b).length > 0, default: true },
  { id: 'traverses', label: 'Rover traverses', hint: 'Routes driven and walked', icon: Footprints, color: '#a78bfa', group: 'Places', on: b => getTraversesForBody(b).length > 0, default: true },
  { id: 'wonders', label: 'Wonders', hint: 'Ancient, modern and natural', icon: Sparkles, color: '#f59e0b', group: 'Places', on: earth, default: false },
  { id: 'shipwrecks', label: 'Shipwrecks', hint: 'Famous wrecks and their depths', icon: Anchor, color: '#22d3ee', group: 'Places', on: earth, default: false },
  { id: 'launchsites', label: 'Spaceports', hint: 'Orbital launch sites', icon: Rocket, color: '#fb923c', group: 'Places', on: earth, default: false },
  { id: 'webcams', label: 'Webcams', hint: 'Links to public live streams', icon: Video, color: '#f472b6', group: 'Places', on: earth, default: false },
  { id: 'grid', label: 'Grid', hint: 'Latitude and longitude lines', icon: Grid3x3, color: '#94a3b8', group: 'Reference', on: () => true, default: false },
  { id: 'stars', label: 'Starfield', hint: 'Stars behind the globe', icon: Earth, color: '#c4b5fd', group: 'Reference', on: (_, globe) => globe, default: true },
];

export type LayerPrefs = Record<OverlayId, boolean>;

const KEY = 'shellb.worlds.layers';

export function loadPrefs(): LayerPrefs {
  const base = Object.fromEntries(OVERLAYS.map(o => [o.id, o.default])) as LayerPrefs;
  try { return { ...base, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LayerPrefs>) }; } catch { return base; }
}

export function savePrefs(p: LayerPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
}
