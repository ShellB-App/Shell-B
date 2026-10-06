import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, Cpu, Download, HardDrive, Loader2, Play, Power, RotateCw, Trash2, X } from 'lucide-react';
import { fmtBytes, req } from '../api';
import { btn, relTime } from './common';

interface Installed {
  name: string; size: number; modifiedAt?: string; family: string; parameterSize: string; quantization: string;
  capabilities: string[]; usedBy: string[]; custom: boolean;
}
interface Loaded { name: string; size: number; vram: number; context?: number; expiresAt?: string; usedBy: string[] }
interface Gpu { id: string; label: string; bytes: number; freeable: boolean }
interface Pull { name: string; state: 'running' | 'done' | 'error' | 'cancelled'; status: string; completed: number; total: number; error: string; started: number }
interface Overview {
  installed: Installed[]; loaded: Loaded[]; gpu: Gpu[]; memory: { MemTotal: number; MemAvailable: number };
  disk: { total: number; free: number } | null; pulls: Pull[];
}
interface Details { modelfile: string; parameters: string; system: string; license: string; contextLength?: number; architecture?: string; parameterCount?: number; capabilities: string[] }

const J = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const hub = {
  overview: () => req<Overview>('/api/modelhub/overview'),
  unload: (b: { model?: string; service?: string }) => req('/api/modelhub/unload', J(b)),
  load: (model: string) => req('/api/modelhub/load', J({ model })),
  show: (name: string) => req<Details>(`/api/modelhub/show/${name.split('/').map(encodeURIComponent).join('/')}`),
  pull: (model: string) => req<Pull>('/api/modelhub/pull', J({ model })),
  cancel: (model: string) => req('/api/modelhub/pull/cancel', J({ model })),
  dismiss: (model: string) => req('/api/modelhub/pull/dismiss', J({ model })),
  remove: (name: string, force = false) => req(`/api/modelhub/installed/${name.split('/').map(encodeURIComponent).join('/')}?force=${force}`, { method: 'DELETE' }),
};
const COLORS = ['#c96442', '#0284c7', '#059669', '#a855f7', '#d97706', '#db2777'];
const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '').replace('admin-key-required', 'Only the signed-in owner can do this (or enter the admin key).');

