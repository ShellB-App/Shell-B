import { useState, useEffect } from 'react';
import clsx from 'clsx';
import {
  Edit2,
  FolderInput,
  FolderKanban,
  Monitor,
  Moon,
  Palette,
  Pin,
  Plus,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { Agent, ChatProject, ConversationSummary, Status } from '../types';
import { AgentAvatar } from '../components/common';
import { ProjectGlyph } from '../components/Projects';
import { setFormFactor } from '../formFactor';
import { nextTheme, setTheme as applyTheme, currentTheme } from '../themes';

interface Props {
  open: boolean;
  onClose: () => void;
  conversations: ConversationSummary[];
  activeId?: string;
  agents: Agent[];
  status?: Status;
  onSelect: (id: string) => void;
  onNew: (agentId?: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  groups: ChatProject[];
  activeGroupId?: string;
  onOpenGroup: (id?: string) => void;
  onNewGroup: () => void;
  onOpenSettings: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function bucket(ts: number) {
  const d = new Date(ts),
    now = new Date();
  const day = 86400000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return 'Today';
  if (ts >= startToday - day) return 'Yesterday';
  if (ts >= startToday - 7 * day) return 'Previous 7 days';
  if (ts >= startToday - 30 * day) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function MobileDrawer({
  open,
  onClose,
  conversations,
  activeId,
  agents,
  status,
  onSelect,
  onNew,
  onDelete,
  onPin,
  onRename,
  groups: projectGroups,
  activeGroupId,
  onOpenGroup,
  onNewGroup,
  onOpenSettings,
  theme,
  onToggleTheme,
}: Props) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [showProjects, setShowProjects] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ('');
      setEditing(null);
      setConfirmDel(null);
    }
  }, [open]);

  const list = conversations.filter(c => c.title.toLowerCase().includes(q.toLowerCase()));
  const pinned = list.filter(c => c.pinned);
  const buckets: [string, ConversationSummary[]][] = [];
  for (const c of list.filter(c => !c.pinned)) {
    const b = bucket(c.updatedAt);
    const g = buckets.find(x => x[0] === b);
    if (g) g[1].push(c);
    else buckets.push([b, [c]]);
  }

  const renderItem = (c: ConversationSummary) => {
    const agent = agents.find(a => a.id === c.agentId);
    const active = c.id === activeId;
    return (
      <div
        key={c.id}
        onClick={() => {
          if (editing !== c.id) {
            onSelect(c.id);
            onClose();
          }
        }}
        className={clsx(
          'group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer text-xs transition',
          active
            ? 'bg-[var(--accent)]/15 text-[var(--text-primary)] font-medium border border-[var(--accent)]/30'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        )}
      >
        <AgentAvatar agent={agent} size={18} />
        {editing === c.id ? (
          <input
            value={draft}
            autoFocus
            onClick={e => e.stopPropagation()}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                onRename(c.id, draft.trim() || c.title);
                setEditing(null);
              }
              if (e.key === 'Escape') setEditing(null);
            }}
            onBlur={() => {
              onRename(c.id, draft.trim() || c.title);
              setEditing(null);
            }}
            className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-strong)] rounded px-1.5 py-0.5 text-xs text-[var(--text-primary)] focus:outline-none"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate">{c.title}</span>
        )}

        {c.pinned && !editing && (
          <Pin className="w-3 h-3 text-[var(--accent)] shrink-0 fill-current opacity-70" />
        )}

        {/* Action icons */}
        <div
          className="flex items-center gap-1 shrink-0"
          onClick={e => e.stopPropagation()}
        >
          {confirmDel === c.id ? (
            <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded-md border border-rose-500/40">
              <span className="text-[10px] text-rose-400">Delete?</span>
              <button
                onClick={() => {
                  onDelete(c.id);
                  setConfirmDel(null);
                }}
                className="text-[10px] font-semibold text-rose-500 hover:underline px-0.5"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDel(null)}
                className="text-[10px] text-[var(--text-muted)] hover:underline px-0.5"
              >
                No
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 opacity-80 sm:opacity-0 group-hover:opacity-100 transition">
              <button
                onClick={() => onPin(c.id, !c.pinned)}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title={c.pinned ? 'Unpin' : 'Pin'}
                aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
              >
                <Pin className={clsx('w-3 h-3', c.pinned && 'fill-current text-[var(--accent)]')} />
              </button>
              <button
                onClick={() => {
                  setDraft(c.title);
                  setEditing(c.id);
                }}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title="Rename"
                aria-label="Rename conversation"
              >
                <Edit2 className="w-3 h-3" />
              </button>
              <button
                onClick={() => setConfirmDel(c.id)}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-rose-400"
                title="Delete"
                aria-label="Delete conversation"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/65 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[85vw] max-w-[340px] h-full bg-[var(--bg-primary)] border-r border-[var(--border-subtle)] flex flex-col overflow-hidden animate-slide-right pb-[env(safe-area-inset-bottom)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <header className="h-14 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent-soft)] font-bold font-mono text-sm">
              S:B
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                Shell:B
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">DGX Spark AI Workstation</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* New Chat & Agent Carousel */}
        <div className="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] shrink-0 space-y-2.5">
          <button
            onClick={() => {
              onNew();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-[var(--accent)] hover:brightness-110 text-[var(--accent-fg)] text-xs font-semibold shadow-sm transition"
          >
            <SquarePen className="w-4 h-4" />
            <span>New Chat</span>
          </button>

          {/* Quick agent launch row */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5 scrollbar-none">
            {agents.map(a => (
              <button
                key={a.id}
                onClick={() => {
                  onNew(a.id);
                  onClose();
                }}
                title={`New chat with ${a.name}`}
                aria-label={`New chat with ${a.name}`}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] shrink-0 transition"
              >
                <AgentAvatar agent={a} size={15} />
                <span className="text-[11px] font-medium text-[var(--text-primary)]">{a.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-[var(--border-subtle)] shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search chats…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* Projects / Groups section */}
        <div className="border-b border-[var(--border-subtle)] shrink-0 px-3 py-2 bg-[var(--bg-secondary)]/50">
          <div
            onClick={() => setShowProjects(s => !s)}
            className="flex items-center justify-between text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider cursor-pointer hover:text-[var(--text-primary)] transition py-1"
          >
            <div className="flex items-center gap-1.5">
              <FolderKanban className="w-3.5 h-3.5 text-sky-400" />
              <span>Projects ({projectGroups.length})</span>
            </div>
            <button
              onClick={e => {
                e.stopPropagation();
                onNewGroup();
                onClose();
              }}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              title="New project"
              aria-label="New project"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {showProjects && (
            <div className="mt-1 space-y-1 pb-1">
              <button
                onClick={() => {
                  onOpenGroup();
                  onClose();
                }}
                className={clsx(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition text-left',
                  activeGroupId === ''
                    ? 'bg-[var(--accent)]/15 text-[var(--accent-soft)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                <FolderKanban className="w-3.5 h-3.5 text-sky-400" />
                <span>All Projects</span>
              </button>

              {projectGroups.map(g => (
                <button
                  key={g.id}
                  onClick={() => {
                    onOpenGroup(g.id);
                    onClose();
                  }}
                  className={clsx(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition text-left',
                    activeGroupId === g.id
                      ? 'bg-[var(--accent)]/15 text-[var(--accent-soft)] font-medium'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  <ProjectGlyph project={g} size={15} />
                  <span className="truncate flex-1">{g.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {pinned.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] px-2">
                Pinned
              </div>
              <div className="space-y-1">{pinned.map(renderItem)}</div>
            </div>
          )}

          {buckets.map(([label, items]) => (
            <div key={label} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] px-2">
                {label}
              </div>
              <div className="space-y-1">{items.map(renderItem)}</div>
            </div>
          ))}

          {list.length === 0 && (
            <div className="text-center py-8 text-xs text-[var(--text-muted)]">
              {q ? 'No matching conversations' : 'No conversations yet'}
            </div>
          )}
        </div>

        {/* Bottom Drawer Footer */}
        <footer className="shrink-0 p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
          <div className="flex items-center justify-between text-xs">
            <button
              onClick={() => {
                setFormFactor('standard');
                onClose();
              }}
              className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
              title="Switch to Desktop view"
            >
              <Monitor className="w-3.5 h-3.5 text-sky-400" />
              <span>Desktop View</span>
            </button>

            <div className="flex items-center gap-1">
              <button
                onClick={() => applyTheme(nextTheme())}
                className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title={`Skin: ${currentTheme()}`}
                aria-label={`Change theme skin, current skin: ${currentTheme()}`}
              >
                <Palette className="w-4 h-4 text-pink-400" />
              </button>
              <button
                onClick={onToggleTheme}
                className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title="Toggle Dark/Light"
                aria-label="Toggle dark/light mode"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                onClick={() => {
                  onOpenSettings();
                  onClose();
                }}
                className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title="Settings"
                aria-label="Open settings"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
