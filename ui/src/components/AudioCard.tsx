import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AudioWaveform, Download, Loader2, Pause, Play, Repeat, Volume2, VolumeX } from 'lucide-react';
import type { AudioInfo } from '../types';
import { fmtBytes } from '../api';

/** What we learn by reading the file itself: header fields plus loudness, stereo and tempo stats. */
interface Analysis {
  duration: number;
  sampleRate: number;
  channels: number;
  bits?: number;
  size: number;
  peaks: Float32Array[]; // per channel, BARS max-abs values
  peakDb: number;
  rmsDb: number;
  correlation?: number; // L/R, -1..1 (stereo only)
  bpm?: number;
}

const BARS = 180;
const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : '−∞');
const fmtTime = (t: number) => {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Read the RIFF/WAVE fmt chunk so we can decode at the native rate and report bit depth. */
function wavHeader(buf: ArrayBuffer): { sampleRate: number; channels: number; bits: number } | null {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57415645) return null;
  for (let p = 12; p + 8 <= buf.byteLength;) {
    const id = v.getUint32(p), len = v.getUint32(p + 4, true);
    if (id === 0x666d7420 && p + 24 <= buf.byteLength) {
      return { channels: v.getUint16(p + 10, true), sampleRate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    }
    p += 8 + len + (len & 1);
  }
  return null;
}

/** Tempo from the autocorrelation of an onset envelope; undefined when there's no clear pulse. */
function estimateBpm(mono: Float32Array, rate: number): number | undefined {
  const hop = 512, frames = Math.floor(mono.length / hop);
  if (frames < 64) return undefined;
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) e += mono[i] * mono[i];
    const le = Math.log1p(e * 1000);
    env[f] = Math.max(0, le - prev);
    prev = le;
  }
  const fps = rate / hop;
  let best = 0, bestLag = 0, sum = 0, n = 0;
  for (let lag = Math.round(fps * 60 / 180); lag <= Math.round(fps * 60 / 70); lag++) {
    let c = 0;
    for (let i = lag; i < frames; i++) c += env[i] * env[i - lag];
    sum += c; n++;
    if (c > best) { best = c; bestLag = lag; }
  }
  if (!bestLag || best < 1.25 * (sum / n)) return undefined;
  return Math.round(60 * fps / bestLag);
}

function analyse(audio: AudioBuffer, size: number, bits?: number): Analysis {
  const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const len = audio.length, per = Math.max(1, Math.floor(len / BARS));
  let peak = 0, sq = 0, lr = 0, ll = 0, rr = 0;
  const peaks = chans.map(() => new Float32Array(BARS));
  const mono = new Float32Array(len);
  for (let c = 0; c < chans.length; c++) {
    const d = chans[c], pk = peaks[c];
    for (let i = 0; i < len; i++) {
      const s = d[i], a = Math.abs(s);
      if (a > peak) peak = a;
      sq += s * s;
      mono[i] += s / chans.length;
      const b = Math.min(BARS - 1, (i / per) | 0);
      if (a > pk[b]) pk[b] = a;
    }
  }
  if (chans.length >= 2) {
    const [l, r] = chans;
    for (let i = 0; i < len; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; }
  }
  return {
    duration: audio.duration, sampleRate: audio.sampleRate, channels: chans.length, bits, size, peaks,
    peakDb: db(peak), rmsDb: db(Math.sqrt(sq / (len * chans.length || 1))),
    correlation: chans.length >= 2 && ll && rr ? lr / Math.sqrt(ll * rr) : undefined,
    bpm: estimateBpm(mono, audio.sampleRate),
  };
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Redraw when the theme or skin changes (they're classes/attributes on <html>). */
function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setTick(t => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-skin', 'style'] });
    return () => mo.disconnect();
  }, []);
  return tick;
}

