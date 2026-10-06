import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, AudioWaveform, Check, CircleStop, Columns2, CornerUpLeft, Dices, Download, History, ImageIcon, Loader2,
  Music, RotateCcw, Shapes, X, type LucideIcon } from 'lucide-react';
import { req } from '../api';
import { assetsApi, type AssetLib } from '../assetsApi';
import { AudioCard } from './AudioCard';
import { btn, relTime } from './common';

/** The Generate playground (#/generate): images, music and sound effects straight from the generators, no chat turn.
 *  Jobs and history come from server/generate.py; keepers go to an asset library through Media's /to-assets. */

type Kind = 'image' | 'music' | 'sfx';
type ServiceId = 'nyx' | 'orpheus' | 'stableaudio';
interface Params {
  seed?: number | null; width?: number; height?: number; steps?: number; quality?: 'draft' | 'high';
  duration?: number; guidance?: number; loop?: boolean;
}
interface JobResult { url: string; seed: number | null; model: string; elapsed: number | null; seconds?: number; mediaId: string | null }
interface Job {
  id: string; kind: Kind; prompt: string; params: Params; service: ServiceId; engine: string | null; count: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'cancelled'; results: JobResult[]; error: string | null;
  note: string | null; created: number; started: number | null; finished: number | null; ahead: number;
}
interface Overview { services: Record<ServiceId, { ok: boolean; error?: string }> & { fluxDev: boolean }; jobs: Job[]; maxCount: number }
interface HistItem { mediaId: string; url: string; kind: Kind; prompt: string; seed: number | null; params: Params; model: string | null; job: string | null; createdAt: number }
/** One generated file, whether it came from a live job or from history. */
interface Item { key: string; url: string; kind: Kind; prompt: string; seed: number | null; params: Params; model: string | null;
  mediaId: string | null; elapsed?: number | null; createdAt: number }

const gen = {
  overview: () => req<Overview>('/api/generate'),
  start: (kind: Kind, prompt: string, params: Params, count: number) =>
    req<Job>('/api/generate', { method: 'POST', body: JSON.stringify({ kind, prompt, params, count }) }),
  stop: (id: string) => req<Job>(`/api/generate/jobs/${id}/stop`, { method: 'POST' }),
  forget: (id: string) => req(`/api/generate/jobs/${id}`, { method: 'DELETE' }),
  history: (kind = '') => req<{ items: HistItem[] }>(`/api/generate/history${kind ? `?kind=${kind}` : ''}`),
  toAssets: (mediaId: string, libId: string) =>
    req<{ status: string; lib: { id: string; name: string } }>(`/api/media/${mediaId}/to-assets`, { method: 'POST', body: JSON.stringify({ libId }) }),
};

const KINDS: { id: Kind; label: string; noun: [string, string]; icon: LucideIcon; tint: string }[] = [
  { id: 'image', label: 'Image', noun: ['image', 'images'], icon: ImageIcon, tint: 'text-sky-400' },
  { id: 'music', label: 'Music', noun: ['track', 'tracks'], icon: Music, tint: 'text-pink-400' },
  { id: 'sfx', label: 'Sound effect', noun: ['sound', 'sounds'], icon: AudioWaveform, tint: 'text-amber-400' },
];
const kindDef = (k: Kind) => KINDS.find(x => x.id === k)!;

const SERVICE: Record<ServiceId, { name: string; what: string; unit: string; port: number }> = {
  nyx: { name: 'NYX', what: 'ComfyUI / FLUX', unit: 'shellb-nyx', port: 8188 },
  orpheus: { name: 'ORPHEUS', what: 'MusicGen', unit: 'shellb-orpheus', port: 8002 },
  stableaudio: { name: 'Stable Audio', what: 'Stable Audio Open', unit: 'shellb-stableaudio', port: 8003 },
};

