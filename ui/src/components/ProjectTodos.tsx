import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowDown, Ban, CheckCircle2, ChevronDown, ChevronUp, Circle, Edit2, Flag, ListChecks, Loader2, MessageSquare, MoreHorizontal, Play,
  Plus, RotateCcw, Square, Trash2, XCircle,
} from 'lucide-react';
import type { Agent, ProjectTodo, ProjectTodoList, TodoPriority, TodoStatus } from '../types';
import { api } from '../api';
import { AgentAvatar, btn, relTime } from './common';
import { t as tx } from '../i18n';

const STATUS: Record<TodoStatus, { icon: typeof Circle; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-[var(--text-muted)]', label: 'To do' },
  running: { icon: Loader2, cls: 'text-[var(--accent)] animate-spin', label: 'Running' },
  done: { icon: CheckCircle2, cls: 'text-emerald-400', label: 'Done' },
  blocked: { icon: AlertTriangle, cls: 'text-amber-400', label: 'Blocked: needs you' },
  failed: { icon: XCircle, cls: 'text-red-400', label: 'Failed' },
  skipped: { icon: Ban, cls: 'text-[var(--text-muted)]', label: 'Skipped' },
};

const PRIORITY: Record<TodoPriority, { label: string; cls: string }> = {
  high: { label: 'High priority', cls: 'text-rose-400' },
  normal: { label: 'Normal priority', cls: 'text-[var(--text-muted)]' },
  low: { label: 'Low priority', cls: 'text-sky-400/80' },
};
const NEXT_PRIORITY: Record<TodoPriority, TodoPriority> = { normal: 'high', high: 'low', low: 'normal' };

function PriorityIcon({ p, className }: { p: TodoPriority; className?: string }) {
  if (p === 'low') return <ArrowDown className={clsx('w-3.5 h-3.5', PRIORITY.low.cls, className)} />;
  return <Flag className={clsx('w-3.5 h-3.5', PRIORITY[p].cls, p === 'high' && 'fill-current', className)} />;
}

function PrioritySelect({ value, onChange }: { value: TodoPriority; onChange: (p: TodoPriority) => void }) {
  return (
    <span className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-0.5" role="radiogroup" aria-label={tx('Priority')}>
      {(['high', 'normal', 'low'] as const).map(p => (
        <button key={p} role="radio" aria-checked={value === p} title={PRIORITY[p].label} onClick={() => onChange(p)}
          className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] capitalize transition',
            value === p ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
          {p !== 'normal' && <PriorityIcon p={p} className="w-3 h-3" />}{p}
        </button>
      ))}
    </span>
  );
}

function AgentSelect({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className={clsx(btn.input, 'w-auto py-1 text-xs')} value={value} onChange={e => onChange(e.target.value)} aria-label={tx('Agent')}>
      {agents.map(a => <option key={a.id} value={a.id} disabled={!!a.unavailable}>{a.name}</option>)}
    </select>
  );
}

interface Props {
  projectId: string;
  agents: Agent[];
  agent: Agent;
  onOpenChat: (convId: string) => void;
  onActivity: () => void; // a run started or finished: the chat list changed
}

