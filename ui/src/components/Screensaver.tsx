import { useEffect, useRef, useState } from 'react';
import { PREVIEW_SAVER, ambienceShot, ambienceSuppressed, reducedMotion, studioSaverId, useAmbience, type SaverStyle, type SceneStyle } from '../ambience';
import { runAmbient } from '../themes/Ambient';
import type { AmbientConfig } from '../themes';
import { frameRawUrl, rawUrl } from '../api';
import { getFormFactor } from '../formFactor';
import '../ambience.css';

const ACTIVITY = ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

// Something else is plausibly holding the user's attention even though this document sees no input:
// a playing video, or focus inside an iframe (artifacts, previews), whose events never reach us.
function busyElsewhere() {
  if (document.activeElement?.tagName === 'IFRAME') return true;
  return Array.from(document.querySelectorAll('video')).some(v => !v.paused && !v.ended);
}

export function Screensaver() {
  const isMobile = getFormFactor() === 'mobile';
  const prefs = useAmbience();
  const shot = ambienceShot().split(':');
  const [on, setOn] = useState(() => !isMobile && shot[0] === 'saver');
  const [previewStyle, setPreviewStyle] = useState<SaverStyle | null>(null);  // the Studio's Preview button
  useEffect(() => { if (!on) setPreviewStyle(null); }, [on]);
  const last = useRef(Date.now());

  useEffect(() => {
    if (isMobile) return;
    const preview = (e: Event) => { setPreviewStyle((e as CustomEvent<SaverStyle | undefined>).detail ?? null); setOn(true); };
    window.addEventListener(PREVIEW_SAVER, preview);
    return () => window.removeEventListener(PREVIEW_SAVER, preview);
  }, [isMobile]);

  // Idle watch
  useEffect(() => {
    if (isMobile || !prefs.saverMinutes || ambienceSuppressed()) return;
    const bump = () => { last.current = Date.now(); };
    const onVis = () => { if (!document.hidden) bump(); };
    ACTIVITY.forEach(e => window.addEventListener(e, bump, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', onVis);
    bump();
    const t = setInterval(() => {
      if (document.hidden || busyElsewhere()) { bump(); return; }
      if (Date.now() - last.current >= prefs.saverMinutes * 60_000) setOn(true);
    }, 5000);
    return () => {
      ACTIVITY.forEach(e => window.removeEventListener(e, bump, { capture: true }));
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [prefs.saverMinutes]);

  // Wake on input. Keys are swallowed so the wake-up press doesn't type into the composer or close a modal.
  useEffect(() => {
    if (!on) return;
    let origin: { x: number; y: number } | null = null;
    const wake = () => { last.current = Date.now(); setOn(false); };
    const onKey = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); wake(); };
    const onMove = (e: MouseEvent) => {
      if (!origin) { origin = { x: e.clientX, y: e.clientY }; return; }
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 12) wake();
    };
    const armed = Date.now();  // ignore the stray events of the click on "Preview"
    const guarded = <E extends Event>(f: (e: E) => void) => (e: E) => { if (Date.now() - armed > 600) f(e); };
    const k = guarded(onKey), m = guarded(onMove), w = guarded(wake);
    window.addEventListener('keydown', k, true);
    window.addEventListener('mousemove', m, true);
    window.addEventListener('wheel', w, true);
    return () => {
      window.removeEventListener('keydown', k, true);
      window.removeEventListener('mousemove', m, true);
      window.removeEventListener('wheel', w, true);
    };
  }, [on]);

  if (isMobile || !on) return null;
  return (
    <div className="sb-saver" onClick={() => { last.current = Date.now(); setOn(false); }}
      onTouchStart={e => { e.preventDefault(); last.current = Date.now(); setOn(false); }}>
      <SaverScene style={previewStyle || (shot.slice(1).join(':') as SaverStyle) || prefs.saverStyle} />
      {prefs.saverClock && <SaverClock />}
    </div>
  );
}

function SaverClock() {
  const [now, setNow] = useState(() => new Date());
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date();
      setNow(d);
      if (d.getSeconds() === 0) setNudge({ x: Math.random() * 6 - 3, y: Math.random() * 4 - 2 });  // slow drift against burn-in
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="sb-saver-clock" style={{ transform: `translate(${nudge.x}vw, ${nudge.y}vh)` }}>
      <div className="sb-saver-time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="sb-saver-date">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </div>
  );
}

/** A built-in style drawn here, or a Studio screensaver run in a sandboxed frame. */
function SaverScene({ style }: { style: SaverStyle }) {
  const pid = studioSaverId(style);
  if (pid) return <StudioSaver pid={pid} />;
  if (style in SCENES) return <SceneSaver id={style as SceneStyle} />;
  return <SaverCanvas style={style} />;
}

