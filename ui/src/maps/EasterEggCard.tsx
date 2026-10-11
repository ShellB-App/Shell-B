// Cards for the Worlds easter eggs (./eastereggs.ts). Rapture gets the full treatment: an Art Deco card in brass and
// deep teal, and a bathysphere descent (BathysphereDescent) that drops through darkening water, past a whale, to the
// city's lit towers and its sign, with an optional sound bed made in WebAudio (no recordings). R'lyeh gets a quieter,
// stranger card. Every card can open the real sea floor under the spot in the dive view.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compass, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { getLocale, t } from '../i18n';
import { fmtCoord } from './core';
import { eggBlurb, type EasterEgg } from './eastereggs';

const fr = () => getLocale() === 'fr';

const DECO_CSS = `
@font-face { font-family: 'SB Deco'; font-weight: 600; font-display: swap; src: url('/fonts/josefin-sans-latin-600-normal.woff2') format('woff2'); }
@font-face { font-family: 'SB Deco'; font-weight: 300; font-display: swap; src: url('/fonts/josefin-sans-latin-300-normal.woff2') format('woff2'); }
.sb-deco { --brass: #d9b45a; --brass-soft: #f1d891; --sea: #041821; font-family: 'SB Deco', 'Josefin Sans', system-ui, sans-serif; }
.sb-deco-title { font-weight: 600; letter-spacing: 0.32em; text-transform: uppercase; color: var(--brass-soft);
  text-shadow: 0 0 12px rgba(241, 216, 145, 0.45); }
.sb-deco-rule { height: 10px; background:
  linear-gradient(var(--brass), var(--brass)) center 4px / 100% 1px no-repeat,
  linear-gradient(var(--brass), var(--brass)) center 7px / 70% 1px no-repeat,
  radial-gradient(circle, var(--brass) 2px, transparent 2.5px) center / 10px 10px no-repeat; }
.sb-deco-fan { background: repeating-conic-gradient(from 270deg at 50% 100%, rgba(217,180,90,0.16) 0deg 4deg, transparent 4deg 9deg); }
.sb-deco-btn { border: 1px solid var(--brass); color: var(--brass-soft); letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; }
.sb-deco-btn:hover { background: rgba(217, 180, 90, 0.16); }
@keyframes sb-bubble { from { transform: translateY(0) translateX(0); opacity: 0; } 10% { opacity: .8; } to { transform: translateY(-110vh) translateX(var(--dx, 12px)); opacity: 0; } }
@keyframes sb-whale { from { transform: translateX(-40%) translateY(0); } 50% { transform: translateX(60%) translateY(-14px); } to { transform: translateX(160%) translateY(4px); } }
@keyframes sb-flicker { 0%, 100% { opacity: 1; } 47% { opacity: .95; } 48% { opacity: .35; } 50% { opacity: 1; } 82% { opacity: .85; } }
@keyframes sb-rise { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes sb-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes sb-shaft { 0%, 100% { opacity: .18; } 50% { opacity: .32; } }
@keyframes sb-sway { 0%, 100% { transform: rotate(-0.6deg); } 50% { transform: rotate(0.6deg); } }
@media (prefers-reduced-motion: reduce) { .sb-deco * { animation-duration: 0.01s !important; animation-iteration-count: 1 !important; } }
`;

function DecoStyle() { return <style>{DECO_CSS}</style>; }

interface CardProps {
  egg: EasterEgg;
  onClose: () => void;
  onFlyTo: () => void;
  /** opens the dive view on the real sea floor here */
  onDive?: () => void;
}

export function EasterEggCard(props: CardProps) {
  return props.egg.id === 'rapture' ? <RaptureCard {...props} /> : <EerieCard {...props} />;
}

// ── Rapture ───────────────────────────────────────────────────────────────

const DISTRICTS = [
  ['Welcome Center', 'Le Centre d’accueil'], ['Medical Pavilion', 'Le Pavillon médical'], ['Neptune’s Bounty', 'Neptune’s Bounty, le port de pêche'],
  ['Arcadia', 'Arcadia, la forêt sous verre'], ['Fort Frolic', 'Fort Frolic, les arts et le théâtre'], ['Hephaestus', 'Hephaestus, la géothermie'],
  ['Point Prometheus', 'Point Prometheus'], ['Apollo Square', 'Apollo Square'], ['Olympus Heights', 'Olympus Heights'],
];

