/** Interface languages. English strings are the keys; catalogs map them to the translation, so untranslated
 * text falls back to English instead of a placeholder. `{name}` fills in from vars. A plural entry is an object keyed
 * by Intl.PluralRules category ("one", "other"…), chosen by vars.n.
 *
 * Which language: the person's preference (Settings → General for the owner and inside a guest's own Shell:B, the
 * guest's config on the guest page), "" meaning the browser's language. The server tells the UI in /api/auth/me, so
 * the login screen is already right on the next visit, and the choice is remembered per browser for the first paint.
 * Catalogues for other languages are loaded dynamically on demand from /api/translate/catalogue/:code (falling back
 * to https://raw.githubusercontent.com/ShellB-App/Shell-B-Translations/main/locales/:code.json) and cached locally. */
import { useSyncExternalStore } from 'react';
import frCatalog from './fr.json';

export type KnownLocale =
  | 'en'
  | 'fr'
  | 'gd'
  | 'ga'
  | 'cy'
  | 'gv'
  | 'kw'
  | 'br'
  | 'eu'
  | 'rm'
  | 'liv'
  | 'smn'
  | 'es'
  | 'ja'
  | 'uk'
  | 'sr'
  | 'sr-Latn'
  | 'la'
  | 'grc'
  | 'ang'
  | 'non'
  | 'eo'
  | 'tlh'
  | 'sjn'
  | 'val'
  | 'en-pirate';
export type Locale = KnownLocale;
export type LocalePref = Locale | '';

export type LocaleCategory = 'living' | 'dead' | 'fictional';

