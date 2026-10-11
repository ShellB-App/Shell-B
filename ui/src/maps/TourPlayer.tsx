// Guided tours: a sequence of stops Atlas (or a chat card) hands over. Flies stop to stop, shows the narration,
// and can read it aloud with the house voice (/api/tts). Play/pause, step, and a progress bar.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Pause, Play, Route, Volume2, VolumeX, X } from 'lucide-react';
import { api } from '../api';
import type { TourStop } from './core';

export interface TourFlight { lat: number; lon: number; zoom?: number; pitch?: number; bearing?: number; body?: string }

export function TourPlayer({ title, stops, onFly, onClose, speakDefault = false }: {
  title?: string; stops: TourStop[]; onFly: (t: TourFlight, durationMs: number) => void; onClose: () => void; speakDefault?: boolean;
}) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speak, setSpeak] = useState(speakDefault);
  const [progress, setProgress] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = stops[Math.min(i, stops.length - 1)];
  const FLY_MS = 2600;

  const stopAudio = () => { audio.current?.pause(); audio.current = null; };

  // Arriving at a stop: fly, narrate, wait, move on
  useEffect(() => {
    if (!stop) return;
    onFly({ lat: stop.lat, lon: stop.lon, zoom: stop.zoom ?? 9, pitch: stop.pitch, bearing: stop.bearing, body: stop.body }, FLY_MS);
    stopAudio();
    let gone = false;
    const dwell = (stop.seconds ?? Math.max(8, Math.min(40, 4 + (stop.text?.length ?? 0) / 14))) * 1000;
    const started = performance.now();
    let raf = 0;
    const tick = () => { if (gone) return; setProgress(Math.min(1, (performance.now() - started) / (FLY_MS + dwell))); raf = requestAnimationFrame(tick); };
    if (playing) raf = requestAnimationFrame(tick); else setProgress(0);
    const next = () => { if (!gone && playing) { if (i < stops.length - 1) setI(i + 1); else setPlaying(false); } };
    if (speak && stop.text && playing) {
      api.tts(`${stop.title}. ${stop.text}`).then(blob => {
        if (gone) return;
        const a = new Audio(URL.createObjectURL(blob as Blob));
        audio.current = a;
        a.onended = () => { if (!gone) timer.current = setTimeout(next, 1500); };
        a.play().catch(() => { timer.current = setTimeout(next, FLY_MS + dwell); });
      }).catch(() => { if (!gone) timer.current = setTimeout(next, FLY_MS + dwell); });
    } else if (playing) {
      timer.current = setTimeout(next, FLY_MS + dwell);
    }
    return () => { gone = true; cancelAnimationFrame(raf); if (timer.current) clearTimeout(timer.current); stopAudio(); };
  }, [i, playing, speak]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopAudio(), []);

  if (!stop) return null;
  return (
    <div className="pointer-events-auto w-[26rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--border-subtle)] sb-map-glass shadow-2xl text-[12px] overflow-hidden">
      <div className="h-1 bg-[var(--bg-tertiary)]"><div className="h-full bg-[var(--accent)] transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <div className="p-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          <Route className="w-3.5 h-3.5 text-amber-400" />
          <span className="truncate">{title ?? 'Tour'}</span>
          <span className="ml-auto tabular-nums">{i + 1} / {stops.length}</span>
          <button onClick={onClose} className="p-0.5 rounded hover:text-[var(--text-primary)]" title="End tour"><X className="w-3.5 h-3.5" /></button>
        </div>
        <h3 className="mt-1 text-[14px] font-semibold tracking-tight text-[var(--text-primary)]">{stop.title}</h3>
        {stop.text && <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)] max-h-28 overflow-y-auto">{stop.text}</p>}
        <div className="mt-2.5 flex items-center gap-1">
          <button onClick={() => { setI(Math.max(0, i - 1)); }} disabled={i === 0} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40" title="Previous stop"><ChevronLeft className="w-4 h-4" /></button>
          <button onClick={() => setPlaying(p => !p)} className="p-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-fg)]" title={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}</button>
          <button onClick={() => { if (i < stops.length - 1) setI(i + 1); }} disabled={i >= stops.length - 1} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40" title="Next stop"><ChevronRight className="w-4 h-4" /></button>
          <button onClick={() => setSpeak(s => !s)} className={clsx('ml-1 p-1.5 rounded-md hover:bg-[var(--bg-tertiary)]', speak ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} title={speak ? 'Stop reading aloud' : 'Read aloud'}>
            {speak ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
          <div className="ml-auto flex items-center gap-1">
            {stops.map((s, k) => (
              <button key={k} onClick={() => setI(k)} title={s.title} className={clsx('w-1.5 h-1.5 rounded-full transition', k === i ? 'bg-[var(--accent)] scale-125' : k < i ? 'bg-[var(--text-muted)]' : 'bg-[var(--bg-tertiary)] ring-1 ring-inset ring-[var(--border-subtle)]')} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
