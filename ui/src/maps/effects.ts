// Animated effects on the Worlds map, drawn as a MapLibre custom layer (same projection path as the spacecraft):
//   plumes  Enceladus' south-polar geysers and Io's volcanic plumes, particles rising from the real vents
//   dust    Mars dust-storm season, drifting tan haze over the regions where regional storms start
// These are impressions (the vents and storm regions are real; the motion is not live data), and the Layers menu says so.
import type * as ML from 'maplibre-gl';
import { invert, merc, mul, sphere } from './orbiters';
import { mapAlive } from './pointLayer';

export type EffectKind = 'plumes' | 'dust';

interface Vent { lat: number; lon: number; name: string; height: number }  // height km
// Enceladus: the four tiger stripes (Baghdad, Damascus, Cairo, Alexandria sulci) around the south pole, with jets along them.
const ENCELADUS: Vent[] = [
  { lat: -81, lon: 30, name: 'Baghdad Sulcus', height: 220 }, { lat: -78, lon: 60, name: 'Baghdad Sulcus', height: 180 }, { lat: -84, lon: 0, name: 'Baghdad Sulcus', height: 200 },
  { lat: -80, lon: -40, name: 'Damascus Sulcus', height: 240 }, { lat: -76, lon: -20, name: 'Damascus Sulcus', height: 160 },
  { lat: -82, lon: 110, name: 'Cairo Sulcus', height: 190 }, { lat: -78, lon: 130, name: 'Cairo Sulcus', height: 150 },
  { lat: -79, lon: 180, name: 'Alexandria Sulcus', height: 170 }, { lat: -75, lon: 160, name: 'Alexandria Sulcus', height: 140 },
];
// Io: the big plumes seen by Voyager, Galileo and New Horizons (IAU longitudes are west-positive; converted to east)
const IO: Vent[] = [
  { lat: -18.7, lon: -255.3 + 360, name: 'Pele', height: 300 }, { lat: 12.6, lon: -308.8 + 360, name: 'Loki', height: 180 },
  { lat: -1.5, lon: -153, name: 'Prometheus', height: 100 }, { lat: 62, lon: -123, name: 'Tvashtar', height: 330 },
  { lat: -12, lon: -243 + 360, name: 'Pillan', height: 140 }, { lat: -28, lon: -210 + 360, name: 'Marduk', height: 120 },
  { lat: 2, lon: -28, name: 'Zamama', height: 90 }, { lat: -45, lon: -340 + 360, name: 'Masubi', height: 110 },
];
// Mars: where regional storms tend to start in southern spring and summer (Hellas, Argyre, Chryse/Acidalia, Noachis, Isidis, Syria)
const STORMS = [
  { lat: -42, lon: 70, r: 14, name: 'Hellas' }, { lat: -50, lon: -43, r: 9, name: 'Argyre' }, { lat: 22, lon: -40, r: 10, name: 'Chryse / Acidalia' },
  { lat: -35, lon: 10, r: 10, name: 'Noachis' }, { lat: 12, lon: 88, r: 8, name: 'Isidis' }, { lat: -12, lon: -100, r: 8, name: 'Syria / Solis' },
];

const VERT = `
attribute vec3 a_pos; attribute vec4 a_color; attribute float a_size;
uniform mat4 u_matrix; uniform vec3 u_cam; uniform float u_globe; uniform float u_dpr;
varying vec4 v_color;
void main() {
  if (u_globe > 0.5) {
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
varying vec4 v_color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r = dot(c, c);
  if (r > 1.0) discard;
  float a = v_color.a * (1.0 - smoothstep(0.0, 1.0, r));
  gl_FragColor = vec4(v_color.rgb * a, a);
}`;

export interface EffectInfo { kind: EffectKind; sources: string[]; note: string }

export function effectFor(bodyId: string): EffectInfo | null {
  if (bodyId === 'enceladus') return { kind: 'plumes', sources: [...new Set(ENCELADUS.map(v => v.name))], note: 'Geysers along the tiger stripes: water vapour and ice grains rising hundreds of km, feeding Saturn’s E ring. Vents are real, the animation is an impression.' };
  if (bodyId === 'io') return { kind: 'plumes', sources: IO.map(v => v.name), note: 'Volcanic plumes of sulphur dioxide up to 300 km high at the major vents. Vents are real, the animation is an impression.' };
  if (bodyId === 'mars') return { kind: 'dust', sources: STORMS.map(s => s.name), note: 'Dust-storm season (southern spring and summer): regional storms start in these basins and can go global. An impression, not a forecast.' };
  return null;
}

