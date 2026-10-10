// The themes' living layer: a canvas behind the app (like the FM visualizer) where things drift on their own:
// Normandy's fireflies, Sakura's petals, Pandora's woodsprites and spores, rain on a window over city bokeh, deep-sea
// jellyfish in marine snow, Arrakis's blowing sand, Borealis's aurora and snow, Ghibli's falling leaves; snow, embers
// and bubbles for custom themes too. Depth is faked with size and pre-blurred sprites: far things small and sharp,
// near ones big and soft. Three systems are procedural rather than sprites: rain on glass, jellyfish, aurora.
// It draws only while the active theme asks for it in the current mode, the tab is visible and Shell:B FM isn't
// playing; with reduced motion it paints one still frame. Mounted once in main.tsx.
import { useEffect, useRef, useState } from 'react';
import { ambientNow, type AmbientConfig } from '.';

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;
type Ctx = CanvasRenderingContext2D;
type Sprite = HTMLCanvasElement;

/** One sprite drawn three times: sharp, slightly soft, out of focus. */
function sprites(size: number, paint: (g: Ctx, s: number) => void): Sprite[] {
  return [0, 1.5, 4].map(blur => {
    const pad = Math.ceil(blur * 3), c = document.createElement('canvas');
    c.width = c.height = size + pad * 2;
    const g = c.getContext('2d')!;
    if (blur) g.filter = `blur(${blur}px)`;
    g.translate(pad, pad); paint(g, size);
    return c;
  });
}
const blurOf = (z: number) => (z < 0.5 ? 0 : z < 0.78 ? 1 : 2);

/** #rrggbb + alpha 0–1 → #rrggbbaa */
const al = (c: string, a: number) => c + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');

function glow(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, '#ffffff'); r.addColorStop(0.1, color);
    r.addColorStop(0.35, color + '55'); r.addColorStop(1, color + '00');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  };
}

/** A soft speck with no white core: marine snow, sand grains. */
function speck(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, color); r.addColorStop(0.3, al(color, 0.6)); r.addColorStop(1, al(color, 0));
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  };
}

/** A lens's out-of-focus highlight: a flat disc with a slightly brighter rim. */
function bokeh(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2 - 1);
    r.addColorStop(0, al(color, 0.32)); r.addColorStop(0.78, al(color, 0.42));
    r.addColorStop(0.93, al(color, 0.62)); r.addColorStop(1, al(color, 0));
    g.fillStyle = r; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 1, 0, TAU); g.fill();
  };
}

/** A sakura petal: a rounded teardrop with the notch at its tip, darker at the base. */
function petal(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    g.save(); g.translate(s / 2, s / 2); g.scale(s / 2.2, s / 2.2);
    g.beginPath();
    g.moveTo(0, 1);
    g.bezierCurveTo(0.62, 0.62, 0.72, -0.25, 0.34, -0.95);
    g.quadraticCurveTo(0.16, -0.78, 0, -0.66);
    g.quadraticCurveTo(-0.16, -0.78, -0.34, -0.95);
    g.bezierCurveTo(-0.72, -0.25, -0.62, 0.62, 0, 1);
    const f = g.createLinearGradient(0, 1, 0, -1);
    f.addColorStop(0, shade(color, -0.22)); f.addColorStop(0.35, color); f.addColorStop(1, shade(color, 0.35));
    g.fillStyle = f; g.fill();
    g.strokeStyle = shade(color, -0.12) + '66'; g.lineWidth = 0.04; g.stroke();
    g.restore();
  };
}

/** A maple leaf: five pointed, serrated lobes, veins and a stem. */
function leaf(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    g.save(); g.translate(s / 2, s * 0.54);
    const R = s * 0.46, lobes: [number, number][] = [[-90, 1], [-38, 0.88], [-142, 0.88], [12, 0.5], [168, 0.5]];
    const r = (th: number) => {
      let m = 0.2;
      for (const [deg, L] of lobes) m = Math.max(m, L * Math.pow(Math.max(0, Math.cos(th - deg * Math.PI / 180)), 9));
      return R * m * (1 + 0.07 * Math.sin(th * 26));
    };
    g.beginPath();
    for (let i = 0; i <= 160; i++) { const th = (i / 160) * TAU - Math.PI; const rr = r(th); g.lineTo(Math.cos(th) * rr, Math.sin(th) * rr); }
    g.closePath();
    const f = g.createRadialGradient(0, 0, 0, 0, 0, R);
    f.addColorStop(0, shade(color, 0.18)); f.addColorStop(0.7, color); f.addColorStop(1, shade(color, -0.25));
    g.fillStyle = f; g.fill();
    g.strokeStyle = shade(color, -0.35) + 'aa'; g.lineWidth = s * 0.012; g.lineCap = 'round';
    for (const [deg, L] of lobes) { const a = deg * Math.PI / 180; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * L * 0.85, Math.sin(a) * R * L * 0.85); g.stroke(); }
    g.lineWidth = s * 0.022; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(s * 0.03, s * 0.2, -s * 0.02, s * 0.36); g.stroke();
    g.restore();
  };
}

