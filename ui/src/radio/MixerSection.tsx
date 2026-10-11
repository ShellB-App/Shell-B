import React from 'react';
import clsx from 'clsx';
import {
  TrendingUp, Waves, OctagonPause, VolumeX, Shuffle, Sliders,
  Volume2, Disc, Sparkles, Zap, Repeat
} from 'lucide-react';
import {
  type StemId, type StemState, type TransitionKind
} from '../dj/engine';
import { t } from '../i18n';

interface MixerSectionProps {
  stems: Record<StemId, StemState>;
  onStemVolume: (stem: StemId, vol: number) => void;
  onStemMute: (stem: StemId, muted: boolean) => void;
  onStemSolo: (stem: StemId, solo: boolean) => void;
  onResetStems: () => void;
  crossfader: number;
  onCrossfaderChange: (val: number) => void;
  filter: number;
  onFilterChange: (val: number) => void;
  bassKill: boolean;
  onToggleBassKill: () => void;
  onBuildUp: () => void;
  onEchoThrow: () => void;
  onTapeBrake: () => void;
  onStutter: () => void;
  isPlaying: boolean;
}

const STEM_CONFIG: Record<StemId, { label: string; icon: string; color: string }> = {
  drums: { label: 'Drums', icon: '🥁', color: '#f43f5e' },
  bass: { label: 'Bass', icon: '🎸', color: '#fb923c' },
  keys: { label: 'Keys', icon: '🎹', color: '#eab308' },
  pad: { label: 'Pad', icon: '🌫️', color: '#06b6d4' },
  arp: { label: 'Arp', icon: '💫', color: '#8b5cf6' },
  lead: { label: 'Lead', icon: '🎺', color: '#ec4899' },
};