function until(iso?: string) {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s > 3600 * 24 * 365) return 'stays loaded';
  if (s <= 60) return 'unloads any moment';
  return `unloads in ${s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`}`;
}

function DetailsRow({ name }: { name: string }) {
  const [d, setD] = useState<Details | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { hub.show(name).then(setD).catch(e => setErr(clean(e))); }, [name]);
  if (err) return <div className="text-xs text-red-400">{err}</div>;
  if (!d) return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-secondary)]">
        {d.architecture && <span>Architecture <b className="font-medium text-[var(--text-primary)]">{d.architecture}</b></span>}
        {d.parameterCount && <span>Parameters <b className="font-medium text-[var(--text-primary)]">{(d.parameterCount / 1e9).toFixed(1)} B</b></span>}
        {d.contextLength && <span>Native context <b className="font-medium text-[var(--text-primary)]">{d.contextLength.toLocaleString()}</b></span>}
      </div>
      {d.system && <div><div className="text-[var(--text-muted)] mb-0.5">System prompt</div><pre className="p-2 rounded bg-[var(--bg-code)] whitespace-pre-wrap max-h-40 overflow-auto">{d.system}</pre></div>}
      {d.parameters && <div><div className="text-[var(--text-muted)] mb-0.5">Parameters</div><pre className="p-2 rounded bg-[var(--bg-code)] whitespace-pre-wrap max-h-32 overflow-auto">{d.parameters}</pre></div>}
      <details><summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]">Modelfile</summary>
        <pre className="mt-1 p-2 rounded bg-[var(--bg-code)] whitespace-pre-wrap max-h-64 overflow-auto">{d.modelfile}</pre></details>
      {d.license && <details><summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]">License</summary>
        <pre className="mt-1 p-2 rounded bg-[var(--bg-code)] whitespace-pre-wrap max-h-64 overflow-auto">{d.license}</pre></details>}
    </div>
  );
}

/** #/models: installed Ollama models, what is holding memory right now, and pull / load / unload / delete. */
export function Models({ busyTurns }: { busyTurns: number }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [pullName, setPullName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(() => hub.overview().then(d => { setO(d); setError(''); }).catch(e => setError(clean(e))), []);
  useEffect(() => { load(); }, [load]);
  const pulling = o?.pulls.some(p => p.state === 'running');
  useEffect(() => { const t = setInterval(load, pulling ? 1500 : 8000); return () => clearInterval(t); }, [load, pulling]);

  const act = async (key: string, f: () => Promise<unknown>) => {
    setWorking(key); setError('');
    try { await f(); } catch (e) { setError(clean(e)); }
    await load(); setWorking('');
  };
  const unload = (b: { model?: string; service?: string }, what: string) => {
    if (busyTurns && !window.confirm(`${busyTurns} agent turn${busyTurns === 1 ? ' is' : 's are'} running. Unloading ${what} may cut one short. Unload anyway?`)) return;
    act(`u:${b.model ?? b.service}`, () => hub.unload(b));
  };

  const mem = o?.memory;
  const used = mem ? mem.MemTotal - mem.MemAvailable : 0;
  const segs = o ? [
    ...o.loaded.map(l => ({ key: `m:${l.name}`, label: l.name, bytes: l.size })),
    ...o.gpu.filter(g => g.id !== 'ollama.service').map(g => ({ key: `s:${g.id}`, label: g.label, bytes: g.bytes })),
  ] : [];
  const other = Math.max(0, used - segs.reduce((a, s) => a + s.bytes, 0));
  const shown = (o?.installed ?? []).filter(m => !q || `${m.name} ${m.family} ${m.usedBy.join(' ')}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-8 animate-fade-in space-y-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold tracking-tight flex-1">Models</h1>
            <button className={btn.icon} onClick={load} title="Refresh"><RotateCw className="w-4 h-4" /></button>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">What's installed, what's holding memory right now, and room to change both. A loaded model uses unified memory nothing else can use.</p>
          {error && <div className="mt-3 flex items-start gap-2 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{error}</div>}
        </div>

        {!o ? <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div> : <>
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Memory right now</h2>
            {mem && (
              <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
                <div className="h-4 rounded-full bg-[var(--bg-tertiary)] overflow-hidden flex" role="img"
                  aria-label={`${fmtBytes(used)} of ${fmtBytes(mem.MemTotal)} in use`}>
                  {segs.map((s, i) => <div key={s.key} className="h-full border-r border-[var(--bg-secondary)]" title={`${s.label} · ${fmtBytes(s.bytes)}`}
                    style={{ width: `${(s.bytes / mem.MemTotal) * 100}%`, background: COLORS[i % COLORS.length] }} />)}
                  <div className="h-full bg-[var(--text-muted)]/40" style={{ width: `${(other / mem.MemTotal) * 100}%` }} title={`System and other programs · ${fmtBytes(other)}`} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]">
                  {segs.map((s, i) => <span key={s.key} className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />{s.label} <span className="font-mono text-[var(--text-muted)]">{fmtBytes(s.bytes)}</span></span>)}
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[var(--text-muted)]/40" />System and other programs <span className="font-mono text-[var(--text-muted)]">{fmtBytes(other)}</span></span>
                  <span className="ml-auto font-mono">{fmtBytes(mem.MemAvailable)} free of {fmtBytes(mem.MemTotal)}</span>
                </div>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {o.loaded.map(l => (
                <div key={l.name} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  <Cpu className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{l.name}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">{fmtBytes(l.size)}{l.context ? ` · context ${l.context.toLocaleString()}` : ''} · {until(l.expiresAt)}</div>
                    {l.usedBy.length > 0 && <div className="text-[11px] text-[var(--text-secondary)] truncate" title={l.usedBy.join(', ')}>For {l.usedBy.join(', ')}</div>}
                  </div>
                  <button className={btn.subtle} disabled={working === `u:${l.name}`} onClick={() => unload({ model: l.name }, l.name)}>
                    {working === `u:${l.name}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}Unload</button>
                </div>
              ))}
              {o.gpu.filter(g => g.id !== 'ollama.service').map(g => (
                <div key={g.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  <Cpu className="w-4 h-4 mt-0.5 text-sky-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{g.label}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">{fmtBytes(g.bytes)} of GPU memory</div>
                  </div>
                  {g.freeable && <button className={btn.subtle} disabled={working === `u:${g.id}`} onClick={() => unload({ service: g.id }, g.label)}>
                    {working === `u:${g.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}Free</button>}
                </div>
              ))}
              {o.loaded.length === 0 && <div className="text-xs text-[var(--text-muted)] p-3">No language models are loaded. They load on first use.</div>}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Get a model</h2>
            <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
              <div className="flex flex-wrap gap-2">
                <input className={clsx(btn.input, 'flex-1 min-w-[220px] font-mono')} value={pullName} onChange={e => setPullName(e.target.value)}
                  placeholder="qwen3:8b   or   hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M"
                  onKeyDown={e => { if (e.key === 'Enter' && pullName.trim()) act('pull', async () => { await hub.pull(pullName.trim()); setPullName(''); }); }} />
                <button className={btn.primary} disabled={!pullName.trim() || working === 'pull'} onClick={() => act('pull', async () => { await hub.pull(pullName.trim()); setPullName(''); })}>
                  <Download className="w-3.5 h-3.5" />Download</button>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
                <span>Names from <a className="underline hover:text-[var(--text-primary)]" href="https://ollama.com/library" target="_blank" rel="noreferrer">ollama.com/library</a>, or any GGUF on Hugging Face as hf.co/&lt;user&gt;/&lt;repo&gt;:&lt;quant&gt;.</span>
                {o.disk && <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />{fmtBytes(o.disk.free)} free on disk</span>}
              </p>
              {o.pulls.map(p => (
                <div key={p.name} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-medium truncate">{p.name}</span>
                    <span className={clsx('flex-1 truncate', p.state === 'error' ? 'text-red-400' : p.state === 'done' ? 'text-emerald-500' : 'text-[var(--text-muted)]')}>
                      {p.state === 'error' ? p.error : p.status}{p.state === 'running' && p.total ? ` · ${fmtBytes(p.completed)} of ${fmtBytes(p.total)}` : ''}</span>
                    {p.state === 'running'
                      ? <button className={btn.ghost} onClick={() => act(`c:${p.name}`, () => hub.cancel(p.name))}>Cancel</button>
                      : <button className={btn.icon} onClick={() => act(`d:${p.name}`, () => hub.dismiss(p.name))} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>}
                  </div>
                  {p.state === 'running' && <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${p.total ? (p.completed / p.total) * 100 : 2}%` }} /></div>}
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex-1">Installed · {o.installed.length} models · {fmtBytes(o.installed.reduce((a, m) => a + m.size, 0))}</h2>
              <input className={clsx(btn.input, 'w-full sm:w-56')} value={q} onChange={e => setQ(e.target.value)} placeholder="Filter models" />
            </div>
            <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
              {shown.map(m => {
                const isLoaded = o.loaded.some(l => l.name === m.name);
                return (
                  <div key={m.name} className="bg-[var(--bg-secondary)]">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                      <button className="flex items-center gap-2 min-w-0 flex-1 text-left" onClick={() => setOpen(open === m.name ? null : m.name)} aria-expanded={open === m.name}>
                        <ChevronDown className={clsx('w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition', open !== m.name && '-rotate-90')} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="text-sm font-medium truncate">{m.name}</span>
                            {isLoaded && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Loaded" />}
                            {m.custom && <span className="px-1.5 rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-muted)]">Shell:B</span>}
                          </span>
                          <span className="block text-[11px] text-[var(--text-muted)] truncate">
                            {[m.family, m.parameterSize, m.quantization, m.capabilities.filter(c => c !== 'completion').join(', ')].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                      <span className="text-[11px] text-[var(--text-secondary)] max-w-[220px] truncate hidden md:block" title={m.usedBy.join(', ')}>
                        {m.usedBy.length ? `Used by ${m.usedBy.join(', ')}` : <span className="text-[var(--text-muted)]">Not used by any agent</span>}</span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)] w-16 text-right">{fmtBytes(m.size)}</span>
                      <div className="flex items-center gap-1">
                        {!isLoaded ? (
                          <button className={btn.ghost} title="Load it now so the first message doesn't wait" disabled={working === `l:${m.name}`}
                            onClick={() => act(`l:${m.name}`, () => hub.load(m.name))}>
                            {working === `l:${m.name}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Load</button>
                        ) : <button className={btn.ghost} onClick={() => unload({ model: m.name }, m.name)}><Power className="w-3.5 h-3.5" />Unload</button>}
                        {confirm === m.name ? (<>
                          <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30"
                            onClick={() => { setConfirm(null); act(`x:${m.name}`, () => hub.remove(m.name, m.usedBy.length > 0)); }}>Delete{m.usedBy.length ? ' anyway' : ''}</button>
                          <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirm(null)}>Keep</button>
                        </>) : (
                          <button className={clsx(btn.icon, 'hover:text-red-400')} title="Delete from disk" onClick={() => setConfirm(m.name)}
                            disabled={working === `x:${m.name}`}>{working === `x:${m.name}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}</button>
                        )}
                      </div>
                    </div>
                    {confirm === m.name && m.usedBy.length > 0 && (
                      <div className="px-3 pb-2 text-[11px] text-amber-500">{m.usedBy.join(', ')} use{m.usedBy.length === 1 ? 's' : ''} this model and will stop working until you pick another one in the Agent Lab or Settings.</div>
                    )}
                    {open === m.name && <div className="px-9 pb-3"><DetailsRow name={m.name} />
                      {m.modifiedAt && <div className="mt-2 text-[11px] text-[var(--text-muted)]">Downloaded or changed {relTime(Date.parse(m.modifiedAt))}</div>}</div>}
                  </div>
                );
              })}
            </div>
          </section>
        </>}
      </div>
    </div>
  );
}
