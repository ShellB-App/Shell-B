// The Worlds app's toggleable overlays: one table drives the Layers menu, the saved prefs and which world offers what.
import type { LucideIcon } from 'lucide-react';
import { Anchor, Building2, CloudRain, Compass, Earth, Flame, Footprints, Grid3x3, Hand, Image as ImageIcon, Landmark as LandmarkIcon, Mountain, MountainSnow, Plane, Rocket, Satellite, Snowflake, Sparkles, Sun, SunMoon, Tornado, Video, Wheat, Activity, Zap, Waves, Fish } from 'lucide-react';
import { getLandmarksForBody } from './landmarks';
import { getTraversesForBody } from './traverses';

export type OverlayId =
  | 'flights' | 'satellites' | 'quakes' | 'daynight' | 'grid' | 'stars'
  | 'landmarks' | 'traverses' | 'wonders' | 'shipwrecks' | 'launchsites' | 'webcams' | 'relief' | 'terrain3d'
  | 'caves' | 'neolithic' | 'iceage' | 'imagery' | 'radar' | 'buildings' | 'places' | 'aurora' | 'plumes' | 'dust' | 'atmosphere'
  | 'sea' | 'marinelife';

/** What the current world offers beyond its id: whether elevation tiles are installed, whether it is the OSM vector map. */
export interface WorldCtx { terrain: boolean; vector?: boolean }

export interface OverlayDef {
  id: OverlayId;
  label: string;
  hint: string;
  icon: LucideIcon;
  color: string;
  group: 'Live' | 'Places' | 'Reference';
  on: (bodyId: string, globe: boolean, ctx: WorldCtx) => boolean;
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
  { id: 'imagery', label: 'Satellite imagery', hint: 'NASA daily true colour; follows the clock’s date', icon: ImageIcon, color: '#34d399', group: 'Live', on: earth, default: false },
  { id: 'aurora', label: 'Aurora', hint: 'Where the northern and southern lights are likely in the next half hour (NOAA)', icon: Zap, color: '#4ade80', group: 'Live', on: earth, default: false },
  { id: 'radar', label: 'Rain & snow', hint: 'NASA satellite precipitation, half-hourly, a few hours behind', icon: CloudRain, color: '#60a5fa', group: 'Live', on: earth, default: false },
  { id: 'sea', label: 'Sea surface', hint: 'Temperature, heatwave anomaly and chlorophyll from NASA satellites; follows the clock’s date', icon: Waves, color: '#22d3ee', group: 'Live', on: earth, default: false },
  { id: 'landmarks', label: 'Landmarks', hint: 'Landing sites and major features', icon: LandmarkIcon, color: '#10b981', group: 'Places', on: b => getLandmarksForBody(b).length > 0, default: true },
  { id: 'traverses', label: 'Rover traverses', hint: 'Routes driven and walked', icon: Footprints, color: '#a78bfa', group: 'Places', on: b => getTraversesForBody(b).length > 0, default: true },
  { id: 'wonders', label: 'Wonders', hint: 'Ancient, modern and natural', icon: Sparkles, color: '#f59e0b', group: 'Places', on: earth, default: false },
  { id: 'shipwrecks', label: 'Shipwrecks', hint: 'Famous wrecks and their depths', icon: Anchor, color: '#22d3ee', group: 'Places', on: earth, default: false },
  { id: 'caves', label: 'Painted caves', hint: 'Ice Age art, shelters and caves', icon: Hand, color: '#e2725b', group: 'Places', on: earth, default: false },
  { id: 'neolithic', label: 'Neolithic', hint: 'First villages, temples and megaliths', icon: Wheat, color: '#cbd5e1', group: 'Places', on: earth, default: false },
  { id: 'marinelife', label: 'Marine life', hint: 'Where a species has been recorded (OBIS)', icon: Fish, color: '#2dd4bf', group: 'Places', on: earth, default: false },
  { id: 'launchsites', label: 'Spaceports', hint: 'Orbital launch sites', icon: Rocket, color: '#fb923c', group: 'Places', on: earth, default: false },
  { id: 'webcams', label: 'Webcams', hint: 'Links to public live streams', icon: Video, color: '#f472b6', group: 'Places', on: earth, default: false },
  { id: 'places', label: 'Atlas places', hint: 'Points Atlas added, each with its card', icon: Compass, color: '#f472b6', group: 'Places', on: () => true, default: true },
  { id: 'relief', label: 'Relief', hint: 'Mountains, craters and the ocean floor in shade', icon: Mountain, color: '#a8a29e', group: 'Reference', on: (_, __, c) => c.terrain, default: true },
  { id: 'terrain3d', label: '3D terrain', hint: 'Real heights; tilt the map to see them', icon: MountainSnow, color: '#d6d3d1', group: 'Reference', on: (_, __, c) => c.terrain, default: false },
  { id: 'buildings', label: '3D buildings', hint: 'Building heights from OpenStreetMap, from street zoom', icon: Building2, color: '#a8a29e', group: 'Reference', on: (b, _, c) => b === 'earth' && !!c.vector, default: false },
  { id: 'iceage', label: 'Ice Age coast', hint: 'Lower seas, back to 80,000 years ago', icon: Snowflake, color: '#d9cfa6', group: 'Reference', on: (b, _, c) => b === 'earth' && c.terrain, default: false },
  { id: 'atmosphere', label: 'Sky & haze', hint: 'This world’s own sky colour at the limb and horizon', icon: Sun, color: '#fbbf24', group: 'Reference', on: () => true, default: true },
  { id: 'plumes', label: 'Plumes', hint: 'Geysers and volcanic plumes at the real vents, animated impression', icon: Flame, color: '#fb923c', group: 'Reference', on: b => b === 'enceladus' || b === 'io', default: true },
  { id: 'dust', label: 'Dust storms', hint: 'Dust-storm season over the basins where storms start, animated impression', icon: Tornado, color: '#d4a373', group: 'Reference', on: b => b === 'mars', default: false },
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
