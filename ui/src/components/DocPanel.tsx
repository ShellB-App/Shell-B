import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Download, ExternalLink, FileSpreadsheet, FileText, Loader2, Maximize2, Minimize2, RotateCw, X,
} from 'lucide-react';
import { fmtBytes } from '../api';
import { t } from '../i18n';
import { colName, fetchDocView, fileUrl, isSheet, type DocTarget, type DocView, type Sheet } from '../docView';
import { Markdown } from './Markdown';
import { btn } from './common';

const WIDTH_KEY = 'shellb.docPanelPct';
const readPct = () => { try { return Number(localStorage.getItem(WIDTH_KEY)) || 50; } catch { return 50; } };

interface Props {
  target: DocTarget;
  onClose: () => void;
  /** reloads the file when it changes (App passes the chat's message count, so an agent's edit shows up) */
  refreshKey?: unknown;
  /** the phone layout: a full-screen sheet instead of a pane beside the chat */
  mobile?: boolean;
}

/** A chat's document or spreadsheet beside the conversation (split view). */
export function DocPanel({ target, onClose, refreshKey, mobile }: Props) {
  const [view, setView] = useState<DocView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [full, setFull] = useState(false);
  const [pct, setPct] = useState(readPct);
  const [dragging, setDragging] = useState(false);
  const url = fileUrl(target);
  const name = target.path.split('/').pop() ?? target.path;

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchDocView(target)
      .then(v => { if (live) { setView(v); setError(''); } })
      .catch((e: Error) => { if (live) { setView(null); setError(e.message.replace(/^\d+: /, '')); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target.convId, target.path, reload, refreshKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && full) setFull(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [full]);

  const Icon = isSheet(target.path) ? FileSpreadsheet : FileText;
  return (
    <section
      className={clsx('relative flex flex-col bg-[var(--bg-primary)] border-l border-[var(--border-subtle)] min-w-0',
        full || mobile ? 'fixed inset-0 z-50' : 'fixed inset-0 z-40 md:static md:z-auto md:w-[var(--doc-w)] md:shrink-0 h-full')}
      style={{ '--doc-w': `${pct}%` } as React.CSSProperties}
      aria-label={t('Split view')}
    >
      {!full && !mobile && (
        <div title={t('Drag to resize; double-click to reset')}
          className={clsx('hidden md:block absolute -left-1 top-0 bottom-0 w-2 z-10 cursor-col-resize hover:bg-[var(--accent)]/30', dragging && 'bg-[var(--accent)]/40')}
          onDoubleClick={() => { setPct(50); try { localStorage.setItem(WIDTH_KEY, '50'); } catch { /* private mode */ } }}
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
          onPointerMove={e => {
            if (!dragging) return;
            setPct(Math.min(75, Math.max(25, ((window.innerWidth - e.clientX) / window.innerWidth) * 100)));
          }}
          onPointerUp={() => { setDragging(false); try { localStorage.setItem(WIDTH_KEY, String(Math.round(pct))); } catch { /* private mode */ } }} />
      )}
      {/* an iframe swallows pointer events, so cover it while dragging */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      <header className="h-12 shrink-0 border-b border-[var(--border-subtle)] px-3 flex items-center gap-2 bg-[var(--bg-secondary)]">
        <span className="w-6 h-6 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] flex items-center justify-center shrink-0"><Icon className="w-3.5 h-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" title={`/work/${target.path}`}>{name}</div>
          {view && <div className="text-[10px] text-[var(--text-muted)] truncate">{fmtBytes(view.size)}{target.path.includes('/') ? ` · /work/${target.path}` : ''}</div>}
        </div>
        <button onClick={() => setReload(r => r + 1)} title={t('Reload')} className={btn.icon}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
        </button>
        <a href={url} target="_blank" rel="noreferrer" title={t('Open in a new tab')} className={btn.icon}><ExternalLink className="w-4 h-4" /></a>
        <a href={`${url}?download=1`} download={name} title={t('Download')} className={btn.icon}><Download className="w-4 h-4" /></a>
        {!mobile && (
          <button onClick={() => setFull(f => !f)} title={full ? t('Back to split view') : t('Full screen')} className={clsx(btn.icon, 'hidden md:inline-flex')}>
            {full ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        )}
        <button onClick={onClose} title={t('Close')} className={btn.icon}><X className="w-4 h-4" /></button>
      </header>

      {(view?.truncated || view?.note) && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-[var(--border-subtle)]">
          {view.note ?? t('This file is long; split view shows the beginning. Download it for the rest.')}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {error ? (
          <div className="m-auto max-w-sm text-center p-6 text-sm text-[var(--text-secondary)]">
            <p className="mb-3">{error}</p>
            <a href={`${url}?download=1`} download={name} className={btn.primary}><Download className="w-3.5 h-3.5" />{t('Download')}</a>
          </div>
        ) : !view ? (
          <div className="m-auto"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
        ) : view.kind === 'sheet' ? (
          <SheetView key={`${target.convId}/${target.path}`} sheets={view.sheets} active={view.active} />
        ) : view.kind === 'pdf' ? (
          <iframe title={name} src={view.url} className={clsx('flex-1 w-full bg-white', dragging && 'pointer-events-none')} />
        ) : view.kind === 'doc' ? (
          <div className="flex-1 overflow-y-auto">
            <article className="docview prose-shellb mx-auto max-w-[52rem] px-6 sm:px-10 py-8" dangerouslySetInnerHTML={{ __html: view.html }} />
          </div>
        ) : view.kind === 'markdown' ? (
          <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-[52rem] px-6 py-6"><Markdown text={view.text} /></div></div>
        ) : (
          <pre className="flex-1 overflow-auto p-4 text-xs font-mono whitespace-pre-wrap break-words">{view.text}</pre>
        )}
      </div>
    </section>
  );
}


/** One workbook: a grid per sheet with column letters and row numbers, a formula bar, and sheet tabs. */
function SheetView({ sheets, active }: { sheets: Sheet[]; active: number }) {
  const shown = sheets.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden || sheets.every(x => x.hidden));
  const [idx, setIdx] = useState(shown.some(x => x.i === active) ? active : shown[0]?.i ?? 0);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sheet = sheets[idx];

  // merged ranges: the top-left cell spans, the rest are skipped
  const { spans, covered, bold } = useMemo(() => {
    const spans = new Map<string, [number, number]>(), covered = new Set<string>();
    for (const [r1, c1, r2, c2] of sheet?.merges ?? []) {
      spans.set(`${r1},${c1}`, [r2 - r1 + 1, c2 - c1 + 1]);
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r},${c}`);
    }
    return { spans, covered, bold: new Set((sheet?.bold ?? []).map(([r, c]) => `${r},${c}`)) };
  }, [sheet]);

  if (!sheet) return null;
  const cols = sheet.rows[0]?.length ?? 0;
  const value = sel ? sheet.rows[sel[0]]?.[sel[1]] ?? '' : '';
  const formula = sel ? sheet.formulas[`${sel[0]},${sel[1]}`] : undefined;
  const width = (c: number) => {
    const w = sheet.widths[colName(c)];
    return w ? Math.min(420, Math.max(40, Math.round(w * 7 + 5))) : undefined;
  };

  const move = (e: React.KeyboardEvent) => {
    if (!sel) return;
    const [r, c] = sel;
    const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, e.shiftKey ? -1 : 1] };
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { navigator.clipboard?.writeText(value).catch(() => { /* no permission */ }); return; }
    if (!d[e.key]) return;
    e.preventDefault();
    const next: [number, number] = [Math.min(sheet.rows.length - 1, Math.max(0, r + d[e.key][0])), Math.min(cols - 1, Math.max(0, c + d[e.key][1]))];
    setSel(next);
    grid.current?.querySelector(`[data-cell="${next[0]},${next[1]}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--border-subtle)] text-xs font-mono">
        <span className="w-16 shrink-0 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-center">{sel ? `${colName(sel[1])}${sel[0] + 1}` : ''}</span>
        <span className="text-[var(--text-muted)] italic">fx</span>
        <span className="min-w-0 flex-1 truncate select-text" title={formula ?? value}>
          {formula ? <>{formula} <span className="text-[var(--text-muted)]">= {value}</span></> : value}
        </span>
      </div>
      <div ref={grid} tabIndex={0} onKeyDown={move} className="flex-1 min-h-0 overflow-auto outline-none">
        {sheet.rows.length === 0 ? (
          <div className="p-6 text-sm text-[var(--text-muted)] text-center">{t('This sheet is empty.')}</div>
        ) : (
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 bg-[var(--bg-tertiary)] border-b border-r border-[var(--border-subtle)] min-w-[2.5rem]" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} style={{ minWidth: width(c) ?? 64, maxWidth: width(c) }}
                    className={clsx('sticky top-0 z-10 px-2 py-0.5 font-medium border-b border-r border-[var(--border-subtle)]',
                      sel?.[1] === c ? 'bg-[var(--accent)]/20 text-[var(--accent-soft)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>
                    {colName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th className={clsx('sticky left-0 z-10 px-1.5 text-right font-medium border-b border-r border-[var(--border-subtle)]',
                    sel?.[0] === r ? 'bg-[var(--accent)]/20 text-[var(--accent-soft)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>{r + 1}</th>
                  {row.map((v, c) => {
                    const k = `${r},${c}`;
                    if (covered.has(k)) return null;
                    const span = spans.get(k);
                    const numeric = /^[-+]?[\d,]*\.?\d+(e[-+]?\d+)?%?$/i.test(v);
                    return (
                      <td key={c} data-cell={k} rowSpan={span?.[0]} colSpan={span?.[1]} onClick={() => setSel([r, c])}
                        style={{ maxWidth: width(c) ?? 320 }}
                        className={clsx('px-2 py-0.5 border-b border-r border-[var(--border-subtle)] whitespace-nowrap overflow-hidden text-ellipsis cursor-cell',
                          numeric && 'text-right tabular-nums', bold.has(k) && 'font-semibold', sheet.formulas[k] && 'text-[var(--accent-soft)]',
                          sel?.[0] === r && sel?.[1] === c && 'outline outline-2 -outline-offset-2 outline-[var(--accent)]')}>
                        {v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sheet.truncated && (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
            {t('Showing {rows} of {total} rows and {cols} of {totalCols} columns.', { rows: sheet.rows.length, total: sheet.nrows, cols, totalCols: sheet.ncols })}
          </div>
        )}
      </div>
      {shown.length > 1 && (
        <div className="shrink-0 flex gap-0.5 overflow-x-auto border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-1">
          {shown.map(({ s, i }) => (
            <button key={i} onClick={() => { setIdx(i); setSel(null); }}
              className={clsx('px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition',
                i === idx ? 'border-[var(--accent)] text-[var(--text-primary)] font-medium bg-[var(--bg-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
