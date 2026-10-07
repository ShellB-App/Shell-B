// Planetary science dossier drawer for celestial bodies.
import { useMemo } from 'react';
import { earthLink, fmtKm, fmtLight } from './sky';
import { useClockTime } from './clock';
import clsx from 'clsx';
import { Compass, ExternalLink, Globe2, Orbit, Radio, Thermometer, Wind, X } from 'lucide-react';
import { getDossier, type WorldDossier } from './dossier';

interface DossierDrawerProps {
  bodyId: string;
  onClose: () => void;
  onOpenSol?: (id: string) => void;
}

const cToF = (c: number) => Math.round((c * 9) / 5 + 32);

export function DossierDrawer({ bodyId, onClose, onOpenSol }: DossierDrawerProps) {
  const d = getDossier(bodyId);
  // Computed from sol.ts (JPL elements); the server's /api/planetary/ephemeris figures were invented.
  const t = useClockTime(60_000);
  const link = useMemo(() => (bodyId === 'earth' || bodyId === 'sol' ? null : earthLink(bodyId, t)), [bodyId, t]);

  if (!d) {
    return (
      <div className="w-80 h-full bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] p-4 flex flex-col justify-between text-[12px]">
        <div>
          <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
            <h3 className="font-semibold text-[14px] text-[var(--text-primary)]">Body Dossier</h3>
            <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-4 text-[var(--text-muted)]">Detailed scientific profile pending for {bodyId}.</p>
        </div>
      </div>
    );
  }

  const gPercent = Math.min(100, Math.max(5, (d.surfaceGravityG / 2.5) * 100));

  return (
    <div className="w-[21rem] max-w-[calc(100vw-3rem)] h-full bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 text-[12px] shadow-2xl">
      {/* Header */}
      <div className="p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/40 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-bold tracking-tight text-[var(--text-primary)]">{d.name}</h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              {d.category}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{d.tagline}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
          title="Close dossier"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {/* Gravity Card */}
        <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 text-[var(--accent)]" />
              Surface Gravity
            </span>
            <span className="font-mono tabular-nums text-[var(--text-primary)] font-semibold">
              {d.surfaceGravityG.toFixed(3)} g ({d.surfaceGravityMs2.toFixed(2)} m/s²)
            </span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-sky-500 to-amber-500 rounded-full"
              style={{ width: `${gPercent}%` }}
            />
          </div>
          <div className="relative mt-1.5 h-3.5 text-[10px] text-[var(--text-muted)] tabular-nums">
            <span className="absolute left-0">0 g</span>
            <span className="absolute left-[40%] -translate-x-1/2">1 g (Earth)</span>
            <span className="absolute right-0">2.5 g</span>
          </div>
        </div>

        {/* Physical Stats Grid */}
        <div>
          <h4 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] mb-2">
            Physical Dimensions
          </h4>
          <dl className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
              <dt className="text-[10px] text-[var(--text-muted)]">Mean Radius</dt>
              <dd className="font-mono font-medium text-[var(--text-primary)] tabular-nums mt-0.5">
                {d.radiusKm.toLocaleString()} km
              </dd>
            </div>
            <div className="p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
              <dt className="text-[10px] text-[var(--text-muted)]">Mass</dt>
              <dd className="font-mono font-medium text-[var(--text-primary)] tabular-nums mt-0.5 truncate" title={d.massKg}>
                {d.massEarth}
              </dd>
            </div>
            <div className="p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
              <dt className="text-[10px] text-[var(--text-muted)]">Escape Velocity</dt>
              <dd className="font-mono font-medium text-[var(--text-primary)] tabular-nums mt-0.5">
                {d.escapeVelocityKms.toFixed(2)} km/s
              </dd>
            </div>
            <div className="p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
              <dt className="text-[10px] text-[var(--text-muted)]">Axial Tilt</dt>
              <dd className="font-mono font-medium text-[var(--text-primary)] tabular-nums mt-0.5">
                {d.axialTiltDeg.toFixed(2)}°
              </dd>
            </div>
          </dl>
        </div>

        {/* Day & Orbit */}
        <div>
          <h4 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] mb-2">
            Motion & Orbit
          </h4>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] space-y-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Solar Day length:</span>
              <span className="font-medium text-[var(--text-primary)]">{d.solarDay}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Orbital Period:</span>
              <span className="font-medium text-[var(--text-primary)]">{d.orbitalPeriod}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Distance:</span>
              <span className="font-medium text-[var(--text-primary)]">{d.distanceFromPrimary}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Eccentricity:</span>
              <span className="font-mono text-[var(--text-primary)]">{d.eccentricity.toFixed(4)}</span>
            </div>
          </div>
        </div>

        {/* Earth Interplanetary Link & Comms */}
        {link && (
          <div>
            <h4 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] mb-2 flex items-center justify-between">
              <span>Earth Interplanetary Link</span>
              <span className="text-[9px] text-sky-400 font-mono flex items-center gap-1 font-normal">
                <Radio className="w-3 h-3" /> At the clock's time
              </span>
            </h4>
            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] space-y-2.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">Distance from Earth:</span>
                <span className="font-mono font-semibold text-[var(--text-primary)]">
                  {link.au < 0.01 ? fmtKm(link.km) : <>{link.au.toFixed(3)} AU <span className="text-[var(--text-muted)] font-normal font-sans">({fmtKm(link.km)})</span></>}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)]">Radio Light Delay:</span>
                <span className="font-mono text-[var(--text-primary)] font-medium">{fmtLight(link.lightSeconds)}</span>
              </div>

              {link.transfer && <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <div className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider flex items-center gap-1">
                  <Orbit className="w-3 h-3 text-emerald-400" /> Hohmann Transfer Trajectory
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] pt-1">
                  <div className="p-2 rounded bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                    <div className="text-[var(--text-muted)]">Transit Duration</div>
                    <div className="font-mono font-medium text-[var(--text-primary)] text-[11px] mt-0.5">
                      {Math.round(link.transfer.days)} days
                    </div>
                  </div>
                  <div className="p-2 rounded bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                    <div className="text-[var(--text-muted)]">Δv between orbits</div>
                    <div className="font-mono font-medium text-[var(--text-primary)] text-[11px] mt-0.5">
                      {link.transfer.dvKms.toFixed(2)} km/s
                    </div>
                  </div>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] pt-0.5 flex justify-between">
                  <span>Synodic Launch Window:</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    Every {Math.round(link.transfer.synodicDays)} days
                  </span>
                </div>
              </div>}
            </div>
          </div>
        )}

        {/* Temperature & Atmosphere */}
        <div>
          <h4 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] mb-2">
            Climate & Atmosphere
          </h4>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] space-y-2.5 text-[11px]">
            <div className="flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
              <Thermometer className="w-3.5 h-3.5 text-amber-500" />
              <span>Surface Temperatures</span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center py-1 bg-[var(--bg-secondary)] rounded-md">
              <div>
                <div className="text-[9px] text-[var(--text-muted)]">MIN</div>
                <div className="font-mono text-[11px] font-semibold text-sky-400">{d.surfaceTempMinC}°C</div>
                <div className="text-[9px] text-[var(--text-muted)]">{cToF(d.surfaceTempMinC)}°F</div>
              </div>
              <div className="border-x border-[var(--border-subtle)]">
                <div className="text-[9px] text-[var(--text-muted)]">MEAN</div>
                <div className="font-mono text-[11px] font-semibold text-emerald-400">{d.surfaceTempMeanC}°C</div>
                <div className="text-[9px] text-[var(--text-muted)]">{cToF(d.surfaceTempMeanC)}°F</div>
              </div>
              <div>
                <div className="text-[9px] text-[var(--text-muted)]">MAX</div>
                <div className="font-mono text-[11px] font-semibold text-rose-400">{d.surfaceTempMaxC}°C</div>
                <div className="text-[9px] text-[var(--text-muted)]">{cToF(d.surfaceTempMaxC)}°F</div>
              </div>
            </div>

            <div className="pt-1.5 border-t border-[var(--border-subtle)]">
              <div className="flex items-center gap-1.5 text-[var(--text-secondary)] mb-1">
                <Wind className="w-3.5 h-3.5 text-sky-400" />
                <span className="font-medium">Atmospheric Pressure:</span>
                <span className="text-[var(--text-primary)] ml-auto truncate" title={d.surfacePressure}>
                  {d.surfacePressure}
                </span>
              </div>
              {d.atmosphere.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {d.atmosphere.map((g, i) => (
                    <li key={i} className="text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-[var(--accent)] shrink-0" />
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Geological Features */}
        <div>
          <h4 className="text-[10px] uppercase font-semibold tracking-wider text-[var(--text-muted)] mb-2">
            Geology & Surface Features
          </h4>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] space-y-2 text-[11px]">
            <p className="text-[var(--text-secondary)] leading-relaxed">{d.geologySummary}</p>
            <div className="pt-2 border-t border-[var(--border-subtle)]">
              <div className="text-[10px] font-medium text-[var(--text-muted)] mb-1">Key Highlights:</div>
              <ul className="space-y-1">
                {d.features.map((f, i) => (
                  <li key={i} className="text-[10px] text-[var(--text-secondary)] flex items-start gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1 shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      {onOpenSol && (
        <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]">
          <button
            onClick={() => onOpenSol(bodyId)}
            className="w-full py-2 px-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium flex items-center justify-center gap-2 transition"
          >
            <Orbit className="w-4 h-4 text-amber-400" />
            <span>View {d.name} in Sol Orrery</span>
          </button>
        </div>
      )}
    </div>
  );
}
