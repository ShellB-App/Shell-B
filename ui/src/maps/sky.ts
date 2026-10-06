// Real sky positions and Earth-link numbers for the Worlds app, computed in the browser from sol.ts (JPL elements).
// Replaces /api/planetary/sky_view and /ephemeris, whose numbers were invented.
//
// Sky: target directions from the observer's spot (topocentric, so Phobos and our Moon are right), turned into
// the local horizon with the IAU WGCCRE 2015 rotation models (pole RA/Dec + prime meridian W). Light time and
// aberration are ignored: a fraction of a degree, below what the dome can show.
import { AU, SOL_BODIES, dist, positions, semiMajorAU, type Vec3 } from './sol';

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const EPS = 23.4392911 * DEG;  // J2000 obliquity: ecliptic → equatorial (ICRF)

type Rot = (d: number, T: number) => { a0: number; d0: number; W: number };

/** IAU rotation models (degrees; d = days, T = centuries from J2000 TDB). The Moon keeps its largest libration term. */
const ROTATION: Record<string, Rot> = {
  earth: (d, T) => ({ a0: -0.641 * T, d0: 90 - 0.557 * T, W: 190.147 + 360.9856235 * d }),
  moon: (d, T) => {
    const E1 = (125.045 - 0.0529921 * d) * DEG;
    return { a0: 269.9949 + 0.0031 * T - 3.8787 * Math.sin(E1), d0: 66.5392 + 0.013 * T + 1.5419 * Math.cos(E1), W: 38.3213 + 13.17635815 * d + 3.561 * Math.sin(E1) };
  },
  mercury: (d, T) => ({ a0: 281.0103 - 0.0328 * T, d0: 61.4155 - 0.0049 * T, W: 329.5988 + 6.1385108 * d }),
  venus: d => ({ a0: 272.76, d0: 67.16, W: 160.2 - 1.4813688 * d }),
  mars: (d, T) => ({ a0: 317.269202 - 0.10927547 * T, d0: 54.432516 - 0.05827105 * T, W: 176.049863 + 350.891982443297 * d }),
};

const RADIUS_KM: Record<string, number> = { earth: 6371, moon: 1737.4, mercury: 2439.7, venus: 6051.8, mars: 3389.5 };

/** Worlds where the sky view works (we know how they spin). */
export const hasSky = (bodyId: string) => bodyId in ROTATION;

const eclToEq = ([x, y, z]: Vec3): Vec3 => [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)];
const eqToEcl = ([x, y, z]: Vec3): Vec3 => [x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS)];
const rz = (t: number, [x, y, z]: Vec3): Vec3 => [Math.cos(t) * x + Math.sin(t) * y, -Math.sin(t) * x + Math.cos(t) * y, z];
const rx = (t: number, [x, y, z]: Vec3): Vec3 => [x, Math.cos(t) * y + Math.sin(t) * z, -Math.sin(t) * y + Math.cos(t) * z];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface SkyObject {
  id: string;
  name: string;
  alt: number;
  az: number;
  /** distance from the observer, km */
  km: number;
  /** lit fraction seen from here, 0..1 (moons and inner planets) */
  lit?: number;
}

export interface Sky {
  sun: SkyObject;
  objects: SkyObject[];
  state: 'day' | 'twilight' | 'night';
}

