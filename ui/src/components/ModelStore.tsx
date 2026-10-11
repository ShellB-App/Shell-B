import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowUpCircle, CheckCircle2, ChevronDown, Download, ExternalLink, Heart, HardDrive, KeyRound, Loader2, Lock,
  RotateCw, Search, Trash2, X,
} from 'lucide-react';
import { fmtBytes, req } from '../api';
import { Markdown } from './Markdown';
import { btn, relTime } from './common';
import { t as tx } from '../i18n';

// Model Store: server/modelstore.py. Ollama pulls run through modelhub, so they also show under Installed.

type Source = 'hf' | 'ollama';
interface HfItem { source: 'hf'; id: string; downloads: number; likes: number; updated?: string; gated: boolean; pipeline: string; license: string; formats: string[] }
interface OllamaItem { source: 'ollama'; id: string; description: string; capabilities: string[]; sizes: string[]; downloads: number; installed: boolean }
type Item = HfItem | OllamaItem;
interface Quant { quant: string; size: number; files: number; pull: string; installed: boolean }
interface HfFile { path: string; size: number; sha256: string; dest: string; subfolder: boolean; diffusersPart: boolean; installed: string }
interface HfRepo {
  id: string; updated?: string; gated: boolean | string; license: string; pipeline: string; downloads: number; likes: number;
  baseModel?: string | string[]; gguf: Quant[]; files: HfFile[]; readme: string; diffusers: boolean; dests: Record<string, string>; tokenSet: boolean;
}
interface OllamaTag { tag: string; digest: string; size: string; context: string; input: string; updated: string; installed: boolean; current: boolean | null }
interface OllamaModel { name: string; description: string; tags: OllamaTag[] }
interface Job {
  id: string; kind: 'file' | 'pull'; name: string; state: 'running' | 'done' | 'error' | 'cancelled'; status: string;
  completed: number; total: number; rate: number | null; error: string; started: number; dest?: string;
}
interface Update { kind: 'ollama' | 'file'; name: string; status: 'update' | 'current' | 'local' | 'unknown' | 'missing'; detail: string; repo?: string }
interface StoreFile { path: string; dest: string; name: string; size: number; modified: number; source: { repo: string; file: string } | null; inUse: boolean }
interface FilesResp { files: StoreFile[]; dests: Record<string, string>; disk: { total: number; free: number }; tokenSet: boolean }

const J = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) });
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const store = {
  search: (source: Source, q: string, kind: string, sort: string) =>
    req<{ items: Item[] }>(`/api/modelstore/search?${new URLSearchParams({ source, q, kind, sort })}`),
  hf: (repo: string) => req<HfRepo>(`/api/modelstore/hf/${enc(repo)}`),
  ollama: (name: string) => req<OllamaModel>(`/api/modelstore/ollama/${encodeURIComponent(name)}`),
  pull: (pull: string) => req<Job>('/api/modelstore/download', J({ pull })),
  file: (repo: string, file: string, dest: string) => req<Job>('/api/modelstore/download', J({ repo, file, dest })),
  jobs: () => req<Job[]>('/api/modelstore/jobs'),
  cancel: (id: string) => req('/api/modelstore/jobs/cancel', J({ id })),
  dismiss: (id: string) => req('/api/modelstore/jobs/dismiss', J({ id })),
  updates: (fresh = false) => req<{ items: Update[]; checked: number }>(`/api/modelstore/updates?fresh=${fresh}`),
  update: (u: Update) => req<Job>('/api/modelstore/update', J({ kind: u.kind, name: u.name })),
  files: () => req<FilesResp>('/api/modelstore/files'),
  remove: (path: string, force = false) => req(`/api/modelstore/files/${enc(path)}?force=${force}`, { method: 'DELETE' }),
  token: (token: string) => req<{ ok: boolean; user?: string }>('/api/modelstore/hf-token', J({ token }, 'PUT')),
};
const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '').replace('admin-key-required', 'Only the signed-in owner can do this (or enter the admin key).');
const num = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const card = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';
const chip = 'px-1.5 py-px rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-muted)]';
const H2 = ({ children }: { children: ReactNode }) => <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{children}</h2>;

