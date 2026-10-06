import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Bot, CalendarCheck, CalendarX2, Check, ChevronDown, CircleCheck, Circle, CloudSun, Loader2, MessageSquare, Mic, Plus, RotateCcw, Sunrise, Undo2, Users, X,
} from 'lucide-react';
import { req } from '../api';
import type { ActivityItem, FollowUpNoted, Message } from '../types';
import { btn, relTime } from './common';

// Follow-ups and the morning brief (server/commitments.py): the note under replies, the Follow-ups tab in Activity,
// the brief card in the feed, and the brief's settings (also shown in Settings → Memory).

export interface FollowUp {
  id: string; text: string; due: string | null; who: string; status: 'open' | 'done' | 'dismissed';
  origin: 'chat' | 'meeting' | 'manual'; convId: string | null; msgId: string | null; meetingId: string | null;
  note: string; createdAt: number; updatedAt: number; closedAt: number | null;
}
interface Counts { open: number; overdue: number; today: number }
interface Overview { items: FollowUp[]; counts: Counts; duplicate?: string | null }
interface BriefLine { id: string; text: string; due: string }
export interface Brief {
  day: string; dayLabel: string; name: string; overdue: BriefLine[]; today: BriefLine[]; soon?: BriefLine[]; openCount: number;
  events: string[]; overnight: { source: string; status: string; title: string }[];
  waiting: { approvals: number; memories: number; attention: number };
  weather: { place: string; summary: string; low: number; high: number; unit: string; rain: number | null } | null;
  text: string; by: string; at: number;
}
interface BriefInfo {
  enabled: boolean; time: string; place: string; followUps: boolean; running: boolean; next: number; ownerActive: boolean;
  lastAt: number; last?: Brief | null;
}

const J = (b: unknown) => JSON.stringify(b);
const fu = {
  list: (status = 'open') => req<Overview>(`/api/commitments?status=${status}`),
  add: (text: string, due: string | null) => req<Overview>('/api/commitments', { method: 'POST', body: J({ text, due }) }),
  patch: (id: string, b: Partial<{ text: string; due: string | null; status: FollowUp['status'] }>) =>
    req<Overview>(`/api/commitments/${id}`, { method: 'PATCH', body: J(b) }),
  undo: (id: string, msg: string) => req<Overview>(`/api/commitments/${id}/undo?msg=${encodeURIComponent(msg)}`, { method: 'POST' }),
  noted: (msg: string) => req<{ state: 'running' | 'done' | 'none'; items: FollowUpNoted[] }>(`/api/commitments/noted/${msg}`),
  brief: () => req<BriefInfo>('/api/brief'),
  briefNow: () => req<BriefInfo>('/api/brief/run', { method: 'POST' }),
  settings: (s: Partial<{ followUps: boolean; morningBrief: boolean; morningBriefTime: string; briefWeatherPlace: string }>) =>
    req('/api/settings', { method: 'PUT', body: J(s) }),
};

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Today 14:00", "Tomorrow", "Fri, Oct 9", "3 days overdue". */
export function dueLabel(due: string | null | undefined): { label: string; tone: 'overdue' | 'today' | 'soon' | 'later' } | null {
  if (!due) return null;
  const today = isoDay(new Date());
  const tomorrow = isoDay(new Date(Date.now() + 86400000));
  const day = due.slice(0, 10);
  const time = due.length > 10 ? ` ${due.slice(11, 16)}` : '';
  if (day < today) {
    const n = Math.round((new Date(today).getTime() - new Date(day).getTime()) / 86400000);
    return { label: n === 1 ? 'Due yesterday' : `${n} days overdue`, tone: 'overdue' };
  }
  if (day === today) return { label: `Today${time}`, tone: 'today' };
  if (day === tomorrow) return { label: `Tomorrow${time}`, tone: 'soon' };
  const d = new Date(`${day}T12:00:00`);
  return { label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + time, tone: 'later' };
}

const TONE = {
  overdue: 'text-red-500 dark:text-red-400',
  today: 'text-amber-600 dark:text-amber-400',
  soon: 'text-[var(--text-secondary)]',
  later: 'text-[var(--text-muted)]',
};

// ── under a reply ───────────────────────────────────────────────────────────

