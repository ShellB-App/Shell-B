import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Check, CheckCircle2, FlaskConical, Layers, ChevronDown, ChevronRight, Circle, CircleSlash, Code2, Columns3,
  Edit2, ExternalLink, Flag, Hand, ListOrdered, Loader2, MessageSquare, Pause, Play, Plus, RotateCcw, Search, SkipForward, Sparkles,
  Trash2, Workflow, X, XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { Agent, CheckResult, MegaEvent, MegaPlan, MegaPlanDetail, MegaStep, PlanLive, PlanQuality, PlanStatus, ProjectSummary, StepCounts, StepStatus } from '../types';
import { AgentAvatar, Modal, Toggle, btn, relTime } from './common';
import { FavoriteStar } from './Favorites';
import { isFavorite } from '../favorites';
import { Markdown } from './Markdown';
import { t as tx } from '../i18n';

// ── shared bits ────────────────────────────────────────────────────────────

const GRADIENT = 'linear-gradient(135deg, #7c3aed, #4f46e5)';

const STEP_META: Record<StepStatus, { label: string; icon: typeof Circle; text: string; dot: string }> = {
  pending: { label: 'To do', icon: Circle, text: 'text-[var(--text-muted)]', dot: 'bg-[var(--text-muted)]/50' },
  running: { label: 'Working', icon: Loader2, text: 'text-sky-500', dot: 'bg-sky-500' },
  revising: { label: 'Revising', icon: RotateCcw, text: 'text-amber-500', dot: 'bg-amber-500' },
  review: { label: 'In review', icon: Search, text: 'text-violet-500', dot: 'bg-violet-500' },
  done: { label: 'Done', icon: CheckCircle2, text: 'text-emerald-500', dot: 'bg-emerald-500' },
  skipped: { label: 'Skipped', icon: CircleSlash, text: 'text-[var(--text-muted)]', dot: 'bg-[var(--text-muted)]/30' },
  failed: { label: 'Failed', icon: XCircle, text: 'text-rose-500', dot: 'bg-rose-500' },
};