function useAct(onDone?: () => void) {
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const act = async (key: string, f: () => Promise<unknown>) => {
    setWorking(key); setError('');
    try { await f(); } catch (e) { setError(clean(e)); }
    setWorking(''); onDone?.();
  };
  return { working, error, setError, act };
}

function Err({ text }: { text: string }) {
  return text ? <div className="flex items-start gap-2 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{text}</div> : null;
}

// ── downloads ──────────────────────────────────────────────────────────────

export function StoreJobs({ nonce }: { nonce: number }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const load = useCallback(() => store.jobs().then(setJobs).catch(() => {}), []);
  useEffect(() => { load(); }, [load, nonce]);
  const running = jobs.some(j => j.state === 'running');
  useEffect(() => { const t = setInterval(load, running ? 1500 : 8000); return () => clearInterval(t); }, [load, running]);
  const { error, act } = useAct(load);
  if (!jobs.length) return null;
  return (
    <section className="space-y-2">
      <H2>{tx('Downloads')}</H2>
      <div className={clsx(card, 'p-3 space-y-2.5')}>
        {jobs.map(j => (
          <div key={j.id} className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono font-medium truncate max-w-[45%]" title={j.name}>{j.name}</span>
              {j.dest && <span className={chip}>{j.dest}</span>}
              <span className={clsx('flex-1 truncate', j.state === 'error' ? 'text-red-400' : j.state === 'done' ? 'text-emerald-500' : 'text-[var(--text-muted)]')}>
                {j.state === 'error' ? j.error : j.status}
                {j.state === 'running' && j.total ? tx(' · {v0} of {v1}', { v0: fmtBytes(j.completed), v1: fmtBytes(j.total) }) : ''}
                {j.state === 'running' && j.rate ? ` · ${fmtBytes(j.rate)}/s` : ''}
              </span>
              {j.state === 'running'
                ? <button className={btn.ghost} onClick={() => act(`c:${j.id}`, () => store.cancel(j.id))}>{j.kind === 'file' ? tx('Pause') : tx('Cancel')}</button>
                : <button className={btn.icon} onClick={() => act(`d:${j.id}`, () => store.dismiss(j.id))} aria-label={tx('Dismiss')}><X className="w-3.5 h-3.5" /></button>}
            </div>
            {j.state === 'running' && <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
              <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${j.total ? (j.completed / j.total) * 100 : 2}%` }} /></div>}
          </div>
        ))}
        <Err text={error} />
      </div>
    </section>
  );
}

// ── browse ─────────────────────────────────────────────────────────────────

const KINDS: Record<Source, [string, string][]> = {
  hf: [['all', 'Everything'], ['llm', 'Language models (GGUF)'], ['image', 'Image generation'], ['lora', 'LoRAs']],
  ollama: [['all', 'Everything'], ['tools', 'Tool use'], ['thinking', 'Thinking'], ['embedding', 'Embeddings']],
};
const SORTS: Record<Source, [string, string][]> = {
  hf: [['downloads', 'Most downloaded'], ['trendingScore', 'Trending'], ['likes', 'Most liked'], ['lastModified', 'Recently updated']],
  ollama: [['downloads', 'Most pulled'], ['popular', 'Trending'], ['newest', 'Newest']],
};
const select = btn.input.replace('w-full ', '') + ' w-auto';

export function ModelStore() {
  const [source, setSource] = useState<Source>('ollama');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('downloads');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setQuery(q.trim()), 400); }, [q]);
  useEffect(() => {
    let live = true;
    setItems(null); setError(''); setOpen(null);
    store.search(source, query, kind, sort).then(r => { if (live) setItems(r.items); }).catch(e => { if (live) { setError(clean(e)); setItems([]); } });
    return () => { live = false; };
  }, [source, query, kind, sort]);
  const started = () => setNonce(n => n + 1);

  return (
    <div className="space-y-6">
      <StoreJobs nonce={nonce} />
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex p-0.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]" role="tablist">
            {([['ollama', 'Ollama library'], ['hf', 'Hugging Face']] as [Source, string][]).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={source === id} onClick={() => { setSource(id); setKind('all'); setSort('downloads'); }}
                className={clsx('px-3 py-1 rounded-md text-xs font-medium transition', source === id ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>{label}</button>
            ))}
          </div>
          <select className={select} value={kind} onChange={e => setKind(e.target.value)} aria-label={tx('Kind')}>
            {KINDS[source].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className={select} value={sort} onChange={e => setSort(e.target.value)} aria-label={tx('Sort')}>
            {SORTS[source].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)}
              placeholder={source === 'hf' ? tx('Search Hugging Face, or paste owner/repo') : tx('Search the Ollama library')} />
          </div>
        </div>
        <Err text={error} />
        {items === null ? <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
          : items.length === 0 ? <div className="text-xs text-[var(--text-muted)] py-8 text-center">{tx('Nothing found.')}</div>
          : <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            {items.map(it => (
              <div key={it.id} className="bg-[var(--bg-secondary)]">
                <button className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-[var(--bg-hover)]/40" onClick={() => setOpen(open === it.id ? null : it.id)} aria-expanded={open === it.id}>
                  <ChevronDown className={clsx('w-3.5 h-3.5 mt-1 text-[var(--text-muted)] shrink-0 transition', open !== it.id && '-rotate-90')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium break-all">{it.id}</span>
                      {it.source === 'ollama' && it.installed && <span className="px-1.5 py-px rounded text-[10px] bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">{tx('Installed')}</span>}
                      {it.source === 'hf' && it.gated && <span className={clsx(chip, 'inline-flex items-center gap-1')}><Lock className="w-2.5 h-2.5" />{tx('Gated')}</span>}
                      {(it.source === 'hf' ? it.formats : it.capabilities).map(f => <span key={f} className={chip}>{f}</span>)}
                    </span>
                    <span className="block text-[11px] text-[var(--text-muted)] truncate">
                      {it.source === 'ollama'
                        ? [it.description, it.sizes.join(' · ')].filter(Boolean).join(' — ')
                        : [it.pipeline, it.license && `license ${it.license}`, it.updated && `updated ${relTime(Date.parse(it.updated))}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-mono text-[var(--text-muted)] flex items-center gap-2 mt-0.5">
                    <span title={tx('Downloads')} className="flex items-center gap-1"><Download className="w-3 h-3" />{num(it.downloads)}</span>
                    {it.source === 'hf' && <span title={tx('Likes')} className="hidden sm:flex items-center gap-1"><Heart className="w-3 h-3" />{num(it.likes)}</span>}
                  </span>
                </button>
                {open === it.id && <div className="px-3 sm:px-8 pb-4">
                  {it.source === 'hf' ? <HfDetail repo={it.id} onStarted={started} /> : <OllamaDetail name={it.id} onStarted={started} />}
                </div>}
              </div>
            ))}
          </div>}
      </section>
      <HfToken />
    </div>
  );
}

