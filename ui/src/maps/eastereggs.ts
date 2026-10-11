// Easter eggs for Worlds: fictional places hidden at their canonical coordinates. None of them is in a layer or the
// layers panel. You find one by searching for it (or a phrase it's known by), by zooming right in on the spot, where a
// faint marker appears, by asking Atlas to take you there, or with the Konami code (↑↑↓↓←→←→BA), which lights every egg
// up for the session. Found eggs are remembered per browser (FOUND) and stay marked at any zoom from then on.
//
// To add one: an entry in EGGS (with French text), and if it deserves its own card, a branch in EasterEggCard.tsx.
import { getLocale } from '../i18n';

export interface EasterEgg {
  id: string;
  body: string;
  name: string;
  /** where it's from: the work and its year */
  source: string;
  lat: number;
  lon: number;
  /** what the search box shows under the name */
  subtitle: string;
  subtitleFr: string;
  blurb: string;
  blurbFr: string;
  /** search phrases that find it (matched against the whole query, lower-cased, apostrophes dropped) */
  phrases: RegExp;
  /** below this zoom an unfound egg stays hidden */
  revealZoom: number;
  color: string;
  glyph: string;
  /** real ocean depth here, roughly, for the dive view */
  depthM?: number;
}

export const EGGS: EasterEgg[] = [
  {
    id: 'rapture', body: 'earth', name: 'Rapture', source: 'BioShock (2007)',
    lat: 63.0333, lon: -29.9167, depthM: 1700, revealZoom: 8, color: '#e8c06e', glyph: '⚓',
    subtitle: 'The city beneath the sea · 63°2′N 29°55′W', subtitleFr: 'La cité sous la mer · 63°2′N 29°55′O',
    blurb: 'A lighthouse in the mid-Atlantic, south-west of Iceland. Below it, a bathysphere goes down to an Art Deco city on the sea floor.',
    blurbFr: 'Un phare au milieu de l’Atlantique, au sud-ouest de l’Islande. Sous lui, une bathysphère descend vers une cité Art déco posée au fond de la mer.',
    phrases: /^(rapture|bioshock|andrew ryan|would you kindly|no gods or kings|a man chooses|adam and eve|big daddy|little sister|welcome to rapture|beyond the sea)\b/,
  },
  {
    id: 'rlyeh', body: 'earth', name: 'R’lyeh', source: 'H. P. Lovecraft, “The Call of Cthulhu” (1928)',
    lat: -47.15, lon: -126.7167, depthM: 3900, revealZoom: 8, color: '#5eead4', glyph: '✺',
    subtitle: 'The sunken city · 47°9′S 126°43′W', subtitleFr: 'La cité engloutie · 47°9′S 126°43′O',
    blurb: 'In the South Pacific, not far from Point Nemo, the most remote spot on Earth: the corpse-city where dead Cthulhu waits dreaming. In the story, the crew of the Emma watched it rise from the sea in 1925.',
    blurbFr: 'Dans le Pacifique Sud, non loin du point Nemo, le lieu le plus isolé de la Terre : la cité-cadavre où Cthulhu mort attend en rêvant. Dans la nouvelle, l’équipage de l’Emma la vit surgir des flots en 1925.',
    phrases: /^(rlyeh|r lyeh|cthulhu|call of cthulhu|ph.?nglui|fhtagn|lovecraft)\b/,
  },
];

const norm = (q: string) => q.trim().toLowerCase().replace(/[’'‘`]/g, '').replace(/\s+/g, ' ');

/** The eggs a search finds. Needs the whole start of a phrase, so a stray "ra" doesn't spoil the surprise. */
export const searchEggs = (q: string, body: string) => {
  const n = norm(q);
  return n.length < 4 ? [] : EGGS.filter(e => e.body === body && (e.phrases.test(n) || norm(e.name) === n));
};

/** An egg by the name a map card or Atlas uses ("Rapture", "R'lyeh"). */
export const eggByName = (name: string, body: string) => searchEggs(name, body)[0] ?? null;

export const eggSubtitle = (e: EasterEgg) => (getLocale() === 'fr' ? e.subtitleFr : e.subtitle);
export const eggBlurb = (e: EasterEgg) => (getLocale() === 'fr' ? e.blurbFr : e.blurb);

// ── found eggs ────────────────────────────────────────────────────────────
const FOUND = 'shellb.worlds.eggs';
export const EGGS_CHANGED = 'shellb:worlds-eggs';

export function foundEggs(): string[] {
  try { const v = JSON.parse(localStorage.getItem(FOUND) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Mark an egg found. True the first time. */
export function markFound(id: string): boolean {
  const all = foundEggs();
  if (all.includes(id)) return false;
  try { localStorage.setItem(FOUND, JSON.stringify([...all, id])); } catch { /* private mode */ }
  window.dispatchEvent(new Event(EGGS_CHANGED));
  return true;
}

// ── Konami code ───────────────────────────────────────────────────────────
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Calls `fn` when the Konami code is typed outside a text field. Returns the cleanup. */
export function onKonami(fn: () => void): () => void {
  let at = 0;
  const key = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    at = k === KONAMI[at] ? at + 1 : k === KONAMI[0] ? 1 : 0;
    if (at === KONAMI.length) { at = 0; fn(); }
  };
  window.addEventListener('keydown', key);
  return () => window.removeEventListener('keydown', key);
}
