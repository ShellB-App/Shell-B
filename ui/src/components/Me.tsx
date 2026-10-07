import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Brain, Briefcase, Cake, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, FolderKanban, Heart, Loader2, Lock, LockOpen,
  MapPin, MessageSquare, Pin, PinOff, Plus, RefreshCw, Repeat, Search, SlidersHorizontal, Sparkles, StickyNote, Trash2, UserRound, X,
} from 'lucide-react';
import { req } from '../api';
import { btn, relTime } from './common';
import type { MemoryRow } from './MemoryManager';

// Me (#/codex/me, server/me.py): everything Shell:B knows about the owner on one page. A view over Memory, Codex
// contacts and calendar, follow-ups and past chats; edits go straight back to /api/memory.

interface Person {
  id: string; name: string; role: string; company: string; location: string; email: string; phone: string; notes: string;
  aka: string[]; circle: string; memories: string[]; birthday: string | null; nextBirthday: string | null; turns: number | null; inMemory: boolean;
}
interface Upcoming {
  kind: 'event' | 'birthday' | 'followup'; id: string; title: string; date: string; time: string; detail: string;
  yearly: boolean; overdue?: boolean; convId?: string | null;
}
interface MeData {
  owner: string | null; today: string; age: number | null;
  portrait: { text: string; at: number; stale: boolean; writing: boolean; error: string };
  memories: MemoryRow[];
  categories: { id: string; label: string; core: boolean }[];
  people: Person[]; loosePeople: string[];
  circles: { id: string; label: string }[];
  upcoming: Upcoming[];
  timeline: { month: string; learned: string[]; changed: string[]; chats: number }[];
  recent: { id: string; title: string; summary: string; at: number }[];
  stats: { since: number | null; chats: number; memories: number; people: number; pending: number };
}

const J = (body: unknown) => JSON.stringify(body);
const me = {
  get: () => req<MeData>('/api/me'),
  portrait: () => req<{ writing: boolean }>('/api/me/portrait', { method: 'POST' }),
  add: (text: string, category: string) => req<unknown>('/api/memory', { method: 'POST', body: J({ text, category }) }),
  patch: (id: string, b: Partial<{ text: string; pinned: boolean; localOnly: boolean }>) =>
    req<unknown>(`/api/memory/${id}`, { method: 'PATCH', body: J(b) }),
  forget: (id: string) => req<unknown>(`/api/memory/${id}/forget`, { method: 'POST' }),
};

// Facts about the owner, in reading order. People are their own section below.
const SECTIONS: { id: string; title: string; icon: typeof Brain; empty: string }[] = [
  { id: 'identity', title: 'About you', icon: UserRound, empty: 'Where you’re from, where you live, what you go by' },
  { id: 'work', title: 'Work', icon: Briefcase, empty: 'Your job, skills, what you’re building' },
  { id: 'preference', title: 'How you like things', icon: SlidersHorizontal, empty: 'How answers should read, likes and dislikes' },
  { id: 'project', title: 'Projects', icon: FolderKanban, empty: 'Things you’re working on' },
  { id: 'interest', title: 'Interests', icon: Sparkles, empty: 'Hobbies, topics you love, what you read or watch' },
  { id: 'routine', title: 'Routines', icon: Repeat, empty: 'Your week, habits, when you work best' },
  { id: 'other', title: 'Other', icon: StickyNote, empty: 'Anything else worth knowing' },
];

const CIRCLE_TINT: Record<string, string> = {
  family: 'from-rose-500 to-pink-500', friends: 'from-sky-500 to-cyan-500', pets: 'from-amber-500 to-orange-500',
  work: 'from-indigo-500 to-violet-500', others: 'from-slate-500 to-slate-600',
};