/** The scenes: a theme's scenery as layers (ambience.css, .sb-scene-<id>) with its particles running over them. */
const SCENES: Record<SceneStyle, AmbientConfig> = {
  meadow: { kind: 'fireflies', density: 1.3 },
  aurora: { kind: 'aurora', extra: ['#ffffff', '#e6f2ff'], density: 1.1 },
  rain: { kind: 'rain', extra: ['#ffb347', '#ff9a4a', '#ff5a6f', '#5fd4e8', '#ffe08a', '#ff7ad9'], density: 1.2 },
  abyss: { kind: 'abyss', density: 1.2 },
  sakura: { kind: 'petals', colors: ['#f7cdd9', '#efb3c6', '#fde3ea'], density: 1.2 },
  dunes: { kind: 'sand', density: 1.1 },
};

function SceneSaver({ id }: { id: SceneStyle }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => runAmbient(ref.current!, SCENES[id], { always: true }), [id]);
  return (
    <div className={`sb-scene sb-scene-${id}`}>
      <canvas ref={ref} className="sb-saver-canvas" />
    </div>
  );
}

/** A Screensaver project from the Studio: its index.html in the same sandbox as Studio previews (scripts only, no
 *  same-origin), and pointer-events off so every movement and key still reaches us and wakes the screen. If the project
 *  is gone or empty, the synthwave horizon stands in. */
function StudioSaver({ pid }: { pid: string }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch(rawUrl(pid, 'index.html'), { cache: 'no-store' }).then(r => { if (live) setOk(r.ok); }, () => { if (live) setOk(false); });
    return () => { live = false; };
  }, [pid]);
  if (ok === false) return <SaverCanvas style="synthwave" />;
  if (ok === null) return null;
  return <iframe src={frameRawUrl(pid, 'index.html')} title="Screensaver" sandbox="allow-scripts" tabIndex={-1} aria-hidden
    className="sb-saver-canvas" style={{ border: 0, pointerEvents: 'none', background: '#000' }} />;
}

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) => void;

function SaverCanvas({ style }: { style: SaverStyle }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0, h = 0;
    const size = () => {
      w = window.innerWidth; h = window.innerHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener('resize', size);
    const draw = (style === 'starfield' ? starfield : style === 'bounce' ? bounce : synthwave)();
    const speed = reducedMotion() ? 0.25 : 1;
    let raf = 0, prev = performance.now(), t = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000) * speed;
      prev = now; t += dt;
      draw(ctx, w, h, t, dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size); };
  }, [style]);
  return <canvas ref={ref} className="sb-saver-canvas" />;
}

const PINK = '#ff2e97', CYAN = '#22d3ee', VIOLET = '#a855f7';

function stars(n: number) {
  return Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.2 + 0.2, p: Math.random() * Math.PI * 2 }));
}

