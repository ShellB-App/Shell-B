import React, { useMemo } from 'react';
import clsx from 'clsx';
import {
  Disc3, Play, Pause, SkipForward, Shuffle, Volume2, RotateCcw,
  Sparkles, Music, ChevronLeft, ChevronRight, Zap
} from 'lucide-react';
import { STYLES, type SongInfo, type DeckEqState } from '../dj/engine';
import { getCamelotCode, evaluateHarmonicMix, type HarmonicRelationship } from './camelot';
import { t } from '../i18n';

interface DeckViewProps {
  deckId: 'A' | 'B';
  song: SongInfo | null;
  isOnAir: boolean;
  isPlaying: boolean;
  section?: string;
  bar?: number;
  totalBars?: number;
  bpm?: number;
  otherSong?: SongInfo | null;
  eq: DeckEqState;
  onEqChange: (band: 'low' | 'mid' | 'high', val: number) => void;
  onEqKill: (band: 'low' | 'mid' | 'high', kill: boolean) => void;
  onNudgeBpm: (delta: number) => void;
  onSetBpm: (bpm: number) => void;
  onJumpBeats: (beats: number) => void;
  onTogglePlay: () => void;
  onMixNow?: () => void;
  onReroll?: () => void;
}

export function DeckView({
  deckId,
  song,
  isOnAir,
  isPlaying,
  section = 'Intro',
  bar = 0,
  totalBars = 32,
  bpm,
  otherSong,
  eq,
  onEqChange,
  onEqKill,
  onNudgeBpm,
  onSetBpm,
  onJumpBeats,
  onTogglePlay,
  onMixNow,
  onReroll,
}: DeckViewProps) {
  const currentBpm = bpm ?? song?.bpm ?? 120;
  const progress = totalBars > 0 ? Math.min(1, bar / totalBars) : 0;

  const camelot = useMemo(() => {
    if (!song) return null;
    return getCamelotCode(song.tonic, song.mode);
  }, [song]);

  const harmonicRelation = useMemo(() => {
    if (!song || !otherSong) return null;
    const keyA = getCamelotCode(song.tonic, song.mode);
    const keyB = getCamelotCode(otherSong.tonic, otherSong.mode);
    return evaluateHarmonicMix(keyA, keyB);
  }, [song, otherSong]);

  const styleDef = song ? STYLES[song.style] : null;

  return (
    <div
      className={clsx(
        'relative flex flex-col rounded-2xl border transition-all duration-300 p-4 bg-[var(--bg-secondary)]/90 backdrop-blur-md overflow-hidden shadow-xl',
        isOnAir
          ? 'border-rose-500/50 shadow-[0_0_24px_rgba(244,63,94,0.18)]'
          : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
      )}
    >
      {/* Deck Header */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div
            className={clsx(
              'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold tracking-wider uppercase',
              deckId === 'A'
                ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
            )}
          >
            DECK {deckId}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={clsx(
                'w-2 h-2 rounded-full',
                isOnAir && isPlaying
                  ? 'bg-rose-500 animate-pulse shadow-[0_0_8px_#f43f5e]'
                  : 'bg-[var(--text-muted)]'
              )}
            />
            <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              {isOnAir ? (isPlaying ? t('LIVE ON AIR') : t('PAUSED')) : t('CUED / READY')}
            </span>
          </div>
        </div>

        {/* Camelot Key Badge */}
        {camelot && (
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[11px] font-mono"
            title={t('Camelot Key: {code} ({name})', { code: camelot.code, name: camelot.name })}
          >
            <span className="text-violet-400 font-bold">{camelot.code}</span>
            <span className="text-[var(--text-muted)]">·</span>
            <span className="text-[var(--text-secondary)]">{song?.key} {song?.mode}</span>
          </div>
        )}
      </div>

      {/* Main Deck Body: Turntable + Track Info */}
      <div className="flex flex-col sm:flex-row items-center gap-4 my-2">
        {/* Vinyl Platter */}
        <div className="relative group shrink-0 w-36 h-36 sm:w-44 sm:h-44 rounded-full p-2 bg-neutral-900 border-4 border-neutral-800 shadow-2xl flex items-center justify-center">
          {/* Turntable Outer Ring */}
          <div className="absolute inset-1 rounded-full border border-neutral-700/60 pointer-events-none" />

          {/* Vinyl Record */}
          <div
            className={clsx(
              'w-full h-full rounded-full relative flex items-center justify-center shadow-inner overflow-hidden',
              isPlaying && isOnAir && 'animate-[spin_2.8s_linear_infinite]'
            )}
            style={{
              background:
                'radial-gradient(circle, #1a1a1a 0%, #0d0d0d 45%, #181818 50%, #080808 70%, #151515 90%, #050505 100%)',
            }}
          >
            {/* Vinyl Grooves Texture */}
            <div className="absolute inset-2 rounded-full border border-neutral-700/25 pointer-events-none" />
            <div className="absolute inset-5 rounded-full border border-neutral-700/35 pointer-events-none" />
            <div className="absolute inset-9 rounded-full border border-neutral-700/25 pointer-events-none" />
            <div className="absolute inset-14 rounded-full border border-neutral-700/40 pointer-events-none" />

            {/* Vinyl Center Label */}
            <div
              className="w-14 h-14 sm:w-16 sm:h-16 rounded-full flex flex-col items-center justify-center p-1 text-center shadow-md border-2 border-white/20"
              style={{
                background: deckId === 'A'
                  ? 'linear-gradient(135deg, #f43f5e, #ec4899)'
                  : 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              }}
            >
              <span className="text-[8px] font-bold tracking-tighter text-white uppercase truncate max-w-full">
                {song?.style ?? 'SHELL:B'}
              </span>
              <span className="text-[7px] font-mono text-white/80">
                {currentBpm} BPM
              </span>
              <div className="w-2.5 h-2.5 rounded-full bg-neutral-950 border border-white/40 mt-0.5" />
            </div>
          </div>

          {/* Tonearm */}
          <div
            className={clsx(
              'absolute top-0 right-1 w-6 h-28 origin-top-right transition-transform duration-700 pointer-events-none',
              isPlaying && isOnAir ? 'rotate-12' : '-rotate-12'
            )}
          >
            <div className="w-1.5 h-20 bg-neutral-400 rounded-full mx-auto shadow-md" />
            <div className="w-3 h-4 bg-rose-500 rounded-sm mx-auto shadow-md" />
          </div>
        </div>

        {/* Track Metadata & Transport */}
        <div className="flex-1 min-w-0 flex flex-col justify-between w-full">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider text-white"
                style={{
                  backgroundColor: styleDef?.hues ? `hsl(${styleDef.hues[0]}, 75%, 45%)` : '#ec4899',
                }}
              >
                {styleDef?.label ? t(styleDef.label) : t('Empty')}
              </span>
              <span className="text-[11px] font-mono text-[var(--text-muted)]">
                {song ? t('{form} form · {totalBars} bars', { form: song.form, totalBars: totalBars }) : t('No track loaded')}
              </span>
            </div>

            <h3
              className="text-base sm:text-lg font-bold text-[var(--text-primary)] truncate mt-1"
              title={song?.title}
            >
              {song?.title ?? t('Procedural Deck Idle')}
            </h3>

            {/* Harmonic Relation Badge */}
            {harmonicRelation && (
              <div
                className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: `${harmonicRelation.color}15`,
                  color: harmonicRelation.color,
                  border: `1px solid ${harmonicRelation.color}35`,
                }}
                title={harmonicRelation.subtext}
              >
                <Sparkles className="w-3 h-3" />
                <span className="font-semibold">{harmonicRelation.badge}</span>
                <span className="opacity-80">· {harmonicRelation.subtext}</span>
              </div>
            )}
          </div>

          {/* Section & Phrase Progress */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] mb-1">
              <span className="text-[var(--text-primary)] font-medium">
                {section ? t('Section: {section}', { section: section }) : t('Cue')}
              </span>
              <span>
                {t('Bar {n} / {total} ({pct}%)', { n: bar + 1, total: totalBars, pct: Math.round(progress * 100) })}
              </span>
            </div>
            {/* Visual Section Progress Bar */}
            <div className="h-2 rounded-full bg-[var(--bg-hover)] overflow-hidden relative">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${progress * 100}%`,
                  backgroundImage: deckId === 'A'
                    ? 'linear-gradient(90deg, #ec4899, #f43f5e, #fb923c)'
                    : 'linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6)',
                }}
              />
            </div>
          </div>

          {/* Play/Cue/Skip Actions */}
          <div className="flex items-center gap-2 mt-3.5">
            <button
              onClick={onTogglePlay}
              className={clsx(
                'px-4 py-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-semibold text-white shadow-lg transition',
                isOnAir && isPlaying
                  ? 'bg-rose-500 hover:bg-rose-600'
                  : 'bg-emerald-500 hover:bg-emerald-600'
              )}
            >
              {isOnAir && isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5 fill-current" />
                  <span>{t('Pause')}</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{isOnAir ? t('Resume') : t('Cue & Play')}</span>
                </>
              )}
            </button>

            {onMixNow && (
              <button
                onClick={onMixNow}
                className="px-3 py-2 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition"
                title={t('Transition into Deck B now')}
              >
                <Zap className="w-3.5 h-3.5" />
                <span>{t('Mix In')}</span>
              </button>
            )}

            {onReroll && (
              <button
                onClick={onReroll}
                className="p-2 rounded-xl border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition"
                title={t('Reroll new procedural track')}
              >
                <Shuffle className="w-4 h-4" />
              </button>
            )}

            {/* Beat Jump Buttons */}
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => onJumpBeats(-4)}
                className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title={t('Jump -4 Beats')}
              >
                -4
              </button>
              <button
                onClick={() => onJumpBeats(4)}
                className="px-2 py-1 rounded-lg border border-[var(--border-subtle)] text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title={t('Jump +4 Beats')}
              >
                +4
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Deck Lower Strip: 3-Band EQ & Pitch Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-[var(--border-subtle)]">
        {/* 3-Band EQ */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
            {t('Deck 3-Band EQ')}
          </span>
          <div className="grid grid-cols-3 gap-2 text-center">
            {/* High */}
            <div className="flex flex-col items-center gap-1 p-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
              <div className="flex items-center justify-between w-full px-1 text-[9px] font-mono">
                <span className="text-[var(--text-muted)]">HIGH</span>
                <span className="text-[var(--text-primary)]">{eq.high}dB</span>
              </div>
              <input
                type="range"
                min={-30}
                max={6}
                step={0.5}
                value={eq.high}
                onChange={e => onEqChange('high', +e.target.value)}
                className="w-full accent-cyan-400"
              />
              <button
                onClick={() => onEqKill('high', !eq.highKill)}
                className={clsx(
                  'w-full py-0.5 rounded text-[8px] font-mono font-bold uppercase transition',
                  eq.highKill
                    ? 'bg-rose-500 text-white'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Kill')}
              </button>
            </div>

            {/* Mid */}
            <div className="flex flex-col items-center gap-1 p-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
              <div className="flex items-center justify-between w-full px-1 text-[9px] font-mono">
                <span className="text-[var(--text-muted)]">MID</span>
                <span className="text-[var(--text-primary)]">{eq.mid}dB</span>
              </div>
              <input
                type="range"
                min={-30}
                max={6}
                step={0.5}
                value={eq.mid}
                onChange={e => onEqChange('mid', +e.target.value)}
                className="w-full accent-yellow-400"
              />
              <button
                onClick={() => onEqKill('mid', !eq.midKill)}
                className={clsx(
                  'w-full py-0.5 rounded text-[8px] font-mono font-bold uppercase transition',
                  eq.midKill
                    ? 'bg-rose-500 text-white'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Kill')}
              </button>
            </div>

            {/* Low */}
            <div className="flex flex-col items-center gap-1 p-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
              <div className="flex items-center justify-between w-full px-1 text-[9px] font-mono">
                <span className="text-[var(--text-muted)]">LOW</span>
                <span className="text-[var(--text-primary)]">{eq.low}dB</span>
              </div>
              <input
                type="range"
                min={-40}
                max={6}
                step={0.5}
                value={eq.low}
                onChange={e => onEqChange('low', +e.target.value)}
                className="w-full accent-rose-500"
              />
              <button
                onClick={() => onEqKill('low', !eq.lowKill)}
                className={clsx(
                  'w-full py-0.5 rounded text-[8px] font-mono font-bold uppercase transition',
                  eq.lowKill
                    ? 'bg-rose-500 text-white'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Kill')}
              </button>
            </div>
          </div>
        </div>

        {/* Pitch / BPM Nudge */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              {t('Tempo & Pitch')}
            </span>
            <span className="text-[11px] font-mono font-bold text-[var(--text-primary)]">
              {currentBpm} BPM
            </span>
          </div>

          <div className="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
            <button
              onClick={() => onNudgeBpm(-1)}
              className="p-1 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-white"
              title={t('Pitch -1 BPM')}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <input
              type="range"
              min={60}
              max={180}
              step={1}
              value={currentBpm}
              onChange={e => onSetBpm(+e.target.value)}
              className="flex-1 accent-[var(--accent)]"
            />
            <button
              onClick={() => onNudgeBpm(1)}
              className="p-1 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-white"
              title={t('Pitch +1 BPM')}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => song && onSetBpm(song.bpm)}
              className="p-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white"
              title={t('Reset to Original Tempo')}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
