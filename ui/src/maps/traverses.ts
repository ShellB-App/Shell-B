// Historical surface expedition traverses & rover tracks for Mars and the Moon.
// Contains real-world coordinate tracks, waypoints, scientific discoveries, and MapLibre layers.
import type * as ML from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { MapLib } from './core';

export interface TraverseWaypoint {
  id: string;
  name: string;
  solOrEva: string;
  date?: string;
  lat: number;
  lon: number;
  distFromStartKm?: number;
  desc: string;
  discovery?: string;
  instrument?: string;
}

export interface Traverse {
  id: string;
  bodyId: 'mars' | 'moon';
  name: string;
  vehicle: string;
  operator: string;
  launchYear: number;
  landingDate: string;
  status: 'Active' | 'Completed';
  totalKm: number;
  duration: string;
  color: string;
  glowColor: string;
  description: string;
  highlight: string;
  center: { lat: number; lon: number };
  zoom: number;
  path: [number, number][]; // [lat, lon]
  waypoints: TraverseWaypoint[];
}

export const TRAVERSES: Traverse[] = [
  // ── MARS: PERSEVERANCE & INGENUITY (Jezero Crater) ────────────────────────
  {
    id: 'perseverance-jezero',
    bodyId: 'mars',
    name: 'Perseverance Rover & Ingenuity',
    vehicle: 'Mars 2020 Rover + Rotorcraft',
    operator: 'NASA / JPL',
    launchYear: 2020,
    landingDate: 'February 18, 2021',
    status: 'Active',
    totalKm: 29.4,
    duration: '2021 – Present (1,250+ sols)',
    color: '#38bdf8',
    glowColor: 'rgba(56, 189, 248, 0.4)',
    description: 'Exploring the ancient river delta and paleolake of Jezero Crater seeking biosignatures and caching core samples for Earth return.',
    highlight: 'Cached 24+ sealed sample tubes; Ingenuity achieved 72 powered atmospheric flights.',
    center: { lat: 18.455, lon: 77.435 },
    zoom: 13,
    path: [
      [18.4447, 77.4508], // Octavia E. Butler Landing
      [18.4420, 77.4485], // South Séítah overlook
      [18.4385, 77.4420], // Roubion (first drill attempt)
      [18.4360, 77.4380], // Citadelle / Rochette (first successful core)
      [18.4420, 77.4300], // Séítah crossing
      [18.4480, 77.4250], // Return to landing site vicinity
      [18.4550, 77.4180], // Delta front arrival (Three Forks)
      [18.4580, 77.4120], // Hawksbill Gap delta ascent
      [18.4610, 77.4080], // Amalik outcrop
      [18.4650, 77.4030], // Berea & delta top
      [18.4720, 77.3950], // Belva impact crater overlook
      [18.4780, 77.3880], // Margin Campaign
      [18.4840, 77.3810], // Bright Angel carbonaceous rocks
      [18.4900, 77.3750], // Neretva Vallis breach
    ],
    waypoints: [
      {
        id: 'percy-land',
        name: 'Octavia E. Butler Landing',
        solOrEva: 'Sol 0',
        date: 'Feb 18, 2021',
        lat: 18.4447,
        lon: 77.4508,
        distFromStartKm: 0.0,
        desc: 'Sky crane touchdown site on the basaltic floor of Jezero Crater.',
        discovery: 'Confirmed volcanic basalt floor overlying older lake sediments.',
      },
      {
        id: 'percy-rochette',
        name: 'Rochette / Citadelle Core',
        solOrEva: 'Sol 190',
        date: 'Sep 1, 2021',
        lat: 18.4360,
        lon: 77.4380,
        distFromStartKm: 2.3,
        desc: 'First successfully cored Martian rock sample (Montdenier).',
        instrument: 'PIXL, SHERLOC, Coring Drill',
        discovery: 'Identified olivine-rich volcanic rock altered by liquid water.',
      },
      {
        id: 'percy-three-forks',
        name: 'Three Forks Sample Depot',
        solOrEva: 'Sol 650',
        date: 'Dec 21, 2022',
        lat: 18.4550,
        lon: 77.4180,
        distFromStartKm: 13.8,
        desc: 'First sample depot on another world: 10 backup titanium tubes placed on surface.',
        discovery: 'Established backup sample collection for Mars Sample Return.',
      },
      {
        id: 'percy-belva',
        name: 'Belva Crater Overlook',
        solOrEva: 'Sol 770',
        date: 'Apr 22, 2023',
        lat: 18.4720,
        lon: 77.3950,
        distFromStartKm: 18.5,
        desc: 'Large 1 km impact crater excavated into the delta, exposing deep sedimentary layers.',
        instrument: 'Mastcam-Z, SuperCam',
        discovery: 'Steeply tilted river conglomerate boulders showing violent flood stages.',
      },
      {
        id: 'percy-bright-angel',
        name: 'Bright Angel Outcrop',
        solOrEva: 'Sol 1170',
        date: 'Jun 8, 2024',
        lat: 18.4840,
        lon: 77.3810,
        distFromStartKm: 27.2,
        desc: 'Cheyava Falls rock sample with organic carbon, iron phosphate "leopard spots", and vivianite.',
        instrument: 'SHERLOC, PIXL Raman',
        discovery: 'Potential chemical biosignatures from ancient microbial energy metabolism.',
      },
    ],
  },

  // ── MARS: CURIOSITY (Gale Crater & Mount Sharp) ───────────────────────────
  {
    id: 'curiosity-gale',
    bodyId: 'mars',
    name: 'Curiosity Rover (Gale Crater)',
    vehicle: 'Mars Science Laboratory',
    operator: 'NASA / JPL',
    launchYear: 2011,
    landingDate: 'August 6, 2012',
    status: 'Active',
    totalKm: 32.1,
    duration: '2012 – Present (4,300+ sols)',
    color: '#fb923c',
    glowColor: 'rgba(251, 146, 60, 0.4)',
    description: 'Climbing the 5.5 km high sedimentary layers of Mount Sharp (Aeolis Mons) to read Mars’s environmental transition from wet to arid.',
    highlight: 'Proved ancient Gale Crater hosted long-lived habitable freshwater lakes with organic carbon.',
    center: { lat: -4.68, lon: 137.38 },
    zoom: 12,
    path: [
      [-4.5895, 137.4417], // Bradbury Landing
      [-4.5920, 137.4520], // Yellowknife Bay (John Klein drill)
      [-4.6200, 137.4200], // The Kimberley
      [-4.6450, 137.3980], // Pahrump Hills (base of Mt. Sharp)
      [-4.6700, 137.3820], // Namib Dune (Bagnold Dune Field)
      [-4.7100, 137.3750], // Murray Buttes
      [-4.7350, 137.3680], // Vera Rubin Ridge (Hematite)
      [-4.7600, 137.3600], // Glen Torridon (Clay unit)
      [-4.7850, 137.3520], // Mont Mercou cliff
      [-4.8100, 137.3450], // Sulfate-Bearing Unit
      [-4.8350, 137.3380], // Gediz Vallis Ridge (debris flows)
    ],
    waypoints: [
      {
        id: 'cur-bradbury',
        name: 'Bradbury Landing',
        solOrEva: 'Sol 0',
        date: 'Aug 6, 2012',
        lat: -4.5895,
        lon: 137.4417,
        distFromStartKm: 0.0,
        desc: 'Touchdown site inside Gale Crater using rocket sky crane.',
        discovery: 'Alluvial fan conglomerates showing ankle-to-waist-deep ancient flowing rivers.',
      },
      {
        id: 'cur-yellowknife',
        name: 'Yellowknife Bay (John Klein)',
        solOrEva: 'Sol 182',
        date: 'Feb 8, 2013',
        lat: -4.5920,
        lon: 137.4520,
        distFromStartKm: 0.7,
        desc: 'Ancient lakebed mudstone where Curiosity drilled its first core.',
        instrument: 'SAM, CheMin, APXS',
        discovery: 'Confirmed ancient Gale Lake was neutral-pH, habitable freshwater with C, H, O, N, P, S.',
      },
      {
        id: 'cur-rubin-ridge',
        name: 'Vera Rubin Ridge',
        solOrEva: 'Sol 1800',
        date: 'Sep 15, 2017',
        lat: -4.7350,
        lon: 137.3680,
        distFromStartKm: 17.3,
        desc: 'Prominent iron-rich hematite ridge resisting erosion on the lower slopes of Mt. Sharp.',
        instrument: 'ChemCam, Mastcam',
        discovery: 'Groundwater episodes carrying dissolved iron precipitated grey crystalline hematite.',
      },
      {
        id: 'cur-glen-torridon',
        name: 'Glen Torridon (Clay Unit)',
        solOrEva: 'Sol 2300',
        date: 'Jan 28, 2019',
        lat: -4.7600,
        lon: 137.3600,
        distFromStartKm: 21.0,
        desc: 'Lush clay-bearing trough formed during Mars’s wet clay era.',
        instrument: 'SAM, CheMin',
        discovery: 'Highest concentration of clay minerals (smectite) and organic molecules found on Mars.',
      },
      {
        id: 'cur-gediz-vallis',
        name: 'Gediz Vallis Channel',
        solOrEva: 'Sol 4100',
        date: 'Feb 15, 2024',
        lat: -4.8350,
        lon: 137.3380,
        distFromStartKm: 31.8,
        desc: 'Carved canyon and debris boulder ridge formed by late-stage catastrophic water floods.',
        instrument: 'APXS, ChemCam',
        discovery: 'Discovered pure elemental sulfur crystals inside crushed rocks.',
      },
    ],
  },

  // ── MARS: OPPORTUNITY (Meridiani Planum) ──────────────────────────────────
  {
    id: 'opportunity-meridiani',
    bodyId: 'mars',
    name: 'Opportunity Rover (MER-B)',
    vehicle: 'Mars Exploration Rover',
    operator: 'NASA / JPL',
    launchYear: 2003,
    landingDate: 'January 25, 2004',
    status: 'Completed',
    totalKm: 45.16,
    duration: '2004 – 2018 (5,111 sols / 14.5 Earth years)',
    color: '#eab308',
    glowColor: 'rgba(234, 179, 8, 0.4)',
    description: 'The marathon rover: drove over 45 km across Meridiani Planum, inspecting impact craters and proving an ancient acidic groundwater sea existed.',
    highlight: 'Discovered hematite blueberries and gypsum veins; longest distance driven on another world.',
    center: { lat: -2.15, lon: -5.35 },
    zoom: 10,
    path: [
      [-1.9462, -5.5266], // Eagle Crater (Hole-in-One)
      [-1.9500, -5.5100], // Fram Crater
      [-1.9550, -5.4850], // Endurance Crater (Burns Cliff)
      [-1.9800, -5.4700], // Erebus Crater
      [-2.0500, -5.5000], // Victoria Crater (Duck Bay)
      [-2.1200, -5.4500], // Meridiani Plains sprint
      [-2.1800, -5.3800], // Santa Maria Crater
      [-2.2400, -5.3000], // Endeavour Crater rim (Cape York)
      [-2.2800, -5.2300], // Marathon Valley
      [-2.3200, -5.2000], // Perseverance Valley (final resting place)
    ],
    waypoints: [
      {
        id: 'oppy-eagle',
        name: 'Eagle Crater (Touchdown)',
        solOrEva: 'Sol 0',
        date: 'Jan 25, 2004',
        lat: -1.9462,
        lon: -5.5266,
        distFromStartKm: 0.0,
        desc: 'Airbag bounce landing directly inside a 22-meter impact crater: the ultimate interplanetary hole-in-one.',
        discovery: 'Discovered hematite spherules ("blueberries") proving past liquid water percolation.',
      },
      {
        id: 'oppy-endurance',
        name: 'Endurance Crater (Burns Cliff)',
        solOrEva: 'Sol 130',
        date: 'Jun 8, 2004',
        lat: -1.9550,
        lon: -5.4850,
        distFromStartKm: 1.2,
        desc: 'Deep 130-meter crater with exposed layered bedrock cliffs.',
        instrument: 'Mössbauer Spectrometer, Microscopic Imager',
        discovery: 'Cross-bedded sandstones deposited in ancient evaporating saline playa lakes.',
      },
      {
        id: 'oppy-victoria',
        name: 'Victoria Crater (Duck Bay)',
        solOrEva: 'Sol 951',
        date: 'Sep 26, 2006',
        lat: -2.0500,
        lon: -5.5000,
        distFromStartKm: 9.2,
        desc: 'Stunning 750-meter-wide crater with scalloped promontories (Cabo Anonimo).',
        discovery: 'Meter-thick sulfates showing regional groundwater table fluctuations.',
      },
      {
        id: 'oppy-endeavour',
        name: 'Endeavour Crater (Cape York)',
        solOrEva: 'Sol 2700',
        date: 'Aug 9, 2011',
        lat: -2.2400,
        lon: -5.3000,
        distFromStartKm: 33.5,
        desc: 'Vast 22 km impact basin with ancient Noachian phyllosilicate rim rocks.',
        discovery: 'Discovered bright gypsum veins (Homestake) formed by neutral, drinkable water.',
      },
      {
        id: 'oppy-perseverance-val',
        name: 'Perseverance Valley',
        solOrEva: 'Sol 5111',
        date: 'Jun 10, 2018',
        lat: -2.3200,
        lon: -5.2000,
        distFromStartKm: 45.16,
        desc: 'Fluid-carved notch descending the inner wall of Endeavour Crater; overtaken by global dust storm.',
        discovery: 'Final transmission: "My battery is low and it’s getting dark."',
      },
    ],
  },

  // ── MOON: APOLLO 15 (Hadley-Apennine) ─────────────────────────────────────
  {
    id: 'apollo-15-traverse',
    bodyId: 'moon',
    name: 'Apollo 15 Lunar Roving Vehicle',
    vehicle: 'Lunar Roving Vehicle (LRV-1) + LM Falcon',
    operator: 'NASA (Dave Scott & Jim Irwin)',
    launchYear: 1971,
    landingDate: 'July 30, 1971',
    status: 'Completed',
    totalKm: 27.9,
    duration: '3 days (18h 35m EVA)',
    color: '#a855f7',
    glowColor: 'rgba(168, 85, 247, 0.4)',
    description: 'First J-mission with the Lunar Roving Vehicle: drove to the brink of the 300-meter-deep Hadley Rille canyon and climbed the Apennine Front.',
    highlight: 'Discovered the 4.1-billion-year-old Genesis Rock; Galileo hammer-and-feather gravity drop.',
    center: { lat: 26.132, lon: 3.633 },
    zoom: 14,
    path: [
      [26.1322, 3.6339], // LM Falcon
      [26.1050, 3.6450], // Elbow Crater
      [26.0900, 3.6600], // St. George Crater (Hadley Rille rim)
      [26.1200, 3.6400], // Return to LM
      [26.1000, 3.7000], // Spur Crater (Apennine Front)
      [26.0950, 3.7200], // Dune Crater
      [26.1322, 3.6339], // Return to LM
      [26.1500, 3.6100], // Scarp Crater
      [26.1650, 3.5900], // The Terrace / Hadley Rille gorge
      [26.1350, 3.6380], // VIP LRV parking site
    ],
    waypoints: [
      {
        id: 'a15-falcon',
        name: 'Falcon Touchdown Site',
        solOrEva: 'Landing',
        date: 'Jul 30, 1971',
        lat: 26.1322,
        lon: 3.6339,
        distFromStartKm: 0.0,
        desc: 'Landed in the marshlands of Palus Putredinis flanked by 4.5 km high Apennine peaks.',
      },
      {
        id: 'a15-elbow',
        name: 'Elbow Crater (Hadley Rille)',
        solOrEva: 'EVA 1',
        date: 'Jul 31, 1971',
        lat: 26.1050,
        lon: 3.6450,
        distFromStartKm: 4.1,
        desc: 'Overlooked the 1.5 km wide, 300 m deep collapsed lava tube of Hadley Rille.',
        discovery: 'Layered basalt flows exposed in the steep far canyon wall.',
      },
      {
        id: 'a15-genesis',
        name: 'Spur Crater (Genesis Rock)',
        solOrEva: 'EVA 2',
        date: 'Aug 1, 1971',
        lat: 26.1000,
        lon: 3.7000,
        distFromStartKm: 12.5,
        desc: 'Slopes of Mount Hadley Delta in the Apennine Front.',
        discovery: 'Found Sample 15415 (Genesis Rock), a primordial anorthosite from early lunar crust accretion.',
      },
      {
        id: 'a15-hammer-feather',
        name: 'Galileo Gravity Experiment Site',
        solOrEva: 'EVA 3',
        date: 'Aug 2, 1971',
        lat: 26.1325,
        lon: 3.6345,
        distFromStartKm: 27.5,
        desc: 'Dave Scott dropped a 1.3 kg geological hammer and a 30 g falcon feather simultaneously in lunar vacuum.',
        discovery: 'Proved Galileo’s law of universal free-fall acceleration: both hit the dust at the exact same instant.',
      },
    ],
  },

  // ── MOON: APOLLO 17 (Taurus-Littrow) ──────────────────────────────────────
  {
    id: 'apollo-17-traverse',
    bodyId: 'moon',
    name: 'Apollo 17 Lunar Rover (Taurus-Littrow)',
    vehicle: 'Lunar Roving Vehicle (LRV-3) + LM Challenger',
    operator: 'NASA (Gene Cernan & Jack Schmitt)',
    launchYear: 1972,
    landingDate: 'December 11, 1972',
    status: 'Completed',
    totalKm: 35.7,
    duration: '3 days (22h 04m EVA)',
    color: '#ec4899',
    glowColor: 'rgba(236, 72, 153, 0.4)',
    description: 'Final crewed lunar landing: geologist Jack Schmitt and commander Gene Cernan drove 35.7 km across the dramatic Taurus-Littrow valley.',
    highlight: 'Discovered pyroclastic orange volcanic glass at Shorty Crater; sampled giant split boulder Tracy’s Rock.',
    center: { lat: 20.19, lon: 30.77 },
    zoom: 13,
    path: [
      [20.1911, 30.7723], // LM Challenger
      [20.1800, 30.7600], // Steno Crater (EVA 1)
      [20.1911, 30.7723], // Return
      [20.1650, 30.7400], // Nansen Crater (South Massif base)
      [20.1850, 30.7100], // Shorty Crater (Orange Soil)
      [20.1950, 30.7300], // Camelot Crater
      [20.1911, 30.7723], // Return
      [20.2400, 30.7600], // North Massif base
      [20.2450, 30.7800], // Tracy’s Rock (Split Boulder)
      [20.2100, 30.7900], // Van Serg Crater
      [20.1920, 30.7750], // VIP Parking
    ],
    waypoints: [
      {
        id: 'a17-challenger',
        name: 'Challenger Touchdown Site',
        solOrEva: 'Landing',
        date: 'Dec 11, 1972',
        lat: 20.1911,
        lon: 30.7723,
        distFromStartKm: 0.0,
        desc: 'Pinpoint landing in the narrow valley of Taurus-Littrow between 2.5 km massifs.',
      },
      {
        id: 'a17-shorty',
        name: 'Shorty Crater (Orange Glass)',
        solOrEva: 'EVA 2',
        date: 'Dec 12, 1972',
        lat: 20.1850,
        lon: 30.7100,
        distFromStartKm: 14.8,
        desc: 'Geologist Jack Schmitt noticed a ring of bright orange volcanic soil around the rim.',
        discovery: '3.64-billion-year-old volcanic fire-fountain beads containing trapped volatiles.',
      },
      {
        id: 'a17-tracys-rock',
        name: 'Tracy’s Rock (Station 6 Split Boulder)',
        solOrEva: 'EVA 3',
        date: 'Dec 13, 1972',
        lat: 20.2450,
        lon: 30.7800,
        distFromStartKm: 28.3,
        desc: 'Enormous 5-story boulder that rolled 1.5 km down North Massif, leaving a clear trackway.',
        discovery: 'Detailed impact-melt breccia dating the Serenitatis impact basin formation.',
      },
      {
        id: 'a17-final-bootprint',
        name: 'Last Human Footprint on the Moon',
        solOrEva: 'EVA 3 End',
        date: 'Dec 14, 1972',
        lat: 20.1915,
        lon: 30.7726,
        distFromStartKm: 35.7,
        desc: 'Gene Cernan re-entered the lunar module: the final human footprints left on the Moon to date.',
        discovery: '“We leave as we came, and, God willing, as we shall return, with peace and hope for all mankind.”',
      },
    ],
  },
];

