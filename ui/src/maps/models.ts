// 3D models for the Worlds app: NASA spacecraft, landers and rovers (GLB) served by server/maps.py from
// ~/shellb/maps/models (fetch_models.py writes the catalog). Cards look models up by landmark id, spacecraft name,
// NORAD number or world; Atlas names one with a map block's "model" key.

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  url: string;
  bytes: number;
  tags: string[];
  landmarks?: string[];
  spacecraft?: string[];
  norad?: number[];
  bodies?: string[];
  /** approximate real size of the object, metres */
  size_m?: number;
  credit: string;
  license: string;
  source: string;
}

let cache: Promise<ModelInfo[]> | null = null;

export function fetchModels(fresh = false): Promise<ModelInfo[]> {
  if (!cache || fresh) {
    cache = fetch('/api/maps/models').then(r => (r.ok ? r.json() : { models: [] })).then((d: { models?: ModelInfo[] }) => d.models ?? [])
      .catch(() => { cache = null; return [] as ModelInfo[]; });
  }
  return cache;
}

export const modelsForLandmark = (all: ModelInfo[], landmarkId: string) => all.filter(m => m.landmarks?.includes(landmarkId));
export const modelsForBody = (all: ModelInfo[], bodyId: string) => all.filter(m => m.bodies?.includes(bodyId));
export function modelsForSpacecraft(all: ModelInfo[], name: string, norad?: number) {
  const n = name.toLowerCase();
  return all.filter(m => (norad != null && m.norad?.includes(norad)) || m.spacecraft?.some(s => n === s.toLowerCase() || n.startsWith(s.toLowerCase() + ' ')));
}
export const modelById = (all: ModelInfo[], id: string) => all.find(m => m.id === id) ?? null;

export function fmtSize(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : m >= 10 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`;
}
