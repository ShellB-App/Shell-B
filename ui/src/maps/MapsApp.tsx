// Worlds app (#/worlds, formerly Maps at #/maps): the Sol orrery (SolView), Earth from the offline OSM planet,
// and every planet and moon mosaic in ~/shellb/maps/bodies, with toggleable overlays (overlays.ts), search,
// measuring, directions, tours and the Atlas copilot.
//
// Map lifecycle: one MapLibre map per (world, theme). The globe/flat switch changes the projection in place.
// Every overlay registers its teardown with `own()`, and the map's own cleanup runs those before map.remove(),
// so no overlay ever touches a removed map. Clicks go through one router: overlays register the layer ids
// they own in `hits`, and only a click that hits nothing drops a pin.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import type * as ML from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import {
  Activity, Anchor, Bookmark, Check, Compass, Copy, Crosshair, Download, Eye, Flag, Globe2, Info, Loader2, LocateFixed,
  Map as MapIcon, MapPin, Navigation, Orbit, PanelLeftClose, PanelLeftOpen, Radar, Rocket, Route as RouteIcon, Ruler,
  Satellite, Search, Sparkles, Thermometer, Video, Wheat, Hand, X, Image as ImageIcon, CloudRain, Mountain, Zap, Waves,
} from 'lucide-react';
import { drawOverlays, fetchBodies, fmtCoord, frameSpec, hasScene, loadMapLib, styleFor, type MapBody, type MapLib, type MapSpec, type TourStop } from './core';
import { MAPS_HANDOFF, useDarkTheme } from './MapCard';
import { SolView } from './SolView';
import { SOL_BODIES, isMajorMoon, moonsOf } from './sol';
import { FLIGHT_HANDOFF, FlightPanel } from './FlightCard';
import { areaFlights, findFlight, pathLayers, planeLayer, viewRadiusNm, type Aircraft, type FindResult } from './flights';
import { REGIME_COLOR, attachOrbiters, type OrbiterInfo, type OrbiterLayer } from './orbiters';
import { compass, type Pass } from './passes';
import { getLandmarksForBody, searchLandmarks, type Landmark } from './landmarks';
import { attachTerminator } from './terminator';
import { attachMeasureLayer, detachMeasureLayer, computePath, formatDist, type MeasurePoint } from './measure';
import { attachGrid } from './grid';
import { DirectionsPanel, type RouteData } from './DirectionsPanel';
import { DossierDrawer } from './DossierDrawer';
import { LandmarkModal } from './LandmarkModal';
import { LiveWeatherWidget } from './LiveWeatherWidget';
import { BookmarksModal } from './BookmarksModal';
import { AtlasCopilot } from './AtlasCopilot';
import { attachTraverseLayer, getTraversesForBody, type Traverse, type TraverseWaypoint } from './traverses';
import { TraverseModal } from './TraverseModal';
import { SkyViewModal } from './SkyViewModal';
import { Starfield } from './Starfield';
import { hasSky } from './sky';
import { SHIPWRECKS } from './shipwrecks';
import { WORLD_WONDERS } from './wonders';
import { LAUNCH_SITES } from './launchsites';
import { CCTV_CAMERAS } from './cctv';
import { MapFeatureModal, type AnyFeature } from './MapFeatureModal';
import { attachPoints, mapAlive, type PointItem, type PointLayer } from './pointLayer';
import { OVERLAYS, loadPrefs, savePrefs, type LayerPrefs, type OverlayId } from './overlays';
import { LayersPanel } from './LayersPanel';
import { TimeBar } from './TimeBar';
import { attachRelief } from './relief';
import { PREHISTORY, isCaveSite, siteName, yearsAgo, type PrehistorySite } from './prehistory';
import { KIND_COLOR, KIND_LABEL, PrehistoryCard, SOLAR_LABEL } from './PrehistoryCard';
import { DeepTimePanel } from './DeepTimePanel';
import { attachIceAge, attachSolarLines, seaLevelAt } from './deeptime';
import { t } from '../i18n';
import { clockNow, goLive, setClock, useClockState, useClockTime } from './clock';
import { ASK_ATLAS, NOTES_CHANGED, OPEN_MEDIA, OPEN_MODEL, OPEN_VIEW3D, mediaSrc, type NoteMedia } from './notes';
import { PLACE_COLOR, fetchPlaces, type Place } from './places';
import { PlaceCard } from './PlaceCard';
import { attachBuildings } from './buildings';
import { LIFE_PREF, SEA_PREF, attachLife, attachSea, fetchGrid, seaDay, type GridStats, type SeaHandle, type SeaVar, type Taxon } from './marine';
import { LifeChip, SeaCard, SeaChip } from './MarinePanels';
import { IMAGERY_PREF, attachImagery, attachRadar, dayOf, fetchImageryCatalog, fetchRadarFrames, type ImageryHandle, type ImageryLayer, type RadarFrames, type RadarHandle } from './imagery';
import { TourPlayer } from './TourPlayer';
import { ModelLightbox, ModelStrip, ModelViewer } from './ModelViewer';
import { fetchModels, modelById, modelsForSpacecraft, type ModelInfo } from './models';
import { MeasureProfile } from './MeasureProfile';
import { DiveView, type View3DTarget } from './DiveView';
import { attachEffects, effectFor } from './effects';
import { attachAurora, fetchAurora, type AuroraData } from './aurora';
import { applySky } from './atmosphere';

export const WORLD_PALETTE: Record<string, { color: string; label?: string }> = {
  sol: { color: '#f59e0b', label: 'Star' },
  mercury: { color: '#94a3b8', label: 'Terrestrial' },
  venus: { color: '#eab308', label: 'Terrestrial' },
  earth: { color: '#0ea5e9', label: 'Terrestrial' },
  moon: { color: '#e2e8f0', label: 'Lunar' },
  mars: { color: '#ea580c', label: 'Terrestrial' },
  phobos: { color: '#a8a29e', label: 'Moon' },
  deimos: { color: '#a8a29e', label: 'Moon' },
  ceres: { color: '#71717a', label: 'Dwarf Planet' },
  vesta: { color: '#9ca3af', label: 'Asteroid' },
  jupiter: { color: '#d97706', label: 'Gas Giant' },
  io: { color: '#facc15', label: 'Volcanic Moon' },
  europa: { color: '#38bdf8', label: 'Ocean Moon' },
  ganymede: { color: '#93c5fd', label: 'Icy Moon' },
  callisto: { color: '#94a3b8', label: 'Cratered Moon' },
  saturn: { color: '#eab308', label: 'Ringed Giant' },
  mimas: { color: '#cbd5e1', label: 'Moon' },
  enceladus: { color: '#7dd3fc', label: 'Geyser Moon' },
  tethys: { color: '#cbd5e1', label: 'Moon' },
  dione: { color: '#cbd5e1', label: 'Moon' },
  rhea: { color: '#cbd5e1', label: 'Moon' },
  titan: { color: '#f97316', label: 'Atmospheric Moon' },
  iapetus: { color: '#71717a', label: 'Moon' },
  uranus: { color: '#2dd4bf', label: 'Ice Giant' },
  neptune: { color: '#3b82f6', label: 'Ice Giant' },
  pluto: { color: '#c084fc', label: 'Dwarf Planet' },
  charon: { color: '#a1a1aa', label: 'Moon' },
};

const LAST = 'shellb.maps.last';
const VIEW = (id: string) => `shellb.maps.view.${id}`;
const GLOBE = 'shellb.maps.globe';
const MEASURE_UNIT = 'shellb.maps.measure.unit';
const DEEP = 'shellb.maps.deepYears';

