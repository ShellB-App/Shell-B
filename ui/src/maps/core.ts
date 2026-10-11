// Shared map engine for the Worlds app and the ```map``` chat card. MapLibre + PMTiles are ~1 MB, so they load on first use.
// Tiles, glyphs and sprites all come from Shell:B (server/maps.py), so maps work with no internet.
import type * as ML from 'maplibre-gl';

export interface MapBody {
  id: string;
  name: string;
  kind: 'planet' | 'moon' | 'dwarf' | 'asteroid';
  parent: string | null;
  radius_km: number;
  type: 'vector' | 'raster';
  minzoom: number;
  maxzoom: number;
  tileSize?: number;
  attribution: string;
  description: string;
  available: boolean;
  /** Earth only, while the planet file is still downloading: 0..1 */
  downloading?: number | null;
  /** Elevation tiles (terrarium raster-dem), when built for this world */
  terrain?: { tileSize: number; maxzoom: number; encoding: 'terrarium'; format: string; version: number; attribution: string } | null;
}

export type MapLib = typeof ML;

let libP: Promise<MapLib> | null = null;

export function loadMapLib(): Promise<MapLib> {
  return (libP ??= (async () => {
    const [ml, pm] = await Promise.all([import('maplibre-gl'), import('pmtiles'), import('maplibre-gl/dist/maplibre-gl.css')]);
    if (import.meta.env.PROD) ml.setWorkerUrl('/assets/maplibre/maplibre-gl-worker.mjs');  // shipped by vite.config.ts
    ml.addProtocol('pmtiles', new pm.Protocol().tile);
    return ml;
  })().catch(e => { libP = null; throw e; }));
}

let catalogP: Promise<MapBody[]> | null = null;

