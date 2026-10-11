// The sea in the Worlds app, for marine biology: NASA satellite maps of the sea surface (through server/earthview.py's
// tile proxy, following the map clock's date) and where a species has been recorded (OBIS, through server/marine.py).
import type * as ML from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { mapAlive } from './pointLayer';

export type SeaVar = 'sst' | 'sstanom' | 'chl';
export const SEA_PREF = 'shellb.worlds.sea';
export const LIFE_PREF = 'shellb.worlds.marinelife';

/** Legends sampled from the GIBS colour maps (GHRSST_Sea_Surface_Temperature, …_Anomalies) and the PACE chlorophyll
 * palette. `ticks` sit evenly along the bar. */
export const SEA_VARS: Record<SeaVar, { label: string; since: string; colors: string[]; ticks: string[]; unit: string }> = {
  sst: {
    label: 'Temperature', since: '2002-06-01', unit: '°C', ticks: ['0', '8', '16', '24', '32'],
    colors: ['#2b001a', '#6c0466', '#450a5c', '#1f2569', '#2257aa', '#2d9ce9', '#26b706', '#f8f500', '#ff8900', '#dc3700', '#7c0800'],
  },
  sstanom: {
    label: 'Anomaly', since: '2002-06-01', unit: '°C', ticks: ['−3', '0', '+3'],
    colors: ['#6b00db', '#7f1ad1', '#00aeff', '#47ffb6', '#b1ff98', '#c2cab8', '#fff679', '#ffaa00', '#ff3d00', '#e60067', '#88000f'],
  },
  chl: {
    label: 'Chlorophyll', since: '2024-04-10', unit: '', ticks: ['low', 'high'],
    colors: ['#4b00b4', '#0000ff', '#0085ff', '#00ffef', '#00ff27', '#a8ff00', '#ffc700', '#ff6300', '#ff0000', '#820000'],
  },
};
const LAG: Record<SeaVar, number> = { sst: 2, sstanom: 2, chl: 1 };

/** The day to ask for: the clock's day, but never past what GIBS has published for that layer yet. */
export function seaDay(v: SeaVar, clockDay: string): string {
  const latest = new Date(Date.now() - LAG[v] * 86400_000).toISOString().slice(0, 10);
  const since = SEA_VARS[v].since;
  return clockDay > latest ? latest : clockDay < since ? since : clockDay;
}

const SRC = 'sb-sea', LAYER = 'sb-sea-raster';

/** Over the sea fill, under roads and labels; the PNGs are transparent on land, so the land map stays. */
function before(map: ML.Map) {
  const ids = map.getStyle().layers.map(l => l.id);
  for (const want of ['water_label_ocean', 'roads_tunnels_other_casing', 'roads_other', 'boundaries']) if (ids.includes(want)) return want;
  return ids.find(id => id.startsWith('sb-pt-')) ?? ids.find(id => id.startsWith('places_'));
}

export interface SeaHandle { set: (v: SeaVar, day: string) => void; detach: () => void }

export function attachSea(map: ML.Map, v: SeaVar, day: string): SeaHandle {
  let cur = { v, day };
  const add = () => {
    if (!mapAlive(map)) return;
    map.addSource(SRC, {
      type: 'raster', tiles: [`${location.origin}/api/earth/imagery/${cur.v}/${cur.day}/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 7,
      attribution: cur.v === 'chl' ? 'NASA PACE OCI / GIBS' : 'GHRSST MUR (NASA JPL) / GIBS',
    });
    map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 200, 'raster-resampling': 'linear' } }, before(map));
  };
  const remove = () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
  };
  add();
  return {
    set: (nv, nd) => { if (nv !== cur.v || nd !== cur.day) { cur = { v: nv, day: nd }; remove(); add(); } },
    detach: remove,
  };
}

// ── species records (OBIS) ──────────────────────────────────────────────────

export interface Taxon { aphia: number; name: string; authority?: string; rank?: string }
export interface GridStats { records?: number; datasets?: number; yearrange?: [number, number] }

export async function searchTaxa(q: string): Promise<Taxon[]> {
  const r = await fetch(`/api/marine/species?q=${encodeURIComponent(q)}`);
  return r.ok ? ((await r.json()) as { results: Taxon[] }).results : [];
}

export async function fetchGrid(aphia: number): Promise<{ grid: FeatureCollection; stats: GridStats } | null> {
  const r = await fetch(`/api/marine/grid?aphia=${aphia}&precision=3`);
  return r.ok ? r.json() : null;
}

const LSRC = 'sb-life', LFILL = 'sb-life-fill', LLINE = 'sb-life-line';

/** OBIS record cells, shaded by how many records each holds (log scale). */
export function attachLife(map: ML.Map, fc: FeatureCollection): () => void {
  const max = Math.max(1, ...fc.features.map(f => Number(f.properties?.n) || 0));
  map.addSource(LSRC, { type: 'geojson', data: fc, attribution: 'OBIS' });
  const shade: ML.ExpressionSpecification = ['interpolate', ['linear'], ['ln', ['max', 1, ['get', 'n']]],
    0, '#67e8f9', Math.log(max) * 0.5 || 1, '#22c55e', Math.log(max) || 2, '#facc15'];
  map.addLayer({ id: LFILL, type: 'fill', source: LSRC, paint: { 'fill-color': shade, 'fill-opacity': 0.55 } }, before(map));
  map.addLayer({ id: LLINE, type: 'line', source: LSRC, paint: { 'line-color': shade, 'line-width': 0.6, 'line-opacity': 0.9 } }, before(map));
  return () => {
    if (!mapAlive(map)) return;
    for (const l of [LLINE, LFILL]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(LSRC)) map.removeSource(LSRC);
  };
}

// ── sea conditions and species near a point ─────────────────────────────────

export interface Ocean {
  lat: number; lon: number; time: string; land: boolean;
  current: Record<'sea_surface_temperature' | 'wave_height' | 'wave_direction' | 'wave_period' | 'swell_wave_height' | 'ocean_current_velocity' | 'ocean_current_direction', number | null>;
  sst_range: [number, number] | null;
  daily: { date: string; wave_height_max: number | null; wave_direction_dominant: number | null }[];
}
export interface NearbySpecies { name: string; aphia: number; group?: string; family?: string; records: number }

export const fetchOcean = (lat: number, lon: number): Promise<Ocean | null> =>
  fetch(`/api/marine/ocean?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
export const fetchNearby = (lat: number, lon: number, km = 25): Promise<{ total: number; species: NearbySpecies[] } | null> =>
  fetch(`/api/marine/checklist?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius_km=${km}`).then(r => (r.ok ? r.json() : null)).catch(() => null);

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassOf = (deg: number | null) => (deg == null ? '—' : COMPASS[Math.round((deg % 360) / 22.5) % 16]);
