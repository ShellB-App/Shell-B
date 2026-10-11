import { t } from '../i18n';
import { useState, useEffect } from 'react';
import clsx from 'clsx';
import {
  Activity as ActivityIcon,
  Cpu,
  HardDrive,
  Radio,
  Play,
  Pause,
  SkipForward,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { Status } from '../types';
import { fmtBytes } from '../api';
import { dj, type DJState } from '../dj/engine';

interface Props {
  status?: Status;
  onOpenApp: (appId: any) => void;
}

export function DesktopWidgets({ status, onOpenApp }: Props) {
  const [time, setTime] = useState(new Date());
  const [djState, setDjState] = useState<DJState>(dj.state);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => dj.subscribe(setDjState), []);

  const mem = status?.memory;
  const memTotal = mem?.MemTotal ?? 1;
  const memAvail = mem?.MemAvailable ?? 1;
  const memUsed = Math.max(0, memTotal - memAvail);
  const memPct = Math.round((memUsed / memTotal) * 100);

  const services = status?.services ?? {};
  const svcCount = Object.keys(services).length;
  const svcOk = Object.values(services).filter(s => s.ok).length;
  const allServicesOk = svcCount > 0 && svcOk === svcCount;

  const hours = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = time.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="absolute top-12 right-6 w-80 space-y-4 select-none z-10 pointer-events-auto">
      {/* Tactical Clock & Date Widget */}
      <div className="p-4 rounded-2xl bg-[var(--bg-secondary)]/85 backdrop-blur-md border border-[var(--border-subtle)] shadow-xl relative overflow-hidden group">
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 via-pink-500 to-amber-500 opacity-70" />
        <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] uppercase tracking-wider">
          <span>{t('SHELL:B STATION')}</span>
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {t('ONLINE')}
          </span>
        </div>

        <div className="mt-2 flex items-baseline justify-between">
          <div className="text-3xl font-mono font-bold tracking-tight text-[var(--text-primary)]">
            {hours}
          </div>
        </div>
        <div className="text-xs text-[var(--text-secondary)] mt-0.5 font-medium">
          {dateStr}
        </div>
      </div>

      {/* DGX Spark Telemetry Widget */}
      <div className="p-4 rounded-2xl bg-[var(--bg-secondary)]/85 backdrop-blur-md border border-[var(--border-subtle)] shadow-xl space-y-3">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <span>DGX Spark GB10</span>
          </div>
          <button
            onClick={() => onOpenApp('models')}
            className="text-[10px] text-[var(--accent-soft)] hover:underline"
          >
            {t('Models →')}
          </button>
        </div>

        {/* Memory Bar */}
        <div>
          <div className="flex justify-between text-[10px] text-[var(--text-secondary)] font-mono mb-1">
            <span>{t('Unified memory')}</span>
            <span>
              {fmtBytes(memUsed)} / {fmtBytes(memTotal)} ({memPct}%)
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              className={clsx(
                'h-full transition-all duration-500 rounded-full',
                memPct > 85 ? 'bg-rose-500' : memPct > 65 ? 'bg-amber-500' : 'bg-cyan-500'
              )}
              style={{ width: `${memPct}%` }}
            />
          </div>
        </div>

        {/* Loaded Models */}
        {status?.loaded && status.loaded.length > 0 && (
          <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1">
            <div className="text-[10px] text-[var(--text-muted)] font-mono uppercase tracking-wider">
              {t('VRAM loaded:')}
            </div>
            <div className="flex flex-wrap gap-1">
              {status.loaded.map(m => (
                <span
                  key={m.name}
                  className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/20"
                >
                  {m.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Service status health summary */}
        <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">{t('Neural Services')}</span>
          <span className="flex items-center gap-1 font-mono text-[10px] text-[var(--text-muted)]">
            {allServicesOk ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t('{ok}/{count} Healthy', { ok: svcOk, count: svcCount })}</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>{svcOk}/{svcCount} Active</span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* Procedural Radio Mini Widget */}
      <div
        onClick={() => onOpenApp('radio')}
        className="p-3.5 rounded-2xl bg-[var(--bg-secondary)]/85 backdrop-blur-md border border-[#ff2e97]/30 hover:border-[#ff2e97]/60 shadow-xl cursor-pointer transition group"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-[#ff2e97]/15 flex items-center justify-center text-[#ff2e97] shrink-0">
              <Radio className={clsx('w-4 h-4', djState.playing && 'animate-pulse')} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate text-[var(--text-primary)] group-hover:text-[#ff2e97] transition">
                {djState.song?.title ?? 'Shell:B FM'}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">
                {djState.playing
                  ? `${djState.song?.style ?? 'Auto'} · ${djState.bpm} BPM`
                  : t('Station Standby')}
              </div>
            </div>
          </div>

          <div
            className="flex items-center gap-1 shrink-0"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => dj.toggle()}
              className="p-2 rounded-xl bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] transition"
              aria-label={djState.playing ? 'Pause radio' : 'Play radio'}
            >
              {djState.playing ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current" />
              )}
            </button>
            <button
              onClick={() => dj.skip('blend')}
              className="p-1.5 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              aria-label="Skip track"
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
