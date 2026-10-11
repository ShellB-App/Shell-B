import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Lightbulb, Loader2, NotebookPen, Pencil, Plus, Quote, RotateCw, Sparkles, StickyNote, Trash2,
  CircleQuestionMark,
} from 'lucide-react';
import { api } from '../../api';
import type { ResearchItem, StudioType } from '../../types';
import { Modal, btn, relTime } from '../common';
import { LEVEL_STYLE, NbMarkdown, STUDIO_META, fmtDuration, useConfirmDelete, useNotebook } from './shared';
import { t as tx } from '../../i18n';

const TILES: StudioType[] = ['briefing', 'study_guide', 'faq', 'timeline', 'mindmap', 'flashcards', 'quiz', 'report'];

function CustomizeModal({ type, onClose }: { type: StudioType | null; onClose: () => void }) {
  const { d, reload } = useNotebook();
  const [focus, setFocus] = useState('');
  const [length, setLength] = useState('default');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (type) { setFocus(''); setLength('default'); } }, [type]);
  if (!type) return null;
  const meta = STUDIO_META[type];
  const go = async () => {
    setBusy(true);
    try { await api.studio(d.id, { type, focus, length }); reload(); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={tx('Customize {label}', { label: meta.label })} icon={<meta.icon className="w-4 h-4" style={{ color: meta.tint }} />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {type === 'audio' && (
          <div>
            <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1.5">{tx('Length')}</label>
            <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] w-fit">
              {[['short', 'Shorter (~3 min)'], ['default', 'Default (~6 min)'], ['long', 'Longer (~10 min)']].map(([v, l]) => (
                <button key={v} onClick={() => setLength(v)} className={clsx('px-3 py-1.5 rounded-lg text-[12.5px] transition',
                  length === v ? 'bg-[var(--bg-hover)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>{l}</button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1.5" htmlFor="st-focus">{tx('What should it focus on?')}</label>
          <textarea id="st-focus" autoFocus className={clsx(btn.input, 'min-h-[110px]')} value={focus} onChange={e => setFocus(e.target.value)}
            placeholder={type === 'audio' ? tx('e.g. Explain it for a sales team; spend most of the time on cost and safety.') : tx('e.g. Only the parts about cost; aimed at engineers new to the topic.')} />
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">{tx('Uses the')} {d.items.filter(i => i.kind === 'source' && i.meta.index === 'ready' && i.meta.selected !== false).length} {tx('selected sources.')}</p>
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
        <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
        <button className={clsx(btn.primary, '!bg-teal-600')} disabled={busy} onClick={go}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{tx('Generate')}</button>
      </footer>
    </Modal>
  );
}

function NoteEditor({ note, open, onClose }: { note?: ResearchItem; open: boolean; onClose: () => void }) {
  const { d, reload } = useNotebook();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [armed, setArmed] = useConfirmDelete();
  useEffect(() => { if (open) { setTitle(note?.title ?? ''); setBody(note?.body ?? ''); setPreview(!!note); } }, [open, note]);
  const save = async () => {
    if (note) await api.patchResearchItem(d.id, note.id, { title, body });
    else await api.addResearchItem(d.id, { kind: 'note', title, body });
    reload(); onClose();
  };
  const remove = async () => {
    if (!note) return;
    if (armed !== note.id) { setArmed(note.id); return; }
    await api.deleteResearchItem(d.id, note.id); reload(); onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={note ? tx('Note') : tx('New note')} icon={<StickyNote className="w-4 h-4 text-amber-500" />} wide={preview}>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {preview ? (
          <>
            <h2 className="text-lg font-semibold">{title || tx('Untitled note')}</h2>
            <NbMarkdown text={body} />
          </>
        ) : (
          <>
            <input className={btn.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={tx('Title')} autoFocus={!note} />
            <textarea className={clsx(btn.input, 'min-h-[260px] leading-relaxed')} value={body} onChange={e => setBody(e.target.value)}
              placeholder={tx('Write a note. Markdown works, and [S1]-style citations link to your sources.')} />
          </>
        )}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex items-center gap-2">
        {note && <button className={clsx(btn.ghost, armed === note.id && 'text-rose-500')} onClick={remove}>
          {armed === note.id ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}{armed === note.id ? tx('Click again to delete') : tx('Delete')}</button>}
        <span className="flex-1" />
        {preview ? <button className={btn.subtle} onClick={() => setPreview(false)}><Pencil className="w-3.5 h-3.5" />{tx('Edit')}</button> : (
          <>
            <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
            <button className={clsx(btn.primary, '!bg-teal-600')} disabled={!title.trim() && !body.trim()} onClick={save}>{tx('Save')}</button>
          </>
        )}
      </footer>
    </Modal>
  );
}

function OutputRow({ it, onOpen }: { it: ResearchItem; onOpen: () => void }) {
  const { d, reload } = useNotebook();
  const [armed, setArmed] = useConfirmDelete();
  const type = it.meta.type as StudioType;
  const meta = STUDIO_META[type] ?? STUDIO_META.report;
  const st = it.meta.status;
  const working = st === 'queued' || st === 'generating' || st === 'voicing';
  const [, tick] = useState(0);
  useEffect(() => { if (!working) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, [working]);
  const elapsed = it.meta.startedAt ? Math.max(0, (Date.now() - it.meta.startedAt) / 1000) : 0;
  const sub = st === 'queued' ? 'Waiting its turn…'
    : st === 'generating' ? `${type === 'audio' ? 'Writing the script' : 'Generating'}… ${fmtDuration(elapsed)}`
    : st === 'voicing' ? `Recording the hosts… ${fmtDuration(elapsed)}`
    : st === 'error' ? (it.meta.error || 'Failed')
    : `${it.meta.duration ? fmtDuration(it.meta.duration) + ' · ' : ''}${relTime(it.meta.finishedAt ?? it.updatedAt)}`;
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (armed !== it.id) { setArmed(it.id); return; }
    await api.deleteResearchItem(d.id, it.id); reload();
  };
  return (
    <div role="button" tabIndex={0} onClick={() => st === 'ready' && onOpen()} onKeyDown={e => e.key === 'Enter' && st === 'ready' && onOpen()}
      className={clsx('group flex items-center gap-3 p-2 rounded-xl transition', st === 'ready' ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : 'cursor-default')}>
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${meta.tint}1f` }}>
        {working ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: meta.tint }} /> : st === 'error' ? <AlertTriangle className="w-4 h-4 text-rose-500" />
          : <meta.icon className="w-4 h-4" style={{ color: meta.tint }} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium truncate">{tx(it.title)}</span>
        <span className={clsx('block text-[11px] truncate', st === 'error' ? 'text-rose-500' : 'text-[var(--text-muted)]')}>{sub}</span>
      </span>
      {st === 'error' && <button className={clsx(btn.icon, 'p-1')} title={tx('Try again')} onClick={e => { e.stopPropagation(); api.retryOutput(d.id, it.id).then(reload); }}><RotateCw className="w-3.5 h-3.5" /></button>}
      {!working && (
        <button className={clsx(btn.icon, 'p-1 transition', armed === it.id ? 'text-rose-500 opacity-100' : 'opacity-0 group-hover:opacity-100')} onClick={remove}
          title={armed === it.id ? tx('Click again to delete') : tx('Delete')}>{armed === it.id ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}</button>
      )}
    </div>
  );
}

export function StudioPanel({ onOpenOutput, onOpenReport }: { onOpenOutput: (id: string) => void; onOpenReport: () => void }) {
  const { d, reload } = useNotebook();
  const [custom, setCustom] = useState<StudioType | null>(null);
  const [note, setNote] = useState<{ item?: ResearchItem } | null>(null);
  const [showFindings, setShowFindings] = useState(false);
  const [starting, setStarting] = useState<StudioType | null>(null);
  const ready = d.items.some(i => i.kind === 'source' && i.meta.index === 'ready' && i.meta.selected !== false);
  const outputs = d.items.filter(i => i.kind === 'output').sort((a, b) => b.createdAt - a.createdAt);
  const notes = d.items.filter(i => i.kind === 'note').sort((a, b) => b.createdAt - a.createdAt);
  const findings = d.items.filter(i => i.kind === 'finding' || i.kind === 'quote' || i.kind === 'question');
  const audioBusy = outputs.some(o => o.meta.type === 'audio' && ['queued', 'generating', 'voicing'].includes(o.meta.status ?? ''));
  const make = async (type: StudioType) => {
    setStarting(type);
    try { await api.studio(d.id, { type }); reload(); } finally { setStarting(null); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-4">
        {/* Audio Overview */}
        <section className="rounded-2xl p-4 text-white relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #0f766e 0%, #134e4a 60%, #3b0764 130%)' }}>
          <div className="flex items-center gap-2 text-[13px] font-semibold"><STUDIO_META.audio.icon className="w-4 h-4" />{tx('Audio Overview')}</div>
          <p className="mt-1 text-[12px] text-white/75 leading-snug">{tx('A podcast-style conversation between two hosts, Alex and Sam, about your sources.')}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setCustom('audio')} disabled={!ready} className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/30 hover:bg-white/10 disabled:opacity-40 transition">{tx('Customize')}</button>
            <button onClick={() => make('audio')} disabled={!ready || audioBusy || starting === 'audio'}
              className="px-3 py-1.5 rounded-full text-[12px] font-semibold bg-white text-teal-800 hover:brightness-95 disabled:opacity-40 transition flex items-center gap-1.5">
              {(audioBusy || starting === 'audio') && <Loader2 className="w-3 h-3 animate-spin" />}{audioBusy ? tx('Generating…') : tx('Generate')}
            </button>
          </div>
        </section>

        {/* tiles */}
        <section className="grid grid-cols-2 gap-2">
          {TILES.map(t => {
            const m = STUDIO_META[t];
            return (
              <div key={t} className="group relative">
                <button disabled={!ready || starting === t} onClick={() => make(t)}
                  className="w-full h-full text-left p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] disabled:opacity-40 transition">
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    {starting === t ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: m.tint }} /> : <m.icon className="w-3.5 h-3.5" style={{ color: m.tint }} />}{tx(m.label)}
                  </span>
                  <span className="block mt-0.5 text-[10.5px] leading-snug text-[var(--text-muted)]">{tx(m.blurb)}</span>
                </button>
                {ready && (
                  <button onClick={() => setCustom(t)} title={tx('Customize')} aria-label={tx('Customize {label}', { label: m.label })}
                    className="absolute top-1.5 right-1.5 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] opacity-0 group-hover:opacity-100 focus:opacity-100 transition">
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </section>
        {!ready && <p className="text-[11.5px] text-[var(--text-muted)] text-center px-2">{tx('Studio works from your sources. Add one, or wait for indexing to finish.')}</p>}

        {/* outputs */}
        {outputs.length > 0 && (
          <section>
            <div className="h-px bg-[var(--border-subtle)] mb-2" />
            {outputs.map(o => <OutputRow key={o.id} it={o} onOpen={() => onOpenOutput(o.id)} />)}
          </section>
        )}

        {/* notes */}
        <section>
          <div className="h-px bg-[var(--border-subtle)] mb-3" />
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <NotebookPen className="w-4 h-4 text-amber-500" /><span className="text-[13px] font-semibold flex-1">{tx('Notes')}</span>
            <button className={btn.ghost} onClick={() => setNote({})}><Plus className="w-3.5 h-3.5" />{tx('Add note')}</button>
          </div>
          {d.summary && (
            <button onClick={onOpenReport} className="w-full text-left flex items-center gap-3 p-2 rounded-xl hover:bg-[var(--bg-secondary)]">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-teal-500/15"><Sparkles className="w-4 h-4 text-teal-600" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{tx('Minerva’s research report')}</span>
                <span className="block text-[11px] text-[var(--text-muted)] truncate">{d.summary.replace(/[#*>[\]]/g, '').slice(0, 90)}</span>
              </span>
            </button>
          )}
          {notes.map(n => (
            <button key={n.id} onClick={() => setNote({ item: n })} className="w-full text-left flex items-center gap-3 p-2 rounded-xl hover:bg-[var(--bg-secondary)]">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-amber-500/15"><StickyNote className="w-4 h-4 text-amber-600" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{n.title || n.body.slice(0, 60) || tx('Untitled note')}</span>
                <span className="block text-[11px] text-[var(--text-muted)] truncate">{n.title ? n.body.replace(/[#*>[\]]/g, '').slice(0, 90) : relTime(n.createdAt)}</span>
              </span>
            </button>
          ))}
          {findings.length > 0 && (
            <div className="mt-1">
              <button onClick={() => setShowFindings(v => !v)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                {showFindings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Minerva’s findings, quotes &amp; questions<span className="ml-auto font-mono text-[10.5px] text-[var(--text-muted)]">{findings.length}</span>
              </button>
              {showFindings && (
                <div className="mt-1 space-y-1.5 px-1">
                  {findings.map(f => {
                    const Icon = f.kind === 'quote' ? Quote : f.kind === 'question' ? CircleQuestionMark : Lightbulb;
                    const c = f.meta.confidence;
                    const cites = f.kind === 'finding' && !/\[S\d/.test(f.body) ? (f.meta.sources ?? []).map(n => `[S${n}]`).join('') : f.kind === 'quote' && f.meta.source ? `[S${f.meta.source}]` : '';
                    return (
                      <div key={f.id} className="flex gap-2 p-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                        <Icon className={clsx('w-3.5 h-3.5 shrink-0 mt-0.5', f.kind === 'finding' && c ? LEVEL_STYLE[c].text : 'text-[var(--text-muted)]')} />
                        <NbMarkdown text={tx('{v0} {cites}{v1}', { v0: f.kind === 'quote' ? `“${f.body}”` : f.body, cites: cites, v1: f.kind === 'question' && f.meta.status === 'answered' ? ' ✓' : '' })}
                          className="!text-[12px] !leading-snug flex-1 min-w-0" />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {!d.summary && notes.length === 0 && findings.length === 0 && (
            <p className="px-2 py-3 text-[11.5px] text-[var(--text-muted)]">{tx('Save chat answers or Studio results here, or write your own notes.')}</p>
          )}
        </section>
      </div>
      <CustomizeModal type={custom} onClose={() => setCustom(null)} />
      <NoteEditor open={!!note} note={note?.item} onClose={() => setNote(null)} />
    </div>
  );
}
