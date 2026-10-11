// 3D model viewer for the Worlds app (three.js, loaded on first use): NASA GLB models of spacecraft, landers and
// rovers in cards, and a full-screen lightbox. Renders only while visible; pauses when the tab is hidden.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Box, ExternalLink, Loader2, Maximize2, Pause, Play, X } from 'lucide-react';
import { fmtSize, type ModelInfo } from './models';

type Three = typeof import('three');
type Loader = import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader;
let threeP: Promise<{ THREE: Three; OrbitControls: typeof import('three/examples/jsm/controls/OrbitControls.js').OrbitControls; loader: () => Loader }> | null = null;
// NASA's GLBs are Draco-compressed: the decoder (three's own copy) is served from /vendor/draco (ui/public)
export const loadThree = () => (threeP ??= Promise.all([
  import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/controls/OrbitControls.js'),
  import('three/examples/jsm/loaders/DRACOLoader.js'),
]).then(([THREE, g, o, d]) => {
  const draco = new d.DRACOLoader().setDecoderPath('/vendor/draco/');
  return { THREE, OrbitControls: o.OrbitControls, loader: () => new g.GLTFLoader().setDRACOLoader(draco) };
}));

// ── Thumbnails: one shared renderer draws each model once to a PNG, so a gallery of fifty costs one WebGL context ──
const thumbs = new Map<string, Promise<string>>();
let thumbQueue: Promise<unknown> = Promise.resolve();
let shared: { renderer: import('three').WebGLRenderer; THREE: Three; loader: () => Loader } | null = null;

export function modelThumbnail(src: string, size = 256): Promise<string> {
  let p = thumbs.get(src);
  if (p) return p;
  p = (thumbQueue = thumbQueue.then(async () => {
    if (!shared) {
      const { THREE, loader } = await loadThree();
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      shared = { renderer, THREE, loader };
    }
    const { renderer, THREE, loader } = shared;
    renderer.setSize(size, size, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1b1d26, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4); sun.position.set(3, 4, 5); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    const gltf = await loader().loadAsync(src);
    const model = gltf.scene;
    const bb = new THREE.Box3().setFromObject(model);
    const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
    const r = Math.max(sz.x, sz.y, sz.z) || 1;
    model.position.sub(c);
    const d = r / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.2;
    camera.position.set(d * 0.7, d * 0.45, d * 0.75); camera.near = d / 100; camera.far = d * 100; camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
    scene.add(model);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    model.traverse(o => { const m = o as import('three').Mesh; m.geometry?.dispose?.(); const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; mats.forEach(mt => mt.dispose()); });
    return url;
  })) as Promise<string>;
  p.catch(() => thumbs.delete(src));
  thumbs.set(src, p);
  return p;
}

