// Import and export for the Worlds app: GeoJSON, KML and GPX in (as a map overlay), KML/GeoJSON out (bookmarks,
// Atlas places, a measured path). Parsing uses DOMParser on text the user picked, nothing is executed.
import type { MapLine, MapPoint, MapSpec } from './core';
import type { Bookmark } from './bookmarks';

const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : NaN; };
const okLat = (v: number) => v >= -90 && v <= 90, okLon = (v: number) => v >= -180 && v <= 180;

function fromGeoJSON(raw: unknown, title: string): MapSpec | null {
  const markers: MapPoint[] = [], lines: MapLine[] = [];
  const feats: unknown[] = (raw as { type?: string; features?: unknown[] })?.type === 'FeatureCollection' ? (raw as { features: unknown[] }).features
    : (raw as { type?: string })?.type === 'Feature' ? [raw] : (raw as { type?: string })?.type ? [{ type: 'Feature', properties: {}, geometry: raw }] : [];
  const walk = (g: unknown, props: Record<string, unknown>) => {
    const geom = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
    const label = typeof props.name === 'string' ? props.name : typeof props.title === 'string' ? props.title : undefined;
    const note = typeof props.description === 'string' ? props.description.replace(/<[^>]+>/g, '').slice(0, 300) : undefined;
    const pt = (c: unknown): [number, number] | null => Array.isArray(c) && okLat(num(c[1])) && okLon(num(c[0])) ? [num(c[1]), num(c[0])] : null;
    switch (geom?.type) {
      case 'Point': { const p = pt(geom.coordinates); if (p) markers.push({ lat: p[0], lon: p[1], label, note }); break; }
      case 'MultiPoint': (geom.coordinates as unknown[] ?? []).forEach(c => { const p = pt(c); if (p) markers.push({ lat: p[0], lon: p[1], label, note }); }); break;
      case 'LineString': { const pts = (geom.coordinates as unknown[] ?? []).map(pt).filter((p): p is [number, number] => !!p); if (pts.length > 1) lines.push({ points: pts, label }); break; }
      case 'MultiLineString': case 'Polygon': (geom.coordinates as unknown[][] ?? []).forEach(ring => { const pts = ring.map(pt).filter((p): p is [number, number] => !!p); if (pts.length > 1) lines.push({ points: pts, label }); }); break;
      case 'MultiPolygon': (geom.coordinates as unknown[][][] ?? []).forEach(poly => poly.forEach(ring => { const pts = ring.map(pt).filter((p): p is [number, number] => !!p); if (pts.length > 1) lines.push({ points: pts, label }); })); break;
      case 'GeometryCollection': (geom.geometries ?? []).forEach(gg => walk(gg, props)); break;
    }
  };
  for (const f of feats) {
    const ff = f as { geometry?: unknown; properties?: Record<string, unknown> };
    if (ff.geometry) walk(ff.geometry, ff.properties ?? {});
  }
  return markers.length || lines.length ? { title, markers, lines } : null;
}

function fromKML(doc: Document, title: string): MapSpec | null {
  const markers: MapPoint[] = [], lines: MapLine[] = [];
  const coords = (s: string | null) => (s ?? '').trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && okLat(c[1]) && okLon(c[0])).map(c => [c[1], c[0]] as [number, number]);
  for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
    const label = pm.getElementsByTagName('name')[0]?.textContent?.trim() || undefined;
    const note = pm.getElementsByTagName('description')[0]?.textContent?.replace(/<[^>]+>/g, '').trim().slice(0, 300) || undefined;
    for (const p of Array.from(pm.getElementsByTagName('Point'))) { const c = coords(p.getElementsByTagName('coordinates')[0]?.textContent); if (c[0]) markers.push({ lat: c[0][0], lon: c[0][1], label, note }); }
    for (const l of Array.from(pm.getElementsByTagName('LineString'))) { const c = coords(l.getElementsByTagName('coordinates')[0]?.textContent); if (c.length > 1) lines.push({ points: c, label }); }
    for (const l of Array.from(pm.getElementsByTagName('LinearRing'))) { const c = coords(l.getElementsByTagName('coordinates')[0]?.textContent); if (c.length > 1) lines.push({ points: c, label }); }
  }
  const docName = doc.getElementsByTagName('Document')[0]?.getElementsByTagName('name')[0]?.textContent?.trim();
  return markers.length || lines.length ? { title: docName || title, markers, lines } : null;
}

