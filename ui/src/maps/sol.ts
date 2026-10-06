// Low-precision ephemeris for the Sol view: heliocentric positions in AU, J2000 ecliptic (x toward the vernal equinox).
// Planets: JPL "Keplerian Elements for Approximate Positions of the Major Planets" (Standish), table 1, valid 1800–2050,
// good to well under a degree for the inner planets. Ceres/Vesta: JPL SBDB osculating elements at JD 2461200.5,
// propagated as two-body orbits. The Moon: the Astronomical Almanac's low-precision series (~0.3°).
// Every other moon: JPL's mean satellite elements (moons.json, from scripts/moons.py), re-anchored to a Horizons
// position at 2026-01-01 and advanced with the table's periods and precession rates. Good to a few degrees for years
// either side of 2026; the small irregular moons wander more.
import MOON_ROWS from './moons.json';

export type Vec3 = [number, number, number];

export interface SolBody {
  id: string;
  name: string;
  kind: 'star' | 'planet' | 'dwarf' | 'asteroid' | 'moon';
  parent?: string;
  color: string;
  /** null for small moons nobody has measured */
  radius_km: number | null;
  /** moons: semi-major axis around the parent, km */
  a_km?: number;
  /** orbital period, days (for the info card) */
  period?: number;
}

const DEG = Math.PI / 180;
const AU_KM = 149_597_870.7;
const J2000 = 2451545.0;

export const jd = (ms: number) => ms / 86_400_000 + 2440587.5;

