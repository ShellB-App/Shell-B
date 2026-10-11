// The Sol view in the Worlds app: an orrery of the solar system with every body at its real position for a chosen moment
// (now, by default). Canvas 2D with an orthographic camera: drag pans, right/shift-drag turns and tilts, wheel zooms.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { goLive, setClock, useClockState, useClockTime } from './clock';
import { TimeBar } from './TimeBar';
import clsx from 'clsx';
import { Crosshair, Map as MapIcon, PanelLeftOpen, RotateCcw, Ruler, Sparkles, X, Zap } from 'lucide-react';
import { AU, SOL_BODIES, dist, isMajorMoon, moonOrbitPath, moonsOf, orbitPath, positions, type SolBody, type Vec3 } from './sol';
import { AURORAE, AURORA_MIN_PX, drawAurorae, drawRings } from './aurorae';

interface HistoricEvent {
  label: string;
  date: string | null;
  body: string | null;
  desc: string;
}

const HISTORIC_EVENTS: HistoricEvent[] = [
  { label: 'Apollo 11 Landing', date: '1969-07-20T20:17:00Z', body: 'moon', desc: 'First humans on the Moon (1969)' },
  { label: 'Voyager 1 Saturn Flyby', date: '1980-11-12T23:46:00Z', body: 'saturn', desc: 'Closest encounter with Saturn & Titan (1980)' },
  { label: 'Cassini Saturn Insertion', date: '2004-07-01T02:48:00Z', body: 'saturn', desc: 'Entering orbit around Saturn (2004)' },
  { label: 'Curiosity Mars Landing', date: '2012-08-06T05:17:00Z', body: 'mars', desc: 'Touchdown in Gale Crater (2012)' },
  { label: 'New Horizons Pluto Flyby', date: '2015-07-14T11:49:00Z', body: 'pluto', desc: 'First high-res flyby of Pluto (2015)' },
  { label: 'Great Conjunction', date: '2020-12-21T18:20:00Z', body: 'jupiter', desc: 'Jupiter & Saturn 0.1° alignment (2020)' },
];

const VIEW = 'shellb.maps.view.sol';
const DAY = 86_400_000;
const RINGS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 40, 50, 100];

interface Cam { yaw: number; pitch: number; scale: number; panX: number; panY: number; compressed: boolean; follow?: string | null }
const DEFAULT_CAM: Cam = { yaw: 0, pitch: 0.55, scale: 0, panX: 0, panY: 0, compressed: true };

const store = {
  get(): Cam | null { try { return JSON.parse(localStorage.getItem(VIEW) ?? 'null') as Cam | null; } catch { return null; } },
  set(c: Cam) { try { localStorage.setItem(VIEW, JSON.stringify(c)); } catch { /* private mode */ } },
};

const BY_ID = Object.fromEntries(SOL_BODIES.map(b => [b.id, b])) as Record<string, SolBody>;
const KIND_LABEL: Record<SolBody['kind'], string> = { star: 'star', planet: 'planet', dwarf: 'dwarf planet', asteroid: 'asteroid', moon: 'moon' };
const dotPx = (b: SolBody) => {
  const r = b.radius_km ?? 0;
  return b.kind === 'star' ? 7 : r > 20_000 ? 5 : b.kind === 'planet' ? 3.5 : b.kind !== 'moon' ? 2.5 : r >= 1000 ? 2.5 : r >= 100 ? 2 : 1.5;
};
// who gets a label when they crowd: the Sun, planets, dwarfs, then moons by size
const KIND_RANK = { star: 0, planet: 1, dwarf: 2, asteroid: 3, moon: 4 };
const siblings: Record<string, number> = {};
for (const b of SOL_BODIES) if (b.parent) siblings[b.parent] = (siblings[b.parent] ?? 0) + 1;
// nearest major moon of each planet (km)
const innerMajor: Record<string, number> = {};
for (const b of SOL_BODIES) if (b.parent && isMajorMoon(b, siblings[b.parent]))
  innerMajor[b.parent] = Math.min(innerMajor[b.parent] ?? Infinity, b.a_km ?? Infinity);
