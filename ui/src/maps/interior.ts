// Interior structure of the worlds, for the dossier's cross-section: layer radii as fractions of the mean radius,
// from published interior models (seismology for Earth and the Moon, InSight for Mars, gravity and magnetic data
// elsewhere). Schematic: thin crusts and ice shells are drawn no thinner than they can be seen.

export interface InteriorLayer { name: string; r: number; color: string; note?: string }
export interface Interior { layers: InteriorLayer[]; note: string; source: string }

const L = (name: string, r: number, color: string, note?: string): InteriorLayer => ({ name, r, color, note });

export const INTERIORS: Record<string, Interior> = {
  sol: { layers: [L('Core', 0.25, '#fff7d6', 'Hydrogen fusion, 15 million K'), L('Radiative zone', 0.7, '#ffd36b', 'Energy crawls out as light over ~170,000 years'), L('Convective zone', 1.0, '#ff9f3d', 'Boiling plasma cells, the granulation we see')],
    note: 'Standard solar model.', source: 'Helioseismology (SOHO/MDI, GONG)' },
  mercury: { layers: [L('Solid inner core', 0.33, '#f1f5f9'), L('Liquid outer core', 0.83, '#f59e0b', 'Still partly molten: a weak dipole field'), L('Mantle', 0.985, '#9a6a4a'), L('Crust', 1.0, '#b8a999', '~35 km')],
    note: 'The largest core for its size of any planet: about 85% of the radius.', source: 'MESSENGER gravity and libration' },
  venus: { layers: [L('Core', 0.53, '#f59e0b', 'Probably at least partly liquid; no field'), L('Mantle', 0.995, '#b4582a'), L('Crust', 1.0, '#d9b36b', '~30 km, basaltic')],
    note: 'Earth-like layering inferred from size and density; no seismometer has survived long enough to check.', source: 'Magellan gravity, Venera landers' },
  earth: { layers: [L('Inner core', 0.19, '#fef3c7', 'Solid iron-nickel, 1,220 km'), L('Outer core', 0.546, '#f59e0b', 'Liquid iron: the geodynamo'), L('Lower mantle', 0.895, '#c2410c'), L('Upper mantle', 0.995, '#ea8a3a'), L('Crust', 1.0, '#8aa3b6', '7 km under oceans, ~35 km continents')],
    note: 'The PREM reference model.', source: 'Seismology (Dziewonski & Anderson 1981)' },
  moon: { layers: [L('Inner core', 0.138, '#fef3c7', '~240 km, solid'), L('Outer core', 0.19, '#f59e0b', 'Liquid, ~330 km'), L('Partial melt', 0.28, '#dc6b3a', 'Low-velocity zone'), L('Mantle', 0.977, '#8c8578'), L('Crust', 1.0, '#d6d3d1', '~40 km, anorthosite')],
    note: 'From the reanalysis of Apollo seismic data.', source: 'Weber et al. 2011; GRAIL gravity' },
  mars: { layers: [L('Liquid core', 0.54, '#f59e0b', '~1,830 km; molten, sulphur-rich'), L('Mantle', 0.985, '#b4512a'), L('Crust', 1.0, '#d08a5c', '24-72 km')],
    note: 'Measured by the InSight seismometer in 2021.', source: 'Stähler et al. 2021 (InSight SEIS)' },
  phobos: { layers: [L('Rubble interior', 1.0, '#a8a29e', 'Porous: ~30% empty space')], note: 'A rubble pile, probably with a thick regolith.', source: 'Mars Express gravity' },
  ceres: { layers: [L('Rocky core', 0.9, '#78716c', 'Hydrated rock'), L('Volatile-rich crust', 1.0, '#cbd5e1', '~40 km of ice, salts and clathrates; brine pockets')],
    note: 'Partly differentiated; brines still reach the surface at Occator.', source: 'Dawn gravity and topography' },
  vesta: { layers: [L('Iron core', 0.42, '#f59e0b', '~110 km'), L('Mantle', 0.93, '#8c7a63', 'Olivine'), L('Crust', 1.0, '#9ca3af', 'Basaltic, ~20 km')],
    note: 'A protoplanet that differentiated like the terrestrial planets.', source: 'Dawn; HED meteorites' },
  jupiter: { layers: [L('Dilute core', 0.3, '#fde68a', 'Heavy elements mixed into hydrogen'), L('Metallic hydrogen', 0.8, '#d97706', 'Conducting liquid: the strongest planetary field'), L('Molecular hydrogen', 1.0, '#f5c87a', 'Helium rain near the transition')],
    note: 'Juno found a larger, fuzzier core than expected.', source: 'Juno gravity (Wahl et al. 2017)' },
  io: { layers: [L('Core', 0.52, '#f59e0b', 'Iron / iron sulphide'), L('Partly molten asthenosphere', 0.98, '#dc6b3a', 'Tidal heating; feeds 400 volcanoes'), L('Crust', 1.0, '#fde68a', 'Sulphur-coated silicate')],
    note: 'Heated by tides from Jupiter, Europa and Ganymede.', source: 'Galileo gravity and magnetometer' },
  europa: { layers: [L('Metallic core', 0.4, '#f59e0b'), L('Rocky mantle', 0.935, '#8c7a63'), L('Salty ocean', 0.985, '#1d4ed8', '60-150 km deep: twice Earth’s water'), L('Ice shell', 1.0, '#bfe6ff', '15-25 km')],
    note: 'The ocean shows in Jupiter’s induced magnetic field.', source: 'Galileo magnetometer (Kivelson et al. 2000)' },
  ganymede: { layers: [L('Iron core', 0.27, '#f59e0b', 'Makes its own magnetic field'), L('Rock mantle', 0.68, '#8c7a63'), L('High-pressure ice', 0.83, '#93c5fd'), L('Ocean', 0.9, '#1d4ed8', 'Salty, ~100 km'), L('Ice shell', 1.0, '#dbeafe', '~150 km')],
    note: 'Possibly several oceans sandwiched between ice phases.', source: 'Galileo; Hubble aurorae (Saur et al. 2015)' },
  callisto: { layers: [L('Rock and ice mix', 0.9, '#78716c', 'Never fully separated'), L('Ocean?', 0.94, '#1d4ed8', 'Hinted by induced field'), L('Icy crust', 1.0, '#cbd5e1', '~150 km')],
    note: 'The least differentiated of the big moons.', source: 'Galileo gravity and magnetometer' },
  saturn: { layers: [L('Core', 0.2, '#fde68a', 'Rock and ice, diffuse'), L('Metallic hydrogen', 0.5, '#d97706'), L('Molecular hydrogen', 1.0, '#f3dc9a', 'Helium rain releases heat')],
    note: 'Cassini’s ring seismology probed the deep interior.', source: 'Cassini gravity and ring waves (Mankovich 2019)' },
  mimas: { layers: [L('Rock core', 0.6, '#78716c'), L('Ocean?', 0.88, '#1d4ed8', 'Suggested by its libration (2024)'), L('Ice shell', 1.0, '#e2e8f0', '20-30 km')], note: 'A young ocean may hide under the cratered ice.', source: 'Cassini libration (Lainey et al. 2024)' },
  enceladus: { layers: [L('Porous rock core', 0.75, '#78716c', 'Water circulates and is heated inside'), L('Global ocean', 0.88, '#1d4ed8', '~30 km deep'), L('Ice shell', 1.0, '#e0f2fe', '20-25 km; only ~5 km at the south pole')],
    note: 'The south-polar plumes sample the ocean directly.', source: 'Cassini gravity and libration (Thomas et al. 2016)' },
  tethys: { layers: [L('Ice-rock interior', 1.0, '#cbd5e1', 'Almost pure water ice')], note: 'Density 0.98: nearly all ice.', source: 'Cassini' },
  dione: { layers: [L('Rock core', 0.7, '#78716c'), L('Ocean?', 0.82, '#1d4ed8', 'Possible, deep'), L('Ice shell', 1.0, '#e2e8f0', '~100 km')], note: 'Gravity hints at a buried ocean.', source: 'Cassini gravity (Beuthe et al. 2016)' },
  rhea: { layers: [L('Ice-rock interior', 1.0, '#cbd5e1', 'Undifferentiated or weakly so')], note: 'Mostly ice with rock mixed in.', source: 'Cassini gravity' },
  titan: { layers: [L('Rock core', 0.8, '#78716c', 'Hydrated silicates'), L('High-pressure ice', 0.9, '#93c5fd'), L('Water-ammonia ocean', 0.96, '#1d4ed8'), L('Ice shell', 1.0, '#fcd9a8', '~100 km, under the orange haze')],
    note: 'Tides measured by Cassini require an ocean.', source: 'Cassini gravity (Iess et al. 2012)' },
  iapetus: { layers: [L('Ice-rock interior', 1.0, '#a8a29e', 'Frozen rigid very early')], note: 'Its equatorial ridge and oblate shape are relics of a fast early spin.', source: 'Cassini' },
  uranus: { layers: [L('Rock core', 0.2, '#78716c'), L('Water-ammonia-methane mantle', 0.8, '#0ea5e9', 'Hot ionic ocean; makes the tilted field'), L('Hydrogen-helium atmosphere', 1.0, '#99f6e4')],
    note: 'An ice giant: mostly fluid ices, little hydrogen.', source: 'Voyager 2 and models' },
  neptune: { layers: [L('Rock core', 0.2, '#78716c'), L('Water-ammonia-methane mantle', 0.8, '#1d4ed8', 'Possibly diamond rain'), L('Hydrogen-helium atmosphere', 1.0, '#60a5fa')],
    note: 'Same build as Uranus, with more internal heat.', source: 'Voyager 2 and models' },
  triton: { layers: [L('Rock core', 0.7, '#78716c'), L('Ocean?', 0.8, '#1d4ed8', 'Kept liquid by ammonia and tides'), L('Ice crust', 1.0, '#fbcfe8', 'Nitrogen frost on top')], note: 'A captured Kuiper belt object.', source: 'Voyager 2 and models' },
  pluto: { layers: [L('Rock core', 0.7, '#78716c'), L('Ocean?', 0.83, '#1d4ed8', 'Hinted by Sputnik Planitia’s position'), L('Ice shell', 1.0, '#e9d5ff', 'Nitrogen and methane ices on top')],
    note: 'New Horizons made a subsurface ocean plausible.', source: 'Nimmo et al. 2016' },
  charon: { layers: [L('Rock core', 0.6, '#78716c'), L('Ice mantle', 1.0, '#d4d4d8', 'An ancient ocean froze and cracked the surface')], note: 'Freezing expanded the ice and split the crust.', source: 'New Horizons' },
};

export const getInterior = (id: string): Interior | null => INTERIORS[id.toLowerCase()] ?? null;
