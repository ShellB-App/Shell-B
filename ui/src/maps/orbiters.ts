// Spacecraft over the current world (server/sky.py), following the shared Worlds clock (clock.ts).
// Earth: Celestrak's whole active catalogue (~16k TLEs), propagated with SGP4 in a Web Worker (satworker.ts).
// Moon, Mars, Mercury: JPL Horizons ground tracks (one sample a minute, 2 h back to 4 h ahead), interpolated here.
//
// Drawing: the dots are a WebGL custom layer. On the globe each craft sits at its true distance from the body's
// centre: MapLibre's globe is a unit sphere and `defaultProjectionData.mainMatrix` is the matrix it renders that
// sphere with, so (1 + alt/R) × the surface normal is exactly where the spacecraft is. The vertex shader drops
// craft the body hides from the camera. On a flat map the dots sit on their ground points (no "up" to lift into).
// Labels, the selected craft's orbit and its coverage footprint go on a 2D canvas; there are only ever a few.
import type * as ML from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import type { MapLib } from './core';
import { clockNow, clockSpeed, subscribeClock } from './clock';
import { passes, type Pass } from './passes';

export interface OrbiterInfo {
  id: string;
  name: string;
  mission?: string;
  lat: number;
  lon: number;
  alt: number;      // km above the surface
  speed: number;    // km/s (Earth: orbital speed; elsewhere: over the ground track)
  station?: boolean;
  regime?: Regime;
}

export type Regime = 'LEO' | 'MEO' | 'GEO' | 'HEO';
export const REGIME_COLOR: Record<Regime, string> = { LEO: '#38bdf8', MEO: '#4ade80', GEO: '#fbbf24', HEO: '#c084fc' };
const REGIME_RGB: Record<Regime, [number, number, number]> = { LEO: [0.22, 0.74, 0.97], MEO: [0.29, 0.87, 0.5], GEO: [0.98, 0.75, 0.14], HEO: [0.75, 0.52, 0.99] };
/** Orbit band from altitude (Earth's conventional bands; other worlds use the same colours by height). */
export function regimeOf(altKm: number): Regime {
  return altKm < 2000 ? 'LEO' : altKm < 34_000 ? 'MEO' : altKm < 37_500 ? 'GEO' : 'HEO';
}

export interface OrbiterLayer {
  detach: () => void;
  select: (id: string | null) => void;
  /** Is there a craft drawn under this screen point? (they live in a custom layer, not a queryable one) */
  hitTest: (x: number, y: number) => boolean;
  /** Craft whose name matches, best first. */
  search: (q: string, limit?: number) => { id: string; name: string; regime: Regime | null }[];
  /** Visible passes of an Earth satellite over a place, from the clock's time. */
  passes: (id: string, lat: number, lon: number) => Pass[] | null;
  /** Where a craft is now (for flying to it). */
  where: (id: string) => OrbiterInfo | null;
}

interface TrackCraft { id: string; name: string; mission: string; track: [number, number, number, number][] }
interface Tle { name: string; norad: number; line1: string; line2: string; group: string }

const TRACK = 'sb-orb-track', GL_LAYER = 'sb-orb';
/** Stations first so their entries (and the station flag) win the de-duplication against `active`. */
const EARTH_GROUPS = 'stations,active';
const PLANET_RADIUS: Record<string, number> = { earth: 6371, moon: 1737.4, mars: 3389.5, mercury: 2439.7 };
const STATION = /^(ISS \(ZARYA\)|CSS \(TIANHE\)|TIANGONG)/i;

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

