import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Edit2, EyeOff, FolderInput, FolderKanban, GitFork, Loader2, PanelLeftClose, Pin, Plus, Search, Settings, SquarePen, Star, Trash2, X } from 'lucide-react';
import type { Agent, ChatHit, ChatProject, ConversationSummary, Status } from '../types';
import { ProjectGlyph } from './Projects';
import { fmtBytes } from '../api';
import { AgentAvatar, Snippet } from './common';
import { refreshFavorites, useFavorites } from '../favorites';
import { FavIcon, FavoriteStar } from './Favorites';
import { req } from '../api';
import { jumpToMessage } from '../jump';

interface Props {
  conversations: ConversationSummary[];
  activeId?: string;
  agents: Agent[];
  status?: Status;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** a chat that isn't remembered and is deleted after 24 h (components/Incognito.tsx) */
  onNewIncognito?: () => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: () => void;
  favoritesActive?: boolean;
  groups: ChatProject[];
  activeGroupId?: string; // '' = the projects index
  onOpenGroup: (id?: string) => void;
  onNewGroup: () => void;
  onMoveToGroup: (convId: string, groupId: string | null) => void;
  onFork?: (id: string) => void;
}

function bucket(ts: number) {
  const d = new Date(ts), now = new Date();
  const day = 86400000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return 'Today';
  if (ts >= startToday - day) return 'Yesterday';
  if (ts >= startToday - 7 * day) return 'Previous 7 days';
  if (ts >= startToday - 30 * day) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function Sidebar(p: Props) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [hits, setHits] = useState<ChatHit[]>([]);
  useEffect(() => {  // search inside messages too, once the query settles
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    const t = setTimeout(() => req<{ results: ChatHit[] }>(`/api/chats/search?q=${encodeURIComponent(term)}&limit=12`)
      .then(r => setHits(r.results)).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  const favs = useFavorites();
  useEffect(() => { refreshFavorites(); }, [p.conversations, p.groups]); // pick up renames and deletions
  const favList = favs.filter(f => `${f.title} ${f.subtitle}`.toLowerCase().includes(q.toLowerCase()));
  const activeHref = typeof location !== 'undefined' ? location.hash : '';

  const list = p.conversations.filter(c => c.title.toLowerCase().includes(q.toLowerCase()));
  const pinned = list.filter(c => c.pinned);
  const groups: [string, ConversationSummary[]][] = [];
  for (const c of list.filter(c => !c.pinned)) {
    const b = bucket(c.updatedAt);
    const g = groups.find(x => x[0] === b);
    if (g) g[1].push(c); else groups.push([b, [c]]);
  }

  const services = p.status?.services ?? {};
  const svcOrder = ['ollama', 'searxng', 'sandbox', 'nyx', 'orpheus', 'hermes', 'embeddings'];
  const svcLabel: Record<string, string> = { ollama: 'Ollama', searxng: 'VASSAGO search', sandbox: 'Code sandbox', nyx: 'NYX images', orpheus: 'ORPHEUS music', hermes: 'HERMES voice', stableaudio: 'Stable Audio', embeddings: 'Memory embeddings' };
  const down = svcOrder.filter(s => services[s] && !services[s].ok);
  const mem = p.status?.memory;
  const usedPct = mem ? Math.round((1 - mem.MemAvailable / mem.MemTotal) * 100) : 0;

  const item = (c: ConversationSummary) => {
    const agent = p.agents.find(a => a.id === c.agentId);
    const active = c.id === p.activeId;
    return (
      <div key={c.id}
        className={clsx('group relative flex items-center gap-2 pl-2 pr-1 py-1.5 rounded-lg cursor-pointer text-[13px] transition',
          active ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]')}
        onClick={() => editing !== c.id && p.onSelect(c.id)}
      >
        <AgentAvatar agent={agent} size={16} />
        {editing === c.id ? (
          <input value={draft} autoFocus onClick={e => e.stopPropagation()} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { p.onRename(c.id, draft.trim() || c.title); setEditing(null); } if (e.key === 'Escape') setEditing(null); }}
            onBlur={() => { if (draft.trim()) p.onRename(c.id, draft.trim()); setEditing(null); }}
            className="flex-1 min-w-0 bg-[var(--bg-primary)] px-1 rounded border border-[var(--accent)] focus:outline-none text-[13px]" />
        ) : (
          <span className="flex-1 min-w-0 truncate">{c.title}</span>
        )}
        {c.incognito && editing !== c.id && (
          <span title="Incognito: not remembered, deleted after 24 h" className="shrink-0"><EyeOff className="w-3 h-3 text-slate-500 dark:text-slate-400" aria-label="Incognito" /></span>
        )}
        {c.groupId && editing !== c.id && <span title={p.groups.find(g => g.id === c.groupId)?.name}><ProjectGlyph project={p.groups.find(g => g.id === c.groupId)} size={14} /></span>}
        {c.streaming && <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)] shrink-0" />}
        {editing !== c.id && (
          confirmDel === c.id ? (
            <span className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
              <button className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 hover:bg-red-500/30" onClick={() => { p.onDelete(c.id); setConfirmDel(null); }}>Delete</button>
              <button className="px-1.5 py-0.5 rounded text-[10px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(null)}>Keep</button>
            </span>
          ) : (
            <span className="hidden group-hover:flex focus-within:flex items-center shrink-0" onClick={e => e.stopPropagation()}>
              <FavoriteStar kind="chat" id={c.id} title={c.title} size={12} />
              <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)]" title={c.pinned ? 'Unpin' : 'Pin'} onClick={() => p.onPin(c.id, !c.pinned)}>
                <Pin className={clsx('w-3 h-3', c.pinned && 'fill-[var(--accent)] text-[var(--accent)]')} />
              </button>
              {!c.incognito && (
                <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Move to project" onClick={() => setMoving(moving === c.id ? null : c.id)}>
                  <FolderInput className="w-3 h-3" />
                </button>
              )}
              {p.onFork && (
                <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Fork chat" onClick={() => p.onFork?.(c.id)}>
                  <GitFork className="w-3 h-3" />
                </button>
              )}
              <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Rename" onClick={() => { setEditing(c.id); setDraft(c.title); }}>
                <Edit2 className="w-3 h-3" />
              </button>
              <button className="p-1 rounded text-[var(--text-muted)] hover:text-red-400" title="Delete" onClick={() => setConfirmDel(c.id)}>
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          )
        )}
        {moving === c.id && (
          <div className="absolute right-1 top-full mt-0.5 z-50 w-52 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1"
            onClick={e => e.stopPropagation()} onMouseLeave={() => setMoving(null)}>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Move to project</div>
            {p.groups.map(g => (
              <button key={g.id} disabled={g.id === c.groupId} onClick={() => { p.onMoveToGroup(c.id, g.id); setMoving(null); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--bg-hover)] disabled:opacity-50">
                <ProjectGlyph project={g} size={16} /><span className="truncate">{g.name}</span>
              </button>
            ))}
            {p.groups.length === 0 && <div className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">No projects yet</div>}
            {c.groupId && (
              <button onClick={() => { p.onMoveToGroup(c.id, null); setMoving(null); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left hover:bg-[var(--bg-hover)] border-t border-[var(--border-subtle)] mt-1">
                <X className="w-3.5 h-3.5" />Remove from project
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {p.open && <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={p.onClose} />}
      <aside className={clsx('sf-sidebar flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] z-40 transition-all duration-200',
        'fixed md:static inset-y-0 left-0 w-72 md:w-64',
        p.open ? 'translate-x-0' : '-translate-x-full md:hidden')}>
        <div className="p-3 space-y-2.5">
          <div className="flex items-center justify-between h-7">
            <div className="flex items-center gap-2">
              <span className="sf-brand font-semibold tracking-tight text-[var(--brand-soft)]">Shell:B</span>
            </div>
            <button onClick={p.onClose} className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]" title="Hide sidebar (Ctrl+B)">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-stretch gap-2">
            <button onClick={p.onNew} className="flex-1 min-w-0 flex items-center justify-between px-3 py-2 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white text-sm font-medium transition shadow-md">
              <span className="flex items-center gap-2"><SquarePen className="w-4 h-4" />New chat</span>
              <kbd className="text-[10px] opacity-75 font-mono hidden md:inline">Ctrl ⇧ O</kbd>
            </button>
            {p.onNewIncognito && (
              <button onClick={p.onNewIncognito} title="New incognito chat: not remembered, deleted after 24 h" aria-label="New incognito chat"
                className="shrink-0 px-2.5 rounded-xl border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60 transition">
                <EyeOff className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats, messages and favorites"
              className="w-full pl-8 pr-2.5 py-1.5 text-[13px] rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/60" />
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-4" aria-label="Conversations">
          {(favs.length > 0 || p.favoritesActive) && (
            <div>
              <a href="#/library/favorites" onClick={() => window.innerWidth < 768 && p.onClose()}
                className={clsx('sf-label px-2 py-1 text-[11px] font-medium flex items-center gap-1 hover:text-[var(--text-primary)]', p.favoritesActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>
                <Star className="w-3 h-3" />Favorites
              </a>
              {favList.slice(0, 8).map(f => (
                <a key={`${f.kind}:${f.ref}:${f.sub}`} href={f.href} title={f.subtitle ? `${f.title} · ${f.subtitle}` : f.title}
                  onClick={() => window.innerWidth < 768 && p.onClose()}
                  className={clsx('group flex items-center gap-2 pl-2 pr-1 py-1.5 rounded-lg text-[13px] transition',
                    activeHref === f.href || (f.kind === 'chat' && f.ref === p.activeId) ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]')}>
                  <FavIcon f={f} agents={p.agents} />
                  <span className="flex-1 min-w-0 truncate">{f.title}</span>
                  <FavoriteStar kind={f.kind} id={f.ref} sub={f.sub} size={12} className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
                </a>
              ))}
              {favList.length > 8 && <a href="#/library/favorites" className="block pl-8 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">All {favList.length} favorites…</a>}
              {q && favs.length > 0 && favList.length === 0 && <div className="pl-8 py-1 text-[11px] text-[var(--text-muted)]">No matching favorites</div>}
            </div>
          )}
          <div>
            <div className="flex items-center justify-between pr-1">
              <button onClick={() => p.onOpenGroup()} className={clsx('sf-label px-2 py-1 text-[11px] font-medium flex items-center gap-1 hover:text-[var(--text-primary)]', p.activeGroupId === '' ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>
                <FolderKanban className="w-3 h-3" />Projects
              </button>
              <button onClick={p.onNewGroup} className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]" title="New project"><Plus className="w-3.5 h-3.5" /></button>
            </div>
            {p.groups.slice(0, 6).map(g => (
              <button key={g.id} onClick={() => p.onOpenGroup(g.id)}
                className={clsx('w-full flex items-center gap-2 pl-2 pr-2 py-1.5 rounded-lg text-[13px] text-left transition',
                  p.activeGroupId === g.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]')}>
                <ProjectGlyph project={g} size={16} />
                <span className="flex-1 min-w-0 truncate">{g.name}</span>
                {!!g.chatCount && <span className="text-[10px] text-[var(--text-muted)] font-mono">{g.chatCount}</span>}
              </button>
            ))}
            {p.groups.length > 6 && <button onClick={() => p.onOpenGroup()} className="w-full text-left pl-8 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">All {p.groups.length} projects…</button>}
            {p.groups.length === 0 && <button onClick={p.onNewGroup} className="w-full text-left pl-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">+ Group chats, files and instructions</button>}
          </div>
          {pinned.length > 0 && (
            <div>
              <div className="sf-label px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] flex items-center gap-1"><Pin className="w-3 h-3" />Pinned</div>
              {pinned.map(item)}
            </div>
          )}
          {groups.map(([label, cs]) => (
            <div key={label}>
              <div className="sf-label px-2 py-1 text-[11px] font-medium text-[var(--text-muted)]">{label}</div>
              {cs.map(item)}
            </div>
          ))}
          {hits.length > 0 && (
            <div>
              <div className="sf-label px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] flex items-center gap-1"><Search className="w-3 h-3" />In messages</div>
              {hits.map(h => (
                <a key={h.convId} href={h.href} title={h.title}
                  onClick={() => { if (h.hits[0]) jumpToMessage(h.hits[0].msgId); if (window.innerWidth < 768) p.onClose(); }}
                  className={clsx('block pl-2 pr-1.5 py-1.5 rounded-lg transition', h.convId === p.activeId ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-tertiary)]')}>
                  <div className="flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)]">
                    <span className="flex-1 min-w-0 truncate">{h.title}</span>
                    {h.where !== 'Chat' && <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{h.where}</span>}
                  </div>
                  {h.hits[0] && <div className="text-[11px] leading-snug text-[var(--text-muted)] line-clamp-2"><Snippet text={h.hits[0].snippet} /></div>}
                </a>
              ))}
            </div>
          )}
          {list.length === 0 && !hits.length && <div className="text-xs text-[var(--text-muted)] text-center py-8">{q ? 'No matches' : 'No conversations yet'}</div>}
        </nav>

        <div className="p-2 border-t border-[var(--border-subtle)] space-y-0.5">
          <button onClick={p.onOpenSettings} className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--bg-hover)] group" title="System status">
            <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1.5">
                <span className={clsx('w-1.5 h-1.5 rounded-full', !p.status ? 'bg-neutral-500' : down.length ? 'bg-amber-400' : 'bg-emerald-400')} />
                {!p.status ? 'Connecting…' : down.length ? `${down.length} service${down.length > 1 ? 's' : ''} offline` : 'All systems local'}
              </span>
              <Settings className="w-3.5 h-3.5 group-hover:text-[var(--text-primary)]" />
            </div>
            {mem && (
              <div className="mt-1.5">
                <div className="h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                  <div className={clsx('h-full rounded-full', usedPct > 88 ? 'bg-red-400' : usedPct > 75 ? 'bg-amber-400' : 'bg-[var(--accent)]')} style={{ width: `${usedPct}%` }} />
                </div>
                <div className="mt-1 text-[10px] font-mono text-[var(--text-muted)] whitespace-nowrap">
                  {fmtBytes(mem.MemTotal - mem.MemAvailable)} of {fmtBytes(mem.MemTotal)} unified memory
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate" title="Loaded models">
                  {p.status?.loaded.map(m => m.name.replace('ShellB-', '').replace(/:latest$/, '')).join(' · ') || 'No models loaded'}
                </div>
              </div>
            )}
            {down.length > 0 && <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400/90 truncate">{down.map(s => svcLabel[s]).join(', ')}</div>}
          </button>
        </div>
      </aside>
    </>
  );
}
