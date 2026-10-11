import React, { useState, useMemo, useRef } from 'react';
import clsx from 'clsx';
import {
  Wand2, Dices, Play, Plus, Download, Sparkles, Heart,
  Sliders, Music, Radio, Volume2, Timer
} from 'lucide-react';
import {
  STYLES, STYLE_IDS, dj,
  type Style, type Form, type Groove, type BassTone, type CustomSongParams, type SongInfo
} from '../dj/engine';
import { getCamelotCode } from './camelot';
import { t } from '../i18n';

interface GeneratorStudioProps {
  onPlaySong: (params: CustomSongParams, now?: boolean) => void;
  onSaveFav?: (song: SongInfo) => void;
  onExportWav?: (params: CustomSongParams) => void;
}

const TONIC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const MODES = [
  { id: 'minor', label: 'Natural Minor' },
  { id: 'dorian', label: 'Dorian' },
  { id: 'major', label: 'Major' },
  { id: 'mixolydian', label: 'Mixolydian' },
  { id: 'lydian', label: 'Lydian' },
  { id: 'phrygian', label: 'Phrygian' },
  { id: 'harmonic', label: 'Harmonic Minor' },
];

const GROOVES: { id: Groove; label: string }[] = [
  { id: 'four', label: 'Four on the Floor' },
  { id: 'house', label: 'House 909' },
  { id: 'boombap', label: 'Boom-Bap' },
  { id: 'half', label: 'Half-Time' },
  { id: 'dnb', label: 'Liquid Breaks' },
  { id: 'shuffle', label: 'Shuffle Swing' },
  { id: 'chip', label: '8-Bit Chip' },
  { id: 'sparse', label: 'Sparse / Drift' },
];

const BASS_TONES: { id: BassTone; label: string }[] = [
  { id: 'round', label: 'Round Analog' },
  { id: 'saw', label: 'Saw Reese' },
  { id: 'upright', label: 'Acoustic Upright' },
  { id: 'deep', label: 'Deep FM' },
  { id: 'sub', label: 'Sub 808' },
  { id: 'chip', label: '8-Bit Triangle' },
  { id: 'slap', label: 'Slap Funk' },
];

const FORMS: { id: Form; label: string }[] = [
  { id: 'classic', label: 'Classic (Verse-Hook-Break)' },
  { id: 'club', label: 'Extended Club (DJ Friendly)' },
  { id: 'song', label: 'Pop Song Structure' },
  { id: 'loop', label: 'Short Groove Loop' },
  { id: 'ambient', label: 'Ambient Drift' },
];