/** A still picture of a model (rendered once, shared context); for galleries and lists. */
export function ModelThumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null); setFailed(false);
    modelThumbnail(src).then(u => { if (alive) setUrl(u); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [src]);
  return (
    <div className={clsx('relative grid place-items-center', className)}>
      {url ? <img src={url} alt={alt} className="w-full h-full object-contain" draggable={false} />
        : failed ? <Box className="w-6 h-6 text-slate-600" /> : <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
    </div>
  );
}

export function ModelViewer({ src, alt, autoRotate = true, className, interactive = true, onError }: {
  src: string; alt: string; autoRotate?: boolean; className?: string; interactive?: boolean; onError?: (e: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [spin, setSpin] = useState(autoRotate);
  const spinRef = useRef(spin);
  spinRef.current = spin;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false, raf = 0, visible = true;
    let dispose = () => {};
    setState('loading');
    (async () => {
      const { THREE, loader, OrbitControls } = await loadThree();
      if (gone) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      el.appendChild(renderer.domElement);
      renderer.domElement.style.display = 'block';
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1b1d26, 1.6));
      const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
      sun.position.set(3, 4, 5);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0x9fb8ff, 0.8);
      fill.position.set(-4, -1, -3);
      scene.add(fill);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.enabled = interactive;
      controls.autoRotateSpeed = 1.2;

      const size = () => {
        const w = el.clientWidth || 1, h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      size();
      const ro = new ResizeObserver(size);
      ro.observe(el);
      const io = new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); }, { threshold: 0.05 });
      io.observe(el);

      let model: import('three').Object3D | null = null;
      try {
        const gltf = await loader().loadAsync(src);
        if (gone) return;
        model = gltf.scene;
        // centre the model and frame it so its longest side fills the view
        const bb = new THREE.Box3().setFromObject(model);
        const c = bb.getCenter(new THREE.Vector3());
        const s = bb.getSize(new THREE.Vector3());
        const r = Math.max(s.x, s.y, s.z) || 1;
        model.position.sub(c);
        const d = r / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
        camera.position.set(d * 0.7, d * 0.45, d * 0.75);
        camera.near = d / 100; camera.far = d * 100;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.minDistance = d * 0.3; controls.maxDistance = d * 4;
        controls.update();
        scene.add(model);
        setState('ready');
      } catch (e) {
        console.warn('Worlds model failed:', src, e);
        if (!gone) { setState('error'); onError?.((e as Error).message); }
        return;
      }
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (!visible || document.hidden) return;
        controls.autoRotate = spinRef.current;
        controls.update();
        renderer.render(scene, camera);
      };
      tick();
      dispose = () => {
        cancelAnimationFrame(raf);
        ro.disconnect(); io.disconnect();
        controls.dispose();
        model?.traverse(o => {
          const m = o as import('three').Mesh;
          m.geometry?.dispose?.();
          const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
          mats.forEach(mt => { Object.values(mt).forEach(v => { if (v && typeof v === 'object' && 'isTexture' in (v as object)) (v as import('three').Texture).dispose(); }); mt.dispose(); });
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(e => { console.warn('Worlds model viewer failed:', src, e); if (!gone) { setState('error'); onError?.((e as Error).message); } });
    return () => { gone = true; dispose(); };
  }, [src, interactive]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={clsx('overflow-hidden', !/\babsolute\b/.test(className ?? '') && 'relative', className)} role="img" aria-label={alt}>
      <div ref={box} className="absolute inset-0" />
      {state === 'loading' && <div className="absolute inset-0 grid place-items-center text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /></div>}
      {state === 'error' && <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--text-muted)] p-3 text-center">This model couldn’t be loaded.</div>}
      {state === 'ready' && interactive && (
        <button onClick={() => setSpin(s => !s)} className="absolute bottom-1.5 left-1.5 p-1 rounded bg-black/50 text-white/90 hover:bg-black/70" title={spin ? 'Stop turning' : 'Turn'}>
          {spin ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </button>
      )}
    </div>
  );
}

/** A model in a card: small viewer, name, real size, credit, and a way to open it big. */
export function ModelStrip({ model, onOpen }: { model: ModelInfo; onOpen: (m: ModelInfo) => void }) {
  return (
    <figure className="rounded-md border border-[var(--border-subtle)] overflow-hidden bg-gradient-to-b from-[#0b0d14] to-[#141826]">
      <div className="relative h-40">
        <ModelViewer src={model.url} alt={model.name} className="absolute inset-0" />
        <button onClick={() => onOpen(model)} className="absolute top-1.5 right-1.5 p-1 rounded bg-black/50 text-white/90 hover:bg-black/70" title="View larger"><Maximize2 className="w-3.5 h-3.5" /></button>
      </div>
      <figcaption className="px-2.5 py-1.5 text-[10.5px] leading-snug text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">{model.name}</span>
        {model.size_m && <span className="text-[var(--text-muted)]"> · about {fmtSize(model.size_m)} across</span>}
        <span className="block text-[var(--text-muted)] truncate">3D model: {model.credit}</span>
      </figcaption>
    </figure>
  );
}

/** Full-screen model over the map, with its story and source. */
export function ModelLightbox({ model, onClose }: { model: ModelInfo; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-50 bg-[#06070c]/95 flex flex-col" role="dialog" aria-label={model.name}>
      <div className="flex items-start gap-3 px-4 pt-3">
        <Box className="w-4 h-4 mt-1 text-sky-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-tight text-slate-100">{model.name}</h3>
          <p className="text-[12px] text-slate-300 leading-snug max-w-2xl">{model.description}</p>
        </div>
        <button className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20" title="Close" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <ModelViewer src={model.url} alt={model.name} className="flex-1 min-h-0" />
      <div className="px-4 pb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {model.size_m && <span>Real size: about {fmtSize(model.size_m)}</span>}
        <span>Credit: {model.credit}</span>
        <span className="truncate max-w-md" title={model.license}>{model.license.split(';')[0]}</span>
        <a href={model.source} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-sky-400 hover:underline"><ExternalLink className="w-3 h-3" /> NASA 3D Resources</a>
        <span className="text-slate-500">Drag to turn · scroll to zoom</span>
      </div>
    </div>
  );
}
