// Unified inspection modal for interactive map features: Shipwrecks, Wonders, Launch Sites, Webcams.
import { useState } from 'react';
import clsx from 'clsx';
import {
  Anchor, Check, Compass, Copy, ExternalLink, Globe2, Mountain, Navigation,
  Radio, Rocket, Shield, Sparkles, Video, Waves, X
} from 'lucide-react';
import { openView3D } from './notes';
import { fmtCoord } from './core';
import { FeatureNotes } from './FeatureNotes';
import type { Shipwreck } from './shipwrecks';
import type { WorldWonder } from './wonders';
import type { LaunchSite } from './launchsites';
import type { CCTVCamera } from './cctv';

export type AnyFeature =
  | { kind: 'shipwreck'; item: Shipwreck }
  | { kind: 'wonder'; item: WorldWonder }
  | { kind: 'launchsite'; item: LaunchSite }
  | { kind: 'cctv'; item: CCTVCamera };

interface MapFeatureModalProps {
  feature: AnyFeature;
  onClose: () => void;
  onFlyTo: (lat: number, lon: number) => void;
  /** elevation tiles exist for this world: the 3D view / dive button shows */
  terrain?: boolean;
}

export function MapFeatureModal({ feature, onClose, onFlyTo, terrain }: MapFeatureModalProps) {
  const [copied, setCopied] = useState(false);

  let lat = 0, lon = 0, title = '', subtitle = '', desc = '', highlight: string | undefined;
  let badgeLabel = '', badgeColor = '', Icon = Globe2;
  const meta: { label: string; value: string }[] = [];
  let streamUrl: string | undefined;

  switch (feature.kind) {
    case 'shipwreck': {
      const w = feature.item;
      lat = w.lat; lon = w.lon;
      title = w.name;
      subtitle = [w.vesselType, w.flag].filter(Boolean).join(' · ');
      desc = w.desc;
      highlight = w.highlight;
      badgeLabel = `Shipwreck (${w.yearSunk > 0 ? w.yearSunk : `${Math.abs(w.yearSunk)} BC`})`;
      badgeColor = 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30';
      Icon = Anchor;
      meta.push({ label: 'Depth', value: `${w.depthMeters.toLocaleString()} m (${Math.round(w.depthMeters * 3.28084).toLocaleString()} ft)` });
      meta.push({ label: 'Year Sunk', value: String(w.yearSunk) });
      if (w.casualties) meta.push({ label: 'Casualties', value: w.casualties });
      if (w.discoveredYear) meta.push({ label: 'Discovered', value: String(w.discoveredYear) });
      break;
    }
    case 'wonder': {
      const w = feature.item;
      lat = w.lat; lon = w.lon;
      title = w.name;
      subtitle = [w.location, w.country].filter(Boolean).join(' · ');
      desc = w.desc;
      highlight = w.highlight;
      badgeLabel = `${w.category.toUpperCase()} WONDER`;
      badgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
      Icon = Sparkles;
      meta.push({ label: 'Country', value: w.country });
      if (w.yearBuilt) meta.push({ label: 'Period', value: w.yearBuilt });
      if (w.unescoYear) meta.push({ label: 'UNESCO', value: `Inscribed ${w.unescoYear}` });
      break;
    }
    case 'launchsite': {
      const s = feature.item;
      lat = s.lat; lon = s.lon;
      title = s.name;
      subtitle = [s.operator, s.country].filter(Boolean).join(' · ');
      desc = s.desc;
      highlight = s.highlight;
      badgeLabel = `SPACEPORT · ${s.status.toUpperCase()}`;
      badgeColor = 'bg-orange-500/20 text-orange-300 border-orange-500/30';
      Icon = Rocket;
      meta.push({ label: 'Operator', value: s.operator });
      meta.push({ label: 'Launchers', value: s.activeLaunchers.slice(0, 2).join(', ') });
      if (s.launchCount) meta.push({ label: 'Launches', value: `${s.launchCount}+ missions` });
      if (s.firstOrbitalLaunch) meta.push({ label: 'First Launch', value: s.firstOrbitalLaunch });
      break;
    }
    case 'cctv': {
      const c = feature.item;
      lat = c.lat; lon = c.lon;
      title = c.name;
      subtitle = [c.location, c.city, c.country].filter(Boolean).join(', ');
      desc = c.desc;
      highlight = c.highlight;
      badgeLabel = `LIVE CCTV · ${c.resolution}`;
      badgeColor = 'bg-rose-500/20 text-rose-300 border-rose-500/30';
      Icon = Video;
      streamUrl = c.streamUrl;
      meta.push({ label: 'City', value: c.city });
      meta.push({ label: 'Timezone', value: c.timezone });
      meta.push({ label: 'Camera Angle', value: c.viewAngle });
      meta.push({ label: 'Status', value: c.status.toUpperCase() });
      break;
    }
  }

  const copyCoords = () => {
    navigator.clipboard.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="w-[21rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-subtle)] sb-map-glass p-3.5 text-[12px] shadow-2xl backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border flex items-center gap-1', badgeColor)}>
              <Icon className="w-3 h-3" />
              <span>{badgeLabel}</span>
            </span>
          </div>
          <h3 className="mt-1 text-[15px] font-bold tracking-tight text-[var(--text-primary)] leading-snug">
            {title}
          </h3>
          {subtitle && (
            <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
              {subtitle}
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

      {/* Meta Grid */}
      <dl className="mt-2.5 grid grid-cols-2 gap-2 text-[11px] p-2 rounded-lg bg-[var(--bg-primary)]/50 border border-[var(--border-subtle)]">
        <div>
          <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">Coordinates</dt>
          <dd className="font-mono text-[10.5px] tabular-nums text-[var(--text-primary)] mt-0.5">
            {fmtCoord(lat, lon)}
          </dd>
        </div>
        {meta.slice(0, 3).map((m, i) => (
          <div key={i}>
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold truncate">{m.label}</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] truncate mt-0.5" title={m.value}>{m.value}</dd>
          </div>
        ))}
      </dl>

      {/* Description */}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        {desc}
      </p>

      {/* Memorable highlight */}
      {highlight && (
        <div className="mt-2 p-2 rounded-lg border border-sky-500/20 bg-sky-500/5 text-[11px] italic text-sky-200/90 leading-snug">
          {highlight}
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)] flex items-center gap-2">
        <button
          onClick={() => onFlyTo(lat, lon)}
          className="flex-1 py-1.5 px-2.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:opacity-90 transition shadow-sm"
        >
          <Navigation className="w-3.5 h-3.5" />
          <span>Fly to Location</span>
        </button>
        {terrain && feature.kind === 'shipwreck' && (
          <button
            onClick={() => openView3D({ lat, lon, label: title, kind: 'wreck', depthM: feature.item.depthMeters, spanKm: 40 })}
            className="py-1.5 px-2.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 text-[11px] font-medium flex items-center gap-1 transition"
            title="Dive to the sea floor around the wreck (3D)"
          >
            <Waves className="w-3.5 h-3.5" />
            <span>Dive</span>
          </button>
        )}
        {terrain && feature.kind === 'wonder' && (
          <button
            onClick={() => openView3D({ lat, lon, label: title, kind: 'wonder', spanKm: 40 })}
            className="py-1.5 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-[11px] font-medium flex items-center gap-1 transition"
            title="See the terrain around it in 3D"
          >
            <Mountain className="w-3.5 h-3.5" />
            <span>3D</span>
          </button>
        )}
        {streamUrl && (
          <a
            href={streamUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="py-1.5 px-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-[11px] font-medium flex items-center gap-1 transition"
            title="Open live camera stream in new tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Watch Live</span>
          </a>
        )}
        <button
          onClick={copyCoords}
          className="py-1.5 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[11px] flex items-center gap-1 transition"
          title="Copy coordinates"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'Copied' : 'Coords'}</span>
        </button>
      </div>

      <FeatureNotes body="earth" feature={title} />
    </div>
  );
}
