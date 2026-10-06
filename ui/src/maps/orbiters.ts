// Spacecraft flying over the current world, as a MapLibre layer (server/sky.py).
// Earth: Celestrak TLEs (stations + ~150 brightest), propagated here with satellite.js every second.
// Moon, Mars, Mercury: JPL Horizons ground tracks (one sample a minute, 2 h back to 4 h ahead), interpolated here.
// In Globe mode: Satellites are elevated into 3D orbital altitude with altitude stalks, 3D orbit trajectory rings,
// nadir ground footprints, and true ray-sphere planetary occlusion.
import type * as ML from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import type { MapLib } from './core';

export interface OrbiterInfo {
  id: string;
  name: string;
  mission?: string;
  lat: number;
  lon: number;
  alt: number;      // km above the surface
  speed: number;    // km/s over the ground track (Earth: orbital speed)
  station?: boolean;
}

interface Craft {
  id: string;
  name: string;
  mission?: string;
  station?: boolean;
  fix: (t: number) => Omit<OrbiterInfo, 'id' | 'name' | 'mission' | 'station'> | null;
}

const SRC = 'sb-orb', TRACK = 'sb-orb-track';
const PLANET_RADIUS: Record<string, number> = {
  earth: 6371,
  moon: 1737,
  mars: 3390,
  mercury: 2440,
};

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

