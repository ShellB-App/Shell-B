import { useState, useEffect } from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Radio,
  Sun,
  Palette,
  Image as ImageIcon,
  Settings,
  Lock,
  Search,
} from 'lucide-react';
import type { Status } from '../types';
import { fmtBytes } from '../api';
import { dj, type DJState } from '../dj/engine';
import { nextTheme, setTheme as applyTheme, currentTheme } from '../themes';
import { t as tx } from '../i18n';

interface Props {
  activeTitle?: string;
  onOpenStartMenu: () => void;
  onOpenFormFactor: () => void;
  onOpenPalette: () => void;
  onOpenWallpaper: () => void;
  onOpenSettings: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  onLockKiosk: () => void;
  onTileWindows: () => void;
  onCascadeWindows: () => void;
  onMinimizeAll: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  status?: Status;
}

export function KioskTopBar({
  activeTitle,
  onOpenStartMenu,
  onOpenFormFactor,
  onOpenPalette,
  onOpenWallpaper,
  onOpenSettings,
  onToggleFullscreen,
  isFullscreen,
  onLockKiosk,
  onTileWindows,
  onCascadeWindows,
  onMinimizeAll,
  theme,
  onToggleTheme,
  status,
}: Props) {
  const [time, setTime] = useState(new Date());
  const [djState, setDjState] = useState<DJState>(dj.state);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => dj.subscribe(setDjState), []);

  const mem = status?.memory;
  const memUsed = mem ? Math.max(0, mem.MemTotal - mem.MemAvailable) : 0;
  const memPct = mem ? Math.round((memUsed / mem.MemTotal) * 100) : 0;

  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = time.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <header className="h-10 px-3 shrink-0 flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md z-40 select-none text-xs">
      {/* Left: Start Menu & Window layout */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenStartMenu}
          className="flex items-center gap-1.5 py-1 px-2.5 rounded-lg bg-[var(--accent)] hover:brightness-110 text-[var(--accent-fg)] font-semibold text-xs shadow-sm transition"
        >
          <span className="font-mono font-bold tracking-tight">{tx('Shell:B')}</span>
          <ChevronDown className="w-3 h-3 opacity-80" />
        </button>

        {activeTitle && (
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            <span className="max-w-[180px] truncate font-medium">{activeTitle}</span>
          </div>
        )}

        {/* Window layout tools */}
        <div className="hidden md:flex items-center gap-0.5 ml-2 border-l border-[var(--border-subtle)] pl-2">
          <button
            onClick={onTileWindows}
            className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
            title={tx('Tile open windows side-by-side')}
          >
            {tx('Tile')}
          </button>
          <button
            onClick={onCascadeWindows}
            className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
            title={tx('Cascade open windows')}
          >
            {tx('Cascade')}
          </button>
          <button
            onClick={onMinimizeAll}
            className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
            title={tx('Show desktop')}
          >
            {tx('Desktop')}
          </button>
        </div>
      </div>

      {/* Center: System Status beacon */}
      <div className="hidden lg:flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="font-medium text-[var(--text-secondary)]">SHELL:B</span>
        <span>·</span>
        <span className="font-mono">{tx('GB10 Unified Memory: {v0} ({memPct}%)', { v0: fmtBytes(memUsed), memPct: memPct })}</span>
        {djState.playing && (
          <>
            <span>·</span>
            <span className="text-[#ff2e97] flex items-center gap-1 font-mono">
              <Radio className="w-3 h-3 animate-pulse" />
              {djState.song?.title ?? tx('Radio')}
            </span>
          </>
        )}
      </div>

      {/* Right: Quick actions, Theme, Fullscreen, Clock */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Search / Command Palette (Ctrl+K)')}
          aria-label={tx('Search')}
        >
          <Search className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onOpenFormFactor}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Display Form Factor')}
          aria-label={tx('Display Form Factor')}
        >
          <Monitor className="w-3.5 h-3.5 text-sky-400" />
        </button>

        <button
          onClick={() => applyTheme(nextTheme())}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Skin: {v0}', { v0: currentTheme() })}
          aria-label={tx('Skin: {v0}', { v0: currentTheme() })}
        >
          <Palette className="w-3.5 h-3.5 text-pink-400" />
        </button>

        <button
          onClick={onOpenWallpaper}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Change Desktop Wallpaper')}
          aria-label={tx('Change Desktop Wallpaper')}
        >
          <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
        </button>

        <button
          onClick={onToggleTheme}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Toggle Dark/Light')}
          aria-label={tx('Toggle dark/light mode')}
        >
          {theme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={tx('Settings & System')}
          aria-label={tx('Settings')}
        >
          <Settings className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onToggleFullscreen}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title={isFullscreen ? tx('Exit Fullscreen') : tx('Enter Fullscreen Kiosk')}
          aria-label={isFullscreen ? tx('Exit Fullscreen') : tx('Enter Fullscreen Kiosk')}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={onLockKiosk}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-amber-400 hover:bg-[var(--bg-hover)] transition"
          title={tx('Kiosk Standby Lock')}
          aria-label={tx('Kiosk Standby Lock')}
        >
          <Lock className="w-3.5 h-3.5" />
        </button>

        {/* Live Clock */}
        <div className="ml-2 pl-2 border-l border-[var(--border-subtle)] flex items-center gap-1.5 font-mono text-[11px] text-[var(--text-primary)]">
          <span className="font-semibold">{timeStr}</span>
          <span className="hidden sm:inline text-[var(--text-muted)]">{dateStr}</span>
        </div>
      </div>
    </header>
  );
}
