/**
 * Kiosk Mode Wallpapers
 * Provides high-resolution vector and procedural wallpapers tailored to the Shell:B aesthetic,
 * as well as custom user-specified image URL support.
 */

export interface WallpaperDef {
  id: string;
  name: string;
  category: 'tactical' | 'ambient' | 'custom';
  description: string;
  previewGradient: string;
  cssBackground: (customUrl?: string) => string;
}

export const WALLPAPER_KEY = 'shellb.kiosk.wallpaper';
export const WALLPAPER_CUSTOM_KEY = 'shellb.kiosk.wallpaper.custom';
export const WALLPAPER_DIM_KEY = 'shellb.kiosk.wallpaper.dim';

// SVG Tactical Blueprint Data URI
const SVG_BLUEPRINT = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <style>
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.9; } }
    @keyframes dash { to { stroke-dashoffset: -24; } }
    .trace { animation: pulse 4s infinite ease-in-out; }
    .dashed { animation: dash 3s linear infinite; }
    .scan { animation: pulse 2s infinite ease-in-out; }
  </style>
  <defs>
    <pattern id="grid-sm" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(56, 189, 248, 0.05)" stroke-width="0.75"/>
    </pattern>
    <pattern id="grid-lg" width="100" height="100" patternUnits="userSpaceOnUse">
      <rect width="100" height="100" fill="url(#grid-sm)"/>
      <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(56, 189, 248, 0.12)" stroke-width="1.2"/>
    </pattern>
  </defs>
  <rect width="800" height="600" fill="#070a12"/>
  <rect width="800" height="600" fill="url(#grid-lg)"/>
  
  <!-- Architectural Chip Outlines -->
  <g stroke="rgba(56, 189, 248, 0.18)" stroke-width="1.2" fill="none">
    <!-- Main GB10 Die -->
    <rect x="280" y="180" width="240" height="240" rx="8" stroke="rgba(56, 189, 248, 0.3)" stroke-width="1.5"/>
    <rect x="300" y="200" width="90" height="90" rx="4"/>
    <rect x="410" y="200" width="90" height="90" rx="4"/>
    <rect x="300" y="310" width="90" height="90" rx="4"/>
    <rect x="410" y="310" width="90" height="90" rx="4"/>
    
    <!-- Unified Memory Banks -->
    <rect x="180" y="200" width="70" height="200" rx="4" stroke="rgba(245, 158, 11, 0.25)"/>
    <rect x="550" y="200" width="70" height="200" rx="4" stroke="rgba(245, 158, 11, 0.25)"/>
    
    <!-- Circuit traces & Micro-vias -->
    <path d="M 250 240 L 280 240 M 250 280 L 280 280 M 250 320 L 280 320 M 250 360 L 280 360" stroke="rgba(245, 158, 11, 0.35)" class="trace"/>
    <path d="M 520 240 L 550 240 M 520 280 L 550 280 M 520 320 L 550 320 M 520 360 L 550 360" stroke="rgba(245, 158, 11, 0.35)" class="trace" style="animation-delay: 1s"/>
    
    <!-- Crosshairs & Alignments -->
    <circle cx="400" cy="300" r="14" stroke="rgba(56, 189, 248, 0.4)" stroke-dasharray="2 2" class="dashed"/>
    <path d="M 370 300 L 430 300 M 400 270 L 400 330" stroke="rgba(56, 189, 248, 0.4)"/>
    <circle cx="100" cy="100" r="6" stroke="rgba(56, 189, 248, 0.25)"/>
    <circle cx="700" cy="100" r="6" stroke="rgba(56, 189, 248, 0.25)"/>
    <circle cx="100" cy="500" r="6" stroke="rgba(56, 189, 248, 0.25)"/>
    <circle cx="700" cy="500" r="6" stroke="rgba(56, 189, 248, 0.25)"/>
  </g>
  
  <!-- Technical Typography -->
  <text x="30" y="45" font-family="monospace" font-size="10" fill="rgba(56, 189, 248, 0.35)" letter-spacing="1.5">SYS: SPARK-GB10 // UNIFIED MEMORY BUS 256-BIT</text>
  <text x="30" y="60" font-family="monospace" font-size="9" fill="rgba(245, 158, 11, 0.3)">LOC: 37.7749° N, 122.4194° W · HOST: LOCAL</text>
  <text x="610" y="570" font-family="monospace" font-size="9" fill="rgba(56, 189, 248, 0.25)" letter-spacing="1">SCHEMA REV 4.2 · TACTICAL</text>
