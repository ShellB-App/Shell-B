// Deep time on the Worlds map: the coastline when the sea stood lower (from the same terrarium elevation tiles as
// Relief) and the solstice lines of aligned monuments.
//
// The sea-level curve is a smoothed global mean after Lambeck et al. 2014 (PNAS, last 35,000 years) and Spratt &
// Lisiecki 2016 (older). Real coasts also rose and sank with the ice load, so a local shoreline can differ by tens of
// metres; ice sheets and old lake levels are not drawn.
import type * as ML from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { MapBody } from './core';
import { mapAlive } from './pointLayer';
import { destination, prehistorySolar, type PrehistorySite, type SolarEvent } from './prehistory';

/** [years ago, metres relative to today] */
const CURVE: [number, number][] = [
  [0, 0], [6000, -2], [7000, -4], [8000, -14], [9000, -25], [10000, -40], [11000, -52], [12000, -60], [13000, -68],
  [14000, -80], [14700, -100], [16000, -110], [18000, -120], [21000, -130], [26000, -125], [30000, -90], [40000, -80],
  [50000, -75], [60000, -85], [70000, -80], [80000, -60],
];
export const DEEP_MAX = 80000;

export function seaLevelAt(yearsAgo: number): number {
  if (yearsAgo <= 0) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    const [y1, s1] = CURVE[i];
    if (yearsAgo <= y1) {
      const [y0, s0] = CURVE[i - 1];
      return s0 + (s1 - s0) * (yearsAgo - y0) / (y1 - y0);
    }
  }
  return CURVE[CURVE.length - 1][1];
}

const SRC = 'sb-iceage-dem', LAND = 'sb-iceage-land';

/** Paint the sea floor between today's coast and `level` (negative metres) as dry land. Returns a setter for the
 * level and a detach. */
export function attachIceAge(map: ML.Map, body: MapBody, level: number, dark: boolean): { setLevel: (m: number) => void; detach: () => void } {
  const t = body.terrain;
  if (!t) return { setLevel: () => {}, detach: () => {} };
  map.addSource(SRC, {
    type: 'raster-dem', url: `pmtiles://${location.origin}/api/maps/terrain/${body.id}.pmtiles?v=${t.version}&for=iceage`,
    tileSize: t.tileSize, encoding: 'terrarium', maxzoom: t.maxzoom, attribution: t.attribution,
  });
  // tundra-steppe tones: the "mammoth steppe" that covered the exposed shelves
  const land = dark ? ['#4a4532', '#5c5639'] : ['#d9cfa6', '#c8bc8a'];
  // color-relief only takes `interpolate`, so the coast is a half-metre ramp from clear to land
  const clear = 'rgba(0,0,0,0)';
  const ramp = (m: number) => (m > -2
    ? ['interpolate', ['linear'], ['elevation'], -1, clear, 0, clear]
    : ['interpolate', ['linear'], ['elevation'], m - 0.5, clear, m, land[1], m / 2, land[0], -0.5, land[0], 0, clear]
  ) as unknown as ML.ExpressionSpecification;
  const before = map.getLayer('water_stream') ? 'water_stream' : undefined;
  map.addLayer({ id: LAND, type: 'color-relief', source: SRC, paint: { 'color-relief-opacity': 0.92, 'color-relief-color': ramp(level) } }, before);
  return {
    setLevel: m => { if (mapAlive(map) && map.getLayer(LAND)) map.setPaintProperty(LAND, 'color-relief-color', ramp(m)); },
    detach: () => {
      if (!mapAlive(map)) return;
      if (map.getLayer(LAND)) map.removeLayer(LAND);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
  };
}

const SOL = 'sb-solar', SOL_LINE = 'sb-solar-line', SOL_LABEL = 'sb-solar-label';
export const SOLAR_COLOR: Record<SolarEvent, string> = {
  'ws-rise': '#fb923c', 'ws-set': '#f43f5e', 'ss-rise': '#facc15', 'ss-set': '#f97316', 'eq-rise': '#a3e635', 'eq-set': '#84cc16',
};

/** Lines from a monument towards where the Sun rose or set on its aligned day, when it was built (solid) and today
 * (dashed). `labels` maps each event to its short name. */
export function attachSolarLines(map: ML.Map, site: PrehistorySite, labels: Record<SolarEvent, string>): () => void {
  const feats: Feature<LineString>[] = [];
  for (const l of prehistorySolar(site)) {
    for (const [az, era] of [[l.then, 'then'], [l.now, 'now']] as const) {
      if (az == null) continue;
      const pts = [0, 1.5, 3, 4.5, 6].map(km => (km === 0 ? [site.lon, site.lat] : destination(site.lat, site.lon, az, km)));
      feats.push({
        type: 'Feature', geometry: { type: 'LineString', coordinates: pts },
        properties: { era, color: SOLAR_COLOR[l.event], label: era === 'then' ? `${labels[l.event]} · ${az.toFixed(1)}°` : '' },
      });
    }
  }
  if (!feats.length) return () => {};
  const data: FeatureCollection = { type: 'FeatureCollection', features: feats };
  map.addSource(SOL, { type: 'geojson', data });
  map.addLayer({
    id: SOL_LINE, type: 'line', source: SOL, layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3.5],
      'line-opacity': ['case', ['==', ['get', 'era'], 'then'], 0.95, 0.55],
      'line-dasharray': ['case', ['==', ['get', 'era'], 'then'], ['literal', [1, 0]], ['literal', [2, 2]]],
    },
  });
  map.addLayer({
    id: SOL_LABEL, type: 'symbol', source: SOL, minzoom: 9,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, -0.8] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': 'rgba(6,7,12,0.9)', 'text-halo-width': 1.5 },
  });
  return () => {
    if (!mapAlive(map)) return;
    for (const l of [SOL_LABEL, SOL_LINE]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(SOL)) map.removeSource(SOL);
  };
}
