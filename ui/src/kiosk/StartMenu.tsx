import { useState, useMemo, useEffect } from 'react';
import clsx from 'clsx';
import { Play, Pin, PinOff } from 'lucide-react';
import {
  Search,
  Settings,
  Monitor,
  Maximize2,
  Lock,
  Moon,
  Sun,
  Palette,
  Image as ImageIcon,
  Power,
  Cpu,
  Boxes,
} from 'lucide-react';
import { APPS, GROUP_LABEL, type AppDef, type AppGroup, type AppId } from '../components/apps';
import type { Status } from '../types';
import { nextTheme, setTheme as applyTheme, currentTheme } from '../themes';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenApp: (appId: AppId) => void;
  onOpenFormFactor: () => void;
  onOpenSettings: () => void;
  onOpenWallpaper: () => void;
  onToggleFullscreen: () => void;
  onLockKiosk: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  status?: Status;
}

export function StartMenu({
  open,
  onClose,
  onOpenApp,
  onOpenFormFactor,
  onOpenSettings,
  onOpenWallpaper,
  onToggleFullscreen,
  onLockKiosk,
  theme,
  onToggleTheme,
  status,
}: Props) {
  
  const [q, setQ] = useState('');
  const [contextMenu, setContextMenu] = useState<{ appId: AppId; x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState<AppId[]>(() => {
    try {
      const stored = localStorage.getItem('shellb.kiosk.desktop');
      if (stored) return JSON.parse(stored);
    } catch {}
    return ['chat', 'studio', 'code', 'radio', 'maps', 'library', 'notes', 'codex', 'research', 'plans', 'activity', 'secretary', 'models', 'settings'];
  });

  useEffect(() => {
    const onPinned = (e: Event) => setPinned((e as CustomEvent).detail);
    window.addEventListener('shellb-desktop-pinned', onPinned);
    return () => window.removeEventListener('shellb-desktop-pinned', onPinned);
  }, []);

  useEffect(() => {
    const onClick = () => setContextMenu(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);


  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return APPS;
    return APPS.filter(
      a =>
        a.label.toLowerCase().includes(term) ||
        a.hint.toLowerCase().includes(term) ||
        (a.keywords && a.keywords.toLowerCase().includes(term))
    );
  }, [q]);

  const groups: { group: AppGroup; label: string; items: AppDef[] }[] = useMemo(() => {
    const order: AppGroup[] = ['make', 'know', 'run', 'system'];
    return order
      .map(group => ({
        group,
        label: GROUP_LABEL[group],
        items: filtered.filter(a => a.group === group),
      }))
      .filter(g => g.items.length > 0);
  }, [filtered]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Start Menu Popup */}
      <div
        className="fixed top-11 left-3 w-96 max-h-[82vh] bg-[var(--bg-primary)] border border-[var(--border-strong)] rounded-2xl shadow-2xl flex flex-col overflow-hidden z-50 animate-scale-in select-none"
        onClick={e => e.stopPropagation()}
      >
        {/* Menu Header */}
        <header className="p-4 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent-soft)] font-mono font-bold text-sm">
              S:B
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                Shell:B Kiosk OS
              </div>
              <div className="text-[10px] text-[var(--text-muted)] font-mono">
                DGX Spark Platform · CUDA 13.0
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
            title="Settings"
            aria-label="Open settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </header>

        {/* Search */}
        <div className="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search apps and tools…"
              autoFocus
              className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* Apps List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {groups.map(g => (
            <div key={g.group} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] px-2">
                {g.label}
              </div>
              <div className="grid grid-cols-1 gap-1">
                {g.items.map(app => {
                  const Icon = app.icon;
                  const live = app.live?.(status);
                  return (
                    <button
                      key={app.id}

                      onClick={() => {
                        onOpenApp(app.id);
                        onClose();
                      }}
                      onContextMenu={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ appId: app.id, x: e.clientX, y: e.clientY });
                      }}

                      className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-[var(--bg-hover)] text-left transition group"
                    >
                      <div
                        className="p-1.5 rounded-lg shrink-0"
                        style={{
                          background: `color-mix(in srgb, ${app.tint} 15%, transparent)`,
                          color: app.tint,
                        }}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-soft)] truncate transition">
                            {app.label}
                          </span>
                          {live?.dot && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                          {live?.busy && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)] truncate">
                          {app.hint}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer Quick Controls */}
        <footer className="p-3 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] flex items-center justify-between text-xs">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                onOpenFormFactor();
                onClose();
              }}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title="Display Form Factor"
              aria-label="Display Form Factor"
            >
              <Monitor className="w-4 h-4 text-sky-400" />
            </button>
            <button
              onClick={() => applyTheme(nextTheme())}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title={`Skin: ${currentTheme()}`}
              aria-label={`Skin: ${currentTheme()}`}
            >
              <Palette className="w-4 h-4 text-pink-400" />
            </button>
            <button
              onClick={() => {
                onOpenWallpaper();
                onClose();
              }}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title="Change Desktop Wallpaper"
              aria-label="Change Desktop Wallpaper"
            >
              <ImageIcon className="w-4 h-4 text-emerald-400" />
            </button>
            <button
              onClick={onToggleTheme}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title="Toggle Dark/Light"
              aria-label="Toggle dark/light mode"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={onToggleFullscreen}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title="Fullscreen Kiosk Mode"
              aria-label="Fullscreen Kiosk Mode"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={() => {
              onLockKiosk();
              onClose();
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/30 transition"
            title="Lock Kiosk"
          >
            <Lock className="w-3.5 h-3.5" />
            <span className="text-[11px] font-medium">Standby</span>
          </button>

        </footer>
      </div>

      {contextMenu && (
        <div
          className="fixed z-[60] w-48 bg-[var(--bg-secondary)]/95 backdrop-blur-md border border-[var(--border-strong)] shadow-2xl rounded-xl overflow-hidden py-1.5 animate-scale-in"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
            onClick={() => {
              onOpenApp(contextMenu.appId);
              setContextMenu(null);
              onClose();
            }}
          >
            <Play className="w-3.5 h-3.5" />
            Open App
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
            onClick={() => {
              setPinned(prev => {
                const isPinned = prev.includes(contextMenu.appId);
                const next = isPinned ? prev.filter(id => id !== contextMenu.appId) : [...prev, contextMenu.appId];
                localStorage.setItem('shellb.kiosk.desktop', JSON.stringify(next));
                window.dispatchEvent(new CustomEvent('shellb-desktop-pinned', { detail: next }));
                return next;
              });
              setContextMenu(null);
            }}
          >
            {pinned.includes(contextMenu.appId) ? (
              <><PinOff className="w-3.5 h-3.5" /> Unpin from Desktop</>
            ) : (
              <><Pin className="w-3.5 h-3.5" /> Pin to Desktop</>
            )}
          </button>
        </div>
      )}

    </>
  );
}
