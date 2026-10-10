import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookMarked, Brain, CalendarClock, Check, CheckCheck, ChevronDown, HardDrive, Inbox, ListTodo, Loader2, Mail, MessageSquare, Rocket, Shapes, ShieldQuestion,
  Sunrise, Telescope, Trash2, Workflow, XCircle, HeartPulse, ShoppingCart, Moon, UsersRound, Users, CalendarDays, Rss } from 'lucide-react';
import { api } from '../api';
import type { ActivityItem, ActivitySource, ActivitySummary, PendingApproval } from '../types';
import { btn, relTime } from './common';
import { BriefNowButton, BriefRow, FollowUpsPanel, useFollowUpCounts } from './FollowUps';
import { FindingsPanel } from './Findings';
import { NightShiftPanel } from './NightShift';

const SOURCES: Record<ActivitySource, { label: string; icon: typeof Inbox; color: string }> = {
  schedule: { label: 'Scheduled', icon: CalendarClock, color: 'text-emerald-400' },
  todo: { label: 'To-dos', icon: ListTodo, color: 'text-sky-400' },
  plan: { label: 'Mega plans', icon: Workflow, color: 'text-violet-400' },
  scout: { label: 'Asset scouts', icon: Shapes, color: 'text-lime-400' },
  notebook: { label: 'Notebooks', icon: Telescope, color: 'text-teal-400' },
  deploy: { label: 'Self-deploys', icon: Rocket, color: 'text-rose-400' },
  codex: { label: 'Codex', icon: BookMarked, color: 'text-indigo-400' },
  memory: { label: 'Memory', icon: Brain, color: 'text-amber-400' },
  data: { label: 'Offline data', icon: HardDrive, color: 'text-cyan-400' },
  brief: { label: 'Briefs', icon: Sunrise, color: 'text-orange-400' },
  health: { label: 'Health', icon: HeartPulse, color: 'text-red-400' },
  shopping: { label: 'Price watch', icon: ShoppingCart, color: 'text-emerald-400' },
  nightshift: { label: 'Night shift', icon: Moon, color: 'text-indigo-300' },
  circles: { label: 'Circles', icon: UsersRound, color: 'text-blue-400' },
  guest: { label: 'Guests', icon: Users, color: 'text-fuchsia-400' },
  calendar: { label: 'Calendar', icon: CalendarDays, color: 'text-orange-300' },
  feeds: { label: 'Feeds', icon: Rss, color: 'text-orange-400' },
};

