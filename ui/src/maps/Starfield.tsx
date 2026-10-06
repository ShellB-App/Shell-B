// Decorative starfield behind the globe. Drawn once per resize (no animation loop), seeded so it never flickers.
import { useEffect, useRef } from 'react';

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth, h = c.clientHeight;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const r = rng(7);
      const n = Math.round((w * h) / 2600);
      for (let i = 0; i < n; i++) {
        const x = r() * w, y = r() * h, m = r() ** 3;  // most stars faint, a few bright
        const tint = r();
        ctx.fillStyle = tint < 0.12 ? '#ffd9a8' : tint < 0.3 ? '#cfe0ff' : '#ffffff';
        ctx.globalAlpha = 0.25 + m * 0.75;
        ctx.beginPath();
        ctx.arc(x, y, 0.4 + m * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden />;
}