const store = {
  get<T>(k: string): T | null { try { return JSON.parse(localStorage.getItem(k) ?? 'null') as T | null; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function take(key: string): string | null {
  try { const v = sessionStorage.getItem(key); sessionStorage.removeItem(key); return v; } catch { return null; }
}
function takeHandoff(): MapSpec | null {
  const raw = take(MAPS_HANDOFF);
  try { return raw ? JSON.parse(raw) as MapSpec : null; } catch { return null; }
}

/** "51.5, -0.12", "51.5 -0.12", "51.5N 0.12W" → lat/lon */
function parseCoords(s: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(s);
  if (!m) return null;
  let lat = +m[1], lon = +m[3];
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
  if (lon > 180) lon -= 360;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function bodyFromHash(): string | null {
  const m = /^#\/(?:worlds|maps)\/([a-zA-Z0-9_-]+)/.exec(location.hash);
  return m ? m[1].toLowerCase() : null;
}

interface Quake { id: string; mag: number; place: string; time: string; depth_km: number; url?: string; lat: number; lon: number }

type Selection =
  | { kind: 'landmark'; item: Landmark }
  | AnyFeature
  | { kind: 'traverse'; traverse: Traverse; waypoint: TraverseWaypoint }
  | { kind: 'quake'; item: Quake }
  | { kind: 'prehistory'; item: PrehistorySite }
  | { kind: 'place'; item: Place };

interface Suggestion {
  id: string;
  kind: 'coord' | 'flight' | 'landmark' | 'geocode' | 'feature' | 'satellite' | 'prehistory';
  satId?: string;
  title: string;
  subtitle?: string;
  lat?: number;
  lon?: number;
  flight?: string;
  landmark?: Landmark;
  feature?: AnyFeature;
  site?: PrehistorySite;
}

type Drawer = 'directions' | 'dossier' | 'bookmarks' | 'atlas' | null;
type GoTo = { body?: string; lat: number; lon: number; zoom?: number; bearing?: number; pitch?: number; pin?: boolean; duration?: number };

const LANDMARK_COLOR: Record<Landmark['kind'], string> = {
  mission: '#10b981', spaceport: '#38bdf8', crater: '#a855f7', volcano: '#f97316', mountain: '#f59e0b',
  canyon: '#f59e0b', plain: '#f59e0b', sea: '#38bdf8',
};

/** Curated point datasets, each one overlay. `sel` turns a hit back into a Selection. */
/** Prehistoric sites begun at least `cut` years ago (0 = all), in the caves or the Neolithic layer. */
const prehistoryPoints = (caves: boolean, cut: number): PointItem[] => PREHISTORY
  .filter(p => isCaveSite(p) === caves && yearsAgo(p) >= cut)
  .map(p => ({ id: p.id, lat: p.lat, lon: p.lon, name: siteName(p), color: KIND_COLOR[p.kind] }));
const prehistorySel = (id: string): Selection | null => { const item = PREHISTORY.find(p => p.id === id); return item ? { kind: 'prehistory', item } : null; };

const POINT_SETS: { id: OverlayId; items: (bodyId: string, cut: number) => PointItem[]; color: string; labelZoom?: number; sel: (id: string, bodyId: string) => Selection | null }[] = [
  {
    id: 'landmarks', color: '#10b981', labelZoom: 1.5,
    items: b => getLandmarksForBody(b).map(l => ({ id: l.id, lat: l.lat, lon: l.lon, name: l.name, color: LANDMARK_COLOR[l.kind] })),
    sel: (id, b) => { const item = getLandmarksForBody(b).find(l => l.id === id); return item ? { kind: 'landmark', item } : null; },
  },
  {
    id: 'wonders', color: '#f59e0b', items: () => WORLD_WONDERS,
    sel: id => { const item = WORLD_WONDERS.find(w => w.id === id); return item ? { kind: 'wonder', item } : null; },
  },
  {
    id: 'shipwrecks', color: '#22d3ee', items: () => SHIPWRECKS,
    sel: id => { const item = SHIPWRECKS.find(w => w.id === id); return item ? { kind: 'shipwreck', item } : null; },
  },
  {
    id: 'launchsites', color: '#fb923c', items: () => LAUNCH_SITES,
    sel: id => { const item = LAUNCH_SITES.find(w => w.id === id); return item ? { kind: 'launchsite', item } : null; },
  },
  {
    id: 'webcams', color: '#f472b6', items: () => CCTV_CAMERAS.filter(c => c.lat !== 0 || c.lon !== 0),
    sel: id => { const item = CCTV_CAMERAS.find(w => w.id === id); return item ? { kind: 'cctv', item } : null; },
  },
  { id: 'caves', color: '#e2725b', labelZoom: 4, items: (_, cut) => prehistoryPoints(true, cut), sel: prehistorySel },
  { id: 'neolithic', color: '#cbd5e1', labelZoom: 4, items: (_, cut) => prehistoryPoints(false, cut), sel: prehistorySel },
];

const selectionKey = (s: Selection | null): { overlay: OverlayId; id: string } | null => {
  if (!s) return null;
  switch (s.kind) {
    case 'landmark': return { overlay: 'landmarks', id: s.item.id };
    case 'wonder': return { overlay: 'wonders', id: s.item.id };
    case 'shipwreck': return { overlay: 'shipwrecks', id: s.item.id };
    case 'launchsite': return { overlay: 'launchsites', id: s.item.id };
    case 'cctv': return { overlay: 'webcams', id: s.item.id };
    case 'prehistory': return { overlay: isCaveSite(s.item) ? 'caves' : 'neolithic', id: s.item.id };
    case 'place': return { overlay: 'places', id: s.item.key };
    default: return null;
  }
};

const QUAKE_SRC = 'sb-quakes';
const PLANE_IDS = { layers: ['sb-flightpath-ahead', 'sb-flightpath-trail', 'sb-planes'], sources: ['sb-flightpath-ahead', 'sb-flightpath-trail', 'sb-planes'] };

export function MapsApp() {
  const dark = useDarkTheme();
  const [bodies, setBodies] = useState<MapBody[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoff] = useState(takeHandoff);
  const [flightHandoff] = useState(() => take(FLIGHT_HANDOFF));
  const [bodyId, setBodyId] = useState<string>(() => (
    bodyFromHash() ?? (flightHandoff ? 'earth' : handoff?.body ?? store.get<string>(LAST) ?? 'earth')
  ));
  const [globe, setGlobe] = useState<boolean>(() => handoff?.globe ?? store.get<boolean>(GLOBE) ?? true);
  const [panel, setPanel] = useState(() => window.innerWidth >= 900);
  const [prefs, setPrefs] = useState<LayerPrefs>(loadPrefs);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [overlay, setOverlay] = useState<MapSpec | null>(handoff);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [solFocus, setSolFocus] = useState<{ id: string } | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(() => {
    const q = location.hash + location.search;
    return /[?&]directions\b/.test(q) ? 'directions' : /[?&]dossier\b/.test(q) ? 'dossier' : /[?&]bookmarks\b/.test(q) ? 'bookmarks' : null;
  });
  const [pinCard, setPinCard] = useState<'weather' | 'sky' | 'sea' | null>(null);
  const [viewport, setViewport] = useState({ lat: 0, lon: 0, zoom: 2 });
  const [atlasRequest, setAtlasRequest] = useState<{ text: string; n: number } | null>(null);
  const [lightbox, setLightbox] = useState<NoteMedia | null>(null);
  const [deepYears, setDeepYearsState] = useState<number>(() => store.get<number>(DEEP) ?? 21000);
  const setDeepYears = (y: number) => { setDeepYearsState(y); store.set(DEEP, y); };
  const [tour, setTour] = useState<{ title?: string; stops: TourStop[] } | null>(null);
  const [modelBox, setModelBox] = useState<ModelInfo | null>(null);
  const [view3d, setView3d] = useState<View3DTarget | null>(null);
  const [aurora, setAurora] = useState<AuroraData | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [imageryLayer, setImageryLayerState] = useState<string>(() => store.get<string>(IMAGERY_PREF) ?? 'modis');
  const setImageryLayer = (id: string) => { setImageryLayerState(id); store.set(IMAGERY_PREF, id); };
  const [imageryCat, setImageryCat] = useState<ImageryLayer[]>([]);
  const [radarFrames, setRadarFrames] = useState<RadarFrames | null>(null);
  const [radarFrame, setRadarFrame] = useState<string | null>(null);
  // a scene handed over from a chat card (layers, time, focus, tour...) is applied once the map is up
  const [pendingScene, setPendingScene] = useState<MapSpec | null>(() => (handoff && hasScene(handoff) ? handoff : null));

  useEffect(() => { if (drawer !== 'atlas') setAtlasRequest(null); }, [drawer]);  // a reopened Atlas shouldn't resend it
  // Cards ask Atlas and open pictures through window events (they sit a few components down)
  useEffect(() => {
    const ask = (e: Event) => { setDrawer('atlas'); setAtlasRequest(r => ({ text: String((e as CustomEvent).detail), n: (r?.n ?? 0) + 1 })); };
    const show = (e: Event) => setLightbox((e as CustomEvent<NoteMedia>).detail);
    const model = (e: Event) => setModelBox((e as CustomEvent<ModelInfo>).detail);
    const v3 = (e: Event) => setView3d((e as CustomEvent<View3DTarget>).detail);
    window.addEventListener(ASK_ATLAS, ask);
    window.addEventListener(OPEN_MEDIA, show);
    window.addEventListener(OPEN_MODEL, model);
    window.addEventListener(OPEN_VIEW3D, v3);
    return () => { window.removeEventListener(ASK_ATLAS, ask); window.removeEventListener(OPEN_MEDIA, show); window.removeEventListener(OPEN_MODEL, model); window.removeEventListener(OPEN_VIEW3D, v3); };
  }, []);

  // Atlas places for this world; refreshed whenever a card changes (Atlas may have added or removed a place)
  useEffect(() => {
    let ctrl = new AbortController();
    const load = () => { ctrl.abort(); ctrl = new AbortController(); fetchPlaces(bodyId, ctrl.signal).then(setPlaces).catch(() => {}); };
    setPlaces([]);
    if (bodyId !== 'sol') load();
    window.addEventListener(NOTES_CHANGED, load);
    return () => { ctrl.abort(); window.removeEventListener(NOTES_CHANGED, load); };
  }, [bodyId]);

  // Live flights (Earth only): the traffic layer, and one followed flight
  const [planes, setPlanes] = useState<Aircraft[]>([]);
  const [trafficErr, setTrafficErr] = useState<string | null>(null);
  const [flightQ, setFlightQ] = useState<string | null>(flightHandoff);
  const [follow, setFollow] = useState(!!flightHandoff);
  const [sel, setSel] = useState<{ res: FindResult | null; error: string | null; updated: number | null }>({ res: null, error: null, updated: null });

  // Spacecraft
  const [orbStatus, setOrbStatus] = useState<{ count: number; error?: string; note?: string } | null>(null);
  const [orbSel, setOrbSel] = useState<OrbiterInfo | null>(null);
  const orbLayer = useRef<OrbiterLayer | null>(null);
  const [quakeCount, setQuakeCount] = useState<number | null>(null);

  // Measuring
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [measureUnit, setMeasureUnit] = useState<'metric' | 'imperial' | 'nautical'>(() => store.get(MEASURE_UNIT) ?? 'metric');

  const [activeRoute, setActiveRoute] = useState<RouteData | null>(null);
  const clock = useClockState();

  const body = bodies?.find(b => b.id === bodyId) ?? null;
  const isEarth = bodyId === 'earth';
  const worldCtx = { terrain: !!body?.terrain, vector: body?.type === 'vector' };
  const has = (id: OverlayId) => prefs[id] && !!OVERLAYS.find(o => o.id === id)?.on(bodyId, globe, worldCtx);

  // ── Map lifecycle ───────────────────────────────────────────────────────
  const box = useRef<HTMLDivElement>(null);
  const [mapState, setMapState] = useState<{ map: ML.Map; lib: MapLib; body: string } | null>(null);
  const map = mapState?.map ?? null;
  const lib = mapState?.lib ?? null;
  const pendingView = useRef<GoTo & { body: string } | null>(null);
  const globeRef = useRef(globe);
  globeRef.current = globe;
  const teardowns = useRef(new Set<() => void>());
  const hits = useRef(new Map<string, (f: ML.MapGeoJSONFeature) => void>());
  const clickRef = useRef<(e: ML.MapMouseEvent) => void>(() => {});
  const pinMarker = useRef<ML.Marker | null>(null);

  /** Register an overlay's teardown; returns an idempotent version for the effect's cleanup. */
  const own = useCallback((fn: () => void) => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      teardowns.current.delete(run);
      try { fn(); } catch (e) { console.warn('Worlds overlay teardown:', e); }
    };
    teardowns.current.add(run);
    return run;
  }, []);

  useEffect(() => {
    if (!body?.available || !box.current) return;
    let gone = false;
    let m: ML.Map | null = null;
    (async () => {
      const lib = await loadMapLib();
      const style = await styleFor(body, dark, globeRef.current);
      if (gone || !box.current) return;
      const pv = pendingView.current?.body === body.id ? pendingView.current : null;
      pendingView.current = null;
      const saved = store.get<{ c: [number, number]; z: number; b?: number; p?: number }>(VIEW(body.id));
      m = new lib.Map({
        container: box.current, style, attributionControl: { compact: true },
        center: pv ? [pv.lon, pv.lat] : saved?.c ?? [0, 20],
        zoom: pv?.zoom ?? saved?.z ?? (globeRef.current ? 1.6 : 1.8),
        bearing: pv?.bearing ?? saved?.b ?? 0, pitch: pv?.pitch ?? saved?.p ?? 0,
        maxZoom: body.type === 'vector' ? 19 : body.maxzoom + 3, maxPitch: 75,
      });
      const map = m;
      map.addControl(new lib.NavigationControl({ visualizePitch: true }), 'top-right');
      if (body.id === 'earth') map.addControl(new lib.ScaleControl({ unit: 'metric' }), 'bottom-right');  // assumes Earth's radius
      map.on('click', e => clickRef.current(e));
      map.on('dragstart', () => setFollow(false));
      map.on('moveend', () => {
        const c = map.getCenter().wrap();
        setViewport({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
        store.set(VIEW(body.id), { c: [c.lng, c.lat], z: map.getZoom(), b: map.getBearing(), p: map.getPitch() });
      });
      map.once('load', () => {
        if (gone) return;
        const c = map.getCenter().wrap();
        setViewport({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
        setMapState({ map, lib, body: body.id });
        if (pv?.pin) setPin({ lat: pv.lat, lon: pv.lon });
      });
    })().catch(e => { console.error('Map engine init failed:', e); if (!gone) setError(`Map engine: ${(e as Error)?.message || e}`); });

    return () => {
      gone = true;
      [...teardowns.current].forEach(t => t());
      hits.current.clear();
      pinMarker.current?.remove(); pinMarker.current = null;
      m?.remove();
      setMapState(null);
    };
  }, [body?.id, body?.available, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // Globe ↔ flat without rebuilding the map
  useEffect(() => {
    if (!map) return;
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
    if (map.getLayer('space')) map.setPaintProperty('space', 'background-color', globe ? 'rgba(0,0,0,0)' : '#06070c');
  }, [map, globe]);

  // Panels opening/closing change the map's width
  useEffect(() => {
    if (!map) return;
    const raf = requestAnimationFrame(() => mapAlive(map) && map.resize());
    return () => cancelAnimationFrame(raf);
  }, [map, panel, drawer]);

  /** Fly somewhere, switching worlds first if needed (the new map then opens there). */
  const goTo = useCallback((t: GoTo) => {
    const target = t.body?.toLowerCase() ?? bodyId;
    if (target !== bodyId || !map) {
      pendingView.current = { ...t, body: target };
      if (target !== bodyId) chooseRef.current(target, true);
      return;
    }
    map.flyTo({ center: [t.lon, t.lat], zoom: t.zoom ?? Math.max(map.getZoom(), isEarth ? 12 : 6), bearing: t.bearing, pitch: t.pitch, duration: t.duration ?? 1200 });
    if (t.pin) setPin({ lat: t.lat, lon: t.lon });
  }, [bodyId, map, isEarth]);

  // A map spec handed over from a chat card (or applied by Atlas)
  useEffect(() => {
    if (!map || !lib || !overlay || (overlay.body ?? 'earth') !== mapState?.body) return;
    const undraw = own(drawOverlays(lib, map, overlay));
    frameSpec(lib, map, overlay, true, { top: 96, bottom: 64, left: 64, right: 64 });
    if ((overlay.pitch !== undefined || overlay.bearing !== undefined) && !overlay.center) {
      map.once('moveend', () => mapAlive(map) && map.easeTo({ pitch: overlay.pitch ?? map.getPitch(), bearing: overlay.bearing ?? map.getBearing(), duration: 800 }));
    }
    return undraw;
  }, [map, lib, overlay, mapState?.body, own]);

  // Dropped pin
  useEffect(() => {
    pinMarker.current?.remove(); pinMarker.current = null;
    if (!pin || !map || !lib) return;
    pinMarker.current = new lib.Marker({ color: '#ff5a36', scale: 0.85 }).setLngLat([pin.lon, pin.lat]).addTo(map);
  }, [pin, map, lib]);

  // ── Click router ────────────────────────────────────────────────────────
  clickRef.current = e => {
    const m = e.target;
    const at = { lat: e.lngLat.lat, lon: e.lngLat.wrap().lng };
    if (measuring) { setMeasurePoints(p => [...p, at]); return; }
    const ids = [...hits.current.keys()].filter(id => m.getLayer(id));
    const f = ids.length ? m.queryRenderedFeatures(e.point, { layers: ids })[0] : undefined;
    if (f) { hits.current.get(f.layer.id)?.(f); return; }
    if (orbLayer.current?.hitTest(e.point.x, e.point.y)) return;  // the spacecraft layer selects it itself
    setSelection(null);
    orbLayer.current?.select(null);
    setPin(at);
    setPinCard(null);
  };

  // ── Point datasets ──────────────────────────────────────────────────────
  const reliefOn = has('relief'), terrain3dOn = has('terrain3d');
  const points = useRef<Partial<Record<OverlayId, PointLayer>>>({});
  const selRef = useRef(selection);
  selRef.current = selection;
  // with the Ice Age coast on, the prehistory layers show only what already existed at the chosen date
  const deepCut = has('iceage') ? deepYears : 0;
  const deepCutRef = useRef(deepCut);
  deepCutRef.current = deepCut;
  const cutCount = PREHISTORY.filter(p => yearsAgo(p) >= deepCut).length;
  const pointKey = POINT_SETS.map(s => (has(s.id) ? '1' : '0')).join('') + cutCount;
  useEffect(() => {
    if (!map) return;
    const cleanups = POINT_SETS.filter(s => has(s.id)).map(s => {
      const items = s.items(bodyId, deepCutRef.current);
      if (!items.length) return () => {};
      const layer = attachPoints(map, s.id, items, { color: s.color, labelZoom: s.labelZoom });
      points.current[s.id] = layer;
      const k = selectionKey(selRef.current);
      if (k?.overlay === s.id) layer.select(k.id);
      layer.hitLayers.forEach(l => hits.current.set(l, f => {
        const next = s.sel(String(f.properties?.id), bodyId);
        if (next) { setSelection(next); setPin(null); }
      }));
      return own(() => {
        layer.hitLayers.forEach(l => hits.current.delete(l));
        if (points.current[s.id] === layer) delete points.current[s.id];
        layer.detach();
      });
    });
    return () => cleanups.forEach(c => c());
  }, [map, bodyId, pointKey, own]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = selectionKey(selection);
    for (const [id, layer] of Object.entries(points.current)) layer?.select(k?.overlay === id ? k.id : null);
  }, [selection]);

  // ── Atlas places ────────────────────────────────────────────────────────
  const placesOn = has('places');
  useEffect(() => {
    if (!map || !placesOn || !places.length) return;
    const layer = attachPoints(map, 'places', places.map(p => ({ id: p.key, lat: p.lat, lon: p.lon, name: p.feature, color: p.color || PLACE_COLOR })), { color: PLACE_COLOR, labelZoom: 2 });
    points.current.places = layer;
    const k = selectionKey(selRef.current);
    if (k?.overlay === 'places') layer.select(k.id);
    layer.hitLayers.forEach(l => hits.current.set(l, f => {
      const item = places.find(p => p.key === String(f.properties?.id));
      if (item) { setSelection({ kind: 'place', item }); setPin(null); }
    }));
    return own(() => {
      layer.hitLayers.forEach(l => hits.current.delete(l));
      if (points.current.places === layer) delete points.current.places;
      layer.detach();
    });
  }, [map, placesOn, places, own]);

  // ── 3D buildings (Earth, OSM heights) ───────────────────────────────────
  const buildingsOn = has('buildings');
  useEffect(() => {
    if (!map || !buildingsOn || mapState?.body !== 'earth') return;
    return own(attachBuildings(map, dark));
  }, [map, buildingsOn, dark, mapState?.body, own]);

  // ── Satellite imagery (NASA GIBS), following the clock's date ───────────
  const imageryOn = has('imagery');
  const clockT = useClockTime(60_000);
  const imageryDay = dayOf(clockT);
  const imageryRef = useRef<ImageryHandle | null>(null);
  useEffect(() => { if (imageryOn && !imageryCat.length) fetchImageryCatalog().then(c => setImageryCat(c.layers)); }, [imageryOn, imageryCat.length]);
  useEffect(() => {
    if (!map || !imageryOn || mapState?.body !== 'earth') return;
    const spec = imageryCat.find(l => l.id === imageryLayer);
    const h = attachImagery(map, imageryLayer, spec?.level ?? 9, imageryDay);
    imageryRef.current = h;
    return own(() => { if (imageryRef.current === h) imageryRef.current = null; h.detach(); });
  }, [map, imageryOn, imageryLayer, mapState?.body, reliefOn, own]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { imageryRef.current?.setDay(imageryDay); }, [imageryDay]);

  // ── The sea, for marine biology: satellite sea surface and species records ──
  const seaOn = has('sea');
  const [seaVar, setSeaVarState] = useState<SeaVar>(() => store.get<SeaVar>(SEA_PREF) ?? 'sst');
  const setSeaVar = (v: SeaVar) => { setSeaVarState(v); store.set(SEA_PREF, v); };
  const seaShownDay = seaDay(seaVar, imageryDay);
  const seaRef = useRef<SeaHandle | null>(null);
  useEffect(() => {
    if (!map || !seaOn || mapState?.body !== 'earth') return;
    const h = attachSea(map, seaVar, seaShownDay);
    seaRef.current = h;
    return own(() => { if (seaRef.current === h) seaRef.current = null; h.detach(); });
  }, [map, seaOn, mapState?.body, reliefOn, imageryOn, own]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { seaRef.current?.set(seaVar, seaShownDay); }, [seaVar, seaShownDay]);

  const lifeOn = has('marinelife');
  const [lifeTaxon, setLifeTaxonState] = useState<Taxon | null>(() => store.get<Taxon>(LIFE_PREF) ?? null);
  const setLifeTaxon = (x: Taxon | null) => { setLifeTaxonState(x); store.set(LIFE_PREF, x); };
  const [life, setLife] = useState<{ aphia: number; grid: FeatureCollection; stats: GridStats } | null>(null);
  const [lifeLoading, setLifeLoading] = useState(false);
  useEffect(() => {
    if (!lifeOn || !lifeTaxon) { setLife(null); return; }
    let alive = true;
    setLifeLoading(true);
    fetchGrid(lifeTaxon.aphia).then(r => { if (alive) setLife(r ? { aphia: lifeTaxon.aphia, ...r } : null); }).finally(() => { if (alive) setLifeLoading(false); });
    return () => { alive = false; };
  }, [lifeOn, lifeTaxon?.aphia]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!map || !lifeOn || !life || mapState?.body !== 'earth') return;
    return own(attachLife(map, life.grid));
  }, [map, lifeOn, life, mapState?.body, seaOn, reliefOn, imageryOn, own]);
  const showSpecies = (x: Taxon) => { setLifeTaxon(x); if (!prefs.marinelife) toggleLayer('marinelife', true); };

  // ── Rain radar (RainViewer) ─────────────────────────────────────────────
  const radarOn = has('radar') && clock.live;
  const radarRef = useRef<RadarHandle | null>(null);
  useEffect(() => {
    if (!radarOn) { setRadarFrames(null); setRadarFrame(null); return; }
    let gone = false;
    const load = () => fetchRadarFrames().then(f => { if (!gone && f) { setRadarFrames(f); setRadarFrame(cur => (cur && [...f.past, ...f.nowcast].includes(cur) ? cur : f.past[f.past.length - 1] ?? null)); } });
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { gone = true; clearInterval(t); };
  }, [radarOn]);
  useEffect(() => {
    if (!map || !radarOn || radarFrame == null || mapState?.body !== 'earth') return;
    const h = attachRadar(map, radarFrame);
    radarRef.current = h;
    return own(() => { if (radarRef.current === h) radarRef.current = null; h.detach(); });
  }, [map, radarOn, radarFrame == null, mapState?.body, own]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (radarFrame != null) radarRef.current?.setFrame(radarFrame); }, [radarFrame]);

  // ── Sky & haze, plumes and dust, aurora ──────────────────────────────────
  const skyOn = has('atmosphere');
  useEffect(() => {
    if (!map || mapState?.body !== bodyId) return;
    applySky(map, bodyId, skyOn);
  }, [map, mapState?.body, bodyId, skyOn, dark]);

  const effectsOn = (has('plumes') || has('dust')) && !!effectFor(bodyId);
  useEffect(() => {
    if (!map || !effectsOn || mapState?.body !== bodyId) return;
    return own(attachEffects(map, bodyId, body?.radius_km ?? 6371));
  }, [map, effectsOn, bodyId, mapState?.body, own]); // eslint-disable-line react-hooks/exhaustive-deps

  const auroraOn = has('aurora');
  useEffect(() => {
    if (!auroraOn) { setAurora(null); return; }
    let gone = false;
    const load = () => fetchAurora().then(d => { if (!gone && d) setAurora(d); });
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { gone = true; clearInterval(t); };
  }, [auroraOn]);
  useEffect(() => {
    if (!map || !auroraOn || !aurora || mapState?.body !== 'earth') return;
    return own(attachAurora(map, aurora));
  }, [map, auroraOn, aurora, mapState?.body, own]);

  // ── Traverses (Moon, Mars) ──────────────────────────────────────────────
  const traversesOn = has('traverses');
  useEffect(() => {
    if (!map || !lib || !traversesOn) return;
    const travs = getTraversesForBody(bodyId);
    const layer = attachTraverseLayer(lib, map, travs);
    hits.current.set('sb-waypoints-circle', f => {
      const t = travs.find(x => x.id === f.properties?.traverseId);
      const wp = t?.waypoints.find(w => w.id === f.properties?.id);
      if (t && wp) { setSelection({ kind: 'traverse', traverse: t, waypoint: wp }); setPin(null); }
    });
    return own(() => { hits.current.delete('sb-waypoints-circle'); layer.remove(); });
  }, [map, lib, bodyId, traversesOn, own]);

  // ── Earthquakes (Earth) ─────────────────────────────────────────────────
  const quakesOn = has('quakes');
  useEffect(() => {
    setQuakeCount(null);
    if (!map || !quakesOn) return;
    let gone = false;
    const layerId = `${QUAKE_SRC}-dot`;
    const load = () => fetch('/api/planetary/earthquakes.geojson?min_mag=2.5')
      .then(r => (r.ok ? r.json() as Promise<FeatureCollection> : Promise.reject(new Error(String(r.status)))))
      .then(fc => {
        if (gone || !mapAlive(map)) return;
        setQuakeCount(fc.features.length);
        const src = map.getSource(QUAKE_SRC) as ML.GeoJSONSource | undefined;
        if (src) { src.setData(fc); return; }
        map.addSource(QUAKE_SRC, { type: 'geojson', data: fc });
        map.addLayer({
          id: layerId, type: 'circle', source: QUAKE_SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 3, 5, 7, 7, 14],
            'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 2.5, '#4ade80', 4.5, '#facc15', 6, '#fb923c', 7.5, '#f43f5e'],
            'circle-opacity': 0.8, 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(6,7,12,0.8)',
          },
        });
      }).catch(() => { if (!gone) setQuakeCount(null); });
    load();
    const t = setInterval(load, 5 * 60_000);
    hits.current.set(layerId, f => {
      const p = f.properties as Omit<Quake, 'lat' | 'lon'>;
      const [lon, lat] = (f.geometry as Point).coordinates;
      setSelection({ kind: 'quake', item: { ...p, lat, lon } });
      setPin(null);
    });
    return own(() => {
      gone = true;
      clearInterval(t);
      hits.current.delete(layerId);
      if (!mapAlive(map)) return;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(QUAKE_SRC)) map.removeSource(QUAKE_SRC);
    });
  }, [map, quakesOn, own]);

  // ── Relief and 3D terrain ───────────────────────────────────────────────
  useEffect(() => {
    if (!map || !body?.terrain || (!reliefOn && !terrain3dOn) || mapState?.body !== body.id) return;
    return own(attachRelief(map, body, { dark, shade: reliefOn, threeD: terrain3dOn }));
  }, [map, body, dark, reliefOn, terrain3dOn, own]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ice Age coast and solstice lines ────────────────────────────────────
  // re-attached after Relief (same deps) so the old shoreline sits above its depth tint
  const iceOn = has('iceage');
  const iceLayer = useRef<{ setLevel: (m: number) => void } | null>(null);
  const deepRef = useRef(deepYears);
  deepRef.current = deepYears;
  useEffect(() => {
    if (!map || !body?.terrain || !iceOn || mapState?.body !== body.id) return;
    const layer = attachIceAge(map, body, seaLevelAt(deepRef.current), dark);
    iceLayer.current = layer;
    return own(() => { if (iceLayer.current === layer) iceLayer.current = null; layer.detach(); });
  }, [map, body, dark, iceOn, reliefOn, terrain3dOn, own]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { iceLayer.current?.setLevel(seaLevelAt(deepYears)); }, [deepYears]);

  const solarSite = selection?.kind === 'prehistory' && selection.item.align?.length ? selection.item : null;
  useEffect(() => {
    if (!map || !solarSite || mapState?.body !== 'earth') return;
    const labels = Object.fromEntries(Object.entries(SOLAR_LABEL).map(([k, v]) => [k, t(v)])) as typeof SOLAR_LABEL;
    return own(attachSolarLines(map, solarSite, labels));
  }, [map, solarSite, mapState?.body, own]);

  // ── Day/night, grid ─────────────────────────────────────────────────────
  const dayNightOn = has('daynight');
  useEffect(() => {
    if (!map || !dayNightOn) return;
    const layer = attachTerminator(map);
    return own(layer.detach);
  }, [map, dayNightOn, own]);

  const gridOn = has('grid');
  useEffect(() => {
    if (!map || !gridOn) return;
    const layer = attachGrid(map);
    return own(layer.detach);
  }, [map, gridOn, own]);

  // ── Spacecraft ──────────────────────────────────────────────────────────
  const satsOn = has('satellites');
  useEffect(() => {
    setOrbSel(null); setOrbStatus(null);
    if (!map || !lib || !satsOn) return;
    const layer = attachOrbiters(lib, map, bodyId, {
      onSelect: info => { setOrbSel(info); if (info) { setSelection(null); setPin(null); } },
      onStatus: setOrbStatus,
    });
    orbLayer.current = layer;
    return own(() => { orbLayer.current = null; layer.detach(); });
  }, [map, lib, bodyId, satsOn, own]);

  // ── Flights ─────────────────────────────────────────────────────────────
  const trafficOn = has('flights') && clock.live;  // ADS-B is live only; the layer pauses when the clock leaves "now"
  useEffect(() => {
    setPlanes([]); setTrafficErr(null);
    if (!map || !trafficOn) return;
    let gone = false, t: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(t);
      if (!document.hidden && mapAlive(map)) {
        const c = map.getCenter().wrap();
        try {
          const r = await areaFlights(c.lat, c.lng, viewRadiusNm(map));
          if (!gone) { setPlanes(r.aircraft); setTrafficErr(null); }
        } catch (e) { if (!gone) setTrafficErr((e as Error).message); }
      }
      if (!gone) t = setTimeout(load, 8000);
    };
    const onMove = () => { clearTimeout(t); t = setTimeout(load, 400); };
    map.on('moveend', onMove);
    load();
    return () => { gone = true; clearTimeout(t); map.off('moveend', onMove); };
  }, [map, trafficOn]);

  useEffect(() => {
    setSel({ res: null, error: null, updated: null });
    if (!flightQ || !isEarth || !clock.live) return;
    let gone = false, t: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!document.hidden) {
        try {
          const r = await findFlight(flightQ);
          if (!gone) setSel({ res: r, error: null, updated: Date.now() });
        } catch (e) { if (!gone) setSel(s => ({ ...s, error: (e as Error).message })); }
      }
      if (!gone) t = setTimeout(load, 6000);
    };
    load();
    return () => { gone = true; clearTimeout(t); };
  }, [flightQ, isEarth, clock.live]);

  const showPlanes = isEarth && clock.live && (trafficOn || !!flightQ);
  useEffect(() => {
    if (!map || !showPlanes) return;
    pathLayers(map);
    planeLayer(map, 'sb-planes', { labels: true });
    hits.current.set('sb-planes', f => { setFlightQ(String(f.properties?.label ?? f.properties?.hex)); setFollow(false); });
    return own(() => {
      hits.current.delete('sb-planes');
      if (!mapAlive(map)) return;
      PLANE_IDS.layers.forEach(l => map.getLayer(l) && map.removeLayer(l));
      PLANE_IDS.sources.forEach(s => map.getSource(s) && map.removeSource(s));
    });
  }, [map, showPlanes, own]);

  useEffect(() => {
    if (!map || !showPlanes || !mapAlive(map)) return;
    const a = sel.res?.aircraft;
    const shown = trafficOn ? planes : [];
    planeLayer(map, 'sb-planes', { labels: true })(a ? [...shown.filter(p => p.hex !== a.hex), a] : shown, a?.hex);
    pathLayers(map)(flightQ ? sel.res : null);
  }, [map, showPlanes, trafficOn, flightQ, planes, sel.res]);

  const flownTo = useRef<string | null>(null);
  useEffect(() => {
    const a = sel.res?.aircraft;
    if (!map || !a) return;
    if (flownTo.current !== flightQ) {
      flownTo.current = flightQ;
      map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 7) });
    } else if (follow) {
      map.easeTo({ center: [a.lon, a.lat], duration: 900 });
    }
  }, [sel.res, follow, flightQ, map]);

  // ── Measure ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !lib || !measuring) return;
    const pts = measurePoints;
    attachMeasureLayer(lib, map, pts, null);
    const canvas = map.getCanvas();
    canvas.style.cursor = 'crosshair';
    let raf = 0;
    const onMove = (e: ML.MapMouseEvent) => {
      if (!pts.length) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => mapAlive(map) && attachMeasureLayer(lib, map, pts, { lat: e.lngLat.lat, lon: e.lngLat.wrap().lng }));
    };
    map.on('mousemove', onMove);
    return own(() => {
      cancelAnimationFrame(raf);
      map.off('mousemove', onMove);
      if (!mapAlive(map)) return;
      canvas.style.cursor = '';
      detachMeasureLayer(map);
    });
  }, [map, lib, measuring, measurePoints, own]);

  const measurePath = useMemo(
    () => (measurePoints.length < 2 ? null : computePath(measurePoints, body?.radius_km ?? 6371)),
    [measurePoints, body?.radius_km],
  );

  // ── Directions route ────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !lib || !isEarth || !activeRoute) return;
    const SRC = 'sb-app-route';
    map.addSource(SRC, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: activeRoute.coords } } });
    map.addLayer({ id: `${SRC}-casing`, type: 'line', source: SRC, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#06070c', 'line-width': 7, 'line-opacity': 0.7 } });
    map.addLayer({ id: SRC, type: 'line', source: SRC, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3b82f6', 'line-width': 4 } });
    const stops = [activeRoute.from, ...(activeRoute.via ?? []), activeRoute.to];
    const markers = stops.map((s, i, all) =>
      new lib.Marker({ color: i === 0 ? '#10b981' : i === all.length - 1 ? '#f43f5e' : '#f59e0b', scale: 0.8 })
        .setLngLat([s.lon, s.lat])
        .setPopup(new lib.Popup({ offset: 22, closeButton: false, className: 'sb-map-popup' }).setText(s.name))
        .addTo(map));
    if (activeRoute.bbox) {
      map.fitBounds([[activeRoute.bbox[0], activeRoute.bbox[1]], [activeRoute.bbox[2], activeRoute.bbox[3]]],
        { padding: { top: 96, bottom: 64, left: 64, right: 64 }, maxZoom: 15 });
    }
    return own(() => {
      markers.forEach(m => m.remove());
      if (!mapAlive(map)) return;
      [`${SRC}`, `${SRC}-casing`].forEach(l => map.getLayer(l) && map.removeLayer(l));
      if (map.getSource(SRC)) map.removeSource(SRC);
    });
  }, [map, lib, isEarth, activeRoute, own]);

  // ── Worlds list ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const load = (fresh: boolean) => fetchBodies(fresh).then(b => {
      if (!alive) return;
      setBodies(b); setError(null);
      if (b.some(x => x.downloading != null)) t = setTimeout(() => load(true), 15000);
    }).catch(() => alive && setError('The map service didn’t answer.'));
    load(true);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const tree = useMemo(() => {
    const maps = new Map((bodies ?? []).map(b => [b.id, b]));
    const known = new Set(SOL_BODIES.map(b => b.id));
    const node = (id: string, name: string) => ({ id, name, map: maps.get(id) ?? null });
    const tops = SOL_BODIES.filter(b => b.kind !== 'star' && b.kind !== 'moon').map(t => {
      const moons = moonsOf(t.id);
      const extra = (bodies ?? []).filter(m => m.parent === t.id && !known.has(m.id));
      const all = [...moons.map(m => ({ ...node(m.id, m.name), major: isMajorMoon(m, moons.length) })), ...extra.map(m => ({ ...node(m.id, m.name), major: true }))];
      return { ...node(t.id, t.name), moons: all };
    });
    const strays = (bodies ?? []).filter(b => !known.has(b.id) && (!b.parent || !known.has(b.parent))).map(b => ({ ...node(b.id, b.name), moons: [] }));
    return [...tops, ...strays];
  }, [bodies]);

  const [worldFilter, setWorldFilter] = useState('');
  const filteredTree = useMemo(() => {
    const q = worldFilter.trim().toLowerCase();
    if (!q) return tree;
    return tree
      .filter(t => t.name.toLowerCase().includes(q) || t.moons.some(m => m.name.toLowerCase().includes(q)))
      .map(t => (t.name.toLowerCase().includes(q) ? t : { ...t, moons: t.moons.filter(m => m.name.toLowerCase().includes(q)) }));
  }, [tree, worldFilter]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const mapIds = useMemo(() => new Set((bodies ?? []).filter(b => b.available).map(b => b.id)), [bodies]);

  const choose = useCallback((id: string, keepPending = false) => {
    if (!keepPending) pendingView.current = null;
    if (id === bodyId) return;
    if (id !== 'sol') setSolFocus(null);
    setBodyId(id); store.set(LAST, id);
    setPin(null); setSelection(null); setPinCard(null);
    setMeasurePoints([]); setMeasuring(false);
    setActiveRoute(null);
    setDrawer(d => (d === 'directions' && id !== 'earth' ? null : d));
    try { window.history.replaceState(null, '', `#/worlds/${id}`); } catch { /* sandboxed */ }
    if (overlay && (overlay.body ?? 'earth') !== id) setOverlay(null);
    if (window.innerWidth < 900) setPanel(false);
  }, [bodyId, overlay]);
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  const openWorld = useCallback((id: string) => {
    if (!mapIds.has(id)) { setSolFocus({ id }); choose('sol'); }
    else choose(id);
  }, [mapIds, choose]);

  useEffect(() => {
    const onHash = () => { const b = bodyFromHash(); if (b && b !== bodyId) choose(b); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [bodyId, choose]);

  const toggleGlobe = () => setGlobe(g => { store.set(GLOBE, !g); return !g; });
  const toggleLayer = (id: OverlayId, on: boolean) => setPrefs(p => { const n = { ...p, [id]: on }; savePrefs(n); return n; });
  const toggleDrawer = (d: Exclude<Drawer, null>) => setDrawer(cur => (cur === d ? null : d));

  /** Find a feature by the name a card shows, on this world (landmarks, curated layers, prehistory, Atlas places). */
  const findFeature = useCallback((name: string, b: string): { sel: Selection; lat: number; lon: number; overlay: OverlayId | null } | null => {
    const q = name.trim().toLowerCase();
    const eq = (s: string) => s.toLowerCase() === q || s.toLowerCase().startsWith(q) || q.startsWith(s.toLowerCase());
    const lm = getLandmarksForBody(b).find(l => eq(l.name)) ?? getLandmarksForBody(b).find(l => l.name.toLowerCase().includes(q));
    if (lm) return { sel: { kind: 'landmark', item: lm }, lat: lm.lat, lon: lm.lon, overlay: 'landmarks' };
    const pl = places.find(p => eq(p.feature));
    if (pl) return { sel: { kind: 'place', item: pl }, lat: pl.lat, lon: pl.lon, overlay: 'places' };
    if (b === 'earth') {
      const pre = PREHISTORY.find(p => eq(p.name) || (p.nameFr && eq(p.nameFr)));
      if (pre) return { sel: { kind: 'prehistory', item: pre }, lat: pre.lat, lon: pre.lon, overlay: isCaveSite(pre) ? 'caves' : 'neolithic' };
      const w = WORLD_WONDERS.find(x => eq(x.name)); if (w) return { sel: { kind: 'wonder', item: w }, lat: w.lat, lon: w.lon, overlay: 'wonders' };
      const sw = SHIPWRECKS.find(x => eq(x.name)); if (sw) return { sel: { kind: 'shipwreck', item: sw }, lat: sw.lat, lon: sw.lon, overlay: 'shipwrecks' };
      const ls = LAUNCH_SITES.find(x => eq(x.name)); if (ls) return { sel: { kind: 'launchsite', item: ls }, lat: ls.lat, lon: ls.lon, overlay: 'launchsites' };
      const cam = CCTV_CAMERAS.find(x => eq(x.name)); if (cam) return { sel: { kind: 'cctv', item: cam }, lat: cam.lat, lon: cam.lon, overlay: 'webcams' };
    }
    return null;
  }, [places]);

  /** Apply a map block from Atlas or a chat card: markers and lines, then every scene key it carries. */
  const applyScene = useCallback((spec: MapSpec) => {
    const b = (spec.body ?? bodyId).toLowerCase();
    if (spec.markers?.length || spec.lines?.length) setOverlay({ ...spec, body: b });
    else if (overlay && b !== (overlay.body ?? 'earth')) setOverlay(null);
    if (b !== bodyId) chooseRef.current(b, true);
    if (spec.layers) for (const [k, v] of Object.entries(spec.layers)) if (OVERLAYS.some(o => o.id === k)) toggleLayer(k as OverlayId, v);
    if (spec.globe !== undefined && spec.globe !== globe) toggleGlobe();
    if (spec.time) {
      if (/^now$/i.test(spec.time)) goLive();
      else { const ms = Date.parse(spec.time); if (Number.isFinite(ms)) setClock(ms); }
    }
    if (spec.yearsAgo !== undefined) { setDeepYears(spec.yearsAgo); toggleLayer('iceage', true); }
    let flew = false;
    if (spec.center) {
      goTo({ body: b, lat: spec.center.lat, lon: spec.center.lon, zoom: spec.zoom, pitch: spec.pitch, bearing: spec.bearing });
      flew = true;
    }
    if (spec.focus) {
      const f = findFeature(spec.focus, b);
      if (f) {
        if (f.overlay && !prefs[f.overlay]) toggleLayer(f.overlay, true);
        setSelection(f.sel); setPin(null);
        if (!flew) { goTo({ body: b, lat: f.lat, lon: f.lon, zoom: spec.zoom ?? Math.max(map?.getZoom() ?? 0, b === 'earth' ? 11 : 6), pitch: spec.pitch, bearing: spec.bearing }); flew = true; }
      }
    }
    if (!flew && !spec.markers?.length && !spec.lines?.length && (spec.pitch !== undefined || spec.bearing !== undefined) && map) {
      map.easeTo({ pitch: spec.pitch ?? map.getPitch(), bearing: spec.bearing ?? map.getBearing(), duration: 900 });
    }
    if (spec.model) fetchModels().then(all => { const m = modelById(all, spec.model!); if (m) setModelBox(m); });
    if (spec.tour?.length) { setTour({ title: spec.title, stops: spec.tour }); setSelection(null); }
    if (spec.view3d) setView3d(spec.view3d);
  }, [bodyId, overlay, globe, prefs, map, goTo, findFeature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!map || !pendingScene) return;
    setPendingScene(null);
    applyScene(pendingScene);
  }, [map, pendingScene, applyScene]);

  // ── Search ──────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hl, setHl] = useState(0);

  useEffect(() => {
    const q = searchQuery.trim();
    setHl(0);
    if (q.length < 2) { setSuggestions([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      const list: Suggestion[] = [];
      const coord = parseCoords(q);
      if (coord) list.push({ id: 'coord', kind: 'coord', title: `${coord.lat.toFixed(4)}, ${coord.lon.toFixed(4)}`, subtitle: 'Go to coordinates', ...coord });
      for (const s of orbLayer.current?.search(q, 5) ?? []) {
        list.push({ id: `sat-${s.id}`, kind: 'satellite', title: s.name, subtitle: `Spacecraft${s.regime ? ` · ${s.regime}` : ''} · ${isEarth ? `NORAD ${s.id}` : 'JPL Horizons'}`, satId: s.id });
      }
      for (const l of searchLandmarks(q, bodyId).slice(0, 4)) {
        list.push({ id: `lm-${l.id}`, kind: 'landmark', title: l.name, subtitle: [l.kind, l.agency, l.country].filter(Boolean).join(' · '), lat: l.lat, lon: l.lon, landmark: l });
      }
      const ql = q.toLowerCase();
      const show = () => { if (alive) setSuggestions([...list]); };  // local matches first; network ones join as they arrive
      const fetchJson = async <T,>(url: string): Promise<T | null> => {
        try { const r = await fetch(url); return r.ok ? await r.json() as T : null; } catch { return null; }
      };
      if (!isEarth && bodyId !== 'sol') {
        show();
        const d = await fetchJson<{ results?: { name: string; type: string; lat: number; lon: number; diameter_km: number; origin?: string }[] }>(
          `/api/planetary/search?body=${encodeURIComponent(bodyId)}&q=${encodeURIComponent(q)}&limit=6`);
        for (const item of d?.results ?? []) {
          if (list.some(e => Math.abs((e.lat ?? 0) - item.lat) < 0.01 && Math.abs((e.lon ?? 0) - item.lon) < 0.01)) continue;
          const type = item.type.toLowerCase();
          list.push({
            id: `iau-${item.name}-${item.lat}`, kind: 'landmark', title: item.name,
            subtitle: [item.type, item.diameter_km > 0 ? `${item.diameter_km} km` : ''].filter(Boolean).join(' · '),
            lat: item.lat, lon: item.lon,
            landmark: {
              id: `iau-${item.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, bodyId, name: item.name,
              kind: type.includes('crater') ? 'crater' : type.includes('mons') ? 'volcano' : 'plain',
              lat: item.lat, lon: item.lon, diameter: item.diameter_km > 0 ? `${item.diameter_km} km` : undefined,
              desc: item.origin ? `Named for ${item.origin}` : item.type, status: 'IAU named feature',
            },
          });
        }
      }
      if (isEarth) {
        if (/^[a-z]{2,3}\d{1,4}[a-z]?$|^n\d{1,5}[a-z]{0,2}$|^[a-f0-9]{6}$/i.test(q)) {
          list.push({ id: `flight-${q}`, kind: 'flight', title: `Track ${q.toUpperCase()}`, subtitle: 'Live ADS-B flight', flight: q.toUpperCase() });
        }
        const feat = (f: AnyFeature, subtitle: string) => list.push({ id: `${f.kind}-${f.item.id}`, kind: 'feature', title: f.item.name, subtitle, lat: f.item.lat, lon: f.item.lon, feature: f });
        WORLD_WONDERS.filter(w => w.name.toLowerCase().includes(ql)).slice(0, 2).forEach(item => feat({ kind: 'wonder', item }, `Wonder · ${item.location}`));
        SHIPWRECKS.filter(w => w.name.toLowerCase().includes(ql)).slice(0, 2).forEach(item => feat({ kind: 'shipwreck', item }, `Shipwreck · ${item.yearSunk}`));
        LAUNCH_SITES.filter(w => w.name.toLowerCase().includes(ql) || w.operator.toLowerCase().includes(ql)).slice(0, 2).forEach(item => feat({ kind: 'launchsite', item }, `Spaceport · ${item.operator}`));
        PREHISTORY.filter(p => [p.name, p.nameFr ?? '', p.place].some(x => x.toLowerCase().includes(ql))).slice(0, 3).forEach(p => list.push({
          id: `pre-${p.id}`, kind: 'prehistory', title: siteName(p), subtitle: `${t(KIND_LABEL[p.kind])} · ${t(p.country)}`, lat: p.lat, lon: p.lon, site: p,
        }));
        CCTV_CAMERAS.filter(c => (c.lat !== 0 || c.lon !== 0) && (c.name.toLowerCase().includes(ql) || c.city.toLowerCase().includes(ql))).slice(0, 2).forEach(item => feat({ kind: 'cctv', item }, `Webcam · ${item.city}`));
        // places after the curated matches, so 'Titanic' finds the wreck before a village of that name
        show();
        const d = await fetchJson<{ results?: { name: string; full: string; lat: number; lon: number }[] }>(`/api/geocode?q=${encodeURIComponent(q)}&limit=5`);
        for (const item of d?.results ?? []) {
          if (list.some(e => e.kind === 'geocode' && e.title === item.name && Math.abs(e.lat! - item.lat) < 0.2 && Math.abs(e.lon! - item.lon) < 0.2)) continue;
          list.push({ id: `geo-${item.lat}-${item.lon}`, kind: 'geocode', title: item.name, subtitle: item.full, lat: item.lat, lon: item.lon });
        }
      }
      if (alive) { setSuggestions(list); setSearching(false); }
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [searchQuery, isEarth, bodyId, satsOn]);

  const selectSuggestion = (s: Suggestion) => {
    setSearchOpen(false);
    setSearchQuery('');
    if (s.kind === 'flight' && s.flight) { setFlightQ(s.flight); setFollow(true); flownTo.current = null; return; }
    if (s.kind === 'satellite' && s.satId) {
      orbLayer.current?.select(s.satId);
      const w = orbLayer.current?.where(s.satId);
      if (w && map) map.flyTo({ center: [w.lon, w.lat], duration: 1200 });
      return;
    }
    if (s.lat == null || s.lon == null) return;
    if (s.kind === 'prehistory' && s.site) {
      const ov = isCaveSite(s.site) ? 'caves' : 'neolithic';
      if (!prefs[ov]) toggleLayer(ov, true);
      setSelection({ kind: 'prehistory', item: s.site }); setPin(null);
      goTo({ lat: s.lat, lon: s.lon, zoom: Math.max(map?.getZoom() ?? 0, 12) });
    } else if (s.kind === 'feature' && s.feature) {
      const ov = selectionKey(s.feature)?.overlay;
      if (ov && !prefs[ov]) toggleLayer(ov, true);
      setSelection(s.feature); setPin(null);
      goTo({ lat: s.lat, lon: s.lon, zoom: Math.max(map?.getZoom() ?? 0, 8) });
    } else if (s.kind === 'landmark' && s.landmark) {
      setSelection({ kind: 'landmark', item: s.landmark }); setPin(null);
      goTo({ lat: s.lat, lon: s.lon, zoom: Math.max(map?.getZoom() ?? 0, isEarth ? 10 : 5) });
    } else {
      setSelection(null);
      goTo({ lat: s.lat, lon: s.lon, pin: true });
    }
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    if (suggestions.length) { selectSuggestion(suggestions[Math.min(hl, suggestions.length - 1)]); return; }
    const c = parseCoords(searchQuery);
    if (c) { setSearchQuery(''); setSearchOpen(false); goTo({ ...c, pin: true }); }
  };

  const searchKeys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchOpen(true); setHl(h => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setSearchOpen(false); (e.target as HTMLInputElement).blur(); }
  };

  const copyPin = () => {
    if (!pin) return;
    navigator.clipboard.writeText(`${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  const clearSelection = () => setSelection(null);
  const flyNear = (lat: number, lon: number, zoom?: number) => goTo({ lat, lon, zoom: zoom ?? Math.max(map?.getZoom() ?? 0, isEarth ? 12 : 6) });

  const counts: Partial<Record<OverlayId, number | string>> = {
    flights: trafficOn ? planes.length : undefined,
    satellites: orbStatus?.count,
    quakes: quakeCount ?? undefined,
    caves: PREHISTORY.filter(p => isCaveSite(p) && yearsAgo(p) >= deepCut).length,
    neolithic: PREHISTORY.filter(p => !isCaveSite(p) && yearsAgo(p) >= deepCut).length,
    places: places.length || undefined,
    aurora: auroraOn && aurora ? `peak ${aurora.peak}%` : undefined,
    plumes: effectFor(bodyId)?.kind === 'plumes' ? effectFor(bodyId)!.sources.length : undefined,
    imagery: imageryOn ? imageryDay : undefined,
    radar: radarOn && radarFrame ? new Date(radarFrame).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : undefined,
  };
  const selectedBrief = selection ? (
    selection.kind === 'landmark' ? { name: selection.item.name, kind: selection.item.kind }
    : selection.kind === 'traverse' ? { name: `${selection.traverse.name}: ${selection.waypoint.name}`, kind: 'traverse waypoint' }
    : selection.kind === 'quake' ? { name: `M ${selection.item.mag.toFixed(1)} ${selection.item.place}`, kind: 'earthquake' }
    : selection.kind === 'prehistory' ? { name: selection.item.name, kind: KIND_LABEL[selection.item.kind].toLowerCase() }
    : selection.kind === 'place' ? { name: selection.item.feature, kind: `Atlas place, ${selection.item.kind}` }
    : { name: selection.item.name, kind: selection.kind === 'cctv' ? 'webcam' : selection.kind === 'launchsite' ? 'spaceport' : selection.kind }
  ) : orbSel ? { name: orbSel.name, kind: 'spacecraft' } : null;
  const sceneBrief = [
    `Layers on: ${OVERLAYS.filter(o => has(o.id)).map(o => o.id).join(', ') || 'none'}`,
    globe ? 'globe view' : 'flat map',
    has('iceage') ? `Ice Age coast at ${deepYears.toLocaleString()} years ago` : '',
    imageryOn ? `imagery ${imageryLayer} for ${imageryDay}` : '',
    pin ? `Dropped pin at ${fmtCoord(pin.lat, pin.lon)}` : '',
    flightQ ? `Following flight ${flightQ}` : '',
    tour ? `A tour is playing (${tour.stops.length} stops)` : '',
    view3d ? `3D terrain view open at ${view3d.label}` : '',
    `Annotated places on this world: ${places.length}`,
  ].filter(Boolean).join('; ');
  const status = (has('satellites') && (orbStatus?.error ? `Spacecraft: ${orbStatus.error}` : orbStatus?.note))
    || (trafficOn && trafficErr ? `Flights: ${trafficErr}` : null);

  const hasMap = bodyId !== 'sol' && !!body?.available;

  return (
    <div className="h-full flex min-h-0 bg-[var(--bg-primary)]">
      {panel && (
        <aside className="w-60 shrink-0 border-r border-[var(--border-subtle)] flex flex-col min-h-0 bg-[var(--bg-secondary)]">
          <div className="px-3 pt-3 pb-2 border-b border-[var(--border-subtle)] space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Orbit className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Solar System</h2>
              </div>
              <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition" onClick={() => setPanel(false)} title="Hide worlds list">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-2 text-[var(--text-muted)] pointer-events-none" />
              <input
                value={worldFilter} onChange={e => setWorldFilter(e.target.value)} placeholder="Filter worlds and moons"
                className="w-full bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-lg pl-7 pr-6 py-1 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] transition"
              />
              {worldFilter && (
                <button onClick={() => setWorldFilter('')} className="absolute right-2 top-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Clear filter">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
            {!bodies && !error && Array.from({ length: 6 }, (_, i) => <div key={i} className="h-7 mx-2 my-1 rounded bg-[var(--bg-tertiary)] animate-pulse" />)}
            {(bodies || error) && (!worldFilter || 'sol orrery sun'.includes(worldFilter.toLowerCase())) && (
              <WorldRow body={{ id: 'sol', name: 'Sol (Orrery)', available: true }} active={bodyId === 'sol' && (!solFocus || solFocus.id === 'sol')}
                onPick={() => { setSolFocus({ id: 'sol' }); choose('sol'); }} depth={0} star />
            )}
            {filteredTree.map(t => {
              const shown = expanded.has(t.id) || worldFilter ? t.moons : t.moons.filter(m => m.major || m.map);
              const hidden = t.moons.filter(m => !m.major && !m.map).length;
              const row = (w: { id: string; name: string; map: MapBody | null }, depth: 1 | 2) => (
                <WorldRow key={w.id} body={w.map ?? { id: w.id, name: w.name, available: false }} depth={depth} hollow={!w.map}
                  active={w.map ? w.id === bodyId : bodyId === 'sol' && solFocus?.id === w.id}
                  title={w.map ? undefined : `No ${w.name} map installed; shows it in the orrery`} onPick={openWorld} />
              );
              return (
                <div key={t.id} className="mb-1">
                  {row(t, 1)}
                  {shown.map(m => row(m, 2))}
                  {!worldFilter && hidden > 0 && (
                    <button className="w-full pl-10 pr-2 py-1 text-left text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                      onClick={() => setExpanded(e => { const n = new Set(e); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}>
                      {expanded.has(t.id) ? 'Fewer moons' : `+${hidden} smaller moon${hidden === 1 ? '' : 's'}`}
                    </button>
                  )}
                </div>
              );
            })}
          </nav>
        </aside>
      )}

      <section className="relative flex-1 min-w-0 flex min-h-0">
        <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
          {bodyId === 'sol' ? (
            <SolView mapIds={mapIds} onOpenMap={choose} focus={solFocus} onShowPanel={panel ? undefined : () => setPanel(true)} />
          ) : (
            <>
              <div className="absolute inset-0 bg-[#04050a] overflow-hidden">
                {globe && hasMap && prefs.stars && <Starfield />}
                <div ref={box} className="w-full h-full relative z-10" />
              </div>

              {/* Toolbar */}
              <div className="absolute top-3 left-3 right-14 flex flex-wrap items-center gap-2 pointer-events-none z-20">
                {!panel && (
                  <button className="pointer-events-auto h-9 w-9 grid place-items-center rounded-xl border border-[var(--border-subtle)] sb-map-glass text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                    onClick={() => setPanel(true)} title="Show worlds list">
                    <PanelLeftOpen className="w-4 h-4" />
                  </button>
                )}
                <button
                  className={clsx('pointer-events-auto h-9 flex items-center gap-2 rounded-xl border sb-map-glass pl-3 pr-2.5 transition',
                    drawer === 'dossier' ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)] hover:border-[var(--text-muted)]')}
                  onClick={() => toggleDrawer('dossier')} title="About this world"
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: WORLD_PALETTE[bodyId]?.color ?? '#94a3b8' }} />
                  <span className="text-[13px] font-semibold tracking-tight text-[var(--text-primary)]">{body?.name ?? bodyId}</span>
                  <Info className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                </button>

                {hasMap && (
                  <div className="relative pointer-events-auto flex-1 min-w-[160px] max-w-[340px]">
                    <form onSubmit={submitSearch} className="flex items-center h-9 rounded-xl border border-[var(--border-subtle)] sb-map-glass focus-within:border-[var(--accent)] transition">
                      <Search className="w-3.5 h-3.5 ml-2.5 text-[var(--text-muted)] shrink-0" />
                      <input
                        value={searchQuery}
                        onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                        onFocus={() => setSearchOpen(true)}
                        onBlur={() => setSearchOpen(false)}
                        onKeyDown={searchKeys}
                        placeholder={isEarth ? 'Places, flights, coordinates' : `Search ${body?.name ?? ''} features`}
                        className="min-w-0 flex-1 bg-transparent px-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                        aria-label="Search the map"
                      />
                      {searching && <Loader2 className="w-3 h-3 animate-spin mr-2 text-[var(--text-muted)]" />}
                      {searchQuery && (
                        <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setSearchQuery(''); setSuggestions([]); }}
                          className="mr-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Clear">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </form>
                    {searchOpen && searchQuery.trim().length >= 2 && (suggestions.length > 0 || !searching) && (
                      <div className="absolute left-0 right-0 top-10 rounded-xl border border-[var(--border-subtle)] sb-map-glass py-1 shadow-2xl z-40 max-h-80 overflow-y-auto">
                        {suggestions.length === 0 && <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">No matches</div>}
                        {suggestions.map((s, i) => (
                          <button key={s.id} type="button" onMouseDown={e => { e.preventDefault(); selectSuggestion(s); }} onMouseEnter={() => setHl(i)}
                            className={clsx('w-full px-3 py-1.5 text-left flex items-start gap-2 transition', i === hl && 'bg-[var(--bg-tertiary)]')}>
                            <SuggestionIcon s={s} />
                            <div className="min-w-0 flex-1">
                              <div className="text-[12px] font-medium text-[var(--text-primary)] truncate">{s.title}</div>
                              {s.subtitle && <div className="text-[10.5px] text-[var(--text-muted)] truncate">{s.subtitle}</div>}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-1" />

                {hasMap && (
                  <div className="pointer-events-auto flex items-center rounded-xl border border-[var(--border-subtle)] sb-map-glass p-0.5">
                    <ToolButton on={globe} onClick={toggleGlobe} icon={globe ? Globe2 : MapIcon} label={globe ? 'Globe' : 'Flat'} title="Switch between globe and flat map" />
                    <ToolButton on={measuring} onClick={() => { setMeasuring(m => !m); setMeasurePoints([]); }} icon={Ruler} label="Measure" title="Measure great-circle distance" />
                    {isEarth && <ToolButton on={drawer === 'directions'} onClick={() => toggleDrawer('directions')} icon={RouteIcon} label="Directions" title="Offline turn-by-turn directions" />}
                    <ToolButton on={drawer === 'bookmarks'} onClick={() => toggleDrawer('bookmarks')} icon={Bookmark} title="Tours and saved places" />
                  </div>
                )}
                {hasMap && <LayersPanel bodyId={bodyId} bodyName={body?.name ?? bodyId} globe={globe} ctx={worldCtx} prefs={prefs} onToggle={toggleLayer} counts={counts} />}
                <button
                  className={clsx('pointer-events-auto h-9 px-3 flex items-center gap-1.5 rounded-xl border sb-map-glass text-[12px] font-medium transition',
                    drawer === 'atlas' ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
                  onClick={() => toggleDrawer('atlas')} aria-pressed={drawer === 'atlas'} title="Ask Atlas about this world"
                >
                  <Compass className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Atlas</span>
                </button>
              </div>

              {measuring && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 flex flex-col gap-2 px-3.5 py-2 rounded-xl border border-[var(--border-subtle)] sb-map-glass text-[12px] max-w-[calc(100%-1.5rem)]">
                <div className="flex items-center gap-3">
                  <Ruler className="w-4 h-4 text-teal-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-[var(--text-primary)] font-mono tabular-nums">
                      {measurePath ? formatDist(measurePath.totalKm, measureUnit) : measurePoints.length ? 'Click the next point' : 'Click to start'}
                    </div>
                    {measurePath && (
                      <div className="text-[10.5px] text-[var(--text-muted)]">
                        {measurePath.segments.length} leg{measurePath.segments.length === 1 ? '' : 's'} · last bearing {Math.round(measurePath.segments[measurePath.segments.length - 1].bearingDeg)}° {measurePath.segments[measurePath.segments.length - 1].bearingCompass}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 border-l border-[var(--border-subtle)] pl-3">
                    <button onClick={() => setMeasureUnit(u => { const n = u === 'metric' ? 'imperial' : u === 'imperial' ? 'nautical' : 'metric'; store.set(MEASURE_UNIT, n); return n; })}
                      className="px-2 py-1 rounded-md bg-[var(--bg-tertiary)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Change units">
                      {measureUnit === 'metric' ? 'km' : measureUnit === 'imperial' ? 'mi' : 'nmi'}
                    </button>
                    {measurePoints.length > 0 && (
                      <button onClick={() => setMeasurePoints(p => p.slice(0, -1))} className="px-2 py-1 rounded-md bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Undo</button>
                    )}
                    <button onClick={() => { setMeasuring(false); setMeasurePoints([]); }} className="px-2.5 py-1 rounded-md bg-[var(--accent)] text-[var(--accent-fg)] font-medium text-[11px]">Done</button>
                  </div>
                </div>
                {body?.terrain && measurePoints.length >= 2 && <MeasureProfile body={body} points={measurePoints} radiusKm={body.radius_km} unit={measureUnit} />}
                </div>
              )}

              {tour && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
                  <TourPlayer title={tour.title} stops={tour.stops} onClose={() => setTour(null)}
                    onFly={(t, ms) => goTo({ body: t.body, lat: t.lat, lon: t.lon, zoom: t.zoom, pitch: t.pitch ?? 0, bearing: t.bearing ?? 0, duration: ms })} />
                </div>
              )}

              {/* One detail card at a time, top left under the toolbar */}
              {selection && (
                <div className="absolute top-16 left-3 z-30 max-h-[calc(100%-8rem)] overflow-y-auto rounded-xl max-w-[calc(100%-1.5rem)]">
                  {selection.kind === 'landmark' ? (
                    <LandmarkModal landmark={selection.item} onClose={clearSelection} onFlyTo={(la, lo) => flyNear(la, lo, isEarth ? 12 : 7)} terrain={!!body?.terrain} />
                  ) : selection.kind === 'traverse' ? (
                    <TraverseModal traverse={selection.traverse} waypoint={selection.waypoint}
                      onSelectWaypoint={wp => setSelection({ kind: 'traverse', traverse: selection.traverse, waypoint: wp })}
                      onFlyTo={(la, lo, zm) => flyNear(la, lo, zm ?? 12)} onClose={clearSelection} />
                  ) : selection.kind === 'quake' ? (
                    <QuakeCard q={selection.item} onClose={clearSelection} />
                  ) : selection.kind === 'prehistory' ? (
                    <PrehistoryCard site={selection.item} onClose={clearSelection} onFlyTo={(la, lo) => flyNear(la, lo, 13)}
                      onDeepTime={y => { setDeepYears(y); if (!prefs.iceage) toggleLayer('iceage', true); flyNear(selection.item.lat, selection.item.lon, 6); }} />
                  ) : selection.kind === 'place' ? (
                    <PlaceCard place={selection.item} onClose={clearSelection} onFlyTo={(la, lo) => flyNear(la, lo, isEarth ? 12 : 7)} terrain={!!body?.terrain} />
                  ) : (
                    <MapFeatureModal feature={selection} onClose={clearSelection} onFlyTo={(la, lo) => flyNear(la, lo, 12)} terrain={!!body?.terrain} />
                  )}
                </div>
              )}

              {hasMap && isEarth && (imageryOn || (radarOn && radarFrames) || seaOn || lifeOn) && (
                <div className={clsx('absolute left-3 z-20 flex flex-col gap-1.5 pointer-events-none', selection ? 'bottom-14' : 'top-16')}>
                  {imageryOn && (
                    <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 text-[11px]">
                      <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <select value={imageryLayer} onChange={e => setImageryLayer(e.target.value)} aria-label="Imagery layer"
                        className="bg-transparent text-[var(--text-primary)] outline-none max-w-[11rem]">
                        {(imageryCat.length ? imageryCat : [{ id: imageryLayer, name: imageryLayer, since: '', level: 9, daily: true, note: '' }]).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                      <span className="font-mono tabular-nums text-[var(--text-secondary)]" title="Follows the map clock; use the time bar to pick a day">{imageryCat.find(l => l.id === imageryLayer)?.daily === false ? 'composite' : imageryDay}</span>
                    </div>
                  )}
                  {seaOn && <SeaChip v={seaVar} onChange={setSeaVar} day={seaShownDay} />}
                  {lifeOn && <LifeChip taxon={lifeTaxon} stats={life?.stats ?? null} loading={lifeLoading} onPick={setLifeTaxon} onClear={() => setLifeTaxon(null)} />}
                  {radarOn && radarFrames && radarFrame != null && (
                    <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 text-[11px]">
                      <CloudRain className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <input type="range" min={0} max={radarFrames.past.length + radarFrames.nowcast.length - 1} step={1} aria-label="Radar frame"
                        value={Math.max(0, [...radarFrames.past, ...radarFrames.nowcast].indexOf(radarFrame))}
                        onChange={e => setRadarFrame([...radarFrames.past, ...radarFrames.nowcast][+e.target.value])} className="w-28 accent-sky-400" />
                      <span className="font-mono tabular-nums text-[var(--text-secondary)]" title={radarFrames.note}>
                        {new Date(radarFrame).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]" title={radarFrames.note}>NASA IMERG · {Math.round((Date.now() - Date.parse(radarFrames.past[radarFrames.past.length - 1])) / 3_600_000)} h behind</span>
                    </div>
                  )}
                </div>
              )}

              {hasMap && iceOn && (
                <div className={clsx('absolute right-14 z-20', isEarth && flightQ ? 'bottom-24' : 'top-16')}>
                  <DeepTimePanel years={deepYears} onChange={setDeepYears} onClose={() => toggleLayer('iceage', false)}
                    shown={has('caves') || has('neolithic')
                      ? PREHISTORY.filter(p => (has('caves') && isCaveSite(p)) || (has('neolithic') && !isCaveSite(p))).filter(p => yearsAgo(p) >= deepYears).length
                      : null} />
                </div>
              )}

              {isEarth && flightQ && (
                <div className="absolute top-16 right-14 w-80 max-w-[calc(100%-5rem)] max-h-[calc(100%-6rem)] overflow-y-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass z-20">
                  <FlightPanel res={sel.res} error={sel.error} updated={sel.updated} loadingLabel={`Looking for ${flightQ}…`}
                    onClose={() => { setFlightQ(null); setFollow(false); }} />
                  {sel.res?.aircraft && (
                    <div className="px-3.5 pb-3">
                      <button className={clsx('w-full h-8 flex items-center justify-center gap-1.5 rounded-md border text-[12px] transition',
                        follow ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
                        onClick={() => setFollow(f => !f)} aria-pressed={follow}>
                        <LocateFixed className="w-3.5 h-3.5" /> {follow ? 'Following' : 'Follow'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {satsOn && orbSel && (
                <SpacecraftCard info={orbSel} earth={isEarth} from={pin ?? (map ? { lat: map.getCenter().lat, lon: map.getCenter().wrap().lng } : null)} fromPin={!!pin}
                  layer={orbLayer.current} onClose={() => orbLayer.current?.select(null)} />
              )}

              {status && (
                <div className="absolute top-16 right-14 rounded-lg border border-amber-500/40 sb-map-glass px-2.5 py-1 text-[11px] text-amber-500 z-10 max-w-[60%] truncate">{status}</div>
              )}

              {hasMap && (
                <div className="absolute bottom-3 left-3 right-28 flex flex-wrap items-end gap-2 pointer-events-none z-20">
                  {map && <Readout map={map} />}
                  {satsOn && isEarth && (
                    <div className="rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 text-[10.5px] text-[var(--text-secondary)] flex items-center gap-2.5 whitespace-nowrap"
                      title="Orbit bands: low Earth orbit (under 2,000 km), medium (GPS, ~20,200 km), geostationary (35,786 km), and high/elliptical">
                      {(['LEO', 'MEO', 'GEO', 'HEO'] as const).map(k => (
                        <span key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: REGIME_COLOR[k] }} />{k}</span>
                      ))}
                    </div>
                  )}
                  {pin && (
                    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--border-subtle)] sb-map-glass pl-2.5 pr-1 py-1 text-[11px]">
                      <MapPin className="w-3.5 h-3.5 text-[#ff5a36] shrink-0" />
                      <span className="font-mono tabular-nums text-[var(--text-primary)] mx-1">{fmtCoord(pin.lat, pin.lon)}</span>
                      <PinButton onClick={copyPin} title="Copy coordinates">{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</PinButton>
                      {hasSky(bodyId) && <PinButton on={pinCard === 'sky'} onClick={() => setPinCard(c => (c === 'sky' ? null : 'sky'))} title="The sky from here"><Eye className="w-3.5 h-3.5" /></PinButton>}
                      {isEarth && <PinButton on={pinCard === 'weather'} onClick={() => setPinCard(c => (c === 'weather' ? null : 'weather'))} title="Weather here"><Thermometer className="w-3.5 h-3.5" /></PinButton>}
                      {isEarth && <PinButton on={pinCard === 'sea'} onClick={() => setPinCard(c => (c === 'sea' ? null : 'sea'))} title={t('The sea here: conditions and species recorded')}><Waves className="w-3.5 h-3.5" /></PinButton>}
                      {isEarth && <PinButton onClick={() => setDrawer('directions')} title="Directions to or from here"><RouteIcon className="w-3.5 h-3.5" /></PinButton>}
                      {body?.terrain && <PinButton onClick={() => setView3d({ lat: pin.lat, lon: pin.lon, label: fmtCoord(pin.lat, pin.lon), spanKm: isEarth ? 40 : 160 })} title="3D terrain here (a dive, at sea)"><Mountain className="w-3.5 h-3.5" /></PinButton>}
                      <PinButton onClick={() => { setPin(null); setPinCard(null); }} title="Remove pin"><X className="w-3.5 h-3.5" /></PinButton>
                    </div>
                  )}
                </div>
              )}

              {lightbox && (
                <div className="absolute inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-6 gap-3" onClick={() => setLightbox(null)}
                  role="dialog" aria-label={lightbox.caption} onKeyDown={e => e.key === 'Escape' && setLightbox(null)} tabIndex={-1} ref={el => el?.focus()}>
                  {lightbox.kind === 'model'
                    ? <ModelViewer src={mediaSrc(lightbox)} alt={lightbox.caption} className="w-full h-[calc(100%-4rem)]" />
                    : <img src={mediaSrc(lightbox)} alt={lightbox.caption} className="max-w-full max-h-[calc(100%-4rem)] object-contain rounded" onClick={e => e.stopPropagation()} />}
                  <div className="max-w-3xl text-center text-[12px] text-slate-200">
                    {lightbox.caption}
                    {(lightbox.credit || lightbox.license) && <span className="text-slate-400"> · {[lightbox.credit, lightbox.license].filter(Boolean).join(' · ')}</span>}
                  </div>
                  <button className="absolute top-3 right-3 p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20" title="Close" onClick={() => setLightbox(null)}><X className="w-4 h-4" /></button>
                </div>
              )}

              {modelBox && <ModelLightbox model={modelBox} onClose={() => setModelBox(null)} />}
              {view3d && body && (body.terrain
                ? <DiveView body={body} target={view3d} onClose={() => setView3d(null)} />
                : <div className="absolute top-16 right-14 z-30 rounded-lg border border-amber-500/40 sb-map-glass px-2.5 py-1 text-[11px] text-amber-500 flex items-center gap-2">No elevation data for {body.name}, so no 3D view here.<button onClick={() => setView3d(null)} className="hover:text-[var(--text-primary)]"><X className="w-3.5 h-3.5" /></button></div>)}
              {hasMap && isEarth && auroraOn && aurora && (
                <div className={clsx('absolute right-14 z-20 rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 text-[11px] flex items-center gap-2 pointer-events-auto', iceOn ? 'top-28' : 'top-16')} title={aurora.forecast ? `NOAA OVATION forecast for ${new Date(aurora.forecast).toLocaleTimeString()}` : undefined}>
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[var(--text-secondary)]">Aurora forecast</span>
                  <span className="font-mono tabular-nums text-[var(--text-primary)]">peak {aurora.peak}%</span>
                  {aurora.stale && <span className="text-amber-400">stale</span>}
                </div>
              )}

              {hasMap && (
                <MapClock className="absolute z-20 left-1/2 -translate-x-1/2 bottom-16 2xl:bottom-3 max-w-[calc(100%-1.5rem)]"
                  flights={has('flights')} sats={satsOn ? (isEarth ? 'tle' : 'track') : null} />
              )}

              {pinCard === 'weather' && pin && isEarth && (
                <div className="absolute bottom-14 left-3 z-30">
                  <LiveWeatherWidget lat={pin.lat} lon={pin.lon} onClose={() => setPinCard(null)} />
                </div>
              )}
              {pinCard === 'sea' && pin && isEarth && (
                <div className="absolute bottom-14 left-3 z-30">
                  <SeaCard lat={pin.lat} lon={pin.lon} onClose={() => setPinCard(null)} onShowSpecies={showSpecies} />
                </div>
              )}
              {pinCard === 'sky' && pin && (
                <SkyViewModal bodyId={bodyId} bodyName={body?.name ?? bodyId} lat={pin.lat} lon={pin.lon}
                  onClose={() => setPinCard(null)} onAskAtlas={() => { setPinCard(null); setDrawer('atlas'); }} />
              )}

              {(error || (bodies && (!body || !body.available))) && (
                <div className="absolute inset-0 grid place-items-center p-6 z-30 bg-[#06070c]">
                  <div className="max-w-sm text-center text-slate-200">
                    {body?.downloading != null ? (
                      <>
                        <Download className="w-6 h-6 mx-auto text-slate-400" />
                        <h3 className="mt-3 text-[15px] font-semibold tracking-tight">The {body.name} map is downloading</h3>
                        <p className="mt-1 text-[12px] leading-relaxed text-slate-400">The full OpenStreetMap planet is about 139 GB. It appears here as soon as it finishes; other worlds work meanwhile.</p>
                        <div className="mt-4 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                          <div className="h-full bg-[var(--accent)] transition-[width] duration-700" style={{ width: `${Math.round(body.downloading * 100)}%` }} />
                        </div>
                        <div className="mt-1.5 text-[11px] tabular-nums text-slate-400">{(body.downloading * 100).toFixed(1)}%</div>
                      </>
                    ) : (
                      <>
                        <Orbit className="w-6 h-6 mx-auto text-slate-400" />
                        <h3 className="mt-3 text-[15px] font-semibold tracking-tight">{error ?? (body ? `No ${body.name} map installed` : 'That world isn’t in the catalogue')}</h3>
                        <p className="mt-1 text-[12px] leading-relaxed text-slate-400">Map data lives in ~/shellb/maps on the Spark.</p>
                        <button className="mt-4 h-8 px-3 rounded-lg border border-slate-700 text-[12px] text-slate-200 hover:bg-slate-800" onClick={() => { setSolFocus({ id: bodyId }); choose('sol'); }}>
                          Show it in the orrery
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {((!bodies && !error) || (hasMap && !map)) && (
                <div className="absolute inset-0 grid place-items-center z-[15] pointer-events-none">
                  <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                </div>
              )}
            </>
          )}
        </div>

        {drawer && bodyId !== 'sol' && (
          <aside className="shrink-0 h-full z-30 max-w-[100vw] absolute right-0 top-0 md:static">
            {drawer === 'directions' && isEarth && (
              <DirectionsPanel pinCoord={pin} onRouteReady={setActiveRoute}
                onStepClick={st => { if (st.at && map) map.flyTo({ center: st.at, zoom: Math.max(map.getZoom(), 15), duration: 700 }); }}
                onClose={() => { setDrawer(null); setActiveRoute(null); }} />
            )}
            {drawer === 'dossier' && (
              <DossierDrawer bodyId={bodyId} radiusKm={body?.radius_km} onClose={() => setDrawer(null)}
                onOpenSol={id => { setDrawer(null); setSolFocus({ id }); choose('sol'); }} />
            )}
            {drawer === 'bookmarks' && (
              <BookmarksModal currentBodyId={bodyId} pinCoord={pin} onClose={() => setDrawer(null)} onImport={applyScene}
                onSelect={bm => goTo({ body: bm.bodyId, lat: bm.lat, lon: bm.lon, zoom: bm.zoom, bearing: bm.bearing ?? 0, pitch: bm.pitch ?? 0, pin: true })} />
            )}
            {drawer === 'atlas' && (
              <AtlasCopilot isOpen request={atlasRequest} onClose={() => setDrawer(null)} bodyId={bodyId} bodyName={body?.name ?? bodyId} viewport={viewport}
                selected={selectedBrief} scene={sceneBrief}
                onFlyTo={t => goTo({ body: t.body, lat: t.lat, lon: t.lon, zoom: t.zoom ?? 7, pin: true })}
                onApplyOverlay={applyScene} />
            )}
          </aside>
        )}
      </section>
    </div>
  );
}

/** Cursor position and zoom, updated straight from the map so the app doesn't re-render on every mouse move. */
function Readout({ map }: { map: ML.Map }) {
  const [text, setText] = useState<{ at: string | null; z: number }>({ at: null, z: map.getZoom() });
  useEffect(() => {
    let raf = 0, last: { lat: number; lon: number } | null = null;
    const flush = () => { raf = 0; setText({ at: last ? fmtCoord(last.lat, last.lon) : null, z: map.getZoom() }); };
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };
    const move = (e: ML.MapMouseEvent) => { last = { lat: e.lngLat.lat, lon: e.lngLat.wrap().lng }; queue(); };
    const out = () => { last = null; queue(); };
    map.on('mousemove', move);
    map.on('mouseout', out);
    map.on('zoom', queue);
    return () => { cancelAnimationFrame(raf); map.off('mousemove', move); map.off('mouseout', out); map.off('zoom', queue); };
  }, [map]);
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-[var(--text-secondary)] flex items-center gap-2 whitespace-nowrap">
      <span className="min-w-[17ch]">{text.at ?? '—'}</span>
      <span className="text-[var(--text-muted)]">z{text.z.toFixed(1)}</span>
    </div>
  );
}

/** The selected spacecraft: where it is, its orbit band, and (Earth) when it's visible from the pin or map centre. */
function SpacecraftCard({ info, earth, from, fromPin, layer, onClose }: {
  info: OrbiterInfo; earth: boolean; from: { lat: number; lon: number } | null; fromPin: boolean; layer: OrbiterLayer | null; onClose: () => void;
}) {
  const [list, setList] = useState<Pass[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => setList(null), [info.id]);
  useEffect(() => {
    let alive = true;
    fetchModels().then(all => { if (alive) setModels(modelsForSpacecraft(all, info.name, earth && /^\d+$/.test(info.id) ? +info.id : undefined)); });
    return () => { alive = false; };
  }, [info.id, info.name, earth]);
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="absolute bottom-14 right-3 w-72 max-h-[calc(100%-8rem)] overflow-y-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass p-3 text-[12px] z-20">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-tight font-semibold tracking-tight truncate">{info.name}</div>
          {info.mission && <div className="text-[11px] text-[var(--text-muted)] truncate">{info.mission}</div>}
        </div>
        <button className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={onClose} title="Close"><X className="w-3.5 h-3.5" /></button>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {([['Latitude', `${Math.abs(info.lat).toFixed(2)}° ${info.lat >= 0 ? 'N' : 'S'}`], ['Longitude', `${Math.abs(info.lon).toFixed(2)}° ${info.lon >= 0 ? 'E' : 'W'}`],
          ['Altitude', `${Math.round(info.alt).toLocaleString()} km${info.regime ? ` · ${info.regime}` : ''}`],
          [earth ? 'Speed' : 'Ground speed', Number.isFinite(info.speed) ? `${info.speed.toFixed(2)} km/s` : '—']] as [string, string][]).map(([k, v]) => (
          <div key={k}><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{k}</dt><dd className="font-mono tabular-nums">{v}</dd></div>
        ))}
      </dl>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-[#d95926]" />last 45 min</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-[var(--text-secondary)]" />next 90 min</span>
        <span className="flex items-center gap-1"><span className="w-3 border-t border-dotted border-[#f97316]" />in view</span>
      </div>
      {earth && from && layer && (
        <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)]">
          {!list ? (
            <button className="w-full h-8 rounded-md border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              onClick={() => setList(layer.passes(info.id, from.lat, from.lon) ?? [])}>
              Passes over {fromPin ? 'the pin' : 'the map centre'}, next 3 days
            </button>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Passes over {fromPin ? 'the pin' : 'the map centre'} (10° up or more)</div>
              {list.length === 0 && <div className="text-[11.5px] text-[var(--text-muted)]">None in the next 3 days.</div>}
              <ul className="space-y-1">
                {list.map(p => (
                  <li key={p.start} className="flex items-baseline gap-2 text-[11.5px]">
                    <span className="tabular-nums text-[var(--text-primary)]">{when(p.start)}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">{Math.round(p.maxEl)}° · {compass(p.startAz)}→{compass(p.endAz)} · {Math.max(1, Math.round((p.end - p.start) / 60000))} min</span>
                    {p.visible && <span className="ml-auto text-[10px] font-medium text-emerald-500" title="Sunlit while your sky is dark">visible</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">“Visible” means the satellite is sunlit while your sky is dark. Times are local.</div>
            </>
          )}
        </div>
      )}
      {models.length > 0 && <div className="mt-3 space-y-2">{models.map(m => <ModelStrip key={m.id} model={m} onOpen={mm => window.dispatchEvent(new CustomEvent(OPEN_MODEL, { detail: mm }))} />)}</div>}
      <div className="mt-2 text-[10px] text-[var(--text-muted)]">{earth ? 'Computed here from Celestrak elements' : 'Ground track from JPL Horizons'}</div>
    </div>
  );
}

/** The shared clock's controls on the map, with a note when a layer can't follow the chosen time. */
function MapClock({ className, flights, sats }: { className: string; flights: boolean; sats: 'tle' | 'track' | null }) {
  const live = useClockState().live;
  const t = useClockTime(5000);
  const off = t - Date.now();
  const note = flights && !live ? 'Flights are live only; press Now to see them.'
    : sats === 'tle' && Math.abs(off) > 30 * 86_400_000 ? 'Satellite orbits drift more than a few weeks from today, so their positions here are rough.'
    : sats === 'track' && (off < -2 * 3_600_000 || off > 4 * 3_600_000) ? 'Spacecraft tracks only cover 2 hours back to 4 hours ahead of now.'
    : null;
  return <TimeBar playRate={2} className={className} note={note} />;
}

function ToolButton({ on, onClick, icon: Icon, label, title }: { on: boolean; onClick: () => void; icon: typeof Globe2; label?: string; title: string }) {
  return (
    <button onClick={onClick} aria-pressed={on} title={title}
      className={clsx('h-8 px-2.5 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition',
        on ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
      <Icon className="w-3.5 h-3.5" />
      {label && <span className="hidden lg:inline">{label}</span>}
    </button>
  );
}

function PinButton({ on, onClick, title, children }: { on?: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-pressed={on}
      className={clsx('p-1.5 rounded-lg transition', on ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]')}>
      {children}
    </button>
  );
}

function SuggestionIcon({ s }: { s: Suggestion }) {
  const c = 'w-3.5 h-3.5 mt-0.5 shrink-0';
  if (s.kind === 'landmark') return <Flag className={clsx(c, 'text-emerald-400')} />;
  if (s.kind === 'flight') return <Radar className={clsx(c, 'text-sky-400')} />;
  if (s.kind === 'coord') return <Crosshair className={clsx(c, 'text-amber-400')} />;
  if (s.kind === 'satellite') return <Satellite className={clsx(c, 'text-sky-400')} />;
  if (s.kind === 'prehistory' && s.site) {
    const Icon = isCaveSite(s.site) ? Hand : Wheat;
    return <Icon className={c} style={{ color: KIND_COLOR[s.site.kind] }} />;
  }
  if (s.kind === 'feature') {
    const k = s.feature?.kind;
    return k === 'shipwreck' ? <Anchor className={clsx(c, 'text-cyan-400')} /> : k === 'wonder' ? <Sparkles className={clsx(c, 'text-amber-400')} />
      : k === 'launchsite' ? <Rocket className={clsx(c, 'text-orange-400')} /> : <Video className={clsx(c, 'text-pink-400')} />;
  }
  return <Navigation className={clsx(c, 'text-[var(--text-muted)]')} />;
}

function QuakeCard({ q, onClose }: { q: Quake; onClose: () => void }) {
  const when = new Date(q.time);
  const ago = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000));
  return (
    <div className="w-80 max-w-full rounded-xl border border-[var(--border-subtle)] sb-map-glass p-3.5 text-[12px]">
      <div className="flex items-start gap-2">
        <Activity className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-tight text-[var(--text-primary)]">M {q.mag.toFixed(1)} earthquake</div>
          <div className="text-[11.5px] text-[var(--text-secondary)]">{q.place}</div>
        </div>
        <button className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={onClose} title="Close"><X className="w-3.5 h-3.5" /></button>
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">When</dt><dd className="tabular-nums">{ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Depth</dt><dd className="tabular-nums">{Math.round(q.depth_km)} km</dd></div>
        <div className="col-span-2"><dt className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Location</dt><dd className="font-mono tabular-nums">{fmtCoord(q.lat, q.lon)}</dd></div>
      </dl>
      {q.url && <a href={q.url} target="_blank" rel="noreferrer" className="mt-2.5 inline-block text-[11.5px] text-[var(--accent)] hover:underline">USGS event page</a>}
    </div>
  );
}

const INDENT = ['pl-2', 'pl-6', 'pl-10'];

function WorldRow({ body, active, onPick, depth, star, hollow, title }: {
  body: Pick<MapBody, 'id' | 'name' | 'available'> & Partial<MapBody>; active: boolean; onPick: (id: string) => void;
  depth: 0 | 1 | 2; star?: boolean; hollow?: boolean; title?: string;
}) {
  const moon = depth === 2;
  const color = WORLD_PALETTE[body.id.toLowerCase()]?.color ?? '#94a3b8';
  return (
    <button
      onClick={() => onPick(body.id)} aria-current={active ? 'page' : undefined} title={title}
      className={clsx(
        'group w-full flex items-center gap-2 rounded-lg py-1.5 pr-2.5 text-left text-[12.5px] transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
        INDENT[depth],
        active ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]',
        hollow && !active && 'text-[var(--text-muted)]',
      )}
    >
      <span
        className={clsx('shrink-0 rounded-full', moon ? 'w-2 h-2' : star ? 'w-3 h-3' : 'w-2.5 h-2.5', hollow && 'border border-dashed')}
        style={{ backgroundColor: hollow ? 'transparent' : color, borderColor: hollow ? color : undefined, opacity: hollow && !active ? 0.5 : 1 }}
      />
      <span className={clsx('flex-1 truncate', !moon && 'font-medium')}>{body.name}</span>
      {body.downloading != null && <span className="shrink-0 text-[10px] tabular-nums font-mono text-amber-400">{Math.round(body.downloading * 100)}%</span>}
    </button>
  );
}
