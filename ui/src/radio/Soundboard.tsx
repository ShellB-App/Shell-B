import React, { useState } from 'react';
import clsx from 'clsx';
import {
  Mic, Radio, Sparkles, Volume2, Send, Zap, Bell, Disc,
  Flame, Gauge, RefreshCw, Music2, Cpu, UserCheck
} from 'lucide-react';
import { type SoundFxKind } from '../dj/engine';
import { t } from '../i18n';

interface SoundboardProps {
  onTriggerFx: (kind: SoundFxKind) => void;
  onVoiceDrop: (phrase?: string, voiceId?: string, speed?: number) => void;
  samplerVolume?: number;
  onSamplerVolumeChange?: (vol: number) => void;
}

const SAMPLE_PADS: {
  id: SoundFxKind;
  label: string;
  icon: string;
  color: string;
  hint: string;
}[] = [
  { id: 'airhorn', label: 'Air Horn', icon: '📢', color: '#f59e0b', hint: '4-blast Screaming Dancehall Reggae Brass Horn' },
  { id: 'scratch', label: 'Vinyl Scratch', icon: '💿', color: '#06b6d4', hint: 'Dual Turntable Chirp & Baby Scratch' },
  { id: 'subdrop', label: '808 Sub Drop', icon: '💣', color: '#f43f5e', hint: 'Saturated 808 Club Sub Boom (with ducking)' },
  { id: 'laser', label: 'Dub Laser', icon: '⚡', color: '#a855f7', hint: 'Kingston Synare 4-Burst Resonant Space Lasers' },
  { id: 'siren', label: 'Dub Siren', icon: '🚨', color: '#10b981', hint: 'Analog LFO Modulated Dub Siren with Tape Echo' },
  { id: 'rewind', label: 'Rewind', icon: '🔄', color: '#3b82f6', hint: 'Turntable Backspin Vinyl Whirl' },
  { id: 'cowbell', label: '808 Cowbell', icon: '🔔', color: '#ec4899', hint: 'Classic Roland TR-808 Phonk Metallic Bell' },
  { id: 'chant', label: 'Crowd "HEY!"', icon: '🗣️', color: '#eab308', hint: 'Resonant Crowd Vocal Hype Chant' },
  { id: 'impact', label: 'Crash Impact', icon: '💥', color: '#ef4444', hint: 'Massive EDM Drop Riser & White Noise Crash' },
  { id: 'tapestop', label: 'Tape Brake', icon: '🛑', color: '#8b5cf6', hint: 'Turntable Motor Deceleration Stop' },
];

const DJ_VOICES = [
  { id: 'am_fenrir', label: 'Hype DJ', icon: '🎤', desc: 'Fenrir · Deep, Booming US Male' },
  { id: 'bm_george', label: 'Club MC', icon: '🔊', desc: 'George · UK Rave & London MC' },
  { id: 'af_bella', label: 'Radio Host', icon: '⚡', desc: 'Bella · Bright & Energetic US Female' },
  { id: 'qwen:sage', label: 'Late Night', icon: '🌙', desc: 'Sage · Sultry Velvet Female Radio Host' },
  { id: 'bf_isabella', label: 'Station ID', icon: '🎙️', desc: 'Isabella · Classy UK Broadcaster' },
  { id: 'am_adam', label: 'Festival Host', icon: '🚀', desc: 'Adam · Punchy Dynamic US Male' },
  { id: 'qwen:glados', label: 'Cyber AI', icon: '🤖', desc: 'GLaDOS · Sardonic Synthetic AI' },
];

const PRESET_DROP_CATEGORIES = [
  {
    name: 'Hype & Drops',
    drops: [
      'Shell B F M, live in the mix!',
      'Drop the beat!',
      'Turn up the bass!',
      'Make some noise!',
      'Warning: excessive bass levels detected!'
    ]
  },
  {
    name: 'Station ID & Broadcast',
    drops: [
      'You are locked in to the procedural sound system.',
      'Broadcasting live from DGX Spark.',
      'Exclusive frequency — twenty four hours a day.',
      'Do not touch that dial!',
      'Shell B F M: Sound without limits.'
    ]
  },
  {
    name: 'Selecta & Rewinds',
    drops: [
      'Rewind! Selecta, bring that back!',
      'Hold tight the crew, Shell B in session!',
      'Another exclusive dubplate, right here!'
    ]
  }
];

