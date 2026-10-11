// 3D terrain view for the Worlds app: dive below the sea to a wreck or a trench (Earth bathymetry), or fly through a
// canyon, crater or volcano on any world with elevation tiles. Heights come from elevation.ts (the same terrarium
// PMTiles as the relief layers); three.js draws a coloured mesh with fog, a water surface seen from below, marine snow
// or wind-blown dust, and a marker at the target. Vertical exaggeration is adjustable and always shown.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Mountain, Snowflake, Waves, Wind, X } from 'lucide-react';
import type { MapBody } from './core';
import { elevationGrid, type HeightGrid } from './elevation';
import { loadThree } from './ModelViewer';
import { skyFor } from './atmosphere';

export interface View3DTarget { lat: number; lon: number; label: string; kind?: string; depthM?: number; spanKm?: number }
type Mode = 'dive' | 'fly';
const SPANS = [20, 40, 80, 160, 320];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
/** Piecewise-linear colour ramp over [stop, colour] pairs. */
function ramp(stops: [number, string][]): (v: number) => [number, number, number] {
  const cs = stops.map(([v, c]) => [v, hex(c)] as const);
  return v => {
    if (v <= cs[0][0]) return [...cs[0][1]];
    for (let i = 1; i < cs.length; i++) {
      if (v <= cs[i][0]) { const t = (v - cs[i - 1][0]) / (cs[i][0] - cs[i - 1][0]); return [0, 1, 2].map(k => lerp(cs[i - 1][1][k], cs[i][1][k], t)) as [number, number, number]; }
    }
    return [...cs[cs.length - 1][1]];
  };
}
const SEA = ramp([[-11000, '#1b2f52'], [-6000, '#2c4a78'], [-3000, '#3b6a9c'], [-1000, '#4f8fbe'], [-200, '#6fb5d6'], [0, '#9fdcec']]);
const LAND = ramp([[0, '#c9b48b'], [200, '#6f9a48'], [1000, '#9a8a5a'], [2500, '#8c7a6b'], [4500, '#e8e8e8'], [8800, '#ffffff']]);
const MARS = ramp([[0, '#4a2314'], [0.3, '#8b3f1f'], [0.6, '#b8713d'], [0.85, '#d9a066'], [1, '#f1d7b0']]);
const GREY = ramp([[0, '#2b2b2b'], [0.5, '#7a7a7a'], [1, '#d8d8d8']]);
const ICE = ramp([[0, '#4a6a86'], [0.5, '#9fc0d8'], [1, '#f1f7fb']]);

function colourFor(body: MapBody, mode: Mode, g: HeightGrid): (h: number) => [number, number, number] {
  const span = Math.max(1, g.max - g.min);
  if (body.id === 'earth') return h => (h < 0 ? SEA(h) : LAND(h));
  if (body.id === 'mars') return h => MARS((h - g.min) / span);
  if (['europa', 'enceladus', 'ganymede', 'callisto', 'titan', 'pluto', 'triton', 'charon', 'mimas', 'tethys', 'dione', 'rhea', 'iapetus'].includes(body.id)) return h => ICE((h - g.min) / span);
  return h => GREY((h - g.min) / span);
}

const fmtM = (m: number) => `${Math.round(Math.abs(m)).toLocaleString()} m`;

