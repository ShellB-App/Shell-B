// Floating inspection card for planetary landmarks and historic space exploration landing sites.
import { useState } from 'react';
import clsx from 'clsx';
import { Check, Compass, Copy, ExternalLink, Flag, MapPin, Navigation, Rocket, X } from 'lucide-react';
import type { Landmark } from './landmarks';
import { FeatureNotes } from './FeatureNotes';
import { fmtCoord } from './core';

interface LandmarkModalProps {
  landmark: Landmark;
  onClose: () => void;
  onFlyTo: (lat: number, lon: number) => void;
}

export function LandmarkModal({ landmark, onClose, onFlyTo }: LandmarkModalProps) {
  const [copied, setCopied] = useState(false);

  const copyCoords = () => {
    navigator.clipboard?.writeText(`${landmark.lat.toFixed(5)}, ${landmark.lon.toFixed(5)}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  const isMission = landmark.kind === 'mission';
  const isSpaceport = landmark.kind === 'spaceport';

  return (
    <div className="w-[22rem] max-w-full rounded-lg border border-[var(--border-subtle)] sb-map-glass p-3.5 text-[12px] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={clsx(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
                isMission ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                isSpaceport ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' :
                'bg-purple-500/20 text-purple-300 border border-purple-500/30'
              )}
            >
              {landmark.kind}
            </span>
            {landmark.year && (
              <span className="text-[10px] text-[var(--text-muted)] font-mono">{landmark.year}</span>
            )}
            {landmark.status && (
              <span className="text-[10px] text-[var(--text-muted)]">· {landmark.status}</span>
            )}
          </div>
          <h3 className="mt-1 text-[15px] font-bold tracking-tight text-[var(--text-primary)] leading-snug">
            {landmark.name}
          </h3>
          {(landmark.agency || landmark.country) && (
            <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
              {[landmark.agency, landmark.country].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
          title="Close card"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Meta grid */}
      <dl className="mt-2.5 grid grid-cols-2 gap-2 text-[11px] p-2 rounded-md bg-[var(--bg-primary)]/50 border border-[var(--border-subtle)]">
        <div>
          <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Coordinates</dt>
          <dd className="font-mono text-[10.5px] tabular-nums text-[var(--text-primary)] mt-0.5">
            {fmtCoord(landmark.lat, landmark.lon)}
          </dd>
        </div>
        {landmark.vehicleType ? (
          <div>
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Vehicle</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] truncate mt-0.5" title={landmark.vehicleType}>
              {landmark.vehicleType}
            </dd>
          </div>
        ) : landmark.elevation ? (
          <div>
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Elevation / Depth</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] truncate mt-0.5">
              {landmark.elevation}
            </dd>
          </div>
        ) : landmark.diameter ? (
          <div>
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Diameter</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] truncate mt-0.5">
              {landmark.diameter}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Location</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] capitalize mt-0.5">
              {landmark.bodyId}
            </dd>
          </div>
        )}
      </dl>

      {/* Description */}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {landmark.desc}
      </p>

      {/* Memorable highlight / quote */}
      {landmark.highlight && (
        <div className="mt-2 p-2 rounded border border-amber-500/20 bg-amber-500/5 text-[11px] italic text-amber-200/90 leading-snug">
          {landmark.highlight}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)] flex items-center gap-2">
        <button
          onClick={() => onFlyTo(landmark.lat, landmark.lon)}
          className="flex-1 py-1.5 px-2.5 rounded-md bg-[var(--accent)] text-white text-[11px] font-medium flex items-center justify-center gap-1.5 hover:opacity-90 transition"
        >
          <Navigation className="w-3.5 h-3.5" />
          <span>Fly to Site</span>
        </button>
        <button
          onClick={copyCoords}
          className="py-1.5 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[11px] flex items-center gap-1 transition"
          title="Copy coordinates"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'Copied' : 'Coords'}</span>
        </button>
      </div>

      <FeatureNotes body={landmark.bodyId} feature={landmark.name} />
    </div>
  );
}
