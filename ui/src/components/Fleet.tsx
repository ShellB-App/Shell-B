import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Copy, Cpu, KeyRound, Loader2, Lock, MonitorSmartphone, Plus, Power, Server, Terminal, Trash2, X } from 'lucide-react';
import { fmtBytes, req } from '../api';
import { copyText } from '../quote';
import { btn, relTime } from './common';
import { t as tx } from '../i18n';

type Mode = 'off' | 'overflow' | 'spread';
interface Gpu { name: string; memTotal: number | null; memUsed: number | null; util: number | null; temp: number | null }
interface Machine {
  id: string; name: string; url: string; kind: 'local' | 'agent' | 'ollama'; enabled: boolean; slots: number; private: boolean;
  up: boolean; error: string; seen?: number; latencyMs?: number; inflight: number; served: number; hasToken?: boolean;
  models: { name: string; size: number }[]; loaded: { name: string; size: number; vram: number }[];
  info: { name?: string; os?: string; arch?: string; cpus?: number; memory?: { total: number; available: number }; gpus?: Gpu[]; helper?: string; ollama?: { version?: string } };
}
interface Job { node: string; model: string; state: 'running' | 'done' | 'error' | 'cancelled'; status: string; completed: number; total: number; error: string }
interface Overview { mode: Mode; localSlots: number; cell: boolean; local: Machine; nodes: Machine[]; jobs: Job[] }
interface Setup { linux: string; windows: string; service: string }

