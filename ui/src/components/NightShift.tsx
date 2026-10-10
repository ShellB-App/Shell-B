import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Loader2, MessageSquare, Moon, Plus, RotateCcw, ThumbsDown, Trash2, X } from 'lucide-react';
import { req } from '../api';
import { btn, relTime } from './common';
import { toastError } from './toast';

// The night shift (server/nightshift.py): research questions and 👎 redrafts the big local model works through while
// the owner is away. Shown as a tab in Activity (#/activity/night-shift).

interface Job {
  id: string; kind: 'research' | 'redraft'; title: string; prompt: string; agentId: string; ref: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; attempts: number; yields: number; convId: string | null;
  result: string; error: string; createdBy: string; createdAt: number; startedAt: number | null; finishedAt: number | null;
}
interface Overview {
  jobs: Job[]; queued: number; idleSeconds: number; blocked: string | null;
  running: { job: string; conv: string | null; title: string; since: number; model: string } | null;
  settings: { enabled: boolean; window: string; idleMinutes: number; model: string; redrafts: boolean; context: number };
}
type Settings = Partial<{ nightShift: boolean; nightShiftWindow: string; nightShiftIdleMinutes: number; nightShiftModel: string; nightShiftRedrafts: boolean; nightShiftContext: number }>;

const J = (b: unknown) => JSON.stringify(b);
const ns = {
  get: () => req<Overview>('/api/nightshift'),
  add: (prompt: string) => req<Overview>('/api/nightshift', { method: 'POST', body: J({ prompt }) }),
  cancel: (id: string) => req<Overview>(`/api/nightshift/${id}/cancel`, { method: 'POST' }),
  retry: (id: string) => req<Overview>(`/api/nightshift/${id}/retry`, { method: 'POST' }),
  remove: (id: string) => req<Overview>(`/api/nightshift/${id}`, { method: 'DELETE' }),
  clear: () => req<Overview>('/api/nightshift-clear', { method: 'POST' }),
  settings: (s: Settings) => req('/api/settings', { method: 'PUT', body: J(s) }),
};

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

function StatusLine({ o }: { o: Overview }) {
  if (o.running) {
    return (
      <span className="flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
        Working on <a className="font-medium text-[var(--text-primary)] hover:underline" href={o.running.conv ? `#/c/${o.running.conv}` : undefined}>{o.running.title}</a>
        <span className="text-[var(--text-muted)]">· {o.running.model} · since {relTime(o.running.since)}</span>
      </span>
    );
  }
  if (!o.settings.enabled) return <span>Off. Queued jobs wait until you switch it back on.</span>;
  if (!o.queued) return <span>Nothing queued. 👎 replies from the last two weeks are picked up on their own{o.settings.redrafts ? '' : ' (when redrafts are on)'}.</span>;
  const idle = Math.floor(o.idleSeconds / 60);
  return <span>{o.queued} queued · {o.blocked ? `${o.blocked}` : 'starting soon'}{o.blocked === 'waiting for you to be away' ? ` (quiet ${idle} of ${o.settings.idleMinutes} min)` : ''}.</span>;
}

function JobRow({ j, onChange }: { j: Job; onChange: (o: Overview) => void }) {
  const act = (fn: () => Promise<Overview>) => () => fn().then(onChange).catch(toastError('Night shift'));
  const tone = {
    queued: 'text-[var(--text-secondary)] border-[var(--border-subtle)]',
    running: 'text-[var(--accent)] border-[var(--accent)]/40',
    done: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
    failed: 'text-red-600 dark:text-red-400 border-red-500/25',
    cancelled: 'text-[var(--text-muted)] border-[var(--border-subtle)]',
  }[j.status];
  const Icon = j.kind === 'redraft' ? ThumbsDown : Moon;
  const when = j.finishedAt ?? j.startedAt ?? j.createdAt;
  return (
    <div className="group flex items-start gap-3 px-3.5 py-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-muted)]" aria-label={j.kind === 'redraft' ? 'Second draft' : 'Research'} />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[52ch]">{j.title}</span>
          <span className={clsx('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border', tone)}>{j.status}</span>
          {j.yields > 0 && j.status !== 'done' && <span className="text-[10px] text-[var(--text-muted)]">paused {j.yields}× for you</span>}
        </div>
        {j.kind === 'research' && j.status === 'queued' && j.prompt !== j.title && (
          <p className="mt-1 text-xs text-[var(--text-secondary)] line-clamp-2 max-w-[65ch]">{j.prompt}</p>
        )}
        {j.status === 'done' && j.result && <p className="mt-1 text-xs text-[var(--text-secondary)] line-clamp-2 max-w-[65ch]">{j.result}</p>}
        {j.error && j.status !== 'done' && <p className="mt-1 text-xs text-red-600 dark:text-red-400 max-w-[65ch]">{j.error}</p>}
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{relTime(when)}{j.kind === 'redraft' ? ' · from your 👎' : ` · ${j.agentId}`}</div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {j.convId && <a className={btn.icon} href={`#/c/${j.convId}`} title="Open the chat"><MessageSquare className="w-3.5 h-3.5" /></a>}
        {(j.status === 'queued' || j.status === 'running') && <button className={btn.icon} title="Cancel" onClick={act(() => ns.cancel(j.id))}><X className="w-3.5 h-3.5" /></button>}
        {(j.status === 'failed' || j.status === 'cancelled') && <button className={btn.icon} title="Queue again" onClick={act(() => ns.retry(j.id))}><RotateCcw className="w-3.5 h-3.5" /></button>}
        {j.status !== 'running' && j.status !== 'queued' && <button className={btn.icon} title="Remove" onClick={act(() => ns.remove(j.id))}><Trash2 className="w-3.5 h-3.5" /></button>}
      </div>
    </div>
  );
}