const SIZES = [
  { label: 'Square', w: 1024, h: 1024 }, { label: 'Portrait', w: 832, h: 1216 },
  { label: 'Landscape', w: 1216, h: 832 }, { label: 'Wide', w: 1344, h: 768 },
];
const DEFAULTS: Record<Kind, Params> = {
  image: { width: 1024, height: 1024, steps: 4, quality: 'draft' },
  music: { duration: 12, guidance: 3, loop: false },
  sfx: { duration: 4, steps: 100, loop: false },
};
const PLACEHOLDER: Record<Kind, string> = {
  image: 'A lighthouse on a basalt cliff at dusk, long exposure, sea spray, 35mm film grain',
  music: 'Warm lo-fi hip hop, dusty Rhodes chords, brushed drums, vinyl crackle, 82 BPM',
  sfx: 'Heavy oak door creaks open slowly in a stone hall, close mic, natural reverb',
};

const PREFS = 'shellb.generate.v1';
function loadPrefs(): { kind: Kind; params: Record<Kind, Params>; count: number } {
  const base = { kind: 'image' as Kind, params: { ...DEFAULTS }, count: 2 };
  try {
    const s = JSON.parse(localStorage.getItem(PREFS) || 'null');
    if (s && KINDS.some(k => k.id === s.kind)) return { kind: s.kind, count: s.count || 2,
      params: { image: { ...DEFAULTS.image, ...s.params?.image, seed: null }, music: { ...DEFAULTS.music, ...s.params?.music },
        sfx: { ...DEFAULTS.sfx, ...s.params?.sfx, seed: null } } };
  } catch { /* storage blocked: defaults */ }
  return base;
}

const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '');
const fmtSecs = (s?: number | null) => (s == null ? '' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);

function paramLine(kind: Kind, p: Params, model?: string | null) {
  if (kind === 'image') return [`${p.width}×${p.height}`, `${p.steps} steps`, p.quality === 'high' ? 'FLUX.1-dev' : 'schnell'].join(' · ');
  const parts = [fmtSecs(p.duration)];
  if (kind === 'music') parts.push(`guidance ${p.guidance}`);
  if (kind === 'sfx' && model?.includes('stable-audio')) parts.push(`${p.steps} steps`);
  if (kind === 'sfx' && model?.includes('audiogen')) parts.push('AudioGen');
  if (p.loop) parts.push('loop');
  return parts.join(' · ');
}

/** What's needed for this kind, and what's down. */
function readiness(kind: Kind, s?: Overview['services']): { blocked: string | null; note: string | null } {
  if (!s) return { blocked: null, note: null };
  const down = (id: ServiceId) => `${SERVICE[id].name} (${SERVICE[id].what}, :${SERVICE[id].port}) isn't responding. Start it with systemctl --user start ${SERVICE[id].unit}.`;
  if (kind === 'image') return { blocked: s.nyx.ok ? null : down('nyx'), note: null };
  if (kind === 'music') return { blocked: s.orpheus.ok ? null : down('orpheus'), note: null };
  if (s.stableaudio.ok) return { blocked: null, note: null };
  if (s.orpheus.ok) return { blocked: null, note: 'Stable Audio is down, so sounds will come from AudioGen on ORPHEUS: 16 kHz mono, no seed or steps.' };
  return { blocked: `Neither Stable Audio (:8003) nor ORPHEUS (:8002) is responding. Start one with systemctl --user start shellb-stableaudio.`, note: null };
}

// ── controls ────────────────────────────────────────────────────────────────

