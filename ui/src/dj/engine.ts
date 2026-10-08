import { djLive } from './live';
// Shell:B FM: a procedural radio station built on the Web Audio API.
// Nine styles (lo-fi, jazzhop, city pop, synthwave, darkwave, deep house, liquid DnB, chiptune, ambient)
// each define tempo, modes, harmonic rhythm, drum grooves, bass lines, instrument patches and song forms.
// A song is fully determined by seed + style + tonic, so favourites replay exactly.
// The DJ runs two decks. While one song plays it already has the next one planned: in Auto it walks an
// energy arc across styles, steered by likes and skips, and keeps keys compatible. At the end it mixes
// with a beatmatched blend (bass swap + tempo ride), an echo out, a filter sweep with a riser, or a tape
// brake. Inside songs it adds risers, drop gaps, fills, filter moves and echo throws, and listeners can
// play along with a filter knob, build / echo / brake pads and a bass kill.

export type Style = 'lofi' | 'jazzhop' | 'citypop' | 'synthwave' | 'darkwave' | 'house' | 'dnb' | 'chiptune' | 'ambient'
  | 'cyberpunk' | 'futurefunk' | 'dubtechno' | 'dungeonsynth';
export type Vibe = 'auto' | Style;
export type TransitionKind = 'blend' | 'echo' | 'filter' | 'brake';

export type StemId = 'drums' | 'bass' | 'keys' | 'pad' | 'arp' | 'lead';
export interface StemState {
  muted: boolean;
  solo: boolean;
  volume: number;
}
export interface DeckEqState {
  low: number; // dB (-40 to +6)
  mid: number;
  high: number;
  lowKill: boolean;
  midKill: boolean;
  highKill: boolean;
}

export interface SongInfo {
  title: string;
  seed: number;
  style: Style;
  tonic: number; // pitch class of the key, needed to replay a harmonically-mixed song
  key: string;
  mode: string;
  bpm: number;
  lofi: number; // 0 = clean, 1 = dusty tape
  bars: number;
  form: string;
}

export interface DJState {
  playing: boolean;
  song: SongInfo | null;
  section: string;
  bar: number;
  totalBars: number;
  bpm: number;
  next: SongInfo | null;
  nextVia: TransitionKind | null;
  note: string; // what the DJ is doing right now
  history: SongInfo[];
  weights: Record<Style, number>; // taste learned from likes and skips, used by Auto
  stems: Record<StemId, StemState>;
  eq: DeckEqState;
  crossfader: number; // -1 (Deck A) to 1 (Deck B)
  recording: boolean;
  recordingDuration: number;
  filter: number;
  bassKill: boolean;
  station: string;
  samplerVolume: number;
}

export type SoundFxKind =
  | 'airhorn'
  | 'scratch'
  | 'subdrop'
  | 'laser'
  | 'siren'
  | 'tapestop'
  | 'stutter'
  | 'rewind'
  | 'cowbell'
  | 'chant'
  | 'impact';

export type Groove = 'four' | 'house' | 'boombap' | 'half' | 'dnb' | 'shuffle' | 'chip' | 'sparse';
export type BassLine = 'pulse' | 'boom' | 'offbeat' | 'walk' | 'octave' | 'sub' | 'roll' | 'chip';
export type BassTone = 'round' | 'saw' | 'upright' | 'deep' | 'sub' | 'chip' | 'slap';
export type PadKind = 'saw' | 'warm' | 'glass' | 'strings' | 'pulse';
export type KeysKind = 'rhodes' | 'organ' | 'stab' | 'pluck' | 'bell' | 'chip';
export type ArpKind = 'square' | 'saw' | 'pluck' | 'bell' | 'chip';
export type LeadKind = 'saw' | 'square' | 'brass' | 'flute' | 'bell' | 'chip';
export type Form = 'classic' | 'song' | 'club' | 'loop' | 'ambient';
export type Perc = 'rim' | 'shaker' | 'conga' | 'none';
export type Fill = 'roll' | 'tom' | 'kick' | 'open' | 'none';

export interface CustomSongParams {
  title?: string;
  style: Style;
  tonic?: number;
  mode?: string;
  bpm?: number;
  lofi?: number;
  form?: Form;
  groove?: Groove;
  bassTone?: BassTone;
  pad?: PadKind;
  keys?: KeysKind;
  arp?: ArpKind;
  lead?: LeadKind;
  seed?: number;
}

interface Kit {
  kick: [number, number, number]; // start Hz, end Hz, decay s
  kickWave: OscillatorType;
  snare: number; snareDecay: number; body: number; gate: number; brush?: boolean;
  hat: number; hatDecay: number; perc: Perc;
}
const KITS: Record<string, Kit> = {
  dusty: { kick: [150, 45, 0.45], kickWave: 'sine', snare: 1300, snareDecay: 0.2, body: 0.3, gate: 0.25, hat: 6800, hatDecay: 0.04, perc: 'rim' },
  brush: { kick: [120, 48, 0.35], kickWave: 'sine', snare: 2600, snareDecay: 0.32, body: 0, gate: 0.2, brush: true, hat: 7500, hatDecay: 0.05, perc: 'rim' },
  gated: { kick: [160, 42, 0.5], kickWave: 'sine', snare: 1800, snareDecay: 0.26, body: 0.35, gate: 0.75, hat: 7200, hatDecay: 0.045, perc: 'none' },
  disco: { kick: [140, 50, 0.32], kickWave: 'sine', snare: 2000, snareDecay: 0.18, body: 0.4, gate: 0.35, hat: 8000, hatDecay: 0.04, perc: 'conga' },
  house: { kick: [130, 46, 0.42], kickWave: 'sine', snare: 1500, snareDecay: 0.14, body: 0.2, gate: 0.3, hat: 8500, hatDecay: 0.035, perc: 'shaker' },
  break: { kick: [170, 50, 0.3], kickWave: 'sine', snare: 2100, snareDecay: 0.16, body: 0.45, gate: 0.3, hat: 8800, hatDecay: 0.03, perc: 'shaker' },
  chip: { kick: [220, 40, 0.18], kickWave: 'triangle', snare: 3500, snareDecay: 0.1, body: 0, gate: 0.05, hat: 9000, hatDecay: 0.02, perc: 'none' },
  soft: { kick: [110, 44, 0.5], kickWave: 'sine', snare: 2400, snareDecay: 0.3, body: 0, gate: 0.5, brush: true, hat: 6000, hatDecay: 0.06, perc: 'rim' },
};

interface StyleDef {
  label: string; short: string; hint: string;
  energy: number; // 0..1, used by the Auto set planner
  hues: number[]; // visualizer palette, cycled per chord
  bpm: [number, number]; lofi: [number, number]; swing: [number, number];
  modes: string[];
  ext: [number, number, number]; // weights for triads / sevenths / ninths
  hr: number[]; // harmonic rhythm: bars per chord
  grooves: Groove[]; bass: BassLine[]; bassTone: BassTone;
  pads: PadKind[]; keys: KeysKind[]; arps: ArpKind[]; leads: LeadKind[];
  arpRates: number[]; // in 16ths; 3 gives a dotted-eighth polyrhythm
  arpSkip: number; // chance an arp note is left out (sparkle instead of a sequence)
  forms: Form[]; kit: Kit;
  density: number; // melody note density
  keysOn: number; // chance the keys comp outside the hooks
}

export const STYLES: Record<Style, StyleDef> = {
  lofi: {
    label: 'Lo-fi', short: 'Lo-fi', hint: 'Dusty beats: swing, Rhodes, vinyl crackle', energy: 0.3, hues: [312, 276, 24, 190],
    bpm: [70, 88], lofi: [0.6, 0.95], swing: [0.18, 0.3], modes: ['minor', 'dorian', 'major', 'dorian'], ext: [0, 2, 2], hr: [1, 1, 2],
    grooves: ['boombap', 'boombap', 'half'], bass: ['boom', 'boom', 'walk'], bassTone: 'round',
    pads: ['warm', 'saw'], keys: ['rhodes', 'rhodes', 'pluck', 'bell'], arps: ['pluck', 'bell'], leads: ['flute', 'bell', 'square'],
    arpRates: [2, 3, 4], arpSkip: 0.15, forms: ['loop', 'classic'], kit: KITS.dusty, density: 0.45, keysOn: 0.9,
  },
  jazzhop: {
    label: 'Jazzhop', short: 'Jazz', hint: 'Ninth chords, walking bass, brushed drums', energy: 0.35, hues: [24, 40, 200, 330],
    bpm: [78, 94], lofi: [0.45, 0.75], swing: [0.22, 0.34], modes: ['dorian', 'major', 'minor'], ext: [0, 1, 3], hr: [1, 2],
    grooves: ['boombap', 'shuffle'], bass: ['walk', 'walk', 'boom'], bassTone: 'upright',
    pads: ['warm'], keys: ['rhodes', 'rhodes', 'organ'], arps: ['pluck', 'bell'], leads: ['flute', 'bell', 'square'],
    arpRates: [2, 4], arpSkip: 0.25, forms: ['loop'], kit: KITS.brush, density: 0.55, keysOn: 1,
  },
  citypop: {
    label: 'City Pop', short: 'City Pop', hint: 'Bright maj7 chords, disco octaves, brass hooks', energy: 0.55, hues: [190, 330, 48, 280],
    bpm: [104, 118], lofi: [0.1, 0.35], swing: [0, 0.08], modes: ['major', 'lydian', 'major', 'dorian'], ext: [0, 2, 2], hr: [1, 2, 0.5],
    grooves: ['shuffle', 'four'], bass: ['octave', 'octave', 'pulse'], bassTone: 'slap',
    pads: ['strings', 'warm'], keys: ['rhodes', 'stab', 'pluck'], arps: ['pluck', 'bell'], leads: ['brass', 'saw', 'square'],
    arpRates: [2, 1], arpSkip: 0, forms: ['song', 'classic'], kit: KITS.disco, density: 0.65, keysOn: 0.8,
  },
  synthwave: {
    label: 'Synthwave', short: 'Synth', hint: 'Pulsing bass, arps, gated 80s snare', energy: 0.65, hues: [312, 276, 190, 330],
    bpm: [84, 112], lofi: [0.03, 0.3], swing: [0, 0.06], modes: ['minor', 'minor', 'dorian', 'mixolydian', 'major'], ext: [3, 2, 0], hr: [1, 1, 2],
    grooves: ['four', 'four', 'boombap'], bass: ['pulse', 'pulse', 'octave'], bassTone: 'saw',
    pads: ['saw', 'strings'], keys: ['pluck', 'stab'], arps: ['square', 'saw', 'pluck'], leads: ['saw', 'square', 'brass'],
    arpRates: [1, 1, 2, 3], arpSkip: 0, forms: ['song', 'classic', 'club'], kit: KITS.gated, density: 0.6, keysOn: 0.4,
  },
  darkwave: {
    label: 'Darkwave', short: 'Dark', hint: 'Phrygian minor, rolling bass, cold leads', energy: 0.7, hues: [280, 0, 250, 320],
    bpm: [100, 124], lofi: [0.05, 0.25], swing: [0, 0.04], modes: ['phrygian', 'minor', 'harmonic'], ext: [3, 1, 0], hr: [1, 2],
    grooves: ['four', 'half', 'boombap'], bass: ['roll', 'roll', 'pulse'], bassTone: 'saw',
    pads: ['strings', 'saw'], keys: ['stab', 'bell'], arps: ['saw', 'square'], leads: ['saw', 'bell'],
    arpRates: [1, 2, 3], arpSkip: 0, forms: ['club', 'song'], kit: KITS.gated, density: 0.5, keysOn: 0.4,
  },
  house: {
    label: 'Deep House', short: 'House', hint: 'Four on the floor, organ stabs, offbeat bass', energy: 0.75, hues: [200, 170, 300, 40],
    bpm: [118, 126], lofi: [0.05, 0.3], swing: [0.04, 0.14], modes: ['minor', 'dorian', 'dorian'], ext: [0, 3, 2], hr: [1, 2],
    grooves: ['house'], bass: ['offbeat', 'offbeat', 'pulse'], bassTone: 'deep',
    pads: ['warm', 'glass'], keys: ['organ', 'stab', 'rhodes'], arps: ['pluck', 'bell'], leads: ['bell', 'flute', 'square'],
    arpRates: [2, 3], arpSkip: 0.1, forms: ['club'], kit: KITS.house, density: 0.4, keysOn: 0.9,
  },
  dnb: {
    label: 'Liquid DnB', short: 'DnB', hint: 'Breakbeats at 170, sub bass, lush pads', energy: 0.9, hues: [190, 220, 160, 300],
    bpm: [168, 176], lofi: [0.05, 0.3], swing: [0, 0.05], modes: ['minor', 'dorian', 'major'], ext: [0, 2, 3], hr: [2, 2, 1],
    grooves: ['dnb'], bass: ['sub', 'sub', 'boom'], bassTone: 'sub',
    pads: ['strings', 'glass', 'warm'], keys: ['rhodes', 'bell'], arps: ['bell', 'pluck'], leads: ['flute', 'bell', 'saw'],
    arpRates: [2, 4, 3], arpSkip: 0.2, forms: ['club'], kit: KITS.break, density: 0.35, keysOn: 0.8,
  },
  chiptune: {
    label: 'Chiptune', short: 'Chip', hint: 'Pulse waves, fast arps, 8-bit drums', energy: 0.8, hues: [120, 50, 200, 330],
    bpm: [124, 150], lofi: [0, 0.05], swing: [0, 0], modes: ['major', 'minor', 'mixolydian', 'dorian'], ext: [3, 1, 0], hr: [1, 1, 0.5],
    grooves: ['chip'], bass: ['chip'], bassTone: 'chip',
    pads: ['pulse'], keys: ['chip'], arps: ['chip'], leads: ['chip'],
    arpRates: [1, 1, 2], arpSkip: 0, forms: ['song', 'classic'], kit: KITS.chip, density: 0.75, keysOn: 0.5,
  },
  ambient: {
    label: 'Ambient', short: 'Ambient', hint: 'Slow drift: glassy pads, bells, little or no drums', energy: 0.1, hues: [200, 250, 170, 290],
    bpm: [60, 78], lofi: [0.2, 0.6], swing: [0, 0.1], modes: ['lydian', 'major', 'dorian', 'minor'], ext: [0, 2, 3], hr: [2, 2, 4],
    grooves: ['sparse'], bass: ['sub'], bassTone: 'sub',
    pads: ['glass', 'warm', 'strings'], keys: ['bell', 'rhodes'], arps: ['bell', 'pluck'], leads: ['flute', 'bell'],
    arpRates: [3, 4, 2], arpSkip: 0.4, forms: ['ambient'], kit: KITS.soft, density: 0.25, keysOn: 0.6,
  },
  cyberpunk: {
    label: 'Cyberpunk', short: 'Cyber', hint: 'Heavy industrial bass, distorted leads, aggressive midtempo', energy: 0.85, hues: [330, 180, 280, 50],
    bpm: [96, 108], lofi: [0.05, 0.25], swing: [0, 0.04], modes: ['phrygian', 'harmonic', 'minor'], ext: [3, 1, 0], hr: [1, 2],
    grooves: ['half', 'four'], bass: ['roll', 'pulse', 'boom'], bassTone: 'saw',
    pads: ['saw', 'strings'], keys: ['stab', 'organ'], arps: ['saw', 'square'], leads: ['saw', 'square', 'brass'],
    arpRates: [1, 2], arpSkip: 0, forms: ['club', 'song'], kit: KITS.gated, density: 0.65, keysOn: 0.5,
  },
  futurefunk: {
    label: 'Future Funk', short: 'Funk', hint: 'Disco punch, slap bass octaves, French house filters', energy: 0.82, hues: [320, 45, 195, 270],
    bpm: [120, 128], lofi: [0.06, 0.2], swing: [0.04, 0.12], modes: ['major', 'dorian', 'mixolydian'], ext: [0, 2, 3], hr: [1, 0.5, 2],
    grooves: ['four', 'house', 'shuffle'], bass: ['octave', 'pulse', 'walk'], bassTone: 'slap',
    pads: ['strings', 'warm'], keys: ['rhodes', 'stab', 'pluck'], arps: ['pluck', 'bell'], leads: ['brass', 'flute', 'saw'],
    arpRates: [2, 1], arpSkip: 0, forms: ['club', 'song'], kit: KITS.disco, density: 0.7, keysOn: 0.9,
  },
  dubtechno: {
    label: 'Dub Techno', short: 'Dub', hint: 'Tape-delayed minor chords, sub rumble, hypnotic spaces', energy: 0.5, hues: [210, 180, 240, 150],
    bpm: [116, 124], lofi: [0.35, 0.65], swing: [0.02, 0.08], modes: ['minor', 'dorian'], ext: [1, 3, 1], hr: [2, 4],
    grooves: ['house', 'sparse'], bass: ['sub', 'pulse'], bassTone: 'sub',
    pads: ['warm', 'glass'], keys: ['stab', 'rhodes'], arps: ['bell', 'pluck'], leads: ['bell', 'flute'],
    arpRates: [3, 4], arpSkip: 0.35, forms: ['club', 'loop'], kit: KITS.house, density: 0.25, keysOn: 0.7,
  },
  dungeonsynth: {
    label: 'Dungeon Synth', short: 'Fantasy', hint: 'Medieval melodies, church organ, mystic lute plucks', energy: 0.22, hues: [140, 40, 280, 200],
    bpm: [68, 84], lofi: [0.2, 0.5], swing: [0, 0.05], modes: ['dorian', 'lydian', 'minor', 'harmonic'], ext: [2, 2, 1], hr: [2, 4],
    grooves: ['sparse'], bass: ['walk', 'sub'], bassTone: 'deep',
    pads: ['glass', 'strings'], keys: ['organ', 'bell', 'pluck'], arps: ['bell', 'pluck'], leads: ['flute', 'bell'],
    arpRates: [3, 4], arpSkip: 0.3, forms: ['classic', 'loop', 'ambient'], kit: KITS.soft, density: 0.45, keysOn: 0.8,
  },
};
export const STYLE_IDS = Object.keys(STYLES) as Style[];

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MODES: Record<string, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
};
// scale-degree progressions (0 = tonic), one chord per harmonic-rhythm slot
const PROGS: Record<string, number[][]> = {
  minor: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 4], [0, 5, 3, 4], [5, 3, 0, 6], [0, 2, 5, 6], [0, 3, 6, 2], [3, 4, 0, 0], [0, 5, 2, 6, 0, 5, 3, 4]],
  dorian: [[0, 3, 0, 3], [0, 6, 3, 0], [0, 1, 3, 6], [3, 6, 0, 4], [0, 3], [0, 6, 0, 3], [0, 4, 3, 3]],
  major: [[1, 4, 0, 5], [3, 2, 1, 0], [0, 5, 3, 4], [3, 4, 2, 5], [0, 2, 3, 3], [0, 4, 5, 3], [0, 5, 1, 4], [3, 4, 0, 0], [5, 3, 0, 4], [1, 4, 0, 0]],
  mixolydian: [[0, 6, 3, 0], [0, 3, 6, 3], [3, 6, 0, 0], [0, 6, 3, 3]],
  lydian: [[0, 1], [0, 1, 4, 5], [0, 4, 1, 0], [5, 1, 0, 0], [0, 1, 2, 1]],
  phrygian: [[0, 1, 0, 6], [0, 1, 6, 0], [0, 5, 1, 0], [0, 3, 1, 0], [0, 6, 5, 1]],
  harmonic: [[0, 5, 4, 4], [0, 3, 4, 0], [0, 5, 3, 4], [0, 5, 1, 4]],
};
const KEYS_RHYTHMS: Record<KeysKind, number[][]> = {
  rhodes: [[0, 7, 10], [0, 6, 10, 14], [0, 3, 8, 11], [2, 8, 14], [0, 8], [0, 6, 12], [0]],
  organ: [[2, 6, 10, 14], [3, 6, 11, 14], [0, 3, 6, 10, 13], [2, 5, 10, 13]],
  stab: [[0, 3, 6, 10, 12], [2, 6, 10, 14], [0, 6, 8, 14], [3, 6, 11]],
  pluck: [[0, 3, 6, 10, 12], [0, 2, 4, 6, 8, 10, 12, 14], [0, 6, 8, 14], [0, 3, 6, 8, 11, 14]],
  bell: [[0], [0, 10], [0, 7], [0, 6, 12]],
  chip: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 4, 8, 12], [0, 3, 6, 8, 11, 14]],
};

