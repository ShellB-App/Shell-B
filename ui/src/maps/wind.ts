// Wind and weather fields on the Worlds map, the earth.nullschool.net way: thousands of particles carried by the
// GFS wind leave fading trails on a canvas over the map, and a scalar field (wind speed, temperature, pressure,
// clouds, humidity) can be painted underneath. Data: server/windfield.py (NOAA GFS 0.25°, thinned to 0.5°, Int16).
// Projection follows the spacecraft layer: a tiny custom layer captures MapLibre's matrix each frame, so the trails
// wrap the globe and hide behind it, and the same code draws on the flat map.
import type * as ML from 'maplibre-gl';
import { invert, merc, mul, sphere } from './orbiters';
import { mapAlive } from './pointLayer';

export interface FieldHeader {
  product: string; label: string; run: string; hour: number; valid: string;
  nx: number; ny: number; lat0: number; dlat: number; lon0: number; dlon: number;
  planes: { name: string; unit: string; scale: number; offset: number }[]; source: string;
}
export interface Field { h: FieldHeader; planes: Int16Array[] }

export const WIND_LEVELS = [
  { id: 'wind10', label: 'Surface', hint: '10 m above ground' },
  { id: 'wind850', label: '850 hPa', hint: 'about 1.5 km up' },
  { id: 'wind500', label: '500 hPa', hint: 'about 5.5 km up' },
  { id: 'wind250', label: '250 hPa', hint: 'jet stream, about 10 km up' },
];
export const OVERLAYS_FOR = (level: string) => [
  { id: 'none', label: 'No overlay' },
  { id: 'speed', label: 'Wind speed' },
  { id: level === 'wind10' ? 'temp2m' : level.replace('wind', 'temp'), label: 'Temperature' },
  ...(level === 'wind10' ? [{ id: 'pressure', label: 'Pressure' }, { id: 'clouds', label: 'Clouds' }, { id: 'humidity', label: 'Humidity' }, { id: 'gust', label: 'Gusts' }] : []),
];

export async function fetchMeta(): Promise<{ run: string; hours: number[]; products: Record<string, string>; source: string } | null> {
  return fetch('/api/earth/wind/meta').then(r => (r.ok ? r.json() : null)).catch(() => null);
}

const cache = new Map<string, Promise<Field | null>>();
export function fetchField(product: string, hour: number): Promise<Field | null> {
  const key = `${product}/${hour}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/api/earth/wind/${product}/${hour}.bin`).then(async r => {
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const dv = new DataView(buf);
      if (dv.getUint8(0) !== 0x53 || dv.getUint8(1) !== 0x42) return null;  // 'SB'
      const n = dv.getUint32(4, true);
      const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as FieldHeader;
      const size = h.nx * h.ny;
      const planes = h.planes.map((_, i) => new Int16Array(buf.slice(8 + n + i * size * 2, 8 + n + (i + 1) * size * 2)));
      return { h, planes };
    }).catch(() => null);
    cache.set(key, p);
    p.then(f => { if (!f) cache.delete(key); });
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Bilinear value of plane `k` at lat/lon, in the plane's physical units. */
export function sampleAt(f: Field, k: number, lat: number, lon: number): number {
  const { h } = f;
  const fy = (lat - h.lat0) / h.dlat;                       // rows run north → south
  let fx = (((lon - h.lon0) % 360) + 360) % 360 / h.dlon;    // columns wrap at 360°
  const y0 = Math.max(0, Math.min(h.ny - 2, Math.floor(fy))), x0 = Math.floor(fx) % h.nx;
  const ty = Math.max(0, Math.min(1, fy - y0)), tx = fx - Math.floor(fx);
  const x1 = (x0 + 1) % h.nx, y1 = y0 + 1;
  const p = f.planes[k], pl = h.planes[k];
  const v = (p[y0 * h.nx + x0] * (1 - tx) + p[y0 * h.nx + x1] * tx) * (1 - ty) + (p[y1 * h.nx + x0] * (1 - tx) + p[y1 * h.nx + x1] * tx) * ty;
  return v / pl.scale + pl.offset;
}
export const windAt = (f: Field, lat: number, lon: number): [number, number] => [sampleAt(f, 0, lat, lon), sampleAt(f, 1, lat, lon)];

