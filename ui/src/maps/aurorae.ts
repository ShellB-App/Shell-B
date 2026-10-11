// Aurorae and rings for the giant planets in the orrery (SolView), drawn on the 2D canvas once a planet's disc is big
// enough. The ovals ring each magnetic pole at their real colatitudes (Jupiter's main oval ~15° from the pole with the
// Io footprint ~8° further out at Io's longitude; Saturn's ~15°), the poles point where the IAU rotation models put them,
// and the glow flickers. Giant-planet aurorae shine mostly in the ultraviolet, so the colours are false colour.
import { fromPlane, type Vec3 } from './sol';

export interface AuroraSpec {
  /** north pole, ICRF right ascension and declination (IAU 2015) */
  pole: [number, number];
  ovals: { colat: number; width: number; color: [number, number, number]; alpha: number }[];
  /** footprint of a moon's flux tube: moon id and magnetic colatitude */
  footprint?: { moon: string; colat: number; color: string };
  rings?: { inner: number; outer: number; alpha: number; color: string }[];  // in planetary radii
  note: string;
}

export const AURORAE: Record<string, AuroraSpec> = {
  jupiter: {
    pole: [268.057, 64.495],
    ovals: [{ colat: 15, width: 2.2, color: [205, 140, 255], alpha: 0.85 }, { colat: 11, width: 1.2, color: [255, 190, 240], alpha: 0.35 }],
    footprint: { moon: 'io', colat: 24, color: 'rgba(255,230,150,0.95)' },
    note: 'The brightest aurorae in the Solar System: a main oval around each pole, bright spots where Io, Europa and Ganymede’s flux tubes land, and polar flares. Ultraviolet mostly, shown in false colour.',
  },
  saturn: {
    pole: [40.589, 83.537],
    ovals: [{ colat: 15, width: 2.5, color: [130, 180, 255], alpha: 0.8 }, { colat: 12, width: 1.0, color: [200, 220, 255], alpha: 0.3 }],
    rings: [{ inner: 1.24, outer: 1.53, alpha: 0.22, color: '#d9cdb0' }, { inner: 1.53, outer: 1.95, alpha: 0.72, color: '#e6dcc0' }, { inner: 2.03, outer: 2.27, alpha: 0.55, color: '#dccfae' }],
    note: 'Ovals around both poles, brightening with the solar wind and pulsing with Saturn’s 10.7-hour radio period; Cassini watched them from above. Ultraviolet mostly, shown in false colour.',
  },
};

