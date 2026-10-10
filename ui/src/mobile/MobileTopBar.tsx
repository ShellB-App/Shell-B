import { t } from '../i18n';
import { useState } from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  ChevronLeft,
  Menu,
  Monitor,
  Moon,
  MoreVertical,
  Palette,
  Search,
  Settings,
  SquarePen,
  Sun,
  Workflow,
  Sparkles,
} from 'lucide-react';
import type { Agent, ChatProject, Conversation, Status } from '../types';
import { AgentAvatar } from '../components/common';
import { ProjectGlyph } from '../components/Projects';
import { nextTheme, setTheme as applyTheme, currentTheme } from '../themes';

interface Props {
  agent: Agent;
  conv: Conversation | null;
  status?: Status;
  onOpenDrawer: () => void;
  onOpenAgentPicker: () => void;
  onNewChat: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenFormFactor: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  appTitle?: string;
  appIcon?: React.ReactNode;
  onBackFromApp?: () => void;
  group?: ChatProject;
  onOpenGroup?: (id?: string) => void;
}

export function MobileTopBar({
  agent,
  conv,
  status,
  onOpenDrawer,
  onOpenAgentPicker,
  onNewChat,
  onOpenPalette,
  onOpenSettings,
  onOpenFormFactor,
  theme,
  onToggleTheme,
  appTitle,
  appIcon,
  onBackFromApp,
  group,
  onOpenGroup,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const pendingApprovals = (status?.activity?.pending ?? 0) > 0;
  const unreadActivity = (status?.activity?.unread ?? 0) > 0;
  const hasBadge = pendingApprovals || unreadActivity;

  return (
    <header className="h-13 shrink-0 flex items-center justify-between px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/90 backdrop-blur-md relative z-30 select-none">
      {/* Left: Drawer Hamburger or Back button if inside an App */}
      <div className="flex items-center gap-1.5 shrink-0">
        {appTitle ? (
          <button
            onClick={onBackFromApp}
            className="flex items-center gap-1 py-1.5 px-2 rounded-xl text-xs font-medium text-[var(--accent-soft)] hover:bg-[var(--bg-hover)] transition"
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5 -ml-1 text-[var(--accent)]" />
            <span>Chat</span>
          </button>
        ) : (
          <button
            onClick={onOpenDrawer}
            className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition relative"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
            {hasBadge && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            )}
          </button>
        )}
      </div>

      {/* Center: Context info (Agent picker / Conversation title OR App Title) */}
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-1">
        {appTitle ? (
          <div className="flex items-center gap-1.5 min-w-0 max-w-full">
            {appIcon}
            <span className="text-xs font-semibold truncate text-[var(--text-primary)]">
              {appTitle}
            </span>
          </div>
        ) : (
          <div className="flex flex-col items-center max-w-full">
            <button
              onClick={onOpenAgentPicker}
              className="flex items-center gap-1.5 py-0.5 px-2 rounded-full hover:bg-[var(--bg-tertiary)] transition border border-transparent hover:border-[var(--border-subtle)] max-w-full"
            >
              <AgentAvatar agent={agent} size={16} />
              <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
                {agent.name}
              </span>
              <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
            </button>

            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] truncate max-w-full leading-tight">
              {group && (
                <button
                  onClick={() => onOpenGroup?.(group.id)}
                  className="hover:text-[var(--accent)] flex items-center gap-1 truncate"
                >
                  <ProjectGlyph project={group} size={10} />
                  <span className="truncate">{group.name}</span>
                  <span>/</span>
                </button>
              )}
              <span className="truncate">{!conv?.title || conv.title === 'New conversation' ? t('New conversation') : conv.title}</span>
            </div>
          </div>
        )}
      </div>

      {/* Right: New Chat & More menu */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onNewChat}
          className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          title="New chat"
          aria-label="New chat"
        >
          <SquarePen className="w-4 h-4" />
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
            title="Options"
            aria-label="More options"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {/* Quick options dropdown */}
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full mt-1 w-48 rounded-xl bg-[var(--bg-primary)] border border-[var(--border-subtle)] shadow-xl py-1.5 z-50 text-xs animate-scale-in">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenFormFactor();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
                >
                  <Monitor className="w-4 h-4 text-sky-400" />
                  <span>Form Factor…</span>
                </button>

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenPalette();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
                >
                  <Search className="w-4 h-4 text-[var(--text-muted)]" />
                  <span>Command Palette</span>
                </button>

                <div className="my-1 border-t border-[var(--border-subtle)]" />

                <button
                  onClick={() => {
                    applyTheme(nextTheme());
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
                >
                  <Palette className="w-4 h-4 text-pink-400" />
                  <span>Skin: {currentTheme()}</span>
                </button>

                <button
                  onClick={() => {
                    onToggleTheme();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
                >
                  {theme === 'dark' ? (
                    <Sun className="w-4 h-4 text-amber-400" />
                  ) : (
                    <Moon className="w-4 h-4 text-sky-400" />
                  )}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>

                <div className="my-1 border-t border-[var(--border-subtle)]" />

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
                >
                  <Settings className="w-4 h-4 text-[var(--text-muted)]" />
                  <span>Settings & System</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