/** Speed in m/s to the Beaufort-ish wording used in the readout. */
export function fmtWind(u: number, v: number): string {
  const s = Math.hypot(u, v);
  const from = (Math.atan2(-u, -v) * 180) / Math.PI;  // direction the wind comes FROM, clockwise from north
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const d = dirs[Math.round((((from % 360) + 360) % 360) / 22.5) % 16];
  return `${s.toFixed(1)} m/s (${Math.round(s * 3.6)} km/h) from the ${d}`;
}

// ── colour scales for the scalar overlays ───────────────────────────────────
type Stop = [number, [number, number, number]];
const SCALES: Record<string, { stops: Stop[]; unit: string; min: number; max: number }> = {
  speed: { unit: 'm/s', min: 0, max: 40, stops: [[0, [37, 74, 125]], [5, [52, 134, 170]], [10, [60, 190, 190]], [15, [120, 210, 110]], [20, [230, 200, 60]], [28, [230, 110, 40]], [35, [210, 40, 60]], [40, [255, 220, 240]]] },
  temp: { unit: '°C', min: -40, max: 45, stops: [[-40, [120, 60, 180]], [-25, [60, 60, 200]], [-10, [40, 140, 230]], [0, [90, 210, 210]], [10, [110, 200, 100]], [20, [230, 220, 80]], [30, [240, 130, 50]], [40, [200, 30, 40]], [45, [255, 160, 230]]] },
  pressure: { unit: 'hPa', min: 950, max: 1050, stops: [[950, [110, 40, 160]], [975, [40, 70, 200]], [995, [40, 160, 210]], [1013, [120, 200, 140]], [1025, [230, 210, 90]], [1040, [230, 110, 50]], [1050, [200, 40, 60]]] },
  clouds: { unit: '%', min: 0, max: 100, stops: [[0, [0, 0, 0]], [30, [90, 90, 100]], [70, [200, 200, 210]], [100, [255, 255, 255]]] },
  humidity: { unit: '%', min: 0, max: 100, stops: [[0, [140, 90, 40]], [30, [200, 170, 90]], [60, [120, 190, 120]], [85, [60, 150, 220]], [100, [40, 60, 200]]] },
  gust: { unit: 'm/s', min: 0, max: 45, stops: [[0, [37, 74, 125]], [10, [60, 190, 190]], [18, [230, 200, 60]], [28, [230, 110, 40]], [38, [210, 40, 60]], [45, [255, 220, 240]]] },
};
/** Temperature ranges per height: the same palette, slid to where the air actually is (−55 °C is normal at the jet). */
const TEMP_RANGE: Record<string, [number, number]> = { temp2m: [-40, 45], temp850: [-35, 30], temp500: [-50, 10], temp250: [-75, -20] };
export function scaleFor(overlay: string) {
  if (overlay.startsWith('temp')) {
    const [lo, hi] = TEMP_RANGE[overlay] ?? TEMP_RANGE.temp2m;
    const base = SCALES.temp;
    const span = base.max - base.min;
    return { ...base, min: lo, max: hi, stops: base.stops.map(([v, c]) => [lo + ((v - base.min) / span) * (hi - lo), c] as Stop) };
  }
  return SCALES[overlay] ?? SCALES.speed;
}

