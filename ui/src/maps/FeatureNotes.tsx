// The "more" part of a map card: whatever Atlas (or the owner) attached to this feature, plus a way to ask for more.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Compass, ExternalLink, Info, Loader2, Maximize2, Trash2 } from 'lucide-react';
import { NOTES_CHANGED, askAtlas, fetchNote, mediaSrc, openMedia, removeNotePart, type FeatureNote, type NoteMedia } from './notes';
import { ModelViewer } from './ModelViewer';

export function FeatureNotes({ body, feature, askHint }: { body: string; feature: string; askHint?: string }) {
  const [note, setNote] = useState<FeatureNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const [edit, setEdit] = useState(false);

  useEffect(() => {
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort(); ctrl = new AbortController();
      fetchNote(body, feature, ctrl.signal).then(n => { setNote(n); setLoading(false); }).catch(e => { if ((e as Error).name !== 'AbortError') setLoading(false); });
    };
    setLoading(true); setNote(null); setEdit(false);
    load();
    window.addEventListener(NOTES_CHANGED, load);
    return () => { ctrl.abort(); window.removeEventListener(NOTES_CHANGED, load); };
  }, [body, feature]);

  const ask = () => askAtlas(askHint ?? `Research ${feature} on ${body} and add what you find to its card: key facts, a short history, `
    + `pictures (and any real sound or video) with credits and licenses, and links for further reading.`);
  const drop = (part: 'facts' | 'sections' | 'media' | 'links', i: number) => removeNotePart(body, feature, part, i).catch(() => {});

  const empty = !note || (!note.summary && !note.facts.length && !note.sections.length && !note.media.length && !note.links.length);
  if (loading) return <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Loader2 className="w-3 h-3 animate-spin" /> Checking for more…</div>;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] space-y-3">
      {!empty && note && (
        <>
          {note.media.length > 0 && (
            <div className="space-y-2">
              {note.media.map((m, i) => <MediaItem key={m.file + i} m={m} onRemove={edit ? () => drop('media', i) : undefined} />)}
            </div>
          )}
          {note.summary && <p className="text-[11.5px] leading-relaxed text-[var(--text-primary)]">{note.summary}</p>}
          {note.facts.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              {note.facts.map((f, i) => (
                <div key={f.label} className="min-w-0 group relative">
                  <dt className="text-[9.5px] uppercase tracking-wider text-[var(--text-muted)] truncate">{f.label}</dt>
                  <dd className="text-[11px] text-[var(--text-primary)] leading-snug">{f.value}</dd>
                  {edit && <RemoveButton onClick={() => drop('facts', i)} />}
                </div>
              ))}
            </dl>
          )}
          {note.sections.map((s, i) => (
            <div key={s.title} className="rounded-lg border border-[var(--border-subtle)] relative">
              <button className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left" aria-expanded={open.has(i)}
                onClick={() => setOpen(o => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                <span className="text-[11.5px] font-semibold text-[var(--text-primary)]">{s.title}</span>
                <ChevronDown className={clsx('w-3.5 h-3.5 text-[var(--text-muted)] transition-transform', open.has(i) && 'rotate-180')} />
              </button>
              {open.has(i) && (
                <div className="px-2.5 pb-2.5 space-y-1.5">
                  {s.text.split(/\n{2,}/).map((p, j) => <p key={j} className="text-[11.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-line">{p}</p>)}
                  {edit && <button onClick={() => drop('sections', i)} className="text-[10.5px] text-rose-500 hover:underline">Remove section</button>}
                </div>
              )}
            </div>
          ))}
          {note.links.length > 0 && (
            <ul className="space-y-1">
              {note.links.map((l, i) => (
                <li key={l.url} className="flex items-center gap-1.5 min-w-0">
                  <ExternalLink className="w-3 h-3 shrink-0 text-[var(--text-muted)]" />
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-[11.5px] text-[var(--accent)] hover:underline truncate">{l.title}</a>
                  {edit && <button onClick={() => drop('links', i)} className="ml-auto text-[var(--text-muted)] hover:text-rose-500" title="Remove link"><Trash2 className="w-3 h-3" /></button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex items-center gap-2">
        <button onClick={ask} className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex items-center gap-1.5">
          <Compass className="w-3.5 h-3.5" /> {empty ? 'Ask Atlas to research this' : 'Ask Atlas for more'}
        </button>
        {!empty && note && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            {note.by && <span title={note.updated ? new Date(note.updated).toLocaleString() : undefined}>Added by {note.by}</span>}
            <button onClick={() => setEdit(e => !e)} className={clsx('px-1.5 py-0.5 rounded hover:text-[var(--text-primary)]', edit && 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]')}>{edit ? 'Done' : 'Edit'}</button>
          </span>
        )}
      </div>
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="absolute top-0 right-0 text-[var(--text-muted)] hover:text-rose-500" title="Remove"><Trash2 className="w-3 h-3" /></button>;
}

function MediaItem({ m, onRemove }: { m: NoteMedia; onRemove?: () => void }) {
  const credit = [m.credit, m.license].filter(Boolean).join(' · ');
  return (
    <figure className="relative">
      {m.kind === 'image' ? (
        <button onClick={() => openMedia(m)} className="group block w-full overflow-hidden rounded-md border border-[var(--border-subtle)] bg-black relative" title="View larger">
          <img src={mediaSrc(m)} alt={m.caption} loading="lazy" className="w-full max-h-48 object-cover" />
          <Maximize2 className="absolute top-1.5 right-1.5 w-3.5 h-3.5 text-white opacity-0 group-hover:opacity-90 drop-shadow" />
        </button>
      ) : m.kind === 'audio' ? (
        <audio controls preload="none" src={mediaSrc(m)} className="w-full h-9" />
      ) : m.kind === 'model' ? (
        <div className="relative h-40 rounded-md border border-[var(--border-subtle)] overflow-hidden bg-gradient-to-b from-[#0b0d14] to-[#141826]">
          <ModelViewer src={mediaSrc(m)} alt={m.caption} className="absolute inset-0" />
          <button onClick={() => openMedia(m)} className="absolute top-1.5 right-1.5 p-1 rounded bg-black/50 text-white/90 hover:bg-black/70" title="View larger"><Maximize2 className="w-3.5 h-3.5" /></button>
        </div>
      ) : (
        <video controls preload="metadata" src={mediaSrc(m)} className="w-full rounded-md bg-black" />
      )}
      <figcaption className="mt-1 text-[10.5px] leading-snug text-[var(--text-secondary)]">
        {m.caption}
        {m.note && <span className="mt-0.5 flex items-start gap-1 text-amber-500"><Info className="w-3 h-3 mt-[1px] shrink-0" />{m.note}</span>}
        {credit && (
          <span className="block text-[var(--text-muted)]">
            {m.source ? <a href={m.source} target="_blank" rel="noopener noreferrer" className="hover:underline">{credit}</a> : credit}
          </span>
        )}
      </figcaption>
      {onRemove && <button onClick={onRemove} className="absolute top-1.5 left-1.5 p-1 rounded bg-black/60 text-white hover:text-rose-400" title="Remove"><Trash2 className="w-3 h-3" /></button>}
    </figure>
  );
}