function OllamaDetail({ name, onStarted }: { name: string; onStarted: () => void }) {
  const [m, setM] = useState<OllamaModel | null>(null);
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);
  const load = useCallback(() => store.ollama(name).then(setM).catch(e => setErr(clean(e))), [name]);
  useEffect(() => { load(); }, [load]);
  const { working, error, act } = useAct(load);
  if (err) return <Err text={err} />;
  if (!m) return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />;
  // the full list runs to dozens of quantizations: show the plain size tags first
  const main = m.tags.filter(t => t.installed || !/-(q\d|fp16|bf16|mxfp4|nvfp4)/i.test(t.tag));
  const shown = all ? m.tags : main;
  return (
    <div className="space-y-3">
      {m.description && <p className="text-xs text-[var(--text-secondary)] max-w-[75ch]">{tx(m.description)}</p>}
      <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
        {shown.map(t => {
          const full = `${name}:${t.tag}`;
          return (
            <div key={t.tag} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <span className="font-mono font-medium min-w-[140px]">{t.tag}</span>
              <span className="text-[var(--text-muted)] flex-1">{[t.size, t.context && `${t.context} context`, t.input && `${t.input} input`, t.updated].filter(Boolean).join(' · ') || tx('Alias of another tag')}</span>
              {t.installed && t.current === false
                ? <button className={btn.subtle} disabled={working === full} onClick={() => act(full, async () => { await store.pull(full); onStarted(); })}><ArrowUpCircle className="w-3.5 h-3.5 text-amber-400" />{tx('Update')}</button>
                : t.installed ? <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="w-3.5 h-3.5" />{tx('Installed')}</span>
                : <button className={btn.subtle} disabled={working === full} onClick={() => act(full, async () => { await store.pull(full); onStarted(); })}>
                  {working === full ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}{tx('Pull')}</button>}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        {m.tags.length > main.length && <button className="underline text-[var(--text-secondary)]" onClick={() => setAll(!all)}>{all ? tx('Fewer tags') : tx('All {length} tags', { length: m.tags.length })}</button>}
        <a className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]" href={`https://ollama.com/library/${name}`} target="_blank" rel="noreferrer">ollama.com<ExternalLink className="w-3 h-3" /></a>
      </div>
      <Err text={error} />
    </div>
  );
}

function HfDetail({ repo, onStarted }: { repo: string; onStarted: () => void }) {
  const [r, setR] = useState<HfRepo | null>(null);
  const [err, setErr] = useState('');
  const [dests, setDests] = useState<Record<string, string>>({});
  const [parts, setParts] = useState(false);
  const load = useCallback(() => store.hf(repo).then(setR).catch(e => setErr(clean(e))), [repo]);
  useEffect(() => { load(); }, [load]);
  const { working, error, act } = useAct(load);
  if (err) return <Err text={err} />;
  if (!r) return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />;
  const singles = r.files.filter(f => !f.diffusersPart);
  const diff = r.files.filter(f => f.diffusersPart);
  const base = Array.isArray(r.baseModel) ? r.baseModel.join(', ') : r.baseModel;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        {r.license && <span>{tx('License')} <span className="font-mono">{r.license}</span></span>}
        {r.pipeline && <span>{r.pipeline}</span>}
        {base && <span>{tx('Based on {base}', { base: base })}</span>}
        {r.updated && <span>{tx('Updated {v0}', { v0: relTime(Date.parse(r.updated)) })}</span>}
        <a className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]" href={`https://huggingface.co/${repo}`} target="_blank" rel="noreferrer">huggingface.co<ExternalLink className="w-3 h-3" /></a>
      </div>
      {r.gated && <div className="text-[11px] text-amber-500 flex items-start gap-1.5"><Lock className="w-3 h-3 mt-px shrink-0" />
        {tx('Gated: accept its terms on huggingface.co with your account')}{r.tokenSet ? '. Your saved token is used for the download.' : tx(', then save a Hugging Face token below.')}</div>}

      {r.gguf.length > 0 && <div className="space-y-1.5">
        <div className="text-xs font-medium">{tx('Run in Ollama')} <span className="text-[var(--text-muted)] font-normal">{tx('· pulled as hf.co/')}{repo}:&lt;quant&gt;</span></div>
        <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
          {r.gguf.map(g => (
            <div key={g.quant} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <span className="font-mono font-medium w-24">{g.quant}</span>
              <span className="text-[var(--text-muted)] flex-1">{fmtBytes(g.size)}{g.files > 1 ? tx(' · {files} parts', { files: g.files }) : ''}</span>
              {g.installed ? <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="w-3.5 h-3.5" />{tx('Installed')}</span>
                : <button className={btn.subtle} disabled={working === g.pull} onClick={() => act(g.pull, async () => { await store.pull(g.pull); onStarted(); })}>
                  {working === g.pull ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}{tx('Pull')}</button>}
            </div>
          ))}
        </div>
      </div>}

      {singles.length > 0 && <div className="space-y-1.5">
        <div className="text-xs font-medium">{tx('Download for ComfyUI')} <span className="text-[var(--text-muted)] font-normal">· saved in ~/comfyui/models/&lt;folder&gt;</span></div>
        <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
          {singles.map(f => {
            const dest = dests[f.path] ?? f.dest;
            return (
              <div key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-xs">
                <span className="font-mono break-all flex-1 min-w-[200px]">{f.path}</span>
                <span className="text-[var(--text-muted)] font-mono w-16 text-right">{fmtBytes(f.size)}</span>
                {f.installed ? <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="w-3.5 h-3.5" />In {f.installed.split('/')[0]}</span> : <>
                  <select className={clsx(select, 'py-1 text-xs')} value={dest} onChange={e => setDests({ ...dests, [f.path]: e.target.value })} aria-label={tx('Folder')}>
                    {Object.entries(r.dests).map(([k, l]) => <option key={k} value={k} title={l}>{k}</option>)}
                  </select>
                  <button className={btn.subtle} disabled={working === f.path} onClick={() => act(f.path, async () => { await store.file(repo, f.path, dest); onStarted(); })}>
                    {working === f.path ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}{tx('Download')}</button>
                </>}
              </div>
            );
          })}
        </div>
      </div>}

      {diff.length > 0 && <div className="text-[11px] text-[var(--text-muted)]">
        <button className="underline" onClick={() => setParts(!parts)}>{parts ? tx('Hide') : tx('Show')} {diff.length} {tx('diffusers-format parts')}</button>
        {' '}{tx('— sharded weights for the diffusers library; ComfyUI needs single-file weights, so look for a file above or a ComfyUI repack.')}
        {parts && <ul className="mt-1.5 space-y-0.5 font-mono">{diff.map(f => <li key={f.path}>{f.path} · {fmtBytes(f.size)}</li>)}</ul>}
      </div>}
      {!r.gguf.length && !singles.length && !diff.length && <div className="text-xs text-[var(--text-muted)]">{tx('No .gguf or .safetensors files here. Pickle formats (.ckpt, .pt, .bin) aren\'t offered: loading one can run code.')}</div>}

      {r.readme && <details className="group">
        <summary className="text-xs font-medium cursor-pointer select-none">{tx('Model card')}</summary>
        <div className="mt-2 max-h-[420px] overflow-y-auto rounded-lg border border-[var(--border-subtle)] p-3 text-sm"><Markdown text={r.readme} /></div>
      </details>}
      <Err text={error} />
    </div>
  );
}