function synthwave(): Draw {
  const sky = stars(160);
  return (ctx, w, h, t) => {
    const hz = h * 0.58, cx = w / 2;
    const skyGrad = ctx.createLinearGradient(0, 0, 0, hz);
    skyGrad.addColorStop(0, '#05010d');
    skyGrad.addColorStop(0.6, '#1a0733');
    skyGrad.addColorStop(1, '#4a0b4f');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, hz);

    for (const s of sky) {
      if (s.y * h > hz - 20) continue;
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + s.p));
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.x * w, s.y * hz, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // Sun, cut by horizontal bands that scroll down into the horizon
    const r = Math.min(w, h) * 0.24, sy = hz - r * 0.35;
    ctx.save();
    ctx.shadowColor = PINK; ctx.shadowBlur = 60;
    const sun = ctx.createLinearGradient(0, sy - r, 0, sy + r);
    sun.addColorStop(0, '#ffe45e'); sun.addColorStop(0.5, '#ff8a3d'); sun.addColorStop(1, PINK);
    ctx.fillStyle = sun;
    ctx.beginPath(); ctx.arc(cx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = skyGrad;
    for (let i = 0; i < 9; i++) {
      const f = ((i + (t * 0.35) % 1) / 9);
      const y = sy - r * 0.1 + f * r * 1.1;
      const th = 1 + f * r * 0.09;
      if (y < hz) ctx.fillRect(cx - r - 2, y, r * 2 + 4, Math.min(th, hz - y));
    }

    // Ground and grid
    const ground = ctx.createLinearGradient(0, hz, 0, h);
    ground.addColorStop(0, '#12021f'); ground.addColorStop(1, '#05010d');
    ctx.fillStyle = ground;
    ctx.fillRect(0, hz, w, h - hz);
    ctx.save();
    ctx.shadowColor = PINK; ctx.shadowBlur = 10;
    ctx.strokeStyle = PINK; ctx.lineWidth = 1.4;
    ctx.beginPath();
    const depth = h - hz;
    for (let i = -24; i <= 24; i++) {
      ctx.moveTo(cx + i * w * 0.012, hz);
      ctx.lineTo(cx + i * w * 0.16, h);
    }
    const phase = (t * 0.6) % 1;
    for (let z = 0; z < 22; z++) {
      const d = z + 1 - phase;  // distance; lines come toward the viewer
      const y = hz + depth * (1 / d) * 0.9;
      if (y > h || y < hz) continue;
      ctx.globalAlpha = Math.min(1, (y - hz) / (depth * 0.15));
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;

    const glow = ctx.createLinearGradient(0, hz - 30, 0, hz + 30);
    glow.addColorStop(0, 'rgba(255,46,151,0)'); glow.addColorStop(0.5, 'rgba(255,46,151,0.55)'); glow.addColorStop(1, 'rgba(255,46,151,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, hz - 30, w, 60);
  };
}

function starfield(): Draw {
  const tints = ['#ffffff', '#ffffff', '#cfe9ff', CYAN, PINK, VIOLET];
  const pts = Array.from({ length: 900 }, () => spawn(Math.random()));
  function spawn(z = 1) { return { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z, c: tints[(Math.random() * tints.length) | 0] }; }
  let first = true;
  return (ctx, w, h, t, dt) => {
    if (first) { ctx.fillStyle = '#04010a'; ctx.fillRect(0, 0, w, h); first = false; }
    ctx.fillStyle = 'rgba(4,1,10,0.35)';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2 + Math.sin(t * 0.13) * w * 0.06, cy = h / 2 + Math.cos(t * 0.17) * h * 0.05;
    const f = Math.max(w, h) * 0.5;
    const v = 0.22 + 0.1 * Math.sin(t * 0.25);
    ctx.lineCap = 'round';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pz = p.z;
      p.z -= v * dt;
      if (p.z <= 0.02) { pts[i] = spawn(); continue; }
      const x0 = cx + (p.x / pz) * f, y0 = cy + (p.y / pz) * f;
      const x1 = cx + (p.x / p.z) * f, y1 = cy + (p.y / p.z) * f;
      if (x1 < -50 || x1 > w + 50 || y1 < -50 || y1 > h + 50) { pts[i] = spawn(); continue; }
      ctx.globalAlpha = Math.min(1, (1 - p.z) * 1.4);
      ctx.strokeStyle = p.c;
      ctx.lineWidth = Math.max(0.5, (1 - p.z) * 2.6);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
}

function bounce(): Draw {
  const bg = stars(120);
  let x = Math.random() * 200 + 40, y = Math.random() * 200 + 40;
  let vx = 110, vy = 80, hue = 290, flash = 0;
  return (ctx, w, h, t, dt) => {
    ctx.fillStyle = '#05010d';
    ctx.fillRect(0, 0, w, h);
    for (const s of bg) {
      ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(t * 0.6 + s.p));
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    const tile = Math.max(44, Math.min(w, h) * 0.08);
    ctx.font = `700 ${tile * 0.62}px 'Inter Variable', Inter, system-ui, sans-serif`;
    const word = 'Shell:B';
    const bw = tile + tile * 0.3 + ctx.measureText(word).width, bh = tile;
    x += vx * dt; y += vy * dt;
    let hits = 0;
    if (x < 0) { x = 0; vx = Math.abs(vx); hits++; } else if (x + bw > w) { x = w - bw; vx = -Math.abs(vx); hits++; }
    if (y < 0) { y = 0; vy = Math.abs(vy); hits++; } else if (y + bh > h) { y = h - bh; vy = -Math.abs(vy); hits++; }
    if (hits) hue = (hue + 67) % 360;
    if (hits === 2) flash = 1;  // a perfect corner
    flash = Math.max(0, flash - dt * 0.7);

    const c1 = `hsl(${hue} 90% 62%)`, c2 = `hsl(${(hue + 50) % 360} 90% 70%)`;
    ctx.save();
    ctx.shadowColor = c1; ctx.shadowBlur = 30 + flash * 60;
    const g = ctx.createLinearGradient(x, y, x + tile, y + tile);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(x, y, tile, tile, tile * 0.22); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('B', x + tile / 2, y + tile * 0.54);
    ctx.textAlign = 'left';
    ctx.shadowColor = c1; ctx.shadowBlur = 18;
    ctx.fillStyle = c2;
    ctx.fillText(word, x + tile * 1.3, y + tile * 0.54);
    ctx.restore();
    if (flash) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.15})`; ctx.fillRect(0, 0, w, h); }
  };
}