const LABEL_ORDER = [...SOL_BODIES].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (b.radius_km ?? 0) - (a.radius_km ?? 0)).map(b => b.id);

/** √r radial compression, so Mercury and Neptune fit on one screen. Units stay "AU" at 1 AU. */
const squash = (v: Vec3, on: boolean): Vec3 => {
  if (!on) return v;
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r < 1e-9) return v;
  const k = Math.sqrt(r) / r;
  return [v[0] * k, v[1] * k, v[2] * k];
};

const fmtAU = (au: number) => `${au < 0.1 ? au.toFixed(4) : au.toFixed(3)} AU`;
const fmtKm = (km: number) => km >= 1e9 ? `${(km / 1e9).toFixed(2)} billion km` : km >= 1e6 ? `${(km / 1e6).toFixed(1)} million km` : `${Math.round(km).toLocaleString()} km`;
const fmtLight = (au: number) => { const s = au * AU / 299_792.458; return s < 120 ? `${s.toFixed(1)} light-seconds` : s < 7200 ? `${(s / 60).toFixed(1)} light-minutes` : `${(s / 3600).toFixed(2)} light-hours`; };
const fmtPeriod = (d: number) => d < 1000 ? `${d.toFixed(d < 100 ? 2 : 1)} days` : `${(d / 365.25).toFixed(d < 3650 ? 2 : 1)} years`;