function HfToken() {
  const [set, setSet] = useState<boolean | null>(null);
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { store.files().then(f => setSet(f.tokenSet)).catch(() => {}); }, []);
  const { working, error, act } = useAct();
  return (
    <section className={clsx(card, 'p-3 space-y-2')}>
      <div className="flex items-center gap-2 text-xs">
        <KeyRound className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <span className="font-medium">{tx('Hugging Face token')}</span>
        <span className="text-[var(--text-muted)]">{set === null ? '' : set ? tx('· saved (gated repos work once you accept their terms)') : tx('· not set (only needed for gated repos)')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className={clsx(btn.input, 'flex-1 min-w-[220px] font-mono')} type="password" autoComplete="off" value={val} onChange={e => setVal(e.target.value)} placeholder="hf_…" />
        <button className={btn.subtle} disabled={!val.trim() || working === 't'} onClick={() => act('t', async () => {
          const r = await store.token(val.trim()); setVal(''); setSet(true); setMsg(r.user ? `Saved for ${r.user}.` : 'Saved.');
        })}>{working === 't' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}{tx('Save token')}</button>
        {set && <button className={btn.ghost} onClick={() => act('r', async () => { await store.token(''); setSet(false); setMsg('Removed.'); })}>{tx('Remove')}</button>}
      </div>
      {msg && <div className="text-[11px] text-emerald-500">{msg}</div>}
      <Err text={error} />
    </section>
  );
}