function hav(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180,
    a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Position on a Horizons track at time t (ms), linearly interpolated; null outside the track. */
function trackFix(tr: TrackCraft['track'], radius: number, tMs: number) {
  const s = tMs / 1000;
  if (!tr.length || s < tr[0][0] || s > tr[tr.length - 1][0]) return null;
  let i = tr.findIndex(p => p[0] > s);
  if (i <= 0) i = tr.length - 1;
  const [t0, la0, lo0, a0] = tr[i - 1], [t1, la1, lo1, a1] = tr[i];
  const f = (s - t0) / Math.max(1, t1 - t0);
  let dlon = lo1 - lo0;
  if (dlon > 180) dlon -= 360;
  if (dlon < -180) dlon += 360;
  const alt = a0 + (a1 - a0) * f;
  return { lat: la0 + (la1 - la0) * f, lon: ((lo0 + dlon * f + 540) % 360) - 180, alt,
    speed: (hav(la0, lo0, la1, lo1) * (radius + alt)) / Math.max(1, t1 - t0) };
}

function sgp4Fix(rec: SatRec, tMs: number) {
  const when = new Date(tMs), pv = propagate(rec, when);
  if (!pv || !pv.position || typeof pv.position === 'boolean' || !pv.velocity || typeof pv.velocity === 'boolean') return null;
  const g = eciToGeodetic(pv.position, gstime(when)), v = pv.velocity;
  return { lat: degreesLat(g.latitude), lon: degreesLong(g.longitude), alt: g.height, speed: Math.hypot(v.x, v.y, v.z) };
}

/** Lon/lat path continuous across ±180, shifted so the point at `anchorIdx` lies in [-180, 180]. */
function unwrapped(pts: Position[], anchorIdx: number): Position[] {
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  const a = pts[anchorIdx];
  if (a) {
    const k = Math.round(a[0] / 360) * 360;
    pts.forEach(p => { p[0] -= k; });
  }
  return pts;
}

type Vec4 = [number, number, number, number];
function mul(m: ArrayLike<number>, x: number, y: number, z: number, w = 1): Vec4 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
}
/** 4×4 inverse (column-major), or null if singular. */
function invert(a: ArrayLike<number>): number[] | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(a);
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}
/** MapLibre's globe frame (same formula as its projectToSphere shader). */
function sphere(lon: number, lat: number, r: number): [number, number, number] {
  const lo = (lon * Math.PI) / 180, la = (lat * Math.PI) / 180, c = Math.cos(la);
  return [Math.sin(lo) * c * r, Math.sin(la) * r, Math.cos(lo) * c * r];
}
/** Web Mercator 0..1 coordinates (what mainMatrix takes on a flat map). */
function merc(lon: number, lat: number): [number, number, number] {
  const la = Math.max(-85.05, Math.min(85.05, lat)) * (Math.PI / 180);
  return [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI), 0];
}

const VERT = `
attribute vec3 a_pos; attribute vec3 a_color; attribute float a_size;
uniform mat4 u_matrix; uniform vec3 u_cam; uniform float u_globe; uniform float u_dpr;
varying vec3 v_color;
void main() {
  if (u_globe > 0.5) {  // hidden when the line from the camera to the craft passes through the body
    vec3 d = a_pos - u_cam; float len2 = dot(d, d);
    float t = -dot(u_cam, d) / len2;
    if (t > 0.0 && t < 1.0 && dot(u_cam, u_cam) - t * t * len2 < 0.99999) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  }
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  gl_PointSize = a_size * u_dpr;
  v_color = a_color;
}`;
const FRAG = `
precision mediump float;
varying vec3 v_color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c);
  if (r > 1.0) discard;
  float a = 1.0 - smoothstep(0.55, 1.0, r);
  gl_FragColor = vec4(v_color * a, a);
}`;

