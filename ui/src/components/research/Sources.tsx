import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowLeft, Check, ClipboardPaste, Compass, ExternalLink, FileText, Link2, Loader2, Plus, RotateCw, Search, Sparkles, Trash2, Upload,
} from 'lucide-react';
import { api } from '../../api';
import type { DiscoverHit, ResearchItem } from '../../types';
import { Modal, btn } from '../common';
import { NbMarkdown, SourceIcon, addedLabel, useConfirmDelete, useNotebook } from './shared';
import { t as tx } from '../../i18n';

// ── add sources ────────────────────────────────────────────────────────────

type AddTab = 'upload' | 'web' | 'text';

export function AddSourcesModal({ open, onClose, onDiscover }: { open: boolean; onClose: () => void; onDiscover: () => void }) {
  const { d, reload } = useNotebook();
  const [tab, setTab] = useState<AddTab>('upload');
  const [urls, setUrls] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setError(''); setBusy(false); } }, [open]);

  const done = () => { reload(); setUrls(''); setTitle(''); setText(''); onClose(); };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); done(); } catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); } finally { setBusy(false); }
  };
  const upload = (files: File[]) => files.length && run(() => api.uploadNotebookFiles(d.id, files));
  const urlList = urls.split(/[\s,]+/).map(u => u.trim()).filter(u => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(u));

  const tabBtn = (t: AddTab, label: string, Icon: typeof Upload) => (
    <button onClick={() => setTab(t)} className={clsx('flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] transition',
      tab === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
      <Icon className="w-4 h-4" />{label}
    </button>
  );
  return (
    <Modal open={open} onClose={onClose} title={tx('Add sources')} icon={<Plus className="w-4 h-4 text-teal-500" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <p className="text-[13px] text-[var(--text-secondary)]">
          {tx('Sources let Minerva base her answers on the material that matters to you. Everything is read, indexed and kept on this machine.')}
        </p>
        <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
          {tabBtn('upload', 'Upload', Upload)}{tabBtn('web', 'Websites', Link2)}{tabBtn('text', 'Paste text', ClipboardPaste)}
        </div>
        {tab === 'upload' && (
          <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}
            onClick={() => file.current?.click()}
            className={clsx('cursor-pointer rounded-2xl border-2 border-dashed py-12 px-6 text-center transition',
              drag ? 'border-teal-500 bg-teal-500/10' : 'border-[var(--border-subtle)] hover:border-teal-500/50 hover:bg-[var(--bg-secondary)]')}>
            {busy ? <Loader2 className="w-7 h-7 mx-auto animate-spin text-teal-500" /> : <Upload className="w-7 h-7 mx-auto text-teal-500" />}
            <p className="mt-3 text-sm font-medium">{tx('Drop files here, or click to choose')}</p>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">{tx('PDF, Word, PowerPoint, Excel, text, Markdown, e-books and images (scans are OCR’d). Up to 100 MB each.')}</p>
            <input ref={file} type="file" multiple hidden onChange={e => upload([...(e.target.files ?? [])])} />
          </div>
        )}
        {tab === 'web' && (
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-[var(--text-muted)]" htmlFor="nb-urls">{tx('Paste one or more links')}</label>
            <textarea id="nb-urls" autoFocus className={clsx(btn.input, 'min-h-[120px] font-mono text-[12.5px]')} value={urls} onChange={e => setUrls(e.target.value)}
              placeholder={'https://example.com/article\nhttps://example.org/report.pdf'} />
            <p className="text-[11px] text-[var(--text-muted)]">{tx('Web pages, online PDFs and documents. Only the text is imported. Paywalled or script-only pages may come through empty.')}</p>
            <button className={clsx(btn.ghost, '-ml-2')} onClick={() => { onClose(); onDiscover(); }}><Compass className="w-3.5 h-3.5 text-teal-500" />{tx('Or search the web for sources')}</button>
          </div>
        )}
        {tab === 'text' && (
          <div className="space-y-2">
            <input className={btn.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={tx('Title (optional)')} />
            <textarea autoFocus className={clsx(btn.input, 'min-h-[200px]')} value={text} onChange={e => setText(e.target.value)} placeholder={tx('Paste notes, an email, a transcript…')} />
          </div>
        )}
        {error && <p className="text-xs text-rose-500">{error}</p>}
      </div>
      {tab !== 'upload' && (
        <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-[var(--text-muted)]">{tab === 'web' && urlList.length ? tx('{length} link{v0}', { length: urlList.length, v0: urlList.length > 1 ? 's' : '' }) : ''}</span>
          <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
          <button className={clsx(btn.primary, '!bg-teal-600')} disabled={busy || (tab === 'web' ? !urlList.length : !text.trim())}
            onClick={() => run(() => (tab === 'web' ? api.addNotebookUrls(d.id, urlList) : api.addNotebookText(d.id, title, text)))}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{tx('Insert')}
          </button>
        </footer>
      )}
    </Modal>
  );
}

export function DiscoverModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { d, reload } = useNotebook();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DiscoverHit[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setQ(q => q || d.question || ''); setHits(null); setPick(new Set()); setError(''); } }, [open, d.question]);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setError('');
    try { const r = await api.discoverSources(d.id, q.trim()); setHits(r); setPick(new Set(r.filter(h => !h.added).slice(0, 5).map(h => h.url))); }
    catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); } finally { setBusy(false); }
  };
  const add = async () => {
    setBusy(true);
    try { await api.addNotebookUrls(d.id, [...pick]); reload(); onClose(); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={tx('Discover sources')} icon={<Compass className="w-4 h-4 text-teal-500" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); search(); }}>
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input autoFocus className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={tx('What are you interested in?')} />
          </div>
          <button className={clsx(btn.primary, '!bg-teal-600')} disabled={busy || !q.trim()}>{busy && !hits ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}{tx('Search')}</button>
        </form>
        <p className="text-[11px] text-[var(--text-muted)]">{tx('Searches the web privately through VASSAGO. Tick the results worth keeping.')}</p>
        {error && <p className="text-xs text-rose-500">{error}</p>}
        {hits && hits.length === 0 && <p className="text-[13px] text-[var(--text-muted)] py-6 text-center">{tx('No results. Try other words.')}</p>}
        <div className="space-y-1.5">
          {hits?.map(h => {
            const on = pick.has(h.url);
            return (
              <label key={h.url} className={clsx('flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer transition',
                h.added ? 'opacity-60 cursor-default border-[var(--border-subtle)]' : on ? 'border-teal-500/60 bg-teal-500/[0.06]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)]')}>
                <input type="checkbox" className="mt-1 accent-teal-600" disabled={h.added} checked={on || h.added}
                  onChange={() => setPick(p => { const n = new Set(p); if (n.has(h.url)) n.delete(h.url); else n.add(h.url); return n; })} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug">{tx(h.title)}</span>
                  <span className="block text-[11px] text-teal-700 dark:text-teal-400 truncate">{h.domain}{h.added ? tx(' · already added') : ''}</span>
                  {h.snippet && <span className="block mt-0.5 text-[12px] text-[var(--text-secondary)] line-clamp-2">{h.snippet}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      {hits && hits.length > 0 && (
        <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
          <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
          <button className={clsx(btn.primary, '!bg-teal-600')} disabled={busy || !pick.size} onClick={add}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{tx('Add')} {pick.size || ''} source{pick.size === 1 ? '' : 's'}
          </button>
        </footer>
      )}
    </Modal>
  );
}

// ── one source ─────────────────────────────────────────────────────────────

export function SourceView({ s, highlight, onBack }: { s: ResearchItem; highlight?: string; onBack: () => void }) {
  const { d, agents, ask, reload } = useNotebook();
  const [text, setText] = useState<string | null>(null);
  const mark = useRef<HTMLElement>(null);
  const [armed, setArmed] = useConfirmDelete();
  useEffect(() => { setText(null); api.sourceText(d.id, s.id).then(r => setText(r.text)).catch(() => setText('')); }, [d.id, s.id, s.meta.index]);
  useEffect(() => { if (text && highlight) requestAnimationFrame(() => mark.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }, [text, highlight]);
  const parts = useMemo(() => {
    if (!text) return null;
    const at = highlight ? text.indexOf(highlight) : -1;
    return at < 0 ? [text] : [text.slice(0, at), text.slice(at, at + highlight!.length), text.slice(at + highlight!.length)];
  }, [text, highlight]);
  const remove = async () => {
    if (armed !== s.id) { setArmed(s.id); return; }
    await api.deleteResearchItem(d.id, s.id); reload(); onBack();
  };
  const state = s.meta.index;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-2 h-11 border-b border-[var(--border-subtle)]">
        <button className={btn.icon} onClick={onBack} aria-label={tx('Back to sources')}><ArrowLeft className="w-4 h-4" /></button>
        <SourceIcon s={s} />
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium ml-1">{s.title || s.url}</span>
        {s.url && <a href={s.url} target="_blank" rel="noreferrer" className={btn.icon} title={tx('Open the original')}><ExternalLink className="w-3.5 h-3.5" /></a>}
        {s.meta.file && <a href={`/api/research/${d.id}/sources/${s.id}/file`} target="_blank" rel="noreferrer" className={btn.icon} title={tx('Open the file')}><FileText className="w-3.5 h-3.5" /></a>}
        <button className={clsx(btn.icon, armed === s.id && 'text-rose-500 hover:text-rose-500')} onClick={remove} title={armed === s.id ? tx('Click again to remove') : tx('Remove source')}>
          {armed === s.id ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">
          <section className="rounded-xl border border-teal-500/25 bg-teal-500/[0.05] p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300 mb-2">
              <Sparkles className="w-3.5 h-3.5" />{tx('Source guide')}
            </div>
            {state === 'indexing' || state === 'pending' ? (
              <p className="text-[13px] text-[var(--text-muted)] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />{tx('Reading and indexing…')}</p>
            ) : state === 'error' ? (
              <div className="text-[13px] text-rose-500 space-y-2">
                <p className="flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{s.meta.error || tx('Couldn’t read this source.')}</p>
                <button className={btn.subtle} onClick={() => api.reindexSource(d.id, s.id).then(reload)}><RotateCw className="w-3.5 h-3.5" />{tx('Try again')}</button>
              </div>
            ) : (
              <>
                <NbMarkdown text={s.meta.guide || s.body || tx('No summary yet.')} className="!text-[13px] !leading-relaxed" />
                {!!s.meta.topics?.length && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {s.meta.topics.map(t => (
                      <button key={t} onClick={() => ask(`Discuss what the sources say about ${t}.`)}
                        className="px-2.5 py-1 rounded-full text-[11.5px] border border-[var(--border-subtle)] bg-[var(--bg-primary)] hover:border-teal-500/60 hover:text-teal-700 dark:hover:text-teal-300 transition">{t}</button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            {s.meta.domain && <span>{s.meta.domain}</span>}
            {s.meta.chars ? <span>{tx('{v0}k characters', { v0: Math.round(s.meta.chars / 1000) })}</span> : null}
            <span>{tx('added by {v0}', { v0: addedLabel(s.addedBy, agents) })}</span>
            {s.ref !== null && <span className="font-mono">S{s.ref}</span>}
          </div>
          {text === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
            : !text ? (state === 'ready' || state === 'no-text' ? <p className="text-[13px] text-[var(--text-muted)]">{tx('No readable text in this source.')}</p> : null)
            : (
              <div className="text-[13px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words font-[450]">
                {parts!.length === 1 ? parts![0] : <>{parts![0]}<mark ref={mark} className="bg-teal-400/30 text-[var(--text-primary)] rounded px-0.5">{parts![1]}</mark>{parts![2]}</>}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────

export function SourcesPanel({ onAdd, onDiscover, open, onOpen }: {
  onAdd: () => void; onDiscover: () => void; open: { id: string; highlight?: string } | null; onOpen: (o: { id: string; highlight?: string } | null) => void;
}) {
  const { d, reload } = useNotebook();
  const srcs = d.items.filter(i => i.kind === 'source');
  const current = open ? srcs.find(s => s.id === open.id) : undefined;
  if (current) return <SourceView s={current} highlight={open?.highlight} onBack={() => onOpen(null)} />;

  const selected = srcs.filter(s => s.meta.selected !== false);
  const all = srcs.length > 0 && selected.length === srcs.length;
  const toggle = async (s: ResearchItem) => { await api.selectSources(d.id, { ids: [s.id], selected: s.meta.selected === false }); reload(); };
  const toggleAll = async () => { await api.selectSources(d.id, { all: true, selected: !all }); reload(); };
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 p-3 grid grid-cols-2 gap-2">
        <button onClick={onAdd} className={clsx(btn.subtle, '!py-2 !rounded-xl')}><Plus className="w-4 h-4" />{tx('Add')}</button>
        <button onClick={onDiscover} className={clsx(btn.subtle, '!py-2 !rounded-xl')}><Compass className="w-4 h-4 text-teal-500" />{tx('Discover')}</button>
      </div>
      {srcs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 pb-10">
          <FileText className="w-8 h-8 text-[var(--text-muted)] mb-2" />
          <p className="text-[13px] font-medium">{tx('Saved sources will appear here')}</p>
          <p className="text-[12px] text-[var(--text-muted)] mt-1">{tx('Add PDFs, websites, documents or pasted text, or let Minerva research and collect them.')}</p>
        </div>
      ) : (
        <>
          <label className="shrink-0 flex items-center gap-2 px-4 py-2 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
            <span className="flex-1">{tx('Select all sources')}</span>
            <input type="checkbox" className="accent-teal-600 w-4 h-4" checked={all} onChange={toggleAll} />
          </label>
          <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
            {srcs.map(s => {
              const st = s.meta.index;
              return (
                <div key={s.id} className="group flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-[var(--bg-secondary)]">
                  <button onClick={() => onOpen({ id: s.id })} className="flex-1 min-w-0 flex items-center gap-2.5 text-left">
                    {st === 'indexing' || st === 'pending' ? <Loader2 className="w-4 h-4 animate-spin text-teal-500 shrink-0" />
                      : st === 'error' ? <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" /> : <SourceIcon s={s} />}
                    <span className="min-w-0 flex-1">
                      <span className={clsx('block text-[13px] leading-snug truncate', s.meta.selected === false && 'text-[var(--text-muted)]')}>{s.title || s.url}</span>
                      {(st === 'error' || s.addedBy === 'auto' || st === 'no-text') && (
                        <span className={clsx('block text-[10.5px] truncate', st === 'error' ? 'text-rose-500' : 'text-[var(--text-muted)]')}>
                          {st === 'error' ? tx('couldn’t read it') : st === 'no-text' ? tx('no readable text') : tx('read by Minerva')}
                        </span>
                      )}
                    </span>
                  </button>
                  <input type="checkbox" className="accent-teal-600 w-4 h-4 shrink-0" checked={s.meta.selected !== false} onChange={() => toggle(s)}
                    aria-label={tx('Use {title} in chat and Studio', { title: s.title })} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