// ── updates ────────────────────────────────────────────────────────────────

const STATUS: Record<Update['status'], [string, string]> = {
  update: ['Update available', 'text-amber-400'], missing: ['Missing', 'text-red-400'], unknown: ["Couldn't check", 'text-[var(--text-muted)]'],
  current: ['Up to date', 'text-emerald-500'], local: ['Built here', 'text-[var(--text-muted)]'],
};

export function ModelUpdates() {
  const [u, setU] = useState<{ items: Update[]; checked: number } | null>(null);
  const [files, setFiles] = useState<FilesResp | null>(null);
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const check = useCallback(async (fresh: boolean) => {
    setChecking(true);
    try { setU(await store.updates(fresh)); } catch { /* shown as empty */ }
    setChecking(false);
  }, []);
  const loadFiles = useCallback(() => store.files().then(setFiles).catch(() => {}), []);
  useEffect(() => { check(false); loadFiles(); }, [check, loadFiles]);
  const { working, error, act } = useAct(() => { loadFiles(); setNonce(n => n + 1); });

  const pending = u?.items.filter(i => i.status === 'update') ?? [];
  const rest = u?.items.filter(i => i.status !== 'update') ?? [];
  const visible = showAll ? rest : rest.filter(i => i.status === 'missing' || i.status === 'unknown');

  return (
    <div className="space-y-6">
      <StoreJobs nonce={nonce} />
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1"><H2>{tx('Updates')}</H2></div>
          {u && <span className="text-[11px] text-[var(--text-muted)]">{tx('Checked {v0}', { v0: relTime(u.checked) })}</span>}
          {pending.length > 1 && <button className={btn.primary} disabled={!!working} onClick={() => act('all', async () => { for (const p of pending) await store.update(p); })}>
            <ArrowUpCircle className="w-3.5 h-3.5" />{tx('Update all')} {pending.length}</button>}
          <button className={btn.subtle} disabled={checking} onClick={() => check(true)}>
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}{tx('Check now')}</button>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] max-w-[75ch]">
          {tx('Ollama models are compared with the registry\'s current build; files this store downloaded are compared with the repository\'s current checksum. Shell:B\'s own models are built here from a base model, so update the base model and rebuild them.')}
        </p>
        {!u ? <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div> : (
          <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            {pending.length === 0 && <div className="px-3 py-3 text-xs text-emerald-500 flex items-center gap-1.5 bg-[var(--bg-secondary)]"><CheckCircle2 className="w-3.5 h-3.5" />{tx('Everything is up to date.')}</div>}
            {[...pending, ...visible].map(i => (
              <div key={`${i.kind}:${i.name}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs bg-[var(--bg-secondary)]">
                <span className={chip}>{i.kind === 'ollama' ? tx('Ollama') : tx('ComfyUI')}</span>
                <span className="font-mono font-medium break-all flex-1 min-w-[160px]">{i.name}</span>
                <span className={clsx('min-w-[110px]', STATUS[i.status][1])} title={i.detail}>{STATUS[i.status][0]}</span>
                <span className="text-[var(--text-muted)] hidden md:block w-56 truncate" title={i.detail}>{i.repo ?? i.detail}</span>
                {i.status === 'update' || (i.status === 'missing' && i.kind === 'file')
                  ? <button className={btn.subtle} disabled={working === i.name} onClick={() => act(i.name, () => store.update(i))}>
                    {working === i.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}{i.status === 'missing' ? tx('Download again') : tx('Update')}</button>
                  : <span className="w-[86px]" />}
              </div>
            ))}
          </div>
        )}
        {u && rest.length > visible.length && <button className="text-[11px] underline text-[var(--text-secondary)]" onClick={() => setShowAll(true)}>
          {tx('Show the {v0} that are up to date or built here', { v0: rest.length - visible.length })}</button>}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1"><H2>{tx('ComfyUI model files')}{files ? ` · ${files.files.length} · ${fmtBytes(files.files.reduce((a, f) => a + f.size, 0))}` : ''}</H2></div>
          {files && <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1"><HardDrive className="w-3 h-3" />{fmtBytes(files.disk.free)} free</span>}
        </div>
        {files && <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
          {files.files.map(f => (
            <div key={f.path} className="bg-[var(--bg-secondary)]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                <span className={chip}>{f.dest}</span>
                <span className="font-mono break-all flex-1 min-w-[160px]">{f.name}</span>
                {f.inUse && <span className="px-1.5 rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-muted)]" title={tx('Shell:B loads this file by name')}>{tx('Shell:B')}</span>}
                <span className="text-[var(--text-muted)] hidden md:block w-48 truncate" title={f.source ? `${f.source.repo} / ${f.source.file}` : ''}>{f.source ? f.source.repo : tx('Added by hand')}</span>
                <span className="font-mono text-[var(--text-muted)] w-16 text-right">{fmtBytes(f.size)}</span>
                {confirm === f.path ? (<>
                  <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30"
                    onClick={() => { setConfirm(null); act(`x:${f.path}`, () => store.remove(f.path, f.inUse)); }}>{tx('Delete')}{f.inUse ? ' anyway' : ''}</button>
                  <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirm(null)}>{tx('Keep')}</button>
                </>) : <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Delete from disk')} onClick={() => setConfirm(f.path)} disabled={working === `x:${f.path}`}>
                  {working === `x:${f.path}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}</button>}
              </div>
              {confirm === f.path && f.inUse && <div className="px-3 pb-2 text-[11px] text-amber-500">{tx('Shell:B loads this file by name; the tools that use it will fail until it\'s back.')}</div>}
            </div>
          ))}
        </div>}
      </section>
      <Err text={error} />
    </div>
  );
}
