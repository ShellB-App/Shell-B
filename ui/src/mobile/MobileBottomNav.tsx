import clsx from 'clsx';
import {
  Clock,
  Grid,
  Inbox,
  MessageSquare,
  Settings,
} from 'lucide-react';
import type { Status } from '../types';
import { t } from '../i18n';

export type MobileTab = 'chat' | 'recents' | 'apps' | 'activity' | 'more';

interface Props {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  status?: Status;
}

export function MobileBottomNav({ activeTab, onTabChange, status }: Props) {
  const pending = status?.activity?.pending ?? 0;
  const unread = status?.activity?.unread ?? 0;
  const totalActivity = pending + unread;

  const TABS: { id: MobileTab; label: string; icon: typeof MessageSquare; badge?: number; urgent?: boolean }[] = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'recents', label: 'Recents', icon: Clock },
    { id: 'apps', label: 'Apps', icon: Grid },
    {
      id: 'activity',
      label: 'Activity',
      icon: Inbox,
      badge: totalActivity > 0 ? totalActivity : undefined,
      urgent: pending > 0,
    },
    { id: 'more', label: 'More', icon: Settings },
  ];

  return (
    <nav className="shrink-0 bg-[var(--bg-secondary)]/95 backdrop-blur-md border-t border-[var(--border-subtle)] pb-[env(safe-area-inset-bottom)] z-30 select-none">
      <div className="h-13 flex items-center justify-around px-2">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={clsx(
                'flex-1 flex flex-col items-center justify-center py-1 rounded-xl transition relative touch-manipulation',
                active
                  ? 'text-[var(--accent-soft)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <div className="relative">
                <Icon className={clsx('w-5 h-5 transition-transform', active && 'scale-110')} />
                {tab.badge !== undefined && (
                  <span
                    className={clsx(
                      'absolute -top-1 -right-2 px-1 py-0.2 min-w-4 text-center rounded-full text-[9px] font-mono leading-tight font-bold',
                      tab.urgent
                        ? 'bg-amber-500 text-black animate-pulse'
                        : 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    )}
                  >
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className={clsx('text-[10px] mt-0.5 tracking-tight', active ? 'font-semibold' : 'font-normal')}>
                {t(tab.label)}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
