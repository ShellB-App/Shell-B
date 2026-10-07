// Real-time Solar Terminator and Day/Night illumination overlay.
// Computes the current subsolar point and constructs the night hemisphere polygon.
import type * as ML from 'maplibre-gl';
import { clockNow, clockSpeed, subscribeClock } from './clock';
import type { Feature, FeatureCollection, Polygon, LineString } from 'geojson';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SubsolarPoint {
  lat: number;
  lon: number;
}

/** Compute the subsolar point (lat, lon) on Earth for a given UTC timestamp. */
export function getSubsolarPoint(timeMs: number): SubsolarPoint {
  const jd = timeMs / 86400000 + 2440587.5;
  const n = jd - 2451545.0;

  // Mean solar longitude and anomaly
  let L = (280.460 + 0.9856474 * n) % 360;
  if (L < 0) L += 360;
  let g = (357.528 + 0.9856003 * n) % 360;
  if (g < 0) g += 360;

  // Ecliptic longitude & obliquity
  const lambda = (L + 1.915 * Math.sin(g * RAD) + 0.020 * Math.sin(2 * g * RAD)) % 360;
  const eps = 23.439 - 0.0000004 * n;

  // Solar declination (subsolar latitude)
  const sinDec = Math.sin(eps * RAD) * Math.sin(lambda * RAD);
  const dec = Math.asin(sinDec) * DEG;

  // Solar right ascension
  const cosDecCosRA = Math.cos(lambda * RAD);
  const cosDecSinRA = Math.cos(eps * RAD) * Math.sin(lambda * RAD);
  const ra = Math.atan2(cosDecSinRA, cosDecCosRA) * DEG;

  // Greenwich Mean Sidereal Time
  let gmst = (280.46061837 + 360.98564736629 * n) % 360;
  if (gmst < 0) gmst += 360;

  // Subsolar longitude
  let lon = (ra - gmst) % 360;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;

  return { lat: dec, lon };
}

/** Construct GeoJSON features: night polygon and golden-hour terminator line. */
export function getTerminatorFeatures(timeMs: number): FeatureCollection {
  const { lat: phi0, lon: lambda0 } = getSubsolarPoint(timeMs);
  const phi0Rad = phi0 * RAD;
  const cotPhi0 = Math.abs(phi0Rad) < 1e-6 ? 0 : 1 / Math.tan(phi0Rad);

  const termPts: [number, number][] = [];
  const step = 2; // degrees longitude

  for (let lon = -180; lon <= 180; lon += step) {
    const dLonRad = (lon - lambda0) * RAD;
    let lat = 0;
    if (Math.abs(phi0Rad) < 1e-6) {
      lat = 0;
    } else {
      lat = -Math.atan(cotPhi0 * Math.cos(dLonRad)) * DEG;
    }
    lat = Math.max(-89.9, Math.min(89.9, lat));
    termPts.push([lon, lat]);
  }

  // Night pole depends on subsolar latitude:
  // If sun is in Northern hemisphere (phi0 > 0), South Pole is in 24h darkness.
  const darkPoleLat = phi0 >= 0 ? -90 : 90;

  // Construct night polygon: terminator points + corner sweep to dark pole
  const polyCoords: [number, number][] = [...termPts];
  polyCoords.push([180, darkPoleLat]);
  polyCoords.push([-180, darkPoleLat]);
  polyCoords.push(termPts[0]);

  const nightFeature: Feature<Polygon> = {
    type: 'Feature',
    properties: { type: 'night' },
    geometry: {
      type: 'Polygon',
      coordinates: [polyCoords],
    },
  };

  const lineFeature: Feature<LineString> = {
    type: 'Feature',
    properties: { type: 'terminator' },
    geometry: {
      type: 'LineString',
      coordinates: termPts,
    },
  };

  return {
    type: 'FeatureCollection',
    features: [nightFeature, lineFeature],
  };
}

const SRC = 'sb-terminator';
const LAYER_FILL = 'sb-terminator-night';
const LAYER_LINE = 'sb-terminator-line';

export function attachTerminator(map: ML.Map): { detach: () => void; update: () => void } {
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = () => {
    if (gone) return;
    (map.getSource(SRC) as ML.GeoJSONSource | undefined)?.setData(getTerminatorFeatures(clockNow()));
  };
  // follows the shared clock: every 30 s live, ~5 times a second while time is playing fast
  const schedule = () => {
    clearTimeout(timer);
    if (gone) return;
    const speed = Math.abs(clockSpeed());
    if (speed === 0) return;
    timer = setTimeout(() => { update(); schedule(); }, speed > 1 ? 200 : 30_000);
  };
  const unsubscribe = subscribeClock(() => { update(); schedule(); });

  map.addSource(SRC, { type: 'geojson', data: getTerminatorFeatures(clockNow()) });
  map.addLayer({ id: LAYER_FILL, type: 'fill', source: SRC, filter: ['==', ['get', 'type'], 'night'],
    paint: { 'fill-color': '#020308', 'fill-opacity': 0.42 } });
  map.addLayer({ id: LAYER_LINE, type: 'line', source: SRC, filter: ['==', ['get', 'type'], 'terminator'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-opacity': 0.7 } });
  schedule();

  return {
    update,
    detach: () => {
      gone = true;
      clearTimeout(timer);
      unsubscribe();
      if (!map.style) return;
      if (map.getLayer(LAYER_LINE)) map.removeLayer(LAYER_LINE);
      if (map.getLayer(LAYER_FILL)) map.removeLayer(LAYER_FILL);
      if (map.getSource(SRC)) map.removeSource(SRC);
    },
  };
}
