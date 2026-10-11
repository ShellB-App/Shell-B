import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import clsx from 'clsx';
import { ArrowUp, BookmarkPlus, Check, Copy, Eraser, Loader2, Plus, RotateCw, Sparkles, Square } from 'lucide-react';
import { api, streamNotebookChat } from '../../api';
import type { NotebookCitation, NotebookMessage } from '../../types';
import { btn } from '../common';
import { NbMarkdown, useNotebook } from './shared';
import { t } from '../../i18n';

export interface ChatHandle { ask: (text: string) => void }

/** Passage citations [n] → the notebook's source numbers [S#], so a saved answer keeps working citations. */
function toSourceCites(text: string, cites?: Record<string, NotebookCitation>) {
  return text.replace(/\[(\d+)\](?!\()/g, (m, n) => (cites?.[n]?.ref ? `[S${cites[n].ref}]` : m)).replace(/(\[S\d+\])(?:\1)+/g, '$1');
}

function Answer({ m, streaming, onSave }: { m: NotebookMessage; streaming: boolean; onSave: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div className="group">
      <NbMarkdown text={m.content || (streaming ? '…' : '')} citations={m.citations ?? {}} className={clsx(streaming && 'caret-last')} />
      {!streaming && m.content && (
        <div className="mt-2 flex items-center gap-1">
          <button className={clsx(btn.ghost, '!px-2 !py-1 border border-[var(--border-subtle)] rounded-full')} disabled={saved}
            onClick={async () => { await onSave(); setSaved(true); }}>
            {saved ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <BookmarkPlus className="w-3.5 h-3.5" />}{saved ? t('Saved') : t('Save to note')}
          </button>
          <button className={btn.icon} title={t('Copy')} onClick={() => { navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

export function NotebookChat({ handle, onAddSources }: { handle: Ref<ChatHandle>; onAddSources: () => void }) {
  const { d, saveNote, reload } = useNotebook();
  const [msgs, setMsgs] = useState<NotebookMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => { setMsgs(null); api.notebookChat(d.id).then(setMsgs).catch(() => setMsgs([])); }, [d.id]);
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const srcs = d.items.filter(i => i.kind === 'source');
  const ready = srcs.filter(s => s.meta.index === 'ready' && s.meta.selected !== false);
  const indexing = srcs.some(s => s.meta.index === 'indexing' || s.meta.index === 'pending');

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput(''); setError(''); setBusy(true);
    atBottom.current = true;
    const live: NotebookMessage = { id: 'live', role: 'assistant', content: '', citations: {}, createdAt: Date.now() };
    setMsgs(m => [...(m ?? []), { id: `u${Date.now()}`, role: 'user', content: q, createdAt: Date.now() }, live]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const patch = (f: (m: NotebookMessage) => NotebookMessage) => setMsgs(ms => ms?.map(m => (m.id === 'live' ? f(m) : m)) ?? ms);
    try {
      for await (const ev of streamNotebookChat(d.id, q, ctrl.signal)) {
        if (ev.type === 'citations') patch(m => ({ ...m, citations: ev.citations }));
        else if (ev.type === 'delta') patch(m => ({ ...m, content: m.content + ev.text }));
        else if (ev.type === 'done') patch(m => ({ ...m, id: ev.id, citations: { ...m.citations, ...ev.citations } }));
        else if (ev.type === 'error') setError(ev.error);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(String(e));
    } finally {
      setBusy(false); abort.current = null;
      setMsgs(ms => ms?.map(m => (m.id === 'live' ? { ...m, id: `a${Date.now()}` } : m)) ?? ms);
    }
  }, [busy, d.id]);
  useImperativeHandle(handle, () => ({ ask: send }), [send]);

  const questions = (d.guide?.questions ?? []).map(q => q.replace(/\*\*|__/g, '')).filter(q => !msgs?.some(m => m.content === q));
  const clear = async () => { await api.clearNotebookChat(d.id); setMsgs([]); };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={scroller} className="flex-1 overflow-y-auto" onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
          {/* notebook overview, like the top of a NotebookLM chat */}
          <div className="mb-8">
            <div className="text-4xl mb-3" aria-hidden>{d.emoji || '📓'}</div>
            <h1 className="text-[26px] font-semibold tracking-tight leading-tight">{t(d.title)}</h1>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">{srcs.length} source{srcs.length === 1 ? '' : 's'}{indexing ? t(' · indexing…') : ''}</p>
            {srcs.length === 0 ? (
              <div className="mt-6 p-6 rounded-2xl border border-dashed border-[var(--border-subtle)] text-center">
                <p className="text-sm font-medium">{t('Add a source to get started')}</p>
                <p className="text-[12.5px] text-[var(--text-muted)] mt-1 max-w-md mx-auto">
                  {t('Upload PDFs and documents, add web pages, paste text, or ask Minerva to research the question and gather sources for you.')}
                </p>
                <button className={clsx(btn.primary, '!bg-teal-600 mt-4')} onClick={onAddSources}><Plus className="w-3.5 h-3.5" />{t('Add sources')}</button>
              </div>
            ) : d.guide?.summary ? (
              <NbMarkdown text={t(d.guide.summary)} className="mt-4 !text-[15px] !leading-relaxed" />
            ) : (
              <p className="mt-4 text-[13px] text-[var(--text-muted)] flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />{indexing ? t('Reading your sources…') : t('Writing the overview…')}
                {!indexing && <button className={clsx(btn.ghost, '!py-0.5')} onClick={() => api.refreshNotebookGuide(d.id).then(reload)}><RotateCw className="w-3 h-3" /></button>}
              </p>
            )}
          </div>

          {msgs === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" /> : (
            <div className="space-y-6">
              {msgs.map((m, i) => m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[14px] whitespace-pre-wrap">{m.content}</div>
                </div>
              ) : (
                <Answer key={m.id} m={m} streaming={busy && m.id === 'live'}
                  onSave={() => saveNote(msgs[i - 1]?.content.slice(0, 120) || 'Saved response', toSourceCites(m.content, m.citations))} />
              ))}
            </div>
          )}
          {error && <p className="mt-4 text-[13px] text-rose-500">{error}</p>}
          {msgs && msgs.length > 0 && !busy && (
            <div className="mt-6 flex justify-center">
              <button className={btn.ghost} onClick={clear}><Eraser className="w-3.5 h-3.5" />{t('Clear chat')}</button>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 sm:px-6 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          {questions.length > 0 && !busy && ready.length > 0 && (
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
              {questions.map(q => (
                <button key={q} onClick={() => send(q)}
                  className="shrink-0 max-w-[22rem] text-left px-3 py-1.5 rounded-xl text-[12px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-teal-500/50 hover:text-[var(--text-primary)] transition">
                  <Sparkles className="w-3 h-3 inline mr-1 -mt-0.5 text-teal-500" />{q}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={e => { e.preventDefault(); send(input); }}
            className="flex items-end gap-2 p-2 pl-4 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] focus-within:border-teal-500/60 transition">
            <textarea value={input} onChange={e => setInput(e.target.value)} rows={1} disabled={srcs.length === 0}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              placeholder={srcs.length === 0 ? t('Add a source to start chatting') : t('Start typing…')}
              className="flex-1 min-w-0 resize-none bg-transparent text-[14px] py-1.5 placeholder-[var(--text-muted)] focus:outline-none max-h-40 [field-sizing:content]" />
            <span className="self-center shrink-0 text-[11px] text-[var(--text-muted)] whitespace-nowrap">{ready.length} source{ready.length === 1 ? '' : 's'}</span>
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()} className="shrink-0 p-2 rounded-xl bg-[var(--bg-hover)]" aria-label={t('Stop')}><Square className="w-4 h-4" /></button>
            ) : (
              <button type="submit" disabled={!input.trim() || srcs.length === 0} className="shrink-0 p-2 rounded-xl bg-teal-600 text-white disabled:opacity-30 hover:brightness-110 transition" aria-label={t('Send')}>
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </form>
          <p className="mt-1.5 text-center text-[10.5px] text-[var(--text-muted)]">{t('Answers come only from your selected sources; check anything important against them.')}</p>
        </div>
      </div>
    </div>
  );
}