export interface LocaleMeta {
  id: Locale;
  name: string;
  flag?: string;
  category?: LocaleCategory;
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', name: 'English', flag: '🇬🇧', category: 'living' },
  { id: 'fr', name: 'Français', flag: '🇫🇷', category: 'living' },
  // Celtic & Endangered / Minority Languages
  { id: 'gd', name: 'Gàidhlig', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', category: 'living' },
  { id: 'ga', name: 'Gaeilge', flag: '🇮🇪', category: 'living' },
  { id: 'cy', name: 'Cymraeg', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿', category: 'living' },
  { id: 'gv', name: 'Gaelg', flag: '🇮🇲', category: 'living' },
  { id: 'kw', name: 'Kernewek', flag: '⬛', category: 'living' },
  { id: 'br', name: 'Brezhoneg', flag: '🏴', category: 'living' },
  { id: 'eu', name: 'Euskara', flag: '🟩', category: 'living' },
  { id: 'rm', name: 'Rumantsch', flag: '🇨🇭', category: 'living' },
  { id: 'liv', name: 'Līvõ kēļ', flag: '🇱🇻', category: 'living' },
  { id: 'smn', name: 'Anarâškielâ', flag: '🇫🇮', category: 'living' },
  // World Languages
  { id: 'es', name: 'Español', flag: '🇪🇸', category: 'living' },
  { id: 'ja', name: '日本語', flag: '🇯🇵', category: 'living' },
  { id: 'uk', name: 'Українська', flag: '🇺🇦', category: 'living' },
  { id: 'sr', name: 'Српски', flag: '🇷🇸', category: 'living' },
  { id: 'sr-Latn', name: 'Srpski', flag: '🇷🇸', category: 'living' },
  // Classical & Dead Languages
  { id: 'la', name: 'Latina', flag: '🏛️', category: 'dead' },
  { id: 'grc', name: 'Ἑλληνική', flag: '🏺', category: 'dead' },
  { id: 'ang', name: 'Ænglisc', flag: '📜', category: 'dead' },
  { id: 'non', name: 'Norrœnt mál', flag: 'ᚱ', category: 'dead' },
  // Fictional & Constructed Languages
  { id: 'eo', name: 'Esperanto', flag: '🟢', category: 'fictional' },
  { id: 'tlh', name: 'tlhIngan Hol', flag: '⚔️', category: 'fictional' },
  { id: 'sjn', name: 'Sindarin', flag: '🍃', category: 'fictional' },
  { id: 'val', name: 'Valyrio Eglie', flag: '🐉', category: 'fictional' },
  { id: 'en-pirate', name: 'Pirate Speak', flag: '🏴‍☠️', category: 'fictional' },
];
export const AUTO = '' as const;

type Entry = string | { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
const CATALOGS: Partial<Record<string, Record<string, Entry>>> = { fr: frCatalog as unknown as Record<string, Entry> };
const KEY = 'shellb.lang';
const CATALOG_STORAGE_PREFIX = 'shellb.catalog.';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/ShellB-App/Shell-B-Translations/main/locales/';
const pendingLoads = new Map<string, Promise<boolean>>();

let current: Locale = 'en';
let pref: LocalePref = AUTO;
const listeners = new Set<() => void>();

function supported(tag: string): Locale | null {
  if (!tag) return null;
  const exact = LOCALES.find(l => l.id.toLowerCase() === tag.toLowerCase());
  if (exact) return exact.id;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  const byBase = LOCALES.find(l => l.id.toLowerCase() === base);
  return byBase ? byBase.id : null;
}

/** The browser's first supported language, or English. */
export function browserLocale(): Locale {
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const tag of tags) { const l = supported(tag || ''); if (l) return l; }
  return 'en';
}

const resolve = (p: LocalePref): Locale => p || browserLocale();

function getCachedCatalog(code: string): Record<string, Entry> | null {
  try {
    const raw = localStorage.getItem(CATALOG_STORAGE_PREFIX + code);
    if (raw) return JSON.parse(raw);
  } catch {
    /* private mode or json parse error */
  }
  return null;
}

function setCachedCatalog(code: string, catalog: Record<string, Entry>) {
  try {
    localStorage.setItem(CATALOG_STORAGE_PREFIX + code, JSON.stringify(catalog));
  } catch {
    /* quota exceeded or private mode */
  }
}

/** Fetch a catalogue: this Shell:B first (Shell-B-Translations next to it), then the community repo on GitHub. */
async function fetchCatalogue(code: string): Promise<Record<string, Entry> | null> {
  for (const url of [`/api/translate/catalogue/${encodeURIComponent(code)}`, `${GITHUB_RAW_BASE}${encodeURIComponent(code)}.json`]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, Entry>;
    } catch { /* offline, or not served here: try the next */ }
  }
  return null;
}

/** Load a catalogue on demand. A copy cached in this browser is used at once (first paint) and refreshed in the
 * background, so new translations show from the next reload instead of never. */
export async function loadCatalogue(code: Locale): Promise<boolean> {
  if (!code || code === 'en') return true;
  if (CATALOGS[code]) return true;
  const existing = pendingLoads.get(code);
  if (existing) return existing;

  const fresh = fetchCatalogue(code).then(data => {
    if (data) {
      CATALOGS[code] = data;
      setCachedCatalog(code, data);
    }
    return Boolean(CATALOGS[code]);
  }).finally(() => pendingLoads.delete(code));
  pendingLoads.set(code, fresh);

  const cached = getCachedCatalog(code);
  if (cached) {
    CATALOGS[code] = cached;
    return true;
  }
  return fresh;
}

function apply(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  listeners.forEach(f => f());
}

try { pref = (localStorage.getItem(KEY) as LocalePref) || AUTO; } catch { /* private mode */ }
const initial = resolve(pref);
apply('en');
if (initial !== 'en') {
  const loaded = loadCatalogue(initial);  // sets a cached copy synchronously and refreshes it in the background
  if (CATALOGS[initial]) apply(initial);
  else loaded.then(ok => { if (ok && resolve(pref) === initial) apply(initial); });
}

/** Set the preference ("" = follow the browser) and switch at once. Remembered per browser so the pre-login screens
 * come up in the right language next time. */
export function setLocalePref(p: LocalePref) {
  pref = p && supported(p) ? (supported(p) as Locale) : AUTO;
  try { pref ? localStorage.setItem(KEY, pref) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  const l = resolve(pref);
  if (l === 'en' || CATALOGS[l]) {
    if (l !== current) apply(l);
    return;
  }
  loadCatalogue(l).then(ok => { if (ok && resolve(pref) === l) apply(l); });
}
export const getLocalePref = (): LocalePref => pref;
export const getLocale = (): Locale => current;

/** The current locale; the component re-renders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => current);
}

const rules: Partial<Record<string, Intl.PluralRules>> = {};
const category = (l: string, n: number) => {
  try {
    return (rules[l] ??= new Intl.PluralRules(l)).select(n) as keyof Exclude<Entry, string>;
  } catch {
    return (rules['en'] ??= new Intl.PluralRules('en')).select(n) as keyof Exclude<Entry, string>;
  }
};

type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** Translate an English source string: t('New chat'), t('Hi {name}.', { name }). */
export function t(key: string, vars?: Vars): string {
  const e = CATALOGS[current]?.[key];
  if (e === undefined) return fill(key, vars);
  if (typeof e === 'string') return fill(e, vars);
  const n = typeof vars?.n === 'number' ? vars.n : Number(vars?.n ?? 1);
  const form = (n === 0 && e.zero) || e[category(current, n)] || e.other;
  return fill(form, vars);
}

/** A count in the English source: tn(n, '{n} chat', '{n} chats'). The catalog keys on the plural form. */
export function tn(n: number, one: string, other: string, vars: Vars = {}): string {
  const v = { n, ...vars };
  if (CATALOGS[current]?.[other] === undefined) return fill(n === 1 ? one : other, v);
  return t(other, v);
}

/** Dates and times in the interface language. */
export const fmtDate = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => {
  try { return new Date(ts).toLocaleDateString(current, opts); } catch { return new Date(ts).toLocaleDateString('en', opts); }
};
export const fmtTime = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }) => {
  try { return new Date(ts).toLocaleTimeString(current, opts); } catch { return new Date(ts).toLocaleTimeString('en', opts); }
};
export const fmtDateTime = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) => {
  try { return new Date(ts).toLocaleString(current, opts); } catch { return new Date(ts).toLocaleString('en', opts); }
};
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => {
  try { return n.toLocaleString(current, opts); } catch { return n.toLocaleString('en', opts); }
};
