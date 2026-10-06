// Planetary landmarks, geological wonders, and historic space exploration landing sites.

export interface Landmark {
  id: string;
  bodyId: string;
  name: string;
  kind: 'mission' | 'crater' | 'volcano' | 'mountain' | 'canyon' | 'plain' | 'spaceport' | 'sea';
  lat: number;
  lon: number;
  agency?: string;
  year?: number;
  date?: string;
  country?: string;
  status?: string;
  vehicleType?: string;
  elevation?: string;
  diameter?: string;
  desc: string;
  highlight?: string;
}

export const LANDMARKS: Landmark[] = [
  // ── MOON ─────────────────────────────────────────────────────────────
  {
    id: 'apollo-11', bodyId: 'moon', name: 'Apollo 11 (Tranquility Base)', kind: 'mission',
    lat: 0.6741, lon: 23.4730, agency: 'NASA', year: 1969, date: 'July 20, 1969', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Eagle)',
    desc: 'First crewed lunar landing. Neil Armstrong and Buzz Aldrin spent 21.6 hours on the lunar surface, collecting 21.5 kg of samples.',
    highlight: '“That’s one small step for [a] man, one giant leap for mankind.”'
  },
  {
    id: 'apollo-12', bodyId: 'moon', name: 'Apollo 12', kind: 'mission',
    lat: -3.0124, lon: -23.4219, agency: 'NASA', year: 1969, date: 'November 19, 1969', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Intrepid)',
    desc: 'Pinpoint landing in Oceanus Procellarum, only 180 meters from the Surveyor 3 robotic probe landed in 1967. Retrieved parts of Surveyor.',
    highlight: 'Retrieved Surveyor 3 camera and components after 2.5 years on the surface.'
  },
  {
    id: 'apollo-14', bodyId: 'moon', name: 'Apollo 14', kind: 'mission',
    lat: -3.6453, lon: -17.4716, agency: 'NASA', year: 1971, date: 'February 5, 1971', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Antares)',
    desc: 'Fra Mauro highlands exploration by Alan Shepard and Edgar Mitchell. Shepard hit two golf balls with a makeshift 6-iron.',
    highlight: 'Alan Shepard famous lunar golf shots.'
  },
  {
    id: 'apollo-15', bodyId: 'moon', name: 'Apollo 15 (Hadley-Apennine)', kind: 'mission',
    lat: 26.1322, lon: 3.6339, agency: 'NASA', year: 1971, date: 'July 30, 1971', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Falcon) + LRV',
    desc: 'First "J-mission" featuring the Lunar Roving Vehicle (LRV). Explored Hadley Rille and the Apennine Mountains, finding the Genesis Rock.',
    highlight: 'First rover on another world; Galileo hammer & feather gravity drop experiment.'
  },
  {
    id: 'apollo-16', bodyId: 'moon', name: 'Apollo 16 (Descartes)', kind: 'mission',
    lat: -8.9730, lon: 15.5002, agency: 'NASA', year: 1972, date: 'April 21, 1972', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Orion) + LRV',
    desc: 'Explored Descartes Highlands. John Young and Charles Duke collected 95.8 kg of lunar samples and drove the rover 26.7 km.',
    highlight: 'Proved the lunar highlands are impact anorthosites rather than volcanic.'
  },
  {
    id: 'apollo-17', bodyId: 'moon', name: 'Apollo 17 (Taurus-Littrow)', kind: 'mission',
    lat: 20.1908, lon: 30.7717, agency: 'NASA', year: 1972, date: 'December 11, 1972', country: 'United States',
    status: 'Completed', vehicleType: 'Lunar Module (Challenger) + LRV',
    desc: 'Final Apollo lunar landing. Gene Cernan and geologist Harrison Schmitt spent 75 hours on the surface, discovering orange pyroclastic soil.',
    highlight: 'Last human footprints on the Moon (Gene Cernan, Dec 14, 1972).'
  },
  {
    id: 'luna-2', bodyId: 'moon', name: 'Luna 2', kind: 'mission',
    lat: 29.1000, lon: 0.0000, agency: 'Soviet Space Program', year: 1959, date: 'September 14, 1959', country: 'USSR',
    status: 'Impacted', vehicleType: 'Impactor probe',
    desc: 'First human-made spacecraft to reach the surface of the Moon, impacting Palus Putredinis east of Mare Serenitatis.',
    highlight: 'First human artifact on another celestial body.'
  },
  {
    id: 'luna-9', bodyId: 'moon', name: 'Luna 9', kind: 'mission',
    lat: 7.0800, lon: -64.3700, agency: 'Soviet Space Program', year: 1966, date: 'February 3, 1966', country: 'USSR',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'First successful soft landing on the Moon (and any celestial body). Transmitted the first panoramic photographs from the lunar surface.',
    highlight: 'Disproved the feared "deep dust sinkhole" hypothesis.'
  },
  {
    id: 'change-4', bodyId: 'moon', name: 'Chang’e 4 (Yutu-2)', kind: 'mission',
    lat: -45.444, lon: 177.599, agency: 'CNSA', year: 2019, date: 'January 3, 2019', country: 'China',
    status: 'Active', vehicleType: 'Lander & Rover',
    desc: 'First mission to achieve a soft landing on the far side of the Moon, touching down in Von Kármán crater in the South Pole-Aitken Basin.',
    highlight: 'First spacecraft on the lunar far side; relayed via Queqiao satellite.'
  },
  {
    id: 'chandrayaan-3', bodyId: 'moon', name: 'Chandrayaan-3 (Shiv Shakti Point)', kind: 'mission',
    lat: -69.373, lon: 32.319, agency: 'ISRO', year: 2023, date: 'August 23, 2023', country: 'India',
    status: 'Completed', vehicleType: 'Vikram Lander + Pragyan Rover',
    desc: 'First landing in the lunar southern polar region. Confirmed the presence of sulfur and measured thermal conductivity in lunar polar regolith.',
    highlight: 'First mission to land within 70° latitude of the Lunar South Pole.'
  },
  {
    id: 'tycho-crater', bodyId: 'moon', name: 'Tycho Crater', kind: 'crater',
    lat: -43.31, lon: -11.36, diameter: '85 km', elevation: '4.8 km deep',
    desc: 'Prominent, geologically young impact crater (~108 million years old) with a dramatic ray system visible across the entire lunar disc.',
    highlight: 'Central peak rises 2 km above the crater floor.'
  },
  {
    id: 'copernicus-crater', bodyId: 'moon', name: 'Copernicus Crater', kind: 'crater',
    lat: 9.62, lon: -20.08, diameter: '93 km', elevation: '3.8 km deep',
    desc: 'Iconic complex crater in eastern Oceanus Procellarum with pronounced terraced walls and a group of central peaks rising 1.2 km.',
    highlight: 'Prototypical Copernican-era lunar crater.'
  },
  {
    id: 'shackleton-crater', bodyId: 'moon', name: 'Shackleton Crater', kind: 'crater',
    lat: -89.9, lon: 0.0, diameter: '21 km', elevation: '4.2 km deep',
    desc: 'Located at the lunar South Pole. Rim peaks receive almost continuous sunlight while the interior is in permanent shadow holding water ice.',
    highlight: 'Primary target for NASA Artemis crewed landings and lunar bases.'
  },
  {
    id: 'mare-tranquillitatis', bodyId: 'moon', name: 'Mare Tranquillitatis', kind: 'sea',
    lat: 8.5, lon: 31.4, diameter: '873 km',
    desc: 'The Sea of Tranquility: vast basaltic plain formed by ancient volcanic flooding. Basalts here have a high titanium content giving a bluish tint.'
  },

  // ── MARS ─────────────────────────────────────────────────────────────
  {
    id: 'perseverance', bodyId: 'mars', name: 'Perseverance & Ingenuity (Jezero)', kind: 'mission',
    lat: 18.4447, lon: 77.4508, agency: 'NASA', year: 2021, date: 'February 18, 2021', country: 'United States',
    status: 'Active', vehicleType: 'Rover & Rotorcraft',
    desc: 'Exploring the ancient river delta of Jezero Crater seeking signs of ancient microbial life. Ingenuity achieved 72 powered flights in Mars atmosphere.',
    highlight: 'Collected sample tubes cached for future Mars Sample Return; first powered flight on another planet.'
  },
  {
    id: 'curiosity', bodyId: 'mars', name: 'Curiosity (Gale Crater)', kind: 'mission',
    lat: -4.5895, lon: 137.4417, agency: 'NASA', year: 2012, date: 'August 6, 2012', country: 'United States',
    status: 'Active', vehicleType: 'Rover (Mars Science Lab)',
    desc: 'Climbing the slopes of Mount Sharp (Aeolis Mons) in Gale Crater. Confirmed that ancient Mars had liquid freshwater lakes suitable for life.',
    highlight: 'Over 30 km driven across Martian dunes, mudstones, and clay sulfates.'
  },
  {
    id: 'opportunity', bodyId: 'mars', name: 'Opportunity (Meridiani Planum)', kind: 'mission',
    lat: -1.9462, lon: -5.5266, agency: 'NASA', year: 2004, date: 'January 25, 2004', country: 'United States',
    status: 'Completed', vehicleType: 'Rover (MER-B)',
    desc: 'Operated for 14 years and 138 days on a 90-day nominal mission, traversing 45.16 km and finding hematite "blueberries" proving past liquid water.',
    highlight: 'Record distance driven on another celestial body (45.16 km).'
  },
  {
    id: 'spirit', bodyId: 'mars', name: 'Spirit (Gusev Crater)', kind: 'mission',
    lat: -14.5684, lon: 175.4726, agency: 'NASA', year: 2004, date: 'January 4, 2004', country: 'United States',
    status: 'Completed', vehicleType: 'Rover (MER-A)',
    desc: 'Twin of Opportunity. Uncovered almost pure silica in Home Plate, revealing past hydrothermal springs or fumaroles.',
    highlight: 'Discovered ancient hydrothermal activity in Gusev Crater.'
  },
  {
    id: 'viking-1', bodyId: 'mars', name: 'Viking 1 Lander', kind: 'mission',
    lat: 22.697, lon: -47.95, agency: 'NASA', year: 1976, date: 'July 20, 1976', country: 'United States',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'First spacecraft to successfully land on Mars and operate for long duration (6 years, 116 days). Performed first in-situ biology experiments.',
    highlight: 'First high-resolution colour surface photographs of the Martian landscape.'
  },
  {
    id: 'viking-2', bodyId: 'mars', name: 'Viking 2 Lander', kind: 'mission',
    lat: 48.269, lon: 134.01, agency: 'NASA', year: 1976, date: 'September 3, 1976', country: 'United States',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'Touched down in Utopia Planitia, operating for 1,281 Martian sols. Measured atmospheric composition, meteorology, and seismic vibrations.',
    highlight: 'Discovered water ice frost coating Martian rocks in winter.'
  },
  {
    id: 'pathfinder', bodyId: 'mars', name: 'Mars Pathfinder (Sojourner)', kind: 'mission',
    lat: 19.13, lon: -33.22, agency: 'NASA', year: 1997, date: 'July 4, 1997', country: 'United States',
    status: 'Completed', vehicleType: 'Lander & First Rover',
    desc: 'Ares Vallis flood plain landing using airbags. Deployed Sojourner, the first robotic rover on Mars, which analyzed rocks Barnacle Bill and Yogi.',
    highlight: 'Pioneered low-cost planetary exploration and airbag landing.'
  },
  {
    id: 'insight', bodyId: 'mars', name: 'InSight Lander', kind: 'mission',
    lat: 4.5024, lon: 135.6234, agency: 'NASA', year: 2018, date: 'November 26, 2018', country: 'United States',
    status: 'Completed', vehicleType: 'Geophysical Lander',
    desc: 'Stationary lander in Elysium Planitia. Deployed the SEIS ultra-sensitive seismometer, recording over 1,300 marsquakes and mapping Mars core and mantle.',
    highlight: 'Discovered Mars has a liquid, metallic molten core and active crustal quakes.'
  },
  {
    id: 'zhurong', bodyId: 'mars', name: 'Zhurong (Tianwen-1)', kind: 'mission',
    lat: 25.066, lon: 109.925, agency: 'CNSA', year: 2021, date: 'May 14, 2021', country: 'China',
    status: 'Completed', vehicleType: 'Rover',
    desc: 'Landed in southern Utopia Planitia. Used ground-penetrating radar to detect underground layered structures from ancient floods.',
    highlight: 'First Chinese rover on Mars; detected buried polygon structures from ancient floods.'
  },
  {
    id: 'olympus-mons', bodyId: 'mars', name: 'Olympus Mons', kind: 'volcano',
    lat: 21.9, lon: -133.8, elevation: '21.9 km above datum', diameter: '624 km',
    desc: 'The largest volcano and highest known planetary mountain in the Solar System. Its summit caldera is 80 km wide and its cliffs drop 6 km to the surrounding plains.',
    highlight: 'Nearly 2.5 times the height of Mount Everest above sea level.'
  },
  {
    id: 'valles-marineris', bodyId: 'mars', name: 'Valles Marineris (Coprates Chasma)', kind: 'canyon',
    lat: -14.0, lon: -59.0, diameter: '4,000 km long', elevation: 'Up to 7 km deep',
    desc: 'The Grand Canyon of Mars, stretching one-fifth of the entire circumference of the planet. Would span from New York to San Francisco on Earth.',
    highlight: 'Deepest and longest tectonic rift canyon in the Solar System.'
  },
  {
    id: 'noctis-labyrinthus', bodyId: 'mars', name: 'Noctis Labyrinthus', kind: 'canyon',
    lat: -7.0, lon: -102.0, diameter: '1,200 km',
    desc: '“Labyrinth of the Night”: a maze-like system of deep, steep-walled intersecting valleys and grabens at the western edge of Valles Marineris.'
  },
  {
    id: 'gale-crater', bodyId: 'mars', name: 'Gale Crater (Mount Sharp)', kind: 'crater',
    lat: -5.37, lon: 137.81, diameter: '154 km', elevation: '5.5 km central mound',
    desc: 'Ancient impact basin filled with layered sedimentary rock strata, preserving billions of years of Martian climate transition from water to desert.'
  },

  // ── VENUS ─────────────────────────────────────────────────────────────
  {
    id: 'venera-7', bodyId: 'venus', name: 'Venera 7', kind: 'mission',
    lat: -5.0, lon: -9.0, agency: 'Soviet Space Program', year: 1970, date: 'December 15, 1970', country: 'USSR',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'First successful soft landing and data transmission from the surface of another planet. Measured 475°C and 90 atmospheres of pressure.',
    highlight: 'First man-made object to return signals from the surface of another planet.'
  },
  {
    id: 'venera-9', bodyId: 'venus', name: 'Venera 9', kind: 'mission',
    lat: 31.01, lon: -68.36, agency: 'Soviet Space Program', year: 1975, date: 'October 22, 1975', country: 'USSR',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'Transmitted the first black-and-white panoramic photograph of the Venusian surface, revealing sharp basaltic rocks with minimal shadow.',
    highlight: 'First surface photograph of Venus.'
  },
  {
    id: 'venera-13', bodyId: 'venus', name: 'Venera 13', kind: 'mission',
    lat: -7.5, lon: -57.0, agency: 'Soviet Space Program', year: 1982, date: 'March 1, 1982', country: 'USSR',
    status: 'Completed', vehicleType: 'Lander',
    desc: 'Survived 127 minutes in 457°C heat. Returned the first color panoramic surface photographs and audio recordings of wind on Venus.',
    highlight: 'First color surface photos and acoustic recording of Venus wind.'
  },
  {
    id: 'maxwell-montes', bodyId: 'venus', name: 'Maxwell Montes', kind: 'mountain',
    lat: 65.2, lon: 3.3, elevation: '11 km high', diameter: '853 km',
    desc: 'The highest mountain range on Venus, rising 11 km above mean radius. Radar-reflective summit likely coated with heavy metallic bismuth or pyrite "snow".',
    highlight: 'Coolest and lowest-pressure location on the surface of Venus (380°C, 45 atm).'
  },
  {
    id: 'maat-mons', bodyId: 'venus', name: 'Maat Mons', kind: 'volcano',
    lat: 0.5, lon: -165.4, elevation: '8 km above radius', diameter: '395 km',
    desc: 'The highest volcano on Venus. Magellan radar imagery showed fresh volcanic lava flows, suggesting recent or active volcanism.',
    highlight: 'Likely site of active Venusian volcanism.'
  },

  // ── MERCURY ───────────────────────────────────────────────────────────
  {
    id: 'caloris-planitia', bodyId: 'mercury', name: 'Caloris Planitia', kind: 'plain',
    lat: 30.5, lon: -170.2, diameter: '1,550 km',
    desc: 'One of the largest impact basins in the Solar System. The asteroid impact was so energetic it sent seismic waves through the core, creating the "Weird Terrain" on the exact opposite side of Mercury.',
    highlight: 'Impact created seismic disruption on the antipodal point of Mercury.'
  },
  {
    id: 'messenger-impact', bodyId: 'mercury', name: 'MESSENGER Impact Site', kind: 'mission',
    lat: 54.4, lon: -149.9, agency: 'NASA', year: 2015, date: 'April 30, 2015', country: 'United States',
    status: 'Impacted', vehicleType: 'Orbiter end-of-mission',
    desc: 'After 4 years in orbit discovering water ice in permanently shadowed polar craters and volatile sodium/sulfur, MESSENGER impacted Mercury at 3.9 km/s.'
  },

  // ── TITAN ─────────────────────────────────────────────────────────────
  {
    id: 'huygens-landing', bodyId: 'titan', name: 'Huygens Landing Site', kind: 'mission',
    lat: -10.3, lon: -167.6, agency: 'ESA / NASA', year: 2005, date: 'January 14, 2005', country: 'European Union / US',
    status: 'Completed', vehicleType: 'Atmospheric Probe',
    desc: 'Landed in soft clay-like damp hydrocarbon sand surrounded by rounded water-ice pebbles. Transmitted for 72 minutes from the surface.',
    highlight: 'Only landing in the outer Solar System (1.4 billion km from Earth).'
  },
  {
    id: 'kraken-mare', bodyId: 'titan', name: 'Kraken Mare', kind: 'sea',
    lat: 68.0, lon: -50.0, diameter: '1,170 km long', elevation: 'Area: 400,000 km²',
    desc: 'The largest body of liquid on Titan’s surface, composed of liquid methane, ethane, and dissolved nitrogen. Larger than the Caspian Sea on Earth.',
    highlight: 'Estimated depth exceeds 300 meters in Moray Sinus.'
  },

  // ── CERES ─────────────────────────────────────────────────────────────
  {
    id: 'occator-crater', bodyId: 'ceres', name: 'Occator Crater (Bright Spots)', kind: 'crater',
    lat: 19.8, lon: -120.7, diameter: '92 km', elevation: '4 km deep',
    desc: 'Famous for the Cerealia and Vinalia Faculae: brilliant bright deposits of sodium carbonate salts left behind by subsurface hydrothermal brines.',
    highlight: 'Brightest deposits in the asteroid belt, evidence of recent cryovolcanism.'
  },
  {
    id: 'ahuna-mons', bodyId: 'ceres', name: 'Ahuna Mons', kind: 'mountain',
    lat: -10.4, lon: -43.8, elevation: '4 km high', diameter: '20 km base',
    desc: 'Solitary, steep-sided volcanic dome formed by cryovolcanism—an ice volcano that erupted viscous mud and salt slurry onto Ceres’ surface.',
    highlight: 'Premier example of an extraterrestrial cryovolcanic dome.'
  },

  // ── EUROPA ────────────────────────────────────────────────────────────
  {
    id: 'conamara-chaos', bodyId: 'europa', name: 'Conamara Chaos', kind: 'plain',
    lat: 8.8, lon: -87.1, diameter: '150 km',
    desc: 'Region of chaotic terrain on Jupiter’s moon Europa. Vast ice rafts and jigsaw-puzzle slabs that broke apart, drifted, and refroze in a slushy brine sea.',
    highlight: 'Key evidence for a dynamic liquid water ocean beneath Europa’s ice crust.'
  },

  // ── EARTH SPACEPORTS & WONDERS ─────────────────────────────────────────
  {
    id: 'ksc', bodyId: 'earth', name: 'Kennedy Space Center (LC-39A)', kind: 'spaceport',
    lat: 28.5729, lon: -80.6490, agency: 'NASA / SpaceX', country: 'United States',
    desc: 'Historic launch complex: launch site for Apollo 11, the first and last Space Shuttle missions, and SpaceX Falcon Heavy / Crew Dragon flights.',
    highlight: 'Launch site for humans to the Moon (Saturn V LC-39A).'
  },
  {
    id: 'cape-canaveral', bodyId: 'earth', name: 'Cape Canaveral SFS (SLC-40)', kind: 'spaceport',
    lat: 28.5620, lon: -80.5772, agency: 'US Space Force / SpaceX', country: 'United States',
    desc: 'Active orbital launch site on Florida’s Space Coast with over 200 orbital launches.',
    highlight: 'One of the world’s busiest spaceports.'
  },
  {
    id: 'starbase', bodyId: 'earth', name: 'Starbase (Boca Chica, TX)', kind: 'spaceport',
    lat: 25.9972, lon: -97.1567, agency: 'SpaceX', country: 'United States',
    desc: 'Launch site and manufacturing facility for SpaceX Starship and Super Heavy booster, the largest rocket ever flown.',
    highlight: 'Home of the Mechazilla "chopsticks" launch and catch tower.'
  },
  {
    id: 'baikonur', bodyId: 'earth', name: 'Baikonur Cosmodrome (Site 1)', kind: 'spaceport',
    lat: 45.9203, lon: 63.3422, agency: 'Roscosmos', country: 'Kazakhstan',
    desc: 'World’s first and largest operational space launch facility. Site 1 ("Gagarin’s Start") launched Sputnik 1 in 1957 and Yuri Gagarin in 1961.',
    highlight: 'Launch site of Sputnik 1 and the first human in space.'
  },
  {
    id: 'kourou', bodyId: 'earth', name: 'Guiana Space Centre (Kourou)', kind: 'spaceport',
    lat: 5.2394, lon: -52.7686, agency: 'ESA / CNES / Arianespace', country: 'French Guiana',
    desc: 'Europe’s primary spaceport. Located 5° north of the Equator, giving rockets maximum boost from Earth’s rotation. Launched James Webb Space Telescope.',
    highlight: 'Launch site of the James Webb Space Telescope (JWST).'
  },
  {
    id: 'tanegashima', bodyId: 'earth', name: 'Tanegashima Space Center', kind: 'spaceport',
    lat: 30.3997, lon: 130.9706, agency: 'JAXA', country: 'Japan',
    desc: 'Japan’s main rocket launch site, perched on a scenic ocean promontory on Tanegashima island. Launches H-IIA and H3 rockets.',
    highlight: 'Widely considered the most picturesque launch site in the world.'
  },
  {
    id: 'grand-canyon', bodyId: 'earth', name: 'Grand Canyon', kind: 'canyon',
    lat: 36.1069, lon: -112.1129, diameter: '446 km long', elevation: '1.8 km deep',
    desc: 'Carved over 6 million years by the Colorado River, exposing nearly two billion years of Earth’s geological history in towering cliffs.'
  },
  {
    id: 'everest', bodyId: 'earth', name: 'Mount Everest (Sagarmatha)', kind: 'mountain',
    lat: 27.9881, lon: 86.9250, elevation: '8,848.86 m',
    desc: 'Earth’s highest mountain above sea level, located in the Mahalangur Himal sub-range of the Himalayas on the China–Nepal border.'
  },
  {
    id: 'mariana-trench', bodyId: 'earth', name: 'Challenger Deep (Mariana Trench)', kind: 'canyon',
    lat: 11.3733, lon: 142.5917, elevation: '10,928 m deep',
    desc: 'The deepest known point in Earth’s oceans, situated in the western Pacific Ocean. The water pressure exceeds 1,000 times atmospheric pressure.'
  }
];

export function getLandmarksForBody(bodyId: string): Landmark[] {
  return LANDMARKS.filter(l => l.bodyId === bodyId);
}

export function searchLandmarks(query: string, bodyId?: string): Landmark[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pool = bodyId ? LANDMARKS.filter(l => l.bodyId === bodyId) : LANDMARKS;
  return pool.filter(l =>
    l.name.toLowerCase().includes(q) ||
    l.desc.toLowerCase().includes(q) ||
    (l.agency && l.agency.toLowerCase().includes(q)) ||
    (l.country && l.country.toLowerCase().includes(q)) ||
    l.kind.toLowerCase().includes(q)
  );
}