export function fetchBodies(fresh = false): Promise<MapBody[]> {
  if (fresh || !catalogP) {
    catalogP = fetch('/api/maps/catalog').then(r => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`))))
      .then((d: { bodies: MapBody[] }) => d.bodies)
      .catch(e => { catalogP = null; throw e; });
  }
  return catalogP;
}

const SPACE = { dark: '#06070c', light: '#0b0d14' };

/** A MapLibre style for one world. Earth is the vector OSM basemap; every other body is a single raster mosaic. */
export async function styleFor(body: MapBody, dark: boolean, globe: boolean): Promise<ML.StyleSpecification> {
  const origin = location.origin;
  const url = `pmtiles://${origin}/api/maps/tiles/${body.id}.pmtiles`;
  const projection: ML.ProjectionSpecification = { type: globe ? 'globe' : 'mercator' };
  if (body.type === 'vector') {
    const { layers, namedFlavor } = await import('@protomaps/basemaps');
    const flavor = dark ? 'dark' : 'light';
    return {
      version: 8,
      projection,
      glyphs: `${origin}/api/maps/fonts/{fontstack}/{range}.pbf`,
      sprite: `${origin}/api/maps/sprites/v4/${flavor}`,
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
      sources: { protomaps: { type: 'vector', url, attribution: body.attribution } },
      layers: layers('protomaps', namedFlavor(flavor), { lang: 'en' }) as ML.LayerSpecification[],
    };
  }
  return {
    version: 8,
    projection,
    glyphs: `${origin}/api/maps/fonts/{fontstack}/{range}.pbf`,
    sources: { body: { type: 'raster', url, tileSize: body.tileSize ?? 256, attribution: body.attribution } },
    layers: [
      { id: 'space', type: 'background', paint: { 'background-color': globe ? 'rgba(0,0,0,0)' : SPACE[dark ? 'dark' : 'light'] } },
      { id: 'surface', type: 'raster', source: 'body', paint: { 'raster-fade-duration': 150 } },
    ],
  };
}

// ── Overlays: markers and lines shared by the card and the app ─────────────

export interface MapPoint { lat: number; lon: number; label?: string; note?: string; color?: string }
export interface MapLine { points: [number, number][]; label?: string; color?: string }
/** One stop of a guided tour: where to fly, and what to say there. */
export interface TourStop { title: string; text?: string; lat: number; lon: number; zoom?: number; pitch?: number; bearing?: number; body?: string; seconds?: number }
export interface MapSpec {
  title?: string;
  body?: string;
  markers?: MapPoint[];
  lines?: MapLine[];
  center?: { lat: number; lon: number };
  zoom?: number;
  globe?: boolean;
  // Scene keys, honoured by the Worlds app (and applied live by the Atlas copilot); the chat card ignores them.
  pitch?: number;
  bearing?: number;
  /** layer id → on/off (overlays.ts ids) */
  layers?: Record<string, boolean>;
  /** ISO date-time for the map clock, or 'now' */
  time?: string;
  /** Ice Age coast: sea level as of this many years ago */
  yearsAgo?: number;
  /** open this feature's card (name as the Worlds app shows it) */
  focus?: string;
  /** show this 3D model (id from /api/maps/models) */
  model?: string;
  tour?: TourStop[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : NaN);
const okLat = (v: number) => v >= -90 && v <= 90;
const okLon = (v: number) => v >= -180 && v <= 360;

function point(raw: unknown): MapPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = num(r.lat ?? r.latitude), lon = num(r.lon ?? r.lng ?? r.long ?? r.longitude);
  if (!okLat(lat) || !okLon(lon)) return null;
  return { lat, lon: lon > 180 ? lon - 360 : lon, label: typeof r.label === 'string' ? r.label : typeof r.name === 'string' ? r.name : undefined,
    note: typeof r.note === 'string' ? r.note : undefined, color: typeof r.color === 'string' ? r.color : undefined };
}

/** Parse what a model wrote into a MapSpec, forgiving the usual slips (lng/long, string numbers, 0–360 longitudes). */
export function parseSpec(text: string): MapSpec | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const markers = (Array.isArray(r.markers) ? r.markers : Array.isArray(r.points) ? r.points : []).map(point).filter((p): p is MapPoint => !!p);
  const lines: MapLine[] = (Array.isArray(r.lines) ? r.lines : []).flatMap(l => {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const pts = (Array.isArray(o.points) ? o.points : Array.isArray(l) ? l : []).flatMap(p => {
      const q = Array.isArray(p) ? { lat: p[0], lon: p[1] } : p;
      const pt = point(q);
      return pt ? [[pt.lat, pt.lon] as [number, number]] : [];
    });
    return pts.length > 1 ? [{ points: pts, label: typeof o.label === 'string' ? o.label : undefined, color: typeof o.color === 'string' ? o.color : undefined }] : [];
  });
  const center = point(r.center) ?? undefined;
  const zoom = num(r.zoom), pitch = num(r.pitch), bearing = num(r.bearing), years = num(r.years_ago ?? r.yearsAgo);
  const layers = r.layers && typeof r.layers === 'object' && !Array.isArray(r.layers)
    ? Object.fromEntries(Object.entries(r.layers as Record<string, unknown>).filter(([k, v]) => /^[a-z0-9]+$/.test(k) && typeof v === 'boolean') as [string, boolean][])
    : Array.isArray(r.layers) ? Object.fromEntries((r.layers as unknown[]).filter((k): k is string => typeof k === 'string').map(k => [k, true])) : undefined;
  const focus = r.focus && typeof r.focus === 'object' ? (r.focus as Record<string, unknown>).feature ?? (r.focus as Record<string, unknown>).name : r.focus;
  const tour = Array.isArray(r.tour) ? (r.tour as unknown[]).flatMap(st => {
    const o = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>;
    const pt = point(o);
    if (!pt) return [];
    const z = num(o.zoom), p = num(o.pitch), b = num(o.bearing), sec = num(o.seconds ?? o.duration);
    return [{ title: typeof o.title === 'string' ? o.title : pt.label ?? `Stop`, text: typeof o.text === 'string' ? o.text : typeof o.note === 'string' ? o.note : undefined,
      lat: pt.lat, lon: pt.lon, zoom: Number.isFinite(z) ? Math.max(0, Math.min(18, z)) : undefined, pitch: Number.isFinite(p) ? Math.max(0, Math.min(75, p)) : undefined,
      bearing: Number.isFinite(b) ? b : undefined, body: typeof o.body === 'string' ? o.body.toLowerCase() : undefined, seconds: Number.isFinite(sec) ? Math.max(3, Math.min(120, sec)) : undefined } as TourStop];
  }) : undefined;
  return {
    title: typeof r.title === 'string' ? r.title : undefined,
    body: typeof r.body === 'string' ? r.body.toLowerCase() : typeof r.world === 'string' ? r.world.toLowerCase() : undefined,
    markers, lines, center: center && { lat: center.lat, lon: center.lon },
    zoom: Number.isFinite(zoom) ? Math.max(0, Math.min(18, zoom)) : undefined,
    globe: typeof r.globe === 'boolean' ? r.globe : undefined,
    pitch: Number.isFinite(pitch) ? Math.max(0, Math.min(75, pitch)) : undefined,
    bearing: Number.isFinite(bearing) ? bearing : undefined,
    layers: layers && Object.keys(layers).length ? layers : undefined,
    time: typeof r.time === 'string' && r.time.trim() ? r.time.trim() : undefined,
    yearsAgo: Number.isFinite(years) ? Math.max(0, Math.min(80000, years)) : undefined,
    focus: typeof focus === 'string' && focus.trim() ? focus.trim() : undefined,
    // models sometimes land on a marker ("markers": [{..., "model": "perseverance"}]) rather than at the top
    model: [r.model, ...(Array.isArray(r.markers) ? r.markers.map(m => (m && typeof m === 'object' ? (m as Record<string, unknown>).model : undefined)) : [])]
      .find((m): m is string => typeof m === 'string' && /^[a-z0-9-]{1,40}$/.test(m)),
    tour: tour?.length ? tour : undefined,
  };
}

/** True when a spec carries anything beyond markers and lines (something only the Worlds app can show). */
export const hasScene = (s: MapSpec) =>
  s.pitch !== undefined || s.bearing !== undefined || !!s.layers || !!s.time || s.yearsAgo !== undefined || !!s.focus || !!s.model || !!s.tour;

const ACCENT = '#ff5a36';

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function fmtCoord(lat: number, lon: number) {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** Draw a spec's markers and lines on a map; returns a remover. Call after the style has loaded. */
export function drawOverlays(lib: MapLib, map: ML.Map, spec: MapSpec): () => void {
  const markers = (spec.markers ?? []).map(p => {
    const m = new lib.Marker({ color: p.color ?? ACCENT }).setLngLat([p.lon, p.lat]);
    if (p.label || p.note) {
      m.setPopup(new lib.Popup({ offset: 24, closeButton: false, className: 'sb-map-popup' }).setHTML(
        `${p.label ? `<strong>${esc(p.label)}</strong>` : ''}${p.note ? `<div>${esc(p.note)}</div>` : ''}<div class="sb-map-coord">${fmtCoord(p.lat, p.lon)}</div>`));
    }
    return m.addTo(map);
  });
  const id = `sb-lines-${Math.random().toString(36).slice(2, 8)}`;
  if (spec.lines?.length) {
    map.addSource(id, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: spec.lines.map(l => ({
        type: 'Feature', properties: { color: l.color ?? ACCENT, label: l.label ?? '' },
        geometry: { type: 'LineString', coordinates: l.points.map(([lat, lon]) => [lon, lat]) },
      })) },
    });
    map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.9 } });
  }
  return () => {
    markers.forEach(m => m.remove());
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  };
}

/** Frame a spec: its explicit center/zoom, else the bounds of everything on it. */
export function frameSpec(lib: MapLib, map: ML.Map, spec: MapSpec, animate = false, padding: number | ML.PaddingOptions = 48) {
  const pts: [number, number][] = [...(spec.markers ?? []).map(p => [p.lon, p.lat] as [number, number]),
    ...(spec.lines ?? []).flatMap(l => l.points.map(([lat, lon]) => [lon, lat] as [number, number]))];
  if (spec.center) {
    map.jumpTo({ center: [spec.center.lon, spec.center.lat], zoom: spec.zoom ?? (pts.length ? map.getZoom() : 3) });
  } else if (pts.length === 1) {
    map.jumpTo({ center: pts[0], zoom: spec.zoom ?? 11 });
  } else if (pts.length > 1) {
    const b = new lib.LngLatBounds(pts[0], pts[0]);
    pts.forEach(p => b.extend(p));
    map.fitBounds(b, { padding, maxZoom: spec.zoom ?? 14, animate });
  } else if (spec.zoom !== undefined) {
    map.setZoom(spec.zoom);
  }
}

export const isDark = () => !document.documentElement.classList.contains('light');