</svg>
`)}`;

// SVG Tactical Topography Data URI
const SVG_TOPOGRAPHY = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="750" viewBox="0 0 1000 750">
  <rect width="1000" height="750" fill="#080c14"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-50 150 Q 200 80, 450 180 T 950 120 T 1150 180" stroke="rgba(56, 189, 248, 0.12)" stroke-width="1.2"/>
    <path d="M-50 220 Q 220 140, 480 240 T 980 180 T 1150 240" stroke="rgba(56, 189, 248, 0.16)" stroke-width="1.2"/>
    <path d="M-50 290 Q 250 210, 520 310 T 1000 240 T 1150 310" stroke="rgba(56, 189, 248, 0.22)" stroke-width="1.4"/>
    <path d="M-50 360 Q 280 280, 550 380 T 1020 310 T 1150 380" stroke="rgba(56, 189, 248, 0.28)" stroke-width="1.6"/>
    <path d="M-50 430 Q 300 350, 580 440 T 1040 370 T 1150 440" stroke="rgba(56, 189, 248, 0.22)" stroke-width="1.4"/>
    <path d="M-50 500 Q 320 420, 620 510 T 1060 440 T 1150 510" stroke="rgba(56, 189, 248, 0.16)" stroke-width="1.2"/>
    <path d="M-50 570 Q 350 490, 650 570 T 1080 500 T 1150 570" stroke="rgba(56, 189, 248, 0.12)" stroke-width="1.2"/>
    
    <!-- Secondary Ridge System -->
    <path d="M 200 -50 Q 380 220, 320 450 T 360 850" stroke="rgba(245, 158, 11, 0.15)" stroke-width="1.2" stroke-dasharray="4 3"/>
    <path d="M 700 -50 Q 820 220, 780 450 T 820 850" stroke="rgba(245, 158, 11, 0.15)" stroke-width="1.2" stroke-dasharray="4 3"/>
  </g>
  <text x="560" y="375" font-family="monospace" font-size="9" fill="rgba(56, 189, 248, 0.45)" letter-spacing="1">EL. 2,450 M // SECTOR 7-B</text>
  <text x="530" y="305" font-family="monospace" font-size="9" fill="rgba(56, 189, 248, 0.35)" letter-spacing="1">EL. 2,200 M</text>
  <circle cx="550" cy="380" r="3" fill="rgba(56, 189, 248, 0.6)"/>
</svg>
`)}`;

// SVG Cyber Hex Matrix Data URI
const SVG_CYBERHEX = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="104" viewBox="0 0 60 104">
  <rect width="60" height="104" fill="#090b12"/>
  <path d="M 30 0 L 60 17.32 L 60 51.96 L 30 69.28 L 0 51.96 L 0 17.32 Z" fill="none" stroke="rgba(99, 102, 241, 0.12)" stroke-width="1"/>
  <path d="M 30 52 L 60 69.32 L 60 103.96 L 30 121.28 L 0 103.96 L 0 69.32 Z" fill="none" stroke="rgba(99, 102, 241, 0.12)" stroke-width="1"/>
  <circle cx="30" cy="17.32" r="1.5" fill="rgba(56, 189, 248, 0.25)"><animate attributeName="r" values="1.5;2.5;1.5" dur="4s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.25;0.8;0.25" dur="4s" repeatCount="indefinite" /></circle>
  <circle cx="30" cy="69.28" r="1.5" fill="rgba(56, 189, 248, 0.25)"><animate attributeName="r" values="1.5;3;1.5" dur="3s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.25;0.9;0.25" dur="3s" repeatCount="indefinite" /></circle>