const J = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const api = {
  get: () => req<Overview>('/api/fleet'),
  config: (b: { mode?: Mode; localSlots?: number }) => req<Overview>('/api/fleet/config', J('PUT', b)),
  add: (b: { name: string; url: string; kind: string; slots: number }) => req<{ node: Machine; setup: Setup | null }>('/api/fleet/nodes', J('POST', b)),
  patch: (id: string, b: Partial<Pick<Machine, 'name' | 'enabled' | 'private' | 'slots'>>) => req(`/api/fleet/nodes/${id}`, J('PATCH', b)),
  remove: (id: string) => req(`/api/fleet/nodes/${id}`, { method: 'DELETE' }),
  setup: (id: string) => req<Setup>(`/api/fleet/nodes/${id}/setup`),
  token: (id: string) => req<Setup>(`/api/fleet/nodes/${id}/token`, { method: 'POST' }),
  copy: (id: string, model: string) => req(`/api/fleet/nodes/${id}/models`, J('POST', { model })),
  drop: (id: string, model: string) => req(`/api/fleet/nodes/${id}/models/${model.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }),
  cancel: (node: string, model: string) => req('/api/fleet/jobs/cancel', J('POST', { node, model })),
  dismiss: (node: string, model: string) => req('/api/fleet/jobs/dismiss', J('POST', { node, model })),
};
const NUM = btn.input.replace('w-full', 'w-16 shrink-0');
const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '').replace('admin-key-required', 'Only the signed-in owner can change the fleet.');

const MODES: [Mode, string, string][] = [
  ['off', 'Only the Spark', 'Every model call stays on this machine.'],
  ['overflow', 'Overflow', 'The Spark first. Other machines take requests only while the Spark is full, or when only they have the model.'],
  ['spread', 'Spread', 'Each request goes to the least busy machine that has the model, preferring one where it is already loaded.'],
];

function SetupBox({ setup, onClose }: { setup: Setup; onClose?: () => void }) {
  const [os, setOs] = useState<'linux' | 'windows'>(navigator.userAgent.includes('Windows') ? 'windows' : 'linux');
  const cmd = setup[os];
  return (
    <div className="mt-3 p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] space-y-2">
      <div className="flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <span className="text-xs font-medium flex-1">{tx('Run this on the machine')}</span>
        <div className="inline-flex p-0.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)]" role="tablist">
          {(['linux', 'windows'] as const).map(k => (
            <button key={k} role="tab" aria-selected={os === k} onClick={() => setOs(k)}
              className={clsx('px-2 py-0.5 rounded text-[11px]', os === k ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              {k === 'linux' ? tx('Linux · macOS') : tx('Windows PowerShell')}</button>
          ))}
        </div>
        {onClose && <button className={btn.icon} onClick={onClose} aria-label={tx('Hide setup')}><X className="w-3.5 h-3.5" /></button>}
      </div>
      <div className="flex items-start gap-2">
        <pre className="flex-1 p-2 rounded bg-[var(--bg-code)] text-[11px] font-mono whitespace-pre-wrap break-all">{cmd}</pre>
        <button className={btn.icon} title={tx('Copy')} onClick={() => copyText(cmd, 'Command copied')}><Copy className="w-3.5 h-3.5" /></button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] max-w-[75ch]">
        {tx('Needs Python 3.9+ and')} <a className="underline hover:text-[var(--text-primary)]" href="https://ollama.com/download" target="_blank" rel="noreferrer">{tx('Ollama')}</a> {tx('on that machine, and both machines on your tailnet. The token in the command is this machine\'s own key: treat it like a password. To keep it running after sign-out, run the same command again with')} <code className="font-mono">--install-service</code> {tx('at the end.')}
      </p>
    </div>
  );
}

function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="min-w-0">
      <div className="flex justify-between text-[11px] text-[var(--text-muted)]"><span>{label}</span><span className="font-mono">{fmtBytes(used)} / {fmtBytes(total)}</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div className={clsx('h-full', pct > 92 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-[var(--accent)]')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MachineCard({ m, sparkModels, jobs, working, act, reload }: {
  m: Machine; sparkModels: string[]; jobs: Job[]; working: string; act: (k: string, f: () => Promise<unknown>) => Promise<void>; reload: () => void;
}) {
  const local = m.kind === 'local';
  const [setup, setSetup] = useState<Setup | null>(null);
  const [pick, setPick] = useState('');
  const [confirm, setConfirm] = useState(false);
  const waiting = !m.up && !m.seen;
  const mem = m.info.memory;
  const missing = sparkModels.filter(s => !m.models.some(x => x.name.toLowerCase() === s.toLowerCase()));
  const loaded = new Set(m.loaded.map(l => l.name.replace(/:latest$/, '').toLowerCase()));
  return (
    <div className={clsx('rounded-xl border bg-[var(--bg-secondary)]', m.enabled ? 'border-[var(--border-subtle)]' : 'border-dashed border-[var(--border-subtle)] opacity-75')}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className={clsx('mt-1.5 w-2 h-2 rounded-full shrink-0', m.up ? 'bg-emerald-400' : waiting ? 'bg-amber-400 animate-pulse' : 'bg-red-500')}
          title={m.up ? tx('Online') : waiting ? tx('Waiting for the machine') : tx('Offline')} />
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2">
            {local ? <Server className="w-4 h-4 text-[var(--text-muted)]" /> : <MonitorSmartphone className="w-4 h-4 text-[var(--text-muted)]" />}
            <span className="text-sm font-semibold tracking-tight">{m.name}</span>
            {local && <span className="px-1.5 rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-muted)]">{tx('this machine')}</span>}
            {m.private && !local && <span className="flex items-center gap-1 px-1.5 rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-muted)]" title={tx('Incognito chats and Aphrodite may run here')}><Lock className="w-2.5 h-2.5" />private</span>}
            {!m.enabled && <span className="px-1.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">paused</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-muted)] font-mono truncate">
            {local ? tx('Ollama on this Spark') : m.url}{m.info.os ? ` · ${m.info.os}` : ''}{m.info.ollama?.version ? tx(' · Ollama {version}', { version: m.info.ollama.version }) : ''}
            {!local && m.up && m.latencyMs != null ? tx(' · {latencyMs} ms', { latencyMs: m.latencyMs }) : ''}
          </div>
          {!m.up && (waiting
            ? <div className="mt-1 text-[11px] text-amber-500">{tx('Waiting for this machine. Run the setup command on it.')}</div>
            : <div className="mt-1 text-[11px] text-red-400 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-px shrink-0" />{m.error || tx('Offline')}{m.seen ? tx(' · last seen {v0}', { v0: relTime(m.seen * 1000) }) : ''}</div>)}
        </div>
        <div className="text-right">
          <div className="text-sm font-mono tabular-nums">{m.inflight}<span className="text-[var(--text-muted)]">/{m.slots}</span></div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tx('busy · {served} served', { served: m.served })}</div>
        </div>
      </div>

      {(mem?.total || (m.info.gpus?.length ?? 0) > 0) && (
        <div className="grid gap-3 sm:grid-cols-2 px-4 pb-3">
          {mem && mem.total > 0 && <Meter label={tx('Memory')} used={mem.total - mem.available} total={mem.total} />}
          {m.info.gpus?.map((g, i) => g.memTotal ? <Meter key={i} label={`${g.name}${g.util != null ? ` · ${g.util}%` : ''}`} used={g.memUsed ?? 0} total={g.memTotal} /> : null)}
        </div>
      )}

      {m.up && (
        <div className="px-4 pb-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{m.models.length} {tx('models ·')} {fmtBytes(m.models.reduce((a, x) => a + x.size, 0))}</div>
          <div className="flex flex-wrap gap-1.5">
            {m.models.map(x => (
              <span key={x.name} className="group inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-[11px] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                {loaded.has(x.name.toLowerCase()) && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title={tx('Loaded')} />}
                <span className="font-mono">{x.name}</span>
                {!local && <button className="p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400" title={tx('Delete {name} from {v0}', { name: x.name, v0: m.name })}
                  onClick={() => window.confirm(`Delete ${x.name} from ${m.name}?`) && act(`x:${m.id}:${x.name}`, () => api.drop(m.id, x.name))}><X className="w-3 h-3" /></button>}
              </span>
            ))}
            {m.models.length === 0 && <span className="text-[11px] text-[var(--text-muted)]">{tx('No models yet. Copy one from the Spark below.')}</span>}
          </div>
          {jobs.map(j => (
            <div key={j.model} className="mt-2 space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-medium">{j.model}</span>
                <span className={clsx('flex-1 truncate', j.state === 'error' ? 'text-red-400' : j.state === 'done' ? 'text-emerald-500' : 'text-[var(--text-muted)]')}>
                  {j.state === 'error' ? j.error : j.status}{j.state === 'running' && j.total ? tx(' · {v0} of {v1}', { v0: fmtBytes(j.completed), v1: fmtBytes(j.total) }) : ''}</span>
                {j.state === 'running'
                  ? <button className={btn.ghost} onClick={() => act(`c:${m.id}`, () => api.cancel(m.id, j.model))}>{tx('Cancel')}</button>
                  : <button className={btn.icon} onClick={() => act(`d:${m.id}`, () => api.dismiss(m.id, j.model))} aria-label={tx('Dismiss')}><X className="w-3.5 h-3.5" /></button>}
              </div>
              {j.state === 'running' && <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${j.total ? (j.completed / j.total) * 100 : 2}%` }} /></div>}
            </div>
          ))}
          {!local && missing.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              <select className={clsx(btn.input, 'flex-1 min-w-[200px] font-mono')} value={pick} onChange={e => setPick(e.target.value)} aria-label={tx('Model to copy')}>
                <option value="">{tx('Copy a model from the Spark…')}</option>
                {missing.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button className={btn.subtle} disabled={!pick || working === `p:${m.id}`}
                onClick={() => act(`p:${m.id}`, async () => { await api.copy(m.id, pick); setPick(''); })}>
                {working === `p:${m.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}{tx('Copy to')} {m.name}</button>
            </div>
          )}
        </div>
      )}

      {!local && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-t border-[var(--border-subtle)]">
          <label className="flex items-center gap-1.5 px-2 text-[11px] text-[var(--text-secondary)]" title={tx('How many requests this machine runs at once (its OLLAMA_NUM_PARALLEL)')}>
            {tx('Slots')}
            <input type="number" min={1} max={16} className={clsx(NUM, 'py-0.5 text-xs')} defaultValue={m.slots}
              onBlur={e => { const v = Number(e.target.value); if (v !== m.slots && v >= 1) act(`s:${m.id}`, () => api.patch(m.id, { slots: v })); }} />
          </label>
          <label className="flex items-center gap-1.5 px-2 text-[11px] text-[var(--text-secondary)]" title={tx('Let incognito chats and Aphrodite run here too. Leave off unless this machine is as private as the Spark.')}>
            <input type="checkbox" checked={m.private} onChange={e => act(`v:${m.id}`, () => api.patch(m.id, { private: e.target.checked }))} />{tx('Private')}
          </label>
          <span className="flex-1" />
          {m.kind === 'agent' && <>
            <button className={btn.ghost} onClick={() => setup ? setSetup(null) : act(`u:${m.id}`, async () => setSetup(await api.setup(m.id)))}><Terminal className="w-3.5 h-3.5" />{tx('Setup')}</button>
            <button className={btn.ghost} title={tx('Make a new token. The machine must run the new setup command.')}
              onClick={() => window.confirm(`Make a new token for ${m.name}? It stops working until you run the new setup command there.`) && act(`t:${m.id}`, async () => setSetup(await api.token(m.id)))}>
              <KeyRound className="w-3.5 h-3.5" />{tx('New token')}</button>
          </>}
          <button className={btn.ghost} onClick={() => act(`e:${m.id}`, () => api.patch(m.id, { enabled: !m.enabled }))}>
            <Power className="w-3.5 h-3.5" />{m.enabled ? tx('Pause') : tx('Resume')}</button>
          {confirm
            ? <><button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={() => act(`r:${m.id}`, () => api.remove(m.id))}>{tx('Remove')}</button>
              <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirm(false)}>{tx('Keep')}</button></>
            : <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Remove from the fleet (its models stay on it)')} onClick={() => setConfirm(true)}><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      )}
      {setup && <div className="px-4 pb-4"><SetupBox setup={setup} onClose={() => { setSetup(null); reload(); }} /></div>}
    </div>
  );
}

/** #/models/fleet: other machines that run Shell:B's local models, and how requests are shared between them. */
export function Fleet() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', kind: 'agent', slots: 1 });
  const [fresh, setFresh] = useState<{ name: string; setup: Setup } | null>(null);

  const load = useCallback(() => api.get().then(d => { setO(d); setError(''); }).catch(e => setError(clean(e))), []);
  useEffect(() => { load(); }, [load]);
  const running = o?.jobs.some(j => j.state === 'running') || o?.nodes.some(n => !n.up && !n.seen);
  useEffect(() => { const t = setInterval(load, running ? 2000 : 6000); return () => clearInterval(t); }, [load, running]);

  const act = async (key: string, f: () => Promise<unknown>) => {
    setWorking(key); setError('');
    try { await f(); } catch (e) { setError(clean(e)); }
    await load(); setWorking('');
  };
  const add = () => act('add', async () => {
    const r = await api.add(form);
    if (r.setup) setFresh({ name: r.node.name, setup: r.setup });
    setAdding(false); setForm({ name: '', url: '', kind: 'agent', slots: 1 });
  });

  if (!o) return error ? <div className="text-xs text-red-400">{error}</div> : <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
  if (o.cell) return <p className="text-sm text-[var(--text-secondary)]">{tx('The fleet is managed on the host Shell:B.')}</p>;
  const sparkModels = o.local.models.map(m => m.name);
  const up = o.nodes.filter(n => n.up && n.enabled).length;

  return (
    <div className="space-y-8">
      {error && <div className="flex items-start gap-2 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{error}</div>}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('Sharing the work')}</h2>
        <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={tx('How requests are shared')}>
            {MODES.map(([id, label, desc]) => (
              <button key={id} role="radio" aria-checked={o.mode === id} disabled={working === 'mode'}
                onClick={() => o.mode !== id && act('mode', () => api.config({ mode: id }))}
                className={clsx('text-left p-3 rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                  o.mode === id ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>
                <div className="text-sm font-medium">{label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">{desc}</div>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--text-muted)] max-w-[75ch]">
            {tx('Only model calls travel: agents, tools, files and memories stay on the Spark. Incognito chats and Aphrodite never leave it unless a machine is marked private. A machine that stops answering is skipped and the Spark takes over.')}
            {o.mode !== 'off' && o.nodes.length > 0 && tx(' {up} of {length} other machine{v0} online.', { up: up, length: o.nodes.length, v0: o.nodes.length === 1 ? '' : 's' })}
          </p>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]" title={tx('Match OLLAMA_NUM_PARALLEL on the Spark')}>
            {tx('The Spark runs')}
            <input type="number" min={1} max={16} className={clsx(NUM, 'py-0.5 text-xs')} defaultValue={o.localSlots} key={o.localSlots}
              onBlur={e => { const v = Number(e.target.value); if (v >= 1 && v !== o.localSlots) act('slots', () => api.config({ localSlots: v })); }} />
            {tx('requests at once before Overflow sends work elsewhere.')}
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex-1">{tx('Machines · {v0}', { v0: o.nodes.length + 1 })}</h2>
          {!adding && <button className={btn.primary} onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" />{tx('Add a machine')}</button>}
        </div>

        {adding && (
          <div className="p-4 rounded-xl border border-[var(--accent)]/50 bg-[var(--bg-secondary)] space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
              <input className={btn.input} placeholder={tx('Name, e.g. Gaming PC')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              <input className={clsx(btn.input, 'font-mono')} placeholder={tx('evie-home  or  100.100.215.122')} value={form.url} autoFocus
                onChange={e => setForm({ ...form, url: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && form.url.trim()) add(); }} />
              <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" title={tx('Requests it runs at once')}>
                {tx('Slots')}<input type="number" min={1} max={16} className={NUM} value={form.slots} onChange={e => setForm({ ...form, slots: Number(e.target.value) || 1 })} /></label>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-secondary)]">
              <label className="flex items-center gap-1.5"><input type="radio" checked={form.kind === 'agent'} onChange={() => setForm({ ...form, kind: 'agent' })} />
                {tx('With the Shell:B helper')} <span className="text-[var(--text-muted)]">{tx('(recommended: token-protected, shows memory and GPUs)')}</span></label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={form.kind === 'ollama'} onChange={() => setForm({ ...form, kind: 'ollama' })} />
                {tx('Plain Ollama URL')} <span className="text-[var(--text-muted)]">{tx('(no token; only on a network you trust)')}</span></label>
            </div>
            <div className="flex gap-2">
              <button className={btn.primary} disabled={!form.url.trim() || working === 'add'} onClick={add}>
                {working === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}{tx('Add machine')}</button>
              <button className={btn.ghost} onClick={() => setAdding(false)}>{tx('Cancel')}</button>
            </div>
          </div>
        )}

        {fresh && (
          <div className="p-4 rounded-xl border border-[var(--accent)]/50 bg-[var(--bg-secondary)]">
            <div className="text-sm font-medium">{tx('{name} was added. Now start the helper there.', { name: fresh.name })}</div>
            <SetupBox setup={fresh.setup} onClose={() => setFresh(null)} />
          </div>
        )}

        <div className="space-y-3">
          {[o.local, ...o.nodes].map(m => (
            <MachineCard key={m.id} m={m} sparkModels={sparkModels} jobs={o.jobs.filter(j => j.node === m.id)} working={working} act={act} reload={load} />
          ))}
        </div>
        {o.nodes.length === 0 && !adding && (
          <p className="text-xs text-[var(--text-muted)] max-w-[65ch]">
            {tx('No other machines yet. Any computer with an NVIDIA or Apple GPU and Ollama can help: add it, run one command on it, then copy the models it should run. Shell:B decides where each request goes.')}
          </p>
        )}
      </section>
    </div>
  );
}