export function GeneratorStudio({ onPlaySong, onSaveFav, onExportWav }: GeneratorStudioProps) {
  const [style, setStyle] = useState<Style>('synthwave');
  const [tonic, setTonic] = useState<number>(0); // C
  const [mode, setMode] = useState<string>('minor');
  const [bpm, setBpm] = useState<number>(110);
  const [lofi, setLofi] = useState<number>(0.15);
  const [groove, setGroove] = useState<Groove>('four');
  const [bassTone, setBassTone] = useState<BassTone>('saw');
  const [form, setForm] = useState<Form>('classic');
  const [seed, setSeed] = useState<number>(() => Math.floor(Math.random() * 1000000));
  const [customTitle, setCustomTitle] = useState<string>('');

  // Tap tempo state
  const tapTimes = useRef<number[]>([]);
  const handleTapTempo = () => {
    const now = Date.now();
    tapTimes.current.push(now);
    if (tapTimes.current.length > 5) tapTimes.current.shift();
    if (tapTimes.current.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < tapTimes.current.length; i++) {
        intervals.push(tapTimes.current[i] - tapTimes.current[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avgInterval > 250 && avgInterval < 1500) {
        const calculatedBpm = Math.round(60000 / avgInterval);
        setBpm(Math.max(60, Math.min(185, calculatedBpm)));
      }
    }
  };

  const handleRollSeed = () => {
    setSeed(Math.floor(Math.random() * 10000000));
  };

  // Preview generated song metadata
  const previewSong = useMemo(() => {
    const params: CustomSongParams = {
      title: customTitle || undefined,
      style,
      tonic,
      mode,
      bpm,
      lofi,
      groove,
      bassTone,
      form,
      seed,
    };
    return dj.composeCustom(params);
  }, [style, tonic, mode, bpm, lofi, groove, bassTone, form, seed, customTitle]);

  const camelot = useMemo(() => {
    return getCamelotCode(previewSong.tonic, previewSong.mode);
  }, [previewSong]);

  const handlePlayNow = () => {
    onPlaySong({
      title: customTitle || undefined,
      style,
      tonic,
      mode,
      bpm,
      lofi,
      groove,
      bassTone,
      form,
      seed,
    }, true);
  };

  const handleQueueNext = () => {
    onPlaySong({
      title: customTitle || undefined,
      style,
      tonic,
      mode,
      bpm,
      lofi,
      groove,
      bassTone,
      form,
      seed,
    }, false);
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md p-4 sm:p-6 shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-pink-500 to-amber-500 flex items-center justify-center text-white shadow-md">
            <Wand2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[var(--text-primary)]">
              {t('The Procedural Forge')}
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)]">
              {t('Craft bespoke algorithmic tracks: compose keys, modes, grooves, synth timbres, and seeds')}
            </p>
          </div>
        </div>

        {/* Randomize Button */}
        <button
          onClick={handleRollSeed}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-xs font-mono text-[var(--text-secondary)] hover:text-white transition shadow-sm"
          title={t('Generate fresh random seed')}
        >
          <Dices className="w-3.5 h-3.5 text-amber-400" />
          <span>{t('Reroll Seed')}</span>
        </button>
      </div>

      {/* Generated Track Live Preview Card */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-xl border border-[var(--accent)]/30 bg-gradient-to-r from-[var(--bg-tertiary)] via-[var(--bg-secondary)] to-[var(--bg-tertiary)] shadow-inner">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm">
              {STYLES[style].label}
            </span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              {t('Seed #{seed}', { seed: seed })}
            </span>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/30 text-[10px] font-mono text-violet-300">
              <span>{camelot.code}</span>
              <span>·</span>
              <span>{previewSong.key} {previewSong.mode}</span>
            </div>
          </div>

          <h3 className="text-lg font-bold text-[var(--text-primary)] truncate mt-1">
            {t(previewSong.title)}
          </h3>
          <p className="text-xs text-[var(--text-secondary)] font-mono mt-0.5">
            {t('{bpm} BPM · {bars} bars · {form} structure · {v0}% tape lofi', { bpm: previewSong.bpm, bars: previewSong.bars, form: form, v0: Math.round(previewSong.lofi * 100) })}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handlePlayNow}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-pink-500 hover:from-rose-600 hover:to-pink-600 text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-pink-500/20 transition active:scale-95"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{t('Play on Deck A')}</span>
          </button>
          <button
            onClick={handleQueueNext}
            className="px-3.5 py-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-medium flex items-center gap-1.5 transition active:scale-95"
            title={t('Queue into Deck B for next mix')}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('Queue in Deck B')}</span>
          </button>
          {onSaveFav && (
            <button
              onClick={() => onSaveFav(previewSong)}
              className="p-2 rounded-xl border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-rose-400 hover:bg-[var(--bg-hover)] transition"
              title={t('Save to Favorites')}
            >
              <Heart className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Parameter Controls Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Left Column: Style, Tonic, Mode, Tempo */}
        <div className="flex flex-col gap-4">
          {/* Style Selector */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Musical Style ({length} Available)', { length: STYLE_IDS.length })}
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {STYLE_IDS.map(id => (
                <button
                  key={id}
                  onClick={() => setStyle(id)}
                  className={clsx(
                    'px-2 py-1.5 rounded-lg border text-xs font-medium transition truncate text-center',
                    style === id
                      ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-soft)] font-bold shadow-sm'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                  title={STYLES[id].hint}
                >
                  {STYLES[id].short}
                </button>
              ))}
            </div>
          </div>

          {/* Key Tonic (Root Note) */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Key Root Note (Tonic)')}
            </label>
            <div className="grid grid-cols-6 sm:grid-cols-12 gap-1 text-center">
              {TONIC_NAMES.map((name, i) => (
                <button
                  key={i}
                  onClick={() => setTonic(i)}
                  className={clsx(
                    'py-1 rounded-md border text-xs font-mono transition',
                    tonic === i
                      ? 'border-violet-500 bg-violet-500 text-white font-bold'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* Scale Mode */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Scale Mode / Harmony')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={clsx(
                    'px-2 py-1.5 rounded-lg border text-xs font-mono transition truncate text-center',
                    mode === m.id
                      ? 'border-cyan-500 bg-cyan-500/20 text-cyan-300 font-bold'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  {t(m.label)}
                </button>
              ))}
            </div>
          </div>

          {/* Tempo BPM & Tap Tempo */}
          <div className="p-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                {t('Tempo (BPM)')}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono font-bold text-[var(--text-primary)]">
                  {bpm} BPM
                </span>
                <button
                  onClick={handleTapTempo}
                  className="px-2.5 py-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-mono font-semibold hover:bg-amber-500/20 active:scale-95 transition"
                >
                  {t('Tap Tempo')}
                </button>
              </div>
            </div>
            <input
              type="range"
              min={60}
              max={180}
              step={1}
              value={bpm}
              onChange={e => setBpm(+e.target.value)}
              className="w-full accent-[var(--accent)]"
            />
          </div>
        </div>

        {/* Right Column: Groove, Bass Tone, Form, Lo-Fi, Seed */}
        <div className="flex flex-col gap-4">
          {/* Drum Groove */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Drum Groove & Pattern')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {GROOVES.map(g => (
                <button
                  key={g.id}
                  onClick={() => setGroove(g.id)}
                  className={clsx(
                    'px-2 py-1.5 rounded-lg border text-xs font-mono transition truncate text-center',
                    groove === g.id
                      ? 'border-rose-500 bg-rose-500/20 text-rose-300 font-bold'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  {t(g.label)}
                </button>
              ))}
            </div>
          </div>

          {/* Bass Tone */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Bass Synth Timbre')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {BASS_TONES.map(b => (
                <button
                  key={b.id}
                  onClick={() => setBassTone(b.id)}
                  className={clsx(
                    'px-2 py-1.5 rounded-lg border text-xs font-mono transition truncate text-center',
                    bassTone === b.id
                      ? 'border-amber-500 bg-amber-500/20 text-amber-300 font-bold'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  {t(b.label)}
                </button>
              ))}
            </div>
          </div>

          {/* Song Form */}
          <div>
            <label className="text-xs font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2 block">
              {t('Song Structure Form')}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
              {FORMS.map(f => (
                <button
                  key={f.id}
                  onClick={() => setForm(f.id)}
                  className={clsx(
                    'px-2 py-1.5 rounded-lg border text-xs font-mono transition truncate text-center',
                    form === f.id
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 font-bold'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  {t(f.label)}
                </button>
              ))}
            </div>
          </div>

          {/* Lo-Fi Dust & Seed */}
          <div className="p-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex flex-col gap-3">
            <div>
              <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                <span className="uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                  {t('Tape Dust & Lo-Fi Crush')}
                </span>
                <span className="font-bold text-[var(--text-primary)]">
                  {Math.round(lofi * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={lofi}
                onChange={e => setLofi(+e.target.value)}
                className="w-full accent-amber-500"
              />
            </div>

            {/* Seed & Custom Title */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--border-subtle)]">
              <div>
                <label className="text-[10px] font-mono uppercase text-[var(--text-muted)] block mb-1">
                  {t('Random Seed')}
                </label>
                <input
                  type="number"
                  value={seed}
                  onChange={e => setSeed(+e.target.value || 0)}
                  className="w-full px-2.5 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase text-[var(--text-muted)] block mb-1">
                  {t('Custom Title (Optional)')}
                </label>
                <input
                  type="text"
                  placeholder={t('Auto-generated if blank')}
                  value={customTitle}
                  onChange={e => setCustomTitle(e.target.value)}
                  className="w-full px-2.5 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