</svg>
`)}`;

// SVG Starfield / Synthwave (Synthfield) Data URI
const SVG_SYNTHFIELD = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <defs>
    <!-- Deep Space Sky Gradient -->
    <linearGradient id="space-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#04010a"/>
      <stop offset="35%" stop-color="#09041a"/>
      <stop offset="65%" stop-color="#14062a"/>
      <stop offset="100%" stop-color="#2a0747"/>
    </linearGradient>

    <!-- Glowing Synthwave Sun Gradient -->
    <linearGradient id="sun-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffe45e"/>
      <stop offset="45%" stop-color="#ff7a2f"/>
      <stop offset="100%" stop-color="#ff2e97"/>
    </linearGradient>

    <!-- Ringed Gas Giant Planet Gradient -->
    <radialGradient id="planet-grad" cx="30%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#59d8ff"/>
      <stop offset="35%" stop-color="#3d7bff"/>
      <stop offset="75%" stop-color="#1d1145"/>
      <stop offset="100%" stop-color="#080318"/>
    </radialGradient>

    <mask id="sun-mask">
      <rect width="1280" height="800" fill="white"/>
      <rect x="0" y="380" width="1280" height="4" fill="black"/>
      <rect x="0" y="394" width="1280" height="7" fill="black"/>
      <rect x="0" y="411" width="1280" height="11" fill="black"/>
      <rect x="0" y="432" width="1280" height="16" fill="black"/>
      <rect x="0" y="456" width="1280" height="24" fill="black"/>
    </mask>

    <g id="palm-tree">
      <!-- Neon Palm Tree Silhouette -->
      <!-- Trunk -->
      <path d="M 0 0 Q -5 -40 10 -80 Q 20 -120 15 -160 Q 13 -120 -2 -80 Q -15 -40 0 0 Z" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <!-- Fronds -->
      <path d="M 15 -160 Q 35 -180 55 -150 Q 35 -160 15 -160" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <path d="M 15 -160 Q 40 -190 30 -110 Q 25 -140 15 -160" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <path d="M 15 -160 Q 5 -200 -20 -180 Q 0 -170 15 -160" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <path d="M 15 -160 Q -25 -190 -45 -140 Q -20 -150 15 -160" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <path d="M 15 -160 Q -35 -140 -20 -100 Q -15 -130 15 -160" fill="#05010b" stroke="#00f3ff" stroke-width="1.5"/>
      <!-- Pink highlight glow on trunk -->
      <path d="M 5 -20 Q 5 -60 15 -100" fill="none" stroke="#ff2e97" stroke-width="1" opacity="0.8"/>
    </g>

    <g id="h-line">
      <line x1="-1000" x2="2280" stroke="#ff2e97">
        <animate attributeName="y1" values="480; 482; 486; 494; 510; 542; 606; 734; 990; 1502; 2526" keyTimes="0; 0.1; 0.2; 0.3; 0.4; 0.5; 0.6; 0.7; 0.8; 0.9; 1" dur="3s" repeatCount="indefinite" />
        <animate attributeName="y2" values="480; 482; 486; 494; 510; 542; 606; 734; 990; 1502; 2526" keyTimes="0; 0.1; 0.2; 0.3; 0.4; 0.5; 0.6; 0.7; 0.8; 0.9; 1" dur="3s" repeatCount="indefinite" />
        <animate attributeName="stroke-width" values="0.5; 0.6; 0.8; 1; 1.2; 1.5; 2; 2.5; 3.5; 5; 7" keyTimes="0; 0.1; 0.2; 0.3; 0.4; 0.5; 0.6; 0.7; 0.8; 0.9; 1" dur="3s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0; 0.5; 0.8; 0.9; 1; 1; 1; 1; 1; 1; 0" keyTimes="0; 0.05; 0.1; 0.2; 0.3; 0.4; 0.5; 0.6; 0.7; 0.9; 1" dur="3s" repeatCount="indefinite" />
      </line>
    </g>
  </defs>

  <!-- Deep Space Sky Background -->
  <rect width="1280" height="500" fill="url(#space-grad)"/>

  <!-- Starfield Stars -->
  <g fill="#ffffff">
    <circle cx="65" cy="45" r="1.5"><animate attributeName="opacity" values="0.95;0.2;0.95" dur="3.5s" repeatCount="indefinite"/></circle>
    <circle cx="140" cy="170" r="1.1" opacity="0.7"/>
    <circle cx="210" cy="70" r="2.2" fill="#cfe9ff"><animate attributeName="opacity" values="0.9;0.4;0.9" dur="4.2s" repeatCount="indefinite"/></circle>
    <circle cx="290" cy="210" r="1.2"><animate attributeName="opacity" values="0.65;0.1;0.65" dur="2.8s" repeatCount="indefinite"/></circle>
    <circle cx="370" cy="95" r="1.4" opacity="0.8"/>
    <circle cx="450" cy="60" r="2.4" fill="#ffd1ea"><animate attributeName="opacity" values="0.9;0.3;0.9" dur="5.1s" repeatCount="indefinite"/></circle>
    <circle cx="530" cy="165" r="1.1" opacity="0.6"/>
    <circle cx="610" cy="85" r="1.8" opacity="0.85"/>
    <circle cx="690" cy="230" r="1" opacity="0.55"/>
    <circle cx="770" cy="115" r="2.1" fill="#ffeaa7"><animate attributeName="opacity" values="0.9;0.2;0.9" dur="3.9s" repeatCount="indefinite"/></circle>
    <circle cx="870" cy="65" r="1.5" opacity="0.75"/>
    <circle cx="950" cy="180" r="1.2" opacity="0.7"/>
    <circle cx="1060" cy="95" r="2.2" fill="#cfe9ff"><animate attributeName="opacity" values="0.85;0.2;0.85" dur="4.5s" repeatCount="indefinite"/></circle>
    <circle cx="1160" cy="155" r="1" opacity="0.5"/>
    <circle cx="1230" cy="65" r="1.6"><animate attributeName="opacity" values="0.8;0.3;0.8" dur="3.2s" repeatCount="indefinite"/></circle>
  </g>

  <!-- Distant Ringed Gas Giant Planet Limb -->
  <g opacity="0.9">
    <circle cx="1060" cy="115" r="100" fill="url(#planet-grad)"/>
    <ellipse cx="1060" cy="115" rx="180" ry="28" fill="none" stroke="rgba(89, 216, 255, 0.45)" stroke-width="2.5" transform="rotate(-18 1060 115)"/>
    <ellipse cx="1060" cy="115" rx="155" ry="20" fill="none" stroke="rgba(255, 61, 127, 0.35)" stroke-width="1.5" transform="rotate(-18 1060 115)"/>
  </g>

  <!-- Radiant Segmented Synthwave Sun Rising on the Horizon -->
  <g mask="url(#sun-mask)">
    <circle cx="640" cy="460" r="175" fill="url(#sun-grad)"/>
  </g>

  <!-- Horizon Atmosphere Glow -->
  <rect y="470" width="1280" height="30" fill="rgba(255, 61, 127, 0.15)"/>

  <!-- Perspective Floor Base -->
  <rect y="480" width="1280" height="320" fill="#05010b"/>

  <!-- 3D Perspective Wireframe Neon Grid Floor -->
  <g stroke="rgba(255, 46, 151, 0.6)" stroke-width="1.4">
    <!-- Converging Perspective Vanishing Lines -->
    <line x1="640" y1="480" x2="-620" y2="800"/>
    <line x1="640" y1="480" x2="-220" y2="800"/>
    <line x1="640" y1="480" x2="180" y2="800"/>
    <line x1="640" y1="480" x2="410" y2="800"/>
    <line x1="640" y1="480" x2="525" y2="800"/>
    <line x1="640" y1="480" x2="640" y2="800"/>
    <line x1="640" y1="480" x2="755" y2="800"/>
    <line x1="640" y1="480" x2="870" y2="800"/>
    <line x1="640" y1="480" x2="1100" y2="800"/>
    <line x1="640" y1="480" x2="1500" y2="800"/>
    <line x1="640" y1="480" x2="1900" y2="800"/>

    <!-- Perfect Animated Perspective Horizontal Rungs -->
    <use href="#h-line" />
    <use href="#h-line">
      <animate attributeName="begin" values="0" />
      <set attributeName="begin" to="-0.3s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-0.6s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-0.9s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-1.2s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-1.5s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-1.8s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-2.1s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-2.4s" />
    </use>
    <use href="#h-line">
      <set attributeName="begin" to="-2.7s" />
    </use>
  </g>

  <!-- The Iconic 4-Colour Starfield / Synthfield Constellation Stripe along Horizon -->
  <g id="starfield-stripe">
    <rect x="0" y="475" width="1280" height="2.5" fill="#3d7bff"/>
    <rect x="0" y="477.5" width="1280" height="2.5" fill="#ff3d7f"/>
    <rect x="0" y="480" width="1280" height="2.5" fill="#ff7a2f"/>
    <rect x="0" y="482.5" width="1280" height="2.5" fill="#ffc23d"/>
  </g>

  <!-- Neon Palm Trees at the Horizon -->
  <use href="#palm-tree" x="120" y="490" transform="scale(0.8) translate(30, 120)" opacity="0.8"/>
  <use href="#palm-tree" x="280" y="485" transform="scale(0.5) translate(280, 485)" opacity="0.6"/>
  
  <use href="#palm-tree" x="1100" y="495" transform="scale(0.9) translate(120, 55)" opacity="0.9"/>
  <use href="#palm-tree" x="1350" y="485" transform="scale(0.4) translate(1750, 720)" opacity="0.5"/>

  <!-- NASA-Punk Telemetry Markings -->
  <g font-family="monospace, sans-serif" font-weight="600" letter-spacing="1.5">
    <text x="35" y="45" font-size="11" fill="rgba(89, 216, 255, 0.8)">CONSTELLATION // STARFIELD SHIP CONSOLE</text>
    <text x="35" y="62" font-size="9.5" fill="rgba(255, 122, 47, 0.7)">NAV CHRONO · WARP 0.92c · SECTOR 04-CYGNUS</text>
    <text x="1245" y="775" font-size="10" fill="rgba(255, 61, 127, 0.75)" text-anchor="end">SYNTHFIELD HORIZON // NASA-PUNK SYNTHWAVE</text>

    <!-- Center Targeting Reticle -->
    <path d="M 615 480 L 665 480 M 640 455 L 640 505" stroke="rgba(255, 194, 61, 0.85)" stroke-width="1.5"/>
    <circle cx="640" cy="480" r="18" fill="none" stroke="rgba(255, 194, 61, 0.65)" stroke-width="1.2" stroke-dasharray="3 3"/>
  </g>
