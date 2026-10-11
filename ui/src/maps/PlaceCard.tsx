// Card for an Atlas place: the header is the place itself, the body is whatever its note holds (FeatureNotes).
import { useState } from 'react';
import { Check, Copy, MapPin, Navigation, Trash2, X } from 'lucide-react';
import { fmtCoord } from './core';
import { FeatureNotes } from './FeatureNotes';
import { removeNotePart } from './notes';
import { PLACE_COLOR, PLACE_KIND_LABEL, type Place } from './places';

export function PlaceCard({ place, onClose, onFlyTo }: { place: Place; onClose: () => void; onFlyTo: (lat: number, lon: number) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(`${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  const remove = () => {
    if (!confirm(`Remove "${place.feature}" from the map, with its card?`)) return;
    removeNotePart(place.body, place.feature).then(onClose).catch(() => {});
  };
  return (
    <div className="w-[22rem] max-w-full rounded-lg border border-[var(--border-subtle)] sb-map-glass p-3.5 text-[12px] shadow-2xl backdrop-blur-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border" style={{ color: place.color || PLACE_COLOR, borderColor: `${place.color || PLACE_COLOR}55`, background: `${place.color || PLACE_COLOR}22` }}>
              {PLACE_KIND_LABEL[place.kind] ?? place.kind}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">Added by {place.by ?? 'Atlas'}</span>
          </div>
          <h3 className="mt-1 text-[15px] font-bold tracking-tight text-[var(--text-primary)] leading-snug">{place.feature}</h3>
        </div>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]" title="Close"><X className="w-4 h-4" /></button>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px]">
        <MapPin className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <span className="font-mono tabular-nums text-[var(--text-secondary)]">{fmtCoord(place.lat, place.lon)}</span>
        <button onClick={copy} className="ml-auto p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Copy coordinates">{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</button>
        <button onClick={() => onFlyTo(place.lat, place.lon)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Fly here"><Navigation className="w-3.5 h-3.5" /></button>
        <button onClick={remove} className="p-1 rounded text-[var(--text-muted)] hover:text-rose-500" title="Remove this place"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      <FeatureNotes body={place.body} feature={place.feature} />
    </div>
  );
}