export function ProjectTodos({ projectId, agents, agent, onOpenChat, onActivity }: Props) {
  const [list, setList] = useState<ProjectTodoList | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [details, setDetails] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [agentId, setAgentId] = useState(agent.id);
  const [priority, setPriority] = useState<TodoPriority>('normal');
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const lastLive = useRef<string | null>(null);
  const activity = useRef(onActivity);
  activity.current = onActivity;

  const apply = useCallback((d: ProjectTodoList) => {
    d.items.forEach(t => { t.priority = PRIORITY[t.priority] ? t.priority : 'normal'; });
    setList(d); setError('');
    const live = d.live?.conv ?? d.live?.item ?? null;
    if (live !== lastLive.current) { lastLive.current = live; activity.current(); }
  }, []);
  const load = useCallback(() => api.todos(projectId).then(apply).catch(e => setError(String(e))), [projectId, apply]);
  const act = async (p: Promise<ProjectTodoList>) => { try { apply(await p); } catch (e) { setError(String(e)); } };

  useEffect(() => { setList(null); lastLive.current = null; load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAgentId(agent.id); }, [agent.id]);
  // poll while something is running or waiting to run
  const busy = !!list && (list.active || !!list.live || list.items.some(t => t.queued));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  if (!list) return null;
  const items = list.items;
  const openCount = items.filter(t => t.status === 'pending').length;
  const finished = items.filter(t => t.status === 'done' || t.status === 'skipped').length;
  const mixed = new Set(items.map(t => t.priority)).size > 1;

  const add = () => {
    const lines = draft.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s*/, '').trim()).filter(Boolean);
    if (!lines.length) return;
    // several lines are several to-dos; details only go with a single one
    const entries = lines.length > 1 && !details.trim()
      ? lines.map(title => ({ title, agentId, priority }))
      : [{ title: lines.join(' '), details: details.trim(), agentId, priority }];
    act(api.addTodos(projectId, entries).then(d => { setDraft(''); setDetails(''); setShowDetails(false); setPriority('normal'); return d; }));
  };
  // the list is sorted by priority, so an item only moves among items of the same priority
  const canMove = (i: number, dir: -1 | 1) => items[i + dir]?.priority === items[i].priority;
  const move = (i: number, dir: -1 | 1) => {
    const ids = items.map(t => t.id);
    const j = i + dir;
    if (!canMove(i, dir)) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(api.reorderTodos(projectId, ids));
  };

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex-1">
          {tx('To-dos ·')} {openCount} open{items.length ? tx(' of {length}', { length: items.length }) : ''}
        </h2>
        {list.active || list.live ? (
          <button className={btn.subtle} onClick={() => act(api.stopTodos(projectId))} title={tx('Stop after aborting the item that\'s running')}>
            <Square className="w-3 h-3 fill-current" />{tx('Stop')}
          </button>
        ) : (
          <button className={btn.primary} disabled={!openCount} onClick={() => act(api.startTodos(projectId))}
            title={tx('Agents work through the open to-dos in order, each in its own chat, with nobody watching')}>
            <Play className="w-3.5 h-3.5" />{tx('Run list')}
          </button>
        )}
        <div className="relative">
          <button className={btn.icon} onClick={() => setMenu(m => !m)} aria-label={tx('To-do options')}><MoreHorizontal className="w-4 h-4" /></button>
          {menu && (
            <div className="absolute right-0 top-full mt-1 w-48 z-30 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1" onMouseLeave={() => setMenu(false)}>
              <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--bg-hover)] disabled:opacity-40" disabled={!finished}
                onClick={() => { setMenu(false); act(api.clearTodos(projectId)); }}>
                <Trash2 className="w-3.5 h-3.5" />{tx('Clear')} {finished} finished
              </button>
            </div>
          )}
        </div>
      </div>

      {list.active && !list.live && openCount > 0 && (
        <div className="text-[11px] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />{tx('Waiting for the next turn. Runs go one at a time.')}
        </div>
      )}
      {!list.active && list.note && list.note !== 'Stopped by you.' && !(list.note === 'All done.' && openCount > 0) && (
        <div className={clsx('text-xs mb-2 px-3 py-2 rounded-lg border',
          list.note === 'All done.' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-200')}>
          {tx(list.note)}
        </div>
      )}
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}

      <div className="space-y-1">
        {items.map((t, i) => (
          <div key={t.id}>
          {mixed && t.priority !== items[i - 1]?.priority && (
            <div className={clsx('flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-1', i ? 'pt-2' : '', PRIORITY[t.priority].cls)}>
              <PriorityIcon p={t.priority} className="w-3 h-3" />{PRIORITY[t.priority].label}
            </div>
          )}
          <TodoRow t={t} agents={agents} first={!canMove(i, -1)} last={!canMove(i, 1)} open={open === t.id}
            onToggle={() => setOpen(o => (o === t.id ? null : t.id))} onMove={dir => move(i, dir)} onOpenChat={onOpenChat}
            onRun={() => act(api.runTodo(projectId, t.id))} onDelete={() => act(api.deleteTodo(projectId, t.id))}
            onPatch={patch => act(api.patchTodo(projectId, t.id, patch))} />
          </div>
        ))}
      </div>

      <div className="mt-2 rounded-xl border border-dashed border-[var(--border-subtle)] p-2 focus-within:border-[var(--accent)]/60 focus-within:border-solid transition">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          placeholder={items.length ? tx('Add a to-do…') : tx('Add tasks for the agents to run on their own. Paste a list to add one per line.')}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !draft.includes('\n')))) { e.preventDefault(); add(); } }}
          className="w-full bg-transparent resize-none px-1.5 py-1 text-sm focus:outline-none placeholder-[var(--text-muted)]" />
        {showDetails && (
          <textarea value={details} onChange={e => setDetails(e.target.value)} rows={4} autoFocus
            placeholder={tx('Full instructions: what to produce, where to save it, what counts as done. The agent gets this with nobody to ask.')}
            className={clsx(btn.input, 'text-xs leading-relaxed mt-1')} />
        )}
        {(draft.trim() || showDetails) && (
          <div className="flex items-center gap-2 mt-1.5">
            <button className={btn.ghost} onClick={() => setShowDetails(s => !s)}>{showDetails ? tx('Hide details') : tx('Add details')}</button>
            <span className="flex-1" />
            <PrioritySelect value={priority} onChange={setPriority} />
            <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
            <button className={btn.primary} disabled={!draft.trim()} onClick={add}>
              <Plus className="w-3.5 h-3.5" />{draft.trim().includes('\n') && !details.trim() ? tx('Add {length}', { length: draft.split('\n').filter(l => l.trim()).length }) : tx('Add')}
            </button>
          </div>
        )}
      </div>
      {!items.length && (
        <p className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center gap-1.5">
          <ListChecks className="w-3.5 h-3.5" />{tx('Run list works through them by priority (high, normal, low), then in list order, each in a new chat here. Later items see what earlier ones did.')}
        </p>
      )}
    </section>
  );
}

