// Chrome shared by every chat card (chart, table, weather, …): a figure with a slim caption bar, like the map cards.
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export function CardFrame({ icon: Icon, title, meta, actions, children, className }: {
  icon: LucideIcon; title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <figure className={clsx('not-prose my-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden', className)}>
      <figcaption className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] min-w-0">
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium text-[var(--text-secondary)] truncate">{title}</span>
        {meta && <span className="tabular-nums truncate">{meta}</span>}
        <div className="flex-1" />
        {actions}
      </figcaption>
      {children}
    </figure>
  );
}

export function CardButton({ onClick, title, children, active }: { onClick: () => void; title: string; children: ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-pressed={active}
      className={clsx('flex items-center gap-1 shrink-0 rounded transition hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
        active && 'text-[var(--text-primary)]')}>
      {children}
    </button>
  );
}

/** Placeholder while a fence is still streaming in, or when its JSON is broken. */
export function CardPending({ icon: Icon, streaming, waiting, broken }: { icon: LucideIcon; streaming?: boolean; waiting: string; broken: string }) {
  return (
    <div className="not-prose my-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] px-4 py-6 text-[12px] text-[var(--text-muted)] flex items-center gap-2">
      <Icon className={clsx('w-4 h-4 shrink-0', streaming && 'animate-pulse')} />
      {streaming ? waiting : broken}
    </div>
  );
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** CSV download of rows, for the table and chart cards. */
export function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map(r => r.map(cell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'data'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Card fields come from a model: stringify anything, and only follow web, API and in-app links. */
export const text = (v: unknown): string => (v == null ? '' : Array.isArray(v) ? v.map(text).filter(Boolean).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
export const safeUrl = (u: unknown): string | undefined => (typeof u === 'string' && /^(https?:\/\/|\/api\/|#\/)/.test(u) ? u : undefined);
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const linkProps = (url: string) => (url.startsWith('#/') ? {} : { target: '_blank', rel: 'noreferrer noopener' });
