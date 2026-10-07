import { useState } from 'react';
import clsx from 'clsx';
import { APPS, type AppId } from '../components/apps';
import { Play, PinOff, Info } from 'lucide-react';
import { useEffect } from 'react';
import type { Status } from '../types';

interface Props {
  onOpenApp: (appId: AppId) => void;
  status?: Status;
}

// Pinned apps that have desktop shortcuts
const DESKTOP_APPS: AppId[] = [
  'chat',
  'studio',
  'code',
  'radio',
  'maps',
  'library',
  'notes',
  'codex',
  'research',
  'plans',
  'activity',
  'secretary',
  'models',
  'settings',
];

export function DesktopIcons({ onOpenApp, status }: Props) {
  
  const [selected, setSelected] = useState<AppId | null>(null);
  const [contextMenu, setContextMenu] = useState<{ appId: AppId; x: number; y: number } | null>(null);

  const [pinned, setPinned] = useState<AppId[]>(() => {
    try {
      const stored = localStorage.getItem('shellb.kiosk.desktop');
      if (stored) return JSON.parse(stored);
    } catch {}
    return DESKTOP_APPS;
  });

  useEffect(() => {
    const onClick = () => setContextMenu(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  const apps = pinned.map(id => APPS.find(a => a.id === id)!).filter(Boolean);


  return (
    <div
      className="p-6 grid grid-flow-col grid-rows-6 auto-cols-[96px] gap-4 select-none z-10"
      onClick={() => setSelected(null)}
    >
      {apps.map(app => {
        const Icon = app.icon;
        const live = app.live?.(status);
        const isSel = selected === app.id;

        return (
          <div
            key={app.id}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu({ appId: app.id, x: e.clientX, y: e.clientY });
              setSelected(app.id);
            }}
            onClick={e => {
              e.stopPropagation();
              setSelected(app.id);
            }}
            onDoubleClick={e => {
              e.stopPropagation();
              onOpenApp(app.id);
            }}
            onTouchEnd={e => {
              // On touch kiosk display, single touch or double tap opens
              e.stopPropagation();
              onOpenApp(app.id);
            }}
            className={clsx(
              'flex flex-col items-center justify-center p-2 rounded-xl cursor-pointer text-center group transition relative',
              isSel
                ? 'bg-[var(--accent)]/20 ring-1 ring-[var(--accent)]/50 backdrop-blur-sm'
                : 'hover:bg-white/5 active:bg-white/10'
            )}
          >
            {/* App Icon Container */}
            <div
              className="w-13 h-13 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-105 group-active:scale-95 relative"
              style={{
                background: `color-mix(in srgb, ${app.tint} 22%, var(--bg-secondary))`,
                border: `1px solid color-mix(in srgb, ${app.tint} 40%, var(--border-subtle))`,
                color: app.tint,
              }}
            >
              <Icon className="w-6 h-6 drop-shadow" />

              {/* Live Status Indicators */}
              {live?.dot && (
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-amber-500 border-2 border-[var(--bg-primary)] animate-pulse" />
              )}
              {live?.busy && (
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[var(--bg-primary)] animate-ping" />
              )}
              {live?.badge !== undefined && live.badge > 0 && (
                <span
                  className={clsx(
                    'absolute -top-1.5 -right-1.5 px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold leading-tight shadow',
                    live.urgent
                      ? 'bg-amber-500 text-black'
                      : 'bg-[var(--accent)] text-white'
                  )}
                >
                  {live.badge}
                </span>
              )}
            </div>

            {/* Label */}
            <span
              className={clsx(
                'text-[11px] font-medium tracking-tight mt-1.5 px-1.5 py-0.5 rounded max-w-[90px] truncate drop-shadow',
                isSel
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-primary)] group-hover:text-white'
              )}
            >
              {app.label}
            </span>
          </div>
        );
      })}
    
      {contextMenu && (
        <div
          className="fixed z-50 w-52 bg-[var(--bg-secondary)]/90 backdrop-blur-md border border-[var(--border-strong)] shadow-2xl rounded-xl overflow-hidden py-1.5 animate-scale-in"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
            onClick={() => {
              onOpenApp(contextMenu.appId);
              setContextMenu(null);
            }}
          >
            <Play className="w-3.5 h-3.5" />
            Open Application
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
            onClick={() => {
              setPinned(prev => {
                const next = prev.filter(id => id !== contextMenu.appId);
                localStorage.setItem('shellb.kiosk.desktop', JSON.stringify(next));
                // Dispatch event so Start Menu knows
                window.dispatchEvent(new CustomEvent('shellb-desktop-pinned', { detail: next }));
                return next;
              });
              setContextMenu(null);
            }}
          >
            <PinOff className="w-3.5 h-3.5" />
            Unpin from Desktop
          </button>
          <div className="h-px bg-[var(--border-subtle)] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex items-center gap-2"
            onClick={() => setContextMenu(null)}
          >
            <Info className="w-3.5 h-3.5" />
            Properties
          </button>
        </div>
      )}
    </div>

  );
}