export function getTraversesForBody(bodyId: string): Traverse[] {
  const b = bodyId.toLowerCase();
  return TRAVERSES.filter(t => t.bodyId === b);
}

export function searchTraverses(query: string, bodyId?: string): Traverse[] {
  const q = query.toLowerCase().trim();
  const list = bodyId ? getTraversesForBody(bodyId) : TRAVERSES;
  if (!q) return list;
  return list.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.vehicle.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.waypoints.some(w => w.name.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q))
  );
}

export interface TraverseLayer {
  selectTraverse: (id: string | null) => void;
  selectWaypoint: (wpId: string | null) => void;
  remove: () => void;
}

export function attachTraverseLayer(
  lib: MapLib,
  map: ML.Map,
  traverses: Traverse[],
  onSelectWaypoint?: (wp: TraverseWaypoint, t: Traverse) => void
): TraverseLayer {
  const srcId = 'sb-traverses-src';
  const wpSrcId = 'sb-waypoints-src';
  const glowLayerId = 'sb-traverses-glow';
  const lineLayerId = 'sb-traverses-line';
  const wpCircleLayerId = 'sb-waypoints-circle';

  // Build GeoJSON Lines
  const lineFeatures: Feature<LineString>[] = traverses.map(t => ({
    type: 'Feature',
    id: t.id,
    properties: {
      id: t.id,
      name: t.name,
      color: t.color,
      glowColor: t.glowColor,
    },
    geometry: {
      type: 'LineString',
      coordinates: t.path.map(([lat, lon]) => [lon, lat]),
    },
  }));

  // Build GeoJSON Waypoints
  const wpFeatures: Feature<Point>[] = traverses.flatMap(t =>
    t.waypoints.map(w => ({
      type: 'Feature',
      id: w.id,
      properties: {
        id: w.id,
        traverseId: t.id,
        name: w.name,
        solOrEva: w.solOrEva,
        date: w.date ?? '',
        desc: w.desc,
        discovery: w.discovery ?? '',
        color: t.color,
      },
      geometry: {
        type: 'Point',
        coordinates: [w.lon, w.lat],
      },
    }))
  );

  map.addSource(srcId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: lineFeatures },
  });

  map.addSource(wpSrcId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: wpFeatures },
  });

  // 1. Glow Layer underneath
  map.addLayer({
    id: glowLayerId,
    type: 'line',
    source: srcId,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 8,
      'line-opacity': 0.35,
      'line-blur': 3,
    },
  });

  // 2. Crisp Line Layer
  map.addLayer({
    id: lineLayerId,
    type: 'line',
    source: srcId,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 3,
      'line-opacity': 0.95,
    },
  });

  // 3. Waypoint Circle Pins
  map.addLayer({
    id: wpCircleLayerId,
    type: 'circle',
    source: wpSrcId,
    paint: {
      'circle-radius': 5,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#06070c',
      'circle-stroke-width': 2,
    },
  });

  const onClickWp = (e: ML.MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f || !onSelectWaypoint) return;
    const wId = f.properties?.id;
    const tId = f.properties?.traverseId;
    const trav = traverses.find(t => t.id === tId);
    const wp = trav?.waypoints.find(w => w.id === wId);
    if (trav && wp) onSelectWaypoint(wp, trav);
  };

  map.on('click', wpCircleLayerId, onClickWp);
  const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
  const onLeave = () => { map.getCanvas().style.cursor = ''; };
  map.on('mouseenter', wpCircleLayerId, onEnter);
  map.on('mouseleave', wpCircleLayerId, onLeave);

  return {
    selectTraverse: (id: string | null) => {
      if (!map.getLayer(lineLayerId)) return;
      if (!id) {
        map.setPaintProperty(lineLayerId, 'line-opacity', 0.95);
        map.setPaintProperty(glowLayerId, 'line-opacity', 0.35);
      } else {
        map.setPaintProperty(lineLayerId, 'line-opacity', ['case', ['==', ['get', 'id'], id], 1.0, 0.2]);
        map.setPaintProperty(glowLayerId, 'line-opacity', ['case', ['==', ['get', 'id'], id], 0.6, 0.05]);
      }
    },
    selectWaypoint: (wpId: string | null) => {
      if (!map.getLayer(wpCircleLayerId)) return;
      if (!wpId) {
        map.setPaintProperty(wpCircleLayerId, 'circle-radius', 5);
      } else {
        map.setPaintProperty(wpCircleLayerId, 'circle-radius', ['case', ['==', ['get', 'id'], wpId], 9, 4]);
      }
    },
    remove: () => {
      map.off('click', wpCircleLayerId, onClickWp);
      map.off('mouseenter', wpCircleLayerId, onEnter);
      map.off('mouseleave', wpCircleLayerId, onLeave);
      if (!map.style) return;
      if (map.getLayer(wpCircleLayerId)) map.removeLayer(wpCircleLayerId);
      if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
      if (map.getLayer(glowLayerId)) map.removeLayer(glowLayerId);
      if (map.getSource(wpSrcId)) map.removeSource(wpSrcId);
      if (map.getSource(srcId)) map.removeSource(srcId);
    },
  };
}
