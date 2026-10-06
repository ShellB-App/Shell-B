import clsx from 'clsx';
import { EyeOff } from 'lucide-react';

// Incognito chats (server/privacy.py): not remembered, learned from or searchable, and deleted
// INCOGNITO_HOURS after the last message by the server's sweep.

export const INCOGNITO_HOURS = 24;

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The quiet band under the chat header that says this chat leaves no trace. */
export function IncognitoStrip({ updatedAt }: { updatedAt?: number }) {
  return (
    <div role="status"
      className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 border-b border-dashed border-slate-500/30 bg-slate-500/[0.06] text-[11px] text-[var(--text-secondary)]">
      <EyeOff className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Incognito</span>
      <span className="text-[var(--text-muted)]" aria-hidden>·</span>
      <span className="truncate">
        Not remembered or searchable{updatedAt ? `; deleted ${when(updatedAt + INCOGNITO_HOURS * 3600_000)} unless you continue` : ''}
      </span>
    </div>
  );
}

/** The line under the composer. */
export function IncognitoNote() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-[var(--text-secondary)] mt-1.5">
      <EyeOff className="w-3 h-3 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
      <span>Incognito: Shell:B won’t remember or learn from this chat; it is deleted after {INCOGNITO_HOURS} h.</span>
    </div>
  );
}

/** A small marker beside an incognito chat's title (header, sidebar, palette). */
export function IncognitoMark({ className }: { className?: string }) {
  return (
    <span title="Incognito chat: not remembered, deleted after 24 h" className="inline-flex shrink-0">
      <EyeOff className={clsx('w-3.5 h-3.5 text-slate-500 dark:text-slate-400', className)} aria-label="Incognito" />
    </span>
  );
}