function colour(stops: Stop[], v: number): [number, number, number] {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const t = (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      const a = stops[i - 1][1], b = stops[i][1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

/** Latitude of each row of a world image that MapLibre stretches between ±85.0511° in Web Mercator. */
export const MERC_LAT = 85.0511;
export function mercatorRowLats(H: number): Float64Array {
  const out = new Float64Array(H);
  const yMax = Math.log(Math.tan(Math.PI / 4 + (MERC_LAT * Math.PI) / 360));
  for (let r = 0; r < H; r++) {
    const y = yMax - (r / (H - 1)) * 2 * yMax;
    out[r] = ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  }
  return out;
}
export const WORLD_CORNERS: [[number, number], [number, number], [number, number], [number, number]] = [[-180, MERC_LAT], [180, MERC_LAT], [180, -MERC_LAT], [-180, -MERC_LAT]];

/** Paint a scalar field (or wind speed from a wind field) into a world image in Web Mercator rows, ~2 px per 0.5° cell. */
export function scalarImage(f: Field, overlay: string): string {
  const { h } = f;
  const W = h.nx * 2, H = h.ny * 2;
  const rowLat = mercatorRowLats(H);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const sc = scaleFor(overlay);
  const speed = overlay === 'speed';
  for (let y = 0; y < H; y++) {
    const lat = rowLat[y];
    for (let x = 0; x < W; x++) {
      const lon = -180 + (x / W) * 360;  // image spans -180..180
      let v: number;
      if (speed) { const [u, vv] = windAt(f, lat, lon); v = Math.hypot(u, vv); } else v = sampleAt(f, 0, lat, lon);
      const c = colour(sc.stops, v);
      const i = (y * W + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
      img.data[i + 3] = overlay === 'clouds' ? Math.round(Math.min(1, v / 100) * 230) : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

const SSRC = 'sb-weather-scalar', SLAYER = 'sb-weather-scalar-raster';
function beforeId(map: ML.Map) {
  const ids = map.getStyle().layers.map(l => l.id);
  for (const want of ['roads_tunnels_other_casing', 'roads_other', 'water_label_ocean', 'sb-relief', 'sb-depth']) if (ids.includes(want)) return want;
  return ids.find(id => id.startsWith('sb-')) ?? ids.find(id => id.startsWith('roads_') || id.startsWith('places_'));
}
export function attachScalar(map: ML.Map, f: Field, overlay: string): () => void {
  if (!mapAlive(map)) return () => {};
  map.addSource(SSRC, { type: 'image', url: scalarImage(f, overlay), coordinates: WORLD_CORNERS });
  map.addLayer({ id: SLAYER, type: 'raster', source: SSRC, paint: { 'raster-opacity': overlay === 'clouds' ? 0.9 : 0.55, 'raster-fade-duration': 300, 'raster-resampling': 'linear' } }, beforeId(map));
  return () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(SLAYER)) map.removeLayer(SLAYER);
    if (map.getSource(SSRC)) map.removeSource(SSRC);
  };
}

// ── particles ────────────────────────────────────────────────────────────────
export interface WindHandle { setField: (f: Field) => void; detach: () => void }

export function attachWind(map: ML.Map, field: Field): WindHandle {
  const ID = 'sb-wind-matrix';
  const R_EARTH = 6371;
  let f = field;
  let mainMatrix: ArrayLike<number> | null = null;
  let gone = false;

  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  // particle state: lon, lat, age (frames left)
  let n = 0, lon = new Float32Array(0), lat = new Float32Array(0), age = new Uint16Array(0), px = new Float32Array(0), py = new Float32Array(0);
  const MAX_AGE = 90;
  const resize = () => {
    const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.min(9000, Math.max(1200, Math.round((w * h) / 220)));
    if (want !== n) { n = want; lon = new Float32Array(n); lat = new Float32Array(n); age = new Uint16Array(n); px = new Float32Array(n).fill(NaN); py = new Float32Array(n); age.fill(0); }
  };
  resize();

  const modeNow = (): 'globe' | 'flat' | null => {
    const m = mainMatrix;
    if (!m) return null;
    const c = map.getCenter(), want = map.project(c), w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
    const check = (p: [number, number, number]) => {
      const q = mul(m, p[0], p[1], p[2]);
      return q[3] > 0 && Math.hypot((q[0] / q[3] * 0.5 + 0.5) * w - want.x, (0.5 - q[1] / q[3] * 0.5) * h - want.y) < 3;
    };
    if (map.getProjection()?.type === 'globe' && check(sphere(c.lng, c.lat, 1))) return 'globe';
    return check(merc(c.lng, c.lat)) ? 'flat' : null;
  };
  const camera = (): [number, number, number] | null => {
    const inv = mainMatrix && invert(mainMatrix);
    if (!inv) return null;
    const c = mul(inv, 0, 0, 1, 0);
    return Math.abs(c[3]) < 1e-12 ? null : [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
  };

  /** Spawn a particle somewhere on screen that is on the map. */
  const spawn = (i: number, w: number, h: number) => {
    for (let tries = 0; tries < 4; tries++) {
      const p = map.unproject([Math.random() * w, Math.random() * h]);
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 89) {
        lon[i] = p.lng; lat[i] = p.lat; age[i] = Math.floor(Math.random() * MAX_AGE); px[i] = NaN;
        return;
      }
    }
    age[i] = 0;
  };

  const clear = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); px.fill(NaN); };
  map.on('move', clear);
  map.on('resize', resize);

  const speedColour = (s: number) => {
    // pale and thin for calm, bright warm for strong
    const t = Math.min(1, s / 30);
    const r = Math.round(170 + 85 * t), g = Math.round(205 - 60 * t), b = Math.round(235 - 150 * t);
    return `rgba(${r},${g},${b},${0.55 + 0.4 * t})`;
  };

  const step = () => {
    if (gone || !mapAlive(map)) return;
    const mode = modeNow();
    const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
    if (!mode) { return; }
    const m = mainMatrix!;
    const cam = mode === 'globe' ? camera() : null;
    const camD2 = cam ? cam[0] ** 2 + cam[1] ** 2 + cam[2] ** 2 : 0;
    // fade the old trails
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    // motion per frame: ~40 minutes of wind at zoom 2, halving per zoom level so trails keep a similar screen length
    const zoom = map.getZoom();
    const secs = 2400 * Math.pow(2, 2 - Math.max(0, zoom));
    const project = (lo: number, la: number): [number, number, boolean] => {
      if (mode === 'flat') { const p = map.project([lo, la]); return [p.x, p.y, true]; }
      const v = sphere(lo, la, 1.0005);
      const q = mul(m, v[0], v[1], v[2]);
      if (q[3] <= 1e-9) return [0, 0, false];
      // hidden when the line camera → point passes through the sphere
      let hidden = false;
      if (cam) {
        const d = [v[0] - cam[0], v[1] - cam[1], v[2] - cam[2]], len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        const t = -(cam[0] * d[0] + cam[1] * d[1] + cam[2] * d[2]) / len2;
        hidden = t > 0 && t < 1 && camD2 - t * t * len2 < 0.99999;
      }
      return [(q[0] / q[3] * 0.5 + 0.5) * w, (0.5 - q[1] / q[3] * 0.5) * h, !hidden];
    };
    const byColour = new Map<string, [number, number, number, number][]>();
    for (let i = 0; i < n; i++) {
      if (age[i] <= 0) { spawn(i, w, h); continue; }
      age[i]--;
      const [u, v] = windAt(f, lat[i], lon[i]);
      const s = Math.hypot(u, v);
      const cosL = Math.max(0.05, Math.cos((lat[i] * Math.PI) / 180));
      const nlat = lat[i] + ((v * secs) / 1000 / R_EARTH) * (180 / Math.PI);
      let nlon = lon[i] + ((u * secs) / 1000 / (R_EARTH * cosL)) * (180 / Math.PI);
      if (nlon > 180) nlon -= 360; else if (nlon < -180) nlon += 360;
      if (Math.abs(nlat) > 89 || s < 0.05) { age[i] = 0; continue; }
      const [x1, y1, vis] = project(nlon, nlat);
      const x0 = px[i], y0 = py[i];
      lon[i] = nlon; lat[i] = nlat; px[i] = x1; py[i] = y1;
      if (!vis || x1 < -20 || y1 < -20 || x1 > w + 20 || y1 > h + 20) { age[i] = 0; continue; }
      if (Number.isNaN(x0) || Math.abs(x1 - x0) > 60 || Math.abs(y1 - y0) > 60) continue;  // first frame, or a wrap
      const c = speedColour(s);
      let arr = byColour.get(c);
      if (!arr) { arr = []; byColour.set(c, arr); }
      arr.push([x0, y0, x1, y1]);
    }
    for (const [c, segs] of byColour) {
      ctx.strokeStyle = c;
      ctx.beginPath();
      for (const [a, b, cx, cy] of segs) { ctx.moveTo(a, b); ctx.lineTo(cx, cy); }
      ctx.stroke();
    }
  };

  const layer: ML.CustomLayerInterface = {
    id: ID, type: 'custom', renderingMode: '2d',
    render: (_gl, args) => {
      mainMatrix = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
      if (!document.hidden) step();
      if (!gone) map.triggerRepaint();
    },
  };
  map.addLayer(layer);
  map.triggerRepaint();

  return {
    setField: nf => { f = nf; },
    detach: () => {
      gone = true;
      map.off('move', clear); map.off('resize', resize);
      canvas.remove();
      if (mapAlive(map) && map.getLayer(ID)) map.removeLayer(ID);
    },
  };
}

/** Forecast hour for the map clock, given the run time: 0 for anything before the run, 3-hourly up to 240 after. */
export function hourFor(runIso: string, clockMs: number): number {
  const run = Date.parse(runIso);
  if (!Number.isFinite(run)) return 0;
  const h = (clockMs - run) / 3_600_000;
  return Math.min(240, Math.max(0, Math.round(h / 3) * 3));
}