function fromGPX(doc: Document, title: string): MapSpec | null {
  const markers: MapPoint[] = [], lines: MapLine[] = [];
  const at = (el: Element) => { const lat = num(el.getAttribute('lat')), lon = num(el.getAttribute('lon')); return okLat(lat) && okLon(lon) ? [lat, lon] as [number, number] : null; };
  for (const w of Array.from(doc.getElementsByTagName('wpt'))) { const p = at(w); if (p) markers.push({ lat: p[0], lon: p[1], label: w.getElementsByTagName('name')[0]?.textContent?.trim() || undefined }); }
  for (const seg of [...Array.from(doc.getElementsByTagName('trkseg')), ...Array.from(doc.getElementsByTagName('rte'))]) {
    const pts = Array.from(seg.children).filter(c => c.tagName === 'trkpt' || c.tagName === 'rtept').map(at).filter((p): p is [number, number] => !!p);
    const label = seg.parentElement?.getElementsByTagName('name')[0]?.textContent?.trim() || undefined;
    if (pts.length > 1) lines.push({ points: pts.length > 2000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 2000) === 0) : pts, label });
  }
  return markers.length || lines.length ? { title, markers, lines } : null;
}

/** Parse a file the user picked into a map overlay, or null when nothing usable is in it. */
export function parseGeoFile(name: string, text: string): MapSpec | null {
  const title = name.replace(/\.[^.]+$/, '');
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return fromGeoJSON(JSON.parse(t), title); } catch { return null; } }
  if (t.startsWith('<')) {
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const root = doc.documentElement.tagName.toLowerCase();
    if (root === 'kml') return fromKML(doc, title);
    if (root === 'gpx') return fromGPX(doc, title);
  }
  return null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface ExportPlace { name: string; desc?: string; lat: number; lon: number; body?: string }

export function toKML(name: string, places: ExportPlace[], lines: { name: string; points: [number, number][] }[] = []): string {
  const pm = places.map(p => `  <Placemark><name>${esc(p.name)}</name>${p.desc ? `<description>${esc(p.desc)}</description>` : ''}${p.body && p.body !== 'earth' ? `<ExtendedData><Data name="world"><value>${esc(p.body)}</value></Data></ExtendedData>` : ''}<Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`);
  const ls = lines.map(l => `  <Placemark><name>${esc(l.name)}</name><LineString><tessellate>1</tessellate><coordinates>${l.points.map(([lat, lon]) => `${lon},${lat},0`).join(' ')}</coordinates></LineString></Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>\n${[...pm, ...ls].join('\n')}\n</Document></kml>\n`;
}

export function toGeoJSON(places: ExportPlace[], lines: { name: string; points: [number, number][] }[] = []): string {
  return JSON.stringify({ type: 'FeatureCollection', features: [
    ...places.map(p => ({ type: 'Feature', properties: { name: p.name, description: p.desc ?? '', world: p.body ?? 'earth' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
    ...lines.map(l => ({ type: 'Feature', properties: { name: l.name }, geometry: { type: 'LineString', coordinates: l.points.map(([lat, lon]) => [lon, lat]) } })),
  ] }, null, 1);
}

export const bookmarksToPlaces = (bms: Bookmark[]): ExportPlace[] => bms.map(b => ({ name: b.name, desc: b.desc, lat: b.lat, lon: b.lon, body: b.bodyId }));

export function download(filename: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
