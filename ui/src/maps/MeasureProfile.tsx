// Elevation profile under the measure tool: heights along the measured path from the world's DEM (elevation.ts).
import { useEffect, useState } from 'react';
import { Loader2, Mountain } from 'lucide-react';
import type { MapBody } from './core';
import { profileAlong, type Profile } from './elevation';
import { interpolateGreatCircle, type MeasurePoint } from './measure';

export function MeasureProfile({ body, points, radiusKm, unit }: { body: MapBody; points: MeasurePoint[]; radiusKm: number; unit: 'metric' | 'imperial' | 'nautical' }) {
  const [prof, setProf] = useState<Profile | null | 'loading'>('loading');
  useEffect(() => {
    let gone = false;
    setProf('loading');
    const pts: { lat: number; lon: number; km: number }[] = [];
    let km = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const seg = interpolateGreatCircle(points[i], points[i + 1], 24);
      for (let j = 0; j < seg.length; j++) {
        const [lon, lat] = seg[j];
        if (j > 0) {
          const [plon, plat] = seg[j - 1];
          const toR = Math.PI / 180;
          const a = Math.sin(((lat - plat) * toR) / 2) ** 2 + Math.cos(plat * toR) * Math.cos(lat * toR) * Math.sin(((lon - plon) * toR) / 2) ** 2;
          km += 2 * radiusKm * Math.asin(Math.sqrt(a));
        }
        if (j > 0 || i === 0) pts.push({ lat, lon, km });
      }
    }
    profileAlong(body, pts).then(p => { if (!gone) setProf(p); }).catch(() => { if (!gone) setProf(null); });
    return () => { gone = true; };
  }, [body, points, radiusKm]);

  if (prof === 'loading') return <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]"><Loader2 className="w-3 h-3 animate-spin" /> Reading heights…</div>;
  if (!prof) return null;
  const W = 260, H = 56, pad = 2;
  const span = Math.max(prof.max - prof.min, 1);
  const xs = prof.samples.map(s => pad + (s.d / Math.max(prof.totalKm, 1e-6)) * (W - 2 * pad));
  const ys = prof.samples.map(s => (s.h === null ? null : H - pad - ((s.h - prof.min) / span) * (H - 2 * pad)));
  let d = '', area = '';
  prof.samples.forEach((_, i) => { const y = ys[i]; if (y === null) return; d += `${d ? 'L' : 'M'}${xs[i].toFixed(1)},${y.toFixed(1)}`; });
  if (d) area = `${d}L${xs[xs.length - 1].toFixed(1)},${H}L${xs[0].toFixed(1)},${H}Z`;
  const m = (v: number) => unit === 'imperial' ? `${Math.round(v * 3.28084).toLocaleString()} ft` : `${Math.round(v).toLocaleString()} m`;
  return (
    <div className="pt-1.5 border-t border-[var(--border-subtle)]">
      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mb-0.5">
        <Mountain className="w-3 h-3 text-stone-400" />
        <span>Elevation profile</span>
        <span className="ml-auto tabular-nums">↑ {m(prof.climb)} · ↓ {m(prof.descent)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-[260px] max-w-full h-14 block" role="img" aria-label="Elevation profile">
        {area && <path d={area} fill="rgba(45,212,191,0.18)" />}
        {d && <path d={d} fill="none" stroke="#2dd4bf" strokeWidth="1.5" />}
        <text x={pad + 1} y={10} fontSize="9" fill="var(--text-muted)">{m(prof.max)}</text>
        <text x={pad + 1} y={H - 3} fontSize="9" fill="var(--text-muted)">{m(prof.min)}</text>
      </svg>
    </div>
  );
}