/** Pandora's woodsprite (atokirina): a bright seed with fine filaments trailing below it like a jellyfish. */
function woodsprite(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    const cx = s / 2, cy = s * 0.36;
    g.lineCap = 'round';
    for (let i = 0; i < 22; i++) {
      const a = Math.PI * (0.08 + 0.84 * (i / 21)) + rand(-0.05, 0.05), len = s * rand(0.32, 0.6);
      const ex = cx + Math.cos(a) * len * 0.75, ey = cy + Math.sin(a) * len;
      const grad = g.createLinearGradient(cx, cy, ex, ey);
      grad.addColorStop(0, color + 'cc'); grad.addColorStop(1, color + '00');
      g.strokeStyle = grad; g.lineWidth = s * 0.008;
      g.beginPath(); g.moveTo(cx, cy);
      g.quadraticCurveTo(cx + Math.cos(a) * len * 0.2 + rand(-4, 4), cy + len * 0.5, ex, ey); g.stroke();
      g.fillStyle = color + '99'; g.beginPath(); g.arc(ex, ey, s * 0.008, 0, TAU); g.fill();
    }
    for (let i = 0; i < 12; i++) {  // the crown: short filaments fanning up
      const a = -Math.PI * (0.15 + 0.7 * (i / 11)), len = s * rand(0.08, 0.16);
      g.strokeStyle = color + '88'; g.lineWidth = s * 0.007;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
    }
    const r = g.createRadialGradient(cx, cy, 0, cx, cy, s * 0.16);
    r.addColorStop(0, '#ffffff'); r.addColorStop(0.25, color); r.addColorStop(1, color + '00');
    g.fillStyle = r; g.beginPath(); g.arc(cx, cy, s * 0.16, 0, TAU); g.fill();
  };
}

function ring(color: string): (g: Ctx, s: number) => void {
  return (g, s) => {
    const r = g.createRadialGradient(s * 0.42, s * 0.4, s * 0.05, s / 2, s / 2, s / 2 - 1);
    r.addColorStop(0, color + '10'); r.addColorStop(0.8, color + '22'); r.addColorStop(0.97, color + 'bb'); r.addColorStop(1, color + '00');
    g.fillStyle = r; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 1, 0, TAU); g.fill();
    g.fillStyle = '#ffffffaa'; g.beginPath(); g.ellipse(s * 0.34, s * 0.3, s * 0.08, s * 0.05, -0.6, 0, TAU); g.fill();
  };
}

/** Lighten (amt > 0) or darken a #rrggbb colour. */
function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1, 7), 16), ch = [n >> 16, (n >> 8) & 255, n & 255];
  return '#' + ch.map(c => Math.round(amt > 0 ? c + (255 - c) * amt : c * (1 + amt)).toString(16).padStart(2, '0')).join('');
}

interface P {
  x: number; y: number; z: number; v: number;  // v: sprite variant
  vx: number; vy: number; heading: number; turn: number; speed: number;
  phase: 0 | 1 | 2 | 3; t: number; dur: number; glow: number;  // blink: dark, rise, hold, fade
  rot: number; spin: number; flip: number; flipRate: number; sway: number;
}

// sprite systems. per: screen area (px²) per particle; size: sprite size range, far → near
const KINDS = {
  fireflies: { colors: ['#e3f77a', '#f0f78a', '#c9f26a'], per: 36000, min: 16, max: 46, size: [22, 68], additive: true },
  petals: { colors: ['#f7c6d3', '#f3b0c3', '#fbdde6'], per: 30000, min: 18, max: 54, size: [9, 26], additive: false },
  leaves: { colors: ['#d9622b', '#e8a33a', '#b8402a', '#cf7f2a'], per: 52000, min: 10, max: 30, size: [14, 40], additive: false },
  woodsprites: { colors: ['#e8fbff', '#bff6ff'], per: 90000, min: 7, max: 16, size: [60, 150], additive: true },
  spores: { colors: ['#3ff0e0', '#b07cff', '#ff5fd8'], per: 26000, min: 20, max: 60, size: [10, 30], additive: true },
  snow: { colors: ['#ffffff', '#e6f2ff'], per: 14000, min: 30, max: 110, size: [5, 18], additive: false },
  embers: { colors: ['#ffb347', '#ff7a2f', '#ffd27a'], per: 30000, min: 16, max: 50, size: [8, 26], additive: true },
  bubbles: { colors: ['#9fe8ff', '#c7f2ff'], per: 50000, min: 10, max: 30, size: [12, 46], additive: false },
  bokeh: { colors: ['#ffb347', '#ff5a4f', '#4fd8ff', '#ff7ad9', '#ffe08a'], per: 60000, min: 10, max: 26, size: [40, 190], additive: true },
  marinesnow: { colors: ['#cfe6ff', '#e8f3ff'], per: 9000, min: 40, max: 160, size: [3, 12], additive: false },
  plankton: { colors: ['#4fd8ff', '#7fb4ff', '#6dffd8'], per: 1e9, min: 0, max: 0, size: [8, 22], additive: true },
  sand: { colors: ['#e9c99a', '#d9a86c', '#f3dcb8'], per: 7000, min: 50, max: 220, size: [4, 11], additive: false },
  motes: { colors: ['#fff3c4', '#ffe7a0', '#ffffff'], per: 22000, min: 24, max: 80, size: [4, 14], additive: true },
} as const;
type SpriteKind = keyof typeof KINDS;
/** What a theme can ask for. rain = city bokeh + streaks + drops on the glass; abyss = marine snow + jellyfish + plankton
 *  that lights where the pointer moves; aurora = curtains + snow; shallows = bubbles + jellyfish in daylight water. */
export type AmbientKind = Exclude<SpriteKind, 'spores' | 'marinesnow' | 'plankton'> | 'rain' | 'abyss' | 'aurora' | 'shallows';