function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string; icon?: LucideIcon; tint?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-0.5 text-xs">
      {options.map(o => (
        <button key={String(o.id)} role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
          className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
            value === o.id ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
          {o.icon && <o.icon className={clsx('w-3.5 h-3.5', value === o.id && o.tint)} />}{o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]" title={hint}>{label}</span>
      {children}
    </label>
  );
}

function Num({ value, onChange, min, max, step = 1, width = 'w-20', ...rest }: {
  value: number | null | undefined; onChange: (v: number | null) => void; min: number; max: number; step?: number; width?: string; placeholder?: string; 'aria-label'?: string;
}) {
  return (
    <input type="number" inputMode="decimal" className={clsx(btn.input, width, 'font-mono text-xs')} min={min} max={max} step={step}
      value={value ?? ''} {...rest}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
      onBlur={e => { if (e.target.value !== '') onChange(Math.max(min, Math.min(max, Number(e.target.value)))); }} />
  );
}

function ParamControls({ kind, p, set, fluxDev, stableOk }: { kind: Kind; p: Params; set: (patch: Params) => void; fluxDev: boolean; stableOk: boolean }) {
  const seed = kind !== 'music' && (
    <Field label="Seed" hint="Leave blank for a random seed. Variations count up from it.">
      <div className="flex gap-1">
        <Num value={p.seed} onChange={v => set({ seed: v == null ? null : Math.round(v) })} min={0} max={2147483647} width="w-32" placeholder="random" aria-label="Seed" />
        <button className={btn.icon} title="Pick a random seed" aria-label="Pick a random seed" onClick={() => set({ seed: Math.floor(Math.random() * 2 ** 31) })}><Dices className="w-4 h-4" /></button>
        {p.seed != null && <button className={btn.icon} title="Back to random" aria-label="Clear seed" onClick={() => set({ seed: null })}><X className="w-4 h-4" /></button>}
      </div>
    </Field>
  );
  if (kind === 'image') return (
    <>
      <Field label="Size">
        <select className={clsx(btn.input, 'text-xs w-44')} value={`${p.width}x${p.height}`} aria-label="Image size"
          onChange={e => { const [w, h] = e.target.value.split('x').map(Number); set({ width: w, height: h }); }}>
          {SIZES.map(s => <option key={s.label} value={`${s.w}x${s.h}`}>{s.label} · {s.w}×{s.h}</option>)}
          {!SIZES.some(s => s.w === p.width && s.h === p.height) && <option value={`${p.width}x${p.height}`}>Custom · {p.width}×{p.height}</option>}
        </select>
      </Field>
      {fluxDev && (
        <Field label="Model">
          <Segmented label="Model" value={p.quality ?? 'draft'} onChange={q => set({ quality: q, steps: q === 'high' ? 24 : 4 })}
            options={[{ id: 'draft', label: 'Schnell' }, { id: 'high', label: 'Dev' }]} />
        </Field>
      )}
      <Field label="Steps" hint={p.quality === 'high' ? 'FLUX.1-dev: 20–30 is the sweet spot' : 'FLUX.1-schnell is distilled for 4 steps; 1–8 allowed'}>
        <Num value={p.steps} onChange={v => set({ steps: v ?? undefined })} min={1} max={p.quality === 'high' ? 50 : 8} width="w-16" aria-label="Steps" />
      </Field>
      {seed}
    </>
  );
  return (
    <>
      <Field label="Length (s)">
        <Num value={p.duration} onChange={v => set({ duration: v ?? undefined })} min={kind === 'music' ? 3 : 0.5} max={kind === 'music' ? 30 : stableOk ? 46 : 30} step={kind === 'music' ? 1 : 0.5} width="w-20" aria-label="Length in seconds" />
      </Field>
      {kind === 'music' ? (
        <Field label="Guidance" hint="How closely MusicGen follows the prompt. 3 is its default; higher is more literal, less varied.">
          <Num value={p.guidance} onChange={v => set({ guidance: v ?? undefined })} min={1} max={10} step={0.5} width="w-16" aria-label="Guidance" />
        </Field>
      ) : stableOk && (
        <Field label="Steps" hint="Stable Audio diffusion steps: 100 is its default, 50 is quicker and usually fine for one-shots.">
          <Num value={p.steps} onChange={v => set({ steps: v ?? undefined })} min={10} max={250} step={10} width="w-20" aria-label="Steps" />
        </Field>
      )}
      <Field label="Loop" hint={kind === 'music' ? 'Crossfades the ends so the track loops without a seam' : 'For ambience: crossfaded into a seamless loop instead of trimmed to the transient'}>
        <button role="switch" aria-checked={!!p.loop} onClick={() => set({ loop: !p.loop })}
          className={clsx('h-[30px] px-2.5 rounded-lg border text-xs transition', p.loop ? 'border-[var(--accent)]/60 bg-[var(--accent)]/15 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
          {p.loop ? 'Seamless' : 'One-shot'}
        </button>
      </Field>
      {seed && stableOk ? seed : null}
    </>
  );
}

// ── results ─────────────────────────────────────────────────────────────────

function SaveToLibrary({ mediaId, libs, loadLibs }: { mediaId: string; libs: AssetLib[] | null; loadLibs: () => void }) {
  const [open, setOpen] = useState(false);
  const [lib, setLib] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (libs && !lib) setLib(libs[0]?.id ?? ''); }, [libs, lib]);
  if (!open) return (
    <button className={btn.ghost} onClick={() => { setOpen(true); loadLibs(); }} title="Copy into an asset library">
      <Shapes className="w-3.5 h-3.5 text-lime-400" />Save
    </button>
  );
  return (
    <div className="basis-full flex flex-col gap-1.5 pt-2">
      {libs === null ? <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Loading libraries…</span>
        : libs.length === 0 ? <span className="text-[11px] text-[var(--text-muted)]">No unlocked asset libraries yet. Make one on the <a className="underline" href="#/assets">Assets</a> page.</span>
        : (
          <div className="flex gap-1.5">
            <select className={clsx(btn.input, 'text-xs')} value={lib} onChange={e => setLib(e.target.value)} aria-label="Asset library">
              {libs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button className={btn.primary} disabled={!lib || busy} onClick={async () => {
              setBusy(true); setMsg(null);
              try { const r = await gen.toAssets(mediaId, lib); setMsg({ ok: true, text: r.status === 'duplicate' ? `Already in ${r.lib.name}.` : `Added to ${r.lib.name}.` }); }
              catch (e) { setMsg({ ok: false, text: clean(e) }); }
              setBusy(false);
            }}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add'}</button>
            <button className={btn.icon} onClick={() => { setOpen(false); setMsg(null); }} aria-label="Close"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
      {msg && <span className={clsx('text-[11px] flex items-center gap-1', msg.ok ? 'text-[var(--text-secondary)]' : 'text-red-400')}>{msg.ok && <Check className="w-3 h-3 text-lime-400" />}{msg.text}</span>}
    </div>
  );
}

function Preview({ it, big }: { it: Item; big?: boolean }) {
  if (it.kind === 'image') return (
    <a href={it.url} target="_blank" rel="noreferrer" className="block bg-[var(--bg-tertiary)]" title="Open full size">
      <img src={it.url} alt={it.prompt.slice(0, 160)} loading="lazy" className={clsx('w-full object-contain', big ? 'max-h-[60vh]' : 'aspect-square object-cover')}
        style={!big && it.params.width && it.params.height ? { aspectRatio: `${it.params.width} / ${it.params.height}` } : undefined} />
    </a>
  );
  return <div className="p-2"><AudioCard src={it.url} info={{ model: it.model ?? undefined, elapsed: it.elapsed ?? undefined, prompt: it.prompt }} /></div>;
}

function ResultCard({ it, comparing, onCompare, onRetry, onReuse, libs, loadLibs, busy, showPrompt }: {
  it: Item; comparing: boolean; onCompare: () => void; onRetry: () => void; onReuse: () => void;
  libs: AssetLib[] | null; loadLibs: () => void; busy: boolean; showPrompt?: boolean;
}) {
  return (
    <article className={clsx('rounded-lg overflow-hidden border bg-[var(--bg-secondary)] flex flex-col', comparing ? 'border-[var(--accent)]/70' : 'border-[var(--border-subtle)]')}>
      <Preview it={it} />
      <div className="px-3 pt-2 pb-1 space-y-1 border-t border-[var(--border-subtle)]">
        {showPrompt && <p className="text-xs leading-snug text-[var(--text-primary)] line-clamp-2" title={it.prompt}>{it.prompt}</p>}
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] min-w-0">
          <span className="font-mono text-[var(--text-secondary)] shrink-0" title={it.seed == null ? 'This engine takes no seed' : 'Seed'}>
            {it.seed == null ? 'no seed' : `#${it.seed}`}</span>
          <span className="truncate">{paramLine(it.kind, it.params, it.model)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-0.5 px-1.5 pb-1.5 mt-auto">
        <button className={btn.ghost} onClick={onRetry} disabled={busy}
          title={it.seed == null ? 'Same prompt and settings, a fresh take' : `Run again with seed ${it.seed}`}>
          <RotateCcw className="w-3.5 h-3.5" />{it.seed == null ? 'Again' : 'Retry'}</button>
        <button className={btn.ghost} onClick={onReuse} title="Put this prompt and its settings back in the prompt bar"><CornerUpLeft className="w-3.5 h-3.5" />Reuse</button>
        <button className={clsx(btn.ghost, comparing && 'text-[var(--accent)]')} onClick={onCompare} aria-pressed={comparing} title="Pin to the comparison strip">
          <Columns2 className="w-3.5 h-3.5" />{comparing ? 'Pinned' : 'Compare'}</button>
        <a className={btn.icon} href={it.url} download aria-label="Download" title="Download"><Download className="w-3.5 h-3.5" /></a>
        {it.mediaId && <SaveToLibrary mediaId={it.mediaId} libs={libs} loadLibs={loadLibs} />}
      </div>
    </article>
  );
}

function Skeleton({ kind, p }: { kind: Kind; p: Params }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden" aria-hidden>
      <div className={clsx('animate-pulse bg-[var(--bg-tertiary)]', kind !== 'image' && 'h-28 m-2 rounded-md')}
        style={kind === 'image' ? { aspectRatio: `${p.width ?? 1} / ${p.height ?? 1}` } : undefined} />
      <div className="px-3 py-2.5 space-y-1.5"><div className="h-2.5 w-24 rounded bg-[var(--bg-tertiary)]" /><div className="h-2.5 w-36 rounded bg-[var(--bg-tertiary)]" /></div>
    </div>
  );
}

const jobItems = (j: Job): Item[] => j.results.map((r, i) => ({
  key: r.mediaId ?? `${j.id}-${i}`, url: r.url, kind: j.kind, prompt: j.prompt, seed: r.seed, params: j.params, model: r.model,
  mediaId: r.mediaId, elapsed: r.elapsed, createdAt: (j.finished ?? j.created) * 1000,
}));

function statusLine(j: Job): string {
  const svc = SERVICE[j.service]?.name ?? j.service;
  if (j.status === 'queued') return j.ahead ? `Waiting for ${svc} · ${j.ahead} job${j.ahead > 1 ? 's' : ''} ahead` : `Starting on ${svc}…`;
  if (j.status === 'running') return `${j.results.length} of ${j.count} on ${svc}${j.engine ? ` · ${j.engine}` : ''}`;
  if (j.status === 'failed') return 'Failed';
  if (j.status === 'cancelled') return 'Cancelled before it started';
  if (j.status === 'stopped') return `Stopped after ${j.results.length} of ${j.count}`;
  const secs = j.started && j.finished ? j.finished - j.started : null;
  return `${j.results.length} ${kindDef(j.kind).noun[j.results.length === 1 ? 0 : 1]}${secs ? ` in ${fmtSecs(secs)}` : ''}${j.engine ? ` · ${j.engine}` : ''}`;
}

// ── page ────────────────────────────────────────────────────────────────────

export function Generate() {
  const init = useMemo(loadPrefs, []);
  const [kind, setKind] = useState<Kind>(init.kind);
  const [params, setParams] = useState<Record<Kind, Params>>(init.params);
  const [count, setCount] = useState(init.count);
  const [prompt, setPrompt] = useState('');
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [hist, setHist] = useState<HistItem[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [histKind, setHistKind] = useState<Kind | ''>('');
  const [histShown, setHistShown] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [compare, setCompare] = useState<Item[]>([]);
  const [libs, setLibs] = useState<AssetLib[] | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const finishedRef = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(PREFS, JSON.stringify({ kind, params, count })); } catch { /* not persisted */ }
  }, [kind, params, count]);

  const loadHist = useCallback(() => {
    gen.history(histKind).then(r => { setHist(r.items); setHistErr(null); }).catch(e => setHistErr(clean(e)));
  }, [histKind]);
  useEffect(loadHist, [loadHist]);

  const refresh = useCallback(async () => {
    try {
      const o = await gen.overview();
      setOv(o); setOvErr(null);
      const finished = o.jobs.filter(j => !['queued', 'running'].includes(j.status)).reduce((n, j) => n + j.results.length + 1, 0);
      if (finished !== finishedRef.current) { finishedRef.current = finished; loadHist(); }
    } catch (e) { setOvErr(clean(e)); }
  }, [loadHist]);
  const live = ov?.jobs.some(j => j.status === 'queued' || j.status === 'running') ?? false;
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, live ? 1500 : 15000);
    return () => clearInterval(t);
  }, [refresh, live]);

  const loadLibs = useCallback(() => {
    if (libs === null) assetsApi.libs().then(l => setLibs(l.filter(x => !x.locked))).catch(() => setLibs([]));
  }, [libs]);

  const p = params[kind];
  const setP = (patch: Params) => setParams(s => ({ ...s, [kind]: { ...s[kind], ...patch } }));
  const { blocked, note } = readiness(kind, ov?.services);
  const stableOk = ov?.services.stableaudio.ok ?? true;
  const maxCount = ov?.maxCount ?? 4;

  const run = async (k: Kind, text: string, prm: Params, n: number) => {
    setSubmitting(true); setSubmitErr(null);
    try { await gen.start(k, text, prm, n); await refresh(); }
    catch (e) { setSubmitErr(clean(e)); }
    setSubmitting(false);
  };
  const submit = () => {
    const text = prompt.trim();
    if (!text) { promptRef.current?.focus(); return; }
    run(kind, text, p, count);
  };
  const retry = (it: Item) => run(it.kind, it.prompt, { ...it.params, seed: it.seed }, 1);
  const reuse = (it: Item) => {
    setKind(it.kind);
    setParams(s => ({ ...s, [it.kind]: { ...DEFAULTS[it.kind], ...it.params, seed: null } }));
    setPrompt(it.prompt);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const toggleCompare = (it: Item) => setCompare(c => c.some(x => x.key === it.key) ? c.filter(x => x.key !== it.key) : [...c, it].slice(-4));
  const pinned = new Set(compare.map(c => c.key));
  const cardProps = (it: Item) => ({
    it, comparing: pinned.has(it.key), onCompare: () => toggleCompare(it), onRetry: () => retry(it), onReuse: () => reuse(it),
    libs, loadLibs, busy: submitting || !!readiness(it.kind, ov?.services).blocked,
  });

  const jobs = ov?.jobs ?? [];
  const sessionKeys = new Set(jobs.flatMap(j => j.results.map(r => r.mediaId)).filter(Boolean));
  const histItems: Item[] = (hist ?? []).filter(h => !sessionKeys.has(h.mediaId)).map(h => ({
    key: h.mediaId, url: h.url, kind: h.kind, prompt: h.prompt, seed: h.seed, params: h.params, model: h.model, mediaId: h.mediaId, createdAt: h.createdAt,
  }));
  const kd = kindDef(kind);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight leading-tight">Generate</h1>
            <p className="text-sm text-[var(--text-secondary)] max-w-[65ch] leading-relaxed">
              Prompt the image, music and sound models directly. Every result lands in Library → Media; keep the good ones in an asset library.</p>
          </div>
          <ul className="flex flex-wrap gap-1.5 text-[11px]" aria-label="Generator services">
            {(Object.keys(SERVICE) as ServiceId[]).map(id => {
              const ok = ov?.services[id]?.ok;
              return (
                <li key={id} title={`${SERVICE[id].what} on :${SERVICE[id].port}${ok === false ? ' — not responding' : ''}`}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', ok === undefined ? 'bg-[var(--text-muted)]' : ok ? 'bg-emerald-400' : 'bg-red-400')} />
                  <span className="tracking-wider uppercase text-[var(--text-secondary)]">{SERVICE[id].name}</span>
                  {ok === false && <span className="text-red-400">down</span>}
                </li>
              );
            })}
          </ul>
        </header>

        {/* prompt bar */}
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]" aria-label="New generation">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
            <Segmented label="What to make" value={kind} onChange={k => { setKind(k); setSubmitErr(null); }}
              options={KINDS.map(k => ({ id: k.id, label: k.label, icon: k.icon, tint: k.tint }))} />
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="uppercase tracking-wider">Variations</span>
              <Segmented label="Variations" value={count} onChange={setCount}
                options={Array.from({ length: maxCount }, (_, i) => ({ id: i + 1, label: String(i + 1) }))} />
            </div>
          </div>
          <div className="px-3 pt-3">
            <textarea ref={promptRef} value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} aria-label="Prompt"
              placeholder={PLACEHOLDER[kind]}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
              className="w-full resize-y min-h-[72px] px-3 py-2 text-sm leading-relaxed rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/70" />
          </div>
          <div className="flex flex-wrap items-end gap-3 px-3 py-3">
            <ParamControls kind={kind} p={p} set={setP} fluxDev={!!ov?.services.fluxDev} stableOk={stableOk} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden sm:inline text-[10px] text-[var(--text-muted)]"><kbd className="font-mono">Ctrl</kbd>+<kbd className="font-mono">Enter</kbd></span>
              <button className={clsx(btn.primary, 'h-[30px] px-4')} onClick={submit} disabled={submitting || !!blocked || !prompt.trim()}>
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <kd.icon className="w-3.5 h-3.5" />}
                Generate {count} {kd.noun[count === 1 ? 0 : 1]}
              </button>
            </div>
          </div>
          {(blocked || note || submitErr || ovErr) && (
            <div className="px-3 pb-3 space-y-1.5">
              {ovErr && <p className="flex items-start gap-1.5 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />Couldn't reach the Generate API: {ovErr}</p>}
              {blocked && <p className="flex items-start gap-1.5 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{blocked}</span></p>}
              {note && <p className="flex items-start gap-1.5 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{note}</span></p>}
              {submitErr && <p className="flex items-start gap-1.5 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{submitErr}</span></p>}
            </div>
          )}
        </section>

        {/* comparison strip */}
        {compare.length > 0 && (
          <section aria-label="Comparison" className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium flex items-center gap-1.5"><Columns2 className="w-4 h-4 text-[var(--text-secondary)]" />Side by side
                <span className="text-[11px] font-normal text-[var(--text-muted)]">{compare.length} of 4 pinned</span></h2>
              <button className={btn.ghost} onClick={() => setCompare([])}>Clear</button>
            </div>
            <div className={clsx('grid gap-3', compare.length === 1 ? 'grid-cols-1 max-w-xl' : compare.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4')}>
              {compare.map(it => (
                <figure key={it.key} className="rounded-lg overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  <Preview it={it} big={compare.length <= 2} />
                  <figcaption className="px-3 py-2 border-t border-[var(--border-subtle)] space-y-1">
                    <p className="text-xs leading-snug line-clamp-3" title={it.prompt}>{it.prompt}</p>
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                      <span className="font-mono text-[var(--text-secondary)]">{it.seed == null ? 'no seed' : `#${it.seed}`}</span>
                      <span className="truncate flex-1">{paramLine(it.kind, it.params, it.model)}</span>
                      <button className={btn.icon} onClick={() => toggleCompare(it)} aria-label="Unpin"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {/* this session's jobs */}
        {jobs.length > 0 && (
          <section aria-label="Recent jobs" className="space-y-5">
            {jobs.map(j => {
              const items = jobItems(j);
              const pending = ['queued', 'running'].includes(j.status) ? j.count - items.length : 0;
              const K = kindDef(j.kind);
              return (
                <div key={j.id} className="space-y-2">
                  <div className="flex items-start gap-2">
                    <K.icon className={clsx('w-4 h-4 mt-0.5 shrink-0', K.tint)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-snug max-w-[75ch]">{j.prompt}</p>
                      <p className="text-[11px] text-[var(--text-muted)] flex flex-wrap items-center gap-x-2">
                        <span className={clsx(j.status === 'failed' && 'text-red-400', j.status === 'running' && 'text-[var(--text-secondary)]')}>
                          {(j.status === 'running' || j.status === 'queued') && <Loader2 className="inline w-3 h-3 mr-1 animate-spin align-[-2px]" />}{statusLine(j)}</span>
                        <span>{paramLine(j.kind, j.params, j.results[0]?.model ?? (j.engine ? 'audiogen' : 'stable-audio'))}</span>
                        <span>{relTime(j.created * 1000)}</span>
                      </p>
                      {j.error && <p className="mt-1 text-xs text-red-400 max-w-[75ch] break-words">{j.error}</p>}
                      {j.note && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{j.note}</p>}
                    </div>
                    {(j.status === 'queued' || j.status === 'running') ? (
                      <button className={btn.ghost} onClick={() => gen.stop(j.id).then(refresh).catch(e => setSubmitErr(clean(e)))}
                        disabled={j.status === 'running' && j.results.length + 1 >= j.count}
                        title={j.status === 'queued' ? 'Drop it from the queue' : 'Finish the current variation, then stop'}>
                        <CircleStop className="w-3.5 h-3.5" />{j.status === 'queued' ? 'Cancel' : 'Stop'}</button>
                    ) : (
                      <div className="flex">
                        {j.status === 'failed' && <button className={btn.ghost} disabled={submitting} onClick={() => run(j.kind, j.prompt, j.params, j.count)}><RotateCcw className="w-3.5 h-3.5" />Try again</button>}
                        <button className={btn.icon} title="Remove from this list (the files stay in Media)" aria-label="Dismiss"
                          onClick={() => gen.forget(j.id).then(refresh).catch(() => {})}><X className="w-3.5 h-3.5" /></button>
                      </div>
                    )}
                  </div>
                  {(items.length > 0 || pending > 0) && (
                    <div className={clsx('grid gap-3', j.kind === 'image' ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2')}>
                      {items.map(it => <ResultCard key={it.key} {...cardProps(it)} />)}
                      {Array.from({ length: pending }, (_, i) => <Skeleton key={i} kind={j.kind} p={j.params} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {/* history */}
        <section aria-label="History" className="space-y-3 pt-2 border-t border-[var(--border-subtle)]">
          <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
            <h2 className="text-sm font-medium flex items-center gap-1.5"><History className="w-4 h-4 text-[var(--text-secondary)]" />Earlier generations</h2>
            <Segmented label="Filter history" value={histKind} onChange={k => { setHistKind(k); setHistShown(24); }}
              options={[{ id: '' as const, label: 'All' }, ...KINDS.map(k => ({ id: k.id, label: k.label === 'Sound effect' ? 'Sounds' : k.label }))]} />
          </div>
          {histErr ? (
            <p className="flex items-center gap-2 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5" />Couldn't load history: {histErr}
              <button className={btn.ghost} onClick={loadHist}>Retry</button></p>
          ) : hist === null ? (
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} kind="image" p={{}} />)}</div>
          ) : histItems.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)] max-w-[65ch] leading-relaxed">
              {jobs.length ? 'Everything made so far is listed above.' : histKind
                ? `No ${kindDef(histKind).noun[1]} made here yet.`
                : 'Nothing made here yet. Describe a picture, a piece of music or a sound above and generate a few variations to compare.'}
            </p>
          ) : (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                {histItems.slice(0, histShown).map(it => (
                  <div key={it.key} className="flex flex-col gap-1">
                    <ResultCard {...cardProps(it)} showPrompt />
                    <span className="text-[10px] text-[var(--text-muted)] px-1">{relTime(it.createdAt)}</span>
                  </div>
                ))}
              </div>
              {histItems.length > histShown && (
                <button className={btn.subtle} onClick={() => setHistShown(n => n + 24)}>Show {Math.min(24, histItems.length - histShown)} more</button>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