</svg>
`)}`

export const WALLPAPERS: WallpaperDef[] = [
  {
    id: 'synthfield',
    name: 'Starfield Synthwave',
    category: 'ambient',
    description: 'Starfield deep space constellation meets Synthwave: glowing sliced sun, wireframe grid floor, and 4-color stripe.',
    previewGradient: 'linear-gradient(180deg, #09041a 0%, #2a0747 45%, #ff2e97 70%, #ff8a3d 85%, #05010b 100%)',
    cssBackground: () => `url("${SVG_SYNTHFIELD}") center/cover no-repeat fixed, #04010a`,
  },
  {
    id: 'blueprint',
    name: 'Tactical Blueprint',
    category: 'tactical',
    description: 'NVIDIA DGX Spark board layout with micro-vias, chip dies, bus traces, and coordinate crosshairs.',
    previewGradient: 'linear-gradient(135deg, #070a12 0%, #0d1a2d 60%, #152c4a 100%)',
    cssBackground: () => `url("${SVG_BLUEPRINT}") center/cover no-repeat fixed, #070a12`,
  },
  {
    id: 'deepspace',
    name: 'Cosmic Nebula',
    category: 'ambient',
    description: 'Deep celestial void with luminous violet-indigo nebula clouds and star dust clusters.',
    previewGradient: 'radial-gradient(ellipse at 70% 30%, #4c1d95 0%, #1e1b4b 45%, #050510 100%)',
    cssBackground: () =>
      `radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.22) 0%, transparent 45%), ` +
      `radial-gradient(circle at 20% 80%, rgba(6, 182, 212, 0.18) 0%, transparent 50%), ` +
      `radial-gradient(ellipse at 50% 50%, rgba(30, 27, 75, 0.8) 0%, #05060f 100%)`,
  },
  {
    id: 'topography',
    name: 'Tactical Topography',
    category: 'tactical',
    description: 'Precision elevation contour lines and alpine topographic survey curves on dark slate.',
    previewGradient: 'linear-gradient(135deg, #080c14 0%, #0f172a 60%, #1e293b 100%)',
    cssBackground: () => `url("${SVG_TOPOGRAPHY}") center/cover no-repeat fixed, #080c14`,
  },
  {
    id: 'synthwave',
    name: 'Synthwave Horizon',
    category: 'ambient',
    description: 'Radiant retro-futuristic sunburst on deep indigo with perspective grid floor.',
    previewGradient: 'linear-gradient(180deg, #18092e 0%, #3b0764 50%, #f43f5e 80%, #090214 100%)',
    cssBackground: () =>
      `radial-gradient(ellipse at 50% 65%, rgba(244, 63, 94, 0.35) 0%, rgba(59, 7, 100, 0.45) 35%, #0a0316 85%)`,
  },
  {
    id: 'cyberhex',
    name: 'Neural Honeycomb',
    category: 'tactical',
    description: 'Hexagonal matrix grid with subtle neural node connections and indigo glow.',
    previewGradient: 'linear-gradient(135deg, #090b12 0%, #17182e 60%, #1f2347 100%)',
    cssBackground: () => `url("${SVG_CYBERHEX}") repeat, #090b12`,
  },
  {
    id: 'minimal',
    name: 'Obsidian Minimal',
    category: 'ambient',
    description: 'Understated Swiss graphite matte with subtle radial focal lighting and clean corners.',
    previewGradient: 'radial-gradient(circle at 50% 45%, #181920 0%, #0b0c10 100%)',
    cssBackground: () =>
      `radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.04) 0%, transparent 60%), #0c0e14`,
  },
  {
    id: 'custom',
    name: 'Custom Image URL',
    category: 'custom',
    description: 'Load any high-resolution wallpaper image via HTTP/HTTPS URL.',
    previewGradient: 'linear-gradient(135deg, #27272a 0%, #3f3f46 50%, #52525b 100%)',
    cssBackground: customUrl =>
      customUrl ? `url("${customUrl}") center/cover no-repeat fixed, #070a12` : '#070a12',
  },
];