/** What's in the sky from (lat, lon) on a world at a time. Longitudes east-positive, as on the maps. */
export function skyFrom(bodyId: string, lat: number, lon: number, ms = Date.now()): Sky | null {
  const rot = ROTATION[bodyId];
  const P = positions(ms);
  const here = P[bodyId];
  if (!rot || !here) return null;
  const d = ms / 86_400_000 + 2440587.5 - J2000, T = d / 36525;
  const { a0, d0, W } = rot(d, T);
  // ICRF → body-fixed, and back
  const toBody = (v: Vec3) => rz(W * DEG, rx((90 - d0) * DEG, rz((90 + a0) * DEG, v)));
  const toIcrf = (v: Vec3) => rz(-(90 + a0) * DEG, rx(-(90 - d0) * DEG, rz(-W * DEG, v)));
  const φ = lat * DEG, λ = lon * DEG;
  const up: Vec3 = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  const east: Vec3 = [-Math.sin(λ), Math.cos(λ), 0];
  const north: Vec3 = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const r = (RADIUS_KM[bodyId] ?? 0) / AU;
  const obs: Vec3 = (() => { const o = eqToEcl(toIcrf([up[0] * r, up[1] * r, up[2] * r])); return [here[0] + o[0], here[1] + o[1], here[2] + o[2]]; })();

  const look = (id: string, name: string): SkyObject | null => {
    const p = P[id];
    if (!p) return null;
    const v = norm(toBody(eclToEq(sub(p, obs))));
    const alt = Math.asin(Math.max(-1, Math.min(1, dot(v, up)))) / DEG;
    const az = ((Math.atan2(dot(v, east), dot(v, north)) / DEG) + 360) % 360;
    const o: SkyObject = { id, name, alt, az, km: dist(p, obs) * AU };
    if (id !== 'sol') {
      const toSun = norm(sub([0, 0, 0], p)), toObs = norm(sub(obs, p));
      o.lit = (1 + dot(toSun, toObs)) / 2;
    }
    return o;
  };

  const sun = look('sol', 'Sun')!;
  const near = new Set(SOL_BODIES.filter(b => b.kind === 'moon' && b.parent === bodyId).map(b => b.id));
  if (bodyId === 'moon') near.add('earth');
  const ids = SOL_BODIES.filter(b => b.id !== bodyId && b.id !== 'sol' && (b.kind === 'planet' || near.has(b.id)));
  const objects = ids.map(b => look(b.id, b.name)).filter((o): o is SkyObject => !!o)
    .sort((a, b) => b.alt - a.alt);
  return { sun, objects, state: sun.alt > 0 ? 'day' : sun.alt > -18 ? 'twilight' : 'night' };
}

export interface EarthLink {
  km: number;
  au: number;
  lightSeconds: number;
  /** null for the Moon, where a Hohmann transfer between heliocentric orbits doesn't apply */
  transfer: { days: number; dvKms: number; synodicDays: number } | null;
}

/** Distance and signal delay from Earth now, plus an idealised Earth → target Hohmann transfer. */
export function earthLink(bodyId: string, ms = Date.now()): EarthLink | null {
  const P = positions(ms);
  if (!P[bodyId] || !P.earth || bodyId === 'earth') return null;
  const au = dist(P[bodyId], P.earth), km = au * AU;
  const r1 = semiMajorAU('earth')!, r2 = semiMajorAU(bodyId);
  let transfer: EarthLink['transfer'] = null;
  if (r2 && bodyId !== 'moon' && Math.abs(r2 - r1) > 0.01) {
    const V1 = 29.7847;  // circular speed at 1 AU, km/s
    const at = (r1 + r2) / 2;
    const dv1 = (V1 / Math.sqrt(r1)) * Math.abs(Math.sqrt(r2 / at) - 1);
    const dv2 = (V1 / Math.sqrt(r2)) * Math.abs(1 - Math.sqrt(r1 / at));
    const T1 = r1 ** 1.5, T2 = r2 ** 1.5;  // years
    transfer = { days: 0.5 * at ** 1.5 * 365.25, dvKms: dv1 + dv2, synodicDays: 365.25 / Math.abs(1 / T1 - 1 / T2) };
  }
  return { km, au, lightSeconds: km / 299_792.458, transfer };
}

export function fmtLight(s: number) {
  if (s < 60) return `${s.toFixed(2)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function fmtKm(km: number) {
  return km >= 1e9 ? `${(km / 1e9).toFixed(2)} billion km` : km >= 1e6 ? `${(km / 1e6).toFixed(1)} million km` : `${Math.round(km).toLocaleString()} km`;
}
