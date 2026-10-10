// Curated world wonders and user-saved bookmarks for all celestial bodies.

export interface Bookmark {
  id: string;
  bodyId: string;
  name: string;
  desc?: string;
  lat: number;
  lon: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
  curated?: boolean;
}

const KEY = 'shellb.maps.bookmarks.v1';

export const CURATED_BOOKMARKS: Bookmark[] = [
  // ── EARTH ─────────────────────────────────────────────────────────────
  {
    id: 'c-earth-ksc', bodyId: 'earth', name: 'Kennedy Space Center LC-39A',
    desc: 'Launch pad of Apollo 11, the Space Shuttle, and SpaceX Falcon Heavy.',
    lat: 28.6083, lon: -80.6041, zoom: 14.5, bearing: 45, pitch: 35, curated: true,
  },
  {
    id: 'c-earth-grand-canyon', bodyId: 'earth', name: 'Grand Canyon South Rim',
    desc: 'Breathtaking 1.8 km deep canyon carved by the Colorado River.',
    lat: 36.0544, lon: -112.1401, zoom: 11.5, bearing: 15, pitch: 40, curated: true,
  },
  {
    id: 'c-earth-everest', bodyId: 'earth', name: 'Mount Everest (Himalayas)',
    desc: 'Earth’s highest peak at 8,848.86 meters above sea level.',
    lat: 27.9881, lon: 86.9250, zoom: 11.8, bearing: 30, pitch: 50, curated: true,
  },
  {
    id: 'c-earth-pyramids', bodyId: 'earth', name: 'Great Pyramids of Giza',
    desc: 'Ancient monumental tombs on the Giza Plateau outside Cairo.',
    lat: 29.9792, lon: 31.1342, zoom: 14.5, bearing: 0, pitch: 25, curated: true,
  },
  {
    id: 'c-earth-starbase', bodyId: 'earth', name: 'SpaceX Starbase (Boca Chica)',
    desc: 'Starship production complex and orbital launch and catch tower.',
    lat: 25.9972, lon: -97.1567, zoom: 14.2, bearing: 90, pitch: 30, curated: true,
  },
  {
    id: 'c-earth-mariana', bodyId: 'earth', name: 'Mariana Trench (Challenger Deep)',
    desc: 'Deepest oceanic abyss on Earth (nearly 11,000 meters down).',
    lat: 11.3733, lon: 142.5917, zoom: 6.0, bearing: 0, pitch: 0, curated: true,
  },

  {
    id: 'c-earth-vezere', bodyId: 'earth', name: 'Vézère valley (Lascaux, Les Eyzies)',
    desc: 'The “valley of mankind”: Lascaux, Font-de-Gaume, Cro-Magnon and dozens of Ice Age caves and shelters.',
    lat: 44.97, lon: 1.06, zoom: 10.5, bearing: 0, pitch: 30, curated: true,
  },
  {
    id: 'c-earth-carnac', bodyId: 'earth', name: 'Carnac and the Gulf of Morbihan',
    desc: 'Over 3,000 standing stones, the broken menhir of Locmariaquer and the carved cairn of Gavrinis.',
    lat: 47.585, lon: -3.0, zoom: 11, bearing: 0, pitch: 30, curated: true,
  },
  {
    id: 'c-earth-gobekli', bodyId: 'earth', name: 'Göbekli Tepe',
    desc: 'Carved T-pillar enclosures raised by hunter-gatherers around 9600 BC.',
    lat: 37.2231, lon: 38.9225, zoom: 15, bearing: 0, pitch: 35, curated: true,
  },
  {
    id: 'c-earth-orkney', bodyId: 'earth', name: 'Heart of Neolithic Orkney',
    desc: 'Skara Brae, Maeshowe, the Ring of Brodgar and the Stones of Stenness.',
    lat: 59.02, lon: -3.25, zoom: 11, bearing: 0, pitch: 30, curated: true,
  },
  {
    id: 'c-earth-doggerland', bodyId: 'earth', name: 'Doggerland (North Sea)',
    desc: 'Dry land linking Britain to Europe until about 8,000 years ago; turn on Ice Age coast to see it.',
    lat: 54.5, lon: 3.0, zoom: 4.6, bearing: 0, pitch: 0, curated: true,
  },

  // ── MOON ─────────────────────────────────────────────────────────────
  {
    id: 'c-moon-apollo11', bodyId: 'moon', name: 'Tranquility Base (Apollo 11)',
    desc: 'First human landing site on the Moon (July 20, 1969).',
    lat: 0.6741, lon: 23.4730, zoom: 7.5, bearing: 0, pitch: 20, curated: true,
  },
  {
    id: 'c-moon-tycho', bodyId: 'moon', name: 'Tycho Crater & Central Peak',
    desc: 'Young 85 km impact crater with magnificent bright rays.',
    lat: -43.31, lon: -11.36, zoom: 6.8, bearing: 180, pitch: 35, curated: true,
  },
  {
    id: 'c-moon-copernicus', bodyId: 'moon', name: 'Copernicus Crater Terraces',
    desc: 'Spectacular 93 km crater with terraced walls in Oceanus Procellarum.',
    lat: 9.62, lon: -20.08, zoom: 6.5, bearing: 45, pitch: 30, curated: true,
  },
  {
    id: 'c-moon-hadley', bodyId: 'moon', name: 'Hadley Rille (Apollo 15)',
    desc: 'Sinuous volcanic collapse rille at the base of the Apennine Mountains.',
    lat: 26.1322, lon: 3.6339, zoom: 7.2, bearing: 30, pitch: 25, curated: true,
  },
  {
    id: 'c-moon-shackleton', bodyId: 'moon', name: 'Shackleton Crater (South Pole)',
    desc: 'Sunlit rim peaks surrounding deep permanently shadowed water ice.',
    lat: -89.9, lon: 0.0, zoom: 6.5, bearing: 0, pitch: 30, curated: true,
  },

  // ── MARS ─────────────────────────────────────────────────────────────
  {
    id: 'c-mars-olympus', bodyId: 'mars', name: 'Olympus Mons Summit Caldera',
    desc: 'Tallest volcano in the Solar System, rising 22 km into the thin Martian sky.',
    lat: 18.65, lon: -133.8, zoom: 5.5, bearing: 0, pitch: 45, curated: true,
  },
  {
    id: 'c-mars-valles', bodyId: 'mars', name: 'Valles Marineris (Grand Canyon of Mars)',
    desc: 'Enormous rift valley system spanning 4,000 km across the Tharsis bulge.',
    lat: -13.9, lon: -59.2, zoom: 4.8, bearing: 90, pitch: 35, curated: true,
  },
  {
    id: 'c-mars-jezero', bodyId: 'mars', name: 'Jezero Crater Delta (Perseverance)',
    desc: 'Ancient river delta lakebed where Perseverance is seeking signs of biosignatures.',
    lat: 18.38, lon: 77.58, zoom: 7.0, bearing: 45, pitch: 20, curated: true,
  },
  {
    id: 'c-mars-gale', bodyId: 'mars', name: 'Gale Crater & Mount Sharp (Curiosity)',
    desc: 'Mount Sharp rising 5.5 km from the ancient lake floor.',
    lat: -5.37, lon: 137.81, zoom: 6.8, bearing: 0, pitch: 25, curated: true,
  },
  {
    id: 'c-mars-noctis', bodyId: 'mars', name: 'Noctis Labyrinthus',
    desc: 'Intricate network of canyon fractures and plateau mesas.',
    lat: -7.0, lon: -102.0, zoom: 5.5, bearing: 270, pitch: 30, curated: true,
  },

  // ── VENUS ─────────────────────────────────────────────────────────────
  {
    id: 'c-venus-maxwell', bodyId: 'venus', name: 'Maxwell Montes',
    desc: 'Highest mountain range on Venus, rising 11 km into the dense atmosphere.',
    lat: 65.2, lon: 3.3, zoom: 5.0, bearing: 0, pitch: 30, curated: true,
  },
  {
    id: 'c-venus-maat', bodyId: 'venus', name: 'Maat Mons Volcano',
    desc: 'Massive shield volcano showing evidence of recent volcanic activity.',
    lat: 0.5, lon: -165.4, zoom: 5.2, bearing: 45, pitch: 25, curated: true,
  },

  // ── MERCURY ───────────────────────────────────────────────────────────
  {
    id: 'c-mercury-caloris', bodyId: 'mercury', name: 'Caloris Planitia',
    desc: 'One of the largest impact basins in the Solar System (1,550 km wide).',
    lat: 30.5, lon: -170.2, zoom: 4.5, bearing: 0, pitch: 20, curated: true,
  },

  // ── TITAN ─────────────────────────────────────────────────────────────
  {
    id: 'c-titan-kraken', bodyId: 'titan', name: 'Kraken Mare',
    desc: 'Vast sea of liquid methane and ethane in Titan’s northern polar region.',
    lat: 68.0, lon: -50.0, zoom: 3.0, bearing: 0, pitch: 0, curated: true,
  },

  // ── EUROPA ────────────────────────────────────────────────────────────
  {
    id: 'c-europa-conamara', bodyId: 'europa', name: 'Conamara Chaos',
    desc: 'Jigsaw ice rafts frozen into place above Europa’s subsurface global ocean.',
    lat: 8.8, lon: -87.1, zoom: 4.0, bearing: 0, pitch: 0, curated: true,
  },

  // ── CERES ─────────────────────────────────────────────────────────────
  {
    id: 'c-ceres-occator', bodyId: 'ceres', name: 'Occator Crater Faculae',
    desc: 'Brilliant sodium carbonate salt deposits from ancient hydrothermal cryovolcanism.',
    lat: 19.8, lon: -120.7, zoom: 5.0, bearing: 0, pitch: 20, curated: true,
  },

  // ── PLUTO ─────────────────────────────────────────────────────────────
  {
    id: 'c-pluto-sputnik', bodyId: 'pluto', name: 'Sputnik Planitia',
    desc: 'The great heart of Pluto: an active, convecting sea of solid nitrogen ice.',
    lat: 24.0, lon: 176.0, zoom: 4.2, bearing: 0, pitch: 0, curated: true,
  }
];

function loadCustom(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as Bookmark[] : [];
  } catch {
    return [];
  }
}

function saveCustom(list: Bookmark[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode
  }
}

export function getBookmarks(bodyId?: string): Bookmark[] {
  const custom = loadCustom();
  const all = [...CURATED_BOOKMARKS, ...custom];
  if (!bodyId) return all;
  return all.filter(b => b.bodyId.toLowerCase() === bodyId.toLowerCase());
}

export function addBookmark(bm: Omit<Bookmark, 'id' | 'curated'>): Bookmark {
  const custom = loadCustom();
  const created: Bookmark = {
    ...bm,
    id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    curated: false,
  };
  saveCustom([created, ...custom]);
  return created;
}

export function removeBookmark(id: string): void {
  const custom = loadCustom().filter(b => b.id !== id);
  saveCustom(custom);
}
