import React, { useEffect, useState, useMemo } from 'react';
import clsx from 'clsx';
import {
  Radio, Play, Pause, SkipForward, Volume2, VolumeX, Mic, MicOff,
  CircleDot, Download, Sparkles, Sliders, Wand2, History, Heart,
  Disc3, Shuffle, ExternalLink, Activity
} from 'lucide-react';
import {
  dj, STYLES, STYLE_IDS, type DJState, type SongInfo, type Style, type Vibe, type CustomSongParams
} from '../dj/engine';
import { DeckView } from './DeckView';
import { MixerSection } from './MixerSection';
import { Soundboard } from './Soundboard';
import { GeneratorStudio } from './GeneratorStudio';
import { WaveformVisualizer } from './WaveformVisualizer';
import { downloadBlob } from './wavExport';

const STATIONS: { id: Vibe; label: string; hint: string; icon: string; themeColor: string }[] = [
  { id: 'auto', label: 'Auto Dynamic', hint: 'The AI DJ curates across every style, walking an energy arc', icon: '🌐', themeColor: '#ec4899' },
  { id: 'synthwave', label: 'Neon Outrun', hint: 'Pulsing bass, gated snares, 80s analog arps', icon: '🏎️', themeColor: '#f43f5e' },
  { id: 'cyberpunk', label: 'Cyberpunk 2077', hint: 'Heavy industrial bass, distorted leads, aggressive midtempo', icon: '🌆', themeColor: '#a855f7' },
  { id: 'lofi', label: 'Lofi Study Café', hint: 'Dusty swing beats, warm Rhodes, tape crackle', icon: '☕', themeColor: '#fb923c' },
  { id: 'jazzhop', label: 'Midnight Velvet', hint: '9th chords, upright bass, brushed snare shuffle', icon: '🎷', themeColor: '#f59e0b' },
  { id: 'citypop', label: 'Tokyo City Pop', hint: '80s disco octaves, funk slap bass, breezy brass', icon: '🌴', themeColor: '#06b6d4' },
  { id: 'house', label: 'Subground 8200', hint: 'Deep house four on the floor, organ stabs, offbeat groove', icon: '🎛️', themeColor: '#3b82f6' },
  { id: 'dnb', label: 'Liquid Velocity', hint: '174 BPM breaks, lush atmospheric pads, rolling sub bass', icon: '⚡', themeColor: '#10b981' },
  { id: 'chiptune', label: '8-Bit Arcade', hint: 'NES pulse waves, fast arps, crunchy chip drums', icon: '👾', themeColor: '#84cc16' },
  { id: 'ambient', label: 'Event Horizon', hint: 'Slow generative drift: glassy pads, bells, deep peace', icon: '🌌', themeColor: '#6366f1' },
  { id: 'dubtechno', label: 'Deep Dub Echo', hint: 'Tape-delayed minor chords, sub rumble, hypnotic space', icon: '🎚️', themeColor: '#14b8a6' },
  { id: 'dungeonsynth', label: 'Ancient Keep', hint: 'Medieval melodies, church organ, mystic lute plucks', icon: '🏰', themeColor: '#d97706' },
  { id: 'darkwave', label: 'Coldwave Night', hint: 'Phrygian minor, rolling bass, cold icy leads', icon: '🌑', themeColor: '#9333ea' },
  { id: 'futurefunk', label: 'Future Funk Disco', hint: 'Disco punch, slap bass octaves, French house filters', icon: '✨', themeColor: '#f43f5e' },
];

const PREF_KEY = 'shellb.dj';
interface StoredPrefs {
  volume: number;
  vibe: Vibe;
  talk: boolean;
  favs: SongInfo[];
}

function loadSavedPrefs(): StoredPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      volume: typeof raw.volume === 'number' ? raw.volume : 0.65,
      vibe: raw.vibe || 'auto',
      talk: !!raw.talk,
      favs: Array.isArray(raw.favs) ? raw.favs : [],
    };
  } catch {
    return { volume: 0.65, vibe: 'auto', talk: false, favs: [] };
  }
}

function savePrefs(p: Partial<StoredPrefs>) {
  try {
    const cur = loadSavedPrefs();
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...cur, ...p }));
  } catch { /* ignored */ }
}

const sameSong = (a: SongInfo, b: SongInfo) => a.seed === b.seed && a.style === b.style;

const parseTabFromUrl = (): 'dj' | 'sampler' | 'forge' | 'library' => {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  if (hash.includes('/sampler')) return 'sampler';
  if (hash.includes('/forge')) return 'forge';
  if (hash.includes('/library') || hash.includes('/history') || hash.includes('/saved')) return 'library';
  return 'dj';
};

