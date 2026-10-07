// Relief for the Worlds app: hillshading (and, on Earth, ocean depth tint) from the terrarium elevation tiles that
// planets/build_dem.py builds into ~/shellb/maps/terrain, plus optional 3D terrain.
//
// MapLibre turns elevation metres into world units with Earth's radius, but every world here is drawn Earth-sized,
// so on a smaller body real heights would look squashed by R_earth/R_body. 3D exaggeration is scaled by that ratio
// so Olympus Mons stands as tall against Mars as it really does.
import type * as ML from 'maplibre-gl';
import type { MapBody } from './core';
import { mapAlive } from './pointLayer';

const SRC = 'sb-dem', SRC_3D = 'sb-dem-3d', SHADE = 'sb-relief', DEPTH = 'sb-depth';

export function attachRelief(map: ML.Map, body: MapBody, opts: { dark: boolean; shade: boolean; threeD: boolean }): () => void {
  const t = body.terrain;
  if (!t) return () => {};
  const url = `pmtiles://${location.origin}/api/maps/terrain/${body.id}.pmtiles?v=${t.version}`;
  // each source gets its own URL, so the pmtiles protocol keeps a separate reader per source: with one shared reader, a
  // tile request cancelled by one source could leave the other with an undecodable tile (a flat hole in 3D terrain)
  const source = (role: string): ML.RasterDEMSourceSpecification => ({
    type: 'raster-dem', url: `${url}&for=${role}`, tileSize: t.tileSize, encoding: 'terrarium', maxzoom: t.maxzoom, attribution: t.attribution,
  });
  const earth = body.id === 'earth';
  // on Earth: above land and sea fills, below rivers, roads and labels; elsewhere: above the mosaic, below our overlays
  const before = earth ? (map.getLayer('water_stream') ? 'water_stream' : undefined)
    : map.getStyle().layers.find(l => l.id.startsWith('sb-'))?.id;

  if (opts.shade) {
    map.addSource(SRC, source('shade'));
    if (earth) {
      const ramp = opts.dark
        ? [-11000, '#070c1d', -6000, '#0d1530', -4000, '#142042', -2000, '#1c2b4f', -200, '#28364f', -1, '#323b4c']
        : [-11000, '#0e3f6e', -6000, '#1a5d8f', -4000, '#2f7fae', -2000, '#4ea3c9', -200, '#7fcbe0', -1, '#a5e3ee'];
      map.addLayer({
        id: DEPTH, type: 'color-relief', source: SRC,
        paint: { 'color-relief-opacity': 0.9, 'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...ramp, 0, 'rgba(0,0,0,0)'] as unknown as ML.ExpressionSpecification },
      }, before);
    }
    map.addLayer({
      id: SHADE, type: 'hillshade', source: SRC,
      paint: {
        // strongest zoomed out (continents, ridges, trenches), easing off at street level where roads matter
        'hillshade-exaggeration': earth ? ['interpolate', ['linear'], ['zoom'], 0, 0.8, 6, 0.65, 10, 0.45, 14, 0.25] : 0.6,
        'hillshade-shadow-color': opts.dark || !earth ? 'rgba(0,0,0,0.78)' : 'rgba(70,55,40,0.5)',
        'hillshade-highlight-color': opts.dark || !earth ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.5)',
        'hillshade-accent-color': 'rgba(0,0,0,0.1)',
      },
    }, before);
  }

  if (opts.threeD) {
    map.addSource(SRC_3D, source('3d'));  // its own source: MapLibre recommends not sharing one with hillshade
    const scale = 6371 / (body.radius_km || 6371);
    map.setTerrain({ source: SRC_3D, exaggeration: 1.5 * scale });
    if (map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 });
  }

  return () => {
    if (!mapAlive(map)) return;
    if (opts.threeD) map.setTerrain(null);
    for (const l of [SHADE, DEPTH]) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of [SRC, SRC_3D]) if (map.getSource(s)) map.removeSource(s);
  };
}
