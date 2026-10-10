import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, Check, FileArchive, History, Loader2, Search, Upload, X } from 'lucide-react';
import { AUTH_LOST, adminKey, req } from '../api';
import { btn } from './common';

// Import history (server/importer.py): ChatGPT / Claude data exports become ordinary chats in an
// "Imported from …" project, searchable and readable by "Learn from past chats". Lives at the bottom of Settings → Memory.

interface PreviewConv { id: string; title: string; createdAt: number; updatedAt: number; messages: number; imported: boolean; convId: string | null }
interface Preview {
  token: string; source: 'chatgpt' | 'claude' | 'gemini'; sourceLabel: string; filename: string;
  count: number; already: number; messages: number; from: number | null; to: number | null; conversations: PreviewConv[];
}
interface Job {
  running: boolean; phase: string; done: number; total: number; imported: number; skipped: number; messages: number;
  error: string; source: string; groupId: string | null; groupName: string; finished: number | null;
}
interface Learnable { imported: number; unread: number }

const imp = {
  status: () => req<Job>('/api/import/status'),
  run: (token: string, ids: string[] | null) => req<Job>('/api/import/run', { method: 'POST', body: JSON.stringify({ token, ids }) }),
  discard: (token: string) => req(`/api/import/${token}`, { method: 'DELETE' }),
  learnable: () => req<Learnable>('/api/import/learnable'),
};