export function AudioCard({ src, info }: { src: string; info?: AudioInfo }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const el = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const spec = useRef<HTMLCanvasElement>(null);
  const graph = useRef<{ ctx: AudioContext; an: AnalyserNode } | null>(null);
  const raf = useRef(0);
  const [width, setWidth] = useState(0);
  const theme = useThemeTick();

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const hdr = wavHeader(buf);
        const off = new OfflineAudioContext(1, 1, hdr?.sampleRate ?? 48000);
        const decoded = await off.decodeAudioData(buf.slice(0));
        if (!dead) setA(analyse(decoded, buf.byteLength, hdr?.bits));
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { dead = true; };
  }, [src]);

  useEffect(() => {
    const c = wave.current;
    if (!c) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const duration = a?.duration ?? el.current?.duration ?? 0;

  // Waveform: left channel above the centre line, right below; the played part is in the accent colour.
  useEffect(() => {
    const c = wave.current;
    if (!c || !width) return;
    const dpr = window.devicePixelRatio || 1, h = 72;
    c.width = Math.round(width * dpr); c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, h);
    const accent = cssVar('--accent'), rest = cssVar('--text-muted'), mid = h / 2;
    const step = width / BARS, bw = Math.max(1, step * 0.62);
    const played = duration ? time / duration : 0;
    const top = a?.peaks[0], bot = a?.peaks[1] ?? a?.peaks[0];
    for (let i = 0; i < BARS; i++) {
      const x = i * step + (step - bw) / 2;
      const up = top ? Math.max(1, top[i] * (mid - 2)) : 2 + 3 * Math.abs(Math.sin(i * 0.37));
      const dn = bot ? Math.max(1, bot[i] * (mid - 2)) : up;
      g.fillStyle = (i + 0.5) / BARS <= played ? accent : rest;
      g.globalAlpha = (i + 0.5) / BARS <= played ? 1 : a ? 0.45 : 0.2;
      g.fillRect(x, mid - up, bw, up);
      g.globalAlpha *= 0.7;
      g.fillRect(x, mid + 1, bw, dn);
    }
    g.globalAlpha = 1;
    if (hover !== null && a) {
      g.fillStyle = cssVar('--text-primary');
      g.fillRect(Math.round(hover * width), 0, 1, h);
    }
  }, [a, width, time, duration, hover, theme]);

  // Live spectrum while playing (Web Audio analyser on the <audio> element).
  const drawSpectrum = useCallback(() => {
    const c = spec.current, gr = graph.current;
    if (!c || !gr) return;
    const w = c.clientWidth, h = 28, dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = h * dpr; }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = new Uint8Array(gr.an.frequencyBinCount);
    gr.an.getByteFrequencyData(data);
    if (el.current) setTime(el.current.currentTime); // smoother playhead than timeupdate's ~4 Hz
    const bands = 48, grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, cssVar('--accent'));
    grad.addColorStop(1, cssVar('--brand-soft') || cssVar('--accent-soft'));
    g.fillStyle = grad;
    const bw = w / bands;
    for (let b = 0; b < bands; b++) {
      // log-spaced bins so bass doesn't hog the left edge
      const lo = Math.floor(Math.pow(data.length, b / bands)), hi = Math.max(lo + 1, Math.floor(Math.pow(data.length, (b + 1) / bands)));
      let m = 0;
      for (let i = lo; i < hi && i < data.length; i++) m = Math.max(m, data[i]);
      const bh = Math.max(1, (m / 255) * h);
      g.fillRect(b * bw + 1, h - bh, bw - 2, bh);
    }
    raf.current = requestAnimationFrame(drawSpectrum);
  }, []);

  useEffect(() => () => { cancelAnimationFrame(raf.current); graph.current?.ctx.close(); }, []);

  const toggle = async () => {
    const au = el.current;
    if (!au) return;
    if (!au.paused) { au.pause(); return; }
    if (!graph.current) {
      try {
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 2048; an.smoothingTimeConstant = 0.8;
        ctx.createMediaElementSource(au).connect(an);
        an.connect(ctx.destination);
        graph.current = { ctx, an };
      } catch { /* the plain <audio> still plays */ }
    }
    await graph.current?.ctx.resume();
    await au.play();
  };

  const seekFrac = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const name = src.split('/').pop() ?? 'audio.wav';
  const elapsed = info?.elapsed;
  const details = useMemo(() => {
    if (!a) return [];
    const rows: [string, string, string?][] = [
      ['Format', [a.bits ? `${a.bits}-bit` : null, `${(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)} kHz`,
        a.channels === 1 ? 'Mono' : a.channels === 2 ? 'Stereo' : `${a.channels} ch`].filter(Boolean).join(' · ')],
      ['Length', `${a.duration.toFixed(1)} s`],
      ['Size', fmtBytes(a.size)],
      ['Peak', fmtDb(a.peakDb), a.peakDb > -0.1 ? 'At or near clipping' : undefined],
      ['Loudness', `${fmtDb(a.rmsDb)} RMS`],
      ['Dynamics', Number.isFinite(a.peakDb - a.rmsDb) ? `${(a.peakDb - a.rmsDb).toFixed(1)} dB crest` : '—',
        'Peak-to-RMS ratio. Higher means punchier transients; low means heavily compressed.'],
    ];
    if (a.correlation !== undefined) {
      const c = a.correlation;
      rows.push(['Stereo', `${c > 0.97 ? 'Near-mono' : c > 0.7 ? 'Narrow' : c > 0.3 ? 'Wide' : 'Very wide'} (${c.toFixed(2)})`,
        'Left/right correlation: 1 is identical channels, 0 is unrelated, negative is out of phase.']);
    }
    if (a.bpm) rows.push(['Tempo', `≈ ${a.bpm} BPM`, 'Estimated from onset autocorrelation; may be half or double the felt tempo.']);
    if (info?.model) rows.push(['Model', info.model.replace(/^facebook\//, '')]);
    if (elapsed) rows.push(['Rendered', `${elapsed.toFixed(1)} s`, a.duration ? `${(a.duration / elapsed).toFixed(2)}× real time` : undefined]);
    return rows;
  }, [a, info?.model, elapsed]);

  return (
    <div className="my-2 w-full max-w-xl rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-3 px-3 pt-3">
        <button onClick={toggle} disabled={!!err} aria-label={playing ? 'Pause' : 'Play'}
          className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110 disabled:opacity-40 transition shadow-[0_0_0_4px_var(--accent-glow)]">
          {playing ? <Pause className="w-4 h-4" fill="currentColor" /> : <Play className="w-4 h-4 translate-x-px" fill="currentColor" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <AudioWaveform className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span className="truncate">{info?.prompt || name}</span>
          </div>
          <div className="text-[11px] font-mono text-[var(--text-muted)] flex items-center gap-2">
            <span>{fmtTime(time)} / {fmtTime(duration)}</span>
            {a?.bpm && <span>· ≈{a.bpm} BPM</span>}
            {!a && !err && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />analysing</span>}
            {err && <span className="text-red-400">couldn't analyse: {err}</span>}
          </div>
        </div>
        <div className="flex items-center gap-0.5 text-[var(--text-muted)]">
          <button onClick={() => setLoop(l => !l)} title="Loop" aria-pressed={loop}
            className={clsx('p-1.5 rounded-md hover:bg-[var(--bg-hover)]', loop && 'text-[var(--accent)]')}>
            <Repeat className="w-4 h-4" />
          </button>
          <button onClick={() => setMuted(m => !m)} title={muted ? 'Unmute' : 'Mute'} className="p-1.5 rounded-md hover:bg-[var(--bg-hover)]">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <a href={src} download={name} title={`Download ${name}`} className="p-1.5 rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <Download className="w-4 h-4" />
          </a>
        </div>
      </div>

      <div className="relative px-3 pt-2">
        <canvas ref={wave} className={clsx('w-full h-[72px] block', a && 'cursor-pointer')}
          onMouseMove={e => setHover(seekFrac(e))} onMouseLeave={() => setHover(null)}
          onClick={e => { if (el.current && duration) { el.current.currentTime = seekFrac(e) * duration; setTime(el.current.currentTime); } }} />
        {hover !== null && a && (
          <span className="pointer-events-none absolute top-1 -translate-x-1/2 px-1 rounded text-[10px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]"
            style={{ left: `calc(0.75rem + ${hover} * (100% - 1.5rem))` }}>
            {fmtTime(hover * duration)}
          </span>
        )}
        <canvas ref={spec} className={clsx('w-full block transition-opacity', playing ? 'h-7 opacity-90' : 'h-0 opacity-0')} />
      </div>

      {details.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 px-3 py-2.5 mt-1 border-t border-[var(--border-subtle)] text-[11px]">
          {details.map(([k, v, tip]) => (
            <div key={k} className="min-w-0" title={tip}>
              <dt className="text-[var(--text-muted)] uppercase tracking-wide text-[9.5px]">{k}</dt>
              <dd className={clsx('font-mono truncate', k === 'Peak' && a && a.peakDb > -0.1 && 'text-amber-600 dark:text-amber-400')}>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <audio ref={el} src={src} preload="metadata" loop={loop} muted={muted}
        onPlay={() => { setPlaying(true); cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(drawSpectrum); }}
        onPause={() => { setPlaying(false); cancelAnimationFrame(raf.current); }}
        onEnded={() => { setPlaying(false); cancelAnimationFrame(raf.current); }}
        onTimeUpdate={e => setTime(e.currentTarget.currentTime)} />
    </div>
  );
}