function hav(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180,
    a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function earthCraft(s: { name: string; norad: number; line1: string; line2: string; group: string }): Craft | null {
  let rec: SatRec;
  try {
    rec = twoline2satrec(s.line1, s.line2);
  } catch {
    return null;
  }
  const station = s.group === 'stations' && /ISS|CSS|TIANHE|TIANGONG/i.test(s.name);
  return {
    id: String(s.norad),
    name: s.name.replace(/\s+\(.*\)$/, '').trim() || s.name,
    station,
    mission: `NORAD ${s.norad}`,
    fix: t => {
      const when = new Date(t),
        pv = propagate(rec, when);
      if (!pv || !pv.position || typeof pv.position === 'boolean' || !pv.velocity || typeof pv.velocity === 'boolean')
        return null;
      const g = eciToGeodetic(pv.position, gstime(when)),
        v = pv.velocity;
      return { lat: degreesLat(g.latitude), lon: degreesLong(g.longitude), alt: g.height, speed: Math.hypot(v.x, v.y, v.z) };
    },
  };
}

function trackCraft(
  c: { id: string; name: string; mission: string; track: [number, number, number, number][] },
  radius: number
): Craft {
  const tr = c.track;
  return {
    id: c.id,
    name: c.name,
    mission: c.mission,
    fix: t => {
      const s = t / 1000;
      if (!tr.length || s < tr[0][0] || s > tr[tr.length - 1][0]) return null;
      let i = tr.findIndex(p => p[0] > s);
      if (i <= 0) i = tr.length - 1;
      const [t0, la0, lo0, a0] = tr[i - 1],
        [t1, la1, lo1, a1] = tr[i];
      const f = (s - t0) / Math.max(1, t1 - t0);
      let dlon = lo1 - lo0;
      if (dlon > 180) dlon -= 360;
      if (dlon < -180) dlon += 360;
      const lon = ((lo0 + dlon * f + 540) % 360) - 180;
      const alt = a0 + (a1 - a0) * f;
      return {
        lat: la0 + (la1 - la0) * f,
        lon,
        alt,
        speed: (hav(la0, lo0, la1, lo1) * (radius + alt)) / Math.max(1, t1 - t0),
      };
    },
  };
}

/** Lon/lat path continuous across ±180, shifted so the point at `anchorIdx` lies in [-180, 180]. */
function unwrapped(pts: Position[], anchorIdx: number): Position[] {
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  const a = pts[anchorIdx];
  if (a) {
    const k = Math.round(a[0] / 360) * 360;
    pts.forEach(p => {
      p[0] -= k;
    });
  }
  return pts;
}

export interface OrbiterLayer {
  detach: () => void;
  select: (id: string | null) => void;
}

/** Compute visual altitude scale above unit sphere (radius 1.0) for Globe mode */
function visualAltitudeFactor(altKm: number, radiusKm: number): number {
  const norm = altKm / radiusKm;
  if (altKm < 1500) {
    // Low Earth/Planet Orbit (ISS ~420km, Starlink ~550km):
    // Visibly elevate into outer space around 22% - 38% above planet radius
    return Math.max(0.20, 0.16 + norm * 1.8);
  }
  if (altKm < 25000) {
    // Medium Earth Orbit (GPS ~20,200km)
    return 0.48 + (norm - 0.23) * 0.22;
  }
  // Geostationary and High Orbits (~35,786km)
  return Math.min(2.2, 0.85 + norm * 0.15);
}

/** Compute vertical altitude in screen pixels for 2D Mercator mode */
function visualAltitudePixels2D(altKm: number): number {
  if (altKm < 1500) {
    return Math.max(30, 26 + (altKm / 1500) * 32);
  }
  if (altKm < 25000) {
    return 58 + (altKm / 25000) * 38;
  }
  return Math.min(135, 96 + (altKm / 36000) * 35);
}

export function attachOrbiters(
  lib: MapLib,
  map: ML.Map,
  bodyId: string,
  opts: {
    onSelect?: (info: OrbiterInfo | null) => void;
    onStatus?: (s: { count: number; error?: string; note?: string }) => void;
  }
): OrbiterLayer {
  void lib;
  let craft: Craft[] = [],
    selected: string | null = null,
    hovered: string | null = null,
    gone = false,
    lastTrack = 0;
  const timers: ReturnType<typeof setInterval>[] = [];
  const planetR = PLANET_RADIUS[bodyId.toLowerCase()] ?? 6371;

  // Add 2D fallback sources & layers (for flat Mercator projection)
  map.addSource(SRC, { type: 'geojson', data: fc([]) });
  map.addSource(TRACK, { type: 'geojson', data: fc([]) });
  map.addLayer({
    id: `${TRACK}-next`,
    type: 'line',
    source: TRACK,
    filter: ['==', ['get', 'part'], 'next'],
    paint: { 'line-color': '#e5e7eb', 'line-opacity': 0.55, 'line-width': 1.5, 'line-dasharray': [2, 3] },
  });
  map.addLayer({
    id: `${TRACK}-past`,
    type: 'line',
    source: TRACK,
    filter: ['==', ['get', 'part'], 'past'],
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#d95926', 'line-width': 2 },
  });
  map.addLayer({
    id: SRC,
    type: 'circle',
    source: SRC,
    paint: {
      'circle-radius': ['case', ['get', 'sel'], 6, ['get', 'station'], 5, 3.5],
      'circle-color': ['case', ['any', ['get', 'sel'], ['get', 'station']], '#d95926', '#3987e5'],
      'circle-stroke-color': '#06070c',
      'circle-stroke-width': 1.5,
    },
  });

  const few = bodyId !== 'earth';
  map.addLayer({
    id: `${SRC}-label`,
    type: 'symbol',
    source: SRC,
    layout: {
      'text-field': few
        ? ['get', 'name']
        : ['step', ['zoom'], ['case', ['any', ['get', 'sel'], ['get', 'station']], ['get', 'name'], ''], 4, ['get', 'name']],
      'text-font': ['Noto Sans Medium'],
      'text-size': 10,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: { 'text-color': '#e5e7eb', 'text-halo-color': '#06070c', 'text-halo-width': 1.2 },
  });

  // ── 3D OVERLAY CANVAS FOR GLOBE PROJECTION ──────────────────────────────
  const container = map.getCanvasContainer();
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'sb-orbiters-3d absolute inset-0 pointer-events-none z-10';
  overlayCanvas.style.position = 'absolute';
  overlayCanvas.style.top = '0';
  overlayCanvas.style.left = '0';
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = '100%';
  overlayCanvas.style.pointerEvents = 'none';
  container.appendChild(overlayCanvas);

  const ctx3d = overlayCanvas.getContext('2d', { alpha: true });

  interface ProjectedCraft {
    c: Craft;
    info: OrbiterInfo;
    surf: { x: number; y: number; occluded: boolean };
    orbit: { x: number; y: number; occluded: boolean };
    dist: number;
    sel: boolean;
  }

  let projectedCrafts: ProjectedCraft[] = [];

  const resizeOverlay = () => {
    if (!overlayCanvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = overlayCanvas.clientWidth;
    const h = overlayCanvas.clientHeight;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (overlayCanvas.width !== pw || overlayCanvas.height !== ph) {
      overlayCanvas.width = pw;
      overlayCanvas.height = ph;
      ctx3d?.scale(dpr, dpr);
    }
  };
  resizeOverlay();
  map.on('resize', resizeOverlay);

  // 3D Point Projection onto screen with ray-sphere occlusion against the unit globe
  const project3D = (
    lng: number,
    lat: number,
    altFactor: number,
    matrix: Float64Array | number[],
    cam: [number, number, number] | Float64Array,
    w: number,
    h: number
  ): { x: number; y: number; occluded: boolean; depth: number } | null => {
    const rad = Math.PI / 180;
    const lngR = lng * rad;
    const latR = lat * rad;
    const cosLat = Math.cos(latR);

    // Unit sphere surface normal
    const nx = Math.sin(lngR) * cosLat;
    const ny = Math.sin(latR);
    const nz = Math.cos(lngR) * cosLat;

    const r = 1.0 + altFactor;
    const px = nx * r;
    const py = ny * r;
    const pz = nz * r;

    // Transform by MapLibre modelViewProjectionMatrix (converts unit-sphere world coordinates to clip space)
    const cx = matrix[0] * px + matrix[4] * py + matrix[8] * pz + matrix[12];
    const cy = matrix[1] * px + matrix[5] * py + matrix[9] * pz + matrix[13];
    const cz = matrix[2] * px + matrix[6] * py + matrix[10] * pz + matrix[14];
    const cw = matrix[3] * px + matrix[7] * py + matrix[11] * pz + matrix[15];

    if (cw <= 0.001) return null; // Behind camera plane

    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const screenX = (ndcX * 0.5 + 0.5) * w;
    const screenY = (-ndcY * 0.5 + 0.5) * h;

    // Ray-sphere occlusion calculation against planet unit sphere (radius 1.0)
    const dx = px - cam[0];
    const dy = py - cam[1];
    const dz = pz - cam[2];
    const dist = Math.hypot(dx, dy, dz);
    let occluded = false;

    if (dist > 1e-4) {
      const vx = dx / dist;
      const vy = dy / dist;
      const vz = dz / dist;
      // Parameter t along the ray from camera where closest approach to sphere center (0,0,0) occurs
      const t = -(cam[0] * vx + cam[1] * vy + cam[2] * vz);
      if (t > 0 && t < dist) {
        const camDistSq = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2];
        const dSq = camDistSq - t * t;
        if (dSq < 0.998) {
          occluded = true;
        }
      }
    }

    return { x: screenX, y: screenY, occluded, depth: cw };
  };

  // Render 3D Elevated Satellites, Alt Stalks, and Orbit Rings
  const render3D = () => {
    if (gone || !ctx3d || !overlayCanvas) return;
    resizeOverlay();

    const isGlobe = map.getProjection()?.type === 'globe';
    const transform = (map as any).transform;
    const matrix = transform?.modelViewProjectionMatrix;
    const cam = transform?.cameraPosition;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = transform?.width ?? (overlayCanvas.width / dpr);
    const h = transform?.height ?? (overlayCanvas.height / dpr);
    ctx3d.clearRect(0, 0, overlayCanvas.width / dpr, overlayCanvas.height / dpr);

    // Hide flat 2D GeoJSON layers so only our elevated spacecraft with stalks render
    if (map.getLayer(SRC)) map.setLayoutProperty(SRC, 'visibility', 'none');
    if (map.getLayer(`${SRC}-label`)) map.setLayoutProperty(`${SRC}-label`, 'visibility', 'none');
    if (map.getLayer(`${TRACK}-next`)) map.setLayoutProperty(`${TRACK}-next`, 'visibility', isGlobe ? 'none' : 'visible');
    if (map.getLayer(`${TRACK}-past`)) map.setLayoutProperty(`${TRACK}-past`, 'visibility', isGlobe ? 'none' : 'visible');

    const now = Date.now();
    projectedCrafts = [];

    const is3DGlobe = isGlobe && matrix && cam;

    // Project each active satellite into elevated position
    for (const c of craft) {
      const f = c.fix(now);
      if (!f) continue;
      const altFactor = visualAltitudeFactor(f.alt, planetR);
      const sel = c.id === selected;
      const info: OrbiterInfo = { id: c.id, name: c.name, mission: c.mission, station: c.station, ...f };

      if (is3DGlobe) {
        const surf = project3D(f.lon, f.lat, 0, matrix, cam, w, h);
        let orbit = project3D(f.lon, f.lat, altFactor, matrix, cam, w, h);
        if (!orbit) continue;

        // Ensure visible vertical altitude separation even near the center of the globe
        if (surf && !orbit.occluded) {
          const dx = orbit.x - surf.x;
          const dy = orbit.y - surf.y;
          const dist = Math.hypot(dx, dy);
          const minStalk = 28 + altFactor * 35;
          if (dist < minStalk) {
            const ang = dist > 0.5 ? Math.atan2(dy, dx) : -Math.PI / 2;
            orbit = {
              ...orbit,
              x: surf.x + Math.cos(ang) * minStalk,
              y: surf.y + Math.sin(ang) * minStalk,
            };
          }
        }

        if (!orbit.occluded || sel) {
          projectedCrafts.push({
            c,
            info,
            surf: surf ?? { x: orbit.x, y: orbit.y, occluded: true },
            orbit: { x: orbit.x, y: orbit.y, occluded: orbit.occluded },
            dist: orbit.depth,
            sel,
          });
        }
      } else {
        // Flat Mercator mode: Project nadir on map and elevate satellite vertically
        try {
          const pt = map.project([f.lon, f.lat]);
          const altPx = visualAltitudePixels2D(f.alt);
          projectedCrafts.push({
            c,
            info,
            surf: { x: pt.x, y: pt.y, occluded: false },
            orbit: { x: pt.x, y: pt.y - altPx, occluded: false },
            dist: 1000 - f.alt,
            sel,
          });
        } catch {}
      }
    }

    // Sort back-to-front by depth
    projectedCrafts.sort((a, b) => b.dist - a.dist);

    const timePulse = (Date.now() % 2000) / 2000;

    // 1. Draw 3D Orbit Trajectory Ring for Selected Satellite
    if (selected) {
      const selCraft = craft.find(x => x.id === selected);
      if (selCraft) {
        const step = 45_000;
        const ptsPast: { x: number; y: number; occluded: boolean }[] = [];
        const ptsNext: { x: number; y: number; occluded: boolean }[] = [];

        // Past 45 min
        for (let t = now - 45 * 60_000; t <= now; t += step) {
          const f = selCraft.fix(t);
          if (f) {
            const p = project3D(f.lon, f.lat, visualAltitudeFactor(f.alt, planetR), matrix, cam, w, h);
            if (p) ptsPast.push(p);
          }
        }

        // Next 90 min
        for (let t = now; t <= now + 90 * 60_000; t += step) {
          const f = selCraft.fix(t);
          if (f) {
            const p = project3D(f.lon, f.lat, visualAltitudeFactor(f.alt, planetR), matrix, cam, w, h);
            if (p) ptsNext.push(p);
          }
        }

        // Draw Past Trajectory in 3D
        if (ptsPast.length > 1) {
          ctx3d.save();
          ctx3d.beginPath();
          let started = false;
          for (let i = 0; i < ptsPast.length; i++) {
            const p = ptsPast[i];
            if (p.occluded) {
              started = false;
              continue;
            }
            if (!started) {
              ctx3d.moveTo(p.x, p.y);
              started = true;
            } else {
              ctx3d.lineTo(p.x, p.y);
            }
          }
          ctx3d.strokeStyle = '#f97316';
          ctx3d.lineWidth = 2.0;
          ctx3d.shadowColor = '#ea580c';
          ctx3d.shadowBlur = 8;
          ctx3d.stroke();
          ctx3d.restore();
        }

        // Draw Future Trajectory in 3D
        if (ptsNext.length > 1) {
          ctx3d.save();
          ctx3d.beginPath();
          ctx3d.setLineDash([5, 4]);
          let started = false;
          for (let i = 0; i < ptsNext.length; i++) {
            const p = ptsNext[i];
            if (p.occluded) {
              started = false;
              continue;
            }
            if (!started) {
              ctx3d.moveTo(p.x, p.y);
              started = true;
            } else {
              ctx3d.lineTo(p.x, p.y);
            }
          }
          ctx3d.strokeStyle = 'rgba(226, 232, 240, 0.75)';
          ctx3d.lineWidth = 1.6;
          ctx3d.shadowColor = '#38bdf8';
          ctx3d.shadowBlur = 6;
          ctx3d.stroke();
          ctx3d.restore();
        }
      }
    }

    // 2. Draw Altitude Stalks & Nadir Footprints
    for (const item of projectedCrafts) {
      if (item.orbit.occluded && !item.sel) continue;
      const { surf, orbit, info } = item;

      // Draw Nadir Footprint & Pulsing Ring on the surface (if surface is visible)
      if (!surf.occluded) {
        ctx3d.save();
        ctx3d.fillStyle = item.sel ? 'rgba(249, 115, 22, 0.7)' : 'rgba(56, 189, 248, 0.55)';
        ctx3d.beginPath();
        ctx3d.arc(surf.x, surf.y, item.sel ? 3 : 2, 0, Math.PI * 2);
        ctx3d.fill();

        // Pulsing radar wave ring on nadir point
        if (item.sel || info.station) {
          ctx3d.strokeStyle = item.sel
            ? `rgba(249, 115, 22, ${1 - timePulse})`
            : `rgba(56, 189, 248, ${0.8 * (1 - timePulse)})`;
          ctx3d.lineWidth = 1.2;
          ctx3d.beginPath();
          ctx3d.arc(surf.x, surf.y, 2 + timePulse * 10, 0, Math.PI * 2);
          ctx3d.stroke();
        }
        ctx3d.restore();

        // Draw Altitude Stalk (Vertical laser beam connecting surface to orbital height)
        ctx3d.save();
        const grad = ctx3d.createLinearGradient(surf.x, surf.y, orbit.x, orbit.y);
        if (item.sel) {
          grad.addColorStop(0, 'rgba(249, 115, 22, 0.25)');
          grad.addColorStop(1, 'rgba(251, 146, 60, 0.95)');
          ctx3d.strokeStyle = grad;
          ctx3d.lineWidth = 1.5;
        } else {
          grad.addColorStop(0, 'rgba(56, 189, 248, 0.15)');
          grad.addColorStop(1, 'rgba(56, 189, 248, 0.75)');
          ctx3d.strokeStyle = grad;
          ctx3d.lineWidth = 1.0;
          ctx3d.setLineDash([2, 3]);
        }
        ctx3d.beginPath();
        ctx3d.moveTo(surf.x, surf.y);
        ctx3d.lineTo(orbit.x, orbit.y);
        ctx3d.stroke();
        ctx3d.restore();
      }
    }

    // 3. Draw Spacecraft Vehicles at Altitude
    for (const item of projectedCrafts) {
      const { orbit, info, sel } = item;
      const isHovered = hovered === item.c.id;
      const ox = orbit.x;
      const oy = orbit.y;
      const isOcc = orbit.occluded;

      ctx3d.save();
      if (isOcc) {
        ctx3d.globalAlpha = 0.35; // Occulted behind the planet
      }

      if (info.station) {
        // Space Station (ISS, Tiangong): Procedural module + golden solar panels
        ctx3d.save();
        ctx3d.translate(ox, oy);

        // Selection / Hover target ring
        if (sel || isHovered) {
          ctx3d.strokeStyle = sel ? '#f97316' : '#38bdf8';
          ctx3d.lineWidth = 1.5;
          ctx3d.beginPath();
          ctx3d.arc(0, 0, 11, 0, Math.PI * 2);
          ctx3d.stroke();
        }

        // Golden Solar Arrays
        ctx3d.fillStyle = '#fbbf24';
        ctx3d.shadowColor = '#f59e0b';
        ctx3d.shadowBlur = 6;
        ctx3d.fillRect(-8, -4.5, 4.5, 9);
        ctx3d.fillRect(3.5, -4.5, 4.5, 9);

        // Central Truss & Habitat Modules
        ctx3d.fillStyle = '#f8fafc';
        ctx3d.fillRect(-3, -1.5, 6, 3);

        // Flashing Strobe Light
        if (timePulse < 0.25) {
          ctx3d.fillStyle = '#ef4444';
          ctx3d.beginPath();
          ctx3d.arc(0, 0, 1.8, 0, Math.PI * 2);
          ctx3d.fill();
        }
        ctx3d.restore();
      } else {
        // Satellites (Hubble, Starlink, GPS, MRO, LRO): Diamond bus + solar wings
        ctx3d.save();
        ctx3d.translate(ox, oy);

        if (sel || isHovered) {
          ctx3d.strokeStyle = sel ? '#f97316' : '#38bdf8';
          ctx3d.lineWidth = 1.4;
          ctx3d.beginPath();
          ctx3d.arc(0, 0, 8, 0, Math.PI * 2);
          ctx3d.stroke();
        }

        // Solar panels
        ctx3d.fillStyle = '#38bdf8';
        ctx3d.fillRect(-4.5, -1, 2.5, 2);
        ctx3d.fillRect(2, -1, 2.5, 2);

        // Satellite bus core
        ctx3d.fillStyle = sel ? '#f97316' : '#e0f2fe';
        ctx3d.shadowColor = sel ? '#ea580c' : '#0284c7';
        ctx3d.shadowBlur = 5;
        ctx3d.beginPath();
        ctx3d.arc(0, 0, sel ? 3.2 : 2.4, 0, Math.PI * 2);
        ctx3d.fill();
        ctx3d.restore();
      }

      // Labels & Altitude Tags (Always for stations/selected, or on hover, or at close zoom)
      const showLabel = sel || isHovered || info.station || (map.getZoom() > 4 && item.c.name.length < 15);
      if (showLabel && !isOcc) {
        ctx3d.save();
        const labelText = info.name;
        const altText = `${Math.round(info.alt)} km · ${info.speed.toFixed(1)} km/s`;

        ctx3d.font = '600 10px Inter, system-ui, sans-serif';
        const tw = Math.max(ctx3d.measureText(labelText).width, ctx3d.measureText(altText).width);

        const lx = ox + 10;
        const ly = oy - 8;

        // Aero-glass background pill
        ctx3d.fillStyle = sel ? 'rgba(15, 23, 42, 0.88)' : 'rgba(15, 23, 42, 0.75)';
        ctx3d.strokeStyle = sel ? 'rgba(249, 115, 22, 0.5)' : 'rgba(56, 189, 248, 0.35)';
        ctx3d.lineWidth = 1;

        ctx3d.beginPath();
        ctx3d.roundRect(lx - 4, ly - 10, tw + 8, 24, 5);
        ctx3d.fill();
        ctx3d.stroke();

        // Title
        ctx3d.fillStyle = sel ? '#fbbf24' : '#f8fafc';
        ctx3d.fillText(labelText, lx, ly);

        // Subtitle altitude & velocity
        ctx3d.font = '500 8.5px "JetBrains Mono", monospace';
        ctx3d.fillStyle = sel ? '#fdba74' : '#93c5fd';
        ctx3d.fillText(altText, lx, ly + 10);

        ctx3d.restore();
      }

      ctx3d.restore();
    }
  };

  // Synchronize 3D rendering with MapLibre frame loop
  map.on('render', render3D);

  // Interactive mouse click and hover detection on elevated satellites
  const onMouseMove = (e: ML.MapMouseEvent) => {
    if (gone) return;
    const px = e.point.x;
    const py = e.point.y;
    let foundId: string | null = null;

    // Hit-test in reverse order (front-to-back)
    for (let i = projectedCrafts.length - 1; i >= 0; i--) {
      const item = projectedCrafts[i];
      if (item.orbit.occluded && !item.sel) continue;
      const dx = px - item.orbit.x;
      const dy = py - item.orbit.y;
      if (Math.hypot(dx, dy) <= 16) {
        foundId = item.c.id;
        break;
      }
    }

    if (foundId !== hovered) {
      hovered = foundId;
      map.getCanvas().style.cursor = hovered ? 'pointer' : '';
      render3D();
    }
  };

  const onMapClick = (e: ML.MapMouseEvent) => {
    if (gone) return;
    const px = e.point.x;
    const py = e.point.y;
    let clickedId: string | null = null;

    for (let i = projectedCrafts.length - 1; i >= 0; i--) {
      const item = projectedCrafts[i];
      if (item.orbit.occluded && !item.sel) continue;
      const dx = px - item.orbit.x;
      const dy = py - item.orbit.y;
      if (Math.hypot(dx, dy) <= 20) {
        clickedId = item.c.id;
        break;
      }
    }

    if (clickedId != null) {
      select(clickedId);
      return;
    }
  };

  map.on('mousemove', onMouseMove);
  map.on('click', onMapClick);

  const onClick2D = (e: ML.MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id;
    if (id != null) select(String(id));
  };
  const enter2D = () => {
    map.getCanvas().style.cursor = 'pointer';
  };
  const leave2D = () => {
    map.getCanvas().style.cursor = '';
  };
  map.on('click', SRC, onClick2D);
  map.on('mouseenter', SRC, enter2D);
  map.on('mouseleave', SRC, leave2D);

  const drawTrack = () => {
    const c = craft.find(x => x.id === selected),
      src = map.getSource(TRACK) as ML.GeoJSONSource | undefined;
    if (!src) return;
    if (!c) {
      src.setData(fc([]));
      return;
    }
    const now = Date.now(),
      step = 30_000,
      pts = (from: number, to: number) => {
        const out: Position[] = [];
        for (let t = from; t <= to; t += step) {
          const f = c.fix(t);
          if (f) out.push([f.lon, f.lat]);
        }
        return out;
      };
    const past = pts(now - 45 * 60_000, now),
      next = pts(now, now + 90 * 60_000);
    src.setData(
      fc([
        ...(past.length > 1
          ? [
              {
                type: 'Feature' as const,
                properties: { part: 'past' },
                geometry: { type: 'LineString' as const, coordinates: unwrapped(past, past.length - 1) },
              },
            ]
          : []),
        ...(next.length > 1
          ? [
              {
                type: 'Feature' as const,
                properties: { part: 'next' },
                geometry: { type: 'LineString' as const, coordinates: unwrapped(next, 0) },
              },
            ]
          : []),
      ])
    );
    lastTrack = now;
  };

  const tick = () => {
    if (gone) return;
    const now = Date.now();
    let selInfo: OrbiterInfo | null = null;
    const features: Feature[] = [];
    for (const c of craft) {
      const f = c.fix(now);
      if (!f) continue;
      const sel = c.id === selected;
      if (sel) selInfo = { id: c.id, name: c.name, mission: c.mission, station: c.station, ...f };
      features.push({
        type: 'Feature',
        properties: { id: c.id, name: c.name, sel, station: !!c.station },
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      });
    }
    (map.getSource(SRC) as ML.GeoJSONSource | undefined)?.setData(fc(features));
    if (selected) {
      opts.onSelect?.(selInfo);
      if (now - lastTrack > 10_000) drawTrack();
    }
    render3D();
    if (!features.length && craft.length)
      opts.onStatus?.({ count: 0, note: 'The cached orbits have run out; reconnect to refresh them.' });
  };

  function select(id: string | null) {
    selected = id;
    lastTrack = 0;
    drawTrack();
    if (!id) opts.onSelect?.(null);
    tick();
  }

  const load = async () => {
    try {
      if (bodyId === 'earth') {
        const r = await fetch('/api/sky/group?name=stations,visual');
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
        craft = (d.sats as Parameters<typeof earthCraft>[0][]).map(earthCraft).filter((c): c is Craft => !!c);
      } else {
        const r = await fetch(`/api/sky/orbiters?body=${encodeURIComponent(bodyId)}`);
        const d = await r.json();
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `HTTP ${r.status}`);
        const radius = d.radius_km ?? planetR;
        craft = (d.craft as Parameters<typeof trackCraft>[0][]).map(c => trackCraft(c, radius));
        if (d.stale) opts.onStatus?.({ count: craft.length, note: 'Offline: showing the last orbits Shell:B fetched.' });
      }
      if (gone) return;
      opts.onStatus?.({
        count: craft.length,
        note: craft.length ? undefined : `No spacecraft are orbiting ${bodyId[0].toUpperCase() + bodyId.slice(1)} right now.`,
      });
      tick();
    } catch (e) {
      if (!gone) opts.onStatus?.({ count: 0, error: (e as Error).message });
    }
  };
  load();
  timers.push(setInterval(tick, 1000));
  if (bodyId !== 'earth') timers.push(setInterval(load, 30 * 60_000)); // Horizons tracks: keep the window ahead of now
  else timers.push(setInterval(load, 6 * 3600_000));

  return {
    select,
    detach: () => {
      gone = true;
      timers.forEach(clearInterval);
      map.off('render', render3D);
      map.off('resize', resizeOverlay);
      map.off('mousemove', onMouseMove);
      map.off('click', onMapClick);
      map.off('click', SRC, onClick2D);
      map.off('mouseenter', SRC, enter2D);
      map.off('mouseleave', SRC, leave2D);
      try {
        if (overlayCanvas.parentNode) overlayCanvas.parentNode.removeChild(overlayCanvas);
      } catch {
        /* container gone */
      }
      try {
        for (const id of [`${SRC}-label`, SRC, `${TRACK}-past`, `${TRACK}-next`]) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of [SRC, TRACK]) if (map.getSource(id)) map.removeSource(id);
      } catch {
        /* the map itself is already gone */
      }
    },
  };
}
