// Prehistoric places for the Worlds app (data in server/prehistory_sites.json): painted caves and Ice Age shelters (overlay "caves"), and the first farmers'
// villages, temples and megaliths (overlay "neolithic"). Written in English and French: Guy, who loves this period,
// reads Shell:B in French.
//
// `when` is in calendar years, negative = BC; the oldest figures are calibrated radiocarbon or uranium-series dates as
// published and are rounded. `align` lists the solar events a monument's axis is known to face; prehistorySolar()
// works out where that Sun stood on the horizon then and now (obliquity changes slowly, so the angles drift).
import { getLocale } from '../i18n';
import SITES from '../../../server/prehistory_sites.json';

export type PrehistoryKind = 'cave' | 'rockart' | 'shelter' | 'settlement' | 'temple' | 'megalith' | 'tomb' | 'find';
export type SolarEvent = 'ws-rise' | 'ws-set' | 'ss-rise' | 'ss-set' | 'eq-rise' | 'eq-set';
export type Visit = 'open' | 'replica' | 'closed' | 'site';

export interface PrehistorySite {
  id: string;
  name: string;
  nameFr?: string;
  kind: PrehistoryKind;
  place: string;
  country: string;
  lat: number;
  lon: number;
  /** The position is only known to a few kilometres (protected or remote sites). */
  approx?: boolean;
  /** [from, to] in calendar years, negative = BC. */
  when: [number, number?];
  period: string;
  discovered?: string;
  unesco?: number;
  visit?: Visit;
  /** Where people go instead when the original is closed. */
  replica?: string;
  align?: SolarEvent[];
  desc: string;
  highlight?: string;
  fr: { desc: string; highlight?: string };
}

export const CAVE_KINDS: PrehistoryKind[] = ['cave', 'rockart', 'shelter'];

/** The sites themselves live in server/prehistory_sites.json, shared with the agents' deep_time tool. */
export const PREHISTORY = SITES as unknown as PrehistorySite[];

const LOCALE_FR = () => getLocale() === 'fr';
export const siteName = (s: PrehistorySite) => (LOCALE_FR() && s.nameFr) || s.name;
export const siteDesc = (s: PrehistorySite) => (LOCALE_FR() ? s.fr.desc : s.desc);
export const siteHighlight = (s: PrehistorySite) => (LOCALE_FR() ? s.fr.highlight : s.highlight);
export const isCaveSite = (s: PrehistorySite) => CAVE_KINDS.includes(s.kind);

/** How long ago a site was begun, in years before 2000 (close enough to "years ago" at these scales). */
export const yearsAgo = (s: PrehistorySite) => 2000 - s.when[0];

/** "about 36,000 years ago" for the Ice Age, "3200–2900 BC" once dates are counted in calendar years. */
export function formatWhen(s: PrehistorySite): string {
  const fr = LOCALE_FR();
  const num = (n: number) => n.toLocaleString(fr ? 'fr' : 'en');
  const [a, b] = s.when;
  if (a < -10000) {
    const r = (y: number) => num(Math.round((2000 - y) / 1000) * 1000);
    const range = b != null && Math.round((2000 - b) / 1000) !== Math.round((2000 - a) / 1000) ? `${r(a)}–${r(b)}` : r(a);
    return fr ? `il y a environ ${range} ans` : `about ${range} years ago`;
  }
  const y = (n: number) => (n < 0 ? num(-n) : num(n));
  const era = (n: number) => (n < 0 ? (fr ? 'av. J.-C.' : 'BC') : (fr ? 'apr. J.-C.' : 'AD'));
  if (b == null || b === a) return `${fr ? 'vers ' : 'c. '}${y(a)} ${era(a)}`;
  if ((a < 0) === (b < 0)) return `${y(a)}–${y(b)} ${era(a)}`;
  return `${y(a)} ${era(a)} – ${y(b)} ${era(b)}`;
}

// ── Solar alignments ─────────────────────────────────────────────────────────

/** Earth's obliquity (degrees) for a calendar year; Laskar's polynomial, good to a few hundredths over these spans. */
export function obliquity(year: number): number {
  const T = (year - 2000) / 100;
  return 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;
}

/** Azimuth (degrees from north) where the Sun's upper limb meets a flat sea-level horizon, at declination `dec`.
 * Null when the Sun doesn't rise or set that day (polar day or night). */
export function horizonAzimuth(lat: number, dec: number, rising: boolean): number | null {
  const h = -0.833 * Math.PI / 180;  // refraction plus the Sun's semi-diameter
  const φ = lat * Math.PI / 180, δ = dec * Math.PI / 180;
  const c = (Math.sin(δ) - Math.sin(φ) * Math.sin(h)) / (Math.cos(φ) * Math.cos(h));
  if (c < -1 || c > 1) return null;
  const A = Math.acos(c) * 180 / Math.PI;
  return rising ? A : 360 - A;
}

export interface SolarLine { event: SolarEvent; then: number | null; now: number | null; year: number }

export function prehistorySolar(s: PrehistorySite): SolarLine[] {
  const year = s.when[0];
  return (s.align ?? []).map(event => {
    const sign = event.startsWith('ss') ? 1 : event.startsWith('ws') ? -1 : 0;
    const rising = event.endsWith('rise');
    const az = (y: number) => horizonAzimuth(s.lat, sign * obliquity(y), rising);
    return { event, then: az(year), now: az(new Date().getFullYear()), year };
  });
}

/** A point `km` along a great circle from (lat, lon) at bearing `az`. */
export function destination(lat: number, lon: number, az: number, km: number): [number, number] {
  const R = 6371, d = km / R, θ = az * Math.PI / 180, φ1 = lat * Math.PI / 180, λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [((λ2 * 180 / Math.PI + 540) % 360) - 180, φ2 * 180 / Math.PI];
}