const LORE_EN = [
  'In 1946 the industrialist Andrew Ryan began building a city on the floor of the North Atlantic, out of reach of governments, churches and taxes: a place where the great would not be constrained by the small.',
  'Its people found ADAM in a sea slug, a substance that rewrites the body, and sold it as plasmids. By New Year’s Eve 1958 the city had turned on itself. Big Daddies in diving suits now walk the corridors guarding the Little Sisters.',
  'In 1960 a plane goes down beside the lighthouse, and its one survivor swims to the door.',
];
const LORE_FR = [
  'En 1946, l’industriel Andrew Ryan commence à bâtir une cité au fond de l’Atlantique Nord, hors de portée des gouvernements, des Églises et de l’impôt : un lieu où les grands ne seraient plus entravés par les petits.',
  'Ses habitants découvrent l’ADAM dans une limace de mer, une substance qui réécrit le corps, et la vendent sous forme de plasmides. Au réveillon de 1958, la cité se retourne contre elle-même. Des Protecteurs en scaphandre arpentent désormais les couloirs pour veiller sur les Petites Sœurs.',
  'En 1960, un avion s’abîme près du phare, et son unique survivant nage jusqu’à la porte.',
];

function RaptureCard({ egg, onClose, onFlyTo, onDive }: CardProps) {
  const [descending, setDescending] = useState(false);
  return (
    <>
      <DecoStyle />
      <div className="sb-deco relative w-[340px] max-w-full overflow-hidden rounded-md border text-[12.5px] leading-relaxed shadow-2xl"
        style={{ background: 'linear-gradient(180deg, #072430, #041821 60%, #030f15)', borderColor: '#d9b45a', color: '#e9dfc4' }}>
        <div className="sb-deco-fan absolute inset-x-0 top-0 h-28 pointer-events-none" />
        <button onClick={onClose} title={t('Close')} className="absolute z-10 top-2 right-2 p-1 rounded text-[#f1d891]/70 hover:text-[#f1d891]"><X className="w-4 h-4" /></button>
        <div className="relative px-5 pt-5 pb-4 text-center">
          <div className="text-[10px] tracking-[0.3em] uppercase text-[#d9b45a]/80">{t('Secret found')} · {egg.source}</div>
          <div className="sb-deco-title text-[26px] mt-2">Rapture</div>
          <div className="sb-deco-rule my-2.5" />
          <div className="italic text-[13px] text-[#f1d891]">“{fr() ? 'Ni dieux ni rois. Seulement l’Homme.' : 'No gods or kings. Only man.'}”</div>
          <div className="text-[10.5px] mt-1 text-[#e9dfc4]/60">{fmtCoord(egg.lat, egg.lon)}</div>
        </div>
        <div className="relative px-5 pb-3 space-y-2">
          <p>{eggBlurb(egg)}</p>
          {(fr() ? LORE_FR : LORE_EN).map(p => <p key={p.slice(0, 20)} className="text-[#e9dfc4]/85">{p}</p>)}
          <div className="pt-1">
            <div className="text-[10px] tracking-[0.25em] uppercase text-[#d9b45a] mb-1">{t('Districts')}</div>
            <div className="flex flex-wrap gap-1">
              {DISTRICTS.map(([en, f]) => <span key={en} className="px-1.5 py-0.5 rounded-sm border border-[#d9b45a]/35 text-[11px]">{fr() ? f : en}</span>)}
            </div>
          </div>
          <p className="text-[11px] text-[#e9dfc4]/55 pt-1">{fr()
            ? 'Le vrai fond ici est la dorsale de Reykjanes et le bassin d’Irminger, vers 1 500 à 2 000 m. L’épave du HMS Hood repose à 120 km au nord-ouest.'
            : 'The real sea floor here is the Reykjanes Ridge and the Irminger Basin, around 1,500–2,000 m down. The wreck of HMS Hood lies 120 km to the north-west.'}</p>
        </div>
        <div className="relative px-5 pb-5 pt-1 flex flex-col gap-1.5">
          <button className="sb-deco-btn rounded-sm py-2 text-[12px]" onClick={() => setDescending(true)}>{t('Descend in the bathysphere')}</button>
          <div className="flex gap-1.5">
            <button className="sb-deco-btn flex-1 rounded-sm py-1.5 text-[10.5px] flex items-center justify-center gap-1" onClick={onFlyTo}><Compass className="w-3.5 h-3.5" />{t('The lighthouse')}</button>
            {onDive && <button className="sb-deco-btn flex-1 rounded-sm py-1.5 text-[10.5px] flex items-center justify-center gap-1" onClick={onDive}><Waves className="w-3.5 h-3.5" />{t('Real sea floor')}</button>}
          </div>
        </div>
      </div>
      {descending && <BathysphereDescent depthM={egg.depthM ?? 1700} onClose={() => setDescending(false)} onDive={onDive && (() => { setDescending(false); onDive(); })} />}
    </>
  );
}