function paintFor(kind: SpriteKind, color: string) {
  switch (kind) {
    case 'petals': return petal(color);
    case 'leaves': return leaf(color);
    case 'woodsprites': return woodsprite(color);
    case 'bubbles': return ring(color);
    case 'bokeh': return bokeh(color);
    case 'marinesnow': case 'sand': return speck(color);
    default: return glow(color);
  }
}

interface Env { wind: number; mx: number; my: number; mvx: number; mvy: number; t: number }
interface System { resize(w: number, h: number): void; step(dt: number, env: Env): void; draw(g: Ctx, dpr: number): void; ripple?(x: number, y: number): void; still(): void }

const okColors = (c: readonly string[] | undefined, d: readonly string[]) => {
  const v = (c ?? []).filter(x => /^#[0-9a-f]{6}$/i.test(x));
  return v.length ? v : [...d];
};

/** A sprite particle system. */
function system(kind: SpriteKind, cfg: { colors?: readonly string[]; density?: number; blend?: 'normal' }): System {
  const k = KINDS[kind];
  const additive = cfg.blend === 'normal' ? false : k.additive;
  const sheets = okColors(cfg.colors, k.colors).map(c => sprites(kind === 'woodsprites' ? 128 : kind === 'bokeh' ? 96 : 64, paintFor(kind, c)));
  const density = Math.min(2, Math.max(0.2, cfg.density ?? 1));
  const falls = kind === 'petals' || kind === 'snow' || kind === 'leaves' || kind === 'marinesnow';
  const tumbles = kind === 'petals' || kind === 'leaves';
  let w = 0, h = 0, ps: P[] = [];

  const spawn = (anywhere: boolean): P => {
    const z = Math.pow(Math.random(), 1.6);
    const low = kind === 'fireflies';  // fireflies live low, over the trees
    return {
      x: kind === 'sand' && !anywhere ? rand(-80, -10) : rand(-20, w + 20),
      y: kind === 'sand' ? h * (1 - Math.pow(Math.random(), 1.3) * 0.5)
        : anywhere ? (low ? h * (1 - Math.pow(Math.random(), 0.7) * 0.85) : rand(0, h)) : falls ? rand(-60, -10) : h + rand(10, 60),
      z, v: Math.floor(Math.random() * sheets.length),
      vx: 0, vy: 0, heading: rand(0, TAU), turn: 0,
      speed: kind === 'woodsprites' ? rand(4, 9) : rand(8, 20) * (0.6 + z),
      phase: 0, t: rand(0, 20), dur: rand(0, 4), glow: kind === 'fireflies' ? 0 : 1,
      rot: rand(0, TAU), spin: rand(-1.2, 1.2), flip: rand(0, TAU), flipRate: rand(1.2, 3.4), sway: rand(0, TAU),
    };
  };

  const blink = (p: P, dt: number) => {  // firefly flash: dark → quick rise → short hold → slow fade
    p.t += dt;
    if (p.t >= p.dur) {
      p.t = 0;
      p.phase = ((p.phase + 1) % 4) as P['phase'];
      p.dur = [rand(1.2, 6.5), rand(0.18, 0.35), rand(0.1, 0.45), rand(0.7, 1.5)][p.phase];
    }
    const q = p.t / p.dur;
    p.glow = [0, q, 1, (1 - q) * (1 - q)][p.phase];
  };

  const step = (p: P, dt: number, env: Env) => {
    const near = 0.5 + p.z;
    switch (kind) {
      case 'fireflies':
        blink(p, dt);
        p.turn += rand(-1, 1) * dt * 2.2; p.turn *= 0.97; p.heading += p.turn * dt;
        p.vx = Math.cos(p.heading) * p.speed; p.vy = Math.sin(p.heading) * p.speed * 0.6 - 3 * near;
        if (p.y < h * 0.12) p.vy += 12;
        break;
      case 'petals': case 'snow': case 'leaves': case 'marinesnow': {
        const sea = kind === 'marinesnow';
        p.sway += dt * (tumbles ? 1.1 : 0.7) * (sea ? 0.4 : 1);
        const fall = (kind === 'petals' ? 26 : kind === 'leaves' ? 34 : sea ? 7 : 18) * near;
        p.vx = Math.sin(p.sway) * (tumbles ? 22 : sea ? 4 : 10) * near + env.wind * near * (sea ? 0.08 : kind === 'leaves' ? 1.3 : 1);
        p.vy = fall + Math.cos(p.sway * 2) * (sea ? 2 : 6);
        p.rot += p.spin * dt * (kind === 'leaves' ? 1.6 : 1); p.flip += p.flipRate * dt;
        break;
      }
      case 'woodsprites':
        // drift on the air like a jellyfish: a slow pulse that lifts, then sink
        p.sway += dt * 0.6; p.turn += rand(-1, 1) * dt * 0.6; p.turn *= 0.98; p.heading += p.turn * dt;
        p.vx = Math.cos(p.heading) * p.speed + env.wind * 0.3;
        p.vy = -Math.max(0, Math.sin(p.sway)) * 10 * near + 3;
        p.glow = 0.7 + 0.3 * Math.sin(p.sway * 1.7 + p.flip);
        p.rot = Math.sin(p.sway * 0.8 + p.flip) * 0.18;
        break;
      case 'spores': case 'embers':
        p.sway += dt * 1.4; p.t += dt;
        p.vx = Math.sin(p.sway + p.flip) * 8 * near + env.wind * 0.5;
        p.vy = -(kind === 'embers' ? 30 : 9) * near;
        p.glow = kind === 'embers' ? 0.55 + 0.45 * Math.abs(Math.sin(p.t * 9 + p.flip)) : 0.35 + 0.65 * Math.max(0, Math.sin(p.t * 1.3 + p.flip));
        break;
      case 'motes':
        // dust in a sunbeam: hanging, turning over slowly, catching the light now and then
        p.sway += dt * 0.5; p.t += dt;
        p.vx = Math.sin(p.sway + p.flip) * 5 * near + env.wind * 0.15; p.vy = Math.cos(p.sway * 0.7 + p.flip) * 3 * near - 1.5;
        p.glow = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(p.t * 0.9 + p.flip * 3), 3);
        break;
      case 'bubbles':
        p.sway += dt * 1.6;
        p.vx = Math.sin(p.sway) * 10 * near; p.vy = -22 * near;
        break;
      case 'bokeh':
        // streetlights seen through rain: barely drifting, swelling and fading as cars and wipers pass
        p.t += dt * (0.15 + p.z * 0.1);
        p.vx = Math.sin(p.t + p.flip) * 3; p.vy = Math.cos(p.t * 0.7 + p.flip) * 2;
        p.glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(p.t * 1.7 + p.sway));
        break;
      case 'sand': {
        // grains skating on the wind, streaking, lifting in eddies
        p.sway += dt * 2.2;
        p.vx = Math.max(40, (110 + 220 * p.z) + env.wind * 4);
        p.vy = Math.sin(p.sway + p.flip) * 14 * near - 4;
        break;
      }
    }
    // the pointer: fireflies and sprites shy away; petals, leaves and snow are blown by its movement
    if (kind !== 'bokeh' && kind !== 'sand') {
      const dx = p.x - env.mx, dy = p.y - env.my, d2 = dx * dx + dy * dy, R = 150;
      if (d2 < R * R) {
        const d = Math.sqrt(d2) || 1, f = 1 - d / R;
        if (falls) { p.vx += env.mvx * f * 0.6; p.vy += env.mvy * f * 0.4; p.spin += env.mvx * f * 0.0004; }
        else { p.vx += dx / d * f * 60; p.vy += dy / d * f * 60; }
      }
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (kind === 'sand') { if (p.x > w + 40) Object.assign(p, spawn(false)); return; }
    if (p.x < -60) p.x = w + 60; else if (p.x > w + 60) p.x = -60;
    if (kind === 'bokeh') { if (p.y < -100) p.y = h + 80; else if (p.y > h + 100) p.y = -80; return; }
    if (p.y > h + 60) {
      if (falls) Object.assign(p, spawn(false), { x: rand(-20, w + 20) });
      else p.y = h + 40;
    }
    if (p.y < -80) Object.assign(p, spawn(false));
  };

  const draw = (g: Ctx, dpr: number) => {
    const home = () => g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = additive ? 'lighter' : 'source-over';
    for (const p of ps) {
      const sheet = sheets[p.v], sp = sheet[kind === 'bokeh' ? (p.z < 0.4 ? 1 : 2) : blurOf(p.z)];
      const size = k.size[0] + p.z * (k.size[1] - k.size[0]);
      const s0 = sheet[0].width, pad = (sp.width - s0) / 2;  // blurred sprites carry extra margin
      const scale = size / s0, full = sp.width * scale;
      let a: number;
      if (kind === 'fireflies') a = (0.05 + 0.95 * p.glow) * (0.95 - p.z * 0.5);
      else if (kind === 'spores' || kind === 'embers' || kind === 'motes') a = p.glow * (0.9 - p.z * 0.4);
      else if (kind === 'woodsprites') a = p.glow * (0.95 - p.z * 0.45);
      else if (kind === 'bokeh') a = p.glow * (0.75 - p.z * 0.35);
      else if (kind === 'marinesnow') a = 0.55 - p.z * 0.25;
      else if (kind === 'sand') a = 0.35 + p.z * 0.35;
      else a = 0.9 - p.z * 0.35;
      g.globalAlpha = Math.max(0, a);
      if (tumbles) {
        // tumbling: rotate, then squash one axis on the flip phase so it turns edge-on and back
        g.translate(p.x, p.y); g.rotate(p.rot); g.scale(1, Math.max(0.12, Math.abs(Math.cos(p.flip))));
        g.drawImage(sp, -full / 2, -full / 2, full, full);
        home();
      } else if (kind === 'woodsprites') {
        // anchored on the seed, not the sprite's centre, so it sways from there
        g.translate(p.x, p.y); g.rotate(p.rot); g.drawImage(sp, -full / 2, -(pad + s0 * 0.36) * scale, full, full); home();
      } else if (kind === 'sand') {
        // a streak, as long as the grain is fast
        g.translate(p.x, p.y); g.rotate(Math.atan2(p.vy, p.vx)); g.scale(1 + p.vx / 40, 1);
        g.drawImage(sp, -full / 2, -full / 2, full, full); home();
      } else {
        g.drawImage(sp, p.x - full / 2, p.y - full / 2, full, full);
        if (kind === 'fireflies' && p.glow > 0.4) {  // the wide halo while lit
          g.globalAlpha = (p.glow - 0.4) * 0.35;
          g.drawImage(sheet[2], p.x - full * 1.6, p.y - full * 1.6, full * 3.2, full * 3.2);
        }
      }
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  };

  return {
    resize: (W, H) => {
      w = W; h = H;
      const want = Math.round(Math.min(k.max, Math.max(k.min, (w * h) / k.per)) * density);
      while (ps.length < want) ps.push(spawn(true));
      ps.length = want;
    },
    step: (dt, env) => { for (const p of ps) step(p, dt, env); },
    draw,
    /** Fireflies' synchronous flash: a ripple out from one point across the swarm. */
    ripple: (ox, oy) => {
      if (kind !== 'fireflies') return;
      for (const p of ps) { p.phase = 0; p.t = 0; p.dur = Math.hypot(p.x - ox, p.y - oy) / 900 + rand(0, 0.08); }
    },
    still: () => { for (const p of ps) p.glow = kind === 'fireflies' ? (Math.random() < 0.45 ? rand(0.4, 1) : 0) : rand(0.5, 1); },
  };
}

// ── rain on the glass ────────────────────────────────────────────────────────
/** A water bead on a window at night: dark rim, a specular glint up top, the city's light refracted into its belly. */
function bead(tint: string): Sprite {
  const s = 48, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.translate(s / 2, s / 2);
  g.scale(1, 1.08);
  const r = s / 2 - 2;
  const body = g.createRadialGradient(0, r * 0.25, r * 0.1, 0, 0, r);
  body.addColorStop(0, 'rgba(255,255,255,0.05)'); body.addColorStop(0.75, 'rgba(10,14,24,0.18)'); body.addColorStop(0.92, 'rgba(0,0,0,0.42)'); body.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = body; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
  const belly = g.createRadialGradient(0, r * 0.55, 0, 0, r * 0.45, r * 0.7);
  belly.addColorStop(0, al(tint, 0.75)); belly.addColorStop(1, al(tint, 0));
  g.fillStyle = belly; g.beginPath(); g.arc(0, 0, r * 0.9, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.ellipse(-r * 0.35, -r * 0.42, r * 0.16, r * 0.1, -0.6, 0, TAU); g.fill();
  return c;
}

interface Drop { x: number; y: number; r: number; v: number; sliding: boolean; life: number; trail: number; wob: number; s: number }

function rainOnGlass(cfg: { colors?: readonly string[]; density?: number; blend?: 'normal' }): System {
  const tints = okColors(cfg.colors, ['#ffc27a', '#ff8a7a', '#9fdcff', '#ffd9a8']);
  const beads = tints.map(bead);
  const density = Math.min(2, Math.max(0.2, cfg.density ?? 1));
  let w = 0, h = 0;
  let drops: Drop[] = [];
  let streaks: { x: number; y: number; len: number; v: number; a: number }[] = [];
  const mk = (big: boolean, anywhere = true): Drop => ({
    x: rand(0, w), y: anywhere ? rand(0, h) : rand(-20, h * 0.6), r: big ? rand(3.5, 8) : rand(0.8, 2.4),
    v: 0, sliding: false, life: 0, trail: 0, wob: rand(0, TAU), s: Math.floor(Math.random() * beads.length),
  });
  return {
    resize: (W, H) => {
      w = W; h = H;
      const big = Math.round(Math.min(90, Math.max(20, (w * h) / 22000)) * density), small = Math.round(Math.min(380, (w * h) / 4500) * density);
      drops = [...Array.from({ length: big }, () => mk(true)), ...Array.from({ length: small }, () => mk(false))];
      streaks = Array.from({ length: Math.round(Math.min(140, (w * h) / 12000) * density) }, () => ({ x: rand(0, w), y: rand(0, h), len: rand(10, 34), v: rand(700, 1100), a: rand(0.05, 0.16) }));
    },
    step: (dt, env) => {
      const slant = env.wind * 0.004;
      for (const s of streaks) { s.y += s.v * dt; s.x += s.v * dt * slant; if (s.y > h + 40) { s.y = rand(-60, -10); s.x = rand(-40, w + 40); } }
      const fresh: Drop[] = [];
      for (const d of drops) {
        d.life += dt;
        if (d.r < 2.6) continue;  // the fine mist never moves
        if (!d.sliding && Math.random() < dt * 0.045 * (d.r / 5)) { d.sliding = true; d.v = rand(20, 60); }
        if (!d.sliding) continue;
        d.v = Math.min(320, d.v + dt * rand(60, 240));
        d.wob += dt * rand(3, 9);
        d.y += d.v * dt; d.x += Math.sin(d.wob) * dt * 18;
        d.trail += d.v * dt;
        if (d.trail > rand(7, 15)) {  // it leaves beads behind and shrinks a little
          d.trail = 0; d.r = Math.max(2.8, d.r - 0.04);
          fresh.push({ x: d.x + rand(-1, 1), y: d.y - d.r * 1.4, r: rand(0.7, 1.5), v: 0, sliding: false, life: 0, trail: 0, wob: 0, s: d.s });
        }
        if (Math.random() < dt * 0.6) { d.sliding = false; d.v = 0; }  // and catches on the glass again
        if (d.y > h + 20) Object.assign(d, mk(true, false));
      }
      // trail beads evaporate; keep the pool bounded
      if (fresh.length) drops.push(...fresh);
      if (drops.length > 900) drops = drops.filter(d => d.r >= 2.6 || d.life < 14 || Math.random() < 0.5);
      for (const d of drops) if (d.r < 1.6 && d.life > rand(10, 30)) Object.assign(d, mk(false), { life: 0 });
    },
    draw: (g) => {
      // streaks of rain beyond the glass: light on a night sky, a little darker than the sky by day
      const day = cfg.blend === 'normal';
      g.globalCompositeOperation = day ? 'source-over' : 'lighter';
      g.strokeStyle = day ? '#6d7c90' : '#bcd8ff'; g.lineWidth = 1; g.lineCap = 'round';
      for (const s of streaks) { g.globalAlpha = s.a; g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x - s.len * 0.08, s.y - s.len); g.stroke(); }
      g.globalCompositeOperation = 'source-over';
      for (const d of drops) {
        const sz = d.r * 2.4;
        g.globalAlpha = d.r < 1.6 ? 0.55 : 0.92;
        g.drawImage(beads[d.s], d.x - sz / 2, d.y - sz / 2, sz, sz * (d.sliding ? 1.15 : 1));
      }
      g.globalAlpha = 1;
    },
    still: () => {},
  };
}

// ── the abyss: jellyfish ─────────────────────────────────────────────────────
interface Jelly { x: number; y: number; s: number; ph: number; period: number; vx: number; vy: number; tilt: number; c: string; n: number; seed: number }

function jellyfish(cfg: { colors?: readonly string[]; density?: number; blend?: 'normal' }): System {
  const colors = okColors(cfg.colors, ['#7fb4ff', '#ff7ad9', '#6dffd8', '#b28bff']);
  const halos = colors.map(c => sprites(64, glow(c))[2]);
  let w = 0, h = 0, js: Jelly[] = [];
  const mk = (anywhere: boolean): Jelly => {
    const s = rand(22, 70) * (Math.random() < 0.2 ? 1.6 : 1);
    return { x: rand(0, w), y: anywhere ? rand(h * 0.1, h) : h + s * 3, s, ph: rand(0, 1), period: rand(2.6, 4.4), vx: rand(-6, 6), vy: 0, tilt: 0,
      c: colors[Math.floor(Math.random() * colors.length)], n: 6 + Math.floor(Math.random() * 6), seed: rand(0, 100) };
  };
  return {
    resize: (W, H) => {
      w = W; h = H;
      const want = Math.round(Math.min(11, Math.max(4, (w * h) / 160000)) * Math.min(2, Math.max(0.2, cfg.density ?? 1)));
      while (js.length < want) js.push(mk(true));
      js.length = want;
    },
    step: (dt, env) => {
      for (const j of js) {
        const prev = j.ph;
        j.ph = (j.ph + dt / j.period) % 1;
        if (j.ph < prev) j.vy -= j.s * 0.9;  // a pulse: the bell contracts and it rises
        j.vy += 9 * dt; j.vy *= Math.pow(0.55, dt);
        j.vx += Math.sin(env.t * 0.2 + j.seed) * dt * 2; j.vx *= Math.pow(0.8, dt);
        const dx = j.x - env.mx, dy = j.y - env.my, d2 = dx * dx + dy * dy;
        if (d2 < 160 * 160) { const d = Math.sqrt(d2) || 1; j.vx += dx / d * 30 * dt; j.vy += dy / d * 30 * dt; }
        j.x += j.vx * dt; j.y += j.vy * dt;
        j.tilt += ((Math.atan2(j.vx, -j.vy) * 0.35) - j.tilt) * Math.min(1, dt * 1.5);
        if (j.y < -j.s * 3) Object.assign(j, mk(false));
        if (j.x < -j.s * 2) j.x = w + j.s; else if (j.x > w + j.s * 2) j.x = -j.s;
        if (j.y > h + j.s * 4) j.y = h + j.s * 3;
      }
    },
    draw: (g, dpr) => {
      const t = performance.now() / 1000;
      g.globalCompositeOperation = cfg.blend === 'normal' ? 'source-over' : 'lighter';
      for (const j of js) {
        // the bell squeezes fast and relaxes slowly
        const q = j.ph < 0.25 ? j.ph / 0.25 : 1 - (j.ph - 0.25) / 0.75;
        const bw = j.s * (1 - 0.18 * q), bh = j.s * 0.62 * (1 + 0.16 * q);
        g.setTransform(dpr, 0, 0, dpr, 0, 0); g.translate(j.x, j.y); g.rotate(j.tilt);
        g.globalAlpha = 0.35; g.drawImage(halos[colors.indexOf(j.c)], -j.s * 1.6, -j.s * 1.4, j.s * 3.2, j.s * 3.2);
        // tentacles, waving in the wake
        g.lineCap = 'round';
        for (let i = 0; i < j.n; i++) {
          const fx = (i / (j.n - 1) - 0.5) * bw * 0.9, len = j.s * (1.3 + ((i * 7.3 + j.seed) % 1.1));
          g.strokeStyle = al(j.c, 0.32); g.lineWidth = 0.9; g.globalAlpha = 1;
          g.beginPath(); g.moveTo(fx, 0);
          for (let k = 1; k <= 12; k++) {
            const u = k / 12;
            g.lineTo(fx * (1 - u * 0.3) + Math.sin(t * 2.1 + u * 5 + i + j.seed) * j.s * 0.12 * u, u * len);
          }
          g.stroke();
        }
        // oral arms: two frilled ribbons down the middle
        for (let i = -1; i <= 1; i += 2) {
          g.strokeStyle = al(j.c, 0.45); g.lineWidth = 2.2;
          g.beginPath(); g.moveTo(i * bw * 0.08, 0);
          for (let k = 1; k <= 10; k++) { const u = k / 10; g.lineTo(i * bw * 0.08 + Math.sin(t * 1.6 + u * 4 + i) * j.s * 0.1 * u, u * j.s * 0.95); }
          g.stroke();
        }
        // the bell
        const bell = g.createRadialGradient(0, -bh * 0.5, 0, 0, -bh * 0.2, bw * 0.7);
        bell.addColorStop(0, al(j.c, 0.55)); bell.addColorStop(0.6, al(j.c, 0.18)); bell.addColorStop(1, al(j.c, 0.05));
        g.fillStyle = bell;
        g.beginPath(); g.ellipse(0, 0, bw / 2, bh, 0, Math.PI, TAU);
        g.quadraticCurveTo(0, bh * 0.22, -bw / 2, 0); g.fill();
        g.strokeStyle = al(j.c, 0.8); g.lineWidth = 1.2;
        g.beginPath(); g.ellipse(0, 0, bw / 2, bh, 0, Math.PI, TAU); g.stroke();
        // the glowing rim lights and a few gonads inside
        g.fillStyle = al('#ffffff', 0.5);
        for (let k = 0; k < 8; k++) { const a = Math.PI + (k + 0.5) / 8 * Math.PI; g.beginPath(); g.arc(Math.cos(a) * bw / 2, Math.sin(a) * bh * 0.08, 1.1, 0, TAU); g.fill(); }
        g.strokeStyle = al(j.c, 0.5); g.lineWidth = 1;
        for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse((k - 1.5) * bw * 0.12, -bh * 0.35, bw * 0.06, bh * 0.16, 0, 0, TAU); g.stroke(); }
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    },
    still: () => {},
  };
}

/** Dinoflagellates: blue sparks where something moves through the water (the pointer), and the odd spontaneous one. */
function plankton(cfg: { colors?: readonly string[] }): System {
  const sheets = okColors(cfg.colors, KINDS.plankton.colors).map(c => sprites(32, glow(c))[1]);
  let w = 0, h = 0;
  const ps: { x: number; y: number; life: number; max: number; s: number; v: number; vx: number; vy: number }[] = [];
  const add = (x: number, y: number) => { if (ps.length < 400) ps.push({ x, y, life: 0, max: rand(0.6, 1.6), s: rand(6, 18), v: Math.floor(Math.random() * sheets.length), vx: rand(-12, 12), vy: rand(-12, 12) }); };
  return {
    resize: (W, H) => { w = W; h = H; },
    step: (dt, env) => {
      const speed = Math.hypot(env.mvx, env.mvy);
      if (env.mx > -1e3 && speed > 40) for (let i = 0; i < Math.min(6, speed / 80); i++) add(env.mx + rand(-24, 24), env.my + rand(-24, 24));
      if (Math.random() < dt * 1.5) { const x = rand(0, w), y = rand(h * 0.2, h); for (let i = 0; i < 8; i++) add(x + rand(-30, 30), y + rand(-20, 20)); }
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]; p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96;
        if (p.life > p.max) ps.splice(i, 1);
      }
    },
    draw: (g) => {
      g.globalCompositeOperation = 'lighter';
      for (const p of ps) {
        const q = p.life / p.max; g.globalAlpha = (q < 0.15 ? q / 0.15 : 1 - (q - 0.15) / 0.85) * 0.9;
        g.drawImage(sheets[p.v], p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    },
    still: () => {},
  };
}

// ── aurora ───────────────────────────────────────────────────────────────────
/** Curtains of light: vertical rays along slowly folding bands, green at the foot, teal and violet up into the dark. */
function aurora(cfg: { colors?: readonly string[]; density?: number }): System {
  const [c0, c1, c2] = [...okColors(cfg.colors, ['#5dffb0', '#3fe0d0', '#b07cff']), '#3fe0d0', '#b07cff'];
  const strip = document.createElement('canvas');
  strip.width = 4; strip.height = 256;
  const sg = strip.getContext('2d')!, grad = sg.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0, al(c0, 0)); grad.addColorStop(0.03, al('#e8fff2', 0.9)); grad.addColorStop(0.07, al(c0, 0.95)); grad.addColorStop(0.2, al(c0, 0.6));
  grad.addColorStop(0.45, al(c1, 0.3)); grad.addColorStop(0.75, al(c2, 0.16)); grad.addColorStop(1, al(c2, 0));
  sg.fillStyle = grad; sg.fillRect(0, 0, 4, 256);
  const curtains = [
    { base: 0.34, amp: 0.06, l1: 380, l2: 170, s1: 0.06, s2: 0.09, hf: 0.32, from: -0.1, to: 0.75, k: 1 },
    { base: 0.26, amp: 0.05, l1: 300, l2: 140, s1: -0.05, s2: 0.07, hf: 0.26, from: 0.3, to: 1.1, k: 0.75 },
    { base: 0.42, amp: 0.04, l1: 520, l2: 210, s1: 0.04, s2: -0.06, hf: 0.2, from: 0.05, to: 0.95, k: 0.5 },
  ];
  let w = 0, h = 0, t = rand(0, 100);
  const intensity = Math.min(1.6, Math.max(0.3, cfg.density ?? 1));
  return {
    resize: (W, H) => { w = W; h = H; },
    step: dt => { t += dt; },
    draw: g => {
      g.globalCompositeOperation = 'lighter';
      const breathe = 0.75 + 0.25 * Math.sin(t * 0.09);
      for (const c of curtains) {
        const x0 = c.from * w, x1 = c.to * w;
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 3) {
          const u = (x - x0) / (x1 - x0), edge = Math.sin(Math.PI * u);  // fade at the curtain's ends
          const y = h * c.base + h * c.amp * Math.sin(x / c.l1 + t * c.s1 * 6) + h * c.amp * 0.6 * Math.sin(x / c.l2 - t * c.s2 * 6);
          const H = h * c.hf * (0.65 + 0.35 * Math.sin(x / 90 + t * 0.4));
          const rays = 0.72 + 0.28 * Math.sin(x / 9.1 + t * 0.9) * Math.sin(x / 31 - t * 0.5);
          const I = edge * rays * (0.6 + 0.4 * Math.sin(x / c.l2 * 2 + t * 0.25)) * c.k * breathe * intensity;
          if (I <= 0.02) continue;
          g.globalAlpha = Math.min(1, I * 0.6);
          g.drawImage(strip, x - 1, y - H, 6, H);
        }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    },
    still: () => {},
  };
}

