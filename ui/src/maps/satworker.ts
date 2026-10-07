// Web Worker: propagates the whole Earth-satellite catalogue (≈16k TLEs) with SGP4 off the main thread.
// in:  { type: 'init', sats: { line1, line2 }[] }  then  { type: 'at', t: ms }
// out: { type: 'at', t, pos: Float32Array }  — lon°, lat°, alt km per satellite (NaN when SGP4 fails or decays)
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';

let recs: (SatRec | null)[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; sats: { line1: string; line2: string }[] } | { type: 'at'; t: number };
  if (m.type === 'init') {
    recs = m.sats.map(s => { try { return twoline2satrec(s.line1, s.line2); } catch { return null; } });
    return;
  }
  const when = new Date(m.t), g = gstime(when);
  const pos = new Float32Array(recs.length * 3);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    let lon = NaN, lat = NaN, alt = NaN;
    if (r) {
      const pv = propagate(r, when);
      if (pv && pv.position && typeof pv.position !== 'boolean') {
        const geo = eciToGeodetic(pv.position, g);
        if (geo.height > 80) { lon = degreesLong(geo.longitude); lat = degreesLat(geo.latitude); alt = geo.height; }
      }
    }
    pos[i * 3] = lon; pos[i * 3 + 1] = lat; pos[i * 3 + 2] = alt;
  }
  (self as unknown as Worker).postMessage({ type: 'at', t: m.t, pos }, [pos.buffer]);
};
