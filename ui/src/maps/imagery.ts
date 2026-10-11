// Satellite imagery and weather radar on Earth, through server/earthview.py (NASA GIBS and RainViewer proxies).
// The imagery layer follows the map clock's date: a day in 2003 shows that day's MODIS pass.
import type * as ML from 'maplibre-gl';
import { mapAlive } from './pointLayer';

export interface ImageryLayer { id: string; name: string; since: string; level: number; daily: boolean; note: string }
export const IMAGERY_PREF = 'shellb.worlds.imagery';
const SRC = 'sb-imagery', LAYER = 'sb-imagery-raster';
const RSRC = 'sb-radar', RLAYER = 'sb-radar-raster';

let catalog: Promise<{ layers: ImageryLayer[]; latest: string }> | null = null;
export function fetchImageryCatalog() {
  catalog ??= fetch('/api/earth/imagery').then(r => (r.ok ? r.json() : { layers: [], latest: '' })).catch(() => { catalog = null; return { layers: [], latest: '' }; });
  return catalog;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Where imagery goes in the Earth style: under water labels and roads, over land/water fills, so streets stay readable. */
function before(map: ML.Map) {
  const ids = map.getStyle().layers.map(l => l.id);
  for (const want of ['roads_tunnels_other_casing', 'roads_other', 'water_label_ocean', 'sb-relief', 'sb-depth']) if (ids.includes(want)) return want;
  return ids.find(id => id.startsWith('sb-')) ?? ids.find(id => id.startsWith('roads_') || id.startsWith('places_'));
}

export interface ImageryHandle { setDay: (day: string) => void; setLayer: (id: string, level: number) => void; detach: () => void }

export function attachImagery(map: ML.Map, layerId: string, level: number, day: string, opacity = 1): ImageryHandle {
  const earth = !!map.getSource('protomaps');
  let cur = { layerId, level, day };
  const add = () => {
    if (!mapAlive(map)) return;
    const ext = cur.layerId === 'nightlights' ? 'png' : 'jpg';
    map.addSource(SRC, { type: 'raster', tiles: [`${location.origin}/api/earth/imagery/${cur.layerId}/${cur.day}/{z}/{x}/{y}.${ext}`], tileSize: 256, maxzoom: cur.level,
      attribution: 'NASA GIBS / EOSDIS' });
    map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 200 } }, earth ? before(map) : undefined);
    // the OSM land fill would hide the imagery; dim the named land and water fills under it
    for (const [id, prop] of [['earth', 'fill-opacity'], ['landuse_park', 'fill-opacity'], ['landuse_urban_green', 'fill-opacity'], ['landcover', 'fill-opacity']] as const) {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, 0);
    }
  };
  const remove = () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
  };
  add();
  return {
    setDay: d => { if (d !== cur.day) { cur = { ...cur, day: d }; remove(); add(); } },
    setLayer: (id, lv) => { if (id !== cur.layerId) { cur = { ...cur, layerId: id, level: lv }; remove(); add(); } },
    detach: () => {
      remove();
      if (!mapAlive(map)) return;
      for (const id of ['earth', 'landuse_park', 'landuse_urban_green', 'landcover']) if (map.getLayer(id)) map.setPaintProperty(id, 'fill-opacity', 1);
    },
  };
}

/** Precipitation frames: ISO half-hour times (UTC), newest last. */
export interface RadarFrames { past: string[]; nowcast: string[]; fetched: number; stale?: boolean; note?: string }
export const fetchRadarFrames = (): Promise<RadarFrames | null> => fetch('/api/earth/radar').then(r => (r.ok ? r.json() : null)).catch(() => null);

export interface RadarHandle { setFrame: (t: string) => void; detach: () => void }

export function attachRadar(map: ML.Map, t: string): RadarHandle {
  let cur = t;
  const add = () => {
    if (!mapAlive(map)) return;
    // NASA IMERG: ~10 km cells, so the layer is drawn soft and fades out at street zooms where it would be blocky
    map.addSource(RSRC, { type: 'raster', tiles: [`${location.origin}/api/earth/radar/${cur}/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 6, attribution: 'NASA GIBS, GPM IMERG' });
    map.addLayer({ id: RLAYER, type: 'raster', source: RSRC, paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.8, 11, 0.25] as unknown as number, 'raster-fade-duration': 150, 'raster-resampling': 'linear' } });
  };
  const remove = () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(RLAYER)) map.removeLayer(RLAYER);
    if (map.getSource(RSRC)) map.removeSource(RSRC);
  };
  add();
  return { setFrame: t => { if (t !== cur) { cur = t; remove(); add(); } }, detach: remove };
}
