// "Atlas places": points Atlas (or the owner) put on the map themselves, each with a card from the start.
// Server: server/worldnotes.py (a note with a `place`). Listed per world; NOTES_CHANGED refreshes them.

export interface Place {
  key: string; body: string; feature: string; lat: number; lon: number;
  kind: string; color?: string | null; summary: string; media: number; by?: string; updated?: number;
}

export const PLACE_KIND_LABEL: Record<string, string> = {
  place: 'Place', mission: 'Mission', crater: 'Crater', volcano: 'Volcano', mountain: 'Mountain', canyon: 'Canyon', plain: 'Plain', sea: 'Sea',
  site: 'Site', city: 'City', wreck: 'Wreck', wonder: 'Wonder', event: 'Event', route: 'Route',
};
export const PLACE_COLOR = '#f472b6';

export async function fetchPlaces(body: string, signal?: AbortSignal): Promise<Place[]> {
  const r = await fetch(`/api/worlds/places?body=${encodeURIComponent(body)}`, { signal });
  if (!r.ok) return [];
  const d = await r.json() as { places?: Place[] };
  return d.places ?? [];
}
