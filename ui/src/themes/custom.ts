// Custom themes: designed by Shell:B in chat (server/themes.py, the design_theme tool) and stored on the server as data,
// never CSS. This turns one into a stylesheet scoped to html[data-skin='custom'], injected as a <style> by setTheme.
// The server already validated everything; colours and numbers are checked again here because the result lands in a
// stylesheet, and the cached copy in localStorage could have been edited by hand.
import type { AmbientKind } from './Ambient';
import forest from './scenery/normandy-treeline.svg?url';
import mountains from './scenery/mountains.svg?url';
import floating from './scenery/pandora-isles.svg?url';
import waves from './scenery/waves.svg?url';
import city from './scenery/city.svg?url';
import seafloor from './scenery/seafloor.svg?url';
import dunes from './scenery/dunes.svg?url';
import snowpines from './scenery/snowpines.svg?url';
import hills from './scenery/hills.svg?url';

export interface CustomTheme {
  id: string; name: string; blurb: string; mode: 'dark' | 'light';
  palette: Record<'bg' | 'panel' | 'raised' | 'hover' | 'code' | 'text' | 'text2' | 'muted' | 'accent' | 'accentText' | 'brand' | 'line', string>
    & { accentSoft?: string; inks: string[] };
  fonts: { display: string; body: string }; caps: boolean; tracking: number; shape: 'soft' | 'hard' | 'round';
  backdrop: { sky: string[]; glows: { x: number; y: number; size: number; strength: number; color: string }[]; stars: number;
    horizon: 'none' | 'forest' | 'mountains' | 'floating' | 'waves' | 'city' | 'seafloor' | 'dunes' | 'snowpines' | 'hills'; horizonColor: string };
  particles: { kind: AmbientKind | 'none'; colors: string[]; density: number };
  created?: number; updated?: number;
}

export const FONT_STACKS: Record<string, string> = {
  'inter': "'Inter Variable', Inter, system-ui, sans-serif",
  'barlow': "'Barlow', 'Inter Variable', sans-serif",
  'barlow-condensed': "'Barlow Condensed', 'Barlow', 'Inter Variable', sans-serif",
  'shippori-mincho': "'Shippori Mincho', Georgia, serif",
  'josefin-sans': "'Josefin Sans', 'Inter Variable', sans-serif",
  'jetbrains-mono': "'JetBrains Mono Variable', ui-monospace, monospace",
  'georgia': "Georgia, 'Times New Roman', serif",
  'cormorant-garamond': "'Cormorant Garamond', Georgia, serif",
  'sora': "'Sora', 'Inter Variable', sans-serif",
  'syncopate': "'Syncopate', 'Barlow', sans-serif",
  'outfit': "'Outfit', 'Inter Variable', sans-serif",
  'zen-maru-gothic': "'Zen Maru Gothic', 'Inter Variable', sans-serif",
};
const HORIZON: Record<string, [string, number]> = {
  forest: [forest, 150], mountains: [mountains, 300], floating: [floating, 760], waves: [waves, 200],
  city: [city, 420], seafloor: [seafloor, 260], dunes: [dunes, 360], snowpines: [snowpines, 260], hills: [hills, 420],
};

const hex = (v: unknown, d = '#000000') => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** #rrggbb plus an alpha 0–1, as #rrggbbaa */
const a = (c: string, alpha: number) => c + Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');

