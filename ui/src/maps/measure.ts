// Geodesic distance measurement & ruler tool for any celestial body radius.
import type * as ML from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { MapLib } from './core';
import { unwrap } from './flights';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface MeasurePoint {
  lat: number;
  lon: number;
}

export interface MeasureSegment {
  from: MeasurePoint;
  to: MeasurePoint;
  distKm: number;
  bearingDeg: number;
  bearingCompass: string;
}

export interface MeasureResult {
  totalKm: number;
  segments: MeasureSegment[];
}

/** Great-circle distance between two points on a sphere of radius R (km). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusKm = 6371
): number {
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dPhi = (lat2 - lat1) * RAD;
  const dLambda = (lon2 - lon1) * RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusKm * c;
}

/** Initial azimuth / bearing in degrees from point 1 to point 2. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dLambda = (lon2 - lon1) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x) * DEG;
  return (theta + 360) % 360;
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassHeading(deg: number): string {
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return COMPASS_POINTS[idx];
}

/** Generate intermediate great-circle points between two coordinates for smooth globe rendering. */
export function interpolateGreatCircle(
  p1: MeasurePoint,
  p2: MeasurePoint,
  numSteps = 24
): [number, number][] {
  const lat1 = p1.lat * RAD, lon1 = p1.lon * RAD;
  const lat2 = p2.lat * RAD, lon2 = p2.lon * RAD;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));

  if (d < 1e-6) return [[p1.lon, p1.lat], [p2.lon, p2.lat]];

  const pts: [number, number][] = [];
  for (let i = 0; i <= numSteps; i++) {
    const f = i / numSteps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * DEG;
    const lon = Math.atan2(y, x) * DEG;
    pts.push([lon, lat]);
  }
  return pts;
}

export function formatDist(km: number, unit: 'metric' | 'imperial' | 'nautical' = 'metric'): string {
  if (unit === 'imperial') {
    const mi = km * 0.621371;
    if (mi < 0.2) return `${Math.round(km * 3280.84)} ft`;
    return `${mi >= 100 ? Math.round(mi).toLocaleString() : mi.toFixed(1)} mi`;
  }
  if (unit === 'nautical') {
    const nm = km * 0.539957;
    return `${nm >= 100 ? Math.round(nm).toLocaleString() : nm.toFixed(1)} nm`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)} km`;
}

export function computePath(points: MeasurePoint[], radiusKm: number): MeasureResult {
  const segments: MeasureSegment[] = [];
  let totalKm = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const distKm = haversineKm(from.lat, from.lon, to.lat, to.lon, radiusKm);
    const b = bearing(from.lat, from.lon, to.lat, to.lon);
    totalKm += distKm;
    segments.push({
      from,
      to,
      distKm,
      bearingDeg: b,
      bearingCompass: compassHeading(b),
    });
  }
  return { totalKm, segments };
}

const SRC = 'sb-measure';
const LAYER_LINE = 'sb-measure-line';
const LAYER_POINTS = 'sb-measure-pts';
const LAYER_CASING = 'sb-measure-casing';

export function attachMeasureLayer(
  lib: MapLib,
  map: ML.Map,
  points: MeasurePoint[],
  previewPoint: MeasurePoint | null
) {
  const allPts = previewPoint ? [...points, previewPoint] : points;
  const raw: [number, number][] = [];
  for (let i = 0; i < allPts.length - 1; i++) raw.push(...interpolateGreatCircle(allPts[i], allPts[i + 1], 16));
  const lineCoords = unwrap(raw);  // continuous across ±180 so the line doesn't streak across the map

  const pointFeatures: Feature[] = points.map((p, idx) => ({
    type: 'Feature',
    properties: { idx: idx + 1 },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  }));

  const lineFeatures: Feature[] = lineCoords.length > 1 ? [{
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: lineCoords },
  }] : [];

  const fc: FeatureCollection = {
    type: 'FeatureCollection',
    features: [...lineFeatures, ...pointFeatures],
  };

  const src = map.getSource(SRC) as ML.GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }

  map.addSource(SRC, { type: 'geojson', data: fc });

  map.addLayer({
    id: LAYER_CASING,
    type: 'line',
    source: SRC,
    filter: ['==', '$type', 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#06070c', 'line-width': 5, 'line-opacity': 0.8 },
  });

  map.addLayer({
    id: LAYER_LINE,
    type: 'line',
    source: SRC,
    filter: ['==', '$type', 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#2dd4bf',
      'line-width': 2.5,
      'line-dasharray': [2, 2],
    },
  });

  map.addLayer({
    id: LAYER_POINTS,
    type: 'circle',
    source: SRC,
    filter: ['==', '$type', 'Point'],
    paint: {
      'circle-radius': 5.5,
      'circle-color': '#2dd4bf',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#06070c',
    },
  });
}

export function detachMeasureLayer(map: ML.Map) {
  if (map.getLayer(LAYER_POINTS)) map.removeLayer(LAYER_POINTS);
  if (map.getLayer(LAYER_LINE)) map.removeLayer(LAYER_LINE);
  if (map.getLayer(LAYER_CASING)) map.removeLayer(LAYER_CASING);
  if (map.getSource(SRC)) map.removeSource(SRC);
}
