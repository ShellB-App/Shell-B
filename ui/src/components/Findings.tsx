import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, CircleDot, Loader2, XCircle } from 'lucide-react';
import { req } from '../api';
import { relTime } from './common';

export interface Finding {
  id: string; title: string; severity: 'critical' | 'high' | 'medium' | 'low'; file: string;
  status: 'open' | 'fixed' | 'wontfix'; firstSeen: number; lastSeen: number; evidence: string; note: string; source: string;
}

const SEV: Record<Finding['severity'], string> = {
  critical: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  low: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-subtle)]',
};

/** The self-review ledger (server/selfreview.py): what Shell:B's reviews of her own code found, and what became of it.
 *  The nightly review re-checks open findings instead of starting over; you can close or reopen them here. */
export function FindingsPanel() {
  const [items, setItems] = useState<Finding[] | null>(null);
  const [status, setStatus] = useState<'open' | 'fixed' | 'wontfix'>('open');
  const [error, setError] = useState('');
  const load = () => req<Finding[]>(`/api/findings?status=${status}`).then(setItems).catch(e => setError(String(e)));
  useEffect(() => { setItems(null); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const mark = async (f: Finding, s: Finding['status']) => {
    try {
      await req(`/api/findings/${f.id}`, { method: 'PATCH', body: JSON.stringify({ status: s, note: f.note }), headers: { 'Content-Type': 'application/json' } });
      setItems(prev => prev?.filter(x => x.id !== f.id) ?? null);
    } catch (e) { setError(String(e)); }
  };

  return (
    <div>
      <p className="text-sm text-[var(--text-secondary)] mb-4 max-w-[65ch]">
        Issues Shell:B's reviews found in her own code. Each night the review reads the live source, re-checks what is
        still open, and adds only what's new.
      </p>
      <div role="tablist" className="flex gap-1.5 mb-4">
        {(['open', 'fixed', 'wontfix'] as const).map(s => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
            className={clsx('px-2.5 py-1 rounded-lg text-xs border transition',
              status === s ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]/60 font-medium'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
            {s === 'wontfix' ? "Won't fix" : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {error && <div className="mb-3 text-xs text-red-500 dark:text-red-400">{error}</div>}
      {items === null ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" aria-label="Loading" /></div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-[var(--text-muted)]">
          {status === 'open' ? 'Nothing open. The next nightly review will add anything it finds.' : 'Nothing here yet.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map(f => (
            <li key={f.id} className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="flex items-start gap-2">
                <span className={clsx('shrink-0 mt-0.5 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider', SEV[f.severity])}>
                  {f.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-snug">{f.title}</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 font-mono truncate">
                    {f.file || 'no file'} · first seen {relTime(f.firstSeen)} · last seen {relTime(f.lastSeen)}
                  </div>
                  {(f.note || f.evidence) && (
                    <div className="text-xs text-[var(--text-secondary)] mt-1.5 whitespace-pre-wrap break-words max-w-[75ch]">{f.note || f.evidence}</div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {f.status !== 'fixed' && (
                    <button onClick={() => mark(f, 'fixed')} title="Mark fixed" aria-label={`Mark "${f.title}" fixed`}
                      className="p-1.5 rounded-lg text-emerald-600 dark:text-emerald-400 hover:bg-[var(--bg-hover)]"><CheckCircle2 className="w-4 h-4" /></button>
                  )}
                  {f.status !== 'wontfix' && (
                    <button onClick={() => mark(f, 'wontfix')} title="Won't fix" aria-label={`Won't fix "${f.title}"`}
                      className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><XCircle className="w-4 h-4" /></button>
                  )}
                  {f.status !== 'open' && (
                    <button onClick={() => mark(f, 'open')} title="Reopen" aria-label={`Reopen "${f.title}"`}
                      className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><CircleDot className="w-4 h-4" /></button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
