import { useEffect, useState, type ReactNode } from 'react';
import {
  AppWindow, BookOpen, Box, CalendarDays, CircleCheck, Code, File, FileText, Image, KeyRound, Link2, ListTodo, Music,
  Palette, Search, SquareCode, StickyNote, Telescope, User,
} from 'lucide-react';
import { req } from '../api';

/**
 * "Search everything" for the command palette (Panels.tsx CommandPalette): GET /api/search (server/search.py) finds the
 * owner's Codex entries, follow-ups, Library items, chat /work files, generated media and offline wiki titles, grouped.
 * The palette keeps its own chat-title and chat-message search; these groups render under them with section headers.
 */

export interface SearchItem {
  id: string;
  title: string;
  snippet: string;   // matches marked [[…]], like the chat-message search (<Snippet>)
  hint?: string;
  route: string;     // a #/… hash to open
  kind: string;      // icon kind: note, contact, event, link, snippet, file, secret, follow-up, code, studio, artifact, image, audio, wiki…
  url?: string;
}
export interface SearchGroup { group: string; key: string; items: SearchItem[] }
interface SearchResponse {
  query: string;
  groups: SearchGroup[];
  searched: string[];
  sources: Record<string, { status: string; ms?: number; count?: number }>;
  ms: number;
}

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

/** Debounced, abortable /api/search. While a new query is in flight the previous groups stay up (no flicker). */
export function useEverythingSearch(q: string, open: boolean, limit = 5) {
  const [res, setRes] = useState<{ query: string; groups: SearchGroup[]; searched: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < MIN_QUERY) { setRes(null); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      req<SearchResponse>(`/api/search?q=${encodeURIComponent(term)}&limit=${limit}`, { signal: ctl.signal })
        .then(r => { setRes({ query: term, groups: r.groups, searched: r.searched }); setLoading(false); })
        .catch(() => { if (!ctl.signal.aborted) { setRes({ query: term, groups: [], searched: [] }); setLoading(false); } });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, open, limit]);
  const real = res ? res.groups.reduce((n, g) => n + g.items.filter(i => i.kind !== 'wiki-search').length, 0) : 0;
  return { groups: res?.groups ?? [], searched: res?.searched ?? [], query: res?.query ?? '', loading, empty: !!res && !loading && real === 0 };
}

const ICONS: Record<string, [typeof File, string]> = {
  note: [StickyNote, 'text-amber-400'], contact: [User, 'text-teal-400'], event: [CalendarDays, 'text-orange-400'],
  link: [Link2, 'text-sky-400'], snippet: [SquareCode, 'text-emerald-400'], secret: [KeyRound, 'text-rose-400'],
  'codex-file': [FileText, 'text-indigo-400'],
  'follow-up': [ListTodo, 'text-[var(--accent)]'], 'follow-up-done': [CircleCheck, 'text-emerald-500'],
  code: [Code, 'text-cyan-400'], studio: [Palette, 'text-fuchsia-400'], research: [Telescope, 'text-violet-400'],
  artifact: [AppWindow, 'text-sky-400'], file: [File, 'text-[var(--text-secondary)]'],
  image: [Image, 'text-pink-400'], audio: [Music, 'text-pink-400'], model: [Box, 'text-pink-400'],
  wiki: [BookOpen, 'text-[var(--text-secondary)]'], 'wiki-search': [Search, 'text-[var(--text-muted)]'],
};

export function searchIcon(item: SearchItem): ReactNode {
  // a Codex "file" entry and a chat /work file share a kind name; ids tell them apart
  const key = item.kind === 'file' && item.id.startsWith('codex:') ? 'codex-file' : item.kind;
  const [Icon, tint] = ICONS[key] ?? [FileText, 'text-[var(--text-secondary)]'];
  return <Icon className={`w-4 h-4 ${tint}`} />;
}

/** "notes, contacts, …, chat files and offline wiki titles" for the empty state. */
export function searchedList(searched: string[]): string {
  if (searched.length < 2) return searched.join('');
  return `${searched.slice(0, -1).join(', ')} and ${searched[searched.length - 1]}`;
}
