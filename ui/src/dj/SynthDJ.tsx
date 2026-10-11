import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Disc3, Heart, History, Mic, MicOff, Minus, OctagonPause, Pause, Play, Radio, Shuffle, SkipForward, Sparkles, TrendingUp, Volume2, VolumeX, Waves,
} from 'lucide-react';
import clsx from 'clsx';
import { dj, STYLES, STYLE_IDS, type DJState, type SongInfo, type Style, type TransitionKind, type Vibe } from './engine';
import { Visualizer } from './Visualizer';
import { useFormFactor } from '../formFactor';
import { t as tx } from '../i18n';

// Shell:B FM: a floating mini player for the procedural DJ. Mounted once beside <App/> so the music
// keeps going across chat, Studio, Code and every other view. The command palette drives it through
// the `shellb:dj` window event (detail: 'toggle' | 'skip' | 'open' | 'build').

const PREF = 'shellb.dj';
type Prefs = { volume: number; vibe: Vibe; playing: boolean; talk: boolean; weights: Partial<Record<Style, number>>; favs: SongInfo[] };
const DEFAULTS: Prefs = { volume: 0.6, vibe: 'auto', playing: false, talk: false, weights: {}, favs: [] };
const LEGACY: Record<string, Vibe> = { chill: 'lofi', mix: 'auto', drive: 'synthwave' };
function loadPrefs(): Prefs {
  try {
    const p: Prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF) || '{}') };
    p.vibe = LEGACY[p.vibe] ?? (p.vibe === 'auto' || p.vibe in STYLES ? p.vibe : 'auto');
    if (!Array.isArray(p.favs)) p.favs = [];
    return p;
  } catch { return DEFAULTS; }
}
function savePrefs(p: Partial<Prefs>) {
  try { localStorage.setItem(PREF, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* private mode */ }
}

const STATIONS: { id: Vibe; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'The DJ curates a set across every style, following an energy arc and your likes' },
  ...STYLE_IDS.map(id => ({ id, label: STYLES[id].short, hint: STYLES[id].hint })),
];
const VIA: Record<TransitionKind, string> = { blend: 'beatmatched blend', echo: 'echo out', filter: 'filter sweep', brake: 'tape brake' };
const same = (a: SongInfo, b: SongInfo) => a.seed === b.seed && a.style === b.style;
const canTalk = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function SynthDJ() {
  // hydrate the learned taste before the first render so the save effect below never writes defaults over it
  const [prefs, setPrefs] = useState(() => { const p = loadPrefs(); dj.setWeights(p.weights); return p; });
  const [st, setSt] = useState<DJState>(dj.state);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(prefs.playing); // was playing last visit: resume on the first click
  const [filter, setFilter] = useState(0);
  const [kill, setKill] = useState(false);
  const [tab, setTab] = useState<'history' | 'saved'>('history');
  const [isRadioRoute, setIsRadioRoute] = useState(() => typeof window !== 'undefined' && /^#\/(radio|dj|fm)\b/.test(window.location.hash));
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onHash = () => setIsRadioRoute(/^#\/(radio|dj|fm)\b/.test(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => dj.subscribe(setSt), []);
  useEffect(() => { dj.setVolume(prefs.volume); dj.setVibe(prefs.vibe); dj.setTalk(prefs.talk); }, [prefs.volume, prefs.vibe, prefs.talk]);
  useEffect(() => { savePrefs({ weights: st.weights }); }, [st.weights]);

  // browsers only start audio after a gesture, so a remembered "playing" waits for the next click
  useEffect(() => {
    if (typeof window !== 'undefined' && /[?&]play=1/.test(window.location.search)) {
      setArmed(false);
      dj.play().catch(() => {});
      return;
    }
    if (!armed) return;
    const go = () => { setArmed(false); dj.play(); };
    addEventListener('pointerdown', go, { once: true, capture: true });
    return () => removeEventListener('pointerdown', go, { capture: true });
  }, [armed]);

  useEffect(() => {
    if (st.playing !== prefs.playing) { savePrefs({ playing: st.playing }); setPrefs(p => ({ ...p, playing: st.playing })); }
    document.documentElement.classList.toggle('dj-live', st.playing);
  }, [st.playing, prefs.playing]);

  useEffect(() => {
    const on = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      setArmed(false);
      if (what === 'skip') dj.skip();
      else if (what === 'open') setOpen(true);
      else if (what === 'build') dj.buildUp();
      else dj.toggle();
    };
    addEventListener('shellb:dj', on);
    return () => removeEventListener('shellb:dj', on);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (card.current && !card.current.contains(e.target as Node)) setOpen(false); };
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [open]);

  const update = (p: Partial<Prefs>) => { setPrefs(x => ({ ...x, ...p })); savePrefs(p); };
  const song = st.song;
  const progress = song ? Math.min(1, (st.bar + 1) / song.bars) : 0;
  const saved = (s: SongInfo | null) => !!s && prefs.favs.some(f => same(f, s));
  const toggleFav = (s: SongInfo) => {
    if (saved(s)) return update({ favs: prefs.favs.filter(f => !same(f, s)) });
    if (song && same(s, song)) dj.like(); // a like also teaches Auto more of this style
    update({ favs: [s, ...prefs.favs].slice(0, 60) });
  };
  const moveFilter = (x: number) => { const v = Math.abs(x) < 0.04 ? 0 : x; setFilter(v); dj.setFilter(v); };
  const tasteTuned = Object.values(st.weights).some(w => Math.abs(w - 1) > 0.01);
  const list = tab === 'history' ? st.history.slice(1) : prefs.favs;
  const live = st.playing;
  const formFactor = useFormFactor();

  const pad = 'flex-1 flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-lg border transition disabled:opacity-40';
  const padIdle = 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]';

  return (
    <>
      {createPortal(<Visualizer active={st.playing} />, document.body)}
      {/* phones have their own radio bar (MobileRadioBar); this floating button sat on top of the bottom tab bar */}
      {!isRadioRoute && formFactor !== 'mobile' && (
        <div ref={card} className="fixed bottom-3 right-3 z-30 flex flex-col items-end gap-2 pointer-events-none">
          {open && (
          <div className="pointer-events-auto w-[21rem] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-secondary)]/95 backdrop-blur-md shadow-2xl p-3.5 animate-fade-in">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-[10px] font-mono tracking-[0.2em] uppercase text-[var(--text-muted)]">{tx('Shell:B FM')}</span>
              <span className={clsx('w-1.5 h-1.5 rounded-full', st.playing ? 'bg-rose-400 animate-pulse' : 'bg-[var(--text-muted)]')} />
              <span className="text-[10px] text-[var(--text-muted)]">{st.playing ? tx('on air') : armed ? tx('resumes on click') : tx('off air')}</span>
              <div className="ml-auto flex items-center gap-0.5">
                {canTalk && (
                  <button onClick={() => update({ talk: !prefs.talk })} title={prefs.talk ? tx('DJ voice on: announces each song') : tx('DJ voice off')}
                    className={clsx('p-1 rounded-md hover:bg-[var(--bg-hover)]', prefs.talk ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')}>
                    {prefs.talk ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                  </button>
                )}
                <button onClick={() => { setOpen(false); location.hash = '#/radio'; }} title={tx('Open full Radio / DJ Station')}
                  className="p-1 rounded-md text-[var(--text-muted)] hover:text-[#ff2e97] hover:bg-[var(--bg-hover)]">
                  <Radio className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setOpen(false)} title={tx('Minimize')} className="p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">
                  <Minus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-start gap-2 min-h-[44px]">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--text-primary)] truncate" title={song?.title}>{song?.title ?? tx('Press play: the DJ writes a new song')}</div>
                <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 font-mono truncate">
                  {song ? tx('{label} · {key} {mode} · {bpm} BPM · {section}', { label: STYLES[song.style].label, key: song.key, mode: song.mode, bpm: song.bpm, section: st.section }) : tx('Nine styles, mixed live, never the same twice')}
                </div>
              </div>
              {song && (
                <button onClick={() => toggleFav(song)} title={saved(song) ? tx('Remove from saved') : tx('Save this song (and hear more like it)')}
                  className={clsx('p-1.5 rounded-full hover:bg-[var(--bg-hover)] shrink-0', saved(song) ? 'text-rose-400' : 'text-[var(--text-muted)]')}>
                  <Heart className={clsx('w-4 h-4', saved(song) && 'fill-current')} />
                </button>
              )}
            </div>
            {st.note && live && (
              <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--accent)] truncate" title={tx(st.note)}>
                <Sparkles className="w-3 h-3 shrink-0" /><span className="truncate">{tx(st.note)}</span>
              </div>
            )}
            <div className="h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden my-2.5">
              <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${progress * 100}%`, backgroundImage: 'linear-gradient(90deg,#a855f7,#ff2e97,#ff7a3d)' }} />
            </div>

            <div className="flex items-center gap-2">
              <button onClick={() => { setArmed(false); dj.toggle(); }} title={st.playing ? tx('Pause') : tx('Play')}
                className="w-9 h-9 rounded-full flex items-center justify-center text-white shadow-lg" style={{ backgroundImage: 'linear-gradient(135deg,#ff2e97,#ff7a3d)' }}>
                {st.playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-[1px]" />}
              </button>
              <button onClick={() => { setArmed(false); dj.skip(); }} title={tx('Next song: the DJ mixes out with an echo, brake or filter sweep')}
                className="p-2 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                <SkipForward className="w-4 h-4" />
              </button>
              <Volume2 className="w-3.5 h-3.5 ml-1 text-[var(--text-muted)] shrink-0" />
              <input type="range" min={0} max={1} step={0.01} value={prefs.volume} aria-label={tx('Volume')}
                onChange={e => update({ volume: +e.target.value })} className="flex-1 min-w-0 accent-[var(--accent)]" />
            </div>

            {/* live DJ controls */}
            <div className="mt-3 rounded-xl border border-[var(--border-subtle)] p-2.5">
              <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--text-muted)]">
                <span className={clsx(filter < 0 && 'text-[var(--accent)]')}>LP</span>
                <input type="range" min={-1} max={1} step={0.01} value={filter} aria-label={tx('DJ filter (low-pass left, high-pass right)')} disabled={!live}
                  title={tx('DJ filter: left for low-pass, right for high-pass. Double-click to reset.')}
                  onChange={e => moveFilter(+e.target.value)} onDoubleClick={() => moveFilter(0)} className="flex-1 min-w-0 accent-[var(--accent)]" />
                <span className={clsx(filter > 0 && 'text-[var(--accent)]')}>HP</span>
              </div>
              <div className="flex gap-1 mt-2">
                <button disabled={!live} onClick={() => dj.buildUp()} title={tx('Two-bar build: riser, snare roll, high-pass sweep, then a drop')} className={clsx(pad, padIdle)}>
                  <TrendingUp className="w-3 h-3" />{tx('Build')}
                </button>
                <button disabled={!live} onClick={() => dj.echoThrow()} title={tx('Throw the mix into the delay for a beat')} className={clsx(pad, padIdle)}>
                  <Waves className="w-3 h-3" />{tx('Echo')}
                </button>
                <button disabled={!live} onClick={() => { setKill(k => !k); dj.setBassKill(!kill); }} title={tx('Cut the low end until you press again')}
                  className={clsx(pad, kill ? 'border-rose-400/60 text-rose-300 bg-rose-500/10' : padIdle)}>
                  <VolumeX className="w-3 h-3" />{tx('Bass')}
                </button>
                <button disabled={!live} onClick={() => dj.skip('brake')} title={tx('Tape-stop the song and drop into the next one')} className={clsx(pad, padIdle)}>
                  <OctagonPause className="w-3 h-3" />{tx('Brake')}
                </button>
              </div>
            </div>

            {st.next && (
              <div className="flex items-center gap-2 mt-3 text-[11px]">
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] shrink-0">{tx('Up next')}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[var(--text-primary)]" title={tx(st.next.title)}>{tx(st.next.title)}</div>
                  <div className="truncate text-[var(--text-muted)] font-mono text-[10px]">
                    {STYLES[st.next.style].label} · {st.next.bpm} BPM{st.nextVia ? ` · ${VIA[st.nextVia]}` : ''}
                  </div>
                </div>
                <button onClick={() => dj.reroll()} title={tx('Let the DJ pick something else')} className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] shrink-0">
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="grid grid-cols-5 gap-1 mt-3">
              {STATIONS.map(v => (
                <button key={v.id} title={tx('{hint}. Takes over from the next song (skip to go now).', { hint: v.hint })} onClick={() => update({ vibe: v.id })}
                  className={clsx('text-[11px] py-1 rounded-lg border transition truncate px-1',
                    prefs.vibe === v.id ? 'border-[var(--accent)]/60 bg-[var(--accent-glow)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
                  {tx(v.label)}
                </button>
              ))}
            </div>
            {prefs.vibe === 'auto' && tasteTuned && (
              <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
                {tx('Auto is tuned by your likes and skips.')}{' '}
                <button className="underline hover:text-[var(--text-secondary)]" onClick={() => dj.setWeights(Object.fromEntries(STYLE_IDS.map(s => [s, 1])))}>{tx('Reset')}</button>
              </div>
            )}

            <div className="flex items-center gap-3 mt-3 border-t border-[var(--border-subtle)] pt-2">
              {(['history', 'saved'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={clsx('flex items-center gap-1 text-[11px]', tab === t ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]')}>
                  {t === 'history' ? <History className="w-3 h-3" /> : <Heart className="w-3 h-3" />}
                  {t === 'history' ? tx('Played') : tx('Saved{v0}', { v0: prefs.favs.length ? ` (${prefs.favs.length})` : '' })}
                </button>
              ))}
            </div>
            <div className="mt-1.5 max-h-36 overflow-y-auto -mx-1">
              {list.length === 0 && (
                <div className="text-[11px] text-[var(--text-muted)] px-1 py-1.5">
                  {tab === 'history' ? tx('Songs you hear show up here.') : tx('Tap the heart to keep a song. Every song is a seed, so it plays back exactly.')}
                </div>
              )}
              {list.map(s => (
                <div key={`${s.style}-${s.seed}`} className="group flex items-center gap-1.5 px-1 py-1 rounded-md hover:bg-[var(--bg-hover)]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-[var(--text-primary)] truncate">{tx(s.title)}</div>
                    <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{STYLES[s.style].label} · {s.key} {s.mode} · {s.bpm}</div>
                  </div>
                  <button onClick={() => toggleFav(s)} title={saved(s) ? tx('Remove from saved') : tx('Save')}
                    className={clsx('p-1 rounded', saved(s) ? 'text-rose-400' : 'text-[var(--text-muted)] opacity-0 group-hover:opacity-100')}>
                    <Heart className={clsx('w-3 h-3', saved(s) && 'fill-current')} />
                  </button>
                  <button onClick={() => { setArmed(false); dj.playSong(s); }} title={tx('Mix into this song now')}
                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                    <Play className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <button onClick={() => setOpen(o => !o)} title={song && st.playing ? tx('Shell:B FM: {title} ({label})', { title: song.title, label: STYLES[song.style].label }) : tx('Shell:B FM (AI DJ)')}
          className={clsx('pointer-events-auto w-9 h-9 rounded-full flex items-center justify-center border transition',
            st.playing ? 'border-[var(--neon-pink,#ff2e97)]/60 text-[var(--neon-pink,#ff2e97)] bg-[var(--bg-secondary)] shadow-[0_0_18px_rgba(255,46,151,0.35)]'
              : 'border-[var(--border-subtle)] text-[var(--text-muted)] bg-[var(--bg-secondary)]/80 opacity-60 hover:opacity-100')}>
          <Disc3 className={clsx('w-[18px] h-[18px]', st.playing && 'animate-[spin_3s_linear_infinite]')} />
        </button>
      </div>
      )}
    </>
  );
}
