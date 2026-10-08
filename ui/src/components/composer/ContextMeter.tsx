import clsx from 'clsx';
import type { ContextInfo } from '../../types';

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** How full the agent's context window will be on the next turn (an estimate from server/compaction.py). Past 70%,
 *  the oldest messages get summarized after the reply; the originals stay in the chat. */
export function ContextMeter({ info }: { info?: ContextInfo }) {
  if (!info || !info.limit) return null;
  const pct = Math.min(100, Math.round((info.used / info.limit) * 100));
  const high = pct >= 70;
  const title = high
    ? `About ${pct}% of the context window is in use. Older messages will be summarized after the next reply; they stay in the chat.`
    : `About ${pct}% of the agent's context window is in use (estimate).`;
  return (
    <span className="inline-flex items-center gap-1.5 align-middle" title={title} aria-label={title}>
      <span className="relative inline-block w-12 h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden" aria-hidden>
        <span className={clsx('absolute inset-y-0 left-0 rounded-full', high ? 'bg-amber-500' : 'bg-[var(--text-muted)]')}
          style={{ width: `${pct}%` }} />
      </span>
      <span className={clsx('tabular-nums', high && 'text-amber-600 dark:text-amber-400')}>{k(info.used)} / {k(info.limit)}</span>
    </span>
  );
}
