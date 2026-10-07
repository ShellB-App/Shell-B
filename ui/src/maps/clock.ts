// The Worlds app's one clock, shared by the orrery, the map (satellites, day/night, sky view, distances) and cards.
// Live by default; can be paused, set to a date, or played forwards/backwards at a chosen rate.
// Module state, so it survives switching between the orrery and a map within the session; a reload starts live.
import { useEffect, useState, useSyncExternalStore } from 'react';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Simulated ms per real second for each rate step. */
export const RATES = [1000, MIN, 10 * MIN, HOUR, DAY, 7 * DAY, 30 * DAY, 365.25 * DAY];
export const RATE_LABEL = ['real time', '1 minute', '10 minutes', '1 hour', '1 day', '1 week', '1 month', '1 year'];

export interface ClockState {
  live: boolean;
  /** signed 1-based index into RATES; 0 = paused (or live) */
  rate: number;
  /** simulated time at `wall` */
  at: number;
  /** performance.now() when `at` was set */
  wall: number;
}

let state: ClockState = { live: true, rate: 0, at: Date.now(), wall: performance.now() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const set = (s: ClockState) => { state = s; emit(); };

/** Simulated time right now (ms since the epoch). Cheap; call it from render loops. */
export function clockNow(): number {
  if (state.live) return Date.now();
  if (!state.rate) return state.at;
  return state.at + ((performance.now() - state.wall) / 1000) * Math.sign(state.rate) * RATES[Math.abs(state.rate) - 1];
}

/** Simulated ms per real ms (0 when paused, 1 when live). */
export function clockSpeed(): number {
  if (state.live) return 1;
  return state.rate ? (Math.sign(state.rate) * RATES[Math.abs(state.rate) - 1]) / 1000 : 0;
}

export const clockState = () => state;
export function subscribeClock(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function goLive() { set({ live: true, rate: 0, at: Date.now(), wall: performance.now() }); }
export function setClock(ms: number) { set({ live: false, rate: 0, at: ms, wall: performance.now() }); }
export function setRate(rate: number) {
  const r = Math.max(-RATES.length, Math.min(RATES.length, Math.round(rate)));
  set({ live: false, rate: r, at: clockNow(), wall: performance.now() });
}
/** Faster forwards (dir 1) or backwards (dir -1); stepping through zero pauses. */
export function nudgeRate(dir: 1 | -1) {
  const r = state.live ? 0 : state.rate;
  if (r === 0) return setRate(dir);
  if (Math.sign(r) === dir) return setRate(r + dir);
  setRate(Math.abs(r) === 1 ? 0 : r + dir);
}
export function togglePlay(defaultRate: number) { setRate(!state.live && state.rate ? 0 : defaultRate); }

export const useClockState = () => useSyncExternalStore(subscribeClock, clockState);

/**
 * The simulated time, re-rendering the component as it moves: every animation frame while playing,
 * every `liveMs` while live, never while paused.
 */
export function useClockTime(liveMs = 30_000): number {
  const s = useClockState();
  const [t, setT] = useState(clockNow);
  useEffect(() => {
    setT(clockNow());
    if (s.live) {
      const id = setInterval(() => setT(clockNow()), liveMs);
      return () => clearInterval(id);
    }
    if (!s.rate) return;
    let raf = 0;
    const step = () => { setT(clockNow()); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [s, liveMs]);
  return t;
}

export const fmtClock = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