export function MixerSection({
  stems,
  onStemVolume,
  onStemMute,
  onStemSolo,
  onResetStems,
  crossfader,
  onCrossfaderChange,
  filter,
  onFilterChange,
  bassKill,
  onToggleBassKill,
  onBuildUp,
  onEchoThrow,
  onTapeBrake,
  onStutter,
  isPlaying,
}: MixerSectionProps) {
  const padBtnClass =
    'flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-xl border text-xs font-semibold transition active:scale-95 disabled:opacity-40 shadow-sm';

  const anySolo = Object.values(stems).some(s => s.solo);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md p-4 shadow-xl">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-[var(--accent)]" />
          <span className="text-xs font-mono font-bold tracking-wider uppercase text-[var(--text-primary)]">
            {t('Performance Mixer & Stems')}
          </span>
        </div>

        {/* Stem Quick Presets */}
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <button
            onClick={() => {
              // Solo drums and bass only
              (['drums', 'bass'] as StemId[]).forEach(id => onStemSolo(id, true));
              (['keys', 'pad', 'arp', 'lead'] as StemId[]).forEach(id => onStemSolo(id, false));
            }}
            className="px-2 py-0.5 rounded-md border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
            title={t('Isolate Groove: Solo Drums & Bass')}
          >
            {t('Groove Only')}
          </button>
          <button
            onClick={() => {
              onStemMute('drums', !stems.drums.muted);
            }}
            className={clsx(
              'px-2 py-0.5 rounded-md border transition',
              stems.drums.muted
                ? 'border-rose-500/50 bg-rose-500/20 text-rose-300'
                : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
            )}
            title={t('Cut Drums for atmospheric breakdown')}
          >
            {stems.drums.muted ? t('Drums Muted') : t('Drop Drums')}
          </button>
          <button
            onClick={onResetStems}
            className="px-2 py-0.5 rounded-md border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white"
            title={t('Reset All Stems')}
          >
            {t('Reset')}
          </button>
        </div>
      </div>

      {/* 6-Channel Stem Mixer Matrix */}
      <div className="grid grid-cols-6 gap-2 p-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
        {(Object.keys(STEM_CONFIG) as StemId[]).map(stemId => {
          const cfg = STEM_CONFIG[stemId];
          const st = stems[stemId];
          const isAudible = anySolo ? st.solo : !st.muted;

          return (
            <div
              key={stemId}
              className={clsx(
                'flex flex-col items-center gap-2 p-2 rounded-lg border transition-all',
                isAudible
                  ? 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]'
                  : 'border-transparent bg-neutral-900/40 opacity-50'
              )}
            >
              {/* Stem Title & Emoji */}
              <div className="flex flex-col items-center">
                <span className="text-sm">{cfg.icon}</span>
                <span className="text-[10px] font-mono font-medium text-[var(--text-primary)] mt-0.5">
                  {t(cfg.label)}
                </span>
              </div>

              {/* Stem Vertical Slider */}
              <div className="h-24 flex items-center justify-center my-1 relative">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={st.volume}
                  onChange={e => onStemVolume(stemId, +e.target.value)}
                  className="h-20 -rotate-90 origin-center accent-[var(--accent)] cursor-pointer"
                  style={{ width: '80px' }}
                  title={t('{label} volume: {v0}%', { label: cfg.label, v0: Math.round(st.volume * 100) })}
                />
              </div>

              {/* Volume % Readout */}
              <span className="text-[9px] font-mono text-[var(--text-muted)]">
                {Math.round(st.volume * 100)}%
              </span>

              {/* Solo & Mute Buttons */}
              <div className="flex items-center gap-1 w-full mt-1">
                <button
                  onClick={() => onStemSolo(stemId, !st.solo)}
                  className={clsx(
                    'flex-1 py-1 rounded text-[9px] font-mono font-bold uppercase transition',
                    st.solo
                      ? 'bg-amber-500 text-black shadow-[0_0_8px_#f59e0b]'
                      : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white'
                  )}
                  title={t('Solo')}
                >
                  S
                </button>
                <button
                  onClick={() => onStemMute(stemId, !st.muted)}
                  className={clsx(
                    'flex-1 py-1 rounded text-[9px] font-mono font-bold uppercase transition',
                    st.muted
                      ? 'bg-rose-500 text-white shadow-[0_0_8px_#f43f5e]'
                      : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-white'
                  )}
                  title={t('Mute')}
                >
                  M
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Center Mixer: Master Filter + Crossfader */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-3 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
        {/* DJ Filter Knob / Slider */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] font-mono">
            <span className="text-[var(--text-muted)] uppercase tracking-wider">
              {t('DJ Master Filter')}
            </span>
            <span
              className={clsx(
                'font-bold',
                filter < -0.05
                  ? 'text-cyan-400'
                  : filter > 0.05
                  ? 'text-rose-400'
                  : 'text-[var(--text-muted)]'
              )}
            >
              {filter < -0.05
                ? t('Low-Pass {v0}%', { v0: Math.round(-filter * 100) })
                : filter > 0.05
                ? t('High-Pass {v0}%', { v0: Math.round(filter * 100) })
                : t('Neutral (Open)')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className={clsx('text-[10px] font-mono font-bold', filter < -0.05 && 'text-cyan-400')}>
              LPF
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={filter}
              disabled={!isPlaying}
              onChange={e => onFilterChange(+e.target.value)}
              onDoubleClick={() => onFilterChange(0)}
              className="flex-1 accent-[var(--accent)] cursor-pointer"
              title={t('DJ filter: slide left for Low-Pass, right for High-Pass. Double-click to reset.')}
            />
            <span className={clsx('text-[10px] font-mono font-bold', filter > 0.05 && 'text-rose-400')}>
              HPF
            </span>
          </div>
        </div>

        {/* DJ Crossfader */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] font-mono">
            <span className="text-[var(--text-muted)] uppercase tracking-wider">
              {t('Crossfader')}
            </span>
            <div className="flex items-center gap-2 text-[10px]">
              <button
                onClick={() => onCrossfaderChange(-1)}
                className={clsx(
                  'px-1.5 py-0.5 rounded font-mono',
                  crossfader === -1 ? 'bg-rose-500 text-white' : 'text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Deck A')}
              </button>
              <button
                onClick={() => onCrossfaderChange(0)}
                className={clsx(
                  'px-1.5 py-0.5 rounded font-mono',
                  crossfader === 0 ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Center')}
              </button>
              <button
                onClick={() => onCrossfaderChange(1)}
                className={clsx(
                  'px-1.5 py-0.5 rounded font-mono',
                  crossfader === 1 ? 'bg-cyan-500 text-white' : 'text-[var(--text-muted)] hover:text-white'
                )}
              >
                {t('Deck B')}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold text-rose-400">A</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={crossfader}
              onChange={e => onCrossfaderChange(+e.target.value)}
              className="flex-1 accent-[var(--accent)] cursor-pointer"
              title={t('Crossfader: blend between Deck A (left) and Deck B (right)')}
            />
            <span className="text-[10px] font-mono font-bold text-cyan-400">B</span>
          </div>
        </div>
      </div>

      {/* Live Performance FX Pads */}
      <div className="flex flex-wrap sm:flex-nowrap gap-2">
        <button
          disabled={!isPlaying}
          onClick={onBuildUp}
          className={clsx(
            padBtnClass,
            'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
          )}
          title={t('2-bar build-up: noise riser + snare rush + highpass sweep + drop')}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          <span>{t('Build-Up')}</span>
        </button>

        <button
          disabled={!isPlaying}
          onClick={onEchoThrow}
          className={clsx(
            padBtnClass,
            'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
          )}
          title={t('Throw mix into stereo delay for a beat')}
        >
          <Waves className="w-3.5 h-3.5" />
          <span>{t('Echo Throw')}</span>
        </button>

        <button
          disabled={!isPlaying}
          onClick={onToggleBassKill}
          className={clsx(
            padBtnClass,
            bassKill
              ? 'border-rose-500 bg-rose-500 text-white shadow-[0_0_12px_#f43f5e]'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
          )}
          title={t('Instantly kill sub bass (-40dB)')}
        >
          <VolumeX className="w-3.5 h-3.5" />
          <span>{bassKill ? t('Sub Cut (ON)') : t('Bass Kill')}</span>
        </button>

        <button
          disabled={!isPlaying}
          onClick={onStutter}
          className={clsx(
            padBtnClass,
            'border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20'
          )}
          title={t('1/16 Beat Stutter Glitch Repeat')}
        >
          <Repeat className="w-3.5 h-3.5" />
          <span>{t('Stutter Roll')}</span>
        </button>

        <button
          disabled={!isPlaying}
          onClick={onTapeBrake}
          className={clsx(
            padBtnClass,
            'border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20'
          )}
          title={t('Tape-stop deceleration drop into next track')}
        >
          <OctagonPause className="w-3.5 h-3.5" />
          <span>{t('Tape Brake')}</span>
        </button>
      </div>
    </div>
  );
}
