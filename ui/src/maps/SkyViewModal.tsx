// The sky from a dropped pin: a horizon dome plus a list, computed live from sky.ts (real positions).
import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Compass, Moon, Orbit, Sun, X } from 'lucide-react';
import { fmtCoord } from './core';
import { fmtKm, skyFrom, type SkyObject } from './sky';

interface SkyViewModalProps {
  bodyId: string;
  bodyName: string;
  lat: number;
  lon: number;
  onClose: () => void;
  onAskAtlas?: (prompt: string) => void;
}

const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (az: number) => CARD[Math.round(az / 45) % 8];
const R = 100;

/** alt/az → dome position: zenith in the middle, horizon on the rim, north up, east right (map-style, not mirrored). */
function project(alt: number, az: number) {
  const r = ((90 - Math.max(0, alt)) / 90) * R;
  const a = (az - 90) * (Math.PI / 180);
  return { x: R + r * Math.cos(a), y: R + r * Math.sin(a) };
}

function phaseName(lit: number) {
  return lit > 0.97 ? 'Full' : lit > 0.6 ? 'Gibbous' : lit > 0.4 ? 'Half' : lit > 0.03 ? 'Crescent' : 'New';
}

export function SkyViewModal({ bodyId, bodyName, lat, lon, onClose, onAskAtlas }: SkyViewModalProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const sky = skyFrom(bodyId, lat, lon, now);
  const up = sky?.objects.filter(o => o.alt > 0) ?? [];
  const sunUp = (sky?.sun.alt ?? -90) > 0;
  const big = (o: SkyObject) => o.km < 2e6;  // moons and, from the Moon, Earth

  return (
    <div className="absolute inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-[440px] max-w-full max-h-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden flex flex-col text-[12px]"
        onClick={e => e.stopPropagation()} role="dialog" aria-label={`Sky from ${bodyName}`}>
        <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold tracking-tight text-[var(--text-primary)]">The sky from {bodyName}</div>
            <div className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums">{fmtCoord(lat, lon)} · {new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC</div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Close"><X className="w-4 h-4" /></button>
        </div>

        {!sky ? (
          <div className="p-6 text-center text-[var(--text-muted)]">The sky view needs to know how {bodyName} spins, and that isn’t in Shell:B yet.</div>
        ) : (
          <div className="overflow-y-auto p-4 space-y-4">
            <div className="flex flex-col items-center">
              <svg viewBox={`-14 -14 ${2 * R + 28} ${2 * R + 28}`} className="w-[230px] h-[230px]" role="img" aria-label="Sky dome">
                <circle cx={R} cy={R} r={R} fill={sunUp ? '#1e3a5f' : sky.state === 'twilight' ? '#1e1b3a' : '#05060c'} stroke="var(--border-subtle)" strokeWidth="1.5" />
                {[30, 60].map(a => <circle key={a} cx={R} cy={R} r={((90 - a) / 90) * R} fill="none" stroke="rgba(255,255,255,0.12)" strokeDasharray="2 3" />)}
                {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
                  const p = project(-6, i * 90);
                  return <text key={c} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight="600" fill="var(--text-muted)">{c}</text>;
                })}
                {sky.sun.alt > 0 && (() => { const p = project(sky.sun.alt, sky.sun.az); return <circle cx={p.x} cy={p.y} r="7" fill="#fbbf24" />; })()}
                {up.map(o => {
                  const p = project(o.alt, o.az);
                  return (
                    <g key={o.id}>
                      <circle cx={p.x} cy={p.y} r={big(o) ? 5 : 2.5} fill={big(o) ? '#e2e8f0' : '#fde68a'} />
                      <text x={p.x} y={p.y + (big(o) ? 13 : 10)} textAnchor="middle" fontSize="8.5" fill="#e2e8f0">{o.name}</text>
                    </g>
                  );
                })}
              </svg>
              <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">Zenith in the middle, horizon at the rim</div>
            </div>

            <div className="space-y-1.5">
              <Row icon={<Sun className="w-4 h-4 text-amber-400" />} name="Sun" o={sky.sun}
                note={sky.state === 'day' ? 'Daytime' : sky.state === 'twilight' ? 'Twilight' : 'Night'} />
              {sky.objects.map(o => (
                <Row key={o.id} o={o} name={o.name}
                  icon={big(o) ? <Moon className="w-4 h-4 text-[var(--text-secondary)]" /> : <Orbit className="w-4 h-4 text-[var(--text-muted)]" />}
                  note={[o.lit != null && (big(o) || o.id === 'venus' || o.id === 'mercury') ? `${phaseName(o.lit)}, ${Math.round(o.lit * 100)}% lit` : null, fmtKm(o.km)].filter(Boolean).join(' · ')} />
              ))}
            </div>
            <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">Positions from JPL orbital elements and IAU rotation models, accurate to about a degree. Planets can be up but lost in daylight.</p>
          </div>
        )}

        {onAskAtlas && sky && (
          <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end">
            <button
              onClick={() => onAskAtlas(`What does the sky look like from ${bodyName} at ${fmtCoord(lat, lon)} right now?`)}
              className="h-8 px-3 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] text-[11.5px] font-medium flex items-center gap-1.5"
            >
              <Compass className="w-3.5 h-3.5" /> Ask Atlas
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ icon, name, o, note }: { icon: ReactNode; name: string; o: SkyObject; note: string }) {
  const above = o.alt > 0;
  return (
    <div className={clsx('flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]', !above && 'opacity-55')}>
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--text-primary)] truncate">{name}</div>
        <div className="text-[10.5px] text-[var(--text-muted)] truncate">{note}</div>
      </div>
      <div className="text-right shrink-0 font-mono tabular-nums">
        <div className={clsx('text-[11.5px]', above ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{o.alt >= 0 ? '+' : ''}{o.alt.toFixed(0)}°</div>
        <div className="text-[10px] text-[var(--text-muted)]">{Math.round(o.az)}° {compass(o.az)}</div>
      </div>
    </div>
  );
}