const d0 = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const daysUntil = (iso: string, today: string) => Math.round((d0(iso).getTime() - d0(today).getTime()) / 86_400_000);
const whenLabel = (iso: string, today: string) => {
  if (!iso) return 'No date';
  const n = daysUntil(iso, today);
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 7) return d0(iso).toLocaleDateString(undefined, { weekday: 'long' });
  return d0(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(n > 300 ? { year: 'numeric' } : {}) });
};
const monthLabel = (ym: string) => d0(`${ym}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const initials = (name: string) => name.replace(/["“”']/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

export function Me() {
  const [data, setData] = useState<MeData | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => me.get().then(d => { setData(d); setErr(''); }).catch(e => setErr(String(e))), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {  // follow the portrait while the local model writes it
    if (!data?.portrait.writing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [data?.portrait.writing, load]);

  const act = useCallback(async (p: Promise<unknown>) => {
    try { await p; await load(); } catch (e) { setErr(String(e).replace(/^Error: \d+: /, '')); }
  }, [load]);

  const byId = useMemo(() => new Map((data?.memories ?? []).map(m => [m.id, m])), [data]);
  if (!data) return <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">{err || 'Loading…'}</div>;
  const active = data.memories.filter(m => m.status === 'active');
  const name = data.owner ?? 'You';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
        <Hero data={data} name={name} onRewrite={() => act(me.portrait())} />
        {err && <div className="text-xs text-red-400">{err}</div>}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {SECTIONS.map(s => {
                const items = active.filter(m => m.category === s.id);
                const core = data.categories.find(c => c.id === s.id)?.core;
                if (!items.length && !core) return null;
                return <FactCard key={s.id} section={s} items={items} core={!!core} onAct={act} />;
              })}
            </div>
            <MissingRow active={active} onAct={act} />
          </div>
          <div className="space-y-4">
            <ComingUp items={data.upcoming} today={data.today} />
            <Lately items={data.recent} />
          </div>
        </div>

        <People data={data} byId={byId} onAct={act} />
        <Timeline data={data} byId={byId} />
      </div>
    </div>
  );
}

// ── hero ────────────────────────────────────────────────────────────────────

function Hero({ data, name, onRewrite }: { data: MeData; name: string; onRewrite: () => void }) {
  const s = data.stats;
  const p = data.portrait;
  const bits = [
    data.age != null && `${data.age}`,
    s.since && `known since ${new Date(s.since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`,
    `${s.chats} chat${s.chats === 1 ? '' : 's'}`, `${s.memories} memories`, `${s.people} people`,
  ].filter(Boolean);
  return (
    <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 md:p-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-rose-500 text-white flex items-center justify-center text-xl font-semibold shrink-0">
          {data.owner ? initials(data.owner) : <UserRound className="w-7 h-7" />}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">{bits.join(' · ')}</div>
        </div>
        <div className="flex items-center gap-2 basis-full sm:basis-auto">
          {s.pending > 0 && (
            <a href="#/memory" className={clsx(btn.subtle, 'text-amber-400 border-amber-500/30')}>
              <Sparkles className="w-3.5 h-3.5" />{s.pending} to review
            </a>
          )}
          <a href="#/memory" className={btn.subtle}><Brain className="w-3.5 h-3.5" />Manage memory</a>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">How Shell:B sees you</span>
          <span className="flex-1" />
          <span className="text-[10px] text-[var(--text-muted)]">
            {p.writing ? 'Rewriting…' : p.at ? `Written ${relTime(p.at)}` : ''}
          </span>
          <button className={btn.icon} title="Rewrite from what Shell:B knows now" disabled={p.writing} onClick={onRewrite}>
            {p.writing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
        {p.text ? (
          <p className={clsx('text-[15px] leading-relaxed max-w-[75ch] text-[var(--text-primary)]', p.writing && 'opacity-60')}>{p.text}</p>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            {p.writing ? 'Shell:B is writing a short portrait from what it knows about you…' : data.stats.memories ? 'No portrait yet.' : 'Tell Shell:B about yourself and a portrait will appear here.'}
          </p>
        )}
        {p.error && <div className="mt-1 text-[11px] text-red-400">{p.error}</div>}
        <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">Written by your local model from the facts below. Fix a fact and it rewrites itself.</div>
      </div>
    </section>
  );
}

// ── facts ───────────────────────────────────────────────────────────────────

type Act = (p: Promise<unknown>) => Promise<void>;

function FactCard({ section, items, core, onAct }: { section: typeof SECTIONS[number]; items: MemoryRow[]; core: boolean; onAct: Act }) {
  const [adding, setAdding] = useState(false);
  const Icon = section.icon;
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3.5 flex flex-col">
      <header className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-medium">{section.title}</h2>
        {core && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]" title="Shell:B has this in every conversation">always known</span>}
        <span className="flex-1" />
        <button className={btn.icon} title={`Add to ${section.title}`} onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" /></button>
      </header>
      <ul className="space-y-0.5">
        {items.map(m => <Fact key={m.id} m={m} onAct={onAct} />)}
      </ul>
      {!items.length && !adding && <div className="text-xs text-[var(--text-muted)] py-1">{section.empty}.</div>}
      {adding && <AddFact category={section.id} placeholder={section.empty} onAct={onAct} onClose={() => setAdding(false)} />}
    </section>
  );
}

function Fact({ m, onAct, compact }: { m: MemoryRow; onAct: Act; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(m.text); }, [m.text]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const save = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== m.text) onAct(me.patch(m.id, { text: t })); else setDraft(m.text);
  };
  return (
    <li className="group flex items-start gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--bg-hover)]/50">
      <span className="mt-[7px] w-1 h-1 rounded-full bg-amber-400/70 shrink-0" />
      <div className="flex-1 min-w-0">
        {editing ? (
          <textarea ref={ref} rows={2} className={clsx(btn.input, 'resize-none text-[13px]')} value={draft} onChange={e => setDraft(e.target.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { setDraft(m.text); setEditing(false); } }} />
        ) : (
          <div className={clsx('cursor-text leading-snug', compact ? 'text-xs text-[var(--text-secondary)]' : 'text-[13px]')} title="Click to correct" onClick={() => setEditing(true)}>
            {m.text}
          </div>
        )}
      </div>
      <span className="shrink-0 hidden items-center group-hover:flex focus-within:flex">
        {m.source && <a href={`#/c/${m.source}`} className={btn.icon} title="Open the chat it came from"><MessageSquare className="w-3 h-3" /></a>}
        {!m.core || m.pinned ? (
          <button className={btn.icon} title={m.pinned ? 'Recall only when relevant' : 'Always know this'} onClick={() => onAct(me.patch(m.id, { pinned: !m.pinned }))}>
            {m.pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
          </button>
        ) : null}
        <button className={btn.icon} title={m.localOnly ? 'Local only. Click to allow cloud agents' : 'Keep local: never send to cloud agents'}
          onClick={() => onAct(me.patch(m.id, { localOnly: !m.localOnly }))}>
          {m.localOnly ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
        </button>
        <button className={clsx(btn.icon, 'hover:text-red-400')} title="Forget (restore it in Manage memory)" onClick={() => onAct(me.forget(m.id))}>
          <Trash2 className="w-3 h-3" />
        </button>
      </span>
      {(m.localOnly || m.pinned) && (
        <span className="shrink-0 mt-1 flex gap-0.5 text-[var(--accent)] group-hover:hidden">
          {m.pinned && <Pin className="w-3 h-3" />}{m.localOnly && <Lock className="w-3 h-3" />}
        </span>
      )}
    </li>
  );
}

function AddFact({ category, placeholder, onAct, onClose }: { category: string; placeholder: string; onAct: Act; onClose: () => void }) {
  const [text, setText] = useState('');
  const submit = async () => { if (text.trim()) { await onAct(me.add(text.trim(), category)); setText(''); onClose(); } };
  return (
    <div className="flex gap-1.5 mt-1.5">
      <input autoFocus className={clsx(btn.input, 'text-[13px] py-1')} value={text} placeholder={`${placeholder}…`} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }} />
      <button className={btn.icon} title="Cancel" onClick={onClose}><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

/** Categories Shell:B knows nothing about yet, as one-click prompts instead of empty cards. */
function MissingRow({ active, onAct }: { active: MemoryRow[]; onAct: Act }) {
  const [open, setOpen] = useState<string | null>(null);
  const missing = SECTIONS.filter(s => !['identity', 'work', 'preference'].includes(s.id) && !active.some(m => m.category === s.id));
  if (!missing.length) return null;
  const cur = missing.find(s => s.id === open);
  return (
    <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-[var(--text-muted)] mr-1">Shell:B doesn’t know about your</span>
        {missing.map(s => (
          <button key={s.id} onClick={() => setOpen(o => (o === s.id ? null : s.id))}
            className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full border transition',
              open === s.id ? 'border-amber-500/50 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
            <s.icon className="w-3 h-3" />{s.title.toLowerCase()}
          </button>
        ))}
      </div>
      {cur && <AddFact category={cur.id} placeholder={cur.empty} onAct={onAct} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── side column ─────────────────────────────────────────────────────────────

function ComingUp({ items, today }: { items: Upcoming[]; today: string }) {
  const icon = (u: Upcoming) => (u.kind === 'birthday' ? <Cake className="w-3.5 h-3.5 text-rose-400" />
    : u.kind === 'event' ? <CalendarDays className="w-3.5 h-3.5 text-orange-400" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />);
  const href = (u: Upcoming) => (u.kind === 'followup' ? (u.convId ? `#/c/${u.convId}` : '#/activity') : u.id === 'me' ? undefined : `#/codex/e/${u.id}`);
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3.5">
      <h2 className="text-sm font-medium mb-2">Coming up</h2>
      {!items.length && <div className="text-xs text-[var(--text-muted)]">Nothing in the next few weeks. Birthdays from Contacts, Calendar events and your follow-ups show up here.</div>}
      <ul className="space-y-1">
        {items.slice(0, 10).map(u => {
          const h = href(u);
          const body = (
            <>
              <span className="mt-0.5 shrink-0">{icon(u)}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] leading-snug">{u.title}</span>
                <span className={clsx('block text-[11px]', u.overdue ? 'text-red-400' : 'text-[var(--text-muted)]')}>
                  {whenLabel(u.date, today)}{u.time && ` · ${u.time}`}{u.detail && ` · ${u.detail}`}
                </span>
              </span>
            </>
          );
          return (
            <li key={`${u.kind}-${u.id}-${u.date}`}>
              {h ? <a href={h} className="flex items-start gap-2 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--bg-hover)]/50">{body}</a>
                : <div className="flex items-start gap-2 px-1.5 py-1 -mx-1.5">{body}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Lately({ items }: { items: MeData['recent'] }) {
  if (!items.length) return null;
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3.5">
      <h2 className="text-sm font-medium mb-2">Lately we talked about</h2>
      <ul className="space-y-2">
        {items.slice(0, 4).map(c => (
          <li key={c.id}>
            <a href={`#/c/${c.id}`} className="block rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--bg-hover)]/50">
              <span className="flex items-baseline gap-2">
                <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{c.title}</span>
                <span className="text-[10px] text-[var(--text-muted)] shrink-0">{relTime(c.at)}</span>
              </span>
              <span className="text-[11px] text-[var(--text-muted)] line-clamp-2">{c.summary}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── people ──────────────────────────────────────────────────────────────────

function People({ data, byId, onAct }: { data: MeData; byId: Map<string, MemoryRow>; onAct: Act }) {
  const [circle, setCircle] = useState('all');
  const [q, setQ] = useState('');
  const counts = useMemo(() => Object.fromEntries(data.circles.map(c => [c.id, data.people.filter(p => p.circle === c.id).length])), [data]);
  const shown = data.people.filter(p => (circle === 'all' || p.circle === circle)
    && (!q || `${p.name} ${p.role} ${p.company} ${p.location}`.toLowerCase().includes(q.toLowerCase())));
  const groups = data.circles.map(c => ({ c, people: shown.filter(p => p.circle === c.id) })).filter(g => g.people.length);
  const loose = data.loosePeople.map(id => byId.get(id)).filter((m): m is MemoryRow => !!m);
  const chip = (id: string, label: string, n: number) => (
    <button key={id} onClick={() => setCircle(id)}
      className={clsx('px-2.5 py-1 rounded-full text-xs border transition', circle === id ? 'bg-[var(--bg-hover)] border-[var(--border-subtle)] text-[var(--text-primary)] font-medium' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
      {label} <span className="text-[var(--text-muted)]">{n}</span>
    </button>
  );
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Heart className="w-4 h-4 text-rose-400" />
        <h2 className="text-base font-semibold">People in your life</h2>
        <span className="flex-1" />
        <div className="relative w-48">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input className={clsx(btn.input, 'pl-8 py-1 text-xs')} value={q} onChange={e => setQ(e.target.value)} placeholder="Find someone" />
        </div>
        <a href="#/codex/contacts" className={btn.ghost}>All contacts</a>
      </div>
      <div className="flex flex-wrap gap-1">
        {chip('all', 'Everyone', data.people.length)}
        {data.circles.filter(c => counts[c.id]).map(c => chip(c.id, c.label, counts[c.id]))}
      </div>
      {!data.people.length && <div className="text-xs text-[var(--text-muted)]">No contacts yet. People you mention in chats are added to <a className="underline" href="#/codex/contacts">Contacts</a>.</div>}
      {groups.map(({ c, people }) => (
        <div key={c.id} className="space-y-2">
          {circle === 'all' && <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{c.label}</div>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {people.map(p => <PersonCard key={p.id} p={p} today={data.today} facts={p.memories.map(id => byId.get(id)).filter((m): m is MemoryRow => !!m)} onAct={onAct} />)}
          </div>
        </div>
      ))}
      {loose.length > 0 && circle === 'all' && !q && (
        <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">Also mentioned</div>
          <ul className="space-y-0.5">{loose.map(m => <Fact key={m.id} m={m} onAct={onAct} />)}</ul>
        </div>
      )}
    </section>
  );
}

function PersonCard({ p, facts, today, onAct }: { p: Person; facts: MemoryRow[]; today: string; onAct: Act }) {
  const [more, setMore] = useState(false);
  const sub = [p.role, p.company].filter(Boolean).join(' · ');
  const bday = p.birthday && /^\d{4}-|^-?-?\d{1,2}-\d{1,2}/.test(p.birthday)
    ? d0(p.birthday.length >= 10 ? p.birthday : `2000-${p.birthday.replace(/^-+/, '')}`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : null;
  const n = p.nextBirthday ? daysUntil(p.nextBirthday, today) : null;
  const shown = more ? facts : facts.slice(0, 3);
  return (
    <div className={clsx('rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 flex flex-col', p.inMemory && 'opacity-80')}>
      <div className="flex items-start gap-2.5">
        <div className={clsx('w-9 h-9 rounded-full bg-gradient-to-br text-white text-xs font-semibold flex items-center justify-center shrink-0', CIRCLE_TINT[p.circle] ?? CIRCLE_TINT.others, p.inMemory && 'grayscale')}>
          {initials(p.name) || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <a href={`#/codex/e/${p.id}`} className="block text-sm font-medium truncate hover:underline" title="Open in Contacts">{p.name}</a>
          {p.aka.length > 0 && <div className="text-[11px] text-[var(--text-muted)] truncate">“{p.aka.join('”, “')}”</div>}
          {sub && <div className="text-[11px] text-[var(--text-secondary)] truncate">{sub}</div>}
        </div>
      </div>
      <div className="mt-2 space-y-0.5 text-[11px] text-[var(--text-muted)]">
        {p.inMemory ? (
          <div className="flex items-center gap-1"><Heart className="w-3 h-3" />In memory{bday && ` · born ${bday}`}</div>
        ) : bday && (
          <div className={clsx('flex items-center gap-1', n != null && n <= 14 && 'text-rose-400')}>
            <Cake className="w-3 h-3" />{bday}{p.turns != null && n != null && ` · turns ${p.turns} ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}`}
          </div>
        )}
        {p.location && <div className="flex items-center gap-1 truncate"><MapPin className="w-3 h-3 shrink-0" /><span className="truncate">{p.location}</span></div>}
      </div>
      {facts.length > 0 && (
        <ul className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-0.5">
          {shown.map(m => <Fact key={m.id} m={m} onAct={onAct} compact />)}
        </ul>
      )}
      {facts.length > 3 && (
        <button className="mt-1 self-start text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setMore(v => !v)}>
          {more ? 'Show less' : `${facts.length - 3} more`}
        </button>
      )}
    </div>
  );
}

// ── over time ───────────────────────────────────────────────────────────────

function Timeline({ data, byId }: { data: MeData; byId: Map<string, MemoryRow> }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data.timeline.length) return null;
  return (
    <section className="space-y-2 pb-6">
      <h2 className="text-base font-semibold">How Shell:B got to know you</h2>
      <ol className="relative border-l border-[var(--border-subtle)] ml-1.5 space-y-1">
        {data.timeline.map(t => {
          const learned = t.learned.map(id => byId.get(id)).filter((m): m is MemoryRow => !!m);
          const isOpen = open === t.month;
          return (
            <li key={t.month} className="pl-4 relative">
              <span className="absolute -left-[5px] top-2.5 w-2.5 h-2.5 rounded-full bg-amber-400/80 ring-4 ring-[var(--bg-primary)]" />
              <button className="w-full text-left flex flex-wrap items-baseline gap-x-2 py-1.5" onClick={() => setOpen(isOpen ? null : t.month)}>
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 self-center" /> : <ChevronRight className="w-3.5 h-3.5 self-center" />}
                <span className="text-sm font-medium">{monthLabel(t.month)}</span>
                <span className="text-xs text-[var(--text-muted)]">
                  {[t.learned.length && `${t.learned.length} learned`, t.changed.length && `${t.changed.length} corrected or forgotten`,
                    t.chats && `${t.chats} chat${t.chats === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'quiet'}
                </span>
              </button>
              {isOpen && (
                <ul className="pb-2 pl-5 space-y-0.5">
                  {learned.map(m => (
                    <li key={m.id} className={clsx('text-xs flex gap-2', m.status === 'retired' ? 'text-[var(--text-muted)] line-through decoration-[var(--text-muted)]/50' : 'text-[var(--text-secondary)]')}>
                      <span className="shrink-0 w-12 text-[var(--text-muted)] no-underline">{new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      <span>{m.text}</span>
                    </li>
                  ))}
                  {!learned.length && <li className="text-xs text-[var(--text-muted)]">Nothing new learned this month.</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