const ADJ = ['Neon', 'Midnight', 'Chrome', 'Velvet', 'Pastel', 'Vapor', 'Analog', 'Magenta', 'Lunar', 'Cassette', 'Arcade', 'Polaroid',
  'Electric', 'Violet', 'Hazy', 'Static', 'Sunset', 'Laser', 'Satellite', 'Coastal', 'Quiet', 'Rainy', 'Faded', 'Digital', 'Golden',
  'Silver', 'Hollow', 'Paper', 'Lucid', 'Infrared', 'Slow', 'Distant', 'Crystal', 'Northern', 'Borrowed', 'Electric Blue'];
const NOUN = ['Drive', 'Boulevard', 'Tide', 'Daydream', 'Skyline', 'Memory', 'Highway', 'Signal', 'Horizon', 'Afterglow', 'Motel',
  'Rain', 'Arcade', 'Lagoon', 'Overpass', 'Postcard', 'Heartbeat', 'Mirage', 'Transmission', 'Rooftops', 'Streetlights', 'Cruise',
  'Frequency', 'Orbit', 'Window', 'Echo', 'Season', 'Weekend', 'Static', 'Reflection'];
const STYLE_NOUNS: Record<Style, string[]> = {
  lofi: ['Study Hall', 'Tea', 'Notebook', 'Sunday', 'Bedroom', 'Raincoat'],
  jazzhop: ['Corner Café', 'Late Set', 'Smoke Rings', 'Brushstrokes', 'Back Booth', 'Fire Escape'],
  citypop: ['Marina', 'Neon Pier', 'Summer', 'Telephone', 'Convertible', 'Resort'],
  synthwave: ['Outrun', 'Interceptor', 'Grid', 'Night Shift', 'Pursuit', 'VHS'],
  darkwave: ['Cathedral', 'Ash', 'Glass Heart', 'Nocturne', 'Black Mirror', 'Silhouette'],
  house: ['Warehouse', 'Sunrise', 'Basement', 'Strobe', 'Dancefloor', 'Afterhours'],
  dnb: ['Rain Circuit', 'Atmosphere', 'Rush', 'Liquid', 'Undercurrent', 'Momentum'],
  chiptune: ['Level 9', 'Cartridge', 'Pixel', 'Boss Rush', 'Overworld', 'Continue'],
  ambient: ['Drift', 'Glacier', 'Aurora', 'Low Tide', 'Snowfall', 'Stillness'],
  cyberpunk: ['Neon Alley', 'Sprawl', 'Neural Net', 'Cyberdeck', 'Megacity', 'Overdrive'],
  futurefunk: ['Roller Disco', 'Plastic Love', 'City Lights', 'Cassette Girl', 'Night Drive', 'Starlight'],
  dubtechno: ['Resonance', 'Echo Chamber', 'Subcurrent', 'Vapour Trail', 'Deep Space', 'Tape Loop'],
  dungeonsynth: ['Old Keep', 'Forgotten Realm', 'Spellbook', 'Candlelight', 'Ancient Woods', 'Crypt'],
};
const TAGS = ['', '', '', '', '', " '86", ' (Tape Mix)', ' (Night Edit)', ' Pt. II', ' (VHS Dub)', ' (Extended)', ' (Club Mix)', ' (Reprise)'];
const TAILS = ['at Dusk', 'After Dark', 'in Blue', 'on Repeat', 'Forever', 'for Two', 'in Slow Motion', 'Underground'];

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const mod = (x: number, n: number) => ((x % n) + n) % n;
function wpick<T extends string>(w: Record<T, number>, rnd: () => number = Math.random): T {
  const keys = Object.keys(w) as T[];
  let total = 0;
  for (const k of keys) total += w[k];
  let x = rnd() * total;
  for (const k of keys) { x -= w[k]; if (x <= 0) return k; }
  return keys[keys.length - 1];
}

// ── composition ───────────────────────────────────────────────────────────
type Layers = { drums: 0 | 1 | 2; bass: boolean; pad: boolean; keys: boolean; arp: boolean; lead: boolean; perc?: boolean; improv?: boolean };
type Section = {
  name: string; bars: number; prog: 'A' | 'B' | 'C'; layers: Layers; energy: number;
  hook?: boolean; // denser hook groove
  riser?: boolean; // noise riser over this section's last two bars
  gap?: boolean; // silence the last beat before the next section lands
  shift?: number; // key change in semitones
  fill?: Fill; filter?: boolean; throw?: boolean;
};
interface Drums { kick: number[]; snare: number[]; clap: number[]; hat: number[]; open: number[]; perc: number[]; rolls: number }
type BassNote = { tone: 'r' | 'o' | '3' | '5' | 'w'; len: number };

interface Song extends SongInfo {
  root: number; // MIDI note of the tonic in the bass register
  scale: number[];
  progs: Record<'A' | 'B' | 'C', number[]>;
  hr: number;
  chordSize: number;
  swing: number;
  sections: Section[];
  drumsA: Drums; drumsB: Drums; kit: Kit; pump: number;
  bass: (BassNote | null)[]; bassTone: BassTone;
  pad: PadKind; keys: KeysKind; arp: ArpKind; lead: LeadKind;
  arpShape: 'up' | 'down' | 'updown' | 'shuffle'; arpRate: number; arpOrder: number[]; arpSkip: number;
  phrase: (number | null)[]; // 32 eighth-note slots over 4 bars, scale degrees
  density: number;
  keysRhythm: number[];
  padCutoff: number;
}

function makeDrums(g: Groove, r: () => number, lofi: number): Drums {
  const chance = (p: number) => r() < p;
  const z = () => new Array<number>(16).fill(0);
  const d: Drums = { kick: z(), snare: z(), clap: z(), hat: z(), open: z(), perc: z(), rolls: 0 };
  const four = () => [0, 4, 8, 12].forEach(i => (d.kick[i] = 1));
  const backbeat = () => { d.snare[4] = 1; d.snare[12] = 1; };
  switch (g) {
    case 'four':
      four(); backbeat();
      for (let i = 0; i < 16; i++) d.hat[i] = i % 2 ? (chance(0.6) ? 0.3 : 0) : i % 4 ? 0.7 : 0.45;
      if (chance(0.5)) d.open[14] = 0.5;
      if (chance(0.3)) d.kick[14] = 0.5;
      break;
    case 'house':
      four(); d.clap[4] = 1; d.clap[12] = 1;
      [2, 6, 10, 14].forEach(i => (d.open[i] = 0.5));
      for (let i = 0; i < 16; i++) d.hat[i] = i % 2 ? 0.28 : 0.16;
      if (chance(0.6)) for (let i = 0; i < 16; i++) d.perc[i] = i % 2 ? 0.35 : 0.18;
      if (chance(0.4)) d.snare[chance(0.5) ? 7 : 15] = 0.2;
      break;
    case 'boombap':
      d.kick[0] = 1; d.kick[10] = 0.9;
      if (chance(0.5)) d.kick[7] = 0.6;
      if (chance(0.4)) d.kick[11] = 0.7;
      if (chance(0.3)) d.kick[3] = 0.5;
      backbeat();
      if (lofi > 0.5 && chance(0.6)) d.snare[15] = 0.25;
      if (chance(0.3)) d.snare[9] = 0.2;
      for (let i = 0; i < 16; i++) d.hat[i] = i % 2 === 0 ? (i % 4 === 0 ? 0.9 : 0.6) : lofi > 0.45 ? (chance(0.55) ? 0.3 + r() * 0.2 : 0) : chance(0.85) ? 0.35 : 0;
      if (chance(0.6)) d.open[chance(0.5) ? 14 : 6] = 0.5;
      if (chance(0.4)) { d.perc[7] = 0.4; d.perc[15] = 0.3; }
      break;
    case 'half':
      d.kick[0] = 1;
      if (chance(0.6)) d.kick[3] = 0.6;
      if (chance(0.5)) d.kick[10] = 0.8;
      if (chance(0.4)) d.kick[11] = 0.6;
      d.snare[8] = 1;
      if (chance(0.5)) d.clap[8] = 0.7;
      for (let i = 0; i < 16; i++) d.hat[i] = i % 4 === 0 ? 0.8 : i % 2 === 0 ? 0.55 : 0.3;
      d.rolls = 0.12;
      if (chance(0.4)) d.open[6] = 0.45;
      break;
    case 'dnb':
      d.kick[0] = 1; d.kick[10] = 0.9;
      if (chance(0.5)) d.kick[2] = 0.6;
      if (chance(0.3)) d.kick[7] = 0.5;
      backbeat();
      if (chance(0.6)) d.snare[7] = 0.2;
      if (chance(0.5)) d.snare[9] = 0.25;
      if (chance(0.5)) d.snare[15] = 0.2;
      for (let i = 0; i < 16; i++) d.hat[i] = i % 2 === 0 ? (i % 4 === 0 ? 0.6 : 0.45) : chance(0.5) ? 0.25 : 0;
      if (chance(0.3)) d.open[6] = 0.4;
      if (chance(0.5)) for (let i = 1; i < 16; i += 2) d.perc[i] = 0.2;
      d.rolls = 0.04;
      break;
    case 'shuffle':
      d.kick[0] = 1; d.kick[8] = 1;
      if (chance(0.5)) { d.kick[4] = 0.9; d.kick[12] = 0.9; }
      backbeat();
      if (chance(0.5)) { d.clap[4] = 0.6; d.clap[12] = 0.6; }
      for (let i = 0; i < 16; i += 2) d.hat[i] = i % 4 === 0 ? 0.5 : 0.75;
      if (chance(0.5)) [2, 6, 10, 14].forEach(i => (d.open[i] = 0.45));
      if (chance(0.6)) { d.perc[3] = 0.5; d.perc[6] = 0.4; d.perc[11] = 0.5; }
      break;
    case 'chip':
      d.kick[0] = 1; d.kick[8] = 1;
      if (chance(0.5)) d.kick[6] = 0.7;
      if (chance(0.4)) d.kick[10] = 0.7;
      backbeat();
      for (let i = 0; i < 16; i++) d.hat[i] = i % 2 ? 0.35 : 0.6;
      d.rolls = 0.05;
      break;
    case 'sparse':
      d.kick[0] = 0.7;
      if (chance(0.5)) d.kick[10] = 0.45;
      if (chance(0.6)) d.perc[12] = 0.5; else d.perc[4] = 0.5;
      if (chance(0.5)) for (let i = 0; i < 16; i += 2) d.hat[i] = 0.25;
      break;
  }
  return d;
}

/** the hook groove: the verse pattern plus extra hats, a kick pickup, perc and ratchets */
function densify(a: Drums, g: Groove, r: () => number): Drums {
  const d: Drums = { kick: [...a.kick], snare: [...a.snare], clap: [...a.clap], hat: [...a.hat], open: [...a.open], perc: [...a.perc], rolls: a.rolls };
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (g === 'sparse') { d.hat = d.hat.map((v, i) => v || (i % 2 === 0 ? 0.22 : 0)); return d; }
  for (let i = 1; i < 16; i += 2) if (!d.hat[i] && r() < 0.5) d.hat[i] = 0.28;
  if (g !== 'four' && g !== 'house') { const k = pick([3, 7, 11, 13, 14]); if (!d.kick[k]) d.kick[k] = 0.55; }
  if (r() < 0.5) { const p = pick([3, 7, 11, 15]); if (!d.perc[p]) d.perc[p] = 0.4; }
  if ((g === 'house' || g === 'four') && r() < 0.5) d.open[14] = 0.5;
  d.rolls = Math.max(d.rolls, g === 'half' ? 0.18 : 0.04);
  return d;
}

