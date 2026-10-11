// The ```map``` fence in a chat reply: a live, offline map with the reply's markers and routes.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { Expand, Globe2, Map as MapIcon, Minimize2, SquareArrowOutUpRight } from 'lucide-react';
import { drawOverlays, frameSpec, hasScene, isDark, parseSpec, type MapSpec } from './core';
import { MapStatus, useLiveMap } from './useLiveMap';

const subscribeTheme = (f: () => void) => {
  const mo = new MutationObserver(f);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
};
export const useDarkTheme = () => useSyncExternalStore(subscribeTheme, isDark);

export const MAPS_HANDOFF = 'shellb.maps.open';

/** Open a spec in the Worlds app. */
export function openInMaps(spec: MapSpec) {
  try { sessionStorage.setItem(MAPS_HANDOFF, JSON.stringify(spec)); } catch { /* private mode: the app opens on its last view */ }
  location.hash = '#/worlds';
}

export function MapCard({ source, streaming }: { source: string; streaming?: boolean }) {
  const spec = parseSpec(source);
  if (!spec) {
    return (
      <div className="not-prose my-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] px-4 py-6 text-[12px] text-[var(--text-muted)] flex items-center gap-2">
        <MapIcon className={clsx('w-4 h-4', streaming && 'animate-pulse')} />
        {streaming ? 'Plotting the map…' : 'This map couldn’t be drawn: its data isn’t valid JSON.'}
      </div>
    );
  }
  return <LiveMap key={source} spec={spec} />;
}

function LiveMap({ spec }: { spec: MapSpec }) {
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const { state, retry } = useLiveMap(box, { bodyId: spec.body ?? 'earth', globe: spec.globe ?? false, onReady: (lib, map) => {
    drawOverlays(lib, map, spec);
    frameSpec(lib, map, spec);
  } });
  const body = state.body;

  useEffect(() => { const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 220); return () => clearTimeout(t); }, [tall]);

  const count = (spec.markers?.length ?? 0) + (spec.lines?.length ?? 0);
  return (
    <figure className="not-prose my-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden">
      <figcaption className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        {spec.globe ? <Globe2 className="w-3.5 h-3.5" /> : <MapIcon className="w-3.5 h-3.5" />}
        <span className="font-medium text-[var(--text-secondary)] truncate">{spec.title ?? body?.name ?? 'Map'}</span>
        {body && body.id !== 'earth' && <span className="uppercase tracking-wider text-[10px]">{body.name}</span>}
        {count > 0 && <span className="tabular-nums">· {spec.markers?.length ? `${spec.markers.length} place${spec.markers.length > 1 ? 's' : ''}` : ''}{spec.markers?.length && spec.lines?.length ? ', ' : ''}{spec.lines?.length ? `${spec.lines.length} route${spec.lines.length > 1 ? 's' : ''}` : ''}</span>}
        {hasScene(spec) && <span title="This map carries layers, a time, a tour or a 3D model that only the Worlds app shows">· {spec.tour ? `tour, ${spec.tour.length} stops` : spec.model ? '3D model' : 'scene'}</span>}
        <div className="flex-1" />
        <button className="flex items-center gap-1 hover:text-[var(--text-primary)] transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] rounded"
          onClick={() => setTall(t => !t)} title={tall ? 'Shrink' : 'Make taller'}>
          {tall ? <Minimize2 className="w-3 h-3" /> : <Expand className="w-3 h-3" />}
        </button>
        <button className="flex items-center gap-1 hover:text-[var(--text-primary)] transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] rounded"
          onClick={() => openInMaps(spec)} title="Open this map in the Worlds app">
          <SquareArrowOutUpRight className="w-3 h-3" /> Open in Maps
        </button>
      </figcaption>
      <div className={clsx('relative transition-[height] duration-200', state.phase === 'missing' ? 'h-[120px]' : tall ? 'h-[520px]' : 'h-[300px]')}>
        <div className="absolute inset-0 bg-[#06070c]"><div ref={box} className="w-full h-full" /></div>
        <MapStatus state={state} retry={retry} />
      </div>
    </figure>
  );
}