const STATUS: Record<string, [string, string]> = {
  done: ['Done', 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'],
  failed: ['Failed', 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25'],
  'rolled-back': ['Rolled back', 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25'],
  blocked: ['Blocked', 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'],
  paused: ['Paused', 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'],
  interrupted: ['Interrupted', 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'],
  'restart-pending': ['Waiting for a restart', 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'],
  review: ['Ready to review', 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25'],
  warning: ['Warning', 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'],
  recovered: ['Back up', 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'],
};

type Filter = 'all' | 'attention' | 'unread';

function dayLabel(ts: number) {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

/** An approval an agent is blocked on right now. Answering happens in the chat, where the whole call is in view. */
function Waiting({ p, onDeny }: { p: PendingApproval; onDeny: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const self = p.kind !== 'remote' && p.kind !== 'question';  // explains itself: deploy, secret, schedule, install
  const diff = p.kind === 'self';
  const deny = async () => {
    setBusy(true); setError('');
    try { await onDeny(); } catch (e) { setError(String(e).includes('admin-key-required') ? 'Only the signed-in owner can answer this.' : String(e)); setBusy(false); }
  };
  return (
    <div className="p-3.5 rounded-xl border border-amber-500/35 bg-amber-500/5">
      <div className="flex items-start gap-3">
        <ShieldQuestion className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{p.kind === 'question' ? p.title : self ? `${p.title}?` : `Allow ${p.title}?`}</div>
          <div className="text-xs text-[var(--text-secondary)] mt-0.5">
            {p.convTitle ? <>In “{p.convTitle}”</> : 'In a chat'} · waiting {relTime(p.since).replace(' ago', '')}
            <span className="text-[var(--text-muted)]"> · {p.kind === 'question' ? 'the agent moves on after 30 minutes' : 'the agent gives up after 15 minutes'}</span>
          </div>
          {p.detail && (
            <button className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => setOpen(!open)}>
              <ChevronDown className={clsx('w-3 h-3 transition', !open && '-rotate-90')} />{diff ? 'Preview the change' : p.kind === 'secret' ? 'Preview the request' : p.kind === 'email' ? 'Read the email' : p.kind === 'git' ? 'Show the commits' : p.kind === 'question' ? 'Show the options' : 'Preview the call'}
            </button>
          )}
          {open && (
            <pre className="mt-1.5 p-2 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono max-h-64 overflow-auto whitespace-pre-wrap break-words">
              {p.detail.split('\n').map((l, i) => <span key={i} className={clsx('block', diff && /^\+(?!\+\+)/.test(l) && 'text-emerald-400',
                diff && /^-(?!--)/.test(l) && 'text-red-400', diff && /^@@/.test(l) && 'text-sky-400')}>{l || ' '}</span>)}
            </pre>
          )}
          {error && <div className="mt-1.5 text-[11px] text-red-400">{error}</div>}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {p.convId && <a href={`#/c/${p.convId}`} className={btn.primary}><MessageSquare className="w-3.5 h-3.5" />{p.kind === 'question' ? 'Answer in chat' : 'Review in chat'}</a>}
            <button disabled={busy} onClick={deny} className="px-2.5 py-1 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50">{p.kind === 'question' ? 'Skip' : 'Deny'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ it, onOpen, onToggle, onDelete }: { it: ActivityItem; onOpen: () => void; onToggle: () => void; onDelete: () => void }) {
  const src = SOURCES[it.source] ?? SOURCES.schedule;
  const Icon = src.icon;
  const [label, tone] = STATUS[it.status] ?? [it.status, 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]'];
  return (
    <div className={clsx('group relative flex items-start gap-3 px-3.5 py-3 rounded-xl border transition cursor-pointer',
      it.read ? 'border-transparent hover:bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]')}
      onClick={onOpen} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
      <span className={clsx('absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full', it.read ? 'bg-transparent' : it.attention ? 'bg-amber-400' : 'bg-[var(--accent)]')} />
      <span className="mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]" title={src.label}>
        <Icon className={clsx('w-4 h-4', src.color)} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={clsx('text-sm truncate', it.read ? 'text-[var(--text-secondary)]' : 'font-medium')}>{it.title}</span>
          <span className={clsx('px-1.5 py-px rounded-md border text-[10px] font-medium shrink-0', tone)}>{label}</span>
        </div>
        {it.body && <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2 break-words">{it.body}</p>}
      </div>
      <div className="shrink-0 flex items-center gap-0.5">
        <span className="text-[11px] text-[var(--text-muted)] mr-1 group-hover:hidden group-focus-within:hidden" title={new Date(it.ts).toLocaleString()}>
          {new Date(it.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        <span className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          <button className={btn.icon} title={it.read ? 'Mark as unread' : 'Mark as read'} onClick={onToggle}>
            {it.read ? <Mail className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button className={clsx(btn.icon, 'hover:text-red-400')} title="Delete" onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /></button>
        </span>
      </div>
    </div>
  );
}

/** The Activity inbox (#/activity): results of work that ran unattended, and approvals agents are waiting on. */
export function Activity({ live }: { live?: ActivitySummary }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [counts, setCounts] = useState<ActivitySummary>({ unread: 0, attention: 0, pending: 0 });
  const [filter, setFilter] = useState<Filter>('all');
  const [source, setSource] = useState<ActivitySource | ''>('');
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  // #/activity/follow-ups opens the Follow-ups tab (server/commitments.py); briefs link there
  const readTab = () => (/^#\/activity\/follow-ups/.test(location.hash) ? 'follow-ups'
    : /^#\/activity\/findings/.test(location.hash) ? 'findings'
    : /^#\/activity\/night-shift/.test(location.hash) ? 'night-shift' : 'feed');
  const [tab, setTab] = useState<'feed' | 'follow-ups' | 'findings' | 'night-shift'>(readTab);
  useEffect(() => { const f = () => setTab(readTab()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const [fuTick, setFuTick] = useState(0);
  const fuCounts = useFollowUpCounts(fuTick);

  const query = { source, only: filter === 'all' ? undefined : filter };
  const load = useCallback(async () => {
    try {
      const r = await api.activity(query);
      setItems(prev => {  // keep pages already loaded with "Show older" beyond the first
        const fresh = new Set(r.items.map(i => i.id));
        const oldest = r.items.length ? r.items[r.items.length - 1].ts : Infinity;
        return [...r.items, ...prev.filter(i => !fresh.has(i.id) && i.ts < oldest)];
      });
      setPending(r.pending);
      setCounts({ unread: r.unread, attention: r.attention, pending: r.pending.length });
      setMore(r.items.length >= 100);
      setError('');
    } catch (e) { setError(String(e)); }
    setLoaded(true);
  }, [filter, source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setItems([]); setLoaded(false); load(); }, [filter, source]); // eslint-disable-line react-hooks/exhaustive-deps
  // the status poll (every 10 s) carries the counts; reload when they move
  const mark = `${live?.unread}|${live?.attention}|${live?.pending}`;
  useEffect(() => { if (loaded) load(); }, [mark]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const older = async () => {
    const r = await api.activity({ ...query, before: items[items.length - 1]?.ts });
    setItems(prev => [...prev, ...r.items.filter(i => !prev.some(p => p.id === i.id))]);
    setMore(r.items.length >= 100);
  };
  const setRead = async (ids: string[], read: boolean) => {
    setItems(prev => prev.map(i => (ids.includes(i.id) ? { ...i, read } : i)));
    setCounts(await api.markActivity({ ids, unread: !read }));
  };
  const open = (it: ActivityItem) => {
    if (!it.read) setRead([it.id], true).catch(() => {});
    if (it.link) location.hash = it.link;
  };
  const remove = async (id: string) => { setItems(prev => prev.filter(i => i.id !== id)); setCounts(await api.deleteActivity(id)); };
  const allRead = async () => { setItems(prev => prev.map(i => ({ ...i, read: true }))); setCounts(await api.markActivity({ all: true })); };
  const clearRead = async () => { setItems(prev => prev.filter(i => !i.read)); setCounts(await api.clearActivity()); };

  const chip = (on: boolean, label: string, onClick: () => void, n?: number) => (
    <button onClick={onClick} className={clsx('px-2.5 py-1 rounded-lg text-xs border transition flex items-center gap-1.5',
      on ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]/60 font-medium'
        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      {label}{!!n && <span className="font-mono text-[10px]">{n}</span>}
    </button>
  );

  const days: [string, ActivityItem[]][] = [];
  for (const it of items) {
    const d = dayLabel(it.ts);
    if (days.length && days[days.length - 1][0] === d) days[days.length - 1][1].push(it);
    else days.push([d, [it]]);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 animate-fade-in">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h1 className="text-2xl font-semibold tracking-tight flex-1">Activity</h1>
          <BriefNowButton onDone={() => { load(); setFuTick(t => t + 1); }} />
          <button className={btn.ghost} onClick={allRead} disabled={!counts.unread}><CheckCheck className="w-3.5 h-3.5" />Mark all read</button>
          <button className={btn.ghost} onClick={clearRead}><Trash2 className="w-3.5 h-3.5" />Clear read</button>
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-5">What scheduled runs, to-dos, Mega Plans, asset scouts, notebooks and self-deploys did while you were away, and anything agents are waiting on you for.</p>
        {error && <div className="mb-4 text-xs text-red-500 dark:text-red-400">{error}</div>}
        <div role="tablist" className="flex gap-4 mb-5 border-b border-[var(--border-subtle)]">
          {([['feed', 'Feed', counts.unread], ['follow-ups', 'Follow-ups', fuCounts ? fuCounts.overdue + fuCounts.today || fuCounts.open : 0],
             ['night-shift', 'Night shift', 0], ['findings', 'Self-review', 0]] as const).map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={tab === id}
              onClick={() => { location.hash = id === 'feed' ? '#/activity' : `#/activity/${id}`; setTab(id); }}
              className={clsx('-mb-px pb-2 text-sm border-b-2 transition flex items-center gap-1.5 focus-visible:outline-none focus-visible:text-[var(--text-primary)]',
                tab === id ? 'border-[var(--accent)] text-[var(--text-primary)] font-medium' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
              {label}
              {!!n && <span className={clsx('font-mono text-[10px] px-1 rounded', id === 'follow-ups' && fuCounts && fuCounts.overdue ? 'bg-red-500/15 text-red-500 dark:text-red-400' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>{n}</span>}
            </button>
          ))}
        </div>

        {pending.length > 0 && (
          <section className="mb-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-500 mb-2">Waiting for you · {pending.length}</h2>
            <div className="space-y-2">
              {pending.map(p => <Waiting key={p.id} p={p} onDeny={async () => { await api.answerApproval(p.id, 'deny'); await load(); }} />)}
            </div>
          </section>
        )}

        {tab === 'findings' ? <FindingsPanel /> : tab === 'night-shift' ? <NightShiftPanel /> : tab === 'follow-ups' ? <FollowUpsPanel onChange={() => setFuTick(t => t + 1)} /> : (<>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {chip(filter === 'all', 'All', () => setFilter('all'))}
          {chip(filter === 'attention', 'Needs you', () => setFilter('attention'), counts.attention)}
          {chip(filter === 'unread', 'Unread', () => setFilter('unread'), counts.unread)}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-5">
          {chip(source === '', 'Everything', () => setSource(''))}
          {(Object.keys(SOURCES) as ActivitySource[]).map(k => chip(source === k, SOURCES[k].label, () => setSource(source === k ? '' : k)))}
        </div>

        {!loaded ? (
          <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-sm text-[var(--text-muted)]">
            {filter === 'all' && !source ? (<>
              <Inbox className="w-8 h-8 mx-auto mb-2" />
              Nothing yet. When scheduled tasks, to-dos, Mega Plans, asset scouts or notebook outputs finish, they show up here.
            </>) : (<>
              <XCircle className="w-8 h-8 mx-auto mb-2" />Nothing matches this filter.
            </>)}
          </div>
        ) : (
          <div className="space-y-5">
            {days.map(([day, list]) => (
              <section key={day}>
                <h2 className="text-xs font-medium text-[var(--text-muted)] mb-1.5 px-1">{day}</h2>
                <div className="space-y-1">
                  {list.map(it => it.source === 'brief' && it.title.startsWith('Morning brief')
                    ? <BriefRow key={it.id} it={it} onOpen={() => open(it)} onDelete={() => remove(it.id)} />
                    : <Row key={it.id} it={it} onOpen={() => open(it)} onToggle={() => setRead([it.id], !it.read)} onDelete={() => remove(it.id)} />)}
                </div>
              </section>
            ))}
            {more && <div className="flex justify-center"><button className={btn.subtle} onClick={older}>Show older</button></div>}
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}