// a (AU), e, I, L, ϖ (long. of perihelion), Ω — then their rates per Julian century
type Elements = [number, number, number, number, number, number];
const PLANETS: Record<string, [Elements, Elements]> = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  pluto: [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
    [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
};

// a, e, i, Ω, ω, M at epoch, n (deg/day), epoch JD
const MINOR: Record<string, [number, number, number, number, number, number, number, number]> = {
  ceres: [2.765552595034094, 0.07969229514816586, 10.58802780183462, 80.24862682043221, 73.29421453021587, 274.4193463761342, 0.21430445064843, 2461200.5],
  vesta: [2.361365965127599, 0.09020374382834395, 7.143925545058711, 103.701293265032, 151.4686478221564, 81.19015607686903, 0.2716183613599909, 2461200.5],
  haumea: [43.06029023650952, 0.1944430148898797, 28.20847393040364, 121.7860561329425, 240.6905472508661, 223.2104118812299, 0.003488097731816818, 2461200.5],
  makemake: [45.57093317300052, 0.1588889953992523, 29.02785603743067, 79.2948338209406, 297.0922733397207, 169.9379962048232, 0.003203850120050116, 2461200.5],
  eris: [67.93394687853566, 0.4382385347971672, 43.9258279471791, 36.00477044417249, 150.7949235840312, 211.774434275007, 0.001760247770619088, 2461200.5],
};

// ── moons ─────────────────────────────────────────────────────────────────
// [name, planet, a_km, e, w, M, i, node, P_days, P_apsis_yr, P_node_yr, pole_ra, pole_dec, frame, epoch_jd, radius_km]
type MoonRow = [string, string, number, number, number, number, number, number, number, number | null, number | null, number | null, number | null, number, number, number | null];
// IAU poles for the "equatorial" frame (Uranus, Pluto)
const POLES: Record<string, [number, number]> = { uranus: [257.311, -15.175], pluto: [132.993, -6.163], neptune: [299.36, 43.46] };
const OBLIQUITY = 23.4392911 * DEG;
const MOON_COLORS: Record<string, string> = {
  moon: '#cfcfcf', io: '#e6d36a', europa: '#d8cdb8', ganymede: '#a99f92', callisto: '#7d7368', titan: '#e0a85a',
  enceladus: '#f2f5f7', triton: '#d9c7c0', charon: '#a7a29c', iapetus: '#bfb3a3', rhea: '#cfcac4', dione: '#d6d3cf',
  tethys: '#e0ddd8', mimas: '#bdbab5', miranda: '#bcbcbc', ariel: '#c9c6c2', umbriel: '#8d8a87', titania: '#b8aea6', oberon: '#a39a92',
};

export const moonId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** "S2004_S_40" → "S/2004 S 40" */
const moonName = (raw: string) => raw.replace(/^S(\d{4})_?([A-Z])_?(\d+)$/, 'S/$1 $2 $3');

interface MoonOrbit { planet: string; a: number; e: number; w: number; M: number; i: number; O: number; n: number; wdot: number; Odot: number; ep: number; frame: number; pole: [number, number] | null }
const MOON_ORBITS: Record<string, MoonOrbit> = {};
const MOON_BODIES: SolBody[] = [];
for (const r of MOON_ROWS as MoonRow[]) {
  const [raw, planet, a, e, w, M, i, O, P, Pa, Pn, ra, dec, frame, ep, rad] = r;
  if (planet === 'earth') continue;  // the Moon has its own series below
  const id = moonId(raw);
  MOON_ORBITS[id] = { planet, a: a / AU_KM, e, w, M, i, O, n: 360 / P, wdot: Pa ? 360 / Pa / 365.25 : 0, Odot: Pn ? -360 / Pn / 365.25 : 0, ep, frame,
    pole: frame === 1 && ra != null && dec != null ? [ra, dec] : frame === 2 ? POLES[planet] ?? null : null };
  MOON_BODIES.push({ id, name: moonName(raw), kind: 'moon', parent: planet, color: MOON_COLORS[id] ?? '#9a9a9a', radius_km: rad, period: P, a_km: a });
}

/** Plane-of-reference coordinates → J2000 ecliptic. The plane is given by its pole in ICRF; its node on the ICRF equator is x. */
function fromPlane(v: Vec3, pole: [number, number] | null): Vec3 {
  if (!pole) return v;
  const ti = (90 - pole[1]) * DEG, tn = (pole[0] + 90) * DEG;
  const y1 = v[1] * Math.cos(ti) - v[2] * Math.sin(ti), z1 = v[1] * Math.sin(ti) + v[2] * Math.cos(ti);
  const x2 = v[0] * Math.cos(tn) - y1 * Math.sin(tn), y2 = v[0] * Math.sin(tn) + y1 * Math.cos(tn);
  return [x2, y2 * Math.cos(OBLIQUITY) + z1 * Math.sin(OBLIQUITY), -y2 * Math.sin(OBLIQUITY) + z1 * Math.cos(OBLIQUITY)];
}

function moonOrbitAt(o: MoonOrbit, JD: number) {
  const d = JD - o.ep;
  return { a: o.a, e: o.e, I: o.i * DEG, O: (o.O + o.Odot * d) * DEG, w: (o.w + o.wdot * d) * DEG, M: (o.M + (o.n - o.wdot - o.Odot) * d) * DEG };
}

/** Offset of a moon from its planet (AU, J2000 ecliptic). */
function moonOffset(id: string, JD: number): Vec3 | null {
  const o = MOON_ORBITS[id];
  if (!o) return null;
  const k = moonOrbitAt(o, JD), E = kepler(k.M, k.e);
  return fromPlane(rotate(k.a * (Math.cos(E) - k.e), k.a * Math.sqrt(1 - k.e * k.e) * Math.sin(E), k.w, k.O, k.I), o.pole);
}

export const SOL_BODIES: SolBody[] = [
  { id: 'sol', name: 'Sol', kind: 'star', color: '#ffd27a', radius_km: 695_700 },
  { id: 'mercury', name: 'Mercury', kind: 'planet', color: '#a7a19a', radius_km: 2439.4, period: 87.97 },
  { id: 'venus', name: 'Venus', kind: 'planet', color: '#e8cf9b', radius_km: 6051.8, period: 224.70 },
  { id: 'earth', name: 'Earth', kind: 'planet', color: '#5b9cff', radius_km: 6371, period: 365.256 },
  { id: 'moon', name: 'Moon', kind: 'moon', parent: 'earth', color: '#cfcfcf', radius_km: 1737.4, period: 27.32 },
  { id: 'mars', name: 'Mars', kind: 'planet', color: '#e0703f', radius_km: 3389.5, period: 686.98 },
  { id: 'vesta', name: 'Vesta', kind: 'asteroid', color: '#b9ab98', radius_km: 262.7, period: 1325.4 },
  { id: 'ceres', name: 'Ceres', kind: 'dwarf', color: '#9c9890', radius_km: 469.7, period: 1679.9 },
  { id: 'jupiter', name: 'Jupiter', kind: 'planet', color: '#d9b38c', radius_km: 69_911, period: 4332.6 },
  { id: 'saturn', name: 'Saturn', kind: 'planet', color: '#e3cf8f', radius_km: 58_232, period: 10_759 },
  { id: 'uranus', name: 'Uranus', kind: 'planet', color: '#9fdbe0', radius_km: 25_362, period: 30_687 },
  { id: 'neptune', name: 'Neptune', kind: 'planet', color: '#5c7cf0', radius_km: 24_622, period: 60_190 },
  { id: 'pluto', name: 'Pluto', kind: 'dwarf', color: '#c9a98a', radius_km: 1188.3, period: 90_560 },
  { id: 'haumea', name: 'Haumea', kind: 'dwarf', color: '#d9d4cc', radius_km: 780, period: 103_250 },
  { id: 'makemake', name: 'Makemake', kind: 'dwarf', color: '#c98f6a', radius_km: 715, period: 112_400 },
  { id: 'eris', name: 'Eris', kind: 'dwarf', color: '#dcdcdc', radius_km: 1163, period: 204_520 },
  ...MOON_BODIES,
];
SOL_BODIES.find(b => b.id === 'moon')!.a_km = 384_400;

/** Moons of a body, nearest first. */
export function moonsOf(id: string): SolBody[] {
  return SOL_BODIES.filter(b => b.parent === id).sort((a, b) => (a.a_km ?? 0) - (b.a_km ?? 0));
}

/** The moons worth listing up front: all of them for small systems, else the ones ≥ 100 km across in radius terms. */
export function isMajorMoon(b: SolBody, siblings: number) {
  return siblings <= 6 || (b.radius_km ?? 0) >= 100;
}

function kepler(M: number, e: number) {
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 12; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Orbit-plane coordinates → J2000 ecliptic, for argument of perihelion w, node O and inclination I (radians). */
function rotate(xp: number, yp: number, w: number, O: number, I: number): Vec3 {
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

/** Orbit shape at a date: a, e, w, Ω, I in radians, and the mean anomaly now. */
function orbitAt(id: string, JD: number) {
  const p = PLANETS[id];
  if (p) {
    const T = (JD - J2000) / 36525;
    const [a, e, I, L, wbar, O] = p[0].map((v, i) => v + p[1][i] * T);
    return { a, e, I: I * DEG, O: O * DEG, w: (wbar - O) * DEG, M: (L - wbar) * DEG };
  }
  const m = MINOR[id];
  if (m) {
    const [a, e, i, O, w, M0, n, ep] = m;
    return { a, e, I: i * DEG, O: O * DEG, w: w * DEG, M: (M0 + n * (JD - ep)) * DEG };
  }
  return null;
}

function moonGeo(JD: number): Vec3 {
  const T = (JD - J2000) / 36525;
  const s = (a: number, b: number) => Math.sin((a + b * T) * DEG), c = (a: number, b: number) => Math.cos((a + b * T) * DEG);
  const lon = 218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) + 0.66 * s(235.7, 890534.22)
    + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03)
    - 1.397 * T;  // equinox of date → J2000
  const lat = 5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21);
  const par = 0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36) + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74);
  const r = 6378.14 / Math.sin(par * DEG) / AU_KM;
  return [r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.cos(lat * DEG) * Math.sin(lon * DEG), r * Math.sin(lat * DEG)];
}

