import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, BookOpen, Check, ChevronDown, Download, Globe2, HardDrive, Loader2, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { fmtBytes, req } from '../api';
import { btn, relTime } from './common';
import { t as tx } from '../i18n';

type Schedule = 'off' | 'weekly' | 'monthly';
interface Job { phase: 'download' | 'verify' | 'install'; done: number; bytes: number; rate: number | null; version: string; note: string | null; started: number }
interface Hist { event: string; version: string; bytes: number; at: number; from?: string | null }
interface Dataset {
  id: string; kind: 'protomaps' | 'kiwix' | 'local'; app: 'worlds' | 'wiki'; name: string; desc: string; updatable: boolean;
  category?: string;
  installed: boolean; bytes: number; downloadedAt: number | null; approxBytes?: number; version?: string | null; verified?: boolean | null;
  schedule?: Schedule; lastCheck?: number | null; checkError?: string | null; lastError?: string | null;
  latest?: { version: string; bytes: number } | null; updateAvailable?: boolean; queued?: boolean; job?: Job | null; history?: Hist[];
}
interface Overview { datasets: Dataset[]; disk: { free: number; total: number }; used: number }

const J = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const data = {
  list: () => req<Overview>('/api/datasets'),
  check: (id: string) => req<Dataset>(`/api/datasets/${id}/check`, { method: 'POST' }),
  install: (id: string) => req<Dataset>(`/api/datasets/${id}/install`, { method: 'POST' }),
  schedule: (id: string, schedule: Schedule) => req<Dataset>(`/api/datasets/${id}/schedule`, J({ schedule })),
  cancel: (id: string) => req<Dataset>(`/api/datasets/${id}/cancel`, { method: 'POST' }),
  remove: (id: string) => req<Dataset>(`/api/datasets/${id}`, { method: 'DELETE' }),
};
const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '').replace('admin-key-required', 'Only the signed-in owner can do this (or enter the admin key).');
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
/** 20261003 → 3 Oct 2026, 2026-06 → Jun 2026: both publishers name builds by date. */
function fmtVersion(v?: string | null) {
  if (!v) return '';
  const m = /^(\d{4})-?(\d{2})-?(\d{2})?([a-z])?$/.exec(v);
  if (!m) return v;
  const d = new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  const base = d.toLocaleDateString(undefined, m[3] ? { year: 'numeric', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' });
  return m[4] ? `${base} (${m[4]})` : base;
}
function eta(j: Job) {
  if (!j.rate || j.phase !== 'download') return '';
  const s = (j.bytes - j.done) / j.rate;
  return s < 90 ? `${Math.ceil(s)} s left` : s < 5400 ? `${Math.round(s / 60)} min left` : `${(s / 3600).toFixed(1)} h left`;
}
const APP_HEAD = {
  worlds: { label: 'Worlds', icon: Globe2, color: 'text-green-400', note: 'Maps of Earth and 18 other worlds. The Earth basemap is the big one; Protomaps rebuilds it daily from OpenStreetMap.' },
  wiki: { label: 'Wiki & Reference', icon: BookOpen, color: 'text-sky-400', note: 'Offline encyclopedias, developer Q&A, system docs, textbooks and repair guides from Kiwix archives, read in the Wiki app and by every agent through the wiki tool.' },
};

function ScheduleSwitch({ value, onChange, disabled }: { value: Schedule; onChange: (s: Schedule) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={tx('Update schedule')} className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-0.5 text-[11px]">
      {(['off', 'weekly', 'monthly'] as Schedule[]).map(s => (
        <button key={s} role="radio" aria-checked={value === s} disabled={disabled} onClick={() => value !== s && onChange(s)}
          className={clsx('px-2 py-0.5 rounded-md capitalize transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
            value === s ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>{s}</button>
      ))}
    </div>
  );
}

function Row({ d, working, act }: { d: Dataset; working: string; act: (key: string, f: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const j = d.job;
  const busy = (k: string) => working === `${k}:${d.id}`;
  const spin = <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  return (
    <div className="bg-[var(--bg-secondary)]">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{d.name}</span>
            {d.category && <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]">{d.category}</span>}
            {d.installed && d.version && <span className="font-mono text-[10px] tracking-wider px-1.5 py-px rounded border border-[var(--border-subtle)] text-[var(--text-secondary)]" title={tx('Build {version}', { version: d.version })}>{fmtVersion(d.version)}</span>}
            {d.verified && <span title={tx('Checksum matched the publisher\'s')}><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /></span>}
            {d.updateAvailable && !j && <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/25">{fmtVersion(d.latest?.version)} available</span>}
            {d.queued && <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{tx('Queued')}</span>}
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5 max-w-[65ch] leading-relaxed">{tx(d.desc)}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 text-[11px] leading-5 min-w-[200px]">
          <dt className="text-[var(--text-muted)]">{tx('Size')}</dt>
          <dd className="font-mono text-right">{d.installed ? fmtBytes(d.bytes) : d.approxBytes ? `≈ ${fmtBytes(d.approxBytes)}` : '—'}</dd>
          <dt className="text-[var(--text-muted)]">{d.updatable ? tx('Downloaded') : tx('Last built')}</dt>
          <dd className="text-right" title={d.downloadedAt ? new Date(d.downloadedAt * 1000).toLocaleString() : undefined}>{d.downloadedAt ? day(d.downloadedAt) : '—'}</dd>
          {d.updatable && <>
            <dt className="text-[var(--text-muted)]">{tx('Checked')}</dt>
            <dd className="text-right">{d.lastCheck ? relTime(d.lastCheck * 1000) : 'never'}</dd>
          </>}
        </dl>
        {d.updatable && (
          <div className="flex flex-col items-end gap-1.5 min-w-[180px]">
            {d.installed ? (
              <>
                <ScheduleSwitch value={d.schedule ?? 'monthly'} disabled={busy('s')} onChange={s => act(`s:${d.id}`, () => data.schedule(d.id, s))} />
                <div className="flex items-center gap-1">
                  {!j && !d.queued && (d.updateAvailable
                    ? <button className={btn.primary} disabled={busy('i')} onClick={() => act(`i:${d.id}`, () => data.install(d.id))}>{busy('i') ? spin : <Download className="w-3.5 h-3.5" />}{tx('Update ·')} {fmtBytes(d.latest!.bytes)}</button>
                    : <button className={btn.ghost} disabled={busy('c')} onClick={() => act(`c:${d.id}`, () => data.check(d.id))}>{busy('c') ? spin : <RotateCw className="w-3.5 h-3.5" />}{tx('Check now')}</button>)}
                  <button className={btn.icon} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={tx('History and removal')}><ChevronDown className={clsx('w-3.5 h-3.5 transition', !open && '-rotate-90')} /></button>
                </div>
              </>
            ) : !j && !d.queued && (
              <button className={btn.subtle} disabled={busy('i')} onClick={() => act(`i:${d.id}`, () => data.install(d.id))}>{busy('i') ? spin : <Download className="w-3.5 h-3.5" />}{tx('Download')}</button>
            )}
          </div>
        )}
      </div>

      {j && (
        <div className="px-4 pb-3 space-y-1">
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="flex-1 truncate">
              {j.phase === 'download' ? tx('Downloading {v0} · {v1} of {v2}{v3}', { v0: fmtVersion(j.version), v1: fmtBytes(j.done), v2: fmtBytes(j.bytes), v3: j.rate ? ` · ${fmtBytes(j.rate)}/s · ${eta(j)}` : '' })
                : j.phase === 'verify' ? tx('Checking the checksum · {v0}%', { v0: Math.round((j.done / j.bytes) * 100) }) : tx('Swapping in the new version')}
              {j.note && <span className="text-amber-500"> · {tx(j.note)}</span>}
            </span>
            {j.phase === 'download' && <button className={btn.ghost} disabled={busy('x')} onClick={() => act(`x:${d.id}`, () => data.cancel(d.id))}><X className="w-3.5 h-3.5" />{tx('Cancel')}</button>}
          </div>
          <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" role="progressbar" aria-valuenow={Math.round((j.done / j.bytes) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={clsx('h-full transition-all', j.phase === 'verify' ? 'bg-emerald-500' : 'bg-[var(--accent)]')} style={{ width: `${Math.max(1, (j.done / j.bytes) * 100)}%` }} />
          </div>
        </div>
      )}
      {d.queued && <div className="px-4 pb-3 text-[11px] text-[var(--text-muted)]">{tx('Waits for the current download; one runs at a time.')} <button className="underline hover:text-[var(--text-primary)]" onClick={() => act(`x:${d.id}`, () => data.cancel(d.id))}>{tx('Remove from queue')}</button></div>}
      {(d.lastError || d.checkError) && !j && (
        <div className="px-4 pb-3 flex items-start gap-1.5 text-[11px] text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{d.lastError ? tx('Last download failed: {lastError}', { lastError: d.lastError ?? '' }) : tx('Couldn\'t check for updates: {checkError}', { checkError: d.checkError ?? '' })}</div>
      )}

      {open && d.installed && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--border-subtle)] flex flex-wrap gap-4 items-end">
          <ol className="flex-1 min-w-[240px] text-[11px] space-y-0.5">
            {(d.history ?? []).map((h, i) => (
              <li key={i} className="flex gap-3"><span className="text-[var(--text-muted)] w-24 shrink-0">{day(h.at)}</span>
                <span className="capitalize">{h.event === 'found' ? tx('Found on disk') : h.event}</span>
                <span className="font-mono text-[var(--text-secondary)]">{h.from ? `${fmtVersion(h.from)} → ` : ''}{fmtVersion(h.version)}</span>
                <span className="font-mono text-[var(--text-muted)] ml-auto">{fmtBytes(h.bytes)}</span></li>
            ))}
            {!d.history?.length && <li className="text-[var(--text-muted)]">{tx('No history yet.')}</li>}
          </ol>
          <button className={clsx(btn.ghost, 'text-red-400 hover:text-red-300')} disabled={busy('r') || !!j}
            onClick={() => window.confirm(`Delete ${d.name} (${fmtBytes(d.bytes)}) from disk? You can download it again later.`) && act(`r:${d.id}`, () => data.remove(d.id))}>
            {busy('r') ? spin : <Trash2 className="w-3.5 h-3.5" />}{tx('Delete from disk')}</button>
        </div>
      )}
    </div>
  );
}

/** #/data: the big offline files behind Worlds and Wiki — what's on disk, how old it is, and when it updates. */
export function OfflineData() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [wikiCat, setWikiCat] = useState('All');
  const load = useCallback(() => data.list().then(d => { setO(d); setError(''); }).catch(e => setError(clean(e))), []);
  useEffect(() => { load(); }, [load]);
  const active = o?.datasets.some(d => d.job || d.queued);
  useEffect(() => { const t = setInterval(load, active ? 1500 : 15000); return () => clearInterval(t); }, [load, active]);
  const act = async (key: string, f: () => Promise<unknown>) => {
    setWorking(key); setError('');
    try { await f(); } catch (e) { setError(clean(e)); }
    await load(); setWorking('');
  };

  const used = o?.used ?? 0;
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-8 animate-fade-in space-y-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold tracking-tight flex-1">{tx('Offline data')}</h1>
            <button className={btn.icon} onClick={load} title={tx('Refresh')}><RotateCw className="w-4 h-4" /></button>
          </div>
          <p className="text-sm text-[var(--text-secondary)] max-w-[70ch] leading-relaxed">{tx('Maps and encyclopedias that work with the internet down. Each one with an update schedule is checked once per period and replaced when a newer build is out. The old copy keeps serving until the new one is downloaded and its checksum matches.')}</p>
          {error && <div className="mt-3 flex items-start gap-2 text-xs text-red-400"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{error}</div>}
        </div>

        {!o ? <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-20 rounded-xl bg-[var(--bg-secondary)] animate-pulse" />)}</div> : <>
          <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
            <div className="flex items-baseline gap-2 text-sm">
              <HardDrive className="w-4 h-4 self-center text-[var(--text-muted)]" />
              <span className="font-medium">{fmtBytes(used)}</span><span className="text-[var(--text-secondary)]">{tx('of offline data')}</span>
              <span className="ml-auto font-mono text-xs text-[var(--text-muted)]">{tx('{v0} free of {v1}', { v0: fmtBytes(o.disk.free), v1: fmtBytes(o.disk.total) })}</span>
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden flex" role="img" aria-label={tx('{v0} offline data, {v1} free', { v0: fmtBytes(used), v1: fmtBytes(o.disk.free) })}>
              <div className="h-full bg-[var(--accent)]" style={{ width: `${(used / o.disk.total) * 100}%` }} title={tx('Offline data · {v0}', { v0: fmtBytes(used) })} />
              <div className="h-full bg-[var(--text-muted)]/40" style={{ width: `${((o.disk.total - o.disk.free - used) / o.disk.total) * 100}%` }} title={tx('Everything else')} />
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">{tx('An update needs room for the old and new copy at once, plus 10 GB to spare.')}</p>
          </section>

          {(['wiki', 'worlds'] as const).map(app => {
            const head = APP_HEAD[app];
            const rows = o.datasets.filter(d => d.app === app).sort((a, b) => Number(b.installed) - Number(a.installed));
            const categories = app === 'wiki' ? ['All', ...Array.from(new Set(rows.map(r => r.category).filter(Boolean))) as string[]] : [];
            const displayRows = app === 'wiki' && wikiCat !== 'All' ? rows.filter(r => r.category === wikiCat) : rows;
            const Icon = head.icon;
            return (
              <section key={app} className="space-y-3">
                <div>
                  <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    <Icon className={clsx('w-3.5 h-3.5', head.color)} />{tx(head.label)}
                    <span className="font-mono normal-case tracking-normal">· {fmtBytes(rows.reduce((a, d) => a + d.bytes, 0))}</span>
                    <a href={app === 'wiki' ? '#/wiki' : '#/worlds'} className="ml-auto normal-case tracking-normal font-normal hover:text-[var(--text-primary)]">{tx('Open {label} →', { label: head.label })}</a>
                  </h2>
                  <p className="text-[11px] text-[var(--text-muted)] mt-1 max-w-[75ch]">{tx(head.note)}</p>
                </div>
                {app === 'wiki' && categories.length > 2 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {categories.map(c => {
                      const count = c === 'All' ? rows.length : rows.filter(r => r.category === c).length;
                      const active = wikiCat === c;
                      return (
                        <button key={c} onClick={() => setWikiCat(c)}
                          className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
                            active ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm' : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]')}>
                          {c} <span className={clsx('ml-1 text-[10px] font-mono', active ? 'text-white/80' : 'text-[var(--text-muted)]')}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
                  {displayRows.map(d => <Row key={d.id} d={d} working={working} act={act} />)}
                </div>
                {app === 'worlds' && <p className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5"><Check className="w-3 h-3" />{tx('The mosaics and map fonts were built here and never go stale, so they have no update schedule.')}</p>}
              </section>
            );
          })}
        </>}
      </div>
    </div>
  );
}
