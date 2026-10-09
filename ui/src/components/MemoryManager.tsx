import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  BookMarked, Brain, Check, ChevronDown, ChevronRight, Eye, History, Loader2, Lock, LockOpen, Moon, MessageSquare, Pencil, Pin, PinOff, Plus, RotateCcw, Search,
  Sparkles, Trash2, Undo2, UsersRound, X,
} from 'lucide-react';
import { api, req } from '../api';
import type { LearnedItem, Message, RecalledMemory } from '../types';
import { btn, relTime } from './common';
import { BriefSettingsRow } from './FollowUps';
import { IncognitoSettingsRow } from './Incognito';
import { HistoryImport } from './HistoryImport';
import { ShareToCircle } from './CircleCards';

// Long-term memory v2 (server/memory.py): the Settings → Memory tab and the "learned" note under chat replies.

export interface MemoryRow {
  id: string; text: string; tags: string[]; createdAt: number; updatedAt: number;
  category: string; status: 'active' | 'pending' | 'retired'; pinned: boolean; core: boolean;
  origin: 'user' | 'agent' | 'auto' | 'history' | 'feedback' | 'reflection'; source: string | null; expires: number | null; note: string; replaces: string | null;
  /** never put in a prompt for a cloud agent (server/privacy.py) */
  localOnly?: boolean;
}
interface Category { id: string; label: string; core: boolean }
interface Backfill { running: boolean; done: number; total: number; found: number; error: string; remaining: number | null }
interface Overview { memories: MemoryRow[]; mode: 'auto' | 'review' | 'off'; categories: Category[]; backfill: Backfill; profile: string }

const J = (body: unknown) => JSON.stringify(body);
const mem = {
  list: () => req<Overview>('/api/memory'),
  add: (text: string, category: string) => req<Overview & { duplicate?: string }>('/api/memory', { method: 'POST', body: J({ text, category }) }),
  patch: (id: string, b: Partial<{ text: string; category: string; pinned: boolean; expires: string | null; localOnly: boolean }>) =>
    req<Overview>(`/api/memory/${id}`, { method: 'PATCH', body: J(b) }),
  act: (id: string, action: 'forget' | 'restore' | 'accept' | 'reject' | 'undo', msg = '') =>
    req<Overview>(`/api/memory/${id}/${action}${msg ? `?msg=${encodeURIComponent(msg)}` : ''}`, { method: 'POST' }),
  acceptAll: () => req<Overview>('/api/memory/accept-all', { method: 'POST' }),
  backfill: () => req<Overview>('/api/memory/backfill', { method: 'POST' }),
  backfillReset: () => req<Overview>('/api/memory/backfill/reset', { method: 'POST' }),
  learned: (msgId: string) => req<{ state: 'running' | 'done' | 'none'; items: LearnedItem[] }>(`/api/memory/learned/${msgId}`),
};