export function RadioApp() {
  const [prefs, setPrefs] = useState<StoredPrefs>(loadSavedPrefs);
  const [state, setState] = useState<DJState>(dj.state);
  const [activeTab, setActiveTab] = useState<'dj' | 'sampler' | 'forge' | 'library'>(parseTabFromUrl);
  const [lastRecordedBlob, setLastRecordedBlob] = useState<Blob | null>(null);

  useEffect(() => {
    const onHash = () => {
      setActiveTab(parseTabFromUrl());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectTab = (t: 'dj' | 'sampler' | 'forge' | 'library') => {
    setActiveTab(t);
    const sub = t === 'dj' ? '' : `/${t}`;
    window.location.hash = `#/radio${sub}`;
  };

  // Sync engine state
  useEffect(() => dj.subscribe(setState), []);
  useEffect(() => {
    dj.setVolume(prefs.volume);
    dj.setVibe(prefs.vibe);
    dj.setTalk(prefs.talk);
  }, [prefs.volume, prefs.vibe, prefs.talk]);

  const updatePrefs = (patch: Partial<StoredPrefs>) => {
    setPrefs(cur => {
      const next = { ...cur, ...patch };
      savePrefs(next);
      return next;
    });
  };

  const handleStationSelect = (v: Vibe) => {
    updatePrefs({ vibe: v });
    dj.setVibe(v);
  };

  const isSaved = (s: SongInfo | null) => !!s && prefs.favs.some(f => sameSong(f, s));
  const toggleSave = (s: SongInfo) => {
    if (isSaved(s)) {
      updatePrefs({ favs: prefs.favs.filter(f => !sameSong(f, s)) });
    } else {
      if (state.song && sameSong(s, state.song)) dj.like();
      updatePrefs({ favs: [s, ...prefs.favs].slice(0, 100) });
    }
  };

  // Recording
  const handleToggleRecord = async () => {
    if (state.recording) {
      const blob = await dj.stopRecording();
      if (blob) {
        setLastRecordedBlob(blob);
        const filename = `ShellB-FM-LiveSet-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        downloadBlob(blob, filename);
      }
    } else {
      dj.startRecording();
    }
  };

  const formatSecs = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const songA = state.song;
  const songB = state.next;

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-transparent p-4 sm:p-6 text-[var(--text-primary)] font-sans select-none">
      {/* Top Station Header & Master Control Bar */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/95 backdrop-blur-md shadow-2xl shrink-0">
        {/* Station Logo & Callout */}
        <div className="flex items-center gap-3.5">
          <div className="relative">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-pink-600 via-rose-500 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-pink-500/25">
              <Radio className="w-6 h-6 animate-pulse" />
            </div>
            {state.playing && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-rose-500 border-2 border-[var(--bg-secondary)] animate-ping" />
            )}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-black tracking-wider uppercase text-[var(--text-primary)]">
                SHELL:B FM
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase tracking-wider bg-rose-500/20 text-rose-400 border border-rose-500/30">
                {state.playing ? 'ON AIR' : 'STANDBY'}
              </span>
            </div>
            <p className="text-[11px] font-mono text-[var(--text-muted)]">
              98.4 FM · Neural Procedural Radio & Live DJ Console
            </p>
          </div>
        </div>

        {/* Master Transport & Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Main Play/Pause */}
          <button
            onClick={() => dj.toggle()}
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-pink-500/30 transition hover:scale-105 active:scale-95"
            style={{ backgroundImage: 'linear-gradient(135deg, #f43f5e, #ff2e97, #fb923c)' }}
            title={state.playing ? 'Pause Radio' : 'Start Broadcast'}
          >
            {state.playing ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current translate-x-0.5" />}
          </button>

          {/* Skip Song */}
          <button
            onClick={() => dj.skip()}
            className="p-2.5 rounded-xl border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] transition"
            title="Next Track: Mix out with beatmatched transition"
          >
            <SkipForward className="w-5 h-5" />
          </button>

          {/* Master Volume */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
            <Volume2 className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={prefs.volume}
              onChange={e => updatePrefs({ volume: +e.target.value })}
              className="w-20 sm:w-28 accent-[var(--accent)] cursor-pointer"
              title={`Master Volume: ${Math.round(prefs.volume * 100)}%`}
            />
          </div>

          {/* DJ Voice Announcer Toggle */}
          <button
            onClick={() => updatePrefs({ talk: !prefs.talk })}
            className={clsx(
              'px-3 py-2 rounded-xl border text-xs font-mono font-medium flex items-center gap-1.5 transition',
              prefs.talk
                ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-soft)] shadow-sm'
                : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            )}
            title={prefs.talk ? 'DJ Voice Announcer: ON' : 'DJ Voice Announcer: OFF'}
          >
            {prefs.talk ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            <span className="hidden sm:inline">{prefs.talk ? 'Voice On' : 'Voice Off'}</span>
          </button>

          {/* Live Recording Button */}
          <button
            onClick={handleToggleRecord}
            className={clsx(
              'px-3.5 py-2 rounded-xl border text-xs font-mono font-bold flex items-center gap-2 transition shadow-sm',
              state.recording
                ? 'border-rose-500 bg-rose-500 text-white animate-pulse shadow-[0_0_15px_#f43f5e]'
                : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]'
            )}
            title={state.recording ? 'Stop Recording and Save WAV' : 'Record Live DJ Set'}
          >
            <CircleDot className="w-4 h-4" />
            <span>{state.recording ? `REC ${formatSecs(state.recordingDuration)}` : 'Record Set'}</span>
          </button>
        </div>
      </div>

      {/* Radio Station Selector Strip */}
      <div className="my-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-bold">
            Radio Channels & Subgenres
          </span>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">
            Active: {STATIONS.find(s => s.id === prefs.vibe)?.label ?? 'Auto'}
          </span>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
          {STATIONS.map(st => (
            <button
              key={st.id}
              onClick={() => handleStationSelect(st.id)}
              className={clsx(
                'group flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium whitespace-nowrap transition-all duration-200 shrink-0 shadow-sm',
                prefs.vibe === st.id
                  ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-soft)] font-bold scale-[1.02]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white'
              )}
              title={st.hint}
            >
              <span className="text-base group-hover:scale-125 transition-transform">{st.icon}</span>
              <span>{st.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Main App Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] mb-5 pb-2">
        <button
          onClick={() => selectTab('dj')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold font-mono transition',
            activeTab === 'dj'
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-md'
              : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]'
          )}
        >
          <Sliders className="w-4 h-4" />
          <span>Dual Decks & Mixer</span>
        </button>

        <button
          onClick={() => selectTab('sampler')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold font-mono transition',
            activeTab === 'sampler'
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-md'
              : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]'
          )}
        >
          <Sparkles className="w-4 h-4" />
          <span>Sampler & Voice Drops</span>
        </button>

        <button
          onClick={() => selectTab('forge')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold font-mono transition',
            activeTab === 'forge'
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-md'
              : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]'
          )}
        >
          <Wand2 className="w-4 h-4" />
          <span>Track Forge Studio</span>
        </button>

        <button
          onClick={() => selectTab('library')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold font-mono transition',
            activeTab === 'library'
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-md'
              : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]'
          )}
        >
          <History className="w-4 h-4" />
          <span>History & Saved ({prefs.favs.length})</span>
        </button>
      </div>

      {/* Main Tab Views */}
      <div className="flex-1 flex flex-col gap-6">
        {activeTab === 'dj' && (
          <>
            {/* Visualizer & Oscilloscope Banner */}
            <WaveformVisualizer active={state.playing} />

            {/* Dual Decks Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Deck A (Main / Live) */}
              <DeckView
                deckId="A"
                song={songA}
                isOnAir={true}
                isPlaying={state.playing}
                section={state.section}
                bar={state.bar}
                totalBars={state.totalBars || 32}
                bpm={state.bpm}
                otherSong={songB}
                eq={state.eq}
                onEqChange={(band, val) => dj.setDeckEq(band, val)}
                onEqKill={(band, kill) => dj.setDeckEqKill(band, kill)}
                onNudgeBpm={delta => dj.nudgeBpm(delta)}
                onSetBpm={bpm => dj.setBpm(bpm)}
                onJumpBeats={beats => dj.jumpBeats(beats)}
                onTogglePlay={() => dj.toggle()}
              />

              {/* Deck B (Incoming / Cued) */}
              <DeckView
                deckId="B"
                song={songB}
                isOnAir={false}
                isPlaying={state.playing}
                section="Ready"
                bar={0}
                totalBars={songB?.bars || 32}
                bpm={songB?.bpm}
                otherSong={songA}
                eq={state.eq}
                onEqChange={(band, val) => dj.setDeckEq(band, val)}
                onEqKill={(band, kill) => dj.setDeckEqKill(band, kill)}
                onNudgeBpm={delta => dj.nudgeBpm(delta)}
                onSetBpm={bpm => dj.setBpm(bpm)}
                onJumpBeats={beats => dj.jumpBeats(beats)}
                onTogglePlay={() => songB && dj.playSong(songB, true)}
                onMixNow={() => dj.skip()}
                onReroll={() => dj.reroll()}
              />
            </div>

            {/* Center Performance Mixer & Stems Strip */}
            <MixerSection
              stems={state.stems}
              onStemVolume={(stem, vol) => dj.setStemVolume(stem, vol)}
              onStemMute={(stem, muted) => dj.setStemMute(stem, muted)}
              onStemSolo={(stem, solo) => dj.setStemSolo(stem, solo)}
              onResetStems={() => dj.resetStems()}
              crossfader={state.crossfader}
              onCrossfaderChange={val => dj.setCrossfader(val)}
              filter={state.filter}
              onFilterChange={val => {
                dj.setFilter(val);
                dj.state.filter = val;
              }}
              bassKill={state.bassKill}
              onToggleBassKill={() => {
                const next = !state.bassKill;
                dj.setBassKill(next);
                dj.state.bassKill = next;
              }}
              onBuildUp={() => dj.buildUp()}
              onEchoThrow={() => dj.echoThrow()}
              onTapeBrake={() => dj.skip('brake')}
              onStutter={() => dj.triggerFx('stutter')}
              isPlaying={state.playing}
            />
          </>
        )}

        {activeTab === 'sampler' && (
          <div className="flex flex-col gap-5">
            <Soundboard
              onTriggerFx={kind => dj.triggerFx(kind)}
              onVoiceDrop={(phrase, voiceId, speed) => dj.voiceDrop(phrase, voiceId, speed)}
              samplerVolume={state.samplerVolume ?? 1.2}
              onSamplerVolumeChange={vol => dj.setSamplerVolume(vol)}
            />
          </div>
        )}

        {activeTab === 'forge' && (
          <GeneratorStudio
            onPlaySong={(params, now) => {
              if (now) dj.playCustom(params, true);
              else dj.playCustom(params, false);
            }}
            onSaveFav={s => toggleSave(s)}
          />
        )}

        {activeTab === 'library' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* History List */}
            <div className="flex flex-col gap-3 p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-bold">
                  Recently Broadcast Tracks
                </span>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">
                  {state.history.length} songs
                </span>
              </div>

              <div className="flex flex-col gap-1.5 max-h-[500px] overflow-y-auto pr-1">
                {state.history.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] p-4 text-center">
                    Songs you hear live on air will be logged here.
                  </p>
                )}
                {state.history.map((s, i) => (
                  <div
                    key={`${s.seed}-${s.style}-${i}`}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)] transition group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-[var(--text-primary)] truncate">
                        {s.title}
                      </div>
                      <div className="text-[10px] font-mono text-[var(--text-muted)] truncate">
                        {STYLES[s.style]?.label ?? s.style} · {s.key} {s.mode} · {s.bpm} BPM · Seed #{s.seed}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <button
                        onClick={() => toggleSave(s)}
                        className={clsx(
                          'p-1.5 rounded-lg transition',
                          isSaved(s) ? 'text-rose-500 fill-current' : 'text-[var(--text-muted)] hover:text-white'
                        )}
                        title={isSaved(s) ? 'Saved' : 'Save to Favorites'}
                      >
                        <Heart className={clsx('w-3.5 h-3.5', isSaved(s) && 'fill-current')} />
                      </button>
                      <button
                        onClick={() => dj.playSong(s, true)}
                        className="p-1.5 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--accent)] hover:text-white text-[var(--text-secondary)] transition shadow-sm"
                        title="Mix track now"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Saved Favorites */}
            <div className="flex flex-col gap-3 p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-bold">
                  Saved Favourites ({prefs.favs.length})
                </span>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">
                  Deterministic Reproducible Seeds
                </span>
              </div>

              <div className="flex flex-col gap-1.5 max-h-[500px] overflow-y-auto pr-1">
                {prefs.favs.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] p-4 text-center">
                    Heart any track while listening or creating in the Forge to save it here.
                  </p>
                )}
                {prefs.favs.map(s => (
                  <div
                    key={`${s.seed}-${s.style}`}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--accent)] transition group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-[var(--text-primary)] truncate">
                        {s.title}
                      </div>
                      <div className="text-[10px] font-mono text-[var(--text-muted)] truncate">
                        {STYLES[s.style]?.label ?? s.style} · {s.key} {s.mode} · {s.bpm} BPM · Seed #{s.seed}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <button
                        onClick={() => toggleSave(s)}
                        className="p-1.5 rounded-lg text-rose-500 hover:text-rose-400 transition"
                        title="Remove from favorites"
                      >
                        <Heart className="w-3.5 h-3.5 fill-current" />
                      </button>
                      <button
                        onClick={() => dj.playSong(s, true)}
                        className="p-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 transition shadow-sm"
                        title="Mix track now"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Live Activity Toast / DJ Note */}
      {state.note && state.playing && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-full border border-pink-500/40 bg-neutral-900/90 text-pink-300 text-xs font-mono shadow-2xl backdrop-blur-md animate-fade-in pointer-events-none">
          <Sparkles className="w-3.5 h-3.5 text-pink-400 animate-spin" />
          <span>{state.note}</span>
        </div>
      )}
    </div>
  );
}