const DEG = Math.PI / 180;
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Pole direction in J2000 ecliptic coordinates, and two perpendicular unit vectors in the equatorial plane. */
export function poleFrame(spec: AuroraSpec): { p: Vec3; u: Vec3; v: Vec3 } {
  const p = norm(fromPlane([0, 0, 1], spec.pole));
  const u = norm(cross(p, Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const v = cross(p, u);
  return { p, u, v };
}

export interface DrawCtx {
  g: CanvasRenderingContext2D;
  cx: number; cy: number;
  /** screen offset (px) of a vector given in AU, for the current camera */
  proj: (v: Vec3) => [number, number];
  /** unit vector pointing away from the camera (larger depth) */
  viewDir: Vec3;
  radiusAU: number;
  radiusPx: number;
  /** ms, for the flicker */
  t: number;
  /** direction from the planet to the footprint moon (ecliptic), if known */
  moonDir?: Vec3 | null;
}

const point = (f: { p: Vec3; u: Vec3; v: Vec3 }, colat: number, az: number): Vec3 => {
  const s = Math.sin(colat), c = Math.cos(colat);
  return [c * f.p[0] + s * (Math.cos(az) * f.u[0] + Math.sin(az) * f.v[0]),
    c * f.p[1] + s * (Math.cos(az) * f.u[1] + Math.sin(az) * f.v[1]),
    c * f.p[2] + s * (Math.cos(az) * f.u[2] + Math.sin(az) * f.v[2])];
};

/** Saturn's rings: `which` = 'far' draws the half behind the planet (before the disc), 'near' the half in front. */
export function drawRings(spec: AuroraSpec, d: DrawCtx, which: 'far' | 'near') {
  if (!spec.rings) return;
  const f = poleFrame(spec);
  const { g } = d;
  const N = 180;
  for (const band of spec.rings) {
    const outer: ([number, number] | null)[] = [], inner: ([number, number] | null)[] = [];
    for (let i = 0; i <= N; i++) {
      const az = (i / N) * 2 * Math.PI;
      const n = point(f, Math.PI / 2, az);
      const near = dot(n, d.viewDir) < 0;
      if ((which === 'near') !== near) { outer.push(null); inner.push(null); continue; }
      const o = d.proj([n[0] * band.outer * d.radiusAU, n[1] * band.outer * d.radiusAU, n[2] * band.outer * d.radiusAU]);
      const q = d.proj([n[0] * band.inner * d.radiusAU, n[1] * band.inner * d.radiusAU, n[2] * band.inner * d.radiusAU]);
      outer.push([d.cx + o[0], d.cy + o[1]]); inner.push([d.cx + q[0], d.cy + q[1]]);
    }
    // the visible half is one contiguous run (possibly wrapping): rotate so it starts after a gap
    let start = outer.findIndex((p, i) => p && !outer[(i + N) % (N + 1)]);
    if (start < 0) start = 0;
    const run: number[] = [];
    for (let k = 0; k <= N; k++) { const i = (start + k) % (N + 1); if (outer[i]) run.push(i); else if (run.length) break; }
    if (run.length < 2) continue;
    g.beginPath();
    run.forEach((i, k) => { const p = outer[i]!; if (k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
    [...run].reverse().forEach(i => { const p = inner[i]!; g.lineTo(p[0], p[1]); });
    g.closePath();
    g.fillStyle = band.color;
    g.globalAlpha = band.alpha * (which === 'far' ? 0.75 : 1);
    g.fill();
    g.globalAlpha = 1;
  }
}

/** The auroral ovals at both poles (visible parts), with the moon footprint when its direction is known. */
export function drawAurorae(spec: AuroraSpec, d: DrawCtx) {
  const f = poleFrame(spec);
  const { g } = d;
  const N = 120;
  for (const hemi of [1, -1] as const) {
    const fh = hemi === 1 ? f : { p: [-f.p[0], -f.p[1], -f.p[2]] as Vec3, u: f.u, v: [-f.v[0], -f.v[1], -f.v[2]] as Vec3 };
    for (const oval of spec.ovals) {
      const w = Math.max(1.2, d.radiusPx * Math.sin(oval.width * DEG) * 2);
      g.lineWidth = w;
      g.lineCap = 'round';
      g.shadowColor = `rgba(${oval.color[0]},${oval.color[1]},${oval.color[2]},0.9)`;
      g.shadowBlur = Math.max(4, w * 2.5);
      let open = false;
      for (let i = 0; i <= N; i++) {
        const az = (i / N) * 2 * Math.PI;
        // slightly ragged: the oval wanders by a degree or so, and flickers along its length
        const wobble = 1 + 0.05 * Math.sin(az * 3 + d.t / 900) + 0.03 * Math.sin(az * 7 - d.t / 500);
        const n = point(fh, oval.colat * DEG * wobble, az);
        const vis = dot(n, d.viewDir) < -0.02;
        if (!vis) { if (open) { g.stroke(); open = false; } continue; }
        const o = d.proj([n[0] * d.radiusAU * 1.01, n[1] * d.radiusAU * 1.01, n[2] * d.radiusAU * 1.01]);
        const flick = 0.75 + 0.25 * Math.sin(az * 5 + d.t / 350) * Math.sin(az * 2 - d.t / 1300);
        const edge = Math.min(1, -dot(n, d.viewDir) * 3);  // fades at the limb
        g.strokeStyle = `rgba(${oval.color[0]},${oval.color[1]},${oval.color[2]},${(oval.alpha * flick * edge).toFixed(3)})`;
        if (!open) { g.beginPath(); g.moveTo(d.cx + o[0], d.cy + o[1]); open = true; }
        else { g.lineTo(d.cx + o[0], d.cy + o[1]); g.stroke(); g.beginPath(); g.moveTo(d.cx + o[0], d.cy + o[1]); }
      }
      if (open) g.stroke();
    }
    // the moon's footprint: a bright spot on the oval at the moon's longitude
    if (spec.footprint && d.moonDir) {
      const m = d.moonDir;
      const az = Math.atan2(dot(m, f.v) * hemi, dot(m, f.u));
      const n = point(fh, spec.footprint.colat * DEG, az);
      if (dot(n, d.viewDir) < -0.05) {
        const o = d.proj([n[0] * d.radiusAU * 1.01, n[1] * d.radiusAU * 1.01, n[2] * d.radiusAU * 1.01]);
        const r = Math.max(1.5, d.radiusPx * 0.025) * (1 + 0.2 * Math.sin(d.t / 200));
        g.shadowColor = spec.footprint.color; g.shadowBlur = r * 4;
        g.fillStyle = spec.footprint.color;
        g.beginPath(); g.arc(d.cx + o[0], d.cy + o[1], r, 0, 2 * Math.PI); g.fill();
      }
    }
  }
  g.shadowBlur = 0; g.lineCap = 'butt';
}

/** Disc radius in px from which the aurorae are worth drawing. */
export const AURORA_MIN_PX = 16;