const PLAN_META: Record<PlanStatus, { label: string; cls: string }> = {
  planning: { label: 'Planning', cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-300' },
  draft: { label: 'Draft', cls: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' },
  running: { label: 'Running', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-300' },
  paused: { label: 'Paused', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-300' },
  complete: { label: 'Complete', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' },
  failed: { label: 'Failed', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-300' },
};

const PHASE_LABEL: Record<PlanLive['phase'], string> = {
  work: 'is working on', review: 'is reviewing', plan: 'is writing the plan', final: 'is writing the final report',
  check: 'is running the checks for', phase: 'is reviewing the finished phase',
};

const QUALITY_LABEL: Record<PlanQuality, { label: string; hint: string }> = {
  thorough: { label: 'Thorough', hint: 'Deep reasoning on every turn, a large tool budget for workers, and phase reviews. Slower; best results.' },
  standard: { label: 'Standard', hint: 'Each agent uses its usual settings. Faster, for smaller jobs.' },
};

/** Kanban columns: where each step status sits on the board. */
const COLUMNS: { key: string; label: string; statuses: StepStatus[]; accent: string }[] = [
  { key: 'todo', label: 'To do', statuses: ['pending'], accent: 'bg-[var(--text-muted)]/40' },
  { key: 'work', label: 'Working', statuses: ['running', 'revising'], accent: 'bg-sky-500' },
  { key: 'review', label: 'Review', statuses: ['review'], accent: 'bg-violet-500' },
  { key: 'done', label: 'Done', statuses: ['done', 'skipped'], accent: 'bg-emerald-500' },
  { key: 'blocked', label: 'Blocked', statuses: ['failed'], accent: 'bg-rose-500' },
];

function PlanPill({ status }: { status: PlanStatus }) {
  const m = PLAN_META[status];
  return <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium', m.cls)}>
    {(status === 'running' || status === 'planning') && <Loader2 className="w-3 h-3 animate-spin" />}{tx(m.label)}
  </span>;
}

function StepIcon({ status, className }: { status: StepStatus; className?: string }) {
  const m = STEP_META[status];
  const Icon = m.icon;
  return <Icon className={clsx('w-4 h-4 shrink-0', m.text, status === 'running' && 'animate-spin', className)} aria-label={tx(m.label)} />;
}

/** One segment per step, coloured by status: progress at a glance. */
function ProgressStrip({ steps, counts, className }: { steps?: MegaStep[]; counts: StepCounts; className?: string }) {
  const finished = counts.done + counts.skipped;
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="flex-1 flex gap-[3px] h-1.5" role="progressbar" aria-valuenow={finished} aria-valuemax={counts.total}>
        {steps ? steps.map(s => <span key={s.id} title={`${s.n}. ${s.title} · ${STEP_META[s.status].label}`}
          className={clsx('flex-1 rounded-full', STEP_META[s.status].dot, s.status === 'running' && 'animate-pulse')} />)
          : <span className="flex-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
            <span className="block h-full bg-emerald-500 rounded-full" style={{ width: `${counts.total ? (finished / counts.total) * 100 : 0}%` }} />
          </span>}
      </div>
      <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">{finished}/{counts.total}</span>
    </div>
  );
}

function agentOf(agents: Agent[], id: string) { return agents.find(a => a.id === id); }

function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return <label htmlFor={htmlFor} className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">{children}</label>;
}

function AgentSelect({ agents, value, onChange, id }: { agents: Agent[]; value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <select id={id} value={value} onChange={e => onChange(e.target.value)} className={btn.input}>
      {agents.map(a => <option key={a.id} value={a.id} disabled={!!a.unavailable}>{a.name} · {tx(a.title)}{a.unavailable ? ' (unavailable)' : ''}</option>)}
    </select>
  );
}

// ── index ──────────────────────────────────────────────────────────────────

export function MegaPlansIndex({ agents, live, onOpen }: { agents: Agent[]; live?: PlanLive | null; onOpen: (id: string) => void }) {
  const [plans, setPlans] = useState<MegaPlan[] | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectSummary[]>([]);
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [orchestrator, setOrchestrator] = useState('shellb');
  const [workspace, setWorkspace] = useState('new');
  const [autoRun, setAutoRun] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [quality, setQuality] = useState<PlanQuality>('thorough');
  const [check, setCheck] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.plans().then(setPlans).catch(() => setPlans([])), []);
  useEffect(() => { load(); const t = setInterval(() => document.visibilityState === 'visible' && load(), 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { api.projects().then(setWorkspaces).catch(() => {}); }, []);
  useEffect(() => { load(); }, [live?.step, live?.phase, load]);
  const orchestrators = useMemo(() => agents.filter(a => !a.studio), [agents]);

  const create = async (plan: boolean) => {
    if (!goal.trim()) return;
    setBusy(true); setError('');
    try {
      const p = await api.createPlan({ title: title.trim(), goal: goal.trim(), orchestrator, workspace, autoRun, maxAttempts, plan, quality, check: check.trim() });
      onOpen(p.id);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="text-center mb-7">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl mb-3" style={{ background: GRADIENT }}>
            <Workflow className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{tx('Mega Plans')}</h1>
          <p className="text-[13.5px] text-[var(--text-muted)] mt-1 max-w-xl mx-auto">
            {tx('For jobs too big for one chat. An orchestrator breaks the goal into steps, specialist agents carry them out one after another in a shared workspace, and the orchestrator checks every step against its acceptance criteria before the next one starts.')}
          </p>
        </div>

        <form className="max-w-2xl mx-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-sm focus-within:border-violet-500/60"
          onSubmit={e => { e.preventDefault(); create(true); }}>
          <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={3} aria-label={tx('Goal')}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(true); } }}
            placeholder={tx('Describe the whole job: what to build or produce, for whom, and what done looks like. e.g. Build a web app that tracks RMA returns: intake form, status board, CSV export, tests.')}
            className="w-full resize-y min-h-[84px] bg-transparent text-[14px] px-3.5 pt-3 pb-1 placeholder-[var(--text-muted)] focus:outline-none" />
          {more && (
            <div className="px-3.5 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2"><Label htmlFor="mp-title">{tx('Title (optional)')}</Label>
                <input id="mp-title" className={btn.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={tx('Named from the goal if empty')} /></div>
              <div><Label htmlFor="mp-orch">{tx('Orchestrator')}</Label><AgentSelect id="mp-orch" agents={orchestrators} value={orchestrator} onChange={setOrchestrator} /></div>
              <div><Label htmlFor="mp-ws">{tx('Workspace')}</Label>
                <select id="mp-ws" value={workspace} onChange={e => setWorkspace(e.target.value)} className={btn.input}>
                  <option value="new">{tx('New Code workspace (git-versioned)')}</option>
                  <option value="none">{tx('No shared workspace')}</option>
                  {workspaces.length > 0 && <optgroup label={tx('Existing Code / Studio projects')}>
                    {workspaces.map(w => <option key={w.id} value={w.id}>{w.name} ({w.kind})</option>)}
                  </optgroup>}
                </select></div>
              <div><Label htmlFor="mp-q">{tx('Quality')}</Label>
                <select id="mp-q" value={quality} onChange={e => setQuality(e.target.value as PlanQuality)} className={btn.input}>
                  {(Object.keys(QUALITY_LABEL) as PlanQuality[]).map(q => <option key={q} value={q}>{QUALITY_LABEL[q].label}</option>)}
                </select>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{QUALITY_LABEL[quality].hint}</p></div>
              <div><Label htmlFor="mp-check">{tx('Regression check (optional)')}</Label>
                <input id="mp-check" className={clsx(btn.input, 'font-mono !text-[12.5px]')} value={check} onChange={e => setCheck(e.target.value)} placeholder={tx('pytest -q')} />
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{tx('Runs in the workspace after every step and must pass. The planner can set one too.')}</p></div>
              <div><Label htmlFor="mp-att">{tx('Attempts per step before asking you')}</Label>
                <select id="mp-att" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} className={btn.input}>
                  {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
                </select></div>
              <div className="flex items-center justify-between gap-3 sm:pt-5">
                <span className="text-[12.5px] text-[var(--text-secondary)]">{tx('Start as soon as it\'s planned')}</span>
                <Toggle on={autoRun} onChange={setAutoRun} label={tx('Start as soon as it\'s planned')} />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 px-2.5 py-2 border-t border-[var(--border-subtle)]">
            <button type="button" className={btn.ghost} onClick={() => setMore(m => !m)} aria-expanded={more}>
              {more ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}{tx('Options')}
              {!more && <span className="text-[var(--text-muted)] hidden sm:inline">· {QUALITY_LABEL[quality].label} · {agentOf(agents, orchestrator)?.name ?? orchestrator} {tx('orchestrates ·')} {workspace === 'new' ? tx('new workspace') : workspace === 'none' ? tx('no workspace') : workspaces.find(w => w.id === workspace)?.name}</span>}
            </button>
            <span className="flex-1" />
            <button type="button" className={btn.ghost} disabled={!goal.trim() || busy} onClick={() => create(false)} title={tx('Create an empty plan and write the steps yourself')}>{tx('Write steps myself')}</button>
            <button type="submit" disabled={!goal.trim() || busy} className={clsx(btn.primary, '!bg-violet-600')}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}{tx('Plan it')}
            </button>
          </div>
          {error && <p className="px-3.5 pb-2 text-[12px] text-rose-500">{error}</p>}
        </form>

        <div className="mt-10 flex items-center gap-2 mb-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{tx('Plans')}</h2>
          {plans && <span className="text-[11px] font-mono text-[var(--text-muted)]">{plans.length}</span>}
        </div>
        {plans === null ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
        ) : plans.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-[var(--text-muted)]">{tx('No mega plans yet. Describe a big job above to start one.')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plans.map(p => {
              const orch = agentOf(agents, p.orchestrator);
              return (
                <button key={p.id} onClick={() => onOpen(p.id)}
                  className="group text-left p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-violet-500/50 transition flex flex-col min-h-[160px]">
                  <div className="flex items-center gap-1.5 mb-2 text-[10.5px]">
                    <PlanPill status={p.status} />
                    <span className="ml-auto text-[var(--text-muted)]">{relTime(p.updatedAt)}</span>
                    <FavoriteStar nested kind="plan" id={p.id} title={tx(p.title)} size={13} className={clsx('-my-1 -mr-1', !isFavorite('plan', p.id) && 'opacity-0 group-hover:opacity-100 focus:opacity-100')} />
                  </div>
                  <div className="text-[15px] font-semibold leading-snug group-hover:text-violet-600 dark:group-hover:text-violet-300 line-clamp-2">{tx(p.title)}</div>
                  <div className="mt-1 text-[12.5px] text-[var(--text-muted)] line-clamp-2">{p.goal}</div>
                  <div className="mt-auto pt-3 space-y-2">
                    {p.current && (p.status === 'running' || p.status === 'paused') && (
                      <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)] truncate">
                        <StepIcon status={p.current.status} className="!w-3.5 !h-3.5" /><span className="truncate">{tx(p.current.title)}</span>
                      </div>
                    )}
                    <ProgressStrip counts={p.counts} />
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><AgentAvatar agent={orch} size={14} />{orch?.name ?? p.orchestrator} orchestrates</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── board ──────────────────────────────────────────────────────────────────

export function MegaPlanBoard({ planId, agents, live, onBack, onOpenChat, onOpenWorkspace }: {
  planId: string; agents: Agent[]; live?: PlanLive | null; onBack: () => void; onOpenChat: (convId: string) => void; onOpenWorkspace: (projectId: string) => void;
}) {
  const [plan, setPlan] = useState<MegaPlanDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<'board' | 'timeline'>(() => (localStorage.getItem('megaplan-view') as 'board' | 'timeline') || 'board');
  const [open, setOpen] = useState<MegaStep | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => api.plan(planId).then(p => { setPlan(p); setMissing(false); }).catch(() => setMissing(true)), [planId]);
  const busy = plan?.status === 'running' || plan?.status === 'planning';
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), busy ? 3000 : 12000);
    return () => clearInterval(t);
  }, [load, busy]);
  useEffect(() => { load(); }, [live?.step, live?.phase, load]);
  useEffect(() => { try { localStorage.setItem('megaplan-view', view); } catch { /* storage off */ } }, [view]);

  const act = async (fn: () => Promise<MegaPlanDetail>) => {
    setError('');
    try { setPlan(await fn()); } catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); }
  };

  if (missing) return <div className="p-8 text-center text-sm text-[var(--text-muted)]">{tx('This plan doesn\'t exist any more.')} <button className="underline" onClick={onBack}>{tx('All plans')}</button></div>;
  if (!plan) return <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;

  const orch = agentOf(agents, plan.orchestrator);
  const liveHere = plan.live;
  const liveStep = liveHere?.step ? plan.steps.find(s => s.id === liveHere.step) : undefined;
  const selected = open && open !== 'new' ? plan.steps.find(s => s.id === open.id) ?? open : open;
  const checkpoint = plan.status === 'paused' && /^Checkpoint/.test(plan.note);
  const reviewWaiting = plan.steps.find(s => s.status === 'review');

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5">
        {/* header */}
        <div className="flex items-start gap-3 mb-4">
          <button className={clsx(btn.icon, 'mt-0.5')} onClick={onBack} aria-label={tx('All plans')}><ArrowLeft className="w-4 h-4" /></button>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: GRADIENT }}><Workflow className="w-4 h-4 text-white" /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight leading-tight">{tx(plan.title)}</h1>
              <PlanPill status={plan.status} />
              <FavoriteStar kind="plan" id={plan.id} title={tx(plan.title)} />
              <button className={btn.icon} onClick={() => setEditing(true)} aria-label={tx('Edit plan')}><Edit2 className="w-3.5 h-3.5" /></button>
            </div>
            <p className="text-[13px] text-[var(--text-muted)] mt-0.5 line-clamp-2" title={plan.goal}>{plan.goal}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            {plan.status === 'running' || plan.status === 'planning' ? (
              <button className={btn.subtle} onClick={() => act(() => api.planAction(plan.id, 'pause'))}><Pause className="w-3.5 h-3.5" />{tx('Pause')}</button>
            ) : plan.steps.length > 0 && plan.status !== 'complete' ? (
              <button className={clsx(btn.primary, '!bg-violet-600')} onClick={() => act(() => api.planAction(plan.id, 'run'))}>
                <Play className="w-3.5 h-3.5" />{plan.status === 'draft' ? tx('Start plan') : checkpoint ? tx('Approve & continue') : tx('Resume')}
              </button>
            ) : null}
            {plan.steps.length === 0 && plan.status === 'draft' && (
              <button className={clsx(btn.primary, '!bg-violet-600')} onClick={() => act(() => api.planAction(plan.id, 'plan'))}><Sparkles className="w-3.5 h-3.5" />{tx('Plan with')} {orch?.name ?? 'AI'}</button>
            )}
          </div>
        </div>

        <ProgressStrip steps={plan.steps} counts={plan.counts} className="mb-4" />

        {(plan.note || error) && (
          <div className={clsx('mb-4 px-3.5 py-2.5 rounded-xl border text-[13px] flex items-start gap-2',
            checkpoint ? 'border-violet-500/40 bg-violet-500/[0.07]' : 'border-amber-500/40 bg-amber-500/[0.07]')}>
            {checkpoint ? <Flag className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />}
            <div className="flex-1">{error || plan.note}</div>
            {!error && reviewWaiting && plan.status === 'paused' && (
              <button className={btn.subtle} onClick={() => setOpen(reviewWaiting)}>{tx('Review step {n}', { n: reviewWaiting.n })}</button>
            )}
            {error && <button className={btn.icon} onClick={() => setError('')} aria-label={tx('Dismiss')}><X className="w-3.5 h-3.5" /></button>}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-5">
          {/* steps */}
          <section className="min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{tx('Steps')}</h2>
              <span className="text-[11px] font-mono text-[var(--text-muted)]">{plan.steps.length}</span>
              <span className="flex-1" />
              <div className="flex p-0.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]" role="tablist">
                {([['board', Columns3, 'Board'], ['timeline', ListOrdered, 'Timeline']] as const).map(([k, Icon, label]) => (
                  <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
                    className={clsx('inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] transition',
                      view === k ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>
              <button className={btn.subtle} onClick={() => setOpen('new')}><Plus className="w-3.5 h-3.5" /><span className="hidden sm:inline">{tx('Add step')}</span></button>
            </div>

            {plan.status === 'planning' && plan.steps.length === 0 ? (
              <div className="py-16 rounded-xl border border-dashed border-[var(--border-strong)] text-center text-[13px] text-[var(--text-muted)]">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-violet-500" />
                {orch?.name ?? tx('The orchestrator')} {tx('is breaking the goal into steps…')}
                {plan.orchConv && <div className="mt-2"><button className="underline hover:text-[var(--text-primary)]" onClick={() => onOpenChat(plan.orchConv!)}>{tx('Watch it think')}</button></div>}
              </div>
            ) : plan.steps.length === 0 ? (
              <div className="py-16 rounded-xl border border-dashed border-[var(--border-strong)] text-center text-[13px] text-[var(--text-muted)]">
                {tx('No steps yet. Have')} {orch?.name ?? tx('the orchestrator')} {tx('plan them, or add them yourself.')}
              </div>
            ) : view === 'board' ? (
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                {COLUMNS.filter(c => c.key !== 'blocked' || plan.counts.failed > 0).map(col => {
                  const items = plan.steps.filter(s => col.statuses.includes(s.status));
                  return (
                    <div key={col.key} className={clsx('shrink-0 snap-start rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] flex flex-col max-h-[70vh]',
                      items.length ? 'w-[250px] sm:w-auto sm:flex-1 sm:min-w-[210px]' : 'hidden sm:flex w-[110px]')}>
                      <div className="px-3 py-2 flex items-center gap-2 border-b border-[var(--border-subtle)]">
                        <span className={clsx('w-2 h-2 rounded-full', col.accent)} />
                        <span className="text-[12px] font-semibold">{tx(col.label)}</span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)]">{items.length}</span>
                      </div>
                      <div className="p-2 space-y-2 overflow-y-auto">
                        {items.map(s => <StepCard key={s.id} step={s} agents={agents} live={liveHere?.step === s.id ? liveHere.phase : undefined} onOpen={() => setOpen(s)} />)}
                        {items.length === 0 && <div className="py-6 text-center text-[11px] text-[var(--text-muted)]">—</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Timeline plan={plan} agents={agents} live={liveHere} onOpen={s => setOpen(s)}
                onMove={(s, d) => act(() => api.patchStep(plan.id, s.id, { move: d }))} />
            )}
          </section>

          {/* orchestrator */}
          <aside className="space-y-4 min-w-0">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3.5">
              <div className="flex items-center gap-2 mb-2">
                <AgentAvatar agent={orch} size={22} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold">{orch?.name ?? plan.orchestrator}</div>
                  <div className="text-[11px] text-[var(--text-muted)]">{tx('Orchestrator')}</div>
                </div>
                {plan.orchConv && <button className={btn.ghost} onClick={() => onOpenChat(plan.orchConv!)} title={tx('Open the orchestrator\'s chat: plan reviews and decisions')}><MessageSquare className="w-3.5 h-3.5" />{tx('Chat')}</button>}
              </div>
              {liveHere ? (
                <button onClick={() => liveHere.conv && onOpenChat(liveHere.conv)}
                  className="w-full mt-1 px-2.5 py-2 rounded-lg bg-sky-500/[0.08] border border-sky-500/30 text-left text-[12.5px] flex items-center gap-2 hover:bg-sky-500/[0.14] transition">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">{liveHere.phase === 'work' ? agentOf(agents, liveStep?.agentId ?? '')?.name ?? tx('A worker') : liveHere.phase === 'check' ? tx('The plan') : orch?.name ?? tx('The orchestrator')}</span>{' '}
                    {PHASE_LABEL[liveHere.phase]}{liveStep ? <> step {liveStep.n}: <span className="text-[var(--text-secondary)]">{tx(liveStep.title)}</span></> : ''}
                    <span className="block text-[10.5px] text-[var(--text-muted)]">{tx('since {v0} · click to watch', { v0: relTime(liveHere.since) })}</span>
                  </span>
                </button>
              ) : (
                <p className="text-[12px] text-[var(--text-muted)]">
                  {plan.status === 'running' ? tx('Waiting for the next turn…') : plan.status === 'draft' ? tx('Review the steps, then start the plan.') : plan.status === 'complete' ? tx('All done.') : 'Idle.'}
                </p>
              )}
              {plan.project && (
                <button onClick={() => onOpenWorkspace(plan.project!.id)} className="mt-2.5 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] text-[12px] hover:bg-[var(--bg-hover)] transition">
                  <Code2 className="w-3.5 h-3.5 text-[var(--text-muted)]" /><span className="flex-1 text-left truncate">{tx('Workspace: {name}', { name: plan.project.name })}</span><ExternalLink className="w-3 h-3 text-[var(--text-muted)]" />
                </button>
              )}
            </div>

            {plan.summary && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-3.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-600 dark:text-emerald-400 mb-1.5"><CheckCircle2 className="w-3.5 h-3.5" />{tx('Final report')}</div>
                <div className="text-[13px] max-h-[420px] overflow-y-auto"><Markdown text={tx(plan.summary)} /></div>
              </div>
            )}

            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] text-[12px] font-semibold">{tx('Activity')}</div>
              <ol className="max-h-[480px] overflow-y-auto px-3.5 py-2 space-y-2">
                {plan.events.map(e => <EventRow key={e.id} e={e} steps={plan.steps} onOpen={s => setOpen(s)} />)}
              </ol>
            </div>
          </aside>
        </div>
      </div>

      {selected && (
        <StepModal key={selected === 'new' ? 'new' : selected.id} plan={plan} step={selected === 'new' ? null : selected} agents={agents}
          onClose={() => setOpen(null)} onChanged={p => setPlan(p)} onOpenChat={onOpenChat} />
      )}
      <PlanSettings open={editing} plan={plan} agents={agents} onClose={() => setEditing(false)} onSaved={p => { setPlan(p); setEditing(false); }}
        onDelete={() => setConfirmDelete(true)} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={tx('Delete this plan?')} icon={<Trash2 className="w-4 h-4 text-rose-500" />}>
        <div className="p-4 text-[13px] text-[var(--text-secondary)]">{tx('The board, its steps and its activity log go away. The chats and the workspace stay.')}</div>
        <footer className="px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
          <button className={btn.ghost} onClick={() => setConfirmDelete(false)}>{tx('Cancel')}</button>
          <button className={clsx(btn.primary, '!bg-rose-600')} onClick={async () => { await api.deletePlan(plan.id); onBack(); }}>{tx('Delete plan')}</button>
        </footer>
      </Modal>
    </div>
  );
}

function StepCard({ step: s, agents, live, onOpen }: { step: MegaStep; agents: Agent[]; live?: PlanLive['phase']; onOpen: () => void }) {
  const a = agentOf(agents, s.agentId);
  return (
    <button onClick={onOpen}
      className={clsx('w-full text-left p-2.5 rounded-lg border bg-[var(--bg-primary)] hover:border-violet-500/50 transition',
        live ? 'border-sky-500/60 shadow-[0_0_0_3px_rgba(14,165,233,0.12)]' : 'border-[var(--border-subtle)]')}>
      <div className="flex items-start gap-1.5">
        <span className="text-[11px] font-mono text-[var(--text-muted)] mt-px">{s.n}</span>
        <span className={clsx('flex-1 text-[13px] font-medium leading-snug', s.status === 'skipped' && 'line-through text-[var(--text-muted)]')}>{tx(s.title)}</span>
        {s.checkpoint && <Flag className="w-3 h-3 text-violet-500 shrink-0 mt-0.5" aria-label={tx('Checkpoint')} />}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
        <AgentAvatar agent={a} size={14} /><span className="truncate">{a?.name ?? s.agentId}</span>
        {s.phase && <span className="px-1.5 rounded bg-[var(--bg-tertiary)] truncate max-w-[90px]">{s.phase}</span>}
        <span className="flex-1" />
        {s.attempts > 1 && <span className="font-mono" title={tx('Attempts')}>×{s.attempts}</span>}
        <CheckBadge step={s} />
        {live && <Loader2 className="w-3 h-3 animate-spin text-sky-500" />}
      </div>
    </button>
  );
}

function Timeline({ plan, agents, live, onOpen, onMove }: {
  plan: MegaPlanDetail; agents: Agent[]; live: PlanLive | null; onOpen: (s: MegaStep) => void; onMove: (s: MegaStep, d: -1 | 1) => void;
}) {
  let phase = '';
  return (
    <ol className="relative">
      {plan.steps.map((s, i) => {
        const a = agentOf(agents, s.agentId);
        const header = s.phase && s.phase !== phase ? s.phase : '';
        if (s.phase) phase = s.phase;
        const movable = s.status === 'pending' && plan.status !== 'running';
        return (
          <li key={s.id}>
            {header && <div className="ml-9 mt-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">{header}</div>}
            <div className="flex gap-3 group">
              <div className="flex flex-col items-center w-6 shrink-0">
                <span className="mt-3"><StepIcon status={s.status} /></span>
                {i < plan.steps.length - 1 && <span className="flex-1 w-px bg-[var(--border-strong)] mt-1" />}
              </div>
              <div className={clsx('flex-1 min-w-0 mb-2 p-3 rounded-xl border bg-[var(--bg-secondary)] transition hover:border-violet-500/50 cursor-pointer',
                live?.step === s.id ? 'border-sky-500/60' : 'border-[var(--border-subtle)]')} onClick={() => onOpen(s)}>
                <div className="flex items-start gap-2">
                  <span className="text-[11px] font-mono text-[var(--text-muted)] mt-0.5">{s.n}</span>
                  <div className="flex-1 min-w-0">
                    <div className={clsx('text-[13.5px] font-medium', s.status === 'skipped' && 'line-through text-[var(--text-muted)]')}>
                      {tx(s.title)}{s.checkpoint && <Flag className="w-3 h-3 inline ml-1.5 -mt-0.5 text-violet-500" aria-label={tx('Checkpoint')} />}
                    </div>
                    <div className="text-[12px] text-[var(--text-muted)] line-clamp-2 mt-0.5">
                      {s.status === 'done' && s.handoff ? s.handoff : (s.status === 'revising' || s.status === 'failed') && s.feedback ? tx('Review: {feedback}', { feedback: s.feedback }) : s.brief}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-[var(--text-muted)]">
                    <span className={STEP_META[s.status].text}>{STEP_META[s.status].label}</span>
                    {s.attempts > 1 && <span className="font-mono">×{s.attempts}</span>}
                    <CheckBadge step={s} />
                    <AgentAvatar agent={a} size={16} />
                  </div>
                  {movable && (
                    <div className="flex flex-col -my-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition" onClick={e => e.stopPropagation()}>
                      <button className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30" disabled={i === 0} onClick={() => onMove(s, -1)} aria-label={tx('Move up')}><ArrowUp className="w-3 h-3" /></button>
                      <button className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30" disabled={i === plan.steps.length - 1} onClick={() => onMove(s, 1)} aria-label={tx('Move down')}><ArrowDown className="w-3 h-3" /></button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const EVENT_ICON: Record<string, { icon: typeof Circle; cls: string }> = {
  accept: { icon: Check, cls: 'text-emerald-500' }, complete: { icon: CheckCircle2, cls: 'text-emerald-500' },
  revise: { icon: RotateCcw, cls: 'text-amber-500' }, fail: { icon: XCircle, cls: 'text-rose-500' }, error: { icon: XCircle, cls: 'text-rose-500' },
  attention: { icon: AlertTriangle, cls: 'text-amber-500' }, checkpoint: { icon: Flag, cls: 'text-violet-500' },
  pause: { icon: Pause, cls: 'text-[var(--text-muted)]' }, run: { icon: Play, cls: 'text-sky-500' }, start: { icon: Play, cls: 'text-sky-500' },
  work: { icon: Search, cls: 'text-violet-500' }, plan: { icon: Sparkles, cls: 'text-violet-500' },
  check: { icon: FlaskConical, cls: 'text-rose-500' }, phase: { icon: Layers, cls: 'text-violet-500' },
};

function EventRow({ e, steps, onOpen }: { e: MegaEvent; steps: MegaStep[]; onOpen: (s: MegaStep) => void }) {
  const m = EVENT_ICON[e.kind] ?? { icon: Circle, cls: 'text-[var(--text-muted)]' };
  const Icon = m.icon;
  const s = e.stepId ? steps.find(x => x.id === e.stepId) : undefined;
  return (
    <li className="flex gap-2 text-[12px] leading-snug">
      <Icon className={clsx('w-3.5 h-3.5 mt-0.5 shrink-0', m.cls)} />
      <div className="flex-1 min-w-0">
        <span className="text-[var(--text-secondary)] line-clamp-3">{tx(e.text)}</span>
        <span className="text-[10.5px] text-[var(--text-muted)]">{relTime(e.at)}{s && <> · <button className="underline hover:text-[var(--text-primary)]" onClick={() => onOpen(s)}>step {s.n}</button></>}</span>
      </div>
    </li>
  );
}

// ── step editor / inspector ────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true, tone }: { title: string; children: ReactNode; defaultOpen?: boolean; tone?: 'warn' | 'ok' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={clsx('rounded-xl border', tone === 'warn' ? 'border-amber-500/40 bg-amber-500/[0.05]' : tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-[var(--border-subtle)]')}>
      <button className="w-full px-3 py-2 flex items-center gap-1.5 text-[12px] font-semibold text-left" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}{title}
      </button>
      {open && <div className="px-3 pb-3 text-[13px]">{children}</div>}
    </div>
  );
}

function StepModal({ plan, step, agents, onClose, onChanged, onOpenChat }: {
  plan: MegaPlanDetail; step: MegaStep | null; agents: Agent[]; onClose: () => void; onChanged: (p: MegaPlanDetail) => void; onOpenChat: (id: string) => void;
}) {
  const isNew = !step;
  const [edit, setEdit] = useState(isNew);
  const [title, setTitle] = useState(step?.title ?? '');
  const [brief, setBrief] = useState(step?.brief ?? '');
  const [criteria, setCriteria] = useState(step?.criteria ?? '');
  const [agentId, setAgentId] = useState(step?.agentId ?? 'hephaestus');
  const [phase, setPhase] = useState(step?.phase ?? '');
  const [checkpoint, setCheckpoint] = useState(step?.checkpoint ?? false);
  const [check, setCheck] = useState(step?.check ?? '');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [armed, setArmed] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (edit) titleRef.current?.focus(); }, [edit]);
  const workers = useMemo(() => agents.filter(a => !a.unavailable || a.id === agentId), [agents, agentId]);
  const phases = useMemo(() => [...new Set(plan.steps.map(s => s.phase).filter(Boolean))], [plan.steps]);

  const run = async (fn: () => Promise<MegaPlanDetail>, close = true) => {
    setError('');
    try { onChanged(await fn()); if (close) onClose(); return true; } catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); return false; }
  };
  const save = () => {
    const body = { title: title.trim(), brief, criteria, agent: agentId, phase: phase.trim(), checkpoint, check: check.trim() };
    if (!body.title) { setError('Give the step a title.'); return; }
    run(() => (isNew ? api.planAction(plan.id, 'steps', body) : api.patchStep(plan.id, step!.id, body)), isNew).then(ok => ok && setEdit(false));
  };
  const a = agentOf(agents, agentId);
  const running = step?.status === 'running';

  return (
    <Modal open onClose={onClose} wide title={isNew ? tx('New step') : tx('Step {n}: {title}', { n: step!.n, title: step!.title })} icon={step ? <StepIcon status={step.status} /> : <Plus className="w-4 h-4 text-violet-500" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
        {edit ? (
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3">
            <div className="space-y-3">
              <div><Label htmlFor="st-title">{tx('Title')}</Label><input ref={titleRef} id="st-title" className={btn.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={tx('Build the intake form')} /></div>
              <div><Label htmlFor="st-brief">{tx('Brief: complete instructions for the worker')}</Label>
                <textarea id="st-brief" className={clsx(btn.input, 'min-h-[150px] resize-y font-[inherit]')} value={brief} onChange={e => setBrief(e.target.value)}
                  placeholder={tx('The worker sees the plan\'s goal and outline, but nothing else. Say exactly what to make, where, and any constraints.')} /></div>
              <div><Label htmlFor="st-crit">{tx('Done when (acceptance criteria, one per line)')}</Label>
                <textarea id="st-crit" className={clsx(btn.input, 'min-h-[90px] resize-y')} value={criteria} onChange={e => setCriteria(e.target.value)}
                  placeholder={tx('- form validates required fields\n- pytest passes')} /></div>
              <div><Label htmlFor="st-check">{tx('Check command (optional): run after each attempt, must exit 0')}</Label>
                <input id="st-check" className={clsx(btn.input, 'font-mono !text-[12.5px]')} value={check} onChange={e => setCheck(e.target.value)}
                  placeholder={tx('pytest -q tests/test_intake.py')} />
                {!plan.projectId && check && <p className="mt-1 text-[11px] text-amber-500">{tx('This plan has no workspace, so checks can\'t run.')}</p>}</div>
            </div>
            <div className="space-y-3">
              <div><Label htmlFor="st-agent">{tx('Agent')}</Label><AgentSelect id="st-agent" agents={workers} value={agentId} onChange={setAgentId} />
                {a && <p className="mt-1 text-[11px] text-[var(--text-muted)] line-clamp-3">{tx(a.description)}</p>}</div>
              <div><Label htmlFor="st-phase">{tx('Phase (optional)')}</Label>
                <input id="st-phase" list="mp-phases" className={btn.input} value={phase} onChange={e => setPhase(e.target.value)} placeholder={tx('Foundation')} />
                <datalist id="mp-phases">{phases.map(p => <option key={p} value={p} />)}</datalist></div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-[12px] text-[var(--text-secondary)]">{tx('Checkpoint')}<span className="block text-[11px] text-[var(--text-muted)]">{tx('Pause for your approval after this step')}</span></span>
                <Toggle on={checkpoint} onChange={setCheckpoint} label={tx('Checkpoint')} />
              </div>
            </div>
          </div>
        ) : step && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1.5"><AgentAvatar agent={agentOf(agents, step.agentId)} size={16} />{agentOf(agents, step.agentId)?.name ?? step.agentId}</span>
              <span className={clsx('inline-flex items-center gap-1', STEP_META[step.status].text)}><StepIcon status={step.status} className="!w-3.5 !h-3.5" />{STEP_META[step.status].label}</span>
              {step.attempts > 0 && <span>{tx('Attempt {attempts} of {v0}', { attempts: step.attempts, v0: plan.options.maxAttempts ?? 3 })}</span>}
              {step.phase && <span>{tx('Phase: {phase}', { phase: step.phase })}</span>}
              {step.checkpoint && <span className="inline-flex items-center gap-1 text-violet-500"><Flag className="w-3 h-3" />{tx('Checkpoint')}</span>}
              {step.finishedAt && <span className="text-[var(--text-muted)]">finished {relTime(step.finishedAt)}</span>}
            </div>
            {step.handoff && <Section title={tx('Handoff (what later steps are told)')} tone="ok"><Markdown text={step.handoff} /></Section>}
            {step.feedback && step.status !== 'done' && <Section title={tx('Latest review')} tone="warn"><Markdown text={step.feedback} /></Section>}
            <Section title={tx('Brief')}><div className="text-[var(--text-secondary)]"><Markdown text={step.brief || tx('_No brief: the worker goes by the title and the plan._')} /></div></Section>
            {step.criteria && <Section title={tx('Done when')}><div className="text-[var(--text-secondary)]"><Markdown text={step.criteria} /></div></Section>}
            {(step.check || step.checkResult) && (
              <Section title={step.checkResult ? tx('Automated checks: {v0}', { v0: step.checkResult.ok ? 'passed' : 'failed' }) : tx('Automated check')}
                tone={step.checkResult ? (step.checkResult.ok ? 'ok' : 'warn') : undefined} defaultOpen={!!step.checkResult && !step.checkResult.ok}>
                {step.checkResult ? <CheckRuns res={step.checkResult} /> : <code className="text-[12px]">{step.check}</code>}
              </Section>
            )}
            {step.report && <Section title={tx('Worker\'s report')} defaultOpen={step.status === 'review'}><div className="max-h-[360px] overflow-y-auto"><Markdown text={step.report} /></div></Section>}
            {step.status === 'review' && plan.status !== 'running' && (
              <div className="rounded-xl border border-violet-500/40 bg-violet-500/[0.05] p-3 space-y-2">
                <div className="text-[12px] font-semibold flex items-center gap-1.5"><Hand className="w-3.5 h-3.5 text-violet-500" />{tx('Your review')}</div>
                <textarea className={clsx(btn.input, 'min-h-[70px] resize-y')} value={feedback} onChange={e => setFeedback(e.target.value)}
                  placeholder={tx('Feedback for the worker (needed to send it back), or a handoff note when accepting')} aria-label={tx('Review feedback')} />
                <div className="flex gap-2 justify-end">
                  <button className={btn.subtle} disabled={!feedback.trim()} onClick={() => run(() => api.patchStep(plan.id, step.id, { verdict: 'revise', feedback }))}><RotateCcw className="w-3.5 h-3.5" />{tx('Send back')}</button>
                  <button className={clsx(btn.primary, '!bg-emerald-600')} onClick={() => run(() => api.patchStep(plan.id, step.id, { verdict: 'accept', summary: feedback }))}><Check className="w-3.5 h-3.5" />{tx('Accept')}</button>
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="text-[12px] text-rose-500">{error}</p>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-2">
        {edit ? (
          <>
            <span className="flex-1" />
            <button className={btn.ghost} onClick={() => (isNew ? onClose() : setEdit(false))}>{tx('Cancel')}</button>
            <button className={clsx(btn.primary, '!bg-violet-600')} onClick={save}>{isNew ? tx('Add step') : tx('Save')}</button>
          </>
        ) : step && (
          <>
            {step.convId && <button className={btn.subtle} onClick={() => onOpenChat(step.convId!)}><MessageSquare className="w-3.5 h-3.5" />{tx('Open chat')}</button>}
            {!running && <button className={btn.ghost} onClick={() => setEdit(true)}><Edit2 className="w-3.5 h-3.5" />{tx('Edit')}</button>}
            <span className="flex-1" />
            {!running && step.status !== 'pending' && (
              <button className={btn.ghost} onClick={() => run(() => api.patchStep(plan.id, step.id, { status: 'pending' }))} title={tx('Run this step again from the start')}><RotateCcw className="w-3.5 h-3.5" />{tx('Redo')}</button>
            )}
            {!running && !['done', 'skipped'].includes(step.status) && (
              <>
                <button className={btn.ghost} onClick={() => run(() => api.patchStep(plan.id, step.id, { status: 'skipped' }))}><SkipForward className="w-3.5 h-3.5" />{tx('Skip')}</button>
                <button className={btn.ghost} onClick={() => run(() => api.patchStep(plan.id, step.id, { status: 'done' }))}><Check className="w-3.5 h-3.5" />{tx('Mark done')}</button>
              </>
            )}
            {!running && (
              <button className={clsx(btn.ghost, armed && '!text-rose-500')} onClick={() => (armed ? run(() => api.deleteStep(plan.id, step.id)) : setArmed(true))}>
                <Trash2 className="w-3.5 h-3.5" />{armed ? tx('Really delete') : tx('Delete')}
              </button>
            )}
          </>
        )}
      </footer>
    </Modal>
  );
}

function PlanSettings({ open, plan, agents, onClose, onSaved, onDelete }: {
  open: boolean; plan: MegaPlanDetail; agents: Agent[]; onClose: () => void; onSaved: (p: MegaPlanDetail) => void; onDelete: () => void;
}) {
  const [title, setTitle] = useState(plan.title);
  const [goal, setGoal] = useState(plan.goal);
  const [orchestrator, setOrchestrator] = useState(plan.orchestrator);
  const [maxAttempts, setMaxAttempts] = useState(plan.options.maxAttempts ?? 3);
  const [quality, setQuality] = useState<PlanQuality>(plan.options.quality ?? 'thorough');
  const [check, setCheck] = useState(plan.options.check ?? '');
  const [phaseReviews, setPhaseReviews] = useState(plan.options.phaseReviews !== false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setTitle(plan.title); setGoal(plan.goal); setOrchestrator(plan.orchestrator); setMaxAttempts(plan.options.maxAttempts ?? 3);
    setQuality(plan.options.quality ?? 'thorough'); setCheck(plan.options.check ?? ''); setPhaseReviews(plan.options.phaseReviews !== false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try { onSaved(await api.patchPlan(plan.id, { title, goal, orchestrator, options: { maxAttempts, quality, check: check.trim(), phaseReviews } })); } catch (e) { setError(String(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={tx('Plan settings')} icon={<Workflow className="w-4 h-4 text-violet-500" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
        <div><Label htmlFor="ps-title">{tx('Title')}</Label><input id="ps-title" className={btn.input} value={title} onChange={e => setTitle(e.target.value)} /></div>
        <div><Label htmlFor="ps-goal">{tx('Goal')}</Label><textarea id="ps-goal" className={clsx(btn.input, 'min-h-[120px] resize-y')} value={goal} onChange={e => setGoal(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="ps-orch">{tx('Orchestrator')}</Label><AgentSelect id="ps-orch" agents={agents.filter(a => !a.studio)} value={orchestrator} onChange={setOrchestrator} /></div>
          <div><Label htmlFor="ps-att">{tx('Attempts per step')}</Label>
            <select id="ps-att" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} className={btn.input}>
              {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
            </select></div>
          <div><Label htmlFor="ps-q">{tx('Quality')}</Label>
            <select id="ps-q" value={quality} onChange={e => setQuality(e.target.value as PlanQuality)} className={btn.input}>
              {(Object.keys(QUALITY_LABEL) as PlanQuality[]).map(q => <option key={q} value={q}>{QUALITY_LABEL[q].label}</option>)}
            </select></div>
          <div className="flex items-start justify-between gap-3 pt-4">
            <span className="text-[12px] text-[var(--text-secondary)]">{tx('Phase reviews')}<span className="block text-[11px] text-[var(--text-muted)]">{tx('Orchestrator checks each finished phase')}</span></span>
            <Toggle on={phaseReviews} onChange={setPhaseReviews} label={tx('Phase reviews')} />
          </div>
        </div>
        <p className="-mt-1 text-[11px] text-[var(--text-muted)]">{QUALITY_LABEL[quality].hint}</p>
        <div><Label htmlFor="ps-check">{tx('Regression check: runs after every step, must exit 0')}</Label>
          <input id="ps-check" className={clsx(btn.input, 'font-mono !text-[12.5px]')} value={check} onChange={e => setCheck(e.target.value)} placeholder={tx('pytest -q')} /></div>
        {error && <p className="text-[12px] text-rose-500">{error}</p>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex items-center gap-2">
        <button className={clsx(btn.ghost, '!text-rose-500')} onClick={onDelete}><Trash2 className="w-3.5 h-3.5" />{tx('Delete plan')}</button>
        <span className="flex-1" />
        <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
        <button className={clsx(btn.primary, '!bg-violet-600')} onClick={save}>{tx('Save')}</button>
      </footer>
    </Modal>
  );
}

function CheckBadge({ step }: { step: MegaStep }) {
  if (!step.checkResult) return step.check ? <FlaskConical className="w-3 h-3 text-[var(--text-muted)]" aria-label={tx('Check: {check}', { check: step.check })} /> : null;
  return step.checkResult.ok
    ? <FlaskConical className="w-3 h-3 text-emerald-500" aria-label={tx('Checks passed')} />
    : <FlaskConical className="w-3 h-3 text-rose-500" aria-label={tx('Checks failed')} />;
}

function CheckRuns({ res }: { res: CheckResult }) {
  return (
    <div className="space-y-2">
      {res.runs.map((r, i) => (
        <div key={i}>
          <div className="flex items-center gap-1.5 text-[12px] font-mono">
            {r.ok ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <X className="w-3.5 h-3.5 text-rose-500" />}
            <span className="truncate">$ {r.cmd}</span>
            {!r.ok && <span className="text-rose-500 shrink-0">exit {r.exit ?? '?'}</span>}
          </div>
          <pre className="mt-1 max-h-[220px] overflow-auto text-[11px] leading-snug p-2 rounded-lg bg-[var(--bg-tertiary)] whitespace-pre-wrap">{r.output || '(no output)'}</pre>
        </div>
      ))}
      <div className="text-[10.5px] text-[var(--text-muted)]">{tx('Run by the plan {v0}', { v0: relTime(res.at) })}</div>
    </div>
  );
}

/** Chat-side card for a mega_plan tool call: opens the board. */
export function PlanCard({ plan }: { plan: { id: string; title: string; status: PlanStatus; counts: StepCounts; created?: boolean; finished?: boolean } }) {
  return (
    <a href={`#/plans/${plan.id}`}
      className="w-full max-w-md my-2 p-3 rounded-xl border border-violet-500/30 bg-violet-500/[0.06] hover:bg-violet-500/[0.12] flex items-center gap-3 transition group no-underline">
      <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: GRADIENT }}><Workflow className="w-4 h-4 text-white" /></span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold truncate text-[var(--text-primary)]">{tx(plan.title)}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">
          {tx('Mega plan ·')} {PLAN_META[plan.status]?.label ?? plan.status} · {plan.counts.done + plan.counts.skipped}/{plan.counts.total} {tx('steps done')}
          {plan.finished ? tx(' · final report written') : ''}
        </span>
      </span>
      <ExternalLink className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] shrink-0" />
    </a>
  );
}