/** Low rumble of the sea, bubbles past the glass, and now and then a whale. Returns the stop function. */
function seaSound(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2);
  master.connect(ctx.destination);
  // brown noise through a low-pass: the water
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
  const ng = ctx.createGain(); ng.gain.value = 0.22;
  noise.connect(lp).connect(ng).connect(master); noise.start();
  const timers: number[] = [];
  const bubble = () => {
    const now = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    const f = 280 + Math.random() * 500;
    o.frequency.setValueAtTime(f, now); o.frequency.exponentialRampToValueAtTime(f * 2.4, now + 0.07);
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.05, now + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    o.connect(g).connect(master); o.start(now); o.stop(now + 0.1);
    timers.push(window.setTimeout(bubble, 180 + Math.random() * 1100));
  };
  const whale = () => {
    const now = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, now); o.frequency.linearRampToValueAtTime(210, now + 1.2); o.frequency.linearRampToValueAtTime(95, now + 3.2);
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.06, now + 0.6); g.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
    o.connect(g).connect(master); o.start(now); o.stop(now + 3.5);
    timers.push(window.setTimeout(whale, 9000 + Math.random() * 8000));
  };
  bubble();
  timers.push(window.setTimeout(whale, 6500));
  return () => {
    timers.forEach(clearTimeout);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    window.setTimeout(() => ctx.close().catch(() => {}), 700);
  };
}

/** Art Deco towers of the skyline: x, width, height, crown style. Drawn in a 1000×420 box, sea floor at y 420. */
const TOWERS: [number, number, number, 'step' | 'spire' | 'dome' | 'fan'][] = [
  [30, 70, 170, 'step'], [115, 50, 240, 'spire'], [180, 90, 150, 'dome'], [290, 60, 300, 'fan'], [365, 80, 210, 'step'],
  [460, 110, 360, 'spire'], [590, 70, 230, 'fan'], [675, 55, 280, 'step'], [745, 95, 180, 'dome'], [855, 60, 250, 'spire'], [925, 65, 160, 'step'],
];

function Tower({ x, w, h, crown, seed }: { x: number; w: number; h: number; crown: string; seed: number }) {
  const top = 420 - h;
  const wins: { x: number; y: number; on: boolean; d: number }[] = [];
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let y = top + 22; y < 410; y += 14) for (let wx = x + 7; wx < x + w - 8; wx += 11) wins.push({ x: wx, y, on: rnd() > 0.35, d: rnd() * 6 });
  return (
    <g>
      {crown === 'step' && <path d={`M${x + w * 0.2} ${top} h${w * 0.6} v-14 h-${w * 0.14} v-12 h-${w * 0.32} v12 h-${w * 0.14} z`} fill="#0b2f3b" />}
      {crown === 'spire' && <path d={`M${x + w * 0.3} ${top} L${x + w / 2} ${top - 70} L${x + w * 0.7} ${top} z`} fill="#0b2f3b" />}
      {crown === 'spire' && <circle cx={x + w / 2} cy={top - 70} r="2.5" fill="#ff6b5a" style={{ animation: 'sb-flicker 2.4s infinite' }} />}
      {crown === 'dome' && <path d={`M${x + 6} ${top} a${w / 2 - 6} ${w / 2 - 14} 0 0 1 ${w - 12} 0 z`} fill="rgba(120,220,230,0.18)" stroke="#2aa3b0" strokeWidth="1.2" />}
      {crown === 'fan' && <path d={`M${x} ${top} a${w / 2} ${w / 2} 0 0 1 ${w} 0 z`} fill="#0b2f3b" />}
      {crown === 'fan' && [0, 1, 2, 3, 4].map(i => <line key={i} x1={x + w / 2} y1={top} x2={x + w / 2 + Math.cos(Math.PI * (1 + (i + 0.5) / 5)) * w / 2.2} y2={top + Math.sin(Math.PI * (1 + (i + 0.5) / 5)) * w / 2.2} stroke="#d9b45a" strokeWidth="1" opacity=".7" />)}
      <rect x={x} y={top} width={w} height={h} fill="#0b2f3b" />
      <rect x={x} y={top} width={w} height={h} fill="url(#sb-tower-shade)" />
      <line x1={x + 3} y1={top + 6} x2={x + 3} y2={420} stroke="#d9b45a" strokeWidth=".8" opacity=".35" />
      <line x1={x + w - 3} y1={top + 6} x2={x + w - 3} y2={420} stroke="#d9b45a" strokeWidth=".8" opacity=".35" />
      {wins.map((p, i) => p.on && <rect key={i} x={p.x} y={p.y} width="5" height="7" fill="#ffd27a" opacity=".85"
        style={i % 7 === 0 ? { animation: `sb-flicker ${3 + p.d}s ${p.d}s infinite` } : undefined} />)}
    </g>
  );
}