function makeBass(kind: BassLine, r: () => number): (BassNote | null)[] {
  const chance = (p: number) => r() < p;
  const b: (BassNote | null)[] = new Array(16).fill(null);
  const add = (s: number, tone: BassNote['tone'], len: number) => { b[s] = { tone, len }; };
  switch (kind) {
    case 'pulse':
      for (let i = 0; i < 16; i += 2) add(i, i % 4 === 2 && chance(0.35) ? 'o' : 'r', 1.7);
      if (chance(0.5)) add(14, '5', 1.7);
      break;
    case 'boom':
      add(0, 'r', 5);
      if (chance(0.6)) add(6, 'r', 3);
      add(10, chance(0.6) ? '5' : 'r', 3);
      if (chance(0.4)) add(14, 'o', 2);
      break;
    case 'offbeat':
      [2, 6, 10, 14].forEach(s => add(s, 'r', 1.5));
      if (chance(0.5)) add(chance(0.5) ? 7 : 15, 'o', 0.8);
      break;
    case 'walk':
      [0, 4, 8, 12].forEach(s => add(s, 'w', 3.6));
      break;
    case 'octave':
      for (let i = 0; i < 16; i += 2) add(i, i % 4 === 0 ? 'r' : 'o', 1.2);
      if (chance(0.5)) add(15, 'o', 0.8);
      break;
    case 'sub':
      if (chance(0.5)) add(0, 'r', 15);
      else { add(0, 'r', 11); add(12, '5', 3.5); }
      break;
    case 'roll':
      for (let i = 0; i < 16; i++) if (i % 4 !== 1) add(i, i === 8 && chance(0.5) ? 'o' : 'r', 0.9);
      break;
    case 'chip':
      for (let i = 0; i < 16; i += 2) add(i, (['r', 'o', '5', 'o'] as const)[(i / 2) % 4], 1.5);
      break;
  }
  return b;
}

/** a 4-bar phrase in eighths: a one-bar cell, a varied answer, the cell again, then a cadence */
function makePhrase(r: () => number, density: number): (number | null)[] {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const tones = [0, 2, 4, 4, 7, 6, 5, 9, 2, 1, 3];
  const cell: (number | null)[] = Array.from({ length: 8 }, (_, i) => (r() < (i % 2 ? density - 0.1 : density + 0.15) ? pick(tones) : null));
  if (!cell.some(x => x !== null)) cell[0] = pick([0, 2, 4]);
  const vary = (amt: number) => cell.map((d, i) => (i >= 4 ? (d === null ? (r() < amt ? pick([0, 2, 4]) : null) : d + pick([-1, 0, 0, 1, 2])) : d));
  const cadence: (number | null)[] = [cell[0] ?? pick([4, 2]), null, pick([4, 5, 3]), r() < density ? pick([3, 2]) : null, pick([0, 2, 4, 7]), null, null, null];
  return [...cell, ...vary(0.5), ...(r() < 0.5 ? cell : vary(0.3)), ...cadence];
}

function makeForm(form: Form, r: () => number, keysOn: boolean): Section[] {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const chance = (p: number) => r() < p;
  const L = (drums: 0 | 1 | 2, bass: boolean, pad: boolean, keys: boolean, arp: boolean, lead: boolean, extra: Partial<Layers> = {}): Layers =>
    ({ drums, bass, pad, keys, arp, lead, ...extra });
  let s: Section[];
  switch (form) {
    case 'song': {
      const up = chance(0.45) ? pick([1, 2]) : 0;
      s = [
        { name: 'Intro', bars: 4, prog: 'A', layers: L(0, false, true, keysOn, !keysOn, false), energy: 0.25 },
        { name: 'Verse', bars: 8, prog: 'A', layers: L(1, true, true, keysOn, false, false), energy: 0.45 },
        { name: 'Pre-chorus', bars: 4, prog: 'C', layers: L(2, true, true, keysOn, true, false), energy: 0.65, riser: true, gap: chance(0.5) },
        { name: 'Chorus', bars: 8, prog: 'B', layers: L(2, true, true, true, chance(0.6), true), energy: 0.9, hook: true },
        { name: 'Verse II', bars: 8, prog: 'A', layers: L(2, true, true, keysOn, true, false), energy: 0.55 },
        { name: 'Pre-chorus', bars: 4, prog: 'C', layers: L(2, true, true, keysOn, true, false), energy: 0.7, riser: true, gap: chance(0.5) },
        { name: 'Chorus II', bars: 8, prog: 'B', layers: L(2, true, true, true, true, true), energy: 0.95, hook: true },
        { name: 'Bridge', bars: 8, prog: chance(0.5) ? 'C' : 'A', layers: L(chance(0.5) ? 1 : 0, true, true, true, false, true, { improv: true }), energy: 0.4, filter: chance(0.4), riser: chance(0.6), gap: chance(0.4) },
        { name: up ? 'Final Chorus ↑' : 'Final Chorus', bars: pick([8, 16]), prog: 'B', layers: L(2, true, true, true, true, true), energy: 1, hook: true, shift: up },
        { name: 'Outro', bars: 8, prog: 'A', layers: L(1, true, true, keysOn, false, false), energy: 0.35, shift: up },
      ];
      break;
    }
    case 'club':
      s = [
        { name: 'Intro', bars: 8, prog: 'A', layers: L(1, false, false, false, false, false, { perc: true }), energy: 0.3 },
        { name: 'Intro II', bars: 8, prog: 'A', layers: L(2, true, false, false, false, false, { perc: true }), energy: 0.45 },
        { name: 'Groove', bars: 16, prog: 'A', layers: L(2, true, true, keysOn || chance(0.5), false, false), energy: 0.6 },
        { name: 'Break', bars: 8, prog: 'B', layers: L(0, false, true, true, true, false), energy: 0.3, filter: true, riser: true, gap: true },
        { name: 'Drop', bars: 16, prog: 'B', layers: L(2, true, true, true, true, true), energy: 1, hook: true },
        { name: 'Groove II', bars: 8, prog: 'A', layers: L(2, true, true, true, false, false, { improv: true }), energy: 0.65 },
        { name: 'Break II', bars: 8, prog: 'C', layers: L(0, false, true, true, false, true, { improv: true }), energy: 0.35, riser: true, gap: chance(0.6) },
        { name: 'Drop II', bars: 16, prog: 'B', layers: L(2, true, true, true, true, true), energy: 1, hook: true },
        { name: 'Outro', bars: 8, prog: 'A', layers: L(2, true, false, false, false, false, { perc: true }), energy: 0.5 },
        { name: 'Outro II', bars: 8, prog: 'A', layers: L(1, false, false, false, false, false, { perc: true }), energy: 0.3 },
      ];
      if (chance(0.4)) s.splice(5, 2); // skip the second break
      break;
    case 'loop':
      s = [
        { name: 'Intro', bars: 4, prog: 'A', layers: L(0, false, true, true, false, false), energy: 0.25 },
        { name: 'A', bars: 8, prog: 'A', layers: L(2, true, true, true, false, false), energy: 0.5 },
        { name: 'B', bars: 8, prog: 'B', layers: L(2, true, true, true, chance(0.5), true), energy: 0.7, hook: true },
        { name: 'A II', bars: 8, prog: 'A', layers: L(2, true, true, true, true, false, { perc: true }), energy: 0.55 },
        { name: 'Solo', bars: 8, prog: chance(0.5) ? 'B' : 'C', layers: L(1, true, true, true, false, true, { improv: true }), energy: 0.6, gap: chance(0.3) },
        { name: 'B II', bars: 8, prog: 'B', layers: L(2, true, true, true, true, true), energy: 0.75, hook: true },
        { name: 'Outro', bars: 8, prog: 'A', layers: L(1, true, true, true, false, false), energy: 0.3 },
      ];
      break;
    case 'ambient':
      s = [
        { name: 'Rise', bars: 8, prog: 'A', layers: L(0, false, true, false, false, false), energy: 0.15 },
        { name: 'Drift', bars: 16, prog: 'A', layers: L(0, true, true, true, false, false), energy: 0.3 },
        { name: 'Bloom', bars: 16, prog: 'B', layers: L(chance(0.6) ? 1 : 0, true, true, true, true, true), energy: 0.5, hook: true },
        { name: 'Still', bars: 8, prog: 'C', layers: L(0, false, true, true, false, false), energy: 0.2 },
        { name: 'Drift II', bars: 16, prog: 'A', layers: L(0, true, true, false, true, true, { improv: true }), energy: 0.35 },
        { name: 'Fade', bars: 8, prog: 'A', layers: L(0, false, true, true, false, false), energy: 0.15 },
      ];
      break;
    default:
      s = [
        { name: 'Intro', bars: pick([4, 8]), prog: 'A', layers: L(0, false, true, keysOn, !keysOn, false), energy: 0.25 },
        { name: 'Groove', bars: 8, prog: 'A', layers: L(1, true, true, keysOn, false, false), energy: 0.5 },
        { name: 'Lift', bars: 8, prog: 'A', layers: L(2, true, true, keysOn, true, false), energy: 0.65, riser: chance(0.5), gap: chance(0.3) },
        { name: 'Hook', bars: pick([8, 16]), prog: 'B', layers: L(2, true, true, true, chance(0.6), true), energy: 0.9, hook: true },
        { name: 'Breakdown', bars: pick([4, 8]), prog: chance(0.5) ? 'C' : 'B', layers: L(0, chance(0.4), true, true, chance(0.5), false), energy: 0.3, filter: chance(0.4) },
        { name: 'Groove II', bars: 8, prog: 'A', layers: L(2, true, true, keysOn, true, chance(0.3), { improv: true }), energy: 0.7, riser: chance(0.4) },
        { name: 'Hook II', bars: pick([8, 16]), prog: 'B', layers: L(2, true, true, true, true, true), energy: 1, hook: true },
        { name: 'Outro', bars: 8, prog: 'A', layers: L(1, true, true, keysOn, false, false), energy: 0.35 },
      ];
      if (chance(0.35)) s.splice(5, 1);
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i].layers.drums === 2) s[i].fill = pick<Fill>(['roll', 'roll', 'tom', 'kick', 'open', 'none']);
    if (i < s.length - 2 && !s[i].riser && chance(0.2)) s[i].throw = true;
  }
  return s;
}

function composeSong(seed: number, style: Style, tonic?: number, custom?: Partial<CustomSongParams>): Song {
  const S = STYLES[style] ?? STYLES.synthwave;
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const chance = (p: number) => r() < p;
  const range = ([a, b]: readonly [number, number]) => a + r() * (b - a);

  const lofi = custom?.lofi !== undefined ? custom.lofi : range(S.lofi);
  const mode = custom?.mode && MODES[custom.mode] ? custom.mode : pick(S.modes);
  const scale = MODES[mode] ?? MODES.minor;
  const pc = Math.floor(r() * 12);
  const tpc = tonic === undefined ? (custom?.tonic !== undefined ? mod(custom.tonic, 12) : pc) : mod(tonic, 12);
  const root = 38 + mod(tpc - 2, 12); // D2..C♯3
  const bpm = custom?.bpm !== undefined ? custom.bpm : Math.round(range(S.bpm));
  const swing = range(S.swing);
  const chordSize = 3 + ['triad', 'seventh', 'ninth'].indexOf(wpick({ triad: S.ext[0], seventh: S.ext[1], ninth: S.ext[2] }, r));
  const hr = pick(S.hr);
  const pool = PROGS[mode];
  const progA = pick(pool);
  let progB = pick(pool);
  for (let i = 0; i < 4 && progB === progA; i++) progB = pick(pool);
  let progC = pick(pool);
  for (let i = 0; i < 6 && (progC === progA || progC === progB); i++) progC = pick(pool);

  const groove = custom?.groove ?? pick(S.grooves);
  const drumsA = makeDrums(groove, r, lofi);
  const drumsB = densify(drumsA, groove, r);
  const bass = makeBass(pick(S.bass), r);
  const pad = custom?.pad ?? pick(S.pads), keys = custom?.keys ?? pick(S.keys), arp = custom?.arp ?? pick(S.arps), lead = custom?.lead ?? pick(S.leads);
  const arpShape = pick(['up', 'down', 'updown', 'shuffle'] as const);
  const arpRate = pick(S.arpRates);
  const arpOrder = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => r() - 0.5);
  const phrase = makePhrase(r, S.density);
  const rhythms = KEYS_RHYTHMS[keys] ?? KEYS_RHYTHMS.rhodes;
  const keysRhythm = keys === 'rhodes' ? (lofi > 0.5 ? pick(rhythms.slice(0, 4)) : pick(rhythms.slice(4))) : pick(rhythms);
  const form = custom?.form ?? pick(S.forms);
  const sections = makeForm(form, r, chance(S.keysOn));

  const nouns = [...NOUN, ...(STYLE_NOUNS[style] ?? []), ...(STYLE_NOUNS[style] ?? [])];
  const title = custom?.title || (chance(0.75) ? `${pick(ADJ)} ${pick(nouns)}${pick(TAGS)}` : `${pick(nouns)} ${pick(TAILS)}`);
  const flat = style === 'chiptune' || style === 'ambient' || style === 'dungeonsynth';
  return {
    title, seed, style, tonic: tpc, key: NOTE_NAMES[tpc], mode: mode === 'harmonic' ? 'harmonic minor' : mode, bpm, lofi,
    bars: sections.reduce((n, s) => n + s.bars, 0), form,
    root, scale, progs: { A: progA, B: progB, C: progC }, hr, chordSize, swing, sections,
    drumsA, drumsB, kit: S.kit, pump: (style === 'ambient' || style === 'dungeonsynth') ? 0 : 0.2 + (1 - lofi) * (flat ? 0.15 : 0.45),
    bass, bassTone: custom?.bassTone ?? S.bassTone, pad, keys, arp, lead, arpShape, arpRate, arpOrder, arpSkip: S.arpSkip,
    phrase, density: S.density, keysRhythm, padCutoff: 700 + (1 - lofi) * 1400 + r() * 400,
  };
}

const infoOf = (s: Song): SongInfo => ({ title: s.title, seed: s.seed, style: s.style, tonic: s.tonic, key: s.key, mode: s.mode, bpm: s.bpm, lofi: s.lofi, bars: s.bars, form: s.form });

function sectionAt(song: Song, bar: number) {
  let b = bar;
  for (let i = 0; i < song.sections.length; i++) {
    const s = song.sections[i];
    if (b < s.bars) return { s, i, barIn: b };
    b -= s.bars;
  }
  const i = song.sections.length - 1;
  return { s: song.sections[i], i, barIn: song.sections[i].bars - 1 };
}

