/** What the app rail and the app list show about Shell:B FM, without loading the 2.6k-line engine (dj/engine.ts) with
 *  the first page: the engine publishes here whenever it plays, stops or changes song. */
export interface DJLive { playing: boolean; song: { title: string; bpm: number } | null }

let state: DJLive = { playing: false, song: null };
const listeners = new Set<(s: DJLive) => void>();

export const djLive = {
  get state() { return state; },
  publish(next: DJLive) {
    if (next.playing === state.playing && next.song?.title === state.song?.title && next.song?.bpm === state.song?.bpm) return;
    state = next;
    listeners.forEach(f => f(state));
  },
  subscribe(fn: (s: DJLive) => void) {
    listeners.add(fn);
    fn(state);
    return () => { listeners.delete(fn); };
  },
};
