// One clickable point layer (dot + optional label + selection ring) for the Worlds app's curated datasets.
// Clicks are not handled here: MapsApp queries `layer.hitLayers` once per click and routes the hit itself,
// so a click never both selects a feature and drops a pin.
import type * as ML from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

export interface PointItem { id: string; lat: number; lon: number; name: string; color?: string }

export interface PointStyle {
  color: string;
  /** Labels appear from this zoom up (default 3) so a zoomed-out globe stays readable. */
  labelZoom?: number;
  radius?: number;
}

export interface PointLayer {
  hitLayers: string[];
  select: (id: string | null) => void;
  detach: () => void;
}

/** True while `map` can still take style calls (not removed, style present). */
export const mapAlive = (map: ML.Map) => !(map as unknown as { _removed?: boolean })._removed && !!map.style;

export function attachPoints(map: ML.Map, id: string, items: PointItem[], style: PointStyle): PointLayer {
  const src = `sb-pt-${id}`, dot = `${src}-dot`, ring = `${src}-ring`, label = `${src}-label`;
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: items.map(p => ({
      type: 'Feature',
      properties: { id: p.id, name: p.name, color: p.color ?? style.color },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
  const r = style.radius ?? 4.5;
  map.addSource(src, { type: 'geojson', data });
  map.addLayer({
    id: ring, type: 'circle', source: src, filter: ['==', ['get', 'id'], ''],
    paint: { 'circle-radius': r + 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': ['get', 'color'] },
  });
  map.addLayer({
    id: dot, type: 'circle', source: src,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, r * 0.8, 6, r, 12, r + 1.5],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 1.25,
      'circle-stroke-color': 'rgba(6,7,12,0.85)',
    },
  });
  map.addLayer({
    id: label, type: 'symbol', source: src, minzoom: style.labelZoom ?? 3,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 11,
      'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 10,
    },
    paint: { 'text-color': '#f1f5f9', 'text-halo-color': 'rgba(6,7,12,0.9)', 'text-halo-width': 1.5 },
  });

  const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
  const leave = () => { map.getCanvas().style.cursor = ''; };
  map.on('mouseenter', dot, enter);
  map.on('mouseleave', dot, leave);

  return {
    hitLayers: [dot],
    select: sel => { if (mapAlive(map) && map.getLayer(ring)) map.setFilter(ring, ['==', ['get', 'id'], sel ?? '']); },
    detach: () => {
      map.off('mouseenter', dot, enter);
      map.off('mouseleave', dot, leave);
      if (!mapAlive(map)) return;
      leave();
      for (const l of [label, dot, ring]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(src)) map.removeSource(src);
    },
  };
}
