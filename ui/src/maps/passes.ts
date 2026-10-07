// Visible passes of an Earth satellite over a place: when it's ≥10° up, lit by the Sun, while the observer's sky is dark.
// SGP4 via satellite.js; the Sun's direction from terminator.ts (accurate to a fraction of a degree, plenty here).
import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, propagate, type SatRec } from 'satellite.js';
import { getSubsolarPoint } from './terminator';

const R_EARTH = 6371;

export interface Pass {
  start: number; peak: number; end: number;   // ms
  maxEl: number;                               // degrees
  startAz: number; endAz: number;              // degrees
  /** part of the pass is visible to the eye (sat sunlit, sky dark) */
  visible: boolean;
}

const unit = (lat: number, lon: number): [number, number, number] => {
  const la = degreesToRadians(lat), lo = degreesToRadians(lon);
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Passes above 10° elevation in the next `days` days from `from`, at most `max` of them. */
export function passes(rec: SatRec, lat: number, lon: number, from: number, days = 3, max = 8): Pass[] {
  const observer = { latitude: degreesToRadians(lat), longitude: degreesToRadians(lon), height: 0 };
  const up = unit(lat, lon);
  const out: Pass[] = [];
  let cur: Pass | null = null;
  const STEP = 20_000;
  for (let t = from; t < from + days * 86_400_000 && out.length < max; t += STEP) {
    const when = new Date(t);
    const pv = propagate(rec, when);
    if (!pv || !pv.position || typeof pv.position === 'boolean') { cur = null; continue; }
    const ecf = eciToEcf(pv.position, gstime(when));
    const look = ecfToLookAngles(observer, ecf);
    const el = (look.elevation * 180) / Math.PI, az = ((look.azimuth * 180) / Math.PI + 360) % 360;
    if (el >= 10) {
      const sun = getSubsolarPoint(t), s = unit(sun.lat, sun.lon);
      const p = [ecf.x, ecf.y, ecf.z], along = dot(p, s);
      const lit = along > 0 || Math.hypot(p[0] - along * s[0], p[1] - along * s[1], p[2] - along * s[2]) > R_EARTH;
      const dark = dot(s, up) < Math.sin((-6 * Math.PI) / 180);   // Sun 6° below the horizon: civil twilight over
      if (!cur) cur = { start: t, peak: t, end: t, maxEl: el, startAz: az, endAz: az, visible: false };
      if (el > cur.maxEl) { cur.maxEl = el; cur.peak = t; }
      cur.end = t; cur.endAz = az;
      if (lit && dark) cur.visible = true;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (az: number) => DIRS[Math.round(az / 45) % 8];
