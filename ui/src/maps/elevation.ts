// Elevation along a path, read straight from the terrarium DEM PMTiles the relief layers use (server/maps.py),
// so the measure tool can draw a profile on any world with terrain, no 3D needed.
import { PMTiles } from 'pmtiles';
import type { MapBody } from './core';

const readers = new Map<string, PMTiles>();
const tiles = new Map<string, Promise<Uint8ClampedArray | null>>();

function reader(body: MapBody): PMTiles | null {
  if (!body.terrain) return null;
  const url = `${location.origin}/api/maps/terrain/${body.id}.pmtiles?v=${body.terrain.version}&for=profile`;
  let r = readers.get(url);
  if (!r) { r = new PMTiles(url); readers.set(url, r); }
  return r;
}

async function tile(body: MapBody, z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
  const key = `${body.id}/${z}/${x}/${y}`;
  let p = tiles.get(key);
  if (!p) {
    p = (async () => {
      const r = reader(body);
      if (!r) return null;
      const t = await r.getZxy(z, x, y);
      if (!t?.data) return null;
      const bmp = await createImageBitmap(new Blob([t.data as ArrayBuffer]));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      return ctx.getImageData(0, 0, cv.width, cv.height).data;
    })().catch(() => null);
    tiles.set(key, p);
    if (tiles.size > 400) tiles.delete(tiles.keys().next().value!);
  }
  return p;
}

/** Height in metres at a point (terrarium: R*256 + G + B/256 - 32768), or null outside the tiles. */
export async function elevationAt(body: MapBody, lat: number, lon: number, zoom?: number): Promise<number | null> {
  const t = body.terrain;
  if (!t) return null;
  const z = Math.min(t.maxzoom, zoom ?? t.maxzoom);
  const size = t.tileSize || 256;
  const n = 2 ** z;
  const latR = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const px = Math.min(size - 1, Math.floor((fx - tx) * size)), py = Math.min(size - 1, Math.floor((fy - ty) * size));
  const data = await tile(body, z, tx, ty);
  if (!data) return null;
  const i = (py * size + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

export interface Profile { samples: { d: number; h: number | null }[]; min: number; max: number; climb: number; descent: number; totalKm: number }

/** Sample a great-circle path at `n` points. `pathPts` are the interpolated [lat, lon] positions with cumulative km. */
export async function profileAlong(body: MapBody, pts: { lat: number; lon: number; km: number }[], n = 120): Promise<Profile | null> {
  if (!body.terrain || pts.length < 2) return null;
  const total = pts[pts.length - 1].km;
  const zoom = Math.min(body.terrain.maxzoom, Math.max(3, Math.round(Math.log2(40000 / Math.max(total, 1)) + 2)));
  const samples: { d: number; h: number | null }[] = [];
  const jobs: Promise<void>[] = [];
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    let j = 0;
    while (j < pts.length - 2 && pts[j + 1].km < d) j++;
    const a = pts[j], b = pts[j + 1];
    const f = b.km === a.km ? 0 : (d - a.km) / (b.km - a.km);
    const lat = a.lat + (b.lat - a.lat) * f;
    let dl = b.lon - a.lon;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    const lon = a.lon + dl * f;
    const idx = samples.push({ d, h: null }) - 1;
    jobs.push(elevationAt(body, lat, lon, zoom).then(h => { samples[idx].h = h; }));
  }
  await Promise.all(jobs);
  const hs = samples.map(s => s.h).filter((h): h is number => h !== null);
  if (!hs.length) return null;
  let climb = 0, descent = 0, prev: number | null = null;
  for (const h of hs) { if (prev !== null) { const dh = h - prev; if (dh > 0) climb += dh; else descent -= dh; } prev = h; }
  return { samples, min: Math.min(...hs), max: Math.max(...hs), climb, descent, totalKm: total };
}