/** "Noted a follow-up: …" under an assistant reply, with Undo. Polls briefly after a fresh turn, like LearnedNote. */
export function FollowUpNote({ message, fresh }: { message: Message; fresh: boolean }) {
  const [items, setItems] = useState<FollowUpNoted[]>(message.followUps ?? []);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  useEffect(() => { if (message.followUps) setItems(message.followUps); }, [message.followUps]);
  useEffect(() => {
    if (!fresh || message.followUps || message.status !== 'complete' || Date.now() - message.timestamp > 5 * 60_000) return;
    let stop = false;
    let tries = 0;
    const tick = async () => {
      if (stop || tries++ > 25) return;
      const r = await fu.noted(message.id).catch(() => null);
      if (stop) return;
      if (r?.items.length) setItems(r.items);
      if (r?.state === 'running' || (!r && tries < 3)) setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, 3000);
    return () => { stop = true; clearTimeout(t); };
  }, [fresh, message.id, message.followUps, message.status, message.timestamp]);
  const shown = items.filter(i => !undone.has(i.id));
  if (!shown.length) return null;
  const undo = async (i: FollowUpNoted) => { await fu.undo(i.id, message.id).catch(() => {}); setUndone(s => new Set(s).add(i.id)); };
  return (
    <div className="mt-1 space-y-0.5">
      {shown.map(i => {
        const due = dueLabel(i.due);
        return (
          <div key={i.id} className="group/f flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]">
            {i.op === 'done' ? <CircleCheck className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500/80" /> : <CalendarCheck className="w-3 h-3 mt-0.5 shrink-0 text-sky-400/80" />}
            <span className="min-w-0">
              <span className="font-medium text-[var(--text-secondary)]">
                {i.op === 'done' ? 'Marked done' : i.who === 'agent' ? 'Noted a follow-up for Shell:B' : 'Noted a follow-up'}
              </span>{' '}
              <a href="#/activity/follow-ups" className={clsx('hover:text-[var(--text-primary)]', i.op === 'done' && 'line-through')}>{i.text}</a>
              {due && i.op !== 'done' && <span className={clsx('ml-1', TONE[due.tone])}>· {due.label}</span>}
            </span>
            <button className="shrink-0 inline-flex items-center gap-0.5 opacity-0 group-hover/f:opacity-100 focus-visible:opacity-100 hover:text-[var(--text-primary)]"
              onClick={() => undo(i)} title={i.op === 'done' ? 'Reopen it' : 'Forget this follow-up'}>
              <Undo2 className="w-3 h-3" />Undo
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Activity: tab badge, Brief me now, the brief in the feed ────────────────

export function useFollowUpCounts(refresh: unknown): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fu.list().then(r => { if (live) setCounts(r.counts); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [refresh]);
  return counts;
}

export function BriefNowButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await fu.briefNow(); onDone(); } catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  return (
    <button className={btn.ghost} onClick={go} disabled={busy} title={err || 'Write a brief now: follow-ups due, calendar, what ran overnight, what is waiting'}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sunrise className="w-3.5 h-3.5" />}{busy ? 'Writing brief…' : 'Brief me now'}
    </button>
  );
}

/** A morning brief in the feed: the whole paragraph, not two clamped lines. */
export function BriefRow({ it, onOpen, onDelete }: { it: ActivityItem; onOpen: () => void; onDelete: () => void }) {
  const [, day] = it.title.split(' · ');
  return (
    <article className={clsx('group relative px-4 py-3.5 rounded-xl border transition',
      it.read ? 'border-[var(--border-subtle)]/60' : 'border-orange-400/30 bg-orange-400/[0.04]')}>
      <header className="flex items-center gap-2 mb-1.5">
        <Sunrise className="w-4 h-4 text-orange-400 shrink-0" />
        <h3 className="text-sm font-semibold tracking-tight flex-1 min-w-0 truncate">Morning brief{day && <span className="font-normal text-[var(--text-muted)]"> · {day}</span>}</h3>
        <span className="text-[11px] text-[var(--text-muted)]" title={new Date(it.ts).toLocaleString()}>
          {new Date(it.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400')} title="Delete" onClick={onDelete}><X className="w-3.5 h-3.5" /></button>
      </header>
      <p className="text-[13px] leading-relaxed text-[var(--text-primary)] max-w-[65ch]">{it.body}</p>
      <button className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded" onClick={onOpen}>
        <CalendarCheck className="w-3 h-3" />Open follow-ups
      </button>
    </article>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

/** Brief on/off, time and weather town, plus follow-up tracking. Shown in the Follow-ups tab and Settings → Memory. */
export function BriefSettingsRow({ compact = false }: { compact?: boolean }) {
  const [info, setInfo] = useState<BriefInfo | null>(null);
  const [place, setPlace] = useState('');
  const load = useCallback(() => fu.brief().then(i => { setInfo(i); setPlace(i.place); }).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!info) return null;
  const save = async (s: Parameters<typeof fu.settings>[0]) => { await fu.settings(s).catch(() => {}); load(); };
  const next = new Date(info.next);
  return (
    <div className="space-y-1.5 text-[11px] text-[var(--text-secondary)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--accent)]" checked={info.enabled} onChange={e => save({ morningBrief: e.target.checked })} />
          Morning brief at
        </label>
        <input type="time" value={info.time} disabled={!info.enabled} aria-label="Brief time"
          onChange={e => e.target.value && save({ morningBriefTime: e.target.value })}
          className="bg-transparent border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" />
        <label className="flex items-center gap-1.5">
          <CloudSun className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input value={place} onChange={e => setPlace(e.target.value)} placeholder="Weather for (town)" disabled={!info.enabled}
            onBlur={() => place !== info.place && save({ briefWeatherPlace: place.trim() })}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-36 bg-transparent border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] placeholder-[var(--text-muted)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" />
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--accent)]" checked={info.followUps} onChange={e => save({ followUps: e.target.checked })} />
          Note follow-ups from chats
        </label>
      </div>
      {!compact && (
        <div className="text-[var(--text-muted)]">
          {info.enabled
            ? <>Next brief {next.toDateString() === new Date().toDateString() ? 'today' : next.toLocaleDateString(undefined, { weekday: 'long' })} at {next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              {!info.ownerActive && ' — skipped while you haven’t used Shell:B for three days'}
              {info.lastAt ? ` · last ${relTime(info.lastAt)}` : ''}.</>
            : 'No morning brief. “Brief me now” still works.'}
          {' '}Only the town name leaves the Spark for the weather.
        </div>
      )}
    </div>
  );
}

// ── the Follow-ups tab ──────────────────────────────────────────────────────

function Origin({ f }: { f: FollowUp }) {
  if (f.origin === 'meeting') return <span className="inline-flex items-center gap-1"><Mic className="w-3 h-3" />{f.note || 'From a meeting'}</span>;
  if (f.origin === 'chat' && f.convId) return <a href={`#/c/${f.convId}`} className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"><MessageSquare className="w-3 h-3" />From a chat · {relTime(f.createdAt)}</a>;
  return <span>Added {relTime(f.createdAt)}</span>;
}

function Item({ f, onRun }: { f: FollowUp; onRun: (p: Promise<Overview>) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.text);
  const due = dueLabel(f.due);
  const closed = f.status !== 'open';
  const saveText = () => { setEditing(false); if (text.trim() && text.trim() !== f.text) onRun(fu.patch(f.id, { text: text.trim() })); else setText(f.text); };
  return (
    <li className="group flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition">
      <button className={clsx('mt-0.5 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]',
        closed ? 'text-emerald-500' : 'text-[var(--text-muted)] hover:text-emerald-500')}
        title={closed ? 'Reopen' : 'Mark done'} onClick={() => onRun(fu.patch(f.id, { status: closed ? 'open' : 'done' }))}>
        {closed ? <CircleCheck className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input autoFocus value={text} onChange={e => setText(e.target.value)} onBlur={saveText}
            onKeyDown={e => { if (e.key === 'Enter') saveText(); if (e.key === 'Escape') { setText(f.text); setEditing(false); } }}
            className={clsx(btn.input, 'py-0.5 text-[13px]')} />
        ) : (
          <button className={clsx('text-left text-[13px] leading-snug max-w-[65ch] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded',
            closed ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]')} onClick={() => !closed && setEditing(true)} title={closed ? undefined : 'Edit'}>
            {f.text}
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
          {f.who === 'agent' && <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]"><Bot className="w-3 h-3" />Shell:B promised</span>}
          {f.who !== 'me' && f.who !== 'agent' && <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]"><Users className="w-3 h-3" />{f.who}</span>}
          <Origin f={f} />
          {f.status === 'dismissed' && <span>· dismissed</span>}
        </div>
      </div>
      {!closed && (
        <div className="shrink-0 flex items-center gap-1">
          <label className={clsx('relative inline-flex items-center gap-1 text-[11px] cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--bg-tertiary)]', due ? TONE[due.tone] : 'text-[var(--text-muted)] opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
            title="Change the due date">
            {due ? due.label : 'Add date'}
            <input type="date" value={f.due?.slice(0, 10) ?? ''} aria-label="Due date"
              onChange={e => onRun(fu.patch(f.id, { due: e.target.value ? e.target.value + (f.due && f.due.length > 10 ? f.due.slice(10) : '') : null }))}
              className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
          {f.due && <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')} title="Clear the date"
            onClick={() => onRun(fu.patch(f.id, { due: null }))}><CalendarX2 className="w-3.5 h-3.5" /></button>}
          <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')} title="Dismiss: not doing this"
            onClick={() => onRun(fu.patch(f.id, { status: 'dismissed' }))}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {closed && (
        <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')} title="Reopen"
          onClick={() => onRun(fu.patch(f.id, { status: 'open' }))}><RotateCcw className="w-3.5 h-3.5" /></button>
      )}
    </li>
  );
}

function Group({ title, tone, items, onRun }: { title: string; tone?: string; items: FollowUp[]; onRun: (p: Promise<Overview>) => void }) {
  if (!items.length) return null;
  return (
    <section>
      <h2 className={clsx('text-xs font-medium mb-1 px-2', tone ?? 'text-[var(--text-muted)]')}>{title} <span className="font-mono text-[10px] opacity-80">{items.length}</span></h2>
      <ul>{items.map(f => <Item key={f.id} f={f} onRun={onRun} />)}</ul>
    </section>
  );
}

export function FollowUpsPanel({ onChange }: { onChange?: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [closed, setClosed] = useState<FollowUp[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => fu.list().then(setData).catch(e => setErr(String(e))), []);
  const loadClosed = useCallback(() => fu.list('done,dismissed').then(r => setClosed(r.items.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 40))).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (showClosed) loadClosed(); }, [showClosed, loadClosed]);
  const run = async (p: Promise<Overview>) => {
    try { await p; setErr(''); } catch (e) { setErr(String(e)); }
    await load();
    if (showClosed) loadClosed();
    onChange?.();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      const r = await fu.add(text.trim(), due || null);
      setMsg(r.duplicate ? `Already on the list: “${r.duplicate}”` : '');
      setText(''); setDue(''); setData(r); onChange?.();
    } catch (e2) { setErr(String(e2)); }
  };

  const today = isoDay(new Date());
  const weekEnd = isoDay(new Date(Date.now() + 7 * 86400000));
  const items = data?.items ?? [];
  const others = items.filter(f => f.who !== 'me' && f.who !== 'agent');
  const mine = items.filter(f => f.who === 'me' || f.who === 'agent');
  const overdue = mine.filter(f => f.due && f.due.slice(0, 10) < today);
  const dueToday = mine.filter(f => f.due && f.due.slice(0, 10) === today);
  const week = mine.filter(f => f.due && f.due.slice(0, 10) > today && f.due.slice(0, 10) <= weekEnd);
  const later = mine.filter(f => f.due && f.due.slice(0, 10) > weekEnd);
  const someday = mine.filter(f => !f.due);

  return (
    <div className="space-y-5">
      <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <BriefSettingsRow />
      </div>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Add a follow-up, e.g. Renew the car registration"
          className={clsx(btn.input, 'flex-1 min-w-[14rem]')} aria-label="New follow-up" />
        <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date"
          className="px-2 py-1.5 text-xs rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]/70" />
        <button type="submit" className={btn.primary} disabled={!text.trim()}><Plus className="w-3.5 h-3.5" />Add follow-up</button>
      </form>
      {msg && <div className="-mt-3 text-[11px] text-[var(--text-muted)]">{msg}</div>}
      {err && <div className="text-xs text-red-500 dark:text-red-400">{err}</div>}

      {!data ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-10 rounded-lg bg-[var(--bg-secondary)] animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--text-muted)] max-w-[52ch] mx-auto">
          <CalendarCheck className="w-8 h-8 mx-auto mb-2" />
          Nothing to follow up on. When you tell Shell:B “I’ll send it Friday” or “remind me to call the vet”, it lands here,
          along with action items from Secretary meetings.
        </div>
      ) : (
        <div className="space-y-4">
          <Group title="Overdue" tone="text-red-500 dark:text-red-400" items={overdue} onRun={run} />
          <Group title="Today" tone="text-amber-600 dark:text-amber-400" items={dueToday} onRun={run} />
          <Group title="This week" items={week} onRun={run} />
          <Group title="Later" items={later} onRun={run} />
          <Group title="No date" items={someday} onRun={run} />
          <Group title="Waiting on others" items={others} onRun={run} />
        </div>
      )}

      <div>
        <button className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded"
          onClick={() => setShowClosed(v => !v)} aria-expanded={showClosed}>
          <ChevronDown className={clsx('w-3 h-3 transition', !showClosed && '-rotate-90')} />Done and dismissed
        </button>
        {showClosed && (closed === null ? <Loader2 className="mt-2 w-4 h-4 animate-spin text-[var(--text-muted)]" />
          : closed.length === 0 ? <div className="mt-1 px-2 text-[11px] text-[var(--text-muted)]">Nothing closed yet.</div>
            : <ul className="mt-1">{closed.map(f => <Item key={f.id} f={f} onRun={run} />)}</ul>)}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] max-w-[65ch]">
        <Check className="inline w-3 h-3 mr-0.5" />Follow-ups are noted by the local utility model after a chat reply, only when the exchange sounds like a promise
        or a reminder; incognito chats are skipped. Undo under the reply removes one.
      </p>
    </div>
  );
}
