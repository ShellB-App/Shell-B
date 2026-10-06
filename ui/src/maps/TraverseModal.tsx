// Waypoint detail popup and stepper for rover and lunar traverses.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  ExternalLink,
  Flag,
  MapPin,
  Microscope,
  Navigation,
  Pause,
  Play,
  Sparkles,
  X
} from 'lucide-react';
import type { Traverse, TraverseWaypoint } from './traverses';
import { fmtCoord } from './core';

interface TraverseModalProps {
  traverse: Traverse;
  waypoint: TraverseWaypoint;
  onClose: () => void;
  onSelectWaypoint: (wp: TraverseWaypoint) => void;
  onFlyTo: (lat: number, lon: number, zoom?: number) => void;
}

export function TraverseModal({
  traverse,
  waypoint,
  onClose,
  onSelectWaypoint,
  onFlyTo,
}: TraverseModalProps) {
  const [touring, setTouring] = useState(false);
  const currentIndex = traverse.waypoints.findIndex(w => w.id === waypoint.id);
  const prevWp = currentIndex > 0 ? traverse.waypoints[currentIndex - 1] : null;
  const nextWp = currentIndex < traverse.waypoints.length - 1 ? traverse.waypoints[currentIndex + 1] : null;

  const cb = useRef({ onSelectWaypoint, onFlyTo });
  cb.current = { onSelectWaypoint, onFlyTo };
  useEffect(() => {
    if (!touring) return;
    const interval = setInterval(() => {
      const idx = traverse.waypoints.findIndex(w => w.id === waypoint.id);
      const nextIdx = (idx + 1) % traverse.waypoints.length;
      const targetWp = traverse.waypoints[nextIdx];
      cb.current.onSelectWaypoint(targetWp);
      cb.current.onFlyTo(targetWp.lat, targetWp.lon);
      if (nextIdx === traverse.waypoints.length - 1) {
        setTouring(false);
      }
    }, 3500);
    return () => clearInterval(interval);
  }, [touring, waypoint.id, traverse.waypoints]);

  return (
    <div className="w-96 max-w-full rounded-2xl border border-[var(--border-subtle)] sb-map-glass shadow-2xl backdrop-blur-xl p-4 text-[12px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 pb-2.5 border-b border-[var(--border-subtle)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: traverse.color }}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] truncate">
              {traverse.name}
            </span>
          </div>
          <h3 className="text-[15px] font-bold text-[var(--text-primary)] mt-0.5 leading-snug">
            {waypoint.name}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Meta Pills */}
      <div className="flex flex-wrap items-center gap-1.5 py-2.5 text-[10px]">
        <span className="px-2 py-0.5 rounded-full font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/20">
          {waypoint.solOrEva}
        </span>
        {waypoint.date && (
          <span className="px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
            {waypoint.date}
          </span>
        )}
        {waypoint.distFromStartKm != null && (
          <span className="px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono">
            {waypoint.distFromStartKm.toFixed(1)} km driven
          </span>
        )}
      </div>

      {/* Description & Science Discovery */}
      <div className="space-y-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        <p>{waypoint.desc}</p>
        {waypoint.discovery && (
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
            <div className="text-[10px] leading-snug">{waypoint.discovery}</div>
          </div>
        )}
        {waypoint.instrument && (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            <Microscope className="w-3 h-3 text-sky-400" />
            <span>Instruments: {waypoint.instrument}</span>
          </div>
        )}
      </div>

      {/* Footer Navigation Bar */}
      <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            disabled={!prevWp}
            onClick={() => {
              if (prevWp) {
                onSelectWaypoint(prevWp);
                onFlyTo(prevWp.lat, prevWp.lon);
              }
            }}
            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] disabled:opacity-30 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] transition"
            title="Previous waypoint"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-[var(--text-muted)] font-mono px-1">
            {currentIndex + 1} / {traverse.waypoints.length}
          </span>
          <button
            disabled={!nextWp}
            onClick={() => {
              if (nextWp) {
                onSelectWaypoint(nextWp);
                onFlyTo(nextWp.lat, nextWp.lon);
              }
            }}
            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] disabled:opacity-30 hover:bg-[var(--bg-hover)] text-[var(--text-primary)] transition"
            title="Next waypoint"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setTouring(t => !t)}
            className={clsx(
              'px-2.5 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1 transition',
              touring
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
            title={touring ? 'Pause automatic tour' : 'Play automatic camera tour along traverse'}
          >
            {touring ? <Pause className="w-3 h-3 text-amber-400" /> : <Play className="w-3 h-3 text-emerald-400" />}
            <span>{touring ? 'Touring…' : 'Tour'}</span>
          </button>

          <button
            onClick={() => onFlyTo(waypoint.lat, waypoint.lon, 14)}
            className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:opacity-90 text-white font-medium text-[11px] flex items-center gap-1 transition shadow"
          >
            <Navigation className="w-3 h-3" /> Center
          </button>
        </div>
      </div>
    </div>
  );
}