export function SolView({ mapIds, onOpenMap, focus, onShowPanel }: {
  mapIds: Set<string>;
  onOpenMap: (id: string) => void;
  /** select and centre this body when it changes (from the Worlds list) */
  focus?: { id: string } | null;
  onShowPanel?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Cam>({ ...DEFAULT_CAM, ...store.get() });
  const [compressed, setCompressed] = useState(cam.current.compressed);
  const time = useClockTime(30_000);  // the shared Worlds clock (clock.ts)
  const { live } = useClockState();
  const [selected, setSelected] = useState<string | null>(focus?.id ?? null);
  // remembered with the camera: a zoom that only makes sense around Saturn must come back centred on Saturn
  const [follow, setFollow] = useState<string | null>(() => focus?.id ?? cam.current.follow ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);  // bumps on camera moves so the canvas redraws
  const [eventsOpen, setEventsOpen] = useState(false);
  const screen = useRef<Record<string, [number, number]>>({});

  const pos = useMemo(() => positions(time), [time]);

  const pickEvent = (ev: HistoricEvent) => {
    if (ev.date) {
      setClock(new Date(ev.date).getTime());
      if (ev.body && BY_ID[ev.body]) {
        setSelected(ev.body);
        setFollow(ev.body);
      }
    } else {
      goLive();
    }
    setEventsOpen(false);
  };

  // orbits change shape slowly; rebuild them once a simulated year has passed
  const orbitEpoch = Math.round(time / (365.25 * DAY));
  const orbits = useMemo(() => Object.fromEntries(SOL_BODIES.filter(b => b.kind !== 'star' && b.kind !== 'moon')
    .map(b => [b.id, orbitPath(b.id, orbitEpoch * 365.25 * DAY)])), [orbitEpoch]);

  // picked in the Worlds list: select it, centre it, and zoom so its moon system (or its own orbit, for a moon) fills the view
  useEffect(() => {
    const focusId = focus?.id;
    if (!focusId || !BY_ID[focusId]) return;
    if (focusId === 'sol') {  // Sol itself, from the list: back to the whole system
      cam.current = { ...DEFAULT_CAM, compressed: cam.current.compressed };
      setSelected(null); setFollow(null); save(); redraw();
      return;
    }
    setSelected(focusId); setFollow(focusId);
    const b = BY_ID[focusId], el = wrap.current;
    // frame the big regular moons (Phoebe and the irregulars would push the view out tenfold)
    const moons = moonsOf(focusId), big = moons.filter(m => (m.radius_km ?? 0) >= 200);
    const frameBy = big.length ? big : moons.filter(m => isMajorMoon(m, moons.length));
    const reach = b.kind === 'moon' ? b.a_km : frameBy.length ? Math.max(...frameBy.map(m => m.a_km ?? 0)) : null;
    if (reach && el) { cam.current.scale = Math.min(el.clientWidth, el.clientHeight) * 0.4 / (reach / AU); save(); }
    redraw();
  }, [focus]);  // eslint-disable-line react-hooks/exhaustive-deps

  const redraw = useCallback(() => setFrame(f => f + 1), []);
  const save = useCallback(() => store.set(cam.current), []);
  useEffect(() => { cam.current.follow = follow; save(); }, [follow, save]);

  // keep the canvas the size of its box
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [redraw]);

  // ── draw ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvas.current, el = wrap.current;
    if (!cv || !el) return;
    const W = el.clientWidth, H = el.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    if (!g) return;
    const c = cam.current;
    if (!c.scale) c.scale = Math.min(W, H) / 2 / (c.compressed ? 5.6 : 6) * 0.9;  // first visit: frame out to Jupiter (true) / Neptune (√)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#06070c';
    g.fillRect(0, 0, W, H);

    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const proj = (v: Vec3): [number, number] => {
      const x = v[0] * cy - v[1] * sy, y = v[0] * sy + v[1] * cy;
      return [x * c.scale, -(y * cp + v[2] * sp) * c.scale];
    };
    const sq = (v: Vec3) => squash(v, c.compressed);
    const moonOff = (id: string): Vec3 | null => {  // moons sit at their real offset from the parent, even when compressed
      const b = BY_ID[id];
      if (b.kind !== 'moon' || !b.parent) return null;
      const p = pos[b.parent], m = pos[id];
      const s = sq(p);
      return [s[0] + m[0] - p[0], s[1] + m[1] - p[1], s[2] + m[2] - p[2]];
    };
    const world = (id: string) => moonOff(id) ?? sq(pos[id]);

    // follow: keep the followed body centred
    if (follow && pos[follow]) {
      const [fx, fy] = proj(world(follow));
      c.panX = -fx; c.panY = -fy;
    }
    const ox = W / 2 + c.panX, oy = H / 2 + c.panY;
    const at = (v: Vec3): [number, number] => { const [x, y] = proj(v); return [ox + x, oy + y]; };

    // distance rings in the ecliptic plane
    g.lineWidth = 1;
    g.font = '10px Inter Variable, system-ui, sans-serif';
    let lastPx = 0;
    for (const r of RINGS) {
      const rr = c.compressed ? Math.sqrt(r) : r;
      if (rr * c.scale < 24 || rr * c.scale > 4 * Math.max(W, H) || rr * c.scale - lastPx < 28) continue;
      lastPx = rr * c.scale;
      g.strokeStyle = 'rgba(140,160,200,0.10)';
      g.beginPath();
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * 2 * Math.PI;
        const [x, y] = at([rr * Math.cos(a), rr * Math.sin(a), 0]);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
      const [lx, ly] = at([rr * Math.cos(-c.yaw + Math.PI / 4), rr * Math.sin(-c.yaw + Math.PI / 4), 0]);
      g.fillStyle = 'rgba(140,160,200,0.38)';
      g.fillText(`${r} AU`, lx + 3, ly - 3);
    }

    // orbits
    for (const b of SOL_BODIES) {
      const path = orbits[b.id];
      if (!path) continue;
      const on = b.id === selected || b.id === hover;
      g.strokeStyle = on ? b.color : b.kind === 'planet' ? 'rgba(170,185,215,0.28)' : 'rgba(170,185,215,0.16)';
      g.lineWidth = on ? 1.5 : 1;
      g.beginPath();
      path.forEach((v, i) => { const [x, y] = at(sq(v)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }

    // moons: shown once their orbit is a few pixels across, with the orbit itself once it's bigger
    // a planet's moons appear once its big moons separate, so the irregular swarms don't smother the overview
    const visible = (b: SolBody) => b.kind !== 'moon' || ((b.a_km ?? 0) / AU * c.scale > 6 && (innerMajor[b.parent!] ?? 0) / AU * c.scale > 6);
    for (const b of SOL_BODIES) {
      if (b.kind !== 'moon' || !b.parent || !pos[b.parent]) continue;
      const rpx = (b.a_km ?? 0) / AU * c.scale;
      if (rpx < 12 || rpx > 6 * Math.max(W, H) || !visible(b)) continue;
      const base = sq(pos[b.parent]), on = b.id === selected || b.id === hover;
      if (!on && !isMajorMoon(b, siblings[b.parent])) continue;  // small moons' orbits only on demand: there are hundreds
      g.strokeStyle = on ? b.color : (b.radius_km ?? 0) >= 100 ? 'rgba(170,185,215,0.24)' : 'rgba(170,185,215,0.09)';
      g.lineWidth = on ? 1.5 : 1;
      g.beginPath();
      moonOrbitPath(b.id, time).forEach((v, i) => {
        const [x, y] = at([base[0] + v[0], base[1] + v[1], base[2] + v[2]]);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();
    }

    // bodies, far to near; labels avoid each other in priority order
    const pts = SOL_BODIES.filter(b => pos[b.id] && visible(b)).map(b => {
      const v = world(b.id);
      const depth = (v[0] * sy + v[1] * cy) * sp - v[2] * cp;
      return { b, s: at(v), depth };
    });
    screen.current = Object.fromEntries(pts.map(p => [p.b.id, p.s]));
    pts.sort((a, b) => b.depth - a.depth);
    const sun = screen.current.sol;
    if (sun) {
      const glow = g.createRadialGradient(sun[0], sun[1], 0, sun[0], sun[1], 40);
      glow.addColorStop(0, 'rgba(255,210,122,0.55)'); glow.addColorStop(1, 'rgba(255,210,122,0)');
      g.fillStyle = glow;
      g.beginPath(); g.arc(sun[0], sun[1], 40, 0, 2 * Math.PI); g.fill();
    }
    const viewDir: Vec3 = [sy * sp, cy * sp, -cp];
    let animated = false;
    for (const { b, s } of pts) {
      const rTrue = c.compressed ? 0 : ((b.radius_km ?? 0) / AU) * c.scale;
      const r = Math.max(dotPx(b), rTrue);
      const aur = AURORAE[b.id];
      const big = !!aur && rTrue >= AURORA_MIN_PX;
      const dctx = big ? {
        g, cx: s[0], cy: s[1], proj, viewDir, radiusAU: (b.radius_km ?? 0) / AU, radiusPx: rTrue, t: performance.now(),
        moonDir: aur!.footprint && pos[aur!.footprint.moon] ? ([pos[aur!.footprint.moon][0] - pos[b.id][0], pos[aur!.footprint.moon][1] - pos[b.id][1], pos[aur!.footprint.moon][2] - pos[b.id][2]] as Vec3) : null,
      } : null;
      if (dctx) drawRings(aur!, dctx, 'far');
      if (big) {  // a lit disc, darker at the limb, once the planet is more than a dot
        const grad = g.createRadialGradient(s[0] - r * 0.25, s[1] - r * 0.25, r * 0.1, s[0], s[1], r);
        grad.addColorStop(0, b.color); grad.addColorStop(0.75, b.color); grad.addColorStop(1, 'rgba(20,18,30,0.95)');
        g.fillStyle = grad;
      } else g.fillStyle = b.color;
      g.globalAlpha = b.parent && !isMajorMoon(b, siblings[b.parent]) && b.id !== selected && b.id !== hover ? 0.55 : 1;
      g.beginPath(); g.arc(s[0], s[1], r, 0, 2 * Math.PI); g.fill();
      g.globalAlpha = 1;
      if (dctx) { drawRings(aur!, dctx, 'near'); drawAurorae(aur!, dctx); animated = true; }
      if (b.id === selected || b.id === hover) {
        g.strokeStyle = b.id === selected ? '#ff5a36' : 'rgba(255,255,255,0.7)';
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(s[0], s[1], r + 4, 0, 2 * Math.PI); g.stroke();
      }
    }
    const boxes: [number, number, number, number][] = [];
    const labelled = new Set<string>();
    g.font = '11px Inter Variable, system-ui, sans-serif';
    const dots = Object.values(screen.current);
    for (const id of [selected, hover, ...LABEL_ORDER]) {
      if (!id || !screen.current[id] || labelled.has(id)) continue;
      const b = BY_ID[id], [x, y] = screen.current[id];
      if (b.parent && id !== selected && id !== hover && !isMajorMoon(b, siblings[b.parent])) continue;
      const w = g.measureText(b.name).width, d = dotPx(b) + 5;
      // right, left, above, below: the first spot that doesn't collide
      const spot = ([[x + d, y - 6], [x - d - w, y - 6], [x - w / 2, y - d - 2], [x - w / 2, y + d + 9]] as [number, number][]).map(([lx, ly]) =>
        ({ lx, ly, box: [lx - 2, ly - 9, lx + w + 2, ly + 3] as [number, number, number, number] }))
        .find(({ box }) => !boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])
          && !dots.some(([px, py]) => px > box[0] - 3 && px < box[2] + 3 && py > box[1] - 3 && py < box[3] + 3));
      if (!spot) continue;
      const { lx, ly, box } = spot;
      boxes.push(box); labelled.add(id);
      g.fillStyle = id === selected ? '#ffffff' : 'rgba(225,230,240,0.78)';
      g.fillText(b.name, lx, ly);
    }
    // aurorae flicker: redraw a few times a second while one is on screen
    const timer = animated && !document.hidden ? setTimeout(redraw, 110) : undefined;
    return () => { if (timer) clearTimeout(timer); };
  }, [frame, pos, orbits, selected, hover, follow, compressed, time, redraw]);

  // ── interaction ─────────────────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ mode: 'pan' | 'turn'; moved: number } | null>(null);
  const pinch = useRef<number | null>(null);

  const hit = (x: number, y: number) => {
    let best: string | null = null, bd = 14;
    for (const [id, [sx, sy]] of Object.entries(screen.current)) {
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const zoomAt = (x: number, y: number, k: number) => {
    const c = cam.current, el = wrap.current!;
    const next = Math.max(2, Math.min(5e6, c.scale * k));
    k = next / c.scale;
    if (!follow) {  // keep the point under the cursor fixed
      const ox = el.clientWidth / 2 + c.panX, oy = el.clientHeight / 2 + c.panY;
      c.panX += (x - ox) * (1 - k); c.panY += (y - oy) * (1 - k);
    }
    c.scale = next;
    redraw(); save();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    drag.current = { mode: e.button === 2 || e.shiftKey || e.ctrlKey ? 'turn' : 'pan', moved: 0 };
    pinch.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e), prev = pointers.current.get(e.pointerId);
    if (!prev) { const h = hit(p.x, p.y); if (h !== hover) setHover(h); return; }
    pointers.current.set(e.pointerId, p);
    const c = cam.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.current);
      pinch.current = d;
      if (drag.current) drag.current.moved += 10;
      return;
    }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (!drag.current) return;
    drag.current.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.current.mode === 'turn') {
      c.yaw += dx * 0.006;
      c.pitch = Math.max(0, Math.min(Math.PI / 2 - 0.02, c.pitch + dy * 0.006));
    } else {
      if (drag.current.moved > 3 && follow) setFollow(null);
      c.panX += dx; c.panY += dy;
    }
    redraw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return;
    const d = drag.current;
    drag.current = null; pinch.current = null;
    if (d && d.moved < 4) {
      const p = local(e), h = hit(p.x, p.y);
      setSelected(h);
    } else save();
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e), h = hit(p.x, p.y);
    if (h) { setSelected(h); setFollow(h); }
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ── controls ────────────────────────────────────────────────────────────
  const toggleScale = () => {
    const c = cam.current;
    // keep roughly the same framing: √ squashes ~6 AU into ~2.4
    c.compressed = !c.compressed;
    c.scale *= c.compressed ? 2.5 : 0.4;
    c.panX = 0; c.panY = 0;
    setCompressed(c.compressed); save(); redraw();
  };
  const resetView = () => {
    cam.current = { ...DEFAULT_CAM, compressed: cam.current.compressed };
    setFollow(null); save(); redraw();
  };
  /** True scale, centred on the planet, zoomed until its disc fills a third of the view: the poles and their aurorae show. */
  const showAurorae = (id: string) => {
    const b = BY_ID[id], el = wrap.current, c = cam.current;
    if (!b?.radius_km || !el) return;
    c.compressed = false; c.panX = 0; c.panY = 0;
    c.scale = Math.min(5e6, (0.3 * Math.min(el.clientWidth, el.clientHeight)) / (b.radius_km / AU));
    if (c.pitch < 0.35) c.pitch = 0.55;
    setCompressed(false); setSelected(id); setFollow(id); save(); redraw();
  };
  const sel = selected ? BY_ID[selected] : null;
  const fromSun = sel && sel.id !== 'sol' ? dist(pos[sel.id], [0, 0, 0]) : null;
  const fromEarth = sel && sel.id !== 'earth' ? dist(pos[sel.id], pos.earth) : null;
  const outOfRange = Math.abs(new Date(time).getUTCFullYear() - 1925) > 125;

  // scale bar (true scale only): a round number of AU close to 110 px
  const bar = useMemo(() => {
    const s = cam.current.scale;
    if (compressed || !s) return null;
    const target = 110 / s;
    const p = 10 ** Math.floor(Math.log10(target));
    const au = [1, 2, 5, 10].map(m => m * p).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    return { px: au * s, label: au >= 0.01 ? `${+au.toPrecision(2)} AU` : fmtKm(au * AU) };
  }, [frame, compressed]);  // eslint-disable-line react-hooks/exhaustive-deps

  const glassBtn = 'pointer-events-auto h-9 px-3 flex items-center gap-1.5 rounded-lg border text-[12px] transition sb-map-glass';
  const iconBtn = 'h-7 w-7 grid place-items-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60';

  return (
    <div className="absolute inset-0">
      <div ref={wrap} className={clsx('absolute inset-0 touch-none select-none', hover ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing')}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)} onDoubleClick={onDoubleClick} onContextMenu={e => e.preventDefault()}>
        <canvas ref={canvas} className="absolute inset-0 w-full h-full" />
      </div>

      {/* top bar */}
      <div className="absolute top-3 left-3 right-3 flex items-start gap-2 pointer-events-none">
        {onShowPanel && (
          <button className="pointer-events-auto h-9 w-9 grid place-items-center rounded-lg border border-[var(--border-subtle)] sb-map-glass text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={onShowPanel} title="Show worlds"><PanelLeftOpen className="w-4 h-4" /></button>
        )}
        <div className="pointer-events-auto rounded-lg border border-[var(--border-subtle)] sb-map-glass px-3 py-2 w-72 max-w-[calc(100vw-2rem)]">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight">Sol</span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">star system</span>
          </div>
          <p className="text-[11px] leading-snug text-[var(--text-muted)] mt-0.5">
            Positions {live ? 'right now' : 'for the date below'}, from JPL orbital elements. Drag to pan, right- or shift-drag to tilt, scroll to zoom.
          </p>
          {sel && (
            <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
              <div className="flex items-baseline gap-2">
                <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: sel.color }} />
                <span className="text-[13px] font-semibold">{sel.name}</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{sel.parent ? `moon of ${BY_ID[sel.parent].name}` : KIND_LABEL[sel.kind]}</span>
                <button className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setSelected(null)} title="Deselect"><X className="w-3 h-3" /></button>
              </div>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                {fromSun != null && <><dt className="text-[var(--text-muted)]">From Sol</dt><dd>{fmtAU(fromSun)} · {fmtKm(fromSun * AU)}</dd></>}
                {fromEarth != null && <><dt className="text-[var(--text-muted)]">From Earth</dt><dd>{fromEarth < 0.05 ? fmtKm(fromEarth * AU) : fmtAU(fromEarth)} · {fmtLight(fromEarth)}</dd></>}
                {sel.parent && sel.a_km && <><dt className="text-[var(--text-muted)]">From {BY_ID[sel.parent].name}</dt><dd>{fmtKm(sel.a_km)} (mean)</dd></>}
                {sel.period && <><dt className="text-[var(--text-muted)]">{sel.parent ? 'Orbit' : 'Year'}</dt><dd>{fmtPeriod(sel.period)}</dd></>}
                <dt className="text-[var(--text-muted)]">Radius</dt>
                <dd>
                  {sel.radius_km != null ? `${sel.radius_km.toLocaleString()} km` : 'not measured'}
                  {sel.radius_km != null && sel.id !== 'earth' && (
                    <span className="text-[var(--text-muted)] ml-1">
                      ({(sel.radius_km / 6371).toFixed(sel.radius_km < 1000 ? 3 : 2)}× Earth)
                    </span>
                  )}
                </dd>
              </dl>
              {AURORAE[sel.id] && (
                <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"><Zap className="w-3 h-3 text-violet-400" /> Aurorae{sel.id === 'saturn' ? ' and rings' : ''}</div>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-muted)]">{AURORAE[sel.id].note}</p>
                  <button className="mt-1.5 h-7 px-2 flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 text-[11px] text-violet-200 hover:bg-violet-500/20 transition"
                    onClick={() => showAurorae(sel.id)} title="True scale, centred, zoomed to the disc">
                    <Zap className="w-3 h-3" /> Show the aurorae
                  </button>
                </div>
              )}
              <div className="mt-2 flex gap-1.5">
                <button className={clsx('h-7 px-2 flex items-center gap-1 rounded-md border text-[11px] transition',
                  follow === sel.id ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
                  onClick={() => setFollow(f => (f === sel.id ? null : sel.id))} aria-pressed={follow === sel.id}>
                  <Crosshair className="w-3 h-3" /> {follow === sel.id ? 'Centred' : 'Centre'}
                </button>
                {mapIds.has(sel.id) && (
                  <button className="h-7 px-2 flex items-center gap-1 rounded-md border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    onClick={() => onOpenMap(sel.id)}><MapIcon className="w-3 h-3" /> Open map</button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <button className={clsx(glassBtn, eventsOpen ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
            onClick={() => setEventsOpen(o => !o)} title="Jump to historic planetary mission encounters">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Events
          </button>
          {eventsOpen && (
            <div className="pointer-events-auto absolute right-0 top-10 w-64 rounded-lg border border-[var(--border-subtle)] sb-map-glass p-1.5 shadow-xl backdrop-blur-md z-30">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] px-2 py-1">Historic Milestones</div>
              {HISTORIC_EVENTS.map(ev => (
                <button key={ev.label} onClick={() => pickEvent(ev)}
                  className="w-full text-left p-2 rounded-md hover:bg-[var(--bg-tertiary)] transition flex flex-col">
                  <div className="font-medium text-[12px] text-[var(--text-primary)]">{ev.label}</div>
                  <div className="text-[10.5px] text-[var(--text-muted)] leading-tight mt-0.5">{ev.desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className={clsx(glassBtn, compressed ? 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]' : 'border-[var(--accent)] text-[var(--text-primary)]')}
          onClick={toggleScale} aria-pressed={!compressed} title={compressed ? 'Distances are compressed (√r) so every planet fits; switch to true scale' : 'Showing true distances; switch to compressed'}>
          <Ruler className="w-3.5 h-3.5" /> True scale
        </button>
        <button className={clsx(glassBtn, 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')} onClick={resetView} title="Reset the camera">
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* time: the shared Worlds clock; Play starts at a day a second */}
      <TimeBar playRate={5} className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[calc(100%-1.5rem)]" />

      {/* scale + accuracy */}
      <div className="absolute bottom-3 left-3 flex flex-col items-start gap-1 pointer-events-none">
        {outOfRange && <div className="rounded-md border border-amber-500/40 sb-map-glass px-2 py-1 text-[11px] text-amber-300">The orbital elements are fitted to 1800–2050; positions this far out are approximate.</div>}
        <div className="rounded-md border border-[var(--border-subtle)] sb-map-glass px-2 py-1 text-[11px] text-[var(--text-secondary)]">
          {bar ? (
            <div className="flex items-center gap-2"><div className="h-1.5 border-x border-b border-[var(--text-secondary)]" style={{ width: bar.px }} /><span className="tabular-nums">{bar.label}</span></div>
          ) : 'Distances compressed (√r)'}
        </div>
      </div>
    </div>
  );
}
