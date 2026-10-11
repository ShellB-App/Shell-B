// Cross-section of a world for the dossier: concentric layers to scale (thin shells thickened just enough to see).
import { useState } from 'react';
import clsx from 'clsx';
import { type Interior } from './interior';

export function InteriorView({ name, radiusKm, interior }: { name: string; radiusKm: number; interior: Interior }) {
  const [hl, setHl] = useState<number | null>(null);
  const R = 92, cx = 100, cy = 100;
  // outer radius per layer, enforcing a minimum visible thickness of 3 px from the inside out
  const outs: number[] = [];
  let prev = 0;
  for (const l of interior.layers) {
    const want = l.r * R;
    const o = Math.max(want, prev + 3);
    outs.push(o); prev = o;
  }
  const scale = R / outs[outs.length - 1];
  const radii = outs.map(o => o * scale);
  const layers = interior.layers.map((l, i) => ({ ...l, outer: radii[i], inner: i ? radii[i - 1] : 0 }));
  const km = (f: number) => Math.round(f * radiusKm).toLocaleString();
  return (
    <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
      <div className="flex gap-3">
        <svg viewBox="0 0 200 200" className="w-36 h-36 shrink-0" role="img" aria-label={`Interior of ${name}`}>
          <defs>
            <clipPath id="sb-int-cut"><path d={`M${cx},${cy} L${cx + R + 4},${cy} A${R + 4},${R + 4} 0 1 1 ${cx},${cy - R - 4} Z`} /></clipPath>
          </defs>
          {/* the globe, cut open: the upper-right quarter shows the layers */}
          {[...layers].reverse().map((l, i) => {
            const idx = layers.length - 1 - i;
            return (
              <circle key={l.name} cx={cx} cy={cy} r={l.outer} fill={l.color} opacity={hl === null || hl === idx ? 1 : 0.35}
                onMouseEnter={() => setHl(idx)} onMouseLeave={() => setHl(null)} className="transition-opacity cursor-help" />
            );
          })}
          <g clipPath="url(#sb-int-cut)">
            <circle cx={cx} cy={cy} r={R} fill={layers[layers.length - 1].color} opacity="0.15" />
          </g>
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" />
        </svg>
        <ol className="flex-1 min-w-0 space-y-1 text-[11px]">
          {layers.map((l, i) => (
            <li key={l.name} className={clsx('flex items-start gap-1.5 rounded px-1 -mx-1 transition', hl === i && 'bg-[var(--bg-tertiary)]')}
              onMouseEnter={() => setHl(i)} onMouseLeave={() => setHl(null)}>
              <span className="w-2.5 h-2.5 mt-[3px] rounded-full shrink-0 border border-black/20" style={{ background: l.color }} />
              <span className="min-w-0">
                <span className="text-[var(--text-primary)] font-medium">{l.name}</span>
                <span className="text-[var(--text-muted)] tabular-nums"> · to {km(l.r)} km</span>
                {l.note && <span className="block text-[10.5px] text-[var(--text-muted)] leading-snug">{l.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-2 text-[10.5px] leading-snug text-[var(--text-muted)]">{interior.note} <span className="opacity-80">Source: {interior.source}.</span></p>
    </div>
  );
}