/** The systems a config asks for, back to front. */
function systemsFor(cfg: AmbientConfig): System[] {
  const d = cfg.density;
  switch (cfg.kind) {
    case 'woodsprites': return [system('spores', { colors: cfg.extra, density: d, blend: cfg.blend }), system('woodsprites', cfg)];
    case 'rain': return [system('bokeh', { colors: cfg.extra, density: d, blend: cfg.blend }), rainOnGlass(cfg)];
    case 'abyss': return [system('marinesnow', { density: d }), jellyfish(cfg), plankton({ colors: cfg.extra })];
    case 'aurora': return [aurora(cfg), system('snow', { colors: cfg.extra, density: d })];
    case 'shallows': return [system('bubbles', { colors: cfg.extra, density: d }), jellyfish({ ...cfg, blend: 'normal' })];
    default: return [system(cfg.kind as SpriteKind, cfg)];
  }
}

/** Run a config's systems on a canvas until the returned stop() is called. The page's backdrop (Ambient below) and the
 *  screensaver's scenes (components/Screensaver.tsx) both use it. `always` keeps it drawing while Shell:B FM plays. */
export function runAmbient(cv: HTMLCanvasElement, cfg: AmbientConfig, opts: { always?: boolean } = {}): () => void {
  const ctx = cv.getContext('2d')!;
  const html = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const systems = systemsFor(cfg);
  const env: Env = { wind: 0, mx: -1e4, my: -1e4, mvx: 0, mvy: 0, t: 0 };
  let w = 0, h = 0, raf = 0, last = 0, gust = 0;
  let nextSync = performance.now() + rand(14e3, 26e3);

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // innerWidth/Height, not the element box: under the UI scale's CSS zoom the two disagree (see .dj-canvas)
    w = window.innerWidth; h = window.innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    systems.forEach(s => s.resize(w, h));
  };
  const draw = () => {
    const dpr = cv.width / (w || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    systems.forEach(s => s.draw(ctx, dpr));
  };
  const active = () => (opts.always || !html.classList.contains('dj-live')) && !document.hidden;

  const frame = (now: number) => {
    raf = 0;
    if (!active()) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); return; }
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; env.t += dt;
    // wind: a slow swell with an occasional gust
    if (Math.random() < dt / 9) gust = rand(25, 60) * (Math.random() < 0.7 ? 1 : -1);
    gust *= Math.pow(0.35, dt);
    env.wind = Math.sin(env.t * 0.21) * 10 + Math.sin(env.t * 0.53) * 5 + gust;
    env.mvx *= Math.pow(0.02, dt); env.mvy *= Math.pow(0.02, dt);
    if (now > nextSync) {
      nextSync = now + rand(22e3, 40e3);
      const ox = rand(0.2, 0.8) * w, oy = rand(0.5, 0.95) * h;
      systems.forEach(s => s.ripple?.(ox, oy));
    }
    systems.forEach(s => s.step(dt, env));
    draw();
    raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (reduce.matches) { draw(); return; }
    if (!raf && active()) { last = performance.now(); raf = requestAnimationFrame(frame); }
  };

  resize();
  if (reduce.matches) {
    systems.forEach(s => s.still());
    // procedural systems need a moment of simulation to look like anything
    for (let i = 0; i < 90; i++) systems.forEach(s => s.step(1 / 30, env));
  }
  wake();

  let lx = 0, ly = 0, lt = 0;
  const onMove = (e: PointerEvent) => {
    const t = performance.now(), dt = Math.max(16, t - lt) / 1000;
    if (lt && t - lt < 200) { env.mvx = (e.clientX - lx) / dt; env.mvy = (e.clientY - ly) / dt; }
    env.mvx = Math.max(-600, Math.min(600, env.mvx)); env.mvy = Math.max(-600, Math.min(600, env.mvy));
    lx = env.mx = e.clientX; ly = env.my = e.clientY; lt = t;
  };
  const onLeave = () => { env.mx = env.my = -1e4; };
  const onResize = () => { resize(); wake(); };
  const mo = new MutationObserver(wake);
  mo.observe(html, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', wake);
  reduce.addEventListener('change', wake);
  return () => {
    cancelAnimationFrame(raf); mo.disconnect();
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', wake);
    reduce.removeEventListener('change', wake);
  };
}

export function Ambient() {
  const [cfg, setCfg] = useState(ambientNow);
  const ref = useRef<HTMLCanvasElement>(null);
  const key = cfg ? JSON.stringify(cfg) : '';

  // follow theme and mode changes
  useEffect(() => {
    const update = () => setCfg(c => { const n = ambientNow(); return JSON.stringify(n) === JSON.stringify(c) ? c : n; });
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin', 'data-custom'] });
    window.addEventListener('shellb:themes', update);
    return () => { mo.disconnect(); window.removeEventListener('shellb:themes', update); };
  }, []);

  useEffect(() => (cfg ? runAmbient(ref.current!, cfg) : undefined), [key]);  // eslint-disable-line react-hooks/exhaustive-deps

  return cfg ? <canvas key={key} ref={ref} className="shellb-ambient" data-kind={cfg.kind} aria-hidden /> : null;
}