function TodoRow({ t, agents, first, last, open, onToggle, onMove, onOpenChat, onRun, onDelete, onPatch }: {
  t: ProjectTodo; agents: Agent[]; first: boolean; last: boolean; open: boolean; onToggle: () => void; onMove: (dir: -1 | 1) => void;
  onOpenChat: (convId: string) => void; onRun: () => void; onDelete: () => void;
  onPatch: (p: Partial<Pick<ProjectTodo, 'title' | 'details' | 'agentId' | 'status' | 'priority'>>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [details, setDetails] = useState(t.details);
  const [agentId, setAgentId] = useState(t.agentId);
  const [priority, setPriority] = useState(t.priority);
  useEffect(() => { if (!editing) { setTitle(t.title); setDetails(t.details); setAgentId(t.agentId); setPriority(t.priority); } }, [t, editing]);
  const s = STATUS[t.status];
  const a = agents.find(x => x.id === t.agentId);
  const running = t.status === 'running';

  return (
    <div className={clsx('group rounded-xl border transition', running ? 'border-[var(--accent)]/50 bg-[var(--accent)]/5' : 'border-[var(--border-subtle)]',
      open && 'bg-[var(--bg-secondary)]')}>
      <div className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] rounded-xl" onClick={onToggle}>
        <button className="shrink-0" title={t.status === 'done' ? tx('Re-open') : t.status === 'pending' ? tx('Mark done') : s.label} disabled={running}
          onClick={e => { e.stopPropagation(); onPatch({ status: t.status === 'pending' ? 'done' : 'pending' }); }}>
          <s.icon className={clsx('w-4 h-4', s.cls)} />
        </button>
        <span className="text-[11px] text-[var(--text-muted)] font-mono w-5 shrink-0">#{t.n}</span>
        <span className="flex-1 min-w-0">
          <span className={clsx('block text-sm truncate', (t.status === 'done' || t.status === 'skipped') && 'text-[var(--text-muted)] line-through decoration-[var(--text-muted)]/50')}>{tx(t.title)}</span>
          {(running || t.queued || t.status === 'blocked' || t.status === 'failed') && (
            <span className={clsx('block text-[11px]', s.cls.replace('animate-spin', ''))}>
              {running ? tx('Running since {v0}', { v0: relTime(t.startedAt ?? Date.now()) }) : t.queued ? tx('Queued') : s.label}
            </span>
          )}
        </span>
        {t.details && <span className="text-[10px] text-[var(--text-muted)] shrink-0" title={tx('Has detailed instructions')}>details</span>}
        <button className={clsx('shrink-0 p-0.5 rounded hover:bg-[var(--bg-tertiary)] transition', t.priority === 'normal' && 'opacity-0 group-hover:opacity-60 hover:!opacity-100')}
          title={tx('{label}. Click to change to {v0}', { label: PRIORITY[t.priority].label, v0: NEXT_PRIORITY[t.priority] })} aria-label={PRIORITY[t.priority].label}
          onClick={e => { e.stopPropagation(); onPatch({ priority: NEXT_PRIORITY[t.priority] }); }}>
          <PriorityIcon p={t.priority} />
        </button>
        <AgentAvatar agent={a} size={18} />
        <span className="flex items-center opacity-0 group-hover:opacity-100 transition" onClick={e => e.stopPropagation()}>
          {!running && !t.queued && t.status !== 'done' && (
            <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)]" title={tx('Run this one now')} onClick={onRun}><Play className="w-3.5 h-3.5" /></button>
          )}
          <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30" disabled={first} title={tx('Move up')} onClick={() => onMove(-1)}><ChevronUp className="w-3.5 h-3.5" /></button>
          <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30" disabled={last} title={tx('Move down')} onClick={() => onMove(1)}><ChevronDown className="w-3.5 h-3.5" /></button>
        </span>
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 text-xs">
          {editing ? (
            <div className="space-y-1.5">
              <input className={btn.input} value={title} onChange={e => setTitle(e.target.value)} autoFocus />
              <textarea className={clsx(btn.input, 'text-xs min-h-[90px] leading-relaxed')} value={details} onChange={e => setDetails(e.target.value)}
                placeholder={tx('Full instructions for the agent (optional)')} />
              <div className="flex items-center gap-2 flex-wrap">
                <PrioritySelect value={priority} onChange={setPriority} />
                <AgentSelect agents={agents} value={agentId} onChange={setAgentId} />
                <span className="flex-1" />
                <button className={btn.subtle} onClick={() => setEditing(false)}>{tx('Cancel')}</button>
                <button className={btn.primary} disabled={!title.trim()} onClick={() => { onPatch({ title: title.trim(), details, agentId, priority }); setEditing(false); }}>{tx('Save')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="whitespace-pre-wrap text-[var(--text-secondary)] leading-relaxed">
                {t.details || <span className="text-[var(--text-muted)] italic">{tx('No details: the agent gets the title as its instruction.')}</span>}
              </div>
              {(t.result || t.error) && (
                <div className={clsx('rounded-lg border px-2.5 py-2', t.status === 'done' ? 'border-emerald-500/25 bg-emerald-500/5'
                  : t.status === 'blocked' ? 'border-amber-500/30 bg-amber-500/5' : 'border-[var(--border-subtle)] bg-[var(--bg-primary)]')}>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    {t.status === 'pending' ? tx('Last attempt') : tx('Result')}{t.finishedAt ? ` · ${relTime(t.finishedAt)}` : ''}{t.attempts > 1 ? tx(' · {attempts} attempts', { attempts: t.attempts }) : ''}
                  </div>
                  {t.result && <div className="whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">{t.result}</div>}
                  {t.error && <div className="text-red-400 mt-1">{t.error}</div>}
                </div>
              )}
              <div className="flex items-center gap-1.5 flex-wrap">
                {t.convId && <button className={btn.subtle} onClick={() => onOpenChat(t.convId!)}><MessageSquare className="w-3.5 h-3.5" />{tx('Open chat')}</button>}
                {!running && t.status !== 'done' && !t.queued && <button className={btn.subtle} onClick={onRun}><Play className="w-3.5 h-3.5" />{tx('Run now')}</button>}
                {!running && t.status !== 'pending' && <button className={btn.subtle} onClick={() => onPatch({ status: 'pending' })}><RotateCcw className="w-3.5 h-3.5" />{tx('Re-open')}</button>}
                {!running && t.status === 'pending' && <button className={btn.subtle} onClick={() => onPatch({ status: 'skipped' })}><Ban className="w-3.5 h-3.5" />{tx('Skip')}</button>}
                <span className="flex-1" />
                <span className="text-[10px] text-[var(--text-muted)]">{t.createdBy.startsWith('agent:') ? tx('added by {v0}', { v0: agents.find(x => `agent:${x.id}` === t.createdBy)?.name ?? 'an agent' }) : tx('added by you')} · {relTime(t.createdAt)}</span>
                {!running && <button className={btn.icon} title={tx('Edit')} onClick={() => setEditing(true)}><Edit2 className="w-3.5 h-3.5" /></button>}
                {!running && <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Delete')} onClick={() => { if (confirm(tx('Delete to-do "{title}"?', { title: t.title }))) onDelete(); }}><Trash2 className="w-3.5 h-3.5" /></button>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