function BathysphereDescent({ depthM, onClose, onDive }: { depthM: number; onClose: () => void; onDive?: () => void }) {
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DESCENT_MS = reduced ? 0 : 13000;
  const [phase, setPhase] = useState<'banner' | 'down' | 'city'>(reduced ? 'city' : 'banner');
  const [depth, setDepth] = useState(reduced ? depthM : 0);
  const [sound, setSound] = useState(!reduced);
  const stopSound = useRef<(() => void) | null>(null);
  const skipped = useRef(false);

  useEffect(() => {
    if (reduced) return;
    const t1 = window.setTimeout(() => { if (!skipped.current) setPhase('down'); }, 3200);
    let raf = 0, start = 0;
    const tick = (now: number) => {
      if (skipped.current) return;
      if (!start) start = now;
      const k = Math.min(1, (now - start) / DESCENT_MS);
      setDepth(Math.round(depthM * (1 - Math.pow(1 - k, 2.2))));
      if (k < 1) raf = requestAnimationFrame(tick); else setPhase('city');
    };
    const t2 = window.setTimeout(() => { raf = requestAnimationFrame(tick); }, 3200);
    return () => { clearTimeout(t1); clearTimeout(t2); cancelAnimationFrame(raf); };
  }, [depthM, DESCENT_MS, reduced]);

  useEffect(() => {
    if (sound) stopSound.current = seaSound();
    return () => { stopSound.current?.(); stopSound.current = null; };
  }, [sound]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const k = depth / depthM;
  const water = `linear-gradient(180deg, hsl(192 70% ${Math.max(3, 30 - k * 27)}%), hsl(200 80% ${Math.max(2, 14 - k * 12)}%))`;
  const feet = Math.round(depth * 3.28084);
  const bubbles = useRef(Array.from({ length: 26 }, (_, i) => ({ left: Math.random() * 100, size: 3 + Math.random() * 9, dur: 4 + Math.random() * 6, delay: -Math.random() * 10, dx: (Math.random() - 0.5) * 60, i })));

  return createPortal(
    <div className="sb-deco fixed inset-0 z-[300] flex flex-col items-center justify-center select-none" style={{ background: '#010608' }} role="dialog" aria-label="Rapture">
      <DecoStyle />
      {phase === 'banner' && (
        <div className="text-center px-6" style={{ animation: 'sb-fade 1.2s ease-out both' }}>
          <div className="sb-deco-fan mx-auto w-72 h-36 rounded-t-full" />
          <div className="sb-deco-title text-[clamp(20px,4vw,40px)] -mt-10">{fr() ? 'Ni dieux ni rois.' : 'No gods or kings.'}</div>
          <div className="sb-deco-title text-[clamp(20px,4vw,40px)] mt-1" style={{ animation: 'sb-fade 1s 1s ease-out both' }}>{fr() ? 'Seulement l’Homme.' : 'Only man.'}</div>
          <div className="sb-deco-rule w-72 mx-auto mt-4" />
        </div>
      )}

      {phase !== 'banner' && (
        <div className="relative w-[min(90vw,78vh,720px)] aspect-square" style={{ animation: 'sb-fade 1.4s ease-out both' }}>
          {/* the view through the porthole */}
          <div className="absolute inset-[6%] rounded-full overflow-hidden" style={{ background: water, transition: 'background 300ms linear', animation: 'sb-sway 7s ease-in-out infinite' }}>
            {[18, 42, 66].map((l, i) => (
              <div key={l} className="absolute -top-10 h-[120%] w-[14%]" style={{ left: `${l}%`, transform: 'skewX(-12deg)', opacity: Math.max(0, 0.3 - k * 0.5),
                background: 'linear-gradient(180deg, rgba(190,240,255,0.5), transparent 75%)', animation: `sb-shaft ${5 + i}s ease-in-out infinite` }} />
            ))}
            {phase === 'down' && k > 0.35 && k < 0.85 && (
              <svg viewBox="0 0 300 90" className="absolute top-[22%] left-0 w-[70%] opacity-70" style={{ animation: 'sb-whale 9s linear both' }}>
                <path d="M10 48 C40 20 120 18 190 30 C230 36 256 44 270 40 L296 22 L288 48 L298 70 L268 56 C240 66 190 72 130 70 C80 68 30 66 10 48 Z" fill="#06202a" />
                <path d="M120 66 L140 86 L150 66 Z" fill="#06202a" />
              </svg>
            )}
            {phase === 'city' && (
              <svg viewBox="0 0 1000 520" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 w-full h-full" style={{ animation: 'sb-rise 2.4s ease-out both' }}>
                <defs>
                  <linearGradient id="sb-tower-shade" x1="0" x2="1"><stop offset="0" stopColor="#000" stopOpacity=".35" /><stop offset=".5" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".45" /></linearGradient>
                  <radialGradient id="sb-city-glow" cx=".5" cy="1" r=".7"><stop offset="0" stopColor="#ffcf7a" stopOpacity=".28" /><stop offset="1" stopColor="#ffcf7a" stopOpacity="0" /></radialGradient>
                </defs>
                <rect x="0" y="100" width="1000" height="420" fill="url(#sb-city-glow)" />
                <g transform="translate(0 100)">
                  {TOWERS.map(([x, w, h, c], i) => <Tower key={i} x={x} w={w} h={h} crown={c} seed={i + 1} />)}
                  {/* glass tunnels between towers */}
                  <path d="M100 300 Q140 280 180 300 M270 320 Q330 290 365 310 M570 260 Q600 240 630 262 M820 300 Q840 280 860 290" stroke="rgba(140,230,240,.45)" strokeWidth="6" fill="none" />
                  <rect x="0" y="410" width="1000" height="20" fill="#03141b" />
                  {/* the sign */}
                  <g style={{ animation: 'sb-flicker 5s 1s infinite' }}>
                    <rect x="372" y="78" width="256" height="58" rx="4" fill="#041821" stroke="#d9b45a" strokeWidth="2" />
                    <text x="500" y="118" textAnchor="middle" fontFamily="'SB Deco', 'Josefin Sans', sans-serif" fontWeight="600" fontSize="34" letterSpacing="10" fill="#f1d891"
                      style={{ filter: 'drop-shadow(0 0 6px rgba(241,216,145,.9))' }}>RAPTURE</text>
                  </g>
                </g>
              </svg>
            )}
            {bubbles.current.map(b => (
              <span key={b.i} className="absolute bottom-[-20px] rounded-full border border-white/40" style={{
                left: `${b.left}%`, width: b.size, height: b.size, background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,.55), rgba(255,255,255,.06))',
                ['--dx' as string]: `${b.dx}px`, animation: `sb-bubble ${b.dur}s ${b.delay}s linear infinite`,
              }} />
            ))}
            <div className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 0 80px 30px rgba(0,0,0,.75)' }} />
          </div>
          {/* brass rim and rivets */}
          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none">
            <defs><linearGradient id="sb-brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f1d891" /><stop offset=".45" stopColor="#a8822f" /><stop offset="1" stopColor="#5a4316" /></linearGradient></defs>
            <circle cx="50" cy="50" r="46.5" fill="none" stroke="url(#sb-brass)" strokeWidth="6" />
            <circle cx="50" cy="50" r="43.4" fill="none" stroke="#2b1f08" strokeWidth=".6" />
            {Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return <circle key={i} cx={50 + Math.cos(a) * 46.5} cy={50 + Math.sin(a) * 46.5} r="1" fill="#3a2a0c" stroke="#f1d891" strokeWidth=".25" />; })}
          </svg>
          {/* depth gauge */}
          <div className="absolute left-1/2 -translate-x-1/2 bottom-[-4%] px-4 py-1.5 rounded-sm border text-center" style={{ background: '#0a0703', borderColor: '#d9b45a' }}>
            <div className="text-[9px] tracking-[0.3em] uppercase text-[#d9b45a]">{t('Depth')}</div>
            <div className="font-mono tabular-nums text-[18px] text-[#f1d891]">{depth.toLocaleString()} m · {feet.toLocaleString()} ft</div>
          </div>
          {phase === 'city' && (
            <div className="absolute inset-x-0 top-[-7%] text-center" style={{ animation: 'sb-rise 1.6s .8s ease-out both' }}>
              <div className="sb-deco-title text-[clamp(16px,3vw,26px)] whitespace-nowrap">{fr() ? 'Bienvenue à Rapture' : 'Welcome to Rapture'}</div>
            </div>
          )}
        </div>
      )}

      <div className="absolute top-3 right-3 flex gap-1.5">
        <button className="sb-deco-btn rounded-sm p-1.5" title={sound ? t('Sound off') : t('Sound on')} onClick={() => setSound(s => !s)}>{sound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}</button>
        <button className="sb-deco-btn rounded-sm p-1.5" title={t('Surface')} onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      {phase === 'city' && (
        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-2" style={{ animation: 'sb-fade 1s 2s ease-out both' }}>
          <button className="sb-deco-btn rounded-sm px-4 py-1.5 text-[11px]" onClick={onClose}>{t('Surface')}</button>
          {onDive && <button className="sb-deco-btn rounded-sm px-4 py-1.5 text-[11px]" onClick={onDive}>{t('Real sea floor')}</button>}
        </div>
      )}
      {phase !== 'city' && <button className="absolute bottom-4 right-4 text-[10px] tracking-[0.2em] uppercase text-[#d9b45a]/60 hover:text-[#d9b45a]" onClick={() => { skipped.current = true; setPhase('city'); setDepth(depthM); }}>{t('Skip')}</button>}
    </div>,
    document.body,
  );
}

