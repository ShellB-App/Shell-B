import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Check, ChevronDown, Copy, Download, ExternalLink,
  File as FileIcon, Loader2, Pin, RefreshCw, Trash2, X
} from 'lucide-react';
import { api, fmtBytes } from '../../api';
import type { CodexEntry, CodexIndex } from '../../types';
import { Markdown } from '../Markdown';
import { btn, relTime } from '../common';
import { Draft, KIND, busyIndex, who } from './types';
import { IndexState, TagInput } from './Inputs';
import { t as tx } from '../../i18n';

/** Opens, edits and creates one entry. `start` is a saved entry, or a blank draft for a new one. */
export function Editor({ start, index, agentNames, onClose, onSaved, onDeleted }: {
  start: Draft; index: CodexIndex | null; agentNames: Record<string, string>;
  onClose: () => void; onSaved: (e: CodexEntry) => void; onDeleted: (id: string) => void;
}) {
  const [e, setE] = useState<Draft>(start);
  const [full, setFull] = useState<CodexEntry | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview'>(start.id ? 'preview' : 'edit');
  const [showText, setShowText] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (id: string) => {
    const f = await api.codexEntry(id);
    setFull(f);
    setE(prev => (dirty ? prev : { ...f }));
    return f;
  }, [dirty]);
  useEffect(() => { if (start.id) load(start.id).catch(err => setError(String(err))); }, [start.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {  // follow indexing and page copies until they finish
    if (!full || !busyIndex(full)) return;
    const t = setTimeout(() => { api.codexEntry(full.id).then(f => { setFull(f); if (!dirty) setE(p => ({ ...p, title: f.title, meta: f.meta })); onSaved(f); }).catch(() => {}); }, 2000);
    return () => clearTimeout(t);
  }, [full, dirty, onSaved]);

  const set = (patch: Partial<Draft>) => { setE(p => ({ ...p, ...patch })); setDirty(true); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { title: e.title, body: e.body ?? '', tags: e.tags ?? [], language: e.language, url: e.url, collectionId: e.collectionId ?? '', pinned: e.pinned, meta: e.meta || {} };
      const saved = e.id ? await api.patchCodexEntry(e.id, body) : await api.createCodexEntry({ ...body, kind: e.kind });
      setDirty(false);
      onSaved(saved);
      await load(saved.id).catch(() => {});
      setE(saved.id === e.id ? (p => ({ ...p, ...saved })) : { ...saved, body: body.body });
      if (e.kind === 'note') setTab('preview');
    } catch (err) { setError(String(err).replace(/^Error: \d+: /, '')); }
    setBusy(false);
  };
  const accept = async () => { if (!e.id) return; const s = await api.patchCodexEntry(e.id, { draft: false }); setE(p => ({ ...p, draft: false })); onSaved(s); };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (dirty && !busy) save(); }
      else if (ev.key === 'Escape' && !dirty) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const K = KIND[e.kind];
  const allTags = (index?.tags ?? []).map(([t]) => t);
  const shown = full ?? (e as CodexEntry);
  const isImage = /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(e.meta?.file ?? '');
  const area = 'w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--accent)]/70 resize-y';

  return (
    <div className="fixed inset-0 z-40 md:static md:z-auto md:w-[min(46vw,640px)] md:shrink-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)] shrink-0">
        <K.icon className={clsx('w-4 h-4', K.color)} />
        <span className="text-xs text-[var(--text-secondary)] flex-1">{e.id ? tx(K.label) : tx('New {v0}', { v0: K.label.toLowerCase() })}{dirty && tx(' · unsaved')}</span>
        {e.id && <button className={btn.icon} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={() => set({ pinned: !e.pinned })}>
          <Pin className={clsx('w-4 h-4', e.pinned && 'fill-current text-[var(--accent)]')} /></button>}
        <button className={btn.icon} onClick={() => { if (!dirty || confirm(tx('Discard your changes?'))) onClose(); }} aria-label={tx('Close')}><X className="w-4 h-4" /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        {e.draft && (
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-amber-500/35 bg-amber-500/5 text-xs">
            <span className="flex-1 min-w-[180px]">{tx('Draft added by {v0}. Agents can see it, but it stays a draft until you accept it.', { v0: who(e as CodexEntry, agentNames) })}</span>
            <button className={btn.primary} onClick={accept}><Check className="w-3.5 h-3.5" />{tx('Accept')}</button>
          </div>
        )}
        <input className="w-full bg-transparent text-xl font-semibold focus:outline-none placeholder-[var(--text-muted)]" value={e.title ?? ''}
          placeholder={e.kind === 'link' ? tx('Title (filled in from the page)') : tx('Title')} onChange={ev => set({ title: ev.target.value })} autoFocus={!e.id && e.kind !== 'link'} />
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_1fr] gap-2">
          <select className={btn.input} value={e.collectionId ?? ''} onChange={ev => set({ collectionId: ev.target.value || null })} aria-label={tx('Collection')}>
            <option value="">{tx('Unfiled')}</option>
            {index?.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <TagInput value={e.tags ?? []} onChange={tags => set({ tags })} all={allTags} />
        </div>

        {e.kind === 'link' && (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input className={btn.input} value={e.url ?? ''} placeholder="https://…" onChange={ev => set({ url: ev.target.value })} autoFocus={!e.id} />
              {e.url && <a className={btn.subtle} href={e.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="w-3.5 h-3.5" />{tx('Open')}</a>}
            </div>
            {e.id && shown.meta?.snapshot && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                {shown.meta.snapshot.status === 'ok' && <span>{tx('Copy saved {v0} · {v1} characters', { v0: relTime(shown.meta.snapshot.at ?? 0), v1: (shown.meta.snapshot.chars ?? 0).toLocaleString() })}</span>}
                {shown.meta.snapshot.status === 'error' && <span className="text-red-400">{tx('Couldn\'t save a copy: {error}', { error: shown.meta.snapshot.error ?? '' })}</span>}
                {shown.meta.snapshot.status === 'pending' && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />{tx('Saving a copy…')}</span>}
                {shown.meta.snapshot.status !== 'pending' && (
                  <button className="flex items-center gap-1 hover:text-[var(--text-primary)]" onClick={async () => { const f = await api.resnapCodexEntry(e.id!); setFull(f); }}>
                    <RefreshCw className="w-3 h-3" />{tx('Save a fresh copy')}</button>
                )}
              </div>
            )}
          </div>
        )}

        {e.kind === 'file' && e.id && e.meta?.file && (
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <FileIcon className="w-4 h-4 text-violet-400" />
            <span className="text-sm truncate flex-1 min-w-0">{e.meta.file}</span>
            <span className="text-[11px] text-[var(--text-muted)]">{fmtBytes(e.meta.size ?? 0)}</span>
            <a className={btn.ghost} href={`/api/codex/file/${e.id}`} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" />{tx('Open')}</a>
            <a className={btn.ghost} href={`/api/codex/file/${e.id}?download=true`}><Download className="w-3.5 h-3.5" />{tx('Download')}</a>
          </div>
        )}
        {e.kind === 'file' && isImage && e.id && <img src={`/api/codex/file/${e.id}`} alt={e.title} className="max-h-80 rounded-lg border border-[var(--border-subtle)] mx-auto" />}

        {e.kind === 'snippet' ? (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input className={clsx(btn.input, 'max-w-[180px]')} value={e.language ?? ''} placeholder={tx('Language (bash, python…)')} onChange={ev => set({ language: ev.target.value })} />
              <span className="flex-1" />
              <button className={btn.ghost} onClick={() => { navigator.clipboard?.writeText(e.body ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? tx('Copied') : tx('Copy')}</button>
            </div>
            <textarea className={clsx(area, 'font-mono text-[13px] min-h-[260px] bg-[var(--bg-code)]')} spellCheck={false} value={e.body ?? ''}
              placeholder={tx('Paste the command, code or config')} onChange={ev => set({ body: ev.target.value })} autoFocus={!e.id} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span className="text-xs text-[var(--text-secondary)] flex-1">{e.kind === 'note' ? tx('Note') : tx('Your notes')}</span>
              {(['edit', 'preview'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)} className={clsx('px-2 py-0.5 rounded text-[11px]', tab === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                  {t === 'edit' ? tx('Edit') : tx('Preview')}</button>
              ))}
            </div>
            {tab === 'edit' ? (
              <textarea className={clsx(area, e.kind === 'note' ? 'min-h-[320px]' : 'min-h-[120px]')} value={e.body ?? ''}
                placeholder={e.kind === 'note' ? tx('Markdown: procedures, reference tables, decisions, anything worth keeping') : tx('Why this matters, what to look for')}
                onChange={ev => set({ body: ev.target.value })} />
            ) : (
              <div className="min-h-[80px] px-3 py-2 rounded-lg border border-[var(--border-subtle)] cursor-text" onDoubleClick={() => setTab('edit')} title={tx('Double-click to edit')}>
                {e.body ? <Markdown text={e.body} /> : <span className="text-sm text-[var(--text-muted)]">{tx('Nothing written yet. Double-click to edit.')}</span>}
              </div>
            )}
          </div>
        )}

        {full?.text && (e.kind === 'link' || e.kind === 'file') && (
          <div>
            <button className="flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => setShowText(!showText)}>
              <ChevronDown className={clsx('w-3.5 h-3.5 transition', !showText && '-rotate-90')} />
              {e.kind === 'link' ? tx('Saved copy of the page') : tx('Extracted text')} · {full.text.length.toLocaleString()} characters
            </button>
            {showText && <pre className="mt-1.5 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs whitespace-pre-wrap break-words max-h-[28rem] overflow-y-auto font-sans">{full.text}</pre>}
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-4 pr-4 md:pr-16 py-2.5 border-t border-[var(--border-subtle)] shrink-0 text-[11px] text-[var(--text-muted)]">
        <span className="flex-1 min-w-[160px]">
          {e.id && full ? <><IndexState e={full} /><span className="block">{tx('Added by {v0} {v1} · edited {v2}', { v0: who(full, agentNames), v1: relTime(full.createdAt), v2: relTime(full.updatedAt) })}</span></> : tx('Ctrl+S saves')}
        </span>
        {e.id && (confirmDel ? (<>
          <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={async () => { await api.deleteCodexEntry(e.id!); onDeleted(e.id!); }}>{tx('Delete')}</button>
          <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(false)}>{tx('Keep')}</button>
        </>) : <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Delete')} onClick={() => setConfirmDel(true)}><Trash2 className="w-4 h-4" /></button>)}
        <button className={btn.primary} disabled={busy || !dirty || (e.kind === 'link' && !e.url?.trim()) || (e.kind !== 'link' && !e.body?.trim() && !e.title?.trim())} onClick={save}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}{e.id ? tx('Save') : tx('Add to Codex')}
        </button>
      </div>
    </div>
  );
}
