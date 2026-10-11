// Feature notes: extra facts, sections, media and links that Atlas (or the owner) attaches to a map card.
// Server: server/worldnotes.py. Notes come from the web, so everything here renders as plain text.

export interface NoteMedia {
  file: string; kind: 'image' | 'audio' | 'video' | 'model'; mime: string; url: string;
  caption: string; credit: string; license: string; source: string; note: string;
}
export interface FeatureNote {
  body: string; feature: string; summary: string;
  facts: { label: string; value: string }[];
  sections: { title: string; text: string }[];
  media: NoteMedia[];
  links: { title: string; url: string }[];
  updated?: number; by?: string;
}

/** Fired when a note may have changed (Atlas finished annotating); cards refetch. */
export const NOTES_CHANGED = 'shellb:worlds-notes';
/** Fired by a card to open media big over the map: detail = NoteMedia. */
export const OPEN_MEDIA = 'shellb:worlds-media';
/** Fired by a card to ask Atlas something: detail = prompt text. */
export const ASK_ATLAS = 'shellb:worlds-ask-atlas';
/** Fired by a card to show a catalog 3D model big: detail = ModelInfo. */
export const OPEN_MODEL = 'shellb:worlds-model';
/** Fired by a card to open the 3D terrain / dive view: detail = View3DTarget. */
export const OPEN_VIEW3D = 'shellb:worlds-view3d';

export const mediaSrc = (m: NoteMedia) => `/api/worlds/media/${m.file}`;

export async function fetchNote(body: string, feature: string, signal?: AbortSignal): Promise<FeatureNote | null> {
  const r = await fetch(`/api/worlds/notes?body=${encodeURIComponent(body)}&feature=${encodeURIComponent(feature)}`, { signal });
  if (!r.ok) throw new Error(`notes ${r.status}`);
  const d = await r.json() as FeatureNote | Record<string, never>;
  return 'feature' in d ? d as FeatureNote : null;
}

export async function removeNotePart(body: string, feature: string, part?: 'facts' | 'sections' | 'media' | 'links', index?: number) {
  const q = new URLSearchParams({ body, feature });
  if (part) { q.set('part', part); q.set('index', String(index ?? 0)); }
  const r = await fetch(`/api/worlds/notes?${q}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`delete ${r.status}`);
  window.dispatchEvent(new Event(NOTES_CHANGED));
}

export const askAtlas = (prompt: string) => window.dispatchEvent(new CustomEvent(ASK_ATLAS, { detail: prompt }));
export const openMedia = (m: NoteMedia) => window.dispatchEvent(new CustomEvent(OPEN_MEDIA, { detail: m }));

export const openModel = (m: import('./models').ModelInfo) => window.dispatchEvent(new CustomEvent(OPEN_MODEL, { detail: m }));
export const openView3D = (t: import('./DiveView').View3DTarget) => window.dispatchEvent(new CustomEvent(OPEN_VIEW3D, { detail: t }));