export function attachOrbiters(
  lib: MapLib,
  map: ML.Map,
  bodyId: string,
  opts: { onSelect?: (info: OrbiterInfo | null) => void; onStatus?: (s: { count: number; error?: string; note?: string }) => void },
): OrbiterLayer {
  void lib;
  const R = PLANET_RADIUS[bodyId.toLowerCase()] ?? 6371;
  const earth = bodyId === 'earth';
  let gone = false;

  // catalogue: parallel arrays, positions in `pos` (lon°, lat°, alt km; NaN = no position at this time)
  let ids: string[] = [], names: string[] = [], station: boolean[] = [];
  let tles: Tle[] = [], tracks: TrackCraft[] = [];
  let pos: Float32Array = new Float32Array(0), posT = 0;
  let selected: number | null = null, hovered: number | null = null, selRec: SatRec | null = null;
  let dirty = true;  // GPU buffer needs rebuilding
  let mainMatrix: ArrayLike<number> | null = null;
  let lastTrack = 0;

  // ── positions ─────────────────────────────────────────────────────────────
  let worker: Worker | null = null, busy = false, wanted: number | null = null;
  const ask = (t: number) => {
    if (!worker) return;
    if (busy) { wanted = t; return; }
    busy = true;
    worker.postMessage({ type: 'at', t });
  };
  const infoAt = (i: number, t = posT): OrbiterInfo | null => {
    if (earth) {
      if (i !== selected || !selRec) {
        const lon = pos[i * 3], lat = pos[i * 3 + 1], alt = pos[i * 3 + 2];
        return Number.isNaN(alt) ? null : { id: ids[i], name: names[i], lon, lat, alt, speed: NaN, station: station[i], regime: regimeOf(alt), mission: `NORAD ${ids[i]}` };
      }
      const f = sgp4Fix(selRec, t);
      return f && { id: ids[i], name: names[i], mission: `NORAD ${ids[i]}`, station: station[i], ...f, regime: regimeOf(f.alt) };
    }
    const f = trackFix(tracks[i].track, R, t);
    return f && { id: ids[i], name: names[i], mission: tracks[i].mission, ...f, regime: regimeOf(f.alt) };
  };
  const fixAt = (i: number, t: number) => (earth ? (selRec && i === selected ? sgp4Fix(selRec, t) : null) : trackFix(tracks[i].track, R, t));

  const landed = (t: number, p: Float32Array) => {
    pos = p; posT = t; dirty = true;
    if (selected != null) {
      opts.onSelect?.(infoAt(selected));
      if (Math.abs(posT - lastTrack) > 10_000) drawTrack();
    }
    map.triggerRepaint();
    if (wanted != null) { const w = wanted; wanted = null; ask(w); }
    else if (Math.abs(clockSpeed()) > 1) ask(clockNow());  // time is playing: keep the pipeline full
  };
  const computeTracks = (t: number) => {
    const p = new Float32Array(tracks.length * 3);
    tracks.forEach((c, i) => {
      const f = trackFix(c.track, R, t);
      p[i * 3] = f?.lon ?? NaN; p[i * 3 + 1] = f?.lat ?? NaN; p[i * 3 + 2] = f?.alt ?? NaN;
    });
    landed(t, p);
  };
  let trackRaf = 0;
  const update = () => {
    if (gone) return;
    if (earth) { ask(clockNow()); return; }
    computeTracks(clockNow());
    cancelAnimationFrame(trackRaf);
    if (Math.abs(clockSpeed()) > 1) trackRaf = requestAnimationFrame(update);  // a few craft: every frame is cheap
  };

  // ── WebGL point layer ─────────────────────────────────────────────────────
  let prog: WebGLProgram | null = null, buf: WebGLBuffer | null = null, count = 0, builtMode: 'globe' | 'flat' | null = null;
  let loc: { pos: number; color: number; size: number; matrix: WebGLUniformLocation | null; cam: WebGLUniformLocation | null; globe: WebGLUniformLocation | null; dpr: WebGLUniformLocation | null } | null = null;

  /** 'globe' or 'flat' when our projection matches MapLibre's this frame (not during its globe→flat blend). */
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

  const glLayer: ML.CustomLayerInterface = {
    id: GL_LAYER, type: 'custom', renderingMode: '2d',
    onAdd: (_m, gl) => {
      const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('orbiters shader:', gl.getProgramInfoLog(p)); return; }
      prog = p; buf = gl.createBuffer();
      loc = { pos: gl.getAttribLocation(p, 'a_pos'), color: gl.getAttribLocation(p, 'a_color'), size: gl.getAttribLocation(p, 'a_size'),
        matrix: gl.getUniformLocation(p, 'u_matrix'), cam: gl.getUniformLocation(p, 'u_cam'), globe: gl.getUniformLocation(p, 'u_globe'), dpr: gl.getUniformLocation(p, 'u_dpr') };
    },
    render: (gl, args) => {
      mainMatrix = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
      if (!prog || !buf || !loc) return;
      const mode = modeNow();
      if (!mode) return;
      if (dirty || mode !== builtMode) {
        const n = pos.length / 3, data = new Float32Array(n * 7);
        let k = 0;
        for (let i = 0; i < n; i++) {
          const lon = pos[i * 3], lat = pos[i * 3 + 1], alt = pos[i * 3 + 2];
          if (Number.isNaN(alt)) continue;
          const v = mode === 'globe' ? sphere(lon, lat, 1 + alt / R) : merc(lon, lat);
          const c = i === selected ? [0.98, 0.45, 0.09] : REGIME_RGB[regimeOf(alt)];
          data[k] = v[0]; data[k + 1] = v[1]; data[k + 2] = v[2];
          data[k + 3] = c[0]; data[k + 4] = c[1]; data[k + 5] = c[2];
          data[k + 6] = station[i] || i === selected ? 7 : earth ? 3.2 : 6;
          k += 7;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.DYNAMIC_DRAW);
        count = k / 7; dirty = false; builtMode = mode;
      }
      const cam = camera();
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.matrix, false, new Float32Array(mainMatrix as ArrayLike<number>));
      gl.uniform3fv(loc.cam, cam ?? [0, 0, 0]);
      gl.uniform1f(loc.globe, mode === 'globe' && cam ? 1 : 0);
      gl.uniform1f(loc.dpr, Math.min(window.devicePixelRatio || 1, 2));
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(loc.color); gl.vertexAttribPointer(loc.color, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(loc.size); gl.vertexAttribPointer(loc.size, 1, gl.FLOAT, false, 28, 24);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(loc.pos); gl.disableVertexAttribArray(loc.color); gl.disableVertexAttribArray(loc.size);
    },
    onRemove: (_m, gl) => { if (prog) gl.deleteProgram(prog); if (buf) gl.deleteBuffer(buf); prog = buf = null; },
  };

  // flat-map orbit track + footprint for the selected craft (the globe gets them on the canvas)
  map.addSource(TRACK, { type: 'geojson', data: fc([]) });
  map.addLayer({ id: `${TRACK}-foot`, type: 'line', source: TRACK, filter: ['==', ['get', 'part'], 'foot'],
    paint: { 'line-color': '#f97316', 'line-opacity': 0.6, 'line-width': 1.2, 'line-dasharray': [1, 2] } });
  map.addLayer({ id: `${TRACK}-next`, type: 'line', source: TRACK, filter: ['==', ['get', 'part'], 'next'],
    paint: { 'line-color': '#e5e7eb', 'line-opacity': 0.55, 'line-width': 1.5, 'line-dasharray': [2, 3] } });
  map.addLayer({ id: `${TRACK}-past`, type: 'line', source: TRACK, filter: ['==', ['get', 'part'], 'past'],
    layout: { 'line-cap': 'round' }, paint: { 'line-color': '#d95926', 'line-width': 2 } });
  map.addLayer(glLayer);

  // ── 2D canvas: labels, the selected orbit and footprint on the globe ──────
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext('2d');

  /** Screen projection for the current frame; `hidden` = the body is in the way (globe only). */
  const projector = () => {
    const mode = modeNow(), m = mainMatrix;
    if (!mode || !m) return null;
    const cam = mode === 'globe' ? camera() : null;
    const w = canvas.clientWidth, h = canvas.clientHeight, camD2 = cam ? cam[0] ** 2 + cam[1] ** 2 + cam[2] ** 2 : 0;
    const at = (lon: number, lat: number, alt: number) => {
      if (mode === 'flat') { const p = map.project([lon, lat]); return { x: p.x, y: p.y, hidden: false }; }
      const p = sphere(lon, lat, 1 + alt / R), q = mul(m, p[0], p[1], p[2]);
      if (q[3] <= 1e-9) return null;
      let hidden = false;
      if (cam) {
        const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]], len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        const t = -(cam[0] * d[0] + cam[1] * d[1] + cam[2] * d[2]) / len2;
        hidden = t > 0 && t < 1 && camD2 - t * t * len2 < 1 - 1e-5;
      }
      return { x: (q[0] / q[3] * 0.5 + 0.5) * w, y: (0.5 - q[1] / q[3] * 0.5) * h, hidden };
    };
    return { mode, at };
  };

  const label = (x: number, y: number, title: string, sub: string, hot: boolean) => {
    if (!ctx) return;
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    const tw = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width);
    ctx.fillStyle = 'rgba(15,23,42,0.85)';
    ctx.beginPath(); ctx.roundRect(x + 9, y - 13, tw + 10, 26, 5); ctx.fill();
    if (hot) { ctx.strokeStyle = 'rgba(249,115,22,0.6)'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = '#f8fafc'; ctx.fillText(title, x + 14, y - 2);
    ctx.font = '500 9px ui-monospace, monospace'; ctx.fillStyle = '#94a3b8'; ctx.fillText(sub, x + 14, y + 9);
  };

  const drawOverlay = () => {
    if (gone || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const proj = projector();
    if (!proj) return;
    const flat = proj.mode === 'flat';
    for (const id of [`${TRACK}-foot`, `${TRACK}-next`, `${TRACK}-past`]) {
      const vis = flat ? 'visible' : 'none';
      if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== vis) map.setLayoutProperty(id, 'visibility', vis);
    }

    if (selected != null && !flat) {
      const sel = selected, now = posT;
      const stroke = (pts: Iterable<{ x: number; y: number; hidden: boolean } | null>, dash: number[], color: string, width = 1.6) => {
        ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
        let pen = false;
        for (const p of pts) {
          if (!p || p.hidden) { pen = false; continue; }
          if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; }
        }
        ctx.stroke(); ctx.restore();
      };
      function* orbit(from: number, to: number) {
        for (let t = from; t <= to; t += 30_000) { const f = fixAt(sel, t); yield f && proj!.at(f.lon, f.lat, f.alt); }
      }
      stroke(orbit(now - 45 * 60_000, now), [], '#f97316');                 // 45 min back
      stroke(orbit(now, now + 90 * 60_000), [5, 4], 'rgba(226,232,240,0.75)'); // 90 min ahead
      const f = infoAt(sel);
      if (f) {  // footprint: where on the ground it's above the horizon, and a line down to its ground point
        stroke(footprint(f.lat, f.lon, f.alt, R).map(([lo, la]) => proj.at(lo, la, 0)), [2, 3], 'rgba(249,115,22,0.7)', 1.2);
        stroke([proj.at(f.lon, f.lat, 0), proj.at(f.lon, f.lat, f.alt)], [], 'rgba(249,115,22,0.7)', 1);
      }
    }
    // labels: stations, the hovered and the selected craft (around other worlds there are few, so all of them)
    const show = new Set<number>(station.flatMap((s, i) => (s ? [i] : [])));
    if (hovered != null) show.add(hovered);
    if (selected != null) show.add(selected);
    if (!earth) ids.forEach((_, i) => show.add(i));
    for (const i of show) {
      const alt = pos[i * 3 + 2];
      if (Number.isNaN(alt)) continue;
      const p = proj.at(pos[i * 3], pos[i * 3 + 1], alt);
      if (!p || p.hidden) continue;
      if (i === hovered || i === selected) {
        ctx.strokeStyle = i === selected ? '#f97316' : '#e2e8f0'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
      }
      label(p.x, p.y, names[i], `${Math.round(alt).toLocaleString()} km · ${regimeOf(alt)}`, i === selected);
    }
  };
  map.on('render', drawOverlay);

  // ── picking ───────────────────────────────────────────────────────────────
  const pick = (x: number, y: number, r: number): number | null => {
    const proj = projector();
    if (!proj) return null;
    let best: number | null = null, bd = r;
    const n = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const alt = pos[i * 3 + 2];
      if (Number.isNaN(alt)) continue;
      const p = proj.at(pos[i * 3], pos[i * 3 + 1], alt);
      if (!p || p.hidden) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  let moveRaf = 0;
  const onMove = (e: ML.MapMouseEvent) => {
    if (gone || moveRaf) return;
    const { x, y } = e.point;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const i = pick(x, y, 9);
      if (i !== hovered) { hovered = i; map.getCanvas().style.cursor = i != null ? 'pointer' : ''; map.triggerRepaint(); }
    });
  };
  const onClick = (e: ML.MapMouseEvent) => {
    const i = gone ? null : pick(e.point.x, e.point.y, 12);
    if (i != null) select(ids[i]);
  };
  map.on('mousemove', onMove);
  map.on('click', onClick);

  const drawTrack = () => {
    const src = map.getSource(TRACK) as ML.GeoJSONSource | undefined;
    if (!src) return;
    const i = selected;
    if (i == null) { src.setData(fc([])); return; }
    const now = posT || clockNow();
    const pts = (from: number, to: number) => {
      const out: Position[] = [];
      for (let t = from; t <= to; t += 30_000) { const f = fixAt(i, t); if (f) out.push([f.lon, f.lat]); }
      return out;
    };
    const past = pts(now - 45 * 60_000, now), next = pts(now, now + 90 * 60_000);
    const f = infoAt(i, now);
    const foot: Position[] = f ? footprint(f.lat, f.lon, f.alt, R) : [];
    const line = (part: string, coordinates: Position[]) => ({ type: 'Feature' as const, properties: { part }, geometry: { type: 'LineString' as const, coordinates } });
    src.setData(fc([
      ...(past.length > 1 ? [line('past', unwrapped(past, past.length - 1))] : []),
      ...(next.length > 1 ? [line('next', unwrapped(next, 0))] : []),
      ...(foot.length > 1 ? [line('foot', unwrapped(foot, 0))] : []),
    ]));
    lastTrack = now;
  };

  function select(id: string | null) {
    const i = id == null ? -1 : ids.indexOf(id);
    selected = i >= 0 ? i : null;
    selRec = null;
    if (earth && selected != null) { try { selRec = twoline2satrec(tles[selected].line1, tles[selected].line2); } catch { selRec = null; } }
    dirty = true; lastTrack = 0;
    drawTrack();
    opts.onSelect?.(selected == null ? null : infoAt(selected));
    map.triggerRepaint();
  }

  // ── loading ───────────────────────────────────────────────────────────────
  const load = async () => {
    try {
      const keep = selected != null ? ids[selected] : null;
      if (earth) {
        const r = await fetch(`/api/sky/group?name=${EARTH_GROUPS}`);
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
        const seen = new Set<number>();
        tles = (d.sats as Tle[]).filter(s => !seen.has(s.norad) && !!seen.add(s.norad));
        ids = tles.map(s => String(s.norad));
        names = tles.map(s => s.name.replace(/\s+\(.*\)$/, '').trim() || s.name);
        station = tles.map(s => s.group === 'stations' && STATION.test(s.name));
        worker?.terminate();
        worker = new Worker(new URL('./satworker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<{ t: number; pos: Float32Array }>) => { busy = false; if (!gone) landed(e.data.t, e.data.pos); };
        worker.postMessage({ type: 'init', sats: tles.map(s => ({ line1: s.line1, line2: s.line2 })) });
        busy = false; wanted = null;
      } else {
        const r = await fetch(`/api/sky/orbiters?body=${encodeURIComponent(bodyId)}`);
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
        tracks = d.craft as TrackCraft[];
        ids = tracks.map(c => c.id); names = tracks.map(c => c.name); station = tracks.map(() => false);
        if (d.stale) opts.onStatus?.({ count: tracks.length, note: 'Offline: showing the last orbits Shell:B fetched.' });
      }
      if (gone) return;
      pos = new Float32Array(0);
      if (keep) select(keep);
      opts.onStatus?.({ count: ids.length, note: ids.length ? undefined : `No spacecraft are orbiting ${bodyId[0].toUpperCase() + bodyId.slice(1)} right now.` });
      update();
    } catch (e) {
      if (!gone) opts.onStatus?.({ count: 0, error: (e as Error).message });
    }
  };
  load();

  const timers = [
    setInterval(() => { if (Math.abs(clockSpeed()) <= 1) update(); }, 1000),  // live/paused: once a second; playing keeps itself going
    setInterval(load, earth ? 6 * 3600_000 : 30 * 60_000),                     // fresh elements; Horizons windows move with now
  ];
  const unsubscribe = subscribeClock(() => { lastTrack = 0; update(); });

  return {
    select,
    hitTest: (x, y) => pick(x, y, 12) != null,
    search: (q, limit = 8) => {
      const s = q.trim().toLowerCase();
      if (s.length < 2) return [];
      const hits: { i: number; score: number }[] = [];
      for (let i = 0; i < names.length && hits.length < 400; i++) {
        const n = names[i].toLowerCase();
        const k = n === s || ids[i] === s ? 0 : n.startsWith(s) ? 1 : n.includes(s) ? 2 : -1;
        if (k >= 0) hits.push({ i, score: k * 10 + (station[i] ? -5 : 0) + n.length / 100 });
      }
      return hits.sort((a, b) => a.score - b.score).slice(0, limit).map(({ i }) => {
        const alt = pos[i * 3 + 2];
        return { id: ids[i], name: names[i], regime: Number.isNaN(alt) || alt === undefined ? null : regimeOf(alt) };
      });
    },
    passes: (id, lat, lon) => {
      if (!earth) return null;
      const i = ids.indexOf(id);
      if (i < 0) return null;
      try { return passes(twoline2satrec(tles[i].line1, tles[i].line2), lat, lon, clockNow()); } catch { return null; }
    },
    where: id => { const i = ids.indexOf(id); return i < 0 ? null : infoAt(i); },
    detach: () => {
      gone = true;
      timers.forEach(clearInterval);
      unsubscribe();
      cancelAnimationFrame(moveRaf);
      cancelAnimationFrame(trackRaf);
      worker?.terminate();
      map.off('render', drawOverlay);
      map.off('mousemove', onMove);
      map.off('click', onClick);
      canvas.remove();
      try {
        for (const id of [GL_LAYER, `${TRACK}-past`, `${TRACK}-next`, `${TRACK}-foot`]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(TRACK)) map.removeSource(TRACK);
      } catch { /* the map itself is already gone */ }
    },
  };
}

/** Ground circle where a craft at `alt` km is above the horizon: [lon, lat][] around (lat, lon). */
function footprint(lat: number, lon: number, alt: number, R: number, n = 96): [number, number][] {
  const lam = Math.acos(R / (R + alt));
  const la1 = (lat * Math.PI) / 180, lo1 = (lon * Math.PI) / 180;
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const b = (k / n) * 2 * Math.PI;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(lam) + Math.cos(la1) * Math.sin(lam) * Math.cos(b));
    const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(lam) * Math.cos(la1), Math.cos(lam) - Math.sin(la1) * Math.sin(la2));
    out.push([((((lo2 * 180) / Math.PI) + 540) % 360) - 180, (la2 * 180) / Math.PI]);
  }
  return out;
}
