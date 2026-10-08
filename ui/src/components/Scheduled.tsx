import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Edit2, Loader2, Play, Plus, Trash2, XCircle } from 'lucide-react';
import { api } from '../api';
import type { Agent, ChatProject, ScheduleDraft, ScheduledRun, ScheduledTask } from '../types';
import { AgentAvatar, Modal, Toggle, btn, relTime } from './common';
import { ProjectGlyph } from './Projects';

export const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const INTERVALS = [
  { label: '5 minutes', cron: '*/5 * * * *' }, { label: '10 minutes', cron: '*/10 * * * *' },
  { label: '15 minutes', cron: '*/15 * * * *' }, { label: '30 minutes', cron: '*/30 * * * *' },
  { label: 'hour', cron: '0 * * * *' }, { label: '2 hours', cron: '0 */2 * * *' }, { label: '3 hours', cron: '0 */3 * * *' },
  { label: '4 hours', cron: '0 */4 * * *' }, { label: '6 hours', cron: '0 */6 * * *' }, { label: '12 hours', cron: '0 */12 * * *' },
];

type Repeat = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval' | 'cron';
interface Form {
  name: string; prompt: string; agentId: string; groupId: string; tz: string;
  repeat: Repeat; time: string; days: number[]; dom: number; interval: string; cron: string; at: string;
}

/** Wall-clock "YYYY-MM-DDTHH:MM" of an instant in a time zone (what a datetime-local input wants). */
function localInput(ms: number, tz: string) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: tz, hour12: false }).replace(' ', 'T').slice(0, 16);
}

function fmtWhen(ms: number, tz: string) {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz };
  return new Date(ms).toLocaleString(undefined, opts) + (tz !== browserTz() ? ` (${tz})` : '');
}

function untilText(ms: number) {
  const s = (ms - Date.now()) / 1000;
  if (s < 60) return 'in under a minute';
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  const d = Math.round(s / 86400);
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

function toCron(f: Form) {
  const [h, m] = f.time.split(':').map(n => parseInt(n, 10) || 0);
  switch (f.repeat) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekly': return `${m} ${h} * * ${f.days.length && f.days.length < 7 ? [...f.days].sort().join(',') : '*'}`;
    case 'monthly': return `${m} ${h} ${f.dom} * *`;
    case 'interval': return f.interval;
    default: return f.cron.trim();
  }
}

/** Reads a stored cron back into the simplest editor preset that produces it. */
function fromCron(cron: string): Partial<Form> {
  if (INTERVALS.some(i => i.cron === cron)) return { repeat: 'interval', interval: cron };
  const m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|[0-6](?:,[0-6])*)$/.exec(cron);
  if (m) {
    const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
    if (m[3] === '*' && m[4] === '*') return { repeat: 'daily', time };
    if (m[3] === '*') return { repeat: 'weekly', time, days: m[4].split(',').map(Number) };
    if (m[4] === '*') return { repeat: 'monthly', time, dom: Number(m[3]) };
  }
  return { repeat: 'cron', cron };
}

function initialForm(task: ScheduledTask | null, defaultAgent: string): Form {
  const tz = task?.tz ?? browserTz();
  const soon = new Date(Date.now() + 3600_000); soon.setMinutes(0, 0, 0);
  const base: Form = {
    name: task?.name ?? '', prompt: task?.prompt ?? '', agentId: task?.agentId ?? defaultAgent, groupId: task?.groupId ?? '', tz,
    repeat: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5], dom: 1, interval: '0 * * * *', cron: '0 8 * * 1-5',
    at: localInput(task?.at ?? soon.getTime(), tz),
  };
  if (!task) return base;
  return task.kind === 'once' ? { ...base, repeat: 'once' } : { ...base, ...fromCron(task.cron), cron: task.cron };
}

function draftOf(f: Form): ScheduleDraft {
  const once = f.repeat === 'once';
  return { name: f.name.trim(), prompt: f.prompt.trim(), agentId: f.agentId, groupId: f.groupId || null, tz: f.tz.trim() || 'UTC',
    kind: once ? 'once' : 'cron', at: once ? f.at : null, cron: once ? '' : toCron(f) };
}

// ── editor ─────────────────────────────────────────────────────────────────

