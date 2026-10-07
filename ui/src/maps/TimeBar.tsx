// The time controls for the shared Worlds clock (clock.ts): rewind / play / fast-forward, the date, and Now.
import clsx from 'clsx';
import { FastForward, Pause, Play, Rewind } from 'lucide-react';
import { RATE_LABEL, fmtClock, goLive, nudgeRate, setClock, togglePlay, useClockState, useClockTime } from './clock';

const iconBtn = 'h-7 w-7 grid place-items-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition';

/** `playRate` is the rate Play starts at: 1-based index into RATES (2 = a minute a second, 5 = a day a second). */
export function TimeBar({ playRate, className, note }: { playRate: number; className?: string; note?: string | null }) {
  const s = useClockState();
  const t = useClockTime(1000);
  const setDate = (v: string) => {
    const [d, hm] = v.split('T');
    const ms = Date.parse(`${d}T${hm ?? '12:00'}:00Z`);
    if (Number.isFinite(ms)) setClock(ms);
  };
  const playing = !s.live && s.rate !== 0;
  return (
    <div className={clsx('flex flex-col items-center gap-1 pointer-events-none', className)}>
      {note && <div className="pointer-events-auto rounded-md border border-amber-500/40 sb-map-glass px-2 py-0.5 text-[11px] text-amber-500 max-w-full">{note}</div>}
      <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] sb-map-glass px-1.5 py-1 max-w-full">
        <button className={iconBtn} onClick={() => nudgeRate(-1)} title="Slower, or backwards"><Rewind className="w-3.5 h-3.5" /></button>
        <button className={iconBtn} onClick={() => togglePlay(playRate)} title={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
        <button className={iconBtn} onClick={() => nudgeRate(1)} title="Faster, or forwards"><FastForward className="w-3.5 h-3.5" /></button>
        <div className="px-2 min-w-0 text-center">
          <div className="font-mono text-[12px] tabular-nums whitespace-nowrap text-[var(--text-primary)]">{fmtClock(t)}</div>
          <div className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">
            {playing ? `${s.rate < 0 ? 'backwards, ' : ''}${RATE_LABEL[Math.abs(s.rate) - 1]}${Math.abs(s.rate) === 1 ? '' : ' per second'}` : s.live ? 'live' : 'paused'}
          </div>
        </div>
        <input type="datetime-local" aria-label="Go to a date and time (UTC)" step={60}
          value={new Date(t).toISOString().slice(0, 16)} onChange={e => setDate(e.target.value)}
          className="hidden sm:block h-7 rounded-md bg-transparent border border-[var(--border-subtle)] px-1.5 text-[11px] text-[var(--text-secondary)]" />
        <button className={clsx('h-7 px-2 rounded-md text-[11px] font-medium transition', s.live ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]')}
          onClick={goLive} title="Back to now">Now</button>
      </div>
    </div>
  );
}