// ── R'lyeh and any other egg ──────────────────────────────────────────────

function EerieCard({ egg, onClose, onFlyTo, onDive }: CardProps) {
  const rlyeh = egg.id === 'rlyeh';
  return (
    <div className="relative w-[330px] max-w-full overflow-hidden rounded-xl border text-[12.5px] leading-relaxed shadow-2xl"
      style={{ background: 'radial-gradient(120% 80% at 50% 0%, #0d2b27, #050d0c 70%)', borderColor: `${egg.color}66`, color: '#cfe9e3' }}>
      <button onClick={onClose} title={t('Close')} className="absolute z-10 top-2 right-2 p-1 rounded text-white/50 hover:text-white"><X className="w-4 h-4" /></button>
      <div className="px-5 pt-5 pb-3 text-center">
        <div className="text-[10px] tracking-[0.25em] uppercase opacity-70">{t('Secret found')} · {egg.source}</div>
        <div className="text-[24px] mt-1.5 font-semibold" style={{ color: egg.color, fontFamily: "'Cormorant Garamond', Georgia, serif", textShadow: `0 0 18px ${egg.color}88` }}>{egg.name}</div>
        <div className="text-[10.5px] opacity-60">{fmtCoord(egg.lat, egg.lon)}</div>
      </div>
      <div className="px-5 pb-3 space-y-2">
        <p>{eggBlurb(egg)}</p>
        {rlyeh && <>
          <p className="italic text-center opacity-90" style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 15, animation: 'sb-flicker 6s infinite' }}>
            Ph’nglui mglw’nafh Cthulhu R’lyeh wgah’nagl fhtagn.</p>
          <p className="text-center text-[11px] opacity-70">{fr() ? '« Dans sa demeure de R’lyeh, Cthulhu mort attend en rêvant. »' : '“In his house at R’lyeh dead Cthulhu waits dreaming.”'}</p>
          <p className="text-[11px] opacity-60">{fr()
            ? 'Clin d’œil réel : en 1997, les hydrophones de la NOAA ont capté à quelque 2 000 km d’ici « the Bloop », un son immense et inexpliqué… qui venait, on l’a su plus tard, de la glace antarctique qui se brise.'
            : 'A real coincidence: in 1997 NOAA hydrophones picked up “the Bloop” some 2,000 km from here, a huge unexplained sound… later traced to Antarctic ice breaking up.'}</p>
        </>}
      </div>
      <style>{DECO_CSS}</style>
      <div className="px-5 pb-5 flex gap-1.5">
        <button className="flex-1 rounded-lg border py-1.5 text-[11px] flex items-center justify-center gap-1 hover:bg-white/5" style={{ borderColor: `${egg.color}66` }} onClick={onFlyTo}><Compass className="w-3.5 h-3.5" />{t('Go there')}</button>
        {onDive && <button className="flex-1 rounded-lg border py-1.5 text-[11px] flex items-center justify-center gap-1 hover:bg-white/5" style={{ borderColor: `${egg.color}66` }} onClick={onDive}><Waves className="w-3.5 h-3.5" />{t('Real sea floor')}</button>}
      </div>
    </div>
  );
}