function Editor({ task, open, onClose, onSaved, agents, groups, defaultAgent }: {
  task: ScheduledTask | null; open: boolean; onClose: () => void; onSaved: () => void;
  agents: Agent[]; groups: ChatProject[]; defaultAgent: string;
}) {
  const [f, setF] = useState(() => initialForm(task, defaultAgent));
  const [preview, setPreview] = useState<{ ok: boolean; error?: string; next: number[]; when?: string }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setF(initialForm(task, defaultAgent)); setError(''); } }, [open, task, defaultAgent]);
  const set = (patch: Partial<Form>) => setF(prev => ({ ...prev, ...patch }));

  const draft = draftOf(f);
  const key = `${draft.kind}|${draft.at}|${draft.cron}|${draft.tz}`;
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api.previewSchedule({ kind: draft.kind, at: draft.at, cron: draft.cron, tz: draft.tz }).then(setPreview).catch(e => setPreview({ ok: false, error: String(e), next: [] }));
    }, 250);
    return () => clearTimeout(t);
  }, [key, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (task) await api.patchSchedule(task.id, { ...draft, enabled: true });
      else await api.createSchedule(draft);
      onSaved();
    } catch (e) {
      setError(String(e).replace(/^Error: \d+: /, ''));
    } finally { setSaving(false); }
  };

  const label = 'block text-[11px] font-medium text-[var(--text-muted)] mb-1';
  const seg = (r: Repeat, text: string) => (
    <button key={r} onClick={() => set({ repeat: r })}
      className={clsx('px-2.5 py-1 rounded-md text-xs transition', f.repeat === r ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>{text}</button>
  );

  return (
    <Modal open={open} onClose={onClose} title={task ? 'Edit scheduled task' : 'New scheduled task'} icon={<CalendarClock className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className={label} htmlFor="st-name">Name</label>
          <input id="st-name" className={btn.input} value={f.name} onChange={e => set({ name: e.target.value })} placeholder="Morning AI news brief" />
        </div>
        <div>
          <label className={label} htmlFor="st-prompt">Prompt</label>
          <textarea id="st-prompt" className={clsx(btn.input, 'min-h-[110px] resize-y')} value={f.prompt} onChange={e => set({ prompt: e.target.value })}
            placeholder="Search for this week's open-weight model releases and summarize the five most important, with links." />
          <p className="text-[11px] text-[var(--text-muted)] mt-1">Each run starts a new chat with this message. Nobody is watching when it runs, so say everything the agent needs.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="st-agent">Agent</label>
            <select id="st-agent" className={btn.input} value={f.agentId} onChange={e => set({ agentId: e.target.value })}>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="st-group">Project</label>
            <select id="st-group" className={btn.input} value={f.groupId} onChange={e => set({ groupId: e.target.value })}>
              <option value="">None</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <span className={label}>When</span>
          <div className="inline-flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
            {seg('once', 'Once')}{seg('daily', 'Daily')}{seg('weekly', 'Weekly')}{seg('monthly', 'Monthly')}{seg('interval', 'Every…')}{seg('cron', 'Cron')}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {f.repeat === 'once' && (
              <input type="datetime-local" className={clsx(btn.input, 'w-auto')} value={f.at} onChange={e => set({ at: e.target.value })} aria-label="Date and time" />
            )}
            {(f.repeat === 'daily' || f.repeat === 'weekly' || f.repeat === 'monthly') && (<>
              {f.repeat === 'monthly' && (<>
                <span className="text-[var(--text-secondary)]">On day</span>
                <input type="number" min={1} max={31} className={clsx(btn.input, 'w-16')} value={f.dom}
                  onChange={e => set({ dom: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) })} aria-label="Day of month" />
              </>)}
              <span className="text-[var(--text-secondary)]">at</span>
              <input type="time" className={clsx(btn.input, 'w-auto')} value={f.time} onChange={e => set({ time: e.target.value || '00:00' })} aria-label="Time" />
            </>)}
            {f.repeat === 'interval' && (<>
              <span className="text-[var(--text-secondary)]">Every</span>
              <select className={clsx(btn.input, 'w-auto')} value={f.interval} onChange={e => set({ interval: e.target.value })} aria-label="Interval">
                {INTERVALS.map(i => <option key={i.cron} value={i.cron}>{i.label}</option>)}
              </select>
            </>)}
            {f.repeat === 'cron' && (
              <input className={clsx(btn.input, 'font-mono w-56')} value={f.cron} onChange={e => set({ cron: e.target.value })} placeholder="0 8 * * 1-5" aria-label="Cron expression" />
            )}
          </div>
          {f.repeat === 'weekly' && (
            <div className="mt-2 flex flex-wrap gap-1">
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <button key={d} onClick={() => set({ days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d] })}
                  className={clsx('w-10 py-1 rounded-md text-xs border transition',
                    f.days.includes(d) ? 'bg-[var(--accent)]/15 border-[var(--accent)]/50 text-[var(--accent-soft)]' : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]')}>
                  {DOW[d]}
                </button>
              ))}
            </div>
          )}
          {f.repeat === 'cron' && <p className="text-[11px] text-[var(--text-muted)] mt-1">minute hour day-of-month month day-of-week, in the time zone below.</p>}
          <div className="mt-3 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <label htmlFor="st-tz">Time zone</label>
            <input id="st-tz" className={clsx(btn.input, 'w-48 text-xs py-1')} value={f.tz} onChange={e => set({ tz: e.target.value })} />
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 text-xs">
          {!preview ? <span className="text-[var(--text-muted)]">Working out the next runs…</span>
            : !preview.ok ? <span className="text-red-500 dark:text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{preview.error}</span>
              : (<>
                <div className="font-medium mb-1">{preview.when}</div>
                <ul className="text-[var(--text-secondary)] space-y-0.5">
                  {preview.next.map((t, i) => <li key={t}>{i === 0 ? 'Next' : 'Then'}: {fmtWhen(t, draft.tz)} <span className="text-[var(--text-muted)]">· {untilText(t)}</span></li>)}
                </ul>
              </>)}
        </div>
        {error && <div className="text-xs text-red-500 dark:text-red-400">{error}</div>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
        <button className={btn.subtle} onClick={onClose}>Cancel</button>
        <button className={btn.primary} disabled={saving || !draft.name || !draft.prompt || !preview?.ok} onClick={save}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{task ? 'Save' : 'Schedule'}
        </button>
      </footer>
    </Modal>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

function RunStatus({ status }: { status: string | null }) {
  if (status === 'running') return <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" aria-label="Running" />;
  if (status === 'complete') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" aria-label="Completed" />;
  if (status === 'error' || status === 'interrupted') return <XCircle className="w-3.5 h-3.5 text-red-500" aria-label={status} />;
  return <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-label={status ?? 'Not run'} />;
}

export function Scheduled({ agents, groups, defaultAgent, onOpenChat }: {
  agents: Agent[]; groups: ChatProject[]; defaultAgent: string; onOpenChat: (convId: string) => void;
}) {
  const [data, setData] = useState<{ tasks: ScheduledTask[]; runs: ScheduledRun[] }>();
  const [editing, setEditing] = useState<ScheduledTask | null | undefined>(undefined); // undefined = closed, null = new
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.schedules().then(setData).catch(e => setError(String(e))), []);
  const busy = !!data?.tasks.some(t => t.running || t.queued) || !!data?.runs.some(r => r.status === 'running');

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, busy ? 3000 : 30000);
    return () => clearInterval(t);
  }, [load, busy]);

  const chatAgents = useMemo(() => agents.filter(a => !a.studio), [agents]);
  const act = async (f: () => Promise<unknown>) => { setError(''); try { await f(); } catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); } load(); };

  const tasks = data?.tasks ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold tracking-tight flex-1">Scheduled</h1>
          <button className={btn.primary} onClick={() => setEditing(null)}><Plus className="w-3.5 h-3.5" />New task</button>
        </div>
        <p className="text-sm text-[var(--text-secondary)] mb-6">Prompts that run on their own, once or on a repeat. Each run lands as a new chat. Agents with the Schedule Tasks tool can set these up for you too.</p>
        {error && <div className="mb-4 text-xs text-red-500 dark:text-red-400">{error}</div>}

        <div className="space-y-2.5">
          {tasks.map(t => {
            const agent = agents.find(a => a.id === t.agentId);
            const group = groups.find(g => g.id === t.groupId);
            const done = t.kind === 'once' && !t.enabled && !!t.lastRun;
            return (
              <div key={t.id} className={clsx('p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] transition', !t.enabled && 'opacity-70')}>
                <div className="flex items-start gap-3">
                  <AgentAvatar agent={agent} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{t.name}</span>
                      {group && <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] shrink-0"><ProjectGlyph project={group} size={14} />{group.name}</span>}
                      {t.createdBy.startsWith('agent:') && <span className="px-1.5 rounded text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-muted)] shrink-0">by {agents.find(a => `agent:${a.id}` === t.createdBy)?.name ?? 'an agent'}</span>}
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className="flex items-center gap-1"><CalendarClock className="w-3 h-3" />{t.when}</span>
                      {t.running ? <span className="text-[var(--accent)]">Running now</span>
                        : t.queued ? <span>Queued</span>
                          : t.enabled && t.nextRun ? <span title={fmtWhen(t.nextRun, t.tz)}>Next {fmtWhen(t.nextRun, t.tz)} · {untilText(t.nextRun)}</span>
                            : <span>{done ? 'Done' : 'Paused'}</span>}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-1.5 line-clamp-2">{t.prompt}</p>
                    {t.lastRun && (
                      <button className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:hover:text-[var(--text-secondary)]"
                        disabled={!t.lastConvId} onClick={() => t.lastConvId && onOpenChat(t.lastConvId)}>
                        <RunStatus status={t.running ? 'running' : t.lastStatus} />Last run {relTime(t.lastRun)}{t.lastConvId && ' · open chat'}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {confirmDel === t.id ? (<>
                      <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={() => { setConfirmDel(null); act(() => api.deleteSchedule(t.id)); }}>Delete</button>
                      <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(null)}>Keep</button>
                    </>) : (<>
                      <button className={btn.icon} title="Run now" disabled={t.running || t.queued} onClick={() => act(() => api.runSchedule(t.id))}><Play className="w-3.5 h-3.5" /></button>
                      <button className={btn.icon} title="Edit" onClick={() => setEditing(t)}><Edit2 className="w-3.5 h-3.5" /></button>
                      <button className={clsx(btn.icon, 'hover:text-red-400')} title="Delete" onClick={() => setConfirmDel(t.id)}><Trash2 className="w-3.5 h-3.5" /></button>
                      <span className="ml-1.5"><Toggle on={t.enabled} label={t.enabled ? 'Pause' : 'Resume'}
                        onChange={on => act(() => (on && t.kind === 'once' ? Promise.resolve(setEditing(t)) : api.patchSchedule(t.id, { enabled: on })))} /></span>
                    </>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {data && tasks.length === 0 && (
          <div className="text-center py-16 text-sm text-[var(--text-muted)]">
            <CalendarClock className="w-8 h-8 mx-auto mb-2" />
            No scheduled tasks yet. Create one, or ask an agent something like "every weekday at 8, brief me on the news".
          </div>
        )}

        {!!data?.runs.length && (
          <div className="mt-10">
            <h2 className="text-sm font-semibold mb-2">Recent runs</h2>
            <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
              {data.runs.map(r => (
                <button key={r.id} disabled={!r.convId} onClick={() => r.convId && onOpenChat(r.convId)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] disabled:hover:bg-[var(--bg-secondary)]">
                  <RunStatus status={r.status} />
                  <span className="flex-1 min-w-0 truncate">{r.name ?? 'Deleted task'}</span>
                  {r.trigger !== 'schedule' && <span className="text-[10px] text-[var(--text-muted)]">{r.trigger === 'late' ? 'ran late' : 'run by hand'}</span>}
                  {r.error && <span className="text-[10px] text-red-500 dark:text-red-400 truncate max-w-[40%]" title={r.error}>{r.error}</span>}
                  <span className="text-[var(--text-muted)] shrink-0">{relTime(r.startedAt)}{r.finishedAt ? ` · ${Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} s` : ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Editor open={editing !== undefined} task={editing ?? null} onClose={() => setEditing(undefined)}
        onSaved={() => { setEditing(undefined); load(); }} agents={chatAgents} groups={groups} defaultAgent={defaultAgent} />
    </div>
  );
}