/** Upload with progress (fetch can't report it, and exports with images run to gigabytes). */
function upload(file: File, onProgress: (f: number) => void): Promise<Preview> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/import/upload');
    const key = adminKey.get();
    if (key) x.setRequestHeader('X-Shellb-Admin', key);
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.upload.onload = () => onProgress(1);
    x.onload = () => {
      if (x.status === 401) window.dispatchEvent(new Event(AUTH_LOST));
      let body: { detail?: string } & Partial<Preview> = {};
      try { body = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status >= 200 && x.status < 300) resolve(body as Preview);
      else reject(new Error(body.detail || x.statusText || `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error('The upload was interrupted.'));
    const fd = new FormData();
    fd.append('file', file);
    x.send(fd);
  });
}

const n = (v: number) => v.toLocaleString();
const month = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—');
const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const ROWS = 400;

export function HistoryImport({ onLearn, learning }: { onLearn: () => void; learning: boolean }) {
  const [stage, setStage] = useState<'idle' | 'reading' | 'preview' | 'importing' | 'done'>('idle');
  const [file, setFile] = useState('');
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [learnable, setLearnable] = useState<Learnable | null>(null);
  const [learnAsked, setLearnAsked] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const finish = useCallback((j: Job) => {
    setJob(j);
    setStage('done');
    imp.learnable().then(setLearnable).catch(() => {});
    window.dispatchEvent(new Event('shellb-chats-changed'));  // App reloads the sidebar's chats and projects
  }, []);

  useEffect(() => {  // an import still running from before this tab was opened
    imp.status().then(j => { if (j.running) { setJob(j); setStage('importing'); } }).catch(() => {});
  }, []);

  useEffect(() => {
    if (stage !== 'importing') return;
    const t = setInterval(async () => {
      const j = await imp.status().catch(() => null);
      if (!j) return;
      if (j.running) setJob(j); else finish(j);
    }, 600);
    return () => clearInterval(t);
  }, [stage, finish]);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setErr(''); setFile(f.name); setProgress(0); setStage('reading');
    try {
      const p = await upload(f, setProgress);
      setPreview(p);
      setPicked(new Set(p.conversations.filter(c => !c.imported).map(c => c.id)));
      setQ('');
      setStage('preview');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStage('idle');
    }
    if (input.current) input.current.value = '';
  };

  const reset = () => {
    if (preview && stage === 'preview') imp.discard(preview.token).catch(() => {});
    setPreview(null); setJob(null); setErr(''); setLearnAsked(false); setStage('idle');
  };

  const start = async () => {
    if (!preview) return;
    const fresh = preview.conversations.filter(c => !c.imported);
    const ids = picked.size === fresh.length ? null : [...picked];
    try {
      setJob(await imp.run(preview.token, ids));
      setStage('importing');
    } catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error: \d+: /, '') : String(e)); }
  };

  const rows = useMemo(() => {
    const all = preview?.conversations ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter(c => c.title.toLowerCase().includes(needle)) : all;
  }, [preview, q]);
  const selectable = rows.filter(c => !c.imported);
  const allPicked = selectable.length > 0 && selectable.every(c => picked.has(c.id));
  const toggleAll = () => setPicked(prev => {
    const next = new Set(prev);
    selectable.forEach(c => (allPicked ? next.delete(c.id) : next.add(c.id)));
    return next;
  });
  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="border-t border-[var(--border-subtle)] pt-4 space-y-3" aria-labelledby="history-import-title">
      <div>
        <h3 id="history-import-title" className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Import history</h3>
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)] max-w-[65ch]">
          Bring your ChatGPT, Claude or Gemini conversations into Shell:B as searchable chats. Choose the export zip as downloaded,
          or the <code className="font-mono">conversations.json</code> inside it. The file is read on this machine and deleted
          once parsed; nothing leaves it.
        </p>
      </div>

      {stage === 'idle' && (
        <>
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]); }}
            className={clsx('flex flex-wrap items-center gap-3 px-3 py-3 rounded-lg border border-dashed transition',
              drag ? 'border-[var(--accent)] bg-[var(--accent)]/[0.06]' : 'border-[var(--border-subtle)]')}>
            <button className={btn.subtle} onClick={() => input.current?.click()}><Upload className="w-3.5 h-3.5" />Choose export file</button>
            <span className="text-[11px] text-[var(--text-muted)]">or drop a .zip or .json here</span>
            <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" className="hidden"
              onChange={e => choose(e.target.files?.[0])} />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)] max-w-[65ch]">
            <dt className="font-medium text-[var(--text-secondary)]">ChatGPT</dt><dd>Settings → Data controls → Export data. The link arrives by email.</dd>
            <dt className="font-medium text-[var(--text-secondary)]">Claude</dt><dd>Settings → Privacy → Export data. The link arrives by email.</dd>
            <dt className="font-medium text-[var(--text-secondary)]">Gemini</dt><dd>takeout.google.com → My Activity → Gemini Apps, format JSON. Takeout keeps your prompts (and some replies), one chat per day.</dd>
          </dl>
        </>
      )}

      {stage === 'reading' && (
        <div className="space-y-1.5 max-w-md">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="truncate">{progress < 1 ? `Loading ${file}… ${Math.round(progress * 100)}%` : `Reading conversations in ${file}…`}</span>
          </div>
          <Bar value={progress < 1 ? progress : null} />
        </div>
      )}

      {err && (
        <div role="alert" className="flex items-start gap-2 text-[11px] text-red-400">
          <X className="w-3.5 h-3.5 mt-px shrink-0" /><span>{err}</span>
        </div>
      )}

      {stage === 'preview' && preview && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5 text-sm font-medium tracking-tight"><FileArchive className="w-4 h-4 text-[var(--text-muted)]" />{preview.sourceLabel} export</span>
            <Stat label="conversations" value={n(preview.count)} />
            <Stat label="messages" value={n(preview.messages)} />
            <Stat label="span" value={`${month(preview.from)} – ${month(preview.to)}`} />
            {preview.already > 0 && <Stat label="already here" value={n(preview.already)} />}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={`Filter ${n(preview.count)} titles`} />
            </div>
            <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap tabular-nums">{n(picked.size)} selected</span>
          </div>

          <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="w-8 px-2 py-1.5 text-left">
                      <input type="checkbox" className="accent-[var(--accent)]" aria-label="Select all shown" checked={allPicked} disabled={!selectable.length} onChange={toggleAll} />
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">Title</th>
                    <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">Messages</th>
                    <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, ROWS).map(c => (
                    <tr key={c.id} onClick={() => !c.imported && toggle(c.id)}
                      className={clsx('border-b border-[var(--border-subtle)] last:border-0', c.imported ? 'text-[var(--text-muted)]' : 'cursor-pointer hover:bg-[var(--bg-hover)]')}>
                      <td className="px-2 py-1.5">
                        {c.imported
                          ? <Check className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-label="Already imported" />
                          : <input type="checkbox" className="accent-[var(--accent)]" aria-label={`Import ${c.title}`} checked={picked.has(c.id)}
                              onClick={e => e.stopPropagation()} onChange={() => toggle(c.id)} />}
                      </td>
                      <td className="px-2 py-1.5 max-w-0 w-full">
                        <div className="truncate" title={c.title}>
                          {c.imported && c.convId ? <a href={`#/c/${c.convId}`} className="hover:underline" onClick={e => e.stopPropagation()}>{c.title}</a> : c.title}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-[var(--text-secondary)]">{c.messages}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap text-[var(--text-secondary)]">{day(c.updatedAt)}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">No titles match “{q}”.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {rows.length > ROWS && (
              <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                Showing {n(ROWS)} of {n(rows.length)}. Filter to find the rest; the header checkbox still selects all {n(rows.length)}.
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button className={btn.primary} disabled={!picked.size} onClick={start}>
              <History className="w-3.5 h-3.5" />Import {n(picked.size)} chat{picked.size === 1 ? '' : 's'}
            </button>
            <button className={btn.ghost} onClick={reset}>Cancel</button>
            <span className="text-[11px] text-[var(--text-muted)]">Into the project “Imported from {preview.sourceLabel}”, with their original dates.</span>
          </div>
        </div>
      )}

      {stage === 'importing' && (
        <div className="space-y-1.5 max-w-md" aria-live="polite">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Importing… <span className="tabular-nums">{n(job?.done ?? 0)} / {n(job?.total ?? 0)}</span>
          </div>
          <Bar value={job?.total ? job.done / job.total : null} />
        </div>
      )}

      {stage === 'done' && job && (
        <div className="space-y-3">
          <div className={clsx('rounded-lg border px-3 py-2.5 text-xs space-y-1', job.error ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)]')}>
            {job.error
              ? <div className="text-red-400">The import stopped: {job.error}. {job.imported ? `${n(job.imported)} chats were saved before it did; run it again to add the rest.` : ''}</div>
              : <div className="text-[var(--text-primary)]">
                  {job.imported
                    ? <>Imported <b>{n(job.imported)}</b> chat{job.imported === 1 ? '' : 's'} ({n(job.messages)} messages).</>
                    : 'Nothing new to import.'}
                  {job.skipped > 0 && <span className="text-[var(--text-muted)]"> {n(job.skipped)} already here, skipped.</span>}
                </div>}
            {job.groupId && (
              <a href={`#/p/${job.groupId}`} className="inline-flex items-center gap-1 text-[var(--accent-soft)] hover:underline">
                Open {job.groupName}<ArrowRight className="w-3 h-3" />
              </a>
            )}
          </div>

          {learnable && learnable.unread > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button className={btn.subtle} disabled={learning || learnAsked} onClick={() => { setLearnAsked(true); onLearn(); }}>
                {learning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}Learn from imported chats
              </button>
              <span className="text-[11px] text-[var(--text-muted)] max-w-[60ch]">
                {learnAsked
                  ? 'Started. Progress shows beside “Learn from past chats” above; new memories wait there for your OK.'
                  : `The local model reads your side of ${n(learnable.unread)} imported chat${learnable.unread === 1 ? '' : 's'} (and any other chat not read yet) and proposes memories for you to review. Large histories take a while.`}
              </span>
            </div>
          )}

          <button className={btn.ghost} onClick={reset}><Upload className="w-3.5 h-3.5" />Import another file</button>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs text-[var(--text-secondary)]">
      <span className="tabular-nums text-[var(--text-primary)]">{value}</span> <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
    </span>
  );
}

function Bar({ value }: { value: number | null }) {
  return (
    <div className="h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" role="progressbar"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      <div className={clsx('h-full bg-[var(--accent)] transition-[width] duration-300', value === null && 'w-1/3 animate-pulse')}
        style={value === null ? undefined : { width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}