export function customCss(t: CustomTheme): string {
  const p = t.palette, dark = t.mode !== 'light';
  const S = `html.${dark ? 'dark' : 'light'}[data-skin='custom']`;
  const c = {
    bg: hex(p.bg), panel: hex(p.panel), raised: hex(p.raised), hover: hex(p.hover), code: hex(p.code), text: hex(p.text, '#eeeeee'),
    text2: hex(p.text2, '#aaaaaa'), muted: hex(p.muted, '#888888'), accent: hex(p.accent, '#d9774a'), accentText: hex(p.accentText, '#111111'),
    accentSoft: hex(p.accentSoft ?? p.accent, '#d9774a'), brand: hex(p.brand, '#8b9cff'), line: hex(p.line, dark ? '#ffffff' : '#000000'),
  };
  const inks = (p.inks ?? []).map(i => hex(i, '')).filter(Boolean);
  const display = FONT_STACKS[t.fonts?.display] ?? FONT_STACKS.inter, body = FONT_STACKS[t.fonts?.body] ?? FONT_STACKS.inter;
  const track = num(t.tracking, -0.02, 0.24, 0), caps = t.caps ? 'uppercase' : 'none';
  const b = t.backdrop ?? { sky: [], glows: [], stars: 0, horizon: 'none', horizonColor: '#000000' };
  const sky = (b.sky ?? []).map(s => hex(s, '')).filter(Boolean);
  const layers: string[] = [];
  const stars = num(b.stars, 0, 1, 0);
  if (stars > 0) {
    const tiles: [number, number, number, number][] = [[20, 30, 223, 199], [140, 90, 271, 239], [70, 160, 313, 281], [40, 20, 97, 113], [10, 60, 151, 173]];
    tiles.slice(0, 1 + Math.round(stars * 4)).forEach(([x, y, w, h], i) =>
      layers.push(`radial-gradient(1px 1px at ${x}px ${y}px, rgba(255,255,255,${(0.25 + stars * 0.35 - i * 0.04).toFixed(2)}), transparent 60%) 0 0 / ${w}px ${h}px`));
  }
  for (const g of (b.glows ?? []).slice(0, 4)) {
    const s = num(g.size, 10, 100, 50);
    layers.push(`radial-gradient(ellipse ${s}% ${s * 0.75}% at ${num(g.x, 0, 100, 50)}% ${num(g.y, 0, 100, 50)}%, ${a(hex(g.color, '#ffffff'), num(g.strength, 0.02, 0.5, 0.14))}, transparent 70%)`);
  }
  layers.push(sky.length > 1 ? `linear-gradient(180deg, ${sky.join(', ')})` : (sky[0] ?? c.bg));
  const horizon = HORIZON[b.horizon];
  const shape = t.shape === 'hard'
    ? `${S} :where([class*='rounded-md'], [class*='rounded-lg'], [class*='rounded-xl'], [class*='rounded-2xl'], [class*='rounded-3xl']) { border-radius: 2px !important; }
${S} [class~='bg-[var(--accent)]'] { border-radius: 0 !important; clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%); }`
    : t.shape === 'round'
      ? `${S} :where([class*='rounded-lg'], [class*='rounded-xl'], [class*='rounded-2xl']) { border-radius: 16px !important; }
${S} :where(button[class*='rounded-md'], button[class*='rounded-lg']) { border-radius: 999px !important; }
${S} .sf-composer { border-radius: 24px !important; }`
      : '';
  return `/* custom theme: ${t.name.replace(/[^\w\s-]/g, '')} */
${S} {
  --bg-primary: ${c.bg}; --bg-secondary: ${c.panel}; --bg-tertiary: ${c.raised}; --bg-hover: ${c.hover}; --bg-code: ${c.code};
  --border-subtle: ${a(c.line, dark ? 0.1 : 0.1)}; --border-strong: ${a(c.line, dark ? 0.22 : 0.2)};
  --text-primary: ${c.text}; --text-secondary: ${c.text2}; --text-muted: ${c.muted};
  --accent: ${c.accent}; --accent-fg: ${c.accentText}; --accent-soft: ${c.accentSoft}; --accent-glow: ${a(c.accent, 0.35)};
  --brand: ${c.brand}; --brand-soft: ${c.brand}; --neon-pink: ${inks[1] ?? c.accent}; --neon-cyan: ${inks[2] ?? c.brand};
  --sunset: linear-gradient(100deg, ${(inks.length > 1 ? inks : [c.accent, c.accentSoft]).join(', ')});
  --focus-ring: ${c.accent};
  color-scheme: ${dark ? 'dark' : 'light'};
}
${S} body { font-family: ${body}; background: ${layers.join(',\n    ')}; background-attachment: fixed; }
${S} :is(.prose-shellb h1, .prose-shellb h2, .prose-shellb h3, .sf-hero h1, h1[class*='tracking-tight'], .sf-brand) {
  font-family: ${display}; text-transform: ${caps}; letter-spacing: ${track}em;
}
${S} .sf-hero h1 { font-size: clamp(1.9rem, 4vw, 2.9rem); font-weight: 600; line-height: 1.1; }
${S} .prose-shellb a { color: ${c.accentSoft}; }
${S} .prose-shellb li::marker { color: ${c.accent}; }
${S} ::selection { background: ${a(c.accent, 0.35)}; }
${S} .sf-sidebar { background: ${a(c.panel, 0.9)}; backdrop-filter: blur(8px); }
${S} .sf-topbar, ${S} header.h-12 { background: ${a(c.bg, 0.7)}; backdrop-filter: blur(6px); position: relative; z-index: 1; }
${S} .sf-card { background-color: ${a(c.panel, 0.86)} !important; backdrop-filter: blur(6px); }
${S} .sf-composer { position: relative; z-index: 20; background: ${a(c.panel, 0.92)} !important; backdrop-filter: blur(12px); }
${S} [class~='bg-[var(--accent)]'] { background-image: var(--sunset); }
${S} [class~='bg-[var(--accent)]']:disabled { background-image: none; }
${shape}
${horizon ? `${S} body::after {
  content: ''; position: fixed; left: 0; right: 0; bottom: 0; height: ${b.horizon === 'floating' ? '70vh' : '240px'}; pointer-events: none; z-index: -2;
  background: ${hex(b.horizonColor)};
  -webkit-mask: url("${horizon[0]}") repeat-x ${b.horizon === 'floating' ? 'center' : 'left'} bottom / ${b.horizon === 'floating' ? 'auto 100%' : `1600px ${Math.min(240, horizon[1])}px`};
  mask: url("${horizon[0]}") repeat-x ${b.horizon === 'floating' ? 'center' : 'left'} bottom / ${b.horizon === 'floating' ? 'auto 100%' : `1600px ${Math.min(240, horizon[1])}px`};
}
${S}:not(:has(.sf-hero)) body::after { opacity: 0.55; }` : ''}
`;
}