export function DiveView({ body, target, onClose }: { body: MapBody; target: View3DTarget; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(target.spanKm ?? (body.id === 'earth' ? 40 : 160));
  const [exag, setExag] = useState(body.id === 'earth' ? 3 : 2);
  const [particles, setParticles] = useState(true);
  const [storm, setStorm] = useState(false);
  const [surface, setSurface] = useState(true);
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; mode?: Mode; grid?: HeightGrid; targetH?: number; msg?: string }>({ phase: 'loading' });
  const [cursor, setCursor] = useState<{ h: number; km: number } | null>(null);
  const live = useRef({ exag, particles, storm, surface });
  live.current = { exag, particles, storm, surface };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false, raf = 0;
    let dispose = () => {};
    setState({ phase: 'loading' });
    setCursor(null);
    (async () => {
      const [{ THREE, OrbitControls }, grid] = await Promise.all([loadThree(), elevationGrid(body, target.lat, target.lon, span, 128)]);
      if (gone) return;
      if (!grid) { setState({ phase: 'error', msg: 'No elevation data here.' }); return; }
      const n = grid.n, mid = Math.floor(n / 2);
      const hCentre = grid.heights[mid * n + mid];
      const targetH = target.depthM != null ? -Math.abs(target.depthM) : Number.isNaN(hCentre) ? grid.min : hCentre;
      const mode: Mode = body.id === 'earth' && targetH < -5 ? 'dive' : 'fly';
      const look = skyFor(body.id);
      const colour = colourFor(body, mode, grid);

      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      el.appendChild(renderer.domElement);
      renderer.domElement.style.display = 'block';
      const scene = new THREE.Scene();
      const deep = new THREE.Color(0x03182c), skyC = new THREE.Color(look.sky), fogC = new THREE.Color(mode === 'dive' ? 0x062c48 : look.fog);
      scene.background = mode === 'dive' ? deep : (look.density > 0 ? skyC : new THREE.Color(0x05060a));
      const fogDensity = mode === 'dive' ? 0.9 / span : 0;
      const fog = mode === 'dive' ? new THREE.FogExp2(fogC.getHex(), fogDensity) : new THREE.Fog(fogC.getHex(), span * 0.5, span * 2.2);
      scene.fog = fog;

      // terrain mesh: PlaneGeometry rows run north → south once rotated flat, matching the grid
      const geo = new THREE.PlaneGeometry(span, span, n - 1, n - 1);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as import('three').BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        let h = grid.heights[i];
        if (Number.isNaN(h)) h = grid.min;
        pos.setY(i, h / 1000);
        const c = colour(h);
        // faint contour bands (every 100 m under the sea, 250 m on land) so smooth slopes still read as relief
        const band = Math.floor(h / (h < 0 ? 100 : 250));
        const shade = band % 2 === 0 ? 1 : 0.9;
        col[i * 3] = c[0] * shade; col[i * 3 + 1] = c[1] * shade; col[i * 3 + 2] = c[2] * shade;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
      scene.add(terrain);
      // a skirt-coloured floor under the mesh so the edges don't show the void
      const base = new THREE.Mesh(new THREE.BoxGeometry(span, 0.001, span), new THREE.MeshBasicMaterial({ color: mode === 'dive' ? 0x041a2e : 0x1a1512 }));
      base.position.y = (grid.min / 1000) * 3 - span * 0.02;
      scene.add(base);

      scene.add(new THREE.HemisphereLight(mode === 'dive' ? 0x8fc8f0 : look.sky, mode === 'dive' ? 0x0a2238 : 0x2a2420, mode === 'dive' ? 1.4 : 1.3));
      const sun = new THREE.DirectionalLight(mode === 'dive' ? 0xbfe3ff : 0xfff1dc, mode === 'dive' ? 1.6 : 2.2);
      sun.position.set(span, span * (mode === 'dive' ? 1.5 : 0.8), span * 0.4);
      scene.add(sun);

      // water surface seen from below (dive)
      let water: import('three').Mesh | null = null;
      if (mode === 'dive') {
        water = new THREE.Mesh(new THREE.PlaneGeometry(span * 4, span * 4), new THREE.MeshBasicMaterial({ color: 0x3c9fd6, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
        water.rotateX(-Math.PI / 2);
        scene.add(water);
      }

      // the target: a ring on the ground and a line up to the surface (dive) or into the sky (fly)
      const marker = new THREE.Group();
      const ringR = span / 45;
      const ring = new THREE.Mesh(new THREE.RingGeometry(ringR * 0.7, ringR, 48), new THREE.MeshBasicMaterial({ color: mode === 'dive' ? 0xffb347 : 0xff5a36, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
      ring.rotateX(-Math.PI / 2);
      marker.add(ring);
      const lineH = mode === 'dive' ? 1 : span * 0.08;
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, lineH, 0)]);
      const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: 0xffd48a, dashSize: span / 200, gapSize: span / 300, transparent: true, opacity: 0.8 }));
      line.computeLineDistances();
      marker.add(line);
      scene.add(marker);

      // particles: marine snow sinking, or dust blowing with the wind
      const kind = mode === 'dive' ? 'snow' : body.id === 'mars' || body.id === 'venus' || body.id === 'titan' ? 'dust' : null;
      let points: import('three').Points | null = null;
      const N = 3000, boxSize = span * 0.7;
      const pp = new Float32Array(N * 3), vv = new Float32Array(N * 3);
      if (kind) {
        for (let i = 0; i < N; i++) {
          pp[i * 3] = (Math.random() - 0.5) * boxSize; pp[i * 3 + 1] = (Math.random() - 0.5) * boxSize; pp[i * 3 + 2] = (Math.random() - 0.5) * boxSize;
          vv[i * 3] = (Math.random() - 0.5) * 0.02; vv[i * 3 + 1] = kind === 'snow' ? -0.01 - Math.random() * 0.02 : (Math.random() - 0.5) * 0.01; vv[i * 3 + 2] = (Math.random() - 0.5) * 0.02;
        }
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
        // a soft round dot, so particles are motes rather than squares
        const cv = document.createElement('canvas'); cv.width = cv.height = 64;
        const g2 = cv.getContext('2d')!; const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,255,255,0.6)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        g2.fillStyle = grad; g2.fillRect(0, 0, 64, 64);
        const sprite = new THREE.CanvasTexture(cv);
        points = new THREE.Points(pg, new THREE.PointsMaterial({ map: sprite, color: kind === 'snow' ? 0xd6ecff : 0xc9955c, size: span / 500, sizeAttenuation: true, transparent: true,
          opacity: kind === 'snow' ? 0.8 : 0.35, depthWrite: false, blending: kind === 'snow' ? THREE.AdditiveBlending : THREE.NormalBlending }));
        scene.add(points);
      }

      const camera = new THREE.PerspectiveCamera(52, 1, 0.01, span * 12);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.minDistance = span / 60;
      controls.maxDistance = span * 1.8;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.listenToKeyEvents(window);
      controls.keyPanSpeed = span * 0.5;
      const placeCamera = () => {
        const ty = (targetH / 1000) * live.current.exag;
        controls.target.set(0, ty, 0);
        camera.position.set(span * 0.22, ty + span * (mode === 'dive' ? 0.07 : 0.14), span * 0.22);
        controls.update();
      };
      placeCamera();

      const size = () => {
        const w = el.clientWidth || 1, h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
      };
      size();
      const ro = new ResizeObserver(size);
      ro.observe(el);

      // cursor readout by raycasting the terrain
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      let want: { x: number; y: number } | null = null;
      const onMove = (e: PointerEvent) => { const r = renderer.domElement.getBoundingClientRect(); want = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) }; };
      const onLeave = () => { want = null; setCursor(null); };
      renderer.domElement.addEventListener('pointermove', onMove);
      renderer.domElement.addEventListener('pointerleave', onLeave);

      let last = performance.now(), lastEx = -1, lastCursor = 0;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        const L = live.current;
        if (L.exag !== lastEx) {
          terrain.scale.y = L.exag; lastEx = L.exag;
          marker.position.y = (targetH / 1000) * L.exag;
          base.position.y = (grid.min / 1000) * L.exag - span * 0.02;
          if (mode === 'dive') { const dash = line.geometry.attributes.position as import('three').BufferAttribute; dash.setY(1, -(targetH / 1000) * L.exag); dash.needsUpdate = true; line.computeLineDistances(); }
          controls.target.y = marker.position.y;
        }
        if (water) water.visible = L.surface;
        ring.scale.setScalar(1 + 0.08 * Math.sin(now / 300));
        if (points) {
          points.visible = L.particles;
          if (L.particles) {
            const stormy = L.storm && kind === 'dust';
            const wind = stormy ? 0.12 : 0.02;
            const half = boxSize / 2, t = controls.target;
            for (let i = 0; i < N; i++) {
              let x = pp[i * 3] + (vv[i * 3] + (kind === 'dust' ? wind : 0)) * dt * span;
              let y = pp[i * 3 + 1] + vv[i * 3 + 1] * dt * span;
              let z = pp[i * 3 + 2] + vv[i * 3 + 2] * dt * span;
              if (x > t.x + half) x -= boxSize; else if (x < t.x - half) x += boxSize;
              if (y > t.y + half) y -= boxSize; else if (y < t.y - half) y += boxSize;
              if (z > t.z + half) z -= boxSize; else if (z < t.z - half) z += boxSize;
              pp[i * 3] = x; pp[i * 3 + 1] = y; pp[i * 3 + 2] = z;
            }
            (points.geometry.attributes.position as import('three').BufferAttribute).needsUpdate = true;
            (points.material as import('three').PointsMaterial).opacity = stormy ? 0.55 : kind === 'snow' ? 0.8 : 0.35;
            (points.material as import('three').PointsMaterial).size = stormy ? span / 220 : span / 500;
          }
          if (kind === 'dust' && scene.fog instanceof THREE.Fog) {
            const f = scene.fog; const stormy = L.storm;
            f.near = span * (stormy ? 0.08 : 0.5); f.far = span * (stormy ? 0.9 : 2.2);
            f.color.set(stormy ? 0xb9733b : look.fog); (scene.background as import('three').Color).set(stormy ? 0xa8683a : look.sky);
          }
        }
        controls.update();
        if (want && now - lastCursor > 80) {
          lastCursor = now;
          ndc.set(want.x, want.y); ray.setFromCamera(ndc, camera);
          const hit = ray.intersectObject(terrain, false)[0];
          if (hit) setCursor({ h: (hit.point.y / L.exag) * 1000, km: Math.hypot(hit.point.x, hit.point.z) });
        }
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(tick);
      setState({ phase: 'ready', mode, grid, targetH });

      dispose = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        renderer.domElement.removeEventListener('pointermove', onMove);
        renderer.domElement.removeEventListener('pointerleave', onLeave);
        controls.dispose();
        scene.traverse(o => { const m = o as import('three').Mesh; m.geometry?.dispose?.(); const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; mats.forEach(mt => mt.dispose()); });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(e => { console.warn('Worlds 3D view failed:', e); if (!gone) setState({ phase: 'error', msg: (e as Error).message }); });
    return () => { gone = true; dispose(); };
  }, [body, target.lat, target.lon, target.depthM, span]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const mode = state.mode ?? (body.id === 'earth' && (target.depthM ?? 0) > 0 ? 'dive' : 'fly');
  const dusty = body.id === 'mars' || body.id === 'venus' || body.id === 'titan';
  const Icon = mode === 'dive' ? Waves : Mountain;
  return (
    <div className="absolute inset-0 z-40 bg-[#05060a] flex flex-col" role="dialog" aria-label={`3D view of ${target.label}`}>
      <div ref={box} className="absolute inset-0" />
      {state.phase !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center text-slate-300 text-[12px] pointer-events-none">
          {state.phase === 'loading' ? <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Reading the {mode === 'dive' ? 'sea floor' : 'terrain'}…</span> : <span>{state.msg ?? 'This view couldn’t be built.'}</span>}
        </div>
      )}
      {/* header */}
      <div className="relative flex items-start gap-3 px-4 pt-3 pointer-events-none">
        <Icon className={clsx('w-4 h-4 mt-1 shrink-0', mode === 'dive' ? 'text-cyan-300' : 'text-amber-300')} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-tight text-slate-100 drop-shadow">{target.label}</h3>
          <p className="text-[11.5px] text-slate-300 drop-shadow">
            {mode === 'dive' ? 'Dive view' : '3D terrain'} · {body.name}
            {state.targetH !== undefined && <> · {state.targetH < 0 ? `${fmtM(state.targetH)} below sea level` : `${fmtM(state.targetH)} elevation`}</>}
            {state.grid && <> · {span} km across, {Math.round(state.grid.stepM).toLocaleString()} m cells · vertical ×{exag}</>}
          </p>
        </div>
        <button className="pointer-events-auto p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20" title="Close (Esc)" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      {/* controls */}
      <div className="relative mt-auto px-4 pb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-200 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-black/45 backdrop-blur px-2 py-1">
          <span className="text-slate-400 mr-1">Area</span>
          {SPANS.map(s => <button key={s} onClick={() => setSpan(s)} className={clsx('px-1.5 py-0.5 rounded', s === span ? 'bg-white/20 text-white' : 'hover:bg-white/10')}>{s} km</button>)}
        </div>
        <label className="pointer-events-auto flex items-center gap-2 rounded-lg bg-black/45 backdrop-blur px-2 py-1">
          <span className="text-slate-400">Heights ×{exag}</span>
          <input type="range" min={1} max={8} step={0.5} value={exag} onChange={e => setExag(+e.target.value)} className="w-24 accent-amber-400" aria-label="Vertical exaggeration" />
        </label>
        {(mode === 'dive' || dusty) && (
          <button onClick={() => setParticles(p => !p)} className={clsx('pointer-events-auto flex items-center gap-1 rounded-lg bg-black/45 backdrop-blur px-2 py-1', particles ? 'text-white' : 'text-slate-500')} title={mode === 'dive' ? 'Marine snow' : 'Dust in the air'}>
            {mode === 'dive' ? <Snowflake className="w-3.5 h-3.5" /> : <Wind className="w-3.5 h-3.5" />} {mode === 'dive' ? 'Marine snow' : 'Dust'}
          </button>
        )}
        {mode === 'fly' && dusty && body.id === 'mars' && (
          <button onClick={() => setStorm(s => !s)} className={clsx('pointer-events-auto flex items-center gap-1 rounded-lg bg-black/45 backdrop-blur px-2 py-1', storm ? 'text-amber-300' : 'text-slate-400')} title="An impression of a regional dust storm: haze and wind-blown dust (not a forecast)">
            <Wind className="w-3.5 h-3.5" /> Dust storm
          </button>
        )}
        {mode === 'dive' && (
          <button onClick={() => setSurface(s => !s)} className={clsx('pointer-events-auto flex items-center gap-1 rounded-lg bg-black/45 backdrop-blur px-2 py-1', surface ? 'text-white' : 'text-slate-500')} title="Show the sea surface">
            <Waves className="w-3.5 h-3.5" /> Surface
          </button>
        )}
        <div className="ml-auto flex items-center gap-3 rounded-lg bg-black/45 backdrop-blur px-2 py-1 font-mono tabular-nums">
          {cursor ? <span>{cursor.h < 0 ? `−${fmtM(cursor.h)}` : `+${fmtM(cursor.h)}`} · {cursor.km.toFixed(1)} km from {target.label}</span> : <span className="text-slate-400">drag to orbit · scroll to zoom · arrows to pan</span>}
        </div>
      </div>
      <div className="absolute bottom-12 right-4 text-[10px] text-slate-400 pointer-events-none">
        {body.id === 'earth' ? 'Sea floor: GEBCO / ETOPO1 via Mapzen terrain tiles' : `Heights: ${body.terrain?.attribution ?? 'elevation tiles'}`} · coarse cells, shapes not details
      </div>
    </div>
  );
}
