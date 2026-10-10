/** Interface languages. English strings are the keys; a catalog (fr.json) maps them to the translation, so untranslated
 * text falls back to English instead of a placeholder. `{name}` fills in from vars. A plural entry is an object keyed
 * by Intl.PluralRules category ("one", "other"…), chosen by vars.n.
 *
 * Which language: the person's preference (Settings → General for the owner and inside a guest's own Shell:B, the
 * guest's config on the guest page), "" meaning the browser's language. The server tells the UI in /api/auth/me, so
 * the login screen is already right on the next visit, and the choice is remembered per browser for the first paint. */
import { useSyncExternalStore } from 'react';
import frCatalog from './fr.json';

export type Locale = 'en' | 'fr';
export type LocalePref = Locale | '';
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];
export const AUTO = '' as const;

type Entry = string | { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
const CATALOGS: Partial<Record<Locale, Record<string, Entry>>> = { fr: frCatalog as unknown as Record<string, Entry> };
const KEY = 'shellb.lang';

let current: Locale = 'en';
let pref: LocalePref = AUTO;
const listeners = new Set<() => void>();

function supported(tag: string): Locale | null {
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return LOCALES.some(l => l.id === base) ? (base as Locale) : null;
}

/** The browser's first supported language, or English. */
export function browserLocale(): Locale {
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]);
  for (const tag of tags) { const l = supported(tag || ''); if (l) return l; }
  return 'en';
}

const resolve = (p: LocalePref): Locale => p || browserLocale();

function apply(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  listeners.forEach(f => f());
}

try { pref = (localStorage.getItem(KEY) as LocalePref) || AUTO; } catch { /* private mode */ }
apply(resolve(pref));

/** Set the preference ("" = follow the browser) and switch at once. Remembered per browser so the pre-login screens
 * come up in the right language next time. */
export function setLocalePref(p: LocalePref) {
  pref = p && supported(p) ? (supported(p) as Locale) : AUTO;
  try { pref ? localStorage.setItem(KEY, pref) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  const l = resolve(pref);
  if (l !== current) apply(l);
}
export const getLocalePref = (): LocalePref => pref;
export const getLocale = (): Locale => current;

/** The current locale; the component re-renders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => current);
}

const rules: Partial<Record<Locale, Intl.PluralRules>> = {};
const category = (l: Locale, n: number) => (rules[l] ??= new Intl.PluralRules(l)).select(n) as keyof Exclude<Entry, string>;

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
export const fmtDate = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(ts).toLocaleDateString(current, opts);
export const fmtTime = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }) =>
  new Date(ts).toLocaleTimeString(current, opts);
export const fmtDateTime = (ts: number | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) =>
  new Date(ts).toLocaleString(current, opts);
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(current, opts);
