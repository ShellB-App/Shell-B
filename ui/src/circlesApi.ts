import { req } from './api';

/** Circles (server/circles.py): the same calls work in the owner's app, the guest app and a guest's cell; the server
 *  decides who is asking. */

export type NoteKind = 'fact' | 'tip' | 'recommendation' | 'event' | 'place';
export const KIND_LABEL: Record<NoteKind, string> = { fact: 'Fact', tip: 'Tip', recommendation: 'Recommendation', event: 'Event', place: 'Place' };

export interface Person { handle: string; name: string; emoji: string; bio: string }
export interface Member extends Person { role: 'owner' | 'moderator' | 'member'; me: boolean; person?: string; muted?: boolean }

export interface CircleSettings { proposals: boolean; cloud: boolean; expiryDays: number }
export interface Circle {
  id: string; name: string; emoji: string; role: 'owner' | 'moderator' | 'member' | null; members: number; notes: number;
  settings: CircleSettings; recall: boolean;
}

export interface CircleNote {
  id: string; circle: string; circleName: string; circleEmoji: string; author: Person; kind: NoteKind; text: string;
  source: string; status: 'draft' | 'live' | 'hidden'; cloudOk: boolean; created: number; updated: number;
  published: number | null; expires: number | null; endorsements: number; endorsed: boolean; flagged: boolean;
  mine: boolean; canModerate: boolean; link: string; flags?: number;
}

export interface CirclesIndex { circles: Circle[]; me: Person; isOwner: boolean; drafts: CircleNote[]; kinds: NoteKind[] }
export interface CircleDetail extends Omit<Circle, 'members' | 'notes'> { notes: CircleNote[]; members: Member[] }
export interface PersonRow extends Person { person: string; account: string; disabled: boolean; muted: boolean; circles: string[] }

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const circlesApi = {
  index: () => req<CirclesIndex>('/api/circles'),
  circle: (id: string) => req<CircleDetail>(`/api/circles/${id}`),
  note: (id: string) => req<CircleNote>(`/api/circles/notes/${id}`),
  write: (b: { circle: string; text: string; kind: NoteKind; cloudOk?: boolean; until?: string; source?: string; fromMemory?: boolean }) =>
    req<CircleNote>('/api/circles/notes', json('POST', b)),
  edit: (id: string, b: Partial<{ text: string; kind: NoteKind; circle: string; cloudOk: boolean; until: string }>) =>
    req<CircleNote>(`/api/circles/notes/${id}`, json('PATCH', b)),
  publish: (id: string, b: Partial<{ text: string; kind: NoteKind; circle: string; cloudOk: boolean }> = {}) =>
    req<CircleNote>(`/api/circles/notes/${id}/publish`, json('POST', b)),
  remove: (id: string) => req<{ ok: boolean }>(`/api/circles/notes/${id}`, { method: 'DELETE' }),
  endorse: (id: string, on: boolean) => req<CircleNote>(`/api/circles/notes/${id}/endorse`, json('POST', { on })),
  flag: (id: string, reason: string) => req<CircleNote>(`/api/circles/notes/${id}/flag`, json('POST', { reason })),
  moderate: (id: string, status: 'live' | 'hidden') => req<CircleNote>(`/api/circles/notes/${id}/moderate`, json('POST', { status })),
  setRecall: (id: string, recall: boolean) => req<Circle>(`/api/circles/${id}`, json('PATCH', { recall })),
  me: (b: Partial<Person>) => req<Person>('/api/circles/me', json('PUT', b)),
  // owner only
  update: (id: string, b: Partial<{ name: string; emoji: string; settings: Partial<CircleSettings> }>) => req<Circle>(`/api/circles/${id}`, json('PATCH', b)),
  create: (name: string, emoji: string) => req<Circle>('/api/circles/admin/circles', json('POST', { name, emoji })),
  destroy: (id: string) => req<{ ok: boolean }>(`/api/circles/${id}`, { method: 'DELETE' }),
  people: () => req<{ people: PersonRow[] }>('/api/circles/admin/people'),
  setPerson: (person: string, b: { circles?: string[]; muted?: boolean }) => req<PersonRow>(`/api/circles/admin/people/${person}`, json('PUT', b)),
  setRole: (circle: string, person: string, role: 'member' | 'moderator' | null) =>
    req<{ members: Member[] }>(`/api/circles/admin/circles/${circle}/members/${person}`, json('PUT', { role })),
  // pins: this Shell:B's own (a chat or project tied to one circle)
  pins: () => req<Record<string, string>>('/api/circle-pins'),
  pin: (kind: 'c' | 'p' | 'g', ref: string, circle: string | null) => req<Record<string, string>>(`/api/circle-pins/${kind}/${ref}`, json('PUT', { circle })),
};

/** "3 days ago" for a unix-seconds timestamp. */
export function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h ago`;
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30)} months ago`;
}

/** Strip the leading status code our `req` puts on errors ("400: That looks like a password…"). */
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^\d{3}:\s*/, '');