export function NightShiftPanel() {
  const [o, setO] = useState<Overview | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState('');
  const load = useCallback(() => ns.get().then(r => { setO(r); setWin(w => w || r.settings.window); }).catch(toastError('Night shift')), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const add = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try { setO(await ns.add(prompt)); setPrompt(''); } catch (e) { toastError('Night shift')(e); }
    setBusy(false);
  };
  const save = async (s: Settings) => { try { await ns.settings(s); await load(); } catch (e) { toastError('Night shift')(e); } };
  const winOk = win === '' || WINDOW_RE.test(win);

  if (!o) return <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
  const open = o.jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const past = o.jobs.filter(j => !(j.status === 'queued' || j.status === 'running'));
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[var(--border-subtle)] p-4">
        <div className="text-sm text-[var(--text-secondary)] mb-3"><StatusLine o={o} /></div>
        <label htmlFor="ns-prompt" className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Research while you're away</label>
        <textarea id="ns-prompt" className={clsx(btn.input, 'min-h-[72px] resize-y')} value={prompt} onChange={e => setPrompt(e.target.value)}
          placeholder="What's the best heat pump for a 1950s house in a cold climate? Compare running costs, noise and rebates."
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); }} />
        <div className="flex items-center justify-between mt-2 gap-3">
          <p className="text-[11px] text-[var(--text-muted)] max-w-[60ch]">Minerva researches it on {o.settings.model}, taking as long as she needs. The report lands in Activity. You can also tell any agent to “look into this tonight”.</p>
          <button className={btn.primary} disabled={busy || !prompt.trim()} onClick={add}><Plus className="w-3.5 h-3.5" />Queue research</button>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Queue · {open.length}</h2>
        {open.length ? <div className="space-y-2">{open.map(j => <JobRow key={j.id} j={j} onChange={setO} />)}</div>
          : <p className="text-sm text-[var(--text-muted)]">Empty.</p>}
      </section>

      {past.length > 0 && (
        <section>
          <div className="flex items-center mb-2">
            <h2 className="flex-1 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Finished</h2>
            <button className={btn.ghost} onClick={() => ns.clear().then(setO).catch(toastError('Night shift'))}><Trash2 className="w-3.5 h-3.5" />Clear finished</button>
          </div>
          <div className="space-y-2">{past.map(j => <JobRow key={j.id} j={j} onChange={setO} />)}</div>
        </section>
      )}

      <section className="rounded-xl border border-[var(--border-subtle)] p-4 space-y-3 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Settings</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={o.settings.enabled} onChange={e => save({ nightShift: e.target.checked })} />Run the night shift</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={o.settings.redrafts} onChange={e => save({ nightShiftRedrafts: e.target.checked })} />Write a second draft of replies I rate 👎</label>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block"><span className="block text-xs text-[var(--text-secondary)] mb-1">Start after I'm quiet for (min)</span>
            <input type="number" min={5} max={240} className={btn.input} defaultValue={o.settings.idleMinutes}
              onBlur={e => { const n = Math.max(5, Math.min(240, Number(e.target.value) || 20)); if (n !== o.settings.idleMinutes) save({ nightShiftIdleMinutes: n }); }} /></label>
          <label className="block"><span className="block text-xs text-[var(--text-secondary)] mb-1">Only between (blank = any time)</span>
            <input className={clsx(btn.input, !winOk && 'border-red-500')} placeholder="01:00-07:00" value={win} onChange={e => setWin(e.target.value.trim())}
              onBlur={() => { if (winOk && win !== o.settings.window) save({ nightShiftWindow: win }); }} /></label>
          <label className="block"><span className="block text-xs text-[var(--text-secondary)] mb-1">Model</span>
            <input className={btn.input} defaultValue={o.settings.model}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== o.settings.model) save({ nightShiftModel: v }); }} /></label>
          <label className="block"><span className="block text-xs text-[var(--text-secondary)] mb-1">Context window (tokens)</span>
            <input type="number" min={8192} max={262144} step={8192} className={btn.input} defaultValue={o.settings.context}
              onBlur={e => { const n = Math.max(8192, Math.min(262144, Number(e.target.value) || 65536)); if (n !== o.settings.context) save({ nightShiftContext: n }); }} /></label>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] max-w-[65ch]">While a job runs, the everyday model is unloaded to make room. Start a chat and the job stops at once, the big model leaves memory, and the job carries on in the same chat the next time you're away.</p>
      </section>
    </div>
  );
}
