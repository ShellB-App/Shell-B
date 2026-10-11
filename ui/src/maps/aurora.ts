// Live aurora: NOAA's OVATION 30-minute forecast (probability per 1° cell, via server/earthview.py) painted onto a
// canvas and shown as an image source over the whole map, so the auroral ovals glow where the forecast puts them.
import type * as ML from 'maplibre-gl';
import { mapAlive } from './pointLayer';
import { WORLD_CORNERS, mercatorRowLats } from './wind';

export interface AuroraData { observed?: string; forecast?: string; grid: number[][]; peak: number; fetched: number; stale?: boolean }
const SRC = 'sb-aurora', LAYER = 'sb-aurora-raster';

export const fetchAurora = (): Promise<AuroraData | null> => fetch('/api/earth/aurora').then(r => (r.ok ? r.json() : null)).catch(() => null);

/** Paint the 360 × 181 grid: green for likely aurora, shading to violet at the strongest, transparent elsewhere. */
export function auroraImage(d: AuroraData): string {
  const W = 720, H = 362;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const rowLat = mercatorRowLats(H);  // the image is stretched between ±85° in Mercator, so rows follow Mercator too
  for (let y = 0; y < H; y++) {
    const lat = rowLat[y];
    const li = Math.max(0, Math.min(180, Math.round(lat + 90)));
    for (let x = 0; x < W; x++) {
      const lon = -180 + (x / W) * 360;                     // image spans -180..180
      const lo = ((Math.round(lon) % 360) + 360) % 360;
      const p = d.grid[li]?.[lo] ?? 0;
      if (p < 3) continue;
      const t = Math.min(1, p / 60);
      const i = (y * W + x) * 4;
      img.data[i] = Math.round(60 + 150 * t * t);           // reddish-violet at the top end
      img.data[i + 1] = Math.round(230 - 90 * t);
      img.data[i + 2] = Math.round(110 + 120 * t);
      img.data[i + 3] = Math.round(255 * Math.min(0.85, 0.15 + t * 0.9));
    }
  }
  ctx.putImageData(img, 0, 0);
  // soften the 1° cells
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d')!;
  octx.filter = 'blur(3px)';
  octx.drawImage(cv, 0, 0);
  return out.toDataURL('image/png');
}

export function attachAurora(map: ML.Map, d: AuroraData): () => void {
  if (!mapAlive(map)) return () => {};
  const url = auroraImage(d);
  map.addSource(SRC, { type: 'image', url, coordinates: WORLD_CORNERS });
  map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.85, 6, 0.5, 9, 0.2] as unknown as number, 'raster-fade-duration': 300, 'raster-resampling': 'linear' } });
  return () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
  };
}