export function attachEffects(map: ML.Map, bodyId: string, radiusKm: number): () => void {
  const info = effectFor(bodyId);
  if (!info) return () => {};
  const ID = 'sb-effects';
  const R = radiusKm;
  const vents = bodyId === 'enceladus' ? ENCELADUS : IO;
  const N = info.kind === 'plumes' ? vents.length * 220 : STORMS.length * 500;
  // per particle: source index, phase 0..1, two random offsets
  const src = new Uint16Array(N), phase = new Float32Array(N), ra = new Float32Array(N), rb = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    src[i] = info.kind === 'plumes' ? i % vents.length : i % STORMS.length;
    phase[i] = Math.random(); ra[i] = Math.random() * Math.PI * 2; rb[i] = Math.random();
  }
  let mainMatrix: ArrayLike<number> | null = null;
  let prog: WebGLProgram | null = null, buf: WebGLBuffer | null = null;
  let loc: { pos: number; color: number; size: number; matrix: WebGLUniformLocation | null; cam: WebGLUniformLocation | null; globe: WebGLUniformLocation | null; dpr: WebGLUniformLocation | null } | null = null;
  const data = new Float32Array(N * 8);
  let gone = false;
  const t0 = performance.now();

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

  /** Fill the vertex buffer for time `t` (seconds). */
  const build = (mode: 'globe' | 'flat', t: number, zoom: number) => {
    const degPerKm = 360 / (2 * Math.PI * R);
    let k = 0;
    const px = Math.pow(2, zoom);  // particle sizes grow with zoom so plumes stay visible when close
    for (let i = 0; i < N; i++) {
      let lon: number, lat: number, alt: number, r: number, g: number, b: number, a: number, size: number;
      if (info.kind === 'plumes') {
        const v = vents[src[i]];
        const life = (phase[i] + t / 14) % 1;  // 14 s to rise and fall
        const up = Math.sin(life * Math.PI);    // ballistic: up then down
        // real plume heights (hundreds of km) would leave the screen on a small moon drawn close up: cap at a fifth of the radius
        const top = Math.min(v.height, R * 0.2);
        alt = up * top * (0.6 + 0.4 * rb[i]);
        const spread = life * top * 0.12 * degPerKm;  // widening umbrella
        lon = v.lon + Math.cos(ra[i]) * spread * (0.3 + rb[i]);
        lat = v.lat + Math.sin(ra[i]) * spread * (0.3 + rb[i]);
        const bright = 1 - life * 0.8;
        if (bodyId === 'io') { r = 1; g = 0.86 * bright + 0.1; b = 0.35 * bright; a = 0.85 * (1 - life); }
        else { r = 0.82; g = 0.93; b = 1; a = 0.9 * (1 - life * life); }
        size = (3 + life * 5) * Math.min(4, Math.max(0.8, px / 6));
      } else {
        const s = STORMS[src[i]];
        const ang = ra[i] + t * (0.08 + 0.06 * rb[i]) * (src[i] % 2 ? 1 : -1);  // slow swirl, alternating senses
        const rad = s.r * (0.15 + 0.85 * phase[i]) * (0.9 + 0.2 * Math.sin(t * 0.3 + ra[i]));
        lon = s.lon + Math.cos(ang) * rad / Math.max(0.3, Math.cos((s.lat * Math.PI) / 180));
        lat = s.lat + Math.sin(ang) * rad * 0.7;
        alt = 8 + 30 * rb[i];
        r = 0.86; g = 0.64; b = 0.42; a = 0.22 + 0.18 * Math.sin(t * 0.5 + ra[i] * 3);
        size = (9 + 10 * rb[i]) * Math.min(4, Math.max(0.5, px / 3));
      }
      const v3 = mode === 'globe' ? sphere(lon, lat, 1 + alt / R) : merc(lon, lat);
      data[k] = v3[0]; data[k + 1] = v3[1]; data[k + 2] = v3[2];
      data[k + 3] = r; data[k + 4] = g; data[k + 5] = b; data[k + 6] = a; data[k + 7] = size;
      k += 8;
    }
    return k / 8;
  };

  const layer: ML.CustomLayerInterface = {
    id: ID, type: 'custom', renderingMode: '2d',
    onAdd: (_m, gl) => {
      const sh = (type: number, s: string) => { const o = gl.createShader(type)!; gl.shaderSource(o, s); gl.compileShader(o); return o; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('effects shader:', gl.getProgramInfoLog(p)); return; }
      prog = p; buf = gl.createBuffer();
      loc = { pos: gl.getAttribLocation(p, 'a_pos'), color: gl.getAttribLocation(p, 'a_color'), size: gl.getAttribLocation(p, 'a_size'),
        matrix: gl.getUniformLocation(p, 'u_matrix'), cam: gl.getUniformLocation(p, 'u_cam'), globe: gl.getUniformLocation(p, 'u_globe'), dpr: gl.getUniformLocation(p, 'u_dpr') };
    },
    render: (gl, args) => {
      mainMatrix = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
      if (!prog || !buf || !loc || document.hidden) return;
      const mode = modeNow();
      if (!mode) return;
      const count = build(mode, (performance.now() - t0) / 1000, map.getZoom());
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 8), gl.DYNAMIC_DRAW);
      const cam = camera();
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.matrix, false, new Float32Array(mainMatrix));
      gl.uniform3fv(loc.cam, cam ?? [0, 0, 0]);
      gl.uniform1f(loc.globe, mode === 'globe' && cam ? 1 : 0);
      gl.uniform1f(loc.dpr, Math.min(window.devicePixelRatio || 1, 2));
      gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(loc.color); gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 32, 12);
      gl.enableVertexAttribArray(loc.size); gl.vertexAttribPointer(loc.size, 1, gl.FLOAT, false, 32, 28);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(loc.pos); gl.disableVertexAttribArray(loc.color); gl.disableVertexAttribArray(loc.size);
      if (!gone) map.triggerRepaint();  // keep animating while the layer is on
    },
    onRemove: (_m, gl) => { if (prog) gl.deleteProgram(prog); if (buf) gl.deleteBuffer(buf); prog = buf = null; },
  };
  map.addLayer(layer);
  map.triggerRepaint();
  return () => {
    gone = true;
    if (mapAlive(map) && map.getLayer(ID)) map.removeLayer(ID);
  };
}
