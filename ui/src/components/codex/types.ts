import {
  Calendar, Code2, File as FileIcon, KeyRound, Link2, StickyNote, User
} from 'lucide-react';
import type { CodexEntry, CodexIndex, CodexKind } from '../../types';

export const KIND: Record<CodexKind, { label: string; plural: string; icon: typeof StickyNote; color: string }> = {
  note: { label: 'Note', plural: 'Notes', icon: StickyNote, color: 'text-amber-400' },
  link: { label: 'Link', plural: 'Links', icon: Link2, color: 'text-sky-400' },
  snippet: { label: 'Snippet', plural: 'Snippets', icon: Code2, color: 'text-emerald-400' },
  file: { label: 'File', plural: 'Files', icon: FileIcon, color: 'text-violet-400' },
  secret: { label: 'Secret', plural: 'Secrets', icon: KeyRound, color: 'text-rose-400' },
  contact: { label: 'Contact', plural: 'Contacts', icon: User, color: 'text-teal-400' },
  event: { label: 'Event', plural: 'Events', icon: Calendar, color: 'text-orange-400' },
};

/** `#/codex/<sub>`: '' (everything), drafts, pinned, unfiled, contacts, calendar, events, c/<collection id>, e/<entry id>. */
export function parseCodexRoute(sub: string) {
  const [a, b] = sub.split('/');
  if (a === 'c' && b) return { view: 'collection' as const, collection: b };
  if (a === 'e' && b) return { view: 'all' as const, entry: b };
  if (a === 'drafts' || a === 'pinned' || a === 'unfiled' || a === 'contacts' || a === 'calendar' || a === 'events' || a === 'secrets') {
    return { view: a as 'drafts' | 'pinned' | 'unfiled' | 'contacts' | 'calendar' | 'events' | 'secrets' };
  }
  return { view: 'all' as const };
}

export type Draft = Partial<CodexEntry> & { body?: string; kind: CodexKind };

export const busyIndex = (e: CodexEntry) =>
  e.meta.index === 'pending' || e.meta.index === 'indexing' || e.meta.snapshot?.status === 'pending';

export const who = (e: CodexEntry, names: Record<string, string>) =>
  (e.createdBy.startsWith('agent:') ? names[e.createdBy.slice(6)] ?? 'an agent'
    : e.meta.shelf && e.createdBy !== 'you' ? e.createdBy : 'you');  // a shelf item is credited to its author

export const ownerOnly = (err: unknown) => {
  const t = String(err).replace(/^Error: \d+: /, '');
  return t.startsWith('Only the signed-in owner') ? `${t} Opening Shell:B on this machine without signing in doesn't count.` : t;
};