const ORIGIN: Record<MemoryRow['origin'], string> = { user: 'added by you', agent: 'saved by an agent', auto: 'learned from a chat', history: 'learned from past chats', feedback: 'from your feedback on a reply', reflection: 'tidied overnight' };
const MODES = [
  { id: 'auto', label: 'Learn automatically', hint: 'After each reply Shell:B notes new facts about you and shows them under the reply, with Undo.' },
  { id: 'review', label: 'Ask me first', hint: 'New facts wait here (and in Activity) until you keep them.' },
  { id: 'off', label: 'Off', hint: 'Only what you add here, or ask an agent to remember, is kept.' },
] as const;

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function MemoryManager() {
  const [data, setData] = useState<Overview | null>(null);
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [cat, setCat] = useState('other');
  const [msg, setMsg] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => mem.list().then(setData).catch(e => setErr(String(e))), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {  // follow "Learn from past chats"
    if (!data?.backfill.running) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [data?.backfill.running, load]);

  const run = async (p: Promise<Overview>) => { try { setData(await p); setErr(''); } catch (e) { setErr(String(e).replace(/^Error: \d+: /, '')); } };
  const add = async () => {
    if (!text.trim()) return;
    try {
      const r = await mem.add(text, cat);
      setData(r); setText('');
      setMsg(r.duplicate ? `Already remembered: “${r.duplicate}”` : 'Remembered.');
    } catch (e) { setErr(String(e)); }
  };
  const setMode = async (mode: Overview['mode']) => {
    await api.saveSettings({ memoryLearning: mode });
    setData(d => (d ? { ...d, mode } : d));
  };

  if (!data) return <div className="text-xs text-[var(--text-muted)] py-6 text-center">{err || 'Loading…'}</div>;
  const match = (m: MemoryRow) => !q || `${m.text} ${m.category}`.toLowerCase().includes(q.toLowerCase());
  const active = data.memories.filter(m => m.status === 'active' && match(m));
  const pending = data.memories.filter(m => m.status === 'pending');
  const retired = data.memories.filter(m => m.status === 'retired' && match(m));
  const core = active.filter(m => m.core);
  const rest = active.filter(m => !m.core);
  const byCat = (list: MemoryRow[]) => data.categories.map(c => ({ c, items: list.filter(m => m.category === c.id) })).filter(g => g.items.length);
  const bf = data.backfill;
  const rowProps = { categories: data.categories, onRun: run };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--text-muted)]">
        What Shell:B knows about you, stored only on this machine. <b className="text-[var(--text-secondary)]">Always known</b> facts go into
        every conversation; the rest are recalled when a message is about them. Longer reference material belongs in
        the <a href="#/codex" className="underline hover:text-[var(--text-primary)]">Codex</a>.
      </p>

      <div>
        <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] w-fit">
          {MODES.map(m => (
            <button key={m.id} onClick={() => setMode(m.id)}
              className={clsx('px-2.5 py-1 rounded-md text-xs transition', data.mode === m.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{MODES.find(m => m.id === data.mode)?.hint}</div>
      </div>

      <div className="flex gap-2">
        <input className={btn.input} value={text} onChange={e => setText(e.target.value)} placeholder="Tell Shell:B something, e.g. “I prefer metric units”"
          onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        <select className={clsx(btn.input, 'w-36')} value={cat} onChange={e => setCat(e.target.value)} title="Category">
          {data.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <button className={btn.primary} disabled={!text.trim()} onClick={add}><Plus className="w-3.5 h-3.5" />Add</button>
      </div>
      {(msg || err) && <div className={clsx('text-[11px]', err ? 'text-red-400' : 'text-[var(--text-muted)]')}>{err || msg}</div>}

      {pending.length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-medium flex-1">Waiting for your OK <span className="text-[var(--text-muted)] font-normal">· {pending.length}</span></h3>
            <button className={btn.subtle} onClick={() => run(mem.acceptAll())}><Check className="w-3.5 h-3.5" />Keep all</button>
          </div>
          {pending.map(m => <PendingRow key={m.id} m={m} all={data.memories} {...rowProps} />)}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button className={btn.subtle} disabled={bf.running || bf.remaining === 0} onClick={() => run(mem.backfill())}
          title="Reads your earlier chats and proposes memories for you to review">
          {bf.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
          {bf.running ? `Reading past chats… ${bf.done}/${bf.total}` : 'Learn from past chats'}
        </button>
        <span className="text-[11px] text-[var(--text-muted)]">
          {bf.running ? `${bf.found} found so far` : bf.remaining ? `${bf.remaining} chat${bf.remaining > 1 ? 's' : ''} not read yet` : 'Every chat has been read.'}
          {bf.error && <span className="text-red-400"> · {bf.error}</span>}
        </span>
        {!bf.running && bf.remaining === 0 && <button className={btn.ghost} onClick={() => run(mem.backfillReset())}>Read them again</button>}
      </div>
      <ReflectionRow onDone={load} />
      <BriefSettingsRow compact />
      <IncognitoSettingsRow />

      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={`Filter ${active.length} memories`} />
      </div>

      <Section title="Always known" hint="In every conversation: who you are, your work, how you like things, and anything you pin.">
        {byCat(core).map(({ c, items }) => <Group key={c.id} label={c.label}>{items.map(m => <MemoryItem key={m.id} m={m} {...rowProps} />)}</Group>)}
        {!core.length && <Empty>Nothing yet. Tell Shell:B about yourself, or let it learn from your chats.</Empty>}
      </Section>

      <Section title="Recalled when relevant" hint="Brought in when a message is about them: people, projects, interests, routines.">
        {byCat(rest).map(({ c, items }) => <Group key={c.id} label={c.label}>{items.map(m => <MemoryItem key={m.id} m={m} {...rowProps} />)}</Group>)}
        {!rest.length && <Empty>Nothing here yet.</Empty>}
      </Section>

      <div className="border-t border-[var(--border-subtle)] pt-3 space-y-2">
        <button className={btn.ghost} onClick={() => setShowRetired(v => !v)}>
          {showRetired ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}Forgotten and replaced · {retired.length}
        </button>
        {showRetired && retired.map(m => (
          <div key={m.id} className="group flex items-start gap-2 px-2.5 py-2 rounded-lg border border-[var(--border-subtle)] opacity-75 hover:opacity-100">
            <div className="flex-1 min-w-0">
              <div className="text-sm line-through decoration-[var(--text-muted)]/60">{m.text}</div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{m.note || 'Forgotten'} · {relTime(m.updatedAt)}</div>
            </div>
            <button className={btn.icon} title="Restore" onClick={() => run(mem.act(m.id, 'restore'))}><RotateCcw className="w-3.5 h-3.5" /></button>
            <button className={clsx(btn.icon, 'hover:text-red-400')} title="Delete for good" onClick={async () => { await api.deleteMemory(m.id); load(); }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <button className={btn.ghost} onClick={() => setShowProfile(v => !v)}>
          {showProfile ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}<Eye className="w-3.5 h-3.5" />What agents see
        </button>
        {showProfile && (
          <pre className="text-[11px] leading-relaxed whitespace-pre-wrap p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] max-h-80 overflow-y-auto">
            {data.profile || 'Nothing yet.'}
          </pre>
        )}
      </div>

      <HistoryImport learning={bf.running} onLearn={() => run(mem.backfill())} />
    </div>
  );
}

// Nightly tidy-up (server/reflection.py): rewrite, merge, ask about stale facts; weekly digest in Activity.
interface ReflectionInfo {
  enabled: boolean; hour: number; running: boolean; lastRun: number; next: number;
  last?: { at: number; tidied: unknown[]; merged: unknown[]; stale: unknown[]; error: string; digest?: boolean } | null;
}

function ReflectionRow({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<ReflectionInfo | null>(null);
  const load = useCallback(() => req<ReflectionInfo>('/api/memory/reflection').then(setInfo).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!info?.running) return;
    const t = setInterval(async () => {
      const i = await req<ReflectionInfo>('/api/memory/reflection').catch(() => null);
      if (i) setInfo(i);
      if (i && !i.running) { clearInterval(t); onDone(); }
    }, 2500);
    return () => clearInterval(t);
  }, [info?.running, onDone]);
  if (!info) return null;
  const save = async (s: { memoryReflection?: boolean; memoryReflectionHour?: number }) => { await api.saveSettings(s); load(); };
  const l = info.last;
  const did = l && [l.tidied.length && `${l.tidied.length} reworded`, l.merged.length && `${l.merged.length} merged`,
    l.stale.length && `${l.stale.length} to check`].filter(Boolean).join(', ');
  const hour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button className={btn.subtle} disabled={info.running} onClick={async () => setInfo(await req<ReflectionInfo>('/api/memory/reflection/run', { method: 'POST' }))}
        title="Rewords, merges duplicates and asks about facts that may be out of date">
        {info.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Moon className="w-3.5 h-3.5" />}{info.running ? 'Tidying up…' : 'Tidy up now'}
      </button>
      <span className="text-[11px] text-[var(--text-muted)]">
        {info.lastRun ? `Last ${relTime(info.lastRun)}${did ? `: ${did}` : ': nothing to change'}` : 'Never run yet'}
        {l?.error && <span className="text-red-400"> · {l.error}</span>}
      </span>
      <span className="flex-1" />
      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
        <input type="checkbox" className="accent-[var(--accent)]" checked={info.enabled} onChange={e => save({ memoryReflection: e.target.checked })} />
        Every night at
      </label>
      <select className="bg-transparent text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" value={info.hour} disabled={!info.enabled}
        onChange={e => save({ memoryReflectionHour: Number(e.target.value) })}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hour(h)}</option>)}
      </select>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{title}</h3>
        <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>
      </div>
      {children}
    </section>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-[var(--text-secondary)] pl-0.5">{label}</div>
      {children}
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <div className="text-xs text-[var(--text-muted)] py-2">{children}</div>;

interface RowProps { categories: Category[]; onRun: (p: Promise<Overview>) => void }

function MemoryItem({ m, categories, onRun }: { m: MemoryRow } & RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [sharing, setSharing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const save = () => { setEditing(false); if (draft.trim() && draft.trim() !== m.text) onRun(mem.patch(m.id, { text: draft.trim() })); else setDraft(m.text); };
  const catCore = categories.find(c => c.id === m.category)?.core;
  return (
    <div className="group flex items-start gap-2 px-2.5 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <Brain className={clsx('w-3.5 h-3.5 mt-0.5 shrink-0', m.origin === 'auto' || m.origin === 'history' ? 'text-amber-400' : 'text-[var(--accent)]')} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <textarea ref={ref} rows={2} className={clsx(btn.input, 'resize-none')} value={draft} onChange={e => setDraft(e.target.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { setDraft(m.text); setEditing(false); } }} />
        ) : (
          <div className="text-sm cursor-text" title="Click to edit" onClick={() => setEditing(true)}>{m.text}</div>
        )}
        <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--text-muted)] mt-0.5">
          <select className="bg-transparent hover:text-[var(--text-primary)] cursor-pointer -ml-0.5" value={m.category}
            onChange={e => onRun(mem.patch(m.id, { category: e.target.value }))} title="Category">
            {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <span>· {ORIGIN[m.origin]} {relTime(m.createdAt)}</span>
          {m.source && <a href={`#/c/${m.source}`} className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]" title="Open the chat it came from"><MessageSquare className="w-2.5 h-2.5" />chat</a>}
          {m.expires && <span>· until {day(m.expires)}</span>}
          {m.localOnly && <span>· local only</span>}
        </div>
      </div>
      <button className={clsx(btn.icon, m.localOnly ? 'text-[var(--accent)]' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
        aria-pressed={!!m.localOnly}
        title={m.localOnly ? 'Local only: never sent to cloud agents. Click to allow' : 'Keep local: never send this to cloud agents'}
        onClick={() => onRun(mem.patch(m.id, { localOnly: !m.localOnly }))}>
        {m.localOnly ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
      </button>
      {!catCore && (
        <button className={clsx(btn.icon, m.pinned ? 'text-[var(--accent)]' : 'opacity-0 group-hover:opacity-100')}
          title={m.pinned ? 'Recall only when relevant' : 'Always know this'} onClick={() => onRun(mem.patch(m.id, { pinned: !m.pinned }))}>
          {m.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
        </button>
      )}
      <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-sky-400')} title="Share to a circle… (the memory stays private; a copy goes to one circle as a note from you)"
        aria-label="Share to a circle" onClick={() => setSharing(true)}>
        <UsersRound className="w-3.5 h-3.5" />
      </button>
      {sharing && <ShareToCircle text={m.text} onClose={() => setSharing(false)} />}
      <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 hover:text-indigo-400')} title="Move to the Codex (stops automatic recall)"
        onClick={async () => { await api.memoryToCodex(m.id); onRun(mem.list()); }}>
        <BookMarked className="w-3.5 h-3.5" />
      </button>
      <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 hover:text-red-400')} title="Forget (you can restore it below)"
        onClick={() => onRun(mem.act(m.id, 'forget'))}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function PendingRow({ m, all, categories, onRun }: { m: MemoryRow; all: MemoryRow[] } & RowProps) {
  const forget = m.replaces?.startsWith('forget:');
  const olds = !forget && m.replaces ? all.filter(x => m.replaces!.split(',').includes(x.id)) : [];
  const [draft, setDraft] = useState(m.text);
  return (
    <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
      <div className="flex-1 min-w-0 space-y-1">
        {forget ? (
          <div className="text-sm"><span className="text-red-400 text-xs font-medium mr-1">Forget</span><span className="line-through">{m.text}</span></div>
        ) : (
          <input className={clsx(btn.input, 'py-1')} value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={() => { if (draft.trim() && draft.trim() !== m.text) onRun(mem.patch(m.id, { text: draft.trim() })); }} />
        )}
        <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--text-muted)]">
          {!forget && (
            <select className="bg-transparent hover:text-[var(--text-primary)] cursor-pointer -ml-0.5" value={m.category}
              onChange={e => onRun(mem.patch(m.id, { category: e.target.value }))}>
              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
          <span>· {ORIGIN[m.origin]}</span>
          {m.source && <a href={`#/c/${m.source}`} className="hover:text-[var(--text-primary)]">· open chat</a>}
          {olds.length > 0 && <span className="truncate">· {olds.length > 1 ? 'merges' : 'replaces'} {olds.map(o => `“${o.text}”`).join(' + ')}</span>}
          {forget && m.note && <span>· {m.note}</span>}
        </div>
      </div>
      <button className={btn.subtle} onClick={() => onRun(mem.act(m.id, 'accept'))}><Check className="w-3.5 h-3.5" />{forget ? 'Forget' : 'Keep'}</button>
      <button className={btn.icon} title="Dismiss" onClick={() => onRun(mem.act(m.id, 'reject'))}><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// Under an assistant reply: what Shell:B learned from that exchange. Polls briefly after a fresh turn, since learning
// runs after the reply has finished streaming.
export function LearnedNote({ message, fresh }: { message: Message; fresh: boolean }) {
  const [items, setItems] = useState<LearnedItem[]>(message.learned ?? []);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState<Set<string>>(new Set());
  useEffect(() => { if (message.learned) setItems(message.learned); }, [message.learned]);
  useEffect(() => {
    if (!fresh || message.learned || message.status !== 'complete' || Date.now() - message.timestamp > 5 * 60_000) return;
    let stop = false;
    let tries = 0;
    const tick = async () => {
      if (stop || tries++ > 20) return;
      const r = await mem.learned(message.id).catch(() => null);
      if (stop) return;
      if (r?.items.length) setItems(r.items);
      if (r?.state === 'running' || (!r && tries < 3)) setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, 2500);
    return () => { stop = true; clearTimeout(t); };
  }, [fresh, message.id, message.learned, message.status, message.timestamp]);
  const shown = items.filter(i => !undone.has(i.id));
  if (!shown.length) return null;
  const verb = (i: LearnedItem) => (i.status === 'pending' ? (i.op === 'retire' ? 'Forget?' : 'Remember?') : i.op === 'update' ? 'Updated' : i.op === 'retire' ? 'Forgot' : 'Remembered');
  const undo = async (i: LearnedItem) => { await mem.act(i.id, i.status === 'pending' ? 'reject' : 'undo', message.id).catch(() => {}); setUndone(s => new Set(s).add(i.id)); };
  const keep = async (i: LearnedItem) => { await mem.act(i.id, 'accept').catch(() => {}); setKept(s => new Set(s).add(i.id)); };
  return (
    <div className="mt-1.5 space-y-0.5">
      {shown.map(i => (
        <div key={i.id} className="group/l flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]">
          <Brain className="w-3 h-3 mt-0.5 shrink-0 text-amber-400/80" />
          <span className="min-w-0">
            <span className="font-medium text-[var(--text-secondary)]">{kept.has(i.id) ? 'Remembered' : verb(i)}</span>{' '}
            <span className={clsx(i.op === 'retire' && 'line-through')}>{i.text}</span>
            {i.op === 'update' && i.old && <span className="opacity-70"> (was: {i.old})</span>}
          </span>
          {i.status === 'pending' && !kept.has(i.id) && (
            <button className="shrink-0 inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]" onClick={() => keep(i)}><Check className="w-3 h-3" />Keep</button>
          )}
          {!kept.has(i.id) && (
            <button className="shrink-0 inline-flex items-center gap-0.5 opacity-0 group-hover/l:opacity-100 hover:text-[var(--text-primary)]" onClick={() => undo(i)}
              title={i.status === 'pending' ? 'Dismiss' : 'Undo'}>
              {i.status === 'pending' ? <X className="w-3 h-3" /> : <Undo2 className="w-3 h-3" />}{i.status === 'pending' ? 'Dismiss' : 'Undo'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** C5: the memories a reply was given, under it. Only shown when some were picked for this message (the core profile
 *  goes in every prompt, so on its own it would add a line to every reply). Each can be corrected or forgotten here. */
export function RecalledNote({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const [showCore, setShowCore] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});   // id -> saved text
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState('');
  const all = (message.recalled ?? []).filter(m => !gone.has(m.id));
  const relevant = all.filter(m => m.relevant);
  if (!relevant.length && !gone.size) return null;
  const core = all.filter(m => !m.relevant);
  const save = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    try { await mem.patch(editing.id, { text }); setEdits(e => ({ ...e, [editing.id]: text })); setEditing(null); setErr(''); }
    catch (e) { setErr(String(e)); }
  };
  const forget = async (m: RecalledMemory) => {
    try { await mem.act(m.id, 'forget'); setGone(s => new Set(s).add(m.id)); setErr(''); }
    catch (e) { setErr(String(e)); }
  };
  const row = (m: RecalledMemory) => (
    <li key={m.id} className="group/r flex items-start gap-1.5">
      <span className="mt-[5px] w-1 h-1 rounded-full bg-current opacity-50 shrink-0" />
      {editing?.id === m.id ? (
        <form className="flex-1 flex items-center gap-1" onSubmit={e => { e.preventDefault(); save(); }}>
          <input autoFocus value={editing.text} onChange={e => setEditing({ id: m.id, text: e.target.value })}
            onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
            className="flex-1 min-w-0 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" />
          <button type="submit" className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]"><Check className="w-3 h-3" />Save</button>
          <button type="button" className="hover:text-[var(--text-primary)]" onClick={() => setEditing(null)} title="Cancel"><X className="w-3 h-3" /></button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1">{edits[m.id] ?? m.text}{edits[m.id] && <span className="opacity-60"> (corrected)</span>}</span>
          <span className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover/r:opacity-100 focus-within:opacity-100">
            <button className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]" title="Correct this memory"
              onClick={() => setEditing({ id: m.id, text: edits[m.id] ?? m.text })}><Pencil className="w-3 h-3" />Edit</button>
            <button className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]" title="Forget this memory"
              onClick={() => forget(m)}><Trash2 className="w-3 h-3" />Forget</button>
          </span>
        </>
      )}
    </li>
  );
  return (
    <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
      <button className="inline-flex items-center gap-1 hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded"
        onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <BookMarked className="w-3 h-3 text-amber-400/80" />
        Recalled {relevant.length} {relevant.length === 1 ? 'memory' : 'memories'}
        {core.length > 0 && <span className="opacity-70">· plus your profile ({core.length})</span>}
      </button>
      {open && (
        <div className="mt-1 ml-4 max-w-[65ch]">
          {relevant.length > 0 && <ul className="space-y-0.5">{relevant.map(row)}</ul>}
          {core.length > 0 && (
            <>
              <button className="mt-1 inline-flex items-center gap-1 hover:text-[var(--text-secondary)]" onClick={() => setShowCore(v => !v)}>
                {showCore ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}Profile (in every reply)
              </button>
              {showCore && <ul className="mt-0.5 space-y-0.5">{core.map(row)}</ul>}
            </>
          )}
          {err && <div className="mt-1 text-red-400">{err}</div>}
        </div>
      )}
    </div>
  );
}