export function Soundboard({
  onTriggerFx,
  onVoiceDrop,
  samplerVolume = 1.2,
  onSamplerVolumeChange,
}: SoundboardProps) {
  const [customText, setCustomText] = useState('');
  const [activePad, setActivePad] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('am_fenrir');
  const [speechSpeed, setSpeechSpeed] = useState(1.08);
  const [isDroppingVoice, setIsDroppingVoice] = useState(false);
  const [activeCategory, setActiveCategory] = useState(0);

  const handlePad = (id: SoundFxKind) => {
    setActivePad(id);
    onTriggerFx(id);
    setTimeout(() => setActivePad(null), 350);
  };

  const handleVoiceDrop = async (phrase?: string) => {
    setIsDroppingVoice(true);
    try {
      await onVoiceDrop(phrase, selectedVoice, speechSpeed);
    } finally {
      setTimeout(() => setIsDroppingVoice(false), 500);
    }
  };

  const handleCustomDrop = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim()) return;
    handleVoiceDrop(customText.trim());
    setCustomText('');
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md p-5 shadow-xl">
      {/* Header Bar with Sampler Master Volume */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400">
            <Radio className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold tracking-wider uppercase text-[var(--text-primary)]">
                {t('DJ Performance Sampler & Drops')}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {t('LOUD & PUNCHY')}
              </span>
            </div>
            <p className="text-[10px] font-mono text-[var(--text-muted)]">
              {t('Dedicated FX Compressor Bus · HERMES 24kHz Neural Announcer')}
            </p>
          </div>
        </div>

        {/* Sampler Volume Slider */}
        {onSamplerVolumeChange && (
          <div className="flex items-center gap-3 bg-[var(--bg-tertiary)] px-3 py-1.5 rounded-xl border border-[var(--border-subtle)]">
            <div className="flex items-center gap-1.5 text-amber-400">
              <Volume2 className="w-3.5 h-3.5" />
              <span className="text-[10px] font-mono font-semibold uppercase tracking-wider">
                {t('Sampler Vol')}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2.0}
              step={0.05}
              value={samplerVolume}
              onChange={e => onSamplerVolumeChange(parseFloat(e.target.value))}
              className="w-24 sm:w-28 accent-amber-400 cursor-pointer h-1.5 bg-[var(--bg-secondary)] rounded-lg"
              title={t('Sampler Gain: {v0}%', { v0: Math.round(samplerVolume * 100) })}
            />
            <span className="text-[11px] font-mono font-bold text-amber-400 min-w-[36px] text-right">
              {Math.round(samplerVolume * 100)}%
            </span>
            <button
              onClick={() => onSamplerVolumeChange(samplerVolume >= 1.8 ? 1.0 : 1.8)}
              className={clsx(
                'px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border transition',
                samplerVolume >= 1.5
                  ? 'bg-amber-500 text-black border-amber-400'
                  : 'bg-[var(--bg-secondary)] hover:text-white border-[var(--border-subtle)] text-[var(--text-muted)]'
              )}
              title={t('Toggle +4dB Boost')}
            >
              BOOST
            </button>
          </div>
        )}
      </div>

      {/* 10 Performance Sample Pads */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-secondary)]">
          <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-amber-400" />
            {t('Performance One-Shots & Drops (Web Audio Bus)')}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">{t('Click or Trigger')}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
          {SAMPLE_PADS.map(pad => (
            <button
              key={pad.id}
              onClick={() => handlePad(pad.id)}
              className={clsx(
                'group relative flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border transition-all duration-150 active:scale-95 shadow-md select-none',
                activePad === pad.id
                  ? 'scale-95 shadow-[0_0_24px_currentColor] brightness-125'
                  : 'hover:border-[var(--border-strong)] bg-[var(--bg-tertiary)] hover:-translate-y-0.5'
              )}
              style={{
                borderColor: activePad === pad.id ? pad.color : undefined,
                color: pad.color,
              }}
              title={t(pad.hint)}
            >
              <span className="text-2xl group-hover:scale-110 transition-transform">
                {pad.icon}
              </span>
              <span className="text-[11px] font-mono font-bold text-[var(--text-primary)]">
                {t(pad.label)}
              </span>
              <span className="text-[9px] font-mono text-[var(--text-muted)] opacity-80 truncate max-w-full text-center">
                {pad.id}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Procedural DJ Voice Drops (HERMES Neural Voice) */}
      <div className="flex flex-col gap-3.5 p-4 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400">
              <Mic className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="text-xs font-mono uppercase tracking-wider text-[var(--text-primary)] font-bold">
                {t('DJ Voice Announcer Drops (HERMES Neural TTS)')}
              </span>
              <p className="text-[10px] font-mono text-[var(--text-muted)]">
                {t('Expressive human delivery · Auto-ducks the music with broadcast presence')}
              </p>
            </div>
          </div>

          {/* Delivery Speed Slider */}
          <div className="flex items-center gap-2 bg-[var(--bg-secondary)] px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] self-start sm:self-auto">
            <Gauge className="w-3 h-3 text-cyan-400" />
            <span className="text-[10px] font-mono text-[var(--text-muted)] uppercase">{t('Speed:')}</span>
            <input
              type="range"
              min={0.85}
              max={1.25}
              step={0.05}
              value={speechSpeed}
              onChange={e => setSpeechSpeed(parseFloat(e.target.value))}
              className="w-16 accent-cyan-400 cursor-pointer h-1"
            />
            <span className="text-[10px] font-mono font-bold text-cyan-400 min-w-[28px]">
              {speechSpeed.toFixed(2)}x
            </span>
          </div>
        </div>

        {/* DJ Voice Persona Selector */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t('Select DJ Voice Persona:')}
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-1.5">
            {DJ_VOICES.map(v => (
              <button
                key={v.id}
                onClick={() => setSelectedVoice(v.id)}
                className={clsx(
                  'flex flex-col items-center justify-center p-2 rounded-lg border text-center transition gap-0.5',
                  selectedVoice === v.id
                    ? 'bg-rose-500/15 border-rose-500 text-rose-300 font-bold shadow-sm'
                    : 'bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-white'
                )}
                title={t(v.desc)}
              >
                <span className="text-base">{v.icon}</span>
                <span className="text-[11px] font-mono font-medium truncate max-w-full">
                  {t(v.label)}
                </span>
                <span className="text-[8px] font-mono opacity-60 truncate max-w-full">
                  {v.id.replace('qwen:', '').replace('am_', '').replace('bm_', '').replace('af_', '').replace('bf_', '')}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Category Tabs for Voice Drops */}
        <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] pb-2 pt-1">
          {PRESET_DROP_CATEGORIES.map((cat, idx) => (
            <button
              key={cat.name}
              onClick={() => setActiveCategory(idx)}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[11px] font-mono font-semibold transition',
                activeCategory === idx
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--text-muted)] hover:text-white hover:bg-[var(--bg-secondary)]'
              )}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Quick Drop Buttons for Active Category */}
        <div className="flex flex-wrap gap-2">
          {PRESET_DROP_CATEGORIES[activeCategory].drops.map((phrase, i) => (
            <button
              key={i}
              disabled={isDroppingVoice}
              onClick={() => handleVoiceDrop(phrase)}
              className={clsx(
                'px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs font-mono text-[var(--text-secondary)] hover:text-white transition flex items-center gap-2 group active:scale-95 disabled:opacity-50 shadow-sm',
                isDroppingVoice && 'cursor-wait'
              )}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400 group-hover:scale-120 transition-transform shrink-0" />
              <span>"{phrase}"</span>
            </button>
          ))}
        </div>

        {/* Custom Phrase Form */}
        <form onSubmit={handleCustomDrop} className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border-subtle)]">
          <input
            type="text"
            placeholder={t('Type custom live DJ shoutout or station ID...')}
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            disabled={isDroppingVoice}
            className="flex-1 px-3 py-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={!customText.trim() || isDroppingVoice}
            className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-40 transition shrink-0 shadow-md"
          >
            {isDroppingVoice ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span>{t('Drop Voice')}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
