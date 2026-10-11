// The wind layer's chip: level, overlay, the forecast hour the clock points at, a colour legend, and the wind at the pin.
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Wind } from 'lucide-react';
import { OVERLAYS_FOR, WIND_LEVELS, fmtWind, hourFor, sampleAt, scaleFor, windAt, type Field } from './wind';

export function WindPanel({ level, overlay, onLevel, onOverlay, run, field, scalar, clockMs, pin, loading, className }: {
  level: string; overlay: string; onLevel: (id: string) => void; onOverlay: (id: string) => void;
  run: string | null; field: Field | null; scalar: Field | null; clockMs: number;
  pin: { lat: number; lon: number } | null; loading: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const hour = run ? hourFor(run, clockMs) : 0;
  const valid = field?.h.valid ? new Date(field.h.valid) : null;
  const sc = overlay !== 'none' ? scaleFor(overlay) : null;
  const legend = useMemo(() => {
    if (!sc) return null;
    const stops = sc.stops.map(([v, c]) => `rgb(${c.map(Math.round).join(',')}) ${((v - sc.min) / (sc.max - sc.min)) * 100}%`).join(', ');
    return { bg: `linear-gradient(90deg, ${stops})`, min: sc.min, max: sc.max, unit: sc.unit };
  }, [sc]);
  useEffect(() => { if (!open) return; const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [open]);

  const atPin = pin && field ? windAt(field, pin.lat, pin.lon) : null;
  const scalarAtPin = pin && scalar && overlay !== 'none' && overlay !== 'speed' ? sampleAt(scalar, 0, pin.lat, pin.lon) : null;
  const lvl = WIND_LEVELS.find(l => l.id === level) ?? WIND_LEVELS[0];

  return (
    <div className={clsx('pointer-events-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass text-[11px]', className)}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left" aria-expanded={open}>
        <Wind className={clsx('w-3.5 h-3.5 shrink-0 text-sky-300', loading && 'animate-pulse')} />
        <span className="text-[var(--text-primary)] font-medium">Wind · {lvl.label}</span>
        <span className="text-[var(--text-muted)] truncate">
          {valid ? `${hour === 0 ? 'analysis' : `+${hour} h`} · ${valid.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : loading ? 'loading GFS…' : 'no data'}
        </span>
        <span className="ml-auto text-[var(--text-muted)]">{open ? '▴' : '▾'}</span>
      </button>
      {legend && (
        <div className="px-2.5 pb-1.5">
          <div className="h-1.5 rounded-full" style={{ background: legend.bg }} />
          <div className="flex justify-between text-[9.5px] text-[var(--text-muted)] tabular-nums"><span>{legend.min} {legend.unit}</span><span>{(OVERLAYS_FOR(level).find(o => o.id === overlay)?.label ?? overlay)}</span><span>{legend.max} {legend.unit}</span></div>
        </div>
      )}
      {atPin && (
        <div className="px-2.5 pb-1.5 text-[10.5px] text-[var(--text-secondary)] tabular-nums">
          At the pin: {fmtWind(atPin[0], atPin[1])}{scalarAtPin != null && sc ? ` · ${scalarAtPin.toFixed(overlay === 'pressure' ? 0 : 1)} ${sc.unit}` : ''}
        </div>
      )}
      {open && (
        <div className="px-2.5 pb-2.5 pt-1 border-t border-[var(--border-subtle)] space-y-2">
          <div>
            <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Height</div>
            <div className="flex flex-wrap gap-1">
              {WIND_LEVELS.map(l => (
                <button key={l.id} onClick={() => onLevel(l.id)} title={l.hint}
                  className={clsx('px-2 py-0.5 rounded-md border text-[10.5px]', l.id === level ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>{l.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Overlay</div>
            <div className="flex flex-wrap gap-1">
              {OVERLAYS_FOR(level).map(o => (
                <button key={o.id} onClick={() => onOverlay(o.id)}
                  className={clsx('px-2 py-0.5 rounded-md border text-[10.5px]', o.id === overlay ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>{o.label}</button>
              ))}
            </div>
          </div>
          <p className="text-[10px] leading-snug text-[var(--text-muted)]">
            NOAA GFS 0.25° model, run {run ? new Date(run).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '…'}, 0.5° cells, 3-hourly to +240 h. The forecast hour follows the map clock: play the time bar to watch the weather move. Particles show direction and speed; nothing here is a measurement at street scale.
          </p>
        </div>
      )}
    </div>
  );
}