/** worker-driven ticks keep scheduling steady when the tab is in the background */
function makeTicker(cb: () => void, ms: number) {
  try {
    const url = URL.createObjectURL(new Blob(['let id;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}'], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = cb;
    return { start: () => w.postMessage(ms), stop: () => w.postMessage(0) };
  } catch {
    let id = 0;
    return { start: () => { clearInterval(id); id = window.setInterval(cb, ms); }, stop: () => clearInterval(id) };
  }
}

export type PulseKind = 'kick' | 'snare' | 'hat' | 'chord' | 'bar';

interface Plan { kind: TransitionKind; next: Song; startStep: number; steps: number; fired: boolean }

interface Deck {
  song: Song;
  step: number; endStep: number; nextTime: number;
  bpm: number; glide: { from: number; to: number; at: number; over: number } | null;
  beat: number; anchor: { t: number; beat: number; bpm: number };
  sum: GainNode;
  eqLow: BiquadFilterNode; eqMid: BiquadFilterNode; eqHigh: BiquadFilterNode;
  low: BiquadFilterNode; hp: BiquadFilterNode; lp: BiquadFilterNode; out: GainNode;
  drumBus: GainNode; pumpBus: GainNode; melodyBus: GainNode;
  stems: Record<StemId, GainNode>;
  rev: GainNode; dly: GainNode; throwSend: GainNode;
  pitch: GainNode; bend: ConstantSourceNode;
  mut: { hatShift: number; kickExtra: number; arpOct: number };
  chord: number[];
  improv: Map<number, (number | null)[]>;
  plan: Plan | null;
  rollFrom: number; rollUntil: number; boostFrom: number; boostUntil: number;
  retired: boolean;
}

const BASS_KILL_DB = -40;
// per-style level trim so the station stays even across styles (measured offline)
const TRIM: Partial<Record<Style, number>> = {
  lofi: 0.78, house: 0.8, jazzhop: 0.9, cyberpunk: 0.85, futurefunk: 0.82, dubtechno: 0.88, dungeonsynth: 0.95,
};

class Engine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  state: DJState = {
    playing: false, song: null, section: '', bar: 0, totalBars: 0, bpm: 120, next: null, nextVia: null, note: '', history: [],
    weights: Object.fromEntries(STYLE_IDS.map(s => [s, 1])) as Record<Style, number>,
    stems: {
      drums: { muted: false, solo: false, volume: 1 },
      bass: { muted: false, solo: false, volume: 1 },
      keys: { muted: false, solo: false, volume: 1 },
      pad: { muted: false, solo: false, volume: 1 },
      arp: { muted: false, solo: false, volume: 1 },
      lead: { muted: false, solo: false, volume: 1 },
    },
    eq: { low: 0, mid: 0, high: 0, lowKill: false, midKill: false, highKill: false },
    crossfader: 0,
    recording: false,
    recordingDuration: 0,
    filter: 0,
    bassKill: false,
    station: 'auto',
    samplerVolume: 1.2,
  };
  vibe: Vibe = 'auto';
  talk = false;
  chordIndex = 0;
  private listeners = new Set<(s: DJState) => void>();
  private ticker = makeTicker(() => this.tick(), 40);
  private volume = 0.6;
  private decks: Deck[] = [];
  private main: Deck | null = null;
  private queued: Song[] = [];
  private setPos = 0;
  private setPhase = Math.random() * Math.PI * 2;
  private pulses: Record<PulseKind, number[]> = { kick: [], snare: [], hat: [], chord: [], bar: [] };

  // graph
  private master!: GainNode;
  private duck!: GainNode;
  private mix!: GainNode;
  private killEq!: BiquadFilterNode;
  private djLp!: BiquadFilterNode;
  private djHp!: BiquadFilterNode;
  private fxBus!: GainNode;
  private samplerBus!: GainNode;
  private samplerVolume = 1.2;

  private reverbIn!: GainNode;
  private verbOut!: GainNode;
  private delayIn!: GainNode;
  private delay!: DelayNode;
  private fb!: GainNode;
  private tone!: BiquadFilterNode;
  private crackleGain!: GainNode;
  private wobble!: GainNode;
  private noise!: AudioBuffer;
  private pw!: Record<'p12' | 'p25', PeriodicWave>;
  private top = 20000;

  subscribe(fn: (s: DJState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }
  setSamplerVolume(v: number) {
    this.samplerVolume = Math.max(0, Math.min(2.5, v));
    if (this.ctx && this.samplerBus) {
      this.samplerBus.gain.setTargetAtTime(this.samplerVolume, this.ctx.currentTime, 0.02);
    }
    this.emit({ samplerVolume: this.samplerVolume });
  }
  private emit(patch: Partial<DJState>) {
    this.state = { ...this.state, ...patch };
    const song = this.state.song;
    djLive.publish({ playing: this.state.playing, song: song ? { title: song.title, bpm: song.bpm } : null });
    this.listeners.forEach(f => f(this.state));
  }
  /** run fn when the audio clock reaches t */
  private later(t: number, fn: () => void) {
    setTimeout(fn, Math.max(0, (t - (this.ctx?.currentTime ?? 0)) * 1000));
  }
  private note(text: string, at?: number) {
    if (at === undefined) this.emit({ note: text });
    else this.later(at, () => this.emit({ note: text }));
  }

  /** seconds since the most recent event of `kind`, or Infinity */
  since(kind: PulseKind) {
    if (!this.ctx) return Infinity;
    const now = this.ctx.currentTime;
    const q = this.pulses[kind];
    for (let i = q.length - 1; i >= 0; i--) if (q[i] <= now) return now - q[i];
    return Infinity;
  }
  /** start times of recent events (already sounding), newest last */
  recent(kind: PulseKind) {
    const now = this.ctx?.currentTime ?? 0;
    return this.pulses[kind].filter(t => t <= now);
  }
  /** beats elapsed on the main deck, for tempo-synced visuals */
  beats() {
    const d = this.main;
    if (!this.ctx || !d) return 0;
    return Math.max(0, d.anchor.beat + (this.ctx.currentTime - d.anchor.t) * d.anchor.bpm / 60);
  }
  /** visualizer hues for the current style */
  palette() { return STYLES[this.main?.song.style ?? 'synthwave'].hues; }
  private mark(kind: PulseKind, t: number) {
    const q = this.pulses[kind];
    q.push(t);
    if (q.length > 24) q.shift();
  }

  // ── controls ────────────────────────────────────────────────────────────
  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.05);
  }
  setTalk(on: boolean) {
    this.talk = on;
    if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
  }
  setWeights(w: Partial<Record<Style, number>>) { this.emit({ weights: { ...this.state.weights, ...w } }); }

  /** pick a station; the up-next song is re-planned so the change shows immediately */
  setVibe(v: Vibe) {
    if (v === this.vibe) return;
    this.vibe = v;
    if (this.main && !this.main.plan?.fired && this.queued.length === 0) this.replan(this.main);
  }

  async play() {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    try {
      await ctx.resume();
    } catch { /* browser autoplay restriction pending gesture */ }
    if (!this.main) this.start(this.queued.shift() ?? this.pickNext(null), ctx.currentTime + 0.1);
    else {
      const lag = Math.max(0, ctx.currentTime + 0.05 - Math.min(...this.decks.map(d => d.nextTime)));
      for (const d of this.decks) d.nextTime += lag;
    }
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(this.volume * this.volume, ctx.currentTime, 0.15);
    this.ticker.start();
    this.emit({ playing: true });
    this.mediaSession();
  }

  pause() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.ticker.stop();
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    setTimeout(() => { if (!this.state.playing) ctx.suspend(); }, 700);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.emit({ playing: false });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  toggle() { return this.state.playing ? this.pause() : this.play(); }

  /** mix out of the current song early, by default with a quick echo out, brake or filter sweep */
  async skip(kind?: TransitionKind, penalize = true) {
    if (!this.ctx || !this.main) return this.play();
    if (!this.state.playing) await this.play();
    const d = this.main;
    if (d.plan?.fired) { this.note('Already mixing…'); return; }
    if (penalize && d.step < d.song.bars * 16 * 0.3) this.steer(d.song.style, 0.88);
    const k = kind ?? wpick({ echo: 0.45, brake: 0.25, filter: 0.3 } as Record<TransitionKind, number>);
    const next = d.plan?.next ?? this.queued.shift() ?? this.pickNext(d.song);
    const beatStep = Math.ceil(d.step / 4) * 4;
    const barStep = Math.ceil(d.step / 16) * 16;
    if (k === 'filter') d.plan = { kind: k, next, startStep: barStep, steps: 32, fired: false };
    else if (k === 'brake') d.plan = { kind: k, next, startStep: beatStep, steps: 8, fired: false };
    else if (k === 'blend') d.plan = { kind: k, next, startStep: barStep, steps: 64, fired: false };
    else d.plan = { kind: 'echo', next, startStep: beatStep, steps: 4, fired: false };
    this.emit({ next: infoOf(next), nextVia: d.plan.kind });
  }

  /** queue a remembered song; `now` mixes into it straight away */
  playSong(info: SongInfo, now = true) {
    const song = composeSong(info.seed, info.style, info.tonic);
    if (!this.main) { this.queued.unshift(song); return this.play(); }
    if (!now) {
      this.queued.push(song);
      if (!this.main.plan?.fired && this.queued.length === 1) this.replan(this.main);
      return;
    }
    if (this.main.plan?.fired) { this.queued.unshift(song); return; }
    this.main.plan = { ...(this.main.plan ?? this.planFor(this.main)), next: song };
    return this.skip(undefined, false);
  }

  /** let the DJ pick a different next song */
  reroll() {
    const d = this.main;
    if (!d || d.plan?.fired) return;
    this.queued = [];
    this.replan(d);
  }

  like() {
    const d = this.main;
    if (!d) return null;
    this.steer(d.song.style, 1.3);
    return infoOf(d.song);
  }

  private steer(style: Style, f: number) {
    const w = this.state.weights;
    this.emit({ weights: { ...w, [style]: Math.min(3, Math.max(0.25, w[style] * f)) } });
  }

  // live performance FX ─ all act on the main deck
  setFilter(x: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const lp = x < -0.03 ? this.top * Math.pow(160 / this.top, -x) : this.top;
    const hp = x > 0.03 ? 20 * Math.pow(2400 / 20, x) : 20;
    this.djLp.frequency.setTargetAtTime(lp, t, 0.03);
    this.djHp.frequency.setTargetAtTime(hp, t, 0.03);
    this.djLp.Q.setTargetAtTime(x < -0.03 ? 1 + -x * 7 : 0.7, t, 0.05);
    this.djHp.Q.setTargetAtTime(x > 0.03 ? 1 + x * 6 : 0.7, t, 0.05);
  }
  setBassKill(on: boolean) {
    if (this.ctx) this.killEq.gain.setTargetAtTime(on ? BASS_KILL_DB : 0, this.ctx.currentTime, 0.02);
  }
  /** two-bar build from the next downbeat: riser, high-pass sweep, snare roll, then a boosted drop */
  buildUp() {
    const d = this.main;
    if (!this.ctx || !d || !this.state.playing || d.plan?.fired) return;
    const sd = 60 / d.bpm / 4;
    const at = Math.ceil(d.step / 16) * 16;
    const T = d.nextTime + (at - d.step) * sd;
    const end = T + 32 * sd;
    this.riser(T, end);
    d.hp.frequency.cancelScheduledValues(T);
    d.hp.frequency.setValueAtTime(30, T);
    d.hp.frequency.exponentialRampToValueAtTime(1100, end - 0.02);
    d.hp.frequency.setValueAtTime(20, end);
    d.rollFrom = at + 16; d.rollUntil = at + 32;
    d.boostFrom = at + 32; d.boostUntil = at + 32 + 8 * 16;
    this.crash(end, 1);
    this.note('Building…', T);
    this.note('Drop', end);
  }
  echoThrow() {
    const d = this.main;
    if (!this.ctx || !d || !this.state.playing) return;
    this.throwAt(d, this.ctx.currentTime + 0.02, 60 / d.bpm);
    this.note('Echo throw');
  }

  // ── audio graph ──────────────────────────────────────────────────────────
  private build() {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    this.top = Math.min(20000, ctx.sampleRate * 0.45); // "filter open", kept below Nyquist

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.duck = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
    shaper.curve = curve;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass'; this.tone.frequency.value = 14000; this.tone.Q.value = 0.3;
    this.killEq = ctx.createBiquadFilter(); this.killEq.type = 'lowshelf'; this.killEq.frequency.value = 220;
    this.djLp = ctx.createBiquadFilter(); this.djLp.type = 'lowpass'; this.djLp.frequency.value = this.top;
    this.djHp = ctx.createBiquadFilter(); this.djHp.type = 'highpass'; this.djHp.frequency.value = 20;
    this.mix = ctx.createGain();
    this.mix.gain.value = 0.8;
    this.mix.connect(this.killEq).connect(this.djLp).connect(this.djHp).connect(this.tone).connect(shaper).connect(comp).connect(this.duck).connect(this.master);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.8;
    this.master.connect(this.analyser).connect(ctx.destination);
    this.fxBus = ctx.createGain(); this.fxBus.connect(this.mix);

    this.samplerBus = ctx.createGain();
    this.samplerBus.gain.value = this.samplerVolume;
    const samplerComp = ctx.createDynamicsCompressor();
    samplerComp.threshold.value = -4;
    samplerComp.knee.value = 6;
    samplerComp.ratio.value = 6;
    samplerComp.attack.value = 0.002;
    samplerComp.release.value = 0.12;
    this.samplerBus.connect(samplerComp).connect(this.master);

    // reverb: generated stereo impulse
    const len = ctx.sampleRate * 3.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    this.reverbIn = ctx.createGain(); this.reverbIn.gain.value = 0.5;
    this.verbOut = ctx.createGain(); this.verbOut.gain.value = 0.55;
    const verbHp = ctx.createBiquadFilter(); verbHp.type = 'highpass'; verbHp.frequency.value = 250;
    this.reverbIn.connect(verbHp).connect(verb).connect(this.verbOut).connect(this.mix);

    // tape-ish feedback delay
    this.delayIn = ctx.createGain(); this.delayIn.gain.value = 0.5;
    this.delay = ctx.createDelay(3);
    this.fb = ctx.createGain(); this.fb.gain.value = 0.38;
    const fbLp = ctx.createBiquadFilter(); fbLp.type = 'lowpass'; fbLp.frequency.value = 2400;
    const delayOut = ctx.createGain(); delayOut.gain.value = 0.45;
    this.delayIn.connect(this.delay).connect(fbLp).connect(this.fb).connect(this.delay);
    fbLp.connect(delayOut).connect(this.mix);
    delayOut.connect(this.reverbIn);

    // shared noise + vinyl crackle loop
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const cr = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate);
    const cd = cr.getChannelData(0);
    for (let i = 0; i < cd.length; i++) {
      cd[i] = (Math.random() * 2 - 1) * 0.04;
      if (Math.random() < 0.0004) { const amp = Math.random() * 0.9; for (let k = 0; k < 40 && i + k < cd.length; k++) cd[i + k] += amp * (Math.random() * 2 - 1) * Math.exp(-k / 6); }
    }
    const crackle = ctx.createBufferSource();
    crackle.buffer = cr; crackle.loop = true;
    const crBp = ctx.createBiquadFilter(); crBp.type = 'bandpass'; crBp.frequency.value = 3200; crBp.Q.value = 0.5;
    this.crackleGain = ctx.createGain(); this.crackleGain.gain.value = 0;
    crackle.connect(crBp).connect(this.crackleGain).connect(this.mix);
    crackle.start();

    // tape wow: one LFO feeds every deck's pitch bus
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.42;
    this.wobble = ctx.createGain(); this.wobble.gain.value = 0;
    lfo.connect(this.wobble); lfo.start();

    // NES-style pulse waves
    const pulse = (duty: number) => {
      const n = 48, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      return ctx.createPeriodicWave(re, im);
    };
    this.pw = { p12: pulse(0.125), p25: pulse(0.25) };
  }

  private addDeck(song: Song, at: number, opts: { bpm?: number; startBar?: number; fadeIn?: number; glideAt?: number } = {}) {
    const ctx = this.ctx!;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type: BiquadFilterType, f: number) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = 0.7; return n; };
    const sum = g(TRIM[song.style] ?? 1);
    const eqLow = bq('lowshelf', 250);
    const eqMid = bq('peaking', 1000); eqMid.Q.value = 1.0;
    const eqHigh = bq('highshelf', 4000);
    const low = bq('lowshelf', 220), hp = bq('highpass', 20), lp = bq('lowpass', this.top), out = g();
    sum.connect(eqLow).connect(eqMid).connect(eqHigh).connect(low).connect(hp).connect(lp).connect(out).connect(this.mix);
    const drumBus = g(0.9), pumpBus = g(), melodyBus = g();
    drumBus.connect(sum); pumpBus.connect(sum); melodyBus.connect(sum);
    const stems: Record<StemId, GainNode> = {
      drums: g(1), bass: g(1), keys: g(1), pad: g(1), arp: g(1), lead: g(1),
    };
    stems.drums.connect(drumBus);
    stems.bass.connect(pumpBus);
    stems.pad.connect(pumpBus);
    stems.keys.connect(melodyBus);
    stems.arp.connect(melodyBus);
    stems.lead.connect(melodyBus);

    // Apply current stems
    const anySolo = Object.values(this.state.stems).some(s => s.solo);
    for (const [sid, stm] of Object.entries(this.state.stems) as [StemId, StemState][]) {
      const active = anySolo ? stm.solo : !stm.muted;
      stems[sid].gain.value = active ? stm.volume : 0;
    }
    // Apply current EQ
    eqLow.gain.value = this.state.eq.lowKill ? BASS_KILL_DB : this.state.eq.low;
    eqMid.gain.value = this.state.eq.midKill ? -30 : this.state.eq.mid;
    eqHigh.gain.value = this.state.eq.highKill ? -30 : this.state.eq.high;

    const rev = g(), dly = g(), throwSend = g(0);
    rev.connect(this.reverbIn); dly.connect(this.delayIn);
    sum.connect(throwSend).connect(this.delayIn);
    const pitch = g();
    this.wobble.connect(pitch);
    const bend = ctx.createConstantSource();
    bend.offset.value = 0;
    bend.connect(pitch);
    bend.start(at);
    const startStep = (opts.startBar ?? 0) * 16;
    const bpm = opts.bpm ?? song.bpm;
    if (opts.fadeIn) { out.gain.setValueAtTime(0, at); out.gain.linearRampToValueAtTime(1, at + opts.fadeIn); }
    const d: Deck = {
      song, step: startStep, endStep: song.bars * 16, nextTime: at,
      bpm, glide: bpm !== song.bpm ? { from: bpm, to: song.bpm, at: opts.glideAt ?? startStep, over: 128 } : null,
      beat: 0, anchor: { t: at, beat: 0, bpm },
      sum, eqLow, eqMid, eqHigh, low, hp, lp, out, drumBus, pumpBus, melodyBus, stems, rev, dly, throwSend, pitch, bend,
      mut: { hatShift: 0, kickExtra: -1, arpOct: 0 }, chord: [], improv: new Map(),
      plan: null, rollFrom: -1, rollUntil: -1, boostFrom: -1, boostUntil: -1, retired: false,
    };
    this.decks.push(d);
    d.plan = this.planFor(d);
    return d;
  }

  private retire(d: Deck) {
    if (d.retired) return;
    d.retired = true;
    this.decks = this.decks.filter(x => x !== d);
    const wait = Math.max(0, d.nextTime - (this.ctx?.currentTime ?? 0)) + 5;
    setTimeout(() => {
      try { d.out.disconnect(); d.rev.disconnect(); d.dly.disconnect(); d.throwSend.disconnect(); this.wobble.disconnect(d.pitch); d.bend.stop(); } catch { /* already gone */ }
    }, wait * 1000);
  }

  /** start fresh (first play): no mix, just a short fade in */
  private start(song: Song, at: number) {
    for (const d of [...this.decks]) { d.out.gain.setTargetAtTime(0, at, 0.1); this.retire(d); }
    const d = this.addDeck(song, at, { fadeIn: 4 * 60 / song.bpm });
    this.main = d;
    this.handover(null, d, at, `On air: ${STYLES[song.style].label}`);
  }

  private applySongFX(song: Song, at: number) {
    const chip = song.style === 'chiptune';
    this.delay.delayTime.setTargetAtTime((60 / song.bpm) * 0.75, at, 0.4); // dotted eighth
    this.tone.frequency.setTargetAtTime(15000 - song.lofi * 8500, at, 0.8);
    this.crackleGain.gain.setTargetAtTime(chip ? 0 : 0.05 + song.lofi * 0.4, at, 1);
    this.wobble.gain.setTargetAtTime(chip ? 0 : 3 + song.lofi * 14, at, 1);
    this.verbOut.gain.setTargetAtTime(song.style === 'ambient' ? 0.95 : song.style === 'chiptune' ? 0.3 : 0.55, at, 1);
  }

  /** `to` becomes the deck the UI, visuals and live FX follow, from time `at` */
  private handover(from: Deck | null, to: Deck, at: number, note: string) {
    this.applySongFX(to.song, at);
    this.later(at, () => {
      if (to.retired) return;
      this.main = to;
      const info = infoOf(to.song);
      const history = [info, ...this.state.history.filter(h => !(h.seed === info.seed && h.style === info.style))].slice(0, 30);
      this.emit({
        song: info, history, note, section: sectionAt(to.song, Math.floor(to.step / 16)).s.name, bar: Math.floor(to.step / 16),
        totalBars: to.song.bars, bpm: Math.round(to.bpm),
        next: to.plan ? infoOf(to.plan.next) : null, nextVia: to.plan?.kind ?? null,
      });
      this.mediaSession();
      this.announce(from?.song ?? null, to.song);
    });
  }

  // ── the DJ's brain ──────────────────────────────────────────────────────
  private pickStyle(cur: Song | null): Style {
    if (this.vibe !== 'auto') return this.vibe;
    // energy arc over roughly nine songs, with a little wander
    this.setPos++;
    const target = 0.5 + 0.38 * Math.sin(this.setPos * 2 * Math.PI / 9 + this.setPhase) + (Math.random() - 0.5) * 0.15;
    const recent = this.state.history.slice(0, 3).map(h => h.style);
    const w = {} as Record<Style, number>;
    for (const s of STYLE_IDS) {
      let x = Math.exp(-((STYLES[s].energy - target) ** 2) / 0.06) * this.state.weights[s];
      if (cur && s === cur.style) x *= 0.45;
      else if (recent.includes(s)) x *= 0.7;
      w[s] = x + 0.002;
    }
    return wpick(w);
  }

  private pickNext(cur: Song | null): Song {
    const style = this.pickStyle(cur);
    // harmonic mixing: same key, a fifth either way, relative major/minor or a step
    const tonic = cur && Math.random() < 0.75 ? mod(cur.tonic + [0, 0, 7, 5, 3, -3, 2][Math.floor(Math.random() * 7)], 12) : undefined;
    return composeSong((Math.random() * 2 ** 31) | 0, style, tonic);
  }

  private chooseTransition(a: Song, b: Song): TransitionKind {
    if (a.style === 'ambient' || b.style === 'ambient') return 'blend';
    const close = Math.abs(a.bpm - b.bpm) <= 14;
    return wpick((close ? { blend: 0.55, filter: 0.2, echo: 0.17, brake: 0.08 } : { blend: 0, filter: 0.35, echo: 0.4, brake: 0.25 }) as Record<TransitionKind, number>);
  }

  private planFor(d: Deck, next?: Song): Plan {
    const song = d.song;
    const nx = next ?? this.queued.shift() ?? this.pickNext(song);
    const kind = this.chooseTransition(song, nx);
    const end = song.bars * 16;
    const steps = kind === 'blend' ? (song.form === 'club' && nx.form === 'club' ? 256 : 128) : kind === 'filter' ? 64 : 16;
    return { kind, next: nx, startStep: end - steps, steps, fired: false };
  }

  private replan(d: Deck) {
    const p = this.planFor(d);
    const barStep = Math.ceil(d.step / 16) * 16;
    if (p.startStep < barStep) { p.kind = 'echo'; p.startStep = Math.max(barStep, d.song.bars * 16 - 16); p.steps = 16; }
    d.plan = p;
    this.emit({ next: infoOf(p.next), nextVia: p.kind });
  }

  /** the outgoing deck reached its plan: start the incoming deck and automate the mix */
  private fire(d: Deck, T: number, stepDur: number) {
    const p = d.plan!;
    p.fired = true;
    const beat = stepDur * 4;
    const len = p.steps * stepDur;
    const next = p.next;
    const label = STYLES[next.style].label;
    const firstDrums = Math.max(0, next.sections.findIndex(s => s.layers.drums > 0));
    const dropBar = next.sections.slice(0, firstDrums).reduce((n, s) => n + s.bars, 0);
    const fadeOut = (from: number, to: number) => {
      for (const gn of [d.out, d.rev, d.dly]) { gn.gain.setValueAtTime(1, from); gn.gain.linearRampToValueAtTime(0.0001, to); }
    };
    d.endStep = p.startStep + p.steps;
    switch (p.kind) {
      case 'blend': {
        const mid = T + len / 2, end = T + len;
        // beatmatch when the tempos are close; ambient pads can float in at their own tempo
        const sync = Math.abs(d.bpm - next.bpm) <= 16;
        const inc = this.addDeck(next, T, { bpm: sync ? d.bpm : next.bpm, glideAt: p.steps, fadeIn: len / 2 });
        inc.low.gain.setValueAtTime(BASS_KILL_DB, T);
        inc.low.gain.setValueAtTime(BASS_KILL_DB, mid);
        inc.low.gain.linearRampToValueAtTime(0, mid + 0.05);
        d.low.gain.setValueAtTime(0, mid);
        d.low.gain.linearRampToValueAtTime(BASS_KILL_DB, mid + 0.05);
        fadeOut(mid, end);
        const tempo = sync && Math.round(d.bpm) !== next.bpm ? `, riding ${Math.round(d.bpm)}→${next.bpm} BPM` : '';
        this.note(`Blending in ${next.title} (${label})`, T);
        this.handover(d, inc, mid, `Bass swap${tempo}`);
        break;
      }
      case 'echo': {
        const cut = T + len;
        this.throwAt(d, T, len, 0.62);
        fadeOut(cut - 0.04, cut);
        const inc = this.addDeck(next, cut, { startBar: d.step < d.song.bars * 16 - 16 ? dropBar : 0 });
        if (dropBar && inc.step) this.crash(cut, 0.8);
        this.handover(d, inc, cut, `Echo out → ${label}`);
        break;
      }
      case 'brake': {
        const end = T + len;
        const start = Math.max(T, end - beat * 1.5);
        d.bend.offset.setValueAtTime(0, start);
        d.bend.offset.setTargetAtTime(-2400, start, beat * 0.45);
        d.lp.frequency.setValueAtTime(this.top, start);
        d.lp.frequency.exponentialRampToValueAtTime(400, end);
        fadeOut(start + beat * 0.5, end + 0.1);
        const inc = this.addDeck(next, end + 0.2, { startBar: dropBar });
        this.crash(end + 0.2, 0.9);
        this.note('Brake', start);
        this.handover(d, inc, end + 0.2, `Tape brake → ${label}`);
        break;
      }
      case 'filter': {
        const end = T + len;
        d.hp.frequency.setValueAtTime(30, T);
        d.hp.frequency.exponentialRampToValueAtTime(2200, end);
        this.riser(T, end);
        d.rollFrom = p.startStep + p.steps - 16; d.rollUntil = p.startStep + p.steps;
        fadeOut(end - 0.03, end);
        const inc = this.addDeck(next, end, { startBar: dropBar });
        this.crash(end, 1);
        this.note(`Filter sweep → ${next.title}`, T);
        this.handover(d, inc, end, `Dropped into ${label}`);
        break;
      }
    }
  }

  private announce(prev: Song | null, song: Song) {
    if (!this.talk || !('speechSynthesis' in window) || !this.ctx) return;
    const style = STYLES[song.style].label;
    const lines = [
      `Shell B F M. This is ${song.title}.`,
      `You're tuned to Shell B F M. Up now, ${song.title}. ${style} at ${song.bpm}.`,
      prev ? `That was ${prev.title}. Here's ${song.title}.` : `Shell B F M, on the air. Here's ${song.title}.`,
      `${style} on Shell B F M. ${song.title}.`,
    ];
    const u = new SpeechSynthesisUtterance(lines[Math.floor(Math.random() * lines.length)].replace(/[()']/g, ''));
    const voice = speechSynthesis.getVoices().find(v => /^en[-_](US|GB)/i.test(v.lang));
    if (voice) u.voice = voice;
    u.rate = 0.97; u.pitch = 0.85; u.volume = Math.min(1, 0.4 + this.volume);
    const ctx = this.ctx;
    const restore = () => this.duck.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
    u.onstart = () => this.duck.gain.setTargetAtTime(0.4, ctx.currentTime, 0.15);
    u.onend = restore; u.onerror = restore;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  private mediaSession() {
    const song = this.main?.song;
    if (!('mediaSession' in navigator) || !song) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: `Shell:B FM · ${STYLES[song.style].label}`, album: `${song.key} ${song.mode} · ${song.bpm} BPM` });
      navigator.mediaSession.playbackState = this.state.playing ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.skip());
    } catch { /* unsupported action */ }
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || !this.state.playing) return;
    const horizon = ctx.currentTime + (document.hidden ? 1.2 : 0.2);
    // index loop: a deck started by fire() is scheduled in the same tick
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      if (d.nextTime < ctx.currentTime - 0.3) d.nextTime = ctx.currentTime + 0.05; // recovered from a stall
      while (d.nextTime < horizon && d.step < d.endStep) {
        if (d.glide && d.step >= d.glide.at) {
          const k = Math.min(1, (d.step - d.glide.at) / d.glide.over);
          d.bpm = d.glide.from + (d.glide.to - d.glide.from) * k;
          if (k >= 1) d.glide = null;
        }
        const stepDur = 60 / d.bpm / 4;
        if (d.plan && !d.plan.fired && (d.step >= d.plan.startStep || d.step === d.endStep - 1)) {
          d.plan.startStep = Math.min(d.plan.startStep, d.step); // a late re-plan still mixes out
          this.fire(d, d.nextTime, stepDur);
        }
        if (d.step >= d.endStep) break;
        this.scheduleStep(d, d.step, d.nextTime, stepDur);
        d.anchor = { t: d.nextTime, beat: d.beat, bpm: d.bpm };
        d.beat += 0.25;
        d.step++;
        d.nextTime += stepDur;
      }
      if (d.step >= d.endStep) { this.retire(d); i--; }
    }
    if (!this.decks.length && this.main) {
      // nothing left (should not happen); keep the station alive
      this.main = null;
      this.start(this.pickNext(null), ctx.currentTime + 0.2);
    }
  }

  // ── composition at play time ────────────────────────────────────────────
  private chordNotes(song: Song, root: number, degree: number, octave: number, size: number) {
    const out: number[] = [];
    for (let k = 0; k < size; k++) {
      const dg = degree + k * 2;
      out.push(root + 12 * octave + song.scale[dg % 7] + 12 * Math.floor(dg / 7));
    }
    return out;
  }
  private degreeNote(song: Song, root: number, degree: number, octave: number) {
    return root + 12 * (octave + Math.floor(degree / 7)) + song.scale[mod(degree, 7)];
  }
  /** pick the inversion closest to the previous chord so the harmony moves smoothly */
  private voice(prev: number[], notes: number[], center: number) {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const target = prev.length ? avg(prev) : center;
    let best = notes, cost = Infinity;
    for (let inv = 0; inv < notes.length; inv++) {
      for (const oct of [-12, 0, 12]) {
        const v = notes.map((n, i) => n + oct + (i < inv ? 12 : 0)).sort((a, b) => a - b);
        const m = avg(v);
        const c = Math.abs(m - target) + 0.35 * Math.abs(m - center);
        if (c < cost) { cost = c; best = v; }
      }
    }
    return best;
  }
  private snapToChord(deg: number, chordDeg: number, size: number) {
    let best = deg, dist = Infinity;
    for (let k = 0; k < Math.min(size, 4); k++) {
      const base = chordDeg + 2 * k;
      for (const o of [-7, 0, 7, 14]) {
        const c = base + o;
        if (Math.abs(c - deg) < dist) { dist = Math.abs(c - deg); best = c; }
      }
    }
    return best;
  }

  private scheduleStep(d: Deck, step: number, t0: number, stepDur: number) {
    const song = d.song;
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const { s: sec, i: si, barIn } = sectionAt(song, bar);
    const boosted = step >= d.boostFrom && step < d.boostUntil;
    const L: Layers = boosted ? { ...sec.layers, drums: 2, bass: true } : sec.layers;
    const energy = boosted ? Math.max(sec.energy, 0.9) : sec.energy;
    const t = t0 + (s16 % 2 === 1 ? song.swing * stepDur : 0);
    const root = song.root + (sec.shift ?? 0);
    const prog = song.progs[sec.prog];
    const hrSteps = Math.max(8, Math.round(song.hr * 16));
    const pos = barIn * 16 + s16;
    const ci = Math.floor(pos / hrSteps);
    const degree = prog[ci % prog.length];
    const nextDegree = prog[(ci + 1) % prog.length];
    const chordStart = pos % hrSteps === 0;
    const lastBar = barIn === sec.bars - 1;
    const beat = 60 / d.bpm;
    const barDur = beat * 4;
    const gap = lastBar && sec.gap && s16 >= 12;
    const isMain = d === this.main;

    if (s16 === 0) {
      this.mark('bar', t0);
      if (barIn === 0) {
        this.later(t0, () => { if (this.main === d) this.emit({ section: sec.name }); });
        const prev = song.sections[si - 1];
        if (prev && L.drums && (sec.energy - prev.energy >= 0.25 || prev.gap)) this.crash(t0, 0.7);
        if (sec.filter) {
          d.lp.frequency.setValueAtTime(this.top, t0);
          d.lp.frequency.exponentialRampToValueAtTime(800, t0 + barDur);
        }
      }
      if (sec.filter && lastBar) {
        d.lp.frequency.setValueAtTime(800, t0);
        d.lp.frequency.exponentialRampToValueAtTime(this.top, t0 + barDur);
      }
      if (sec.riser && barIn === Math.max(0, sec.bars - 2)) this.riser(t0, t0 + barDur * Math.min(2, sec.bars));
      if (sec.throw && lastBar && L.drums) this.throwAt(d, t0 + beat * 3, beat);
      this.later(t0, () => { if (this.main === d) this.emit({ bar, totalBars: d.song.bars, bpm: Math.round(d.bpm) }); });
      // slow mutations every four bars keep loops breathing
      if (bar > 0 && bar % 4 === 0 && Math.random() < 0.5) {
        const m = Math.floor(Math.random() * 3);
        if (m === 0) d.mut.hatShift = Math.random() < 0.5 ? 0 : 1;
        if (m === 1) d.mut.kickExtra = Math.random() < 0.5 ? -1 : [3, 7, 11, 13, 14][Math.floor(Math.random() * 5)];
        if (m === 2) d.mut.arpOct = Math.random() < 0.5 ? 0 : 12;
      }
    }

    if (chordStart || !d.chord.length) {
      d.chord = this.voice(d.chord, this.chordNotes(song, root, degree, 2, song.chordSize), root + 26);
      if (isMain && chordStart) { this.mark('chord', t0); this.chordIndex++; }
      if (L.pad && chordStart) this.pad(d, t0, d.chord, (hrSteps - pos % hrSteps) * stepDur, energy);
    }

    // drums
    const rolling = step >= d.rollFrom && step < d.rollUntil;
    if (rolling) {
      const k = (step - d.rollFrom) / Math.max(1, d.rollUntil - d.rollFrom);
      this.snare(d, t0, 0.25 + k * 0.6);
      if (k > 0.5) this.snare(d, t0 + stepDur / 2, 0.2 + k * 0.6);
      if (s16 % 4 === 0) this.kick(d, t0, 0.8);
    } else if (L.drums && !gap) {
      const pat = sec.hook || boosted ? song.drumsB : song.drumsA;
      const fill = lastBar && L.drums === 2 && sec.bars >= 4 && si < song.sections.length - 1 ? sec.fill ?? 'none' : 'none';
      const kit = song.kit;
      if (fill === 'roll' && s16 >= 12) this.snare(d, t, 0.35 + (s16 - 12) * 0.15);
      else if (fill === 'tom' && s16 >= 8) { if (s16 % 2 === 0) this.tom(d, t, 0.8, 220 - (s16 - 8) * 18); }
      else if (fill === 'kick' && s16 >= 8) { if ([8, 11, 14, 15].includes(s16)) this.kick(d, t, 0.8); }
      else {
        const kv = pat.kick[s16] || (s16 === d.mut.kickExtra ? 0.55 : 0);
        if (kv) this.kick(d, t, kv * (L.drums === 1 ? 0.85 : 1));
        const sv = pat.snare[s16];
        if (sv && (L.drums === 2 || sv > 0.5)) this.snare(d, t, sv);
        const cv = pat.clap[s16];
        if (cv && (L.drums === 2 || cv > 0.5)) this.clap(d, t, cv);
        if (fill === 'open' && s16 === 14) this.hat(d, t, 0.6, true);
      }
      const hv = pat.hat[(s16 + d.mut.hatShift) % 16];
      if (hv && (L.drums === 2 || s16 % 2 === 0) && !(fill === 'kick' && s16 >= 8)) {
        const ov = pat.open[s16];
        if (ov && L.drums === 2) this.hat(d, t, ov, true);
        else {
          const v = hv * (0.85 + Math.random() * 0.3);
          this.hat(d, t, v, false);
          if (L.drums === 2 && Math.random() < pat.rolls) {
            const n = Math.random() < 0.5 ? 2 : 3;
            for (let k = 1; k < n; k++) this.hat(d, t + (stepDur * k) / n, v * 0.7, false);
          }
        }
      } else if (pat.open[s16] && L.drums === 2) this.hat(d, t, pat.open[s16], true);
      const pv = pat.perc[s16];
      if (pv && kit.perc !== 'none' && (L.perc || L.drums === 2)) this.perc(d, t, pv, kit.perc);
      else if (pv && kit.perc === 'none' && L.drums === 2 && s16 % 2) this.hat(d, t, pv * 0.6, false);
    }

    // bass
    const bn = song.bass[s16];
    if (L.bass && !gap && bn) {
      const tones = this.chordNotes(song, root, degree, 0, 4);
      let note = tones[0];
      if (bn.tone === 'o') note += 12;
      else if (bn.tone === '5') note = tones[2];
      else if (bn.tone === '3') note = tones[1];
      else if (bn.tone === 'w') {
        const left = hrSteps - (pos % hrSteps);
        const nextRoot = this.chordNotes(song, root, nextDegree, 0, 1)[0];
        const b = s16 / 4;
        if (left <= 4) note = nextRoot + (Math.random() < 0.5 ? 1 : -1); // chromatic approach
        else note = [tones[0], tones[1], tones[2], tones[3] - 12][(b + Math.floor(Math.random() * 2)) % 4];
        if (note > root + 14) note -= 12;
      }
      this.bass(d, t, note, bn.len * stepDur);
    }

    // keys comping
    if (L.keys && !gap && song.keysRhythm.includes(s16)) {
      let notes = d.chord.map(n => n + 12);
      if (s16 !== 0 && song.keys === 'rhodes') notes = notes.slice(1);
      const v = s16 === 0 ? 0.5 : 0.36;
      const strum = song.keys === 'rhodes' ? 0.012 * (1 + song.lofi * 2) : 0.003;
      notes.forEach((n, i) => this.keys(d, t + i * strum, n, v * (0.85 + Math.random() * 0.25), stepDur));
    }

    // arpeggio over the voiced chord, on an absolute step grid so rate 3 runs across the bar line
    if (L.arp && !gap && step % song.arpRate === 0 && !(Math.random() < song.arpSkip)) {
      const tones = d.chord.map(n => n + 12);
      const two = [...tones, ...tones.map(n => n + 12)];
      const i = step / song.arpRate;
      const n = two.length;
      let idx: number;
      if (song.arpShape === 'up') idx = i % n;
      else if (song.arpShape === 'down') idx = n - 1 - (i % n);
      else if (song.arpShape === 'updown') { const c = i % (2 * n - 2); idx = c < n ? c : 2 * n - 2 - c; }
      else idx = song.arpOrder[i % song.arpOrder.length] % n;
      this.arp(d, t, two[idx] + d.mut.arpOct, stepDur * song.arpRate * 0.9, energy);
    }

    // lead: the phrase, or a fresh improvised one per 4 bars in improv sections
    if (L.lead && !gap && s16 % 2 === 0) {
      let phrase = song.phrase;
      if (L.improv) {
        const key = si * 64 + Math.floor(barIn / 4);
        phrase = d.improv.get(key) ?? makePhrase(mulberry32(song.seed ^ Math.imul(key + 1, 2654435761)), Math.min(0.8, song.density + 0.1));
        d.improv.set(key, phrase);
      }
      const slot = (barIn % 4) * 8 + s16 / 2;
      let deg = phrase[slot];
      if (deg !== null && !(lastBar && sec.gap && s16 >= 10)) {
        let len = 1;
        while (slot + len < 32 && phrase[slot + len] === null && len < 4) len++;
        if (s16 % 4 === 0) deg = this.snapToChord(deg, degree, song.chordSize);
        const oct = song.lead === 'bell' || song.lead === 'chip' ? 4 : 3;
        this.lead(d, t, this.degreeNote(song, root, deg, oct), stepDur * 2 * len * 0.92);
      }
    }
  }

  // ── DJ moves ────────────────────────────────────────────────────────────
  private throwAt(d: Deck, t: number, dur: number, fb = 0.58) {
    d.throwSend.gain.cancelScheduledValues(t);
    d.throwSend.gain.setValueAtTime(0, t);
    d.throwSend.gain.linearRampToValueAtTime(0.9, t + 0.02);
    d.throwSend.gain.setValueAtTime(0.9, t + dur);
    d.throwSend.gain.linearRampToValueAtTime(0, t + dur + 0.03);
    this.fb.gain.cancelScheduledValues(t);
    this.fb.gain.setValueAtTime(fb, t);
    this.fb.gain.setTargetAtTime(0.38, t + dur + 1.2, 0.8);
  }

  private riser(t0: number, t1: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.start(t0); src.stop(t1 + 0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(7500, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t1);
    g.gain.linearRampToValueAtTime(0.0001, t1 + 0.05);
    src.connect(bp).connect(g).connect(this.fxBus);
    const send = ctx.createGain(); send.gain.value = 0.6;
    g.connect(send).connect(this.reverbIn);
  }

  private crash(t: number, v: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.start(t); src.stop(t + 2.6);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.17, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
    src.connect(hp).connect(g).connect(this.fxBus);
    const send = ctx.createGain(); send.gain.value = 0.3;
    g.connect(send).connect(this.reverbIn);
  }

  // ── instruments ─────────────────────────────────────────────────────────
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number, sustain: number, release: number, hold: number) {
    const p = g.gain;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setTargetAtTime(peak * sustain, t + attack, decay / 3);
    p.setTargetAtTime(0.0001, t + Math.max(hold, attack), release / 4);
  }

  /** an oscillator on deck `d`; 'pitch' follows tape wobble + brake, 'bend' only the brake */
  private osc(d: Deck, type: OscillatorType | PeriodicWave, freq: number, t: number, stop: number, detune = 0, follow: 'pitch' | 'bend' | 'none' = 'pitch') {
    const o = this.ctx!.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType; else o.setPeriodicWave(type);
    o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    const src = follow === 'pitch' ? d.pitch : follow === 'bend' ? d.bend : null;
    if (src) src.connect(o.detune);
    o.start(t); o.stop(stop);
    o.onended = () => { if (src) try { src.disconnect(o.detune); } catch { /* already gone */ } };
    return o;
  }

  private noiseSrc(t: number, dur: number) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.5, dur);
    return src;
  }

  private send(d: Deck, from: AudioNode, rev: number, dly = 0) {
    const ctx = this.ctx!;
    if (rev) { const s = ctx.createGain(); s.gain.value = rev; from.connect(s).connect(d.rev); }
    if (dly) { const s = ctx.createGain(); s.gain.value = dly; from.connect(s).connect(d.dly); }
  }

  private kick(d: Deck, t: number, v: number) {
    const ctx = this.ctx!;
    const k = d.song.kit;
    const o = this.osc(d, k.kickWave, k.kick[0], t, t + k.kick[2] + 0.1, 0, 'bend');
    o.frequency.exponentialRampToValueAtTime(k.kick[1], t + (k.kickWave === 'sine' ? 0.13 : 0.06));
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 1.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + k.kick[2]);
    o.connect(g).connect(d.stems.drums);
    const n = this.noiseSrc(t, 0.02);
    const ng = ctx.createGain(); ng.gain.setValueAtTime(v * 0.18, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
    n.connect(ng).connect(d.stems.drums);
    // sidechain pump on bass + pads
    if (d.song.pump > 0) {
      const pg = d.pumpBus.gain;
      pg.cancelScheduledValues(t);
      pg.setValueAtTime(1 - d.song.pump * v, t);
      pg.setTargetAtTime(1, t + 0.03, 0.08);
    }
    this.mark('kick', t);
  }

  private snare(d: Deck, t: number, v: number) {
    const ctx = this.ctx!;
    const k = d.song.kit;
    const n = this.noiseSrc(t, k.snareDecay + 0.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = k.snare - d.song.lofi * 500; f.Q.value = k.brush ? 0.4 : 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v * (k.brush ? 0.32 : 0.55), t + (k.brush ? 0.012 : 0.001));
    g.gain.exponentialRampToValueAtTime(0.001, t + k.snareDecay + (1 - d.song.lofi) * 0.05);
    n.connect(f).connect(g).connect(d.stems.drums);
    if (k.body) {
      const body = this.osc(d, 'triangle', 185, t, t + 0.15, 0, 'none');
      const bg = ctx.createGain(); bg.gain.setValueAtTime(v * k.body, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      body.connect(bg).connect(d.stems.drums);
    }
    if (v > 0.5) {
      this.send(d, g, k.gate * (1.2 - d.song.lofi * 0.5)); // big gated-80s tail on the synthwave kits
      this.mark('snare', t);
    }
  }

  private clap(d: Deck, t: number, v: number) {
    const ctx = this.ctx!;
    const n = this.noiseSrc(t, 0.3);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1150; bp.Q.value = 1.3;
    const g = ctx.createGain();
    const p = g.gain;
    p.setValueAtTime(0.0001, t);
    for (let i = 0; i < 3; i++) { p.setValueAtTime(v * 0.5, t + i * 0.011); p.setTargetAtTime(0.03, t + i * 0.011 + 0.001, 0.004); }
    p.setValueAtTime(v * 0.45, t + 0.033);
    p.setTargetAtTime(0.0001, t + 0.034, 0.05);
    n.connect(bp).connect(g).connect(d.stems.drums);
    this.send(d, g, 0.3);
    this.mark('snare', t);
  }

  private hat(d: Deck, t: number, v: number, open: boolean) {
    const ctx = this.ctx!;
    const k = d.song.kit;
    const dur = open ? 0.3 : k.hatDecay;
    const n = this.noiseSrc(t, dur + 0.02);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = k.hat;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp).connect(g).connect(d.stems.drums);
    this.mark('hat', t);
  }

  private perc(d: Deck, t: number, v: number, kind: Perc) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.connect(d.stems.drums);
    if (kind === 'rim') {
      const o = this.osc(d, 'triangle', 1750, t, t + 0.06, 0, 'none');
      g.gain.setValueAtTime(v * 0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      o.connect(g);
      const n = this.noiseSrc(t, 0.03);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000;
      n.connect(bp).connect(g);
      this.send(d, g, 0.25);
    } else if (kind === 'shaker') {
      const n = this.noiseSrc(t, 0.1);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7000; bp.Q.value = 0.8;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v * 0.12, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      n.connect(bp).connect(g);
    } else {
      const o = this.osc(d, 'sine', 250, t, t + 0.3, 0, 'none');
      o.frequency.exponentialRampToValueAtTime(195, t + 0.05);
      g.gain.setValueAtTime(v * 0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g);
    }
  }

  private tom(d: Deck, t: number, v: number, f: number) {
    const ctx = this.ctx!;
    const o = this.osc(d, 'sine', f, t, t + 0.4, 0, 'bend');
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(d.stems.drums);
    this.send(d, g, 0.2);
  }

  private bass(d: Deck, t: number, midi: number, dur: number) {
    const ctx = this.ctx!;
    const song = d.song;
    const f = mtof(midi);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1;
    const g = ctx.createGain();
    const end = t + dur + 0.3;
    const hold = t + dur;
    switch (song.bassTone) {
      case 'round':
        this.osc(d, 'triangle', f, t, end).connect(lp); this.osc(d, 'sine', f, t, end).connect(lp);
        lp.frequency.value = 700;
        this.env(g, t, 0.42, 0.01, 0.3, 0.7, 0.15, hold);
        break;
      case 'upright':
        this.osc(d, 'triangle', f, t, end).connect(lp); this.osc(d, 'sine', f, t, end).connect(lp);
        lp.frequency.setValueAtTime(1600, t); lp.frequency.setTargetAtTime(600, t, 0.1);
        this.env(g, t, 0.5, 0.006, 0.35, 0.3, 0.12, hold);
        break;
      case 'deep': {
        this.osc(d, 'sine', f, t, end).connect(lp);
        const s = ctx.createGain(); s.gain.value = 0.25;
        this.osc(d, 'sawtooth', f, t, end).connect(s).connect(lp);
        lp.frequency.value = 380; lp.Q.value = 5;
        this.env(g, t, 0.45, 0.005, 0.25, 0.6, 0.06, hold);
        break;
      }
      case 'sub': {
        this.osc(d, 'sine', f, t, end).connect(lp);
        const s = ctx.createGain(); s.gain.value = 0.15;
        this.osc(d, 'triangle', f * 2, t, end).connect(s).connect(lp);
        lp.frequency.value = 420;
        this.env(g, t, 0.3, 0.02, 0.5, 0.7, 0.25, hold);
        break;
      }
      case 'chip':
        this.osc(d, 'triangle', f, t, end).connect(lp);
        lp.frequency.value = 9000;
        this.env(g, t, 0.36, 0.002, 0.1, 0.9, 0.03, hold);
        break;
      case 'slap': {
        this.osc(d, 'sawtooth', f, t, end).connect(lp);
        const s = ctx.createGain(); s.gain.value = 0.3;
        this.osc(d, 'square', f, t, end).connect(s).connect(lp);
        lp.Q.value = 3;
        lp.frequency.setValueAtTime(2800, t); lp.frequency.setTargetAtTime(500, t, 0.05);
        this.env(g, t, 0.32, 0.003, 0.18, 0.55, 0.06, hold);
        break;
      }
      default: {
        this.osc(d, 'sawtooth', f, t, end).connect(lp);
        const s = ctx.createGain(); s.gain.value = 0.35;
        this.osc(d, 'square', f / 2, t, end).connect(s).connect(lp);
        lp.Q.value = 4 - song.lofi * 3;
        lp.frequency.setValueAtTime(260, t);
        lp.frequency.linearRampToValueAtTime(1300, t + 0.012);
        lp.frequency.setTargetAtTime(320, t + 0.012, 0.08);
        this.env(g, t, 0.3, 0.005, 0.2, 0.75, 0.08, hold);
      }
    }
    lp.connect(g).connect(d.stems.bass);
  }

  private pad(d: Deck, t: number, notes: number[], dur: number, energy: number) {
    const ctx = this.ctx!;
    const song = d.song;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    const g = ctx.createGain();
    const end = t + dur + 3.2;
    const sweep = (cut: number) => {
      lp.frequency.setValueAtTime(cut * 0.6, t);
      lp.frequency.linearRampToValueAtTime(cut, t + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(cut * 0.75, t + dur);
    };
    switch (song.pad) {
      case 'strings':
        sweep(1800 * (0.6 + energy * 0.6)); lp.Q.value = 0.5;
        this.env(g, t, 0.17 / Math.sqrt(notes.length * 3), 0.9, 1, 0.95, 1.8, t + dur);
        for (const n of notes) for (const det of [-11, 0, 12]) this.osc(d, 'sawtooth', mtof(n), t, end, det).connect(lp);
        this.send(d, g, 0.7);
        break;
      case 'warm':
        sweep(1500 * (0.6 + energy * 0.5));
        this.env(g, t, 0.13 / Math.sqrt(notes.length * 2), 0.7, 1, 0.9, 1.6, t + dur);
        for (const n of notes) {
          this.osc(d, 'triangle', mtof(n), t, end, -6).connect(lp);
          this.osc(d, 'triangle', mtof(n), t, end, 6).connect(lp);
        }
        this.send(d, g, 0.6);
        break;
      case 'glass': {
        lp.type = 'highpass'; lp.frequency.value = 250; lp.Q.value = 0.5;
        this.env(g, t, 0.13 / Math.sqrt(notes.length), 1.4, 2, 0.9, 3, t + dur);
        for (const n of notes) {
          const f = mtof(n);
          const car = this.osc(d, 'sine', f, t, end);
          const m = this.osc(d, 'sine', f * 2, t, end);
          const idx = ctx.createGain();
          idx.gain.setValueAtTime(f * 0.9, t); idx.gain.setTargetAtTime(f * 0.15, t, 1.5);
          m.connect(idx).connect(car.frequency);
          car.connect(lp);
          const hi = ctx.createGain(); hi.gain.value = 0.25;
          this.osc(d, 'sine', f * 2, t, end, 4).connect(hi).connect(lp);
        }
        this.send(d, g, 0.9, 0.3);
        break;
      }
      case 'pulse':
        lp.frequency.value = 2600;
        this.env(g, t, 0.07 / Math.sqrt(notes.length), 0.02, 0.3, 0.7, 0.2, t + dur);
        for (const n of notes) this.osc(d, this.pw.p25, mtof(n), t, end, 0, 'bend').connect(lp);
        this.send(d, g, 0.15);
        break;
      default:
        sweep(song.padCutoff * (0.5 + energy * 0.8));
        this.env(g, t, 0.21 / Math.sqrt(notes.length * 2), 0.5, 1, 0.9, 1.4, t + dur);
        for (const n of notes) for (const det of [-8, 7]) this.osc(d, 'sawtooth', mtof(n), t, end, det).connect(lp);
        this.send(d, g, 0.6);
    }
    lp.connect(g).connect(d.stems.pad);
  }

  private fm(d: Deck, f: number, ratio: number, index: number, decay: number, t: number, end: number) {
    const ctx = this.ctx!;
    const car = this.osc(d, 'sine', f, t, end);
    const m = this.osc(d, 'sine', f * ratio, t, end);
    const idx = ctx.createGain();
    idx.gain.setValueAtTime(f * index, t);
    idx.gain.setTargetAtTime(f * index * 0.1, t, decay);
    m.connect(idx).connect(car.frequency);
    return car;
  }

  private keys(d: Deck, t: number, midi: number, v: number, stepDur: number) {
    const ctx = this.ctx!;
    const f = mtof(midi);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const beat = stepDur * 4;
    switch (d.song.keys) {
      case 'organ': {
        const dur = stepDur * 1.8, end = t + dur + 0.2;
        [[1, 0.6], [2, 0.3], [3, 0.15], [4, 0.08]].forEach(([h, a]) => {
          const s = ctx.createGain(); s.gain.value = a;
          this.osc(d, 'sine', f * h, t, end).connect(s).connect(lp);
        });
        lp.frequency.value = 4000;
        this.env(g, t, v * 0.1, 0.004, 0.2, 0.8, 0.06, t + dur);
        this.send(d, g, 0.3);
        break;
      }
      case 'stab': {
        const dur = stepDur * 2, end = t + dur + 0.3;
        for (const det of [-7, 7]) this.osc(d, 'sawtooth', f, t, end, det).connect(lp);
        lp.Q.value = 4; lp.frequency.setValueAtTime(2800, t); lp.frequency.setTargetAtTime(500, t, 0.07);
        this.env(g, t, v * 0.07, 0.003, 0.15, 0.3, 0.1, t + dur);
        this.send(d, g, 0.35, 0.25);
        break;
      }
      case 'pluck': {
        const dur = stepDur * 1.5, end = t + dur + 0.3;
        this.osc(d, 'sawtooth', f, t, end).connect(lp);
        lp.Q.value = 2; lp.frequency.setValueAtTime(3500, t); lp.frequency.setTargetAtTime(350, t, 0.06);
        this.env(g, t, v * 0.1, 0.002, 0.2, 0.2, 0.12, t + dur);
        this.send(d, g, 0.3, 0.3);
        break;
      }
      case 'bell': {
        const dur = beat * 2, end = t + dur + 1.2;
        this.fm(d, f, 3.5, 3, 0.5, t, end).connect(lp);
        lp.frequency.value = 6000;
        this.env(g, t, v * 0.09, 0.002, 1.2, 0.2, 0.9, t + dur);
        this.send(d, g, 0.5, 0.2);
        break;
      }
      case 'chip': {
        const dur = stepDur * 1.6, end = t + dur + 0.1;
        this.osc(d, this.pw.p25, f, t, end, 0, 'bend').connect(lp);
        lp.frequency.value = 9000;
        this.env(g, t, v * 0.06, 0.002, 0.1, 0.6, 0.03, t + dur);
        break;
      }
      default: { // FM electric piano
        const dur = beat * 1.6, end = t + dur + 0.8;
        const car = this.osc(d, 'sine', f, t, end);
        const m = this.osc(d, 'sine', f, t, end);
        const idx = ctx.createGain();
        idx.gain.setValueAtTime(f * 2.2, t);
        idx.gain.setTargetAtTime(f * 0.25, t, 0.12);
        m.connect(idx).connect(car.frequency);
        car.connect(lp);
        this.env(g, t, v * 0.16, 0.004, 1.2, 0.35, 0.5, t + dur);
        this.send(d, g, 0.35);
      }
    }
    lp.connect(g).connect(d.stems.keys);
  }

  private arp(d: Deck, t: number, midi: number, dur: number, energy: number) {
    const ctx = this.ctx!;
    const f = mtof(midi);
    const end = t + dur + 0.15;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
    const g = ctx.createGain();
    switch (d.song.arp) {
      case 'saw':
        this.osc(d, 'sawtooth', f, t, end).connect(lp);
        lp.Q.value = 5; lp.frequency.setValueAtTime(1500 + energy * 3000, t); lp.frequency.setTargetAtTime(500, t, 0.05);
        this.env(g, t, 0.045, 0.003, 0.08, 0.4, 0.05, t + dur);
        break;
      case 'pluck':
        this.osc(d, 'triangle', f, t, end).connect(lp);
        this.osc(d, 'sawtooth', f, t, end, 5).connect(lp);
        lp.frequency.setValueAtTime(2600, t); lp.frequency.setTargetAtTime(400, t, 0.05);
        this.env(g, t, 0.055, 0.002, 0.1, 0.3, 0.08, t + dur);
        break;
      case 'bell':
        this.fm(d, f, 2, 2.5, 0.25, t, end + 0.8).connect(lp);
        lp.frequency.value = 7000;
        this.env(g, t, 0.05, 0.002, 0.6, 0.25, 0.8, t + dur);
        this.send(d, g, 0.4);
        break;
      case 'chip':
        this.osc(d, this.pw.p12, f, t, end, 0, 'bend').connect(lp);
        lp.frequency.value = 10000;
        this.env(g, t, 0.035, 0.002, 0.05, 0.7, 0.02, t + dur);
        break;
      default:
        this.osc(d, 'square', f, t, end).connect(lp);
        lp.frequency.setValueAtTime(1200 + energy * 2600, t);
        lp.frequency.setTargetAtTime(600, t, 0.06);
        this.env(g, t, 0.05, 0.003, 0.08, 0.4, 0.05, t + dur);
    }
    const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() - 0.5) * 0.7;
    lp.connect(g).connect(pan).connect(d.stems.arp);
    this.send(d, g, 0, 1);
  }

  private lead(d: Deck, t: number, midi: number, dur: number) {
    const ctx = this.ctx!;
    const song = d.song;
    const f = mtof(midi);
    const end = t + dur + 0.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1;
    const g = ctx.createGain();
    const vibrato = (targets: OscillatorNode[], depth: number, rate = 5.2, delay = 0.4) => {
      const vib = this.osc(d, 'sine', rate, t, end, 0, 'none');
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(depth, t + Math.min(delay, dur));
      vib.connect(vg);
      targets.forEach(o => vg.connect(o.detune));
    };
    switch (song.lead) {
      case 'square': {
        const a = this.osc(d, 'square', f, t, end, -5), b = this.osc(d, 'square', f, t, end, 6);
        const bg = ctx.createGain(); bg.gain.value = 0.6;
        a.connect(lp); b.connect(bg).connect(lp);
        vibrato([a, b], 12);
        lp.frequency.value = 2400;
        this.env(g, t, 0.05, 0.02, 0.4, 0.75, 0.25, t + dur);
        break;
      }
      case 'brass': {
        const a = this.osc(d, 'sawtooth', f, t, end, -8), b = this.osc(d, 'sawtooth', f, t, end, 8);
        a.connect(lp); b.connect(lp);
        vibrato([a, b], 10, 5.5, 0.5);
        lp.Q.value = 2;
        lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(2800, t + 0.06); lp.frequency.setTargetAtTime(1500, t + 0.06, 0.2);
        this.env(g, t, 0.06, 0.04, 0.3, 0.8, 0.25, t + dur);
        break;
      }
      case 'flute': {
        const a = this.osc(d, 'sine', f, t, end);
        const h = this.osc(d, 'triangle', f * 2, t, end);
        const hg = ctx.createGain(); hg.gain.value = 0.12;
        a.connect(lp); h.connect(hg).connect(lp);
        vibrato([a, h], 16, 5, 0.3);
        const n = this.noiseSrc(t, dur + 0.3);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 1.5; bp.Q.value = 2;
        const ng = ctx.createGain(); ng.gain.value = 0.25;
        n.connect(bp).connect(ng).connect(lp);
        lp.frequency.value = 3200;
        this.env(g, t, 0.075, 0.06, 0.3, 0.85, 0.25, t + dur);
        break;
      }
      case 'bell':
        this.fm(d, f, 3.5, 2.5, 0.6, t, end + 1).connect(lp);
        lp.frequency.value = 7000;
        this.env(g, t, 0.075, 0.002, 1.1, 0.3, 1, t + dur);
        break;
      case 'chip': {
        const a = this.osc(d, 'square', f, t, end, 0, 'bend');
        vibrato([a], 25, 6, 0.25);
        a.connect(lp);
        lp.frequency.value = 10000;
        this.env(g, t, 0.04, 0.002, 0.1, 0.9, 0.05, t + dur);
        break;
      }
      default: {
        const a = this.osc(d, song.lofi > 0.5 ? 'triangle' : 'sawtooth', f, t, end, -5);
        const b = this.osc(d, 'square', f, t, end, 6);
        const bg = ctx.createGain(); bg.gain.value = 0.5;
        a.connect(lp); b.connect(bg).connect(lp);
        vibrato([a, b], 14);
        lp.frequency.value = 2200 - song.lofi * 900;
        this.env(g, t, 0.065, 0.03, 0.4, 0.75, 0.3, t + dur);
      }
    }
    lp.connect(g).connect(d.stems.lead);
    this.send(d, g, 0.5, 1);
  }

  // ── Stem controls ──
  setStemVolume(stem: StemId, vol: number) {
    const s = this.state.stems[stem];
    if (!s) return;
    s.volume = Math.max(0, Math.min(1, vol));
    this.applyStems();
  }
  setStemMute(stem: StemId, muted: boolean) {
    const s = this.state.stems[stem];
    if (!s) return;
    s.muted = muted;
    this.applyStems();
  }
  setStemSolo(stem: StemId, solo: boolean) {
    const s = this.state.stems[stem];
    if (!s) return;
    s.solo = solo;
    this.applyStems();
  }
  resetStems() {
    for (const id of ['drums', 'bass', 'keys', 'pad', 'arp', 'lead'] as StemId[]) {
      this.state.stems[id] = { muted: false, solo: false, volume: 1 };
    }
    this.applyStems();
  }
  private applyStems() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const anySolo = Object.values(this.state.stems).some(x => x.solo);
    for (const d of this.decks) {
      for (const [id, stm] of Object.entries(this.state.stems) as [StemId, StemState][]) {
        const active = anySolo ? stm.solo : !stm.muted;
        const target = active ? stm.volume : 0;
        d.stems[id].gain.setTargetAtTime(target, now, 0.02);
      }
    }
    this.emit({ stems: { ...this.state.stems } });
  }

  // ── Deck 3-Band EQ ──
  setDeckEq(band: 'low' | 'mid' | 'high', gainDb: number) {
    const eq = this.state.eq;
    const clamped = Math.max(-40, Math.min(6, gainDb));
    eq[band] = clamped;
    if (this.ctx && this.main) {
      const now = this.ctx.currentTime;
      const node = band === 'low' ? this.main.eqLow : band === 'mid' ? this.main.eqMid : this.main.eqHigh;
      const isKilled = band === 'low' ? eq.lowKill : band === 'mid' ? eq.midKill : eq.highKill;
      node.gain.setTargetAtTime(isKilled ? (band === 'low' ? BASS_KILL_DB : -30) : clamped, now, 0.03);
    }
    this.emit({ eq: { ...eq } });
  }
  setDeckEqKill(band: 'low' | 'mid' | 'high', kill: boolean) {
    const eq = this.state.eq;
    if (band === 'low') eq.lowKill = kill;
    else if (band === 'mid') eq.midKill = kill;
    else eq.highKill = kill;
    if (this.ctx && this.main) {
      const now = this.ctx.currentTime;
      const node = band === 'low' ? this.main.eqLow : band === 'mid' ? this.main.eqMid : this.main.eqHigh;
      const val = kill ? (band === 'low' ? BASS_KILL_DB : -30) : eq[band];
      node.gain.setTargetAtTime(val, now, 0.02);
    }
    this.emit({ eq: { ...eq } });
  }

  // ── Crossfader (-1 = Deck A, 1 = Deck B) ──
  setCrossfader(x: number) {
    const val = Math.max(-1, Math.min(1, x));
    this.emit({ crossfader: val });
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const deckA = this.main;
    const deckB = this.decks.find(d => d !== deckA);
    if (deckA) {
      const gainA = val <= 0 ? 1 : Math.cos(val * Math.PI * 0.5);
      deckA.out.gain.setTargetAtTime(gainA, now, 0.03);
    }
    if (deckB) {
      const gainB = val >= 0 ? 1 : Math.sin((val + 1) * Math.PI * 0.5);
      deckB.out.gain.setTargetAtTime(gainB, now, 0.03);
    }
  }

  // ── Tempo & Beat Controls ──
  nudgeBpm(delta: number) {
    if (!this.main) return;
    this.main.bpm = Math.max(40, Math.min(220, Math.round(this.main.bpm + delta)));
    this.emit({ bpm: this.main.bpm });
  }
  setBpm(bpm: number) {
    if (!this.main) return;
    this.main.bpm = Math.max(40, Math.min(220, Math.round(bpm)));
    this.emit({ bpm: this.main.bpm });
  }
  jumpBeats(beats: number) {
    if (!this.main) return;
    const steps = beats * 4;
    this.main.step = Math.max(0, Math.min(this.main.endStep - 16, this.main.step + steps));
    this.note(`Jumped ${beats > 0 ? '+' : ''}${beats} beats`);
  }

  // ── Custom Song Composition & Playback ──
  composeCustom(params: CustomSongParams): SongInfo {
    const seed = params.seed ?? (Math.random() * 2 ** 31) | 0;
    const song = composeSong(seed, params.style, params.tonic, params);
    return infoOf(song);
  }
  playCustom(params: CustomSongParams, now = true) {
    const seed = params.seed ?? (Math.random() * 2 ** 31) | 0;
    const song = composeSong(seed, params.style, params.tonic, params);
    if (!this.main) {
      this.queued.unshift(song);
      return this.play();
    }
    if (!now) {
      this.queued.push(song);
      if (!this.main.plan?.fired && this.queued.length === 1) this.replan(this.main);
      return;
    }
    if (this.main.plan?.fired) {
      this.queued.unshift(song);
      return;
    }
    this.main.plan = { ...(this.main.plan ?? this.planFor(this.main)), next: song };
    return this.skip(undefined, false);
  }

  // ── Performance Soundboard & FX ──
  triggerFx(kind: SoundFxKind) {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const t = ctx.currentTime;
    const dest = this.samplerBus || this.master;

    switch (kind) {
      case 'airhorn': {
        const times = [0, 0.11, 0.22, 0.35];
        const chords = [311, 622, 784, 932, 1244]; // Eb4, Eb5, G5, Bb5, Eb6
        times.forEach((dt, idx) => {
          const start = t + dt;
          const dur = idx === times.length - 1 ? 0.6 : 0.09;

          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 1.4;
          const peak = ctx.createBiquadFilter();
          peak.type = 'peaking'; peak.frequency.value = 2200; peak.gain.value = 5.0; peak.Q.value = 1.2;

          const g = ctx.createGain();
          g.gain.setValueAtTime(0, start);
          g.gain.linearRampToValueAtTime(0.95, start + 0.006);
          g.gain.setValueAtTime(0.85, start + dur - 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, start + dur);

          chords.forEach(f => {
            [-1.8, 1.8].forEach(detuneHz => {
              const o = ctx.createOscillator();
              o.type = 'sawtooth';
              const baseFreq = f + detuneHz;
              o.frequency.setValueAtTime(baseFreq * 1.03, start);
              o.frequency.linearRampToValueAtTime(baseFreq, start + 0.02);
              o.frequency.setValueAtTime(baseFreq, start + dur - 0.025);
              o.frequency.linearRampToValueAtTime(baseFreq * 0.93, start + dur);
              o.connect(lp);
              o.start(start);
              o.stop(start + dur);
            });
          });

          lp.connect(peak).connect(g).connect(dest);
          if (this.reverbIn) {
            const send = ctx.createGain();
            send.gain.value = 0.35;
            g.connect(send).connect(this.reverbIn);
          }
        });

        // Duck music bus on airhorn blast
        this.duck.gain.setTargetAtTime(0.35, t, 0.02);
        this.duck.gain.setTargetAtTime(1.0, t + 1.05, 0.25);
        this.note('Air horn blast!');
        break;
      }

      case 'scratch': {
        const dur = 0.22;
        if (this.noise) {
          const nSrc = ctx.createBufferSource();
          nSrc.buffer = this.noise;
          const nBp = ctx.createBiquadFilter();
          nBp.type = 'bandpass';
          nBp.frequency.setValueAtTime(1100, t);
          nBp.frequency.linearRampToValueAtTime(3800, t + 0.06);
          nBp.frequency.linearRampToValueAtTime(1400, t + dur);
          nBp.Q.value = 4.2;
          const nGain = ctx.createGain();
          nGain.gain.setValueAtTime(0.85, t);
          nGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
          nSrc.connect(nBp).connect(nGain).connect(dest);
          nSrc.start(t); nSrc.stop(t + dur);
        }

        const o1 = ctx.createOscillator();
        o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(320, t);
        o1.frequency.linearRampToValueAtTime(1900, t + 0.05);
        o1.frequency.linearRampToValueAtTime(380, t + dur);
        const o2 = ctx.createOscillator();
        o2.type = 'square';
        o2.frequency.setValueAtTime(160, t);
        o2.frequency.linearRampToValueAtTime(950, t + 0.05);
        o2.frequency.linearRampToValueAtTime(190, t + dur);
        const toneBp = ctx.createBiquadFilter();
        toneBp.type = 'bandpass'; toneBp.frequency.value = 2100; toneBp.Q.value = 2.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.8, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o1.connect(toneBp); o2.connect(toneBp);
        toneBp.connect(g).connect(dest);
        o1.start(t); o1.stop(t + dur);
        o2.start(t); o2.stop(t + dur);
        this.note('Vinyl scratch');
        break;
      }

      case 'subdrop': {
        const dur = 2.0;
        const click = ctx.createOscillator();
        click.type = 'sine';
        click.frequency.setValueAtTime(240, t);
        click.frequency.exponentialRampToValueAtTime(80, t + 0.03);
        const clickGain = ctx.createGain();
        clickGain.gain.setValueAtTime(0.95, t);
        clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        click.connect(clickGain).connect(dest);
        click.start(t); click.stop(t + 0.04);

        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(140, t);
        sub.frequency.exponentialRampToValueAtTime(52, t + 0.6);
        sub.frequency.linearRampToValueAtTime(36, t + dur);

        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
          const x = (i / 255.5) - 1;
          curve[i] = Math.tanh(x * 1.8);
        }
        shaper.curve = curve;

        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(1.05, t);
        subGain.gain.exponentialRampToValueAtTime(0.001, t + dur);

        sub.connect(shaper).connect(subGain).connect(dest);
        sub.start(t); sub.stop(t + dur);

        this.duck.gain.setTargetAtTime(0.3, t, 0.02);
        this.duck.gain.setTargetAtTime(1.0, t + 0.6, 0.2);
        this.note('Sub drop boom');
        break;
      }

      case 'laser': {
        const times = [0, 0.11, 0.22, 0.35];
        times.forEach(dt => {
          const st = t + dt;
          const shotDur = 0.09;
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(3400, st);
          o.frequency.exponentialRampToValueAtTime(220, st + shotDur);

          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(4500, st);
          lp.frequency.exponentialRampToValueAtTime(400, st + shotDur);
          lp.Q.value = 6.0;

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.85, st);
          g.gain.exponentialRampToValueAtTime(0.001, st + shotDur);

          o.connect(lp).connect(g).connect(dest);
          if (this.delayIn) {
            const send = ctx.createGain();
            send.gain.value = 0.5;
            g.connect(send).connect(this.delayIn);
          }
          o.start(st); o.stop(st + shotDur);
        });
        this.note('Dub laser');
        break;
      }

      case 'siren': {
        const dur = 1.9;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const lfo = ctx.createOscillator();
        lfo.type = 'triangle';
        lfo.frequency.value = 5.5;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 320;
        lfo.connect(lfoG).connect(o.frequency);
        o.frequency.setValueAtTime(820, t);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 3.2;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.85, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);

        lfo.start(t); lfo.stop(t + dur);
        o.connect(bp).connect(g).connect(dest);
        if (this.delayIn) {
          const dSend = ctx.createGain();
          dSend.gain.value = 0.6;
          g.connect(dSend).connect(this.delayIn);
        }
        if (this.reverbIn) {
          const vSend = ctx.createGain();
          vSend.gain.value = 0.45;
          g.connect(vSend).connect(this.reverbIn);
        }
        o.start(t); o.stop(t + dur);
        this.note('Dub siren');
        break;
      }

      case 'tapestop': {
        if (this.state.playing) {
          this.skip('brake');
        } else {
          const dur = 1.4;
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(440, t);
          o.frequency.exponentialRampToValueAtTime(32, t + dur);
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.setValueAtTime(1400, t);
          lp.frequency.exponentialRampToValueAtTime(150, t + dur);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.8, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + dur);
          o.connect(lp).connect(g).connect(dest);
          o.start(t); o.stop(t + dur);
        }
        this.note('Tape brake');
        break;
      }

      case 'rewind': {
        const dur = 0.8;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(3200, t + 0.18);
        o.frequency.exponentialRampToValueAtTime(180, t + dur);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1200, t);
        bp.frequency.exponentialRampToValueAtTime(4200, t + 0.18);
        bp.frequency.exponentialRampToValueAtTime(400, t + dur);
        bp.Q.value = 2.8;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.9, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);

        if (this.noise) {
          const n = ctx.createBufferSource();
          n.buffer = this.noise;
          const nG = ctx.createGain();
          nG.gain.setValueAtTime(0.7, t);
          nG.gain.exponentialRampToValueAtTime(0.001, t + dur);
          n.connect(bp).connect(nG).connect(dest);
          n.start(t); n.stop(t + dur);
        }

        o.connect(bp).connect(g).connect(dest);
        o.start(t); o.stop(t + dur);
        this.duck.gain.setTargetAtTime(0.15, t, 0.02);
        this.duck.gain.setTargetAtTime(1.0, t + dur + 0.1, 0.2);
        this.note('Turntable rewind');
        break;
      }

      case 'cowbell': {
        const dur = 0.45;
        const f1 = 540, f2 = 800;
        const o1 = ctx.createOscillator(); o1.type = 'square'; o1.frequency.value = f1;
        const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = f2;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 840; bp.Q.value = 4.2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.9, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o1.connect(bp); o2.connect(bp);
        bp.connect(g).connect(dest);
        o1.start(t); o1.stop(t + dur);
        o2.start(t); o2.stop(t + dur);
        this.note('808 Cowbell');
        break;
      }

      case 'chant': {
        const dur = 0.28;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(230, t);
        o.frequency.exponentialRampToValueAtTime(130, t + dur);

        const f1 = ctx.createBiquadFilter();
        f1.type = 'bandpass'; f1.frequency.value = 750; f1.Q.value = 4.5;
        const f2 = ctx.createBiquadFilter();
        f2.type = 'bandpass'; f2.frequency.value = 1250; f2.Q.value = 4.5;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.95, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);

        o.connect(f1); o.connect(f2);
        f1.connect(g); f2.connect(g);
        g.connect(dest);
        if (this.reverbIn) {
          const send = ctx.createGain();
          send.gain.value = 0.3;
          g.connect(send).connect(this.reverbIn);
        }
        o.start(t); o.stop(t + dur);
        this.note('Crowd shout');
        break;
      }

      case 'impact': {
        const dur = 2.4;
        if (this.noise) {
          const n = ctx.createBufferSource();
          n.buffer = this.noise;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(14000, t);
          lp.frequency.exponentialRampToValueAtTime(300, t + dur);
          lp.Q.value = 2.5;
          const g = ctx.createGain();
          g.gain.setValueAtTime(1.0, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + dur);
          n.connect(lp).connect(g).connect(dest);
          if (this.reverbIn) {
            const send = ctx.createGain();
            send.gain.value = 0.65;
            g.connect(send).connect(this.reverbIn);
          }
          n.start(t); n.stop(t + dur);
        }
        const sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(120, t);
        sub.frequency.exponentialRampToValueAtTime(45, t + 0.4);
        const subG = ctx.createGain();
        subG.gain.setValueAtTime(0.9, t);
        subG.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        sub.connect(subG).connect(dest);
        sub.start(t); sub.stop(t + 0.5);
        this.note('Cymbal crash impact');
        break;
      }

      case 'stutter': {
        if (!this.main) return;
        const d = this.main;
        const stepDur = 60 / d.bpm / 4;
        for (let i = 0; i < 8; i++) {
          const st = t + i * (stepDur / 2);
          d.out.gain.setValueAtTime(1, st);
          d.out.gain.setValueAtTime(0.05, st + stepDur / 4);
        }
        d.out.gain.setValueAtTime(1, t + 4 * stepDur);
        this.note('Stutter roll');
        break;
      }
    }
  }

  async voiceDrop(phrase?: string, voiceId = 'am_fenrir', speed = 1.05) {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const drops = [
      'Shell B F M, live in the mix!',
      'Drop the beat!',
      'Procedural sound system!',
      'Broadcasting live from DGX Spark!',
      'Turn up the bass!',
      'Make some noise!',
      'Rewind! Bring that back!',
      'Warning: excessive bass levels detected!'
    ];
    const text = phrase ?? drops[Math.floor(Math.random() * drops.length)];
    this.note(`DJ Voice: "${text}"`);

    // 1) Primary high-quality neural voice via HERMES /api/tts
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voiceId,
          speed: speed || 1.05,
          format: 'mp3',
        }),
      });

      if (!res.ok) throw new Error(`TTS server HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;

      // FM broadcast EQ & voice processing chain:
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 100;

      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3400;
      presence.gain.value = 4.5;
      presence.Q.value = 1.2;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4.5;
      comp.attack.value = 0.005;
      comp.release.value = 0.12;

      const g = ctx.createGain();
      g.gain.value = 1.35 * (this.samplerVolume ?? 1.2);

      src.connect(hp).connect(presence).connect(comp).connect(g).connect(this.samplerBus || this.master);

      if (this.reverbIn) {
        const send = ctx.createGain();
        send.gain.value = 0.2;
        g.connect(send).connect(this.reverbIn);
      }

      const now = ctx.currentTime;
      const dur = audioBuf.duration;
      this.duck.gain.setTargetAtTime(0.2, now, 0.04);
      this.duck.gain.setTargetAtTime(1.0, now + dur, 0.25);

      src.start(now);
      return;
    } catch (err) {
      console.warn('[DJ Engine] HERMES neural TTS fallback to SpeechSynthesis:', err);
    }

    // 2) Fallback to SpeechSynthesis with dynamic pitch/speed to prevent monotone delivery
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const eng = voices.filter(v => /^en[-_]/i.test(v.lang));
      const chosen = eng.find(v => /google|natural|premium|online|guy|male/i.test(v.name)) || eng[0];
      if (chosen) u.voice = chosen;

      u.rate = Math.max(0.9, speed * 1.12);
      u.pitch = 1.08;
      u.volume = 1.0;

      this.duck.gain.setTargetAtTime(0.25, ctx.currentTime, 0.04);
      u.onend = () => this.duck.gain.setTargetAtTime(1.0, ctx.currentTime, 0.25);
      u.onerror = () => this.duck.gain.setTargetAtTime(1.0, ctx.currentTime, 0.25);
      speechSynthesis.speak(u);
    }
  }

  // ── Recording ──
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recStartAt = 0;
  private recTimer: number | null = null;

  startRecording() {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (!this.recDest) {
      this.recDest = ctx.createMediaStreamDestination();
      this.master.connect(this.recDest);
    }
    this.recChunks = [];
    const mimeType = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    try {
      this.recorder = new MediaRecorder(this.recDest.stream, { mimeType });
      this.recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) this.recChunks.push(e.data);
      };
      this.recorder.start(250);
      this.recStartAt = Date.now();
      this.emit({ recording: true, recordingDuration: 0 });
      if (this.recTimer) clearInterval(this.recTimer);
      this.recTimer = window.setInterval(() => {
        if (this.state.recording) {
          const duration = Math.floor((Date.now() - this.recStartAt) / 1000);
          this.emit({ recordingDuration: duration });
        }
      }, 1000);
      this.note('Recording started');
    } catch (e) {
      console.warn('MediaRecorder error', e);
    }
  }

  stopRecording(): Promise<Blob | null> {
    return new Promise(resolve => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        if (this.recTimer) clearInterval(this.recTimer);
        this.emit({ recording: false, recordingDuration: 0 });
        resolve(null);
        return;
      }
      this.recorder.onstop = () => {
        if (this.recTimer) clearInterval(this.recTimer);
        const blob = new Blob(this.recChunks, { type: this.recorder?.mimeType || 'audio/webm' });
        this.recorder = null;
        this.emit({ recording: false, recordingDuration: 0 });
        this.note('Recording saved');
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}

export const dj = new Engine();
