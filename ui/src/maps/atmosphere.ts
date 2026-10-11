// Sky and haze per world: MapLibre's sky (globe limb glow, horizon when tilted) tinted the way each world's
// atmosphere scatters light. Airless worlds get a black sky; Mars a butterscotch one; Venus thick yellow-white;
// Titan orange smog; Pluto and Triton a faint blue haze. Also the palette the 3D views use for their skies.
import type * as ML from 'maplibre-gl';

export interface SkyLook {
  sky: string; horizon: string; fog: string;
  /** 0 = airless (no glow), 1 = a thick atmosphere */
  density: number;
  note: string;
}

export const SKY: Record<string, SkyLook> = {
  earth: { sky: '#88c6fc', horizon: '#dfeffd', fog: '#ffffff', density: 1, note: 'Rayleigh scattering: blue sky, white horizon' },
  mars: { sky: '#c89f78', horizon: '#e6c1a0', fog: '#d9a97f', density: 0.45, note: 'Dust in a thin CO₂ atmosphere: butterscotch sky, blue-tinged sunsets' },
  venus: { sky: '#e9d8a3', horizon: '#f3e7bf', fog: '#efe0ad', density: 1, note: 'Sulphuric-acid clouds 50 km up: a yellow-white overcast, no Sun disc' },
  titan: { sky: '#d98a33', horizon: '#f2b366', fog: '#e9a24f', density: 1, note: 'Organic smog: an orange sky; the Sun a dim smear' },
  pluto: { sky: '#7f9bc2', horizon: '#b7c9e2', fog: '#a2b7d6', density: 0.2, note: 'Blue haze layers of tholins in a nitrogen atmosphere 10 μbar thick' },
  triton: { sky: '#8aa4c4', horizon: '#c3d2e6', fog: '#aebfd9', density: 0.12, note: 'Thin nitrogen haze with geyser plumes drifting downwind' },
  io: { sky: '#3a3634', horizon: '#6b5a44', fog: '#4a4038', density: 0.05, note: 'SO₂ from the volcanoes: a near-vacuum; faint glow at the limb' },
  enceladus: { sky: '#1b2230', horizon: '#4d6f8f', fog: '#2e4a66', density: 0.06, note: 'Plume vapour over the south pole; otherwise airless' },
};
const AIRLESS: SkyLook = { sky: '#06070c', horizon: '#06070c', fog: '#06070c', density: 0, note: 'No atmosphere: the sky is black at noon' };

export const skyFor = (bodyId: string): SkyLook => SKY[bodyId] ?? AIRLESS;

/** The sky spec for a world's style (globe or flat); `on` false gives every world Earth's default blue. */
export function skySpec(bodyId: string, on: boolean): ML.SkySpecification {
  const look = on ? skyFor(bodyId) : SKY.earth;
  const blend = look.density;
  return {
    'sky-color': look.sky,
    'horizon-color': look.horizon,
    'fog-color': look.fog,
    'fog-ground-blend': 0.5,
    'horizon-fog-blend': 0.8,
    'sky-horizon-blend': blend > 0 ? 0.8 : 1,
    // the limb glow fades as you zoom in; airless worlds never glow
    'atmosphere-blend': blend > 0 ? (['interpolate', ['linear'], ['zoom'], 0, blend, 5, blend, 7, 0] as unknown as number) : 0,
  };
}

export function applySky(map: ML.Map, bodyId: string, on: boolean) {
  try { map.setSky(skySpec(bodyId, on)); } catch { /* style not ready */ }
}
