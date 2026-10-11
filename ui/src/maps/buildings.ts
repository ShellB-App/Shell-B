// 3D buildings on Earth: fill-extrusion from the Protomaps `buildings` layer (OSM height / min_height, or an
// estimate from the building kind when OSM has none). Visible from zoom 14; the map tilts so they show.
import type * as ML from 'maplibre-gl';
import { mapAlive } from './pointLayer';

const ID = 'sb-buildings-3d';

export function attachBuildings(map: ML.Map, dark: boolean): () => void {
  if (!map.getSource('protomaps') || map.getLayer(ID)) return () => {};
  const height: ML.ExpressionSpecification = ['coalesce', ['get', 'height'], ['case', ['==', ['get', 'kind_detail'], 'house'], 6, ['==', ['get', 'kind_detail'], 'garage'], 3, 11]];
  const color: ML.ExpressionSpecification = dark
    ? ['interpolate', ['linear'], height, 0, '#3b4252', 40, '#4c566a', 150, '#6b7a99']
    : ['interpolate', ['linear'], height, 0, '#dcd7cf', 40, '#cfc7bb', 150, '#b8ad9c'];
  // just above the flat building footprints, below roads labels and our overlays
  const before = map.getStyle().layers.find(l => l.id === 'roads_labels_minor' || l.id === 'pois' || l.id.startsWith('sb-'))?.id;
  map.addLayer({
    id: ID, type: 'fill-extrusion', source: 'protomaps', 'source-layer': 'buildings', minzoom: 13.5,
    filter: ['in', 'kind', 'building', 'building_part'],
    paint: {
      'fill-extrusion-color': color,
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, height],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 14.5, ['coalesce', ['get', 'min_height'], 0]],
      'fill-extrusion-opacity': 0.85,
      'fill-extrusion-vertical-gradient': true,
    },
  }, before);
  if (map.getLayer('buildings')) map.setPaintProperty('buildings', 'fill-opacity', 0.15);
  if (map.getPitch() < 20 && map.getZoom() >= 13.5) map.easeTo({ pitch: 50, duration: 900 });
  return () => {
    if (!mapAlive(map)) return;
    if (map.getLayer(ID)) map.removeLayer(ID);
    if (map.getLayer('buildings')) map.setPaintProperty('buildings', 'fill-opacity', 0.5);
  };
}