export const DEFAULT_WALLPAPER = 'synthfield';

export function getStoredWallpaperId(): string {
  try {
    return localStorage.getItem(WALLPAPER_KEY) || DEFAULT_WALLPAPER;
  } catch {
    return DEFAULT_WALLPAPER;
  }
}

export function getStoredCustomUrl(): string {
  try {
    return localStorage.getItem(WALLPAPER_CUSTOM_KEY) || '';
  } catch {
    return '';
  }
}

export function getStoredWallpaperDim(): number {
  try {
    const val = localStorage.getItem(WALLPAPER_DIM_KEY);
    return val !== null ? Number(val) : 25; // default 25% dim for contrast
  } catch {
    return 25;
  }
}

export function saveWallpaperChoice(id: string, customUrl?: string, dimPercent?: number) {
  try {
    localStorage.setItem(WALLPAPER_KEY, id);
    if (customUrl !== undefined) {
      localStorage.setItem(WALLPAPER_CUSTOM_KEY, customUrl);
    }
    if (dimPercent !== undefined) {
      localStorage.setItem(WALLPAPER_DIM_KEY, String(dimPercent));
    }
    window.dispatchEvent(new CustomEvent('shellb-kiosk-wallpaper', { detail: { id, customUrl, dimPercent } }));
  } catch {}
}