/** Heliocentric position (AU) of every body at a time (ms since the epoch). */
export function positions(ms: number): Record<string, Vec3> {
  const JD = jd(ms);
  const out: Record<string, Vec3> = { sol: [0, 0, 0] };
  for (const b of SOL_BODIES) {
    if (b.kind === 'moon') continue;
    const o = orbitAt(b.id, JD);
    if (!o) continue;
    const E = kepler(o.M, o.e);
    out[b.id] = rotate(o.a * (Math.cos(E) - o.e), o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E), o.w, o.O, o.I);
  }
  // the table's "earth" is the Earth–Moon barycentre; split it into Earth and the Moon (mass ratio 81.3)
  const m = moonGeo(JD), bc = out.earth, k = 1 / 82.3;
  out.earth = [bc[0] - m[0] * k, bc[1] - m[1] * k, bc[2] - m[2] * k];
  out.moon = [out.earth[0] + m[0], out.earth[1] + m[1], out.earth[2] + m[2]];
  for (const id in MOON_ORBITS) {
    const p = out[MOON_ORBITS[id].planet], off = moonOffset(id, JD);
    if (p && off) out[id] = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  }
  return out;
}

/** A moon's orbit around its planet as a closed polyline (AU, relative to the planet). */
export function moonOrbitPath(id: string, ms: number, n = 96): Vec3[] {
  const JD = jd(ms);
  if (id === 'moon') {  // trace a month of the series
    return Array.from({ length: n + 1 }, (_, i) => moonGeo(JD + (i / n) * 27.3217));
  }
  const o = MOON_ORBITS[id];
  if (!o) return [];
  const k = moonOrbitAt(o, JD), b = k.a * Math.sqrt(1 - k.e * k.e);
  return Array.from({ length: n + 1 }, (_, i) => {
    const E = (i / n) * 2 * Math.PI;
    return fromPlane(rotate(k.a * (Math.cos(E) - k.e), b * Math.sin(E), k.w, k.O, k.I), o.pole);
  });
}

/** The orbit as a closed polyline (AU), for drawing. */
export function orbitPath(id: string, ms: number, n = 256): Vec3[] {
  const o = orbitAt(id, jd(ms));
  if (!o) return [];
  const b = o.a * Math.sqrt(1 - o.e * o.e);
  return Array.from({ length: n + 1 }, (_, i) => {
    const E = (i / n) * 2 * Math.PI;
    return rotate(o.a * (Math.cos(E) - o.e), b * Math.sin(E), o.w, o.O, o.I);
  });
}

export const AU = AU_KM;
export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Mean heliocentric semi-major axis (AU) of a planet, dwarf or asteroid; a moon gives its planet's. */
export function semiMajorAU(id: string): number | null {
  const host = MOON_ORBITS[id]?.planet ?? (id === 'moon' ? 'earth' : id);
  return orbitAt(host, J2000)?.a ?? null;
}
