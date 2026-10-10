import { useMemo, useState, type SyntheticEvent } from 'react';
import clsx from 'clsx';
import { AppWindow, Boxes, CodeXml, FileCode2, FileText, GitFork, GripVertical, Image as ImageIcon, MessageSquare, Palette, Search, Star, Telescope, Workflow } from 'lucide-react';
import type { Agent } from '../types';
import { FAV_LABEL, favKey, reorderFavorites, setFavorite, useFavorites, useIsFavorite, type FavKind, type Favorite } from '../favorites';
import { ProjectGlyph } from './Projects';
import { AgentAvatar, btn, relTime } from './common';
import { t } from '../i18n';

const ART_ICON: Record<string, typeof Boxes> = { html: AppWindow, svg: ImageIcon, markdown: FileText, mermaid: GitFork, code: FileCode2 };

/** A star toggle for anything favoritable. `title` only fills the optimistic row until the server answers. */
export function FavoriteStar({ kind, id, sub = '', title, size = 14, className, always, nested }: {
  kind: FavKind; id: string; sub?: string; title?: string; size?: number; className?: string;
  always?: boolean; // keep visible when not starred (otherwise the caller's hover styles decide)
  nested?: boolean; // inside another <button>: render a span with button semantics instead
}) {
  const on = useIsFavorite(kind, id, sub);
  const toggle = (e: SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); setFavorite(kind, id, sub, !on, title); };
  const props = {
    'aria-pressed': on, 'aria-label': on ? 'Remove from Favorites' : 'Add to Favorites', title: on ? 'Remove from Favorites' : 'Add to Favorites',
    onClick: toggle,
    className: clsx('p-1 rounded shrink-0 transition cursor-pointer', on ? 'text-amber-400 hover:text-amber-300' : 'text-[var(--text-muted)] hover:text-amber-400', always && 'opacity-100', className),
  };
  const icon = <Star style={{ width: size, height: size }} className={clsx(on && 'fill-amber-400')} />;
  return nested
    ? <span role="button" tabIndex={0} {...props} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggle(e)}>{icon}</span>
    : <button type="button" {...props}>{icon}</button>;
}

export function FavIcon({ f, agents, size = 16 }: { f: Favorite; agents: Agent[]; size?: number }) {
  const s = { width: size, height: size };
  switch (f.kind) {
    case 'chat': return <AgentAvatar agent={agents.find(a => a.id === f.agentId)} size={size} />;
    case 'artifact': { const I = ART_ICON[f.type ?? ''] ?? Boxes; return <I style={s} className="text-[var(--accent)] shrink-0" />; }
    case 'project': return f.type === 'code' ? <CodeXml style={s} className="text-sky-400 shrink-0" /> : <Palette style={s} className="text-rose-400 shrink-0" />;
    case 'group': return <ProjectGlyph project={{ name: f.title, emoji: f.emoji ?? '' }} size={size} />;
    case 'research': return f.emoji ? <span className="shrink-0 text-center leading-none" style={{ width: size, fontSize: size * 0.85 }}>{f.emoji}</span> : <Telescope style={s} className="text-teal-400 shrink-0" />;
    case 'plan': return <Workflow style={s} className="text-violet-400 shrink-0" />;
  }
}

const ORDER: FavKind[] = ['chat', 'artifact', 'project', 'group', 'research', 'plan'];

/** `#/library/favorites`: everything starred, filterable by kind, drag to reorder. */
export function FavoritesPage({ agents }: { agents: Agent[] }) {
  const favs = useFavorites();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<FavKind | ''>('');
  const [drag, setDrag] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<FavKind, number>();
    favs.forEach(f => m.set(f.kind, (m.get(f.kind) ?? 0) + 1));
    return m;
  }, [favs]);
  const needle = q.trim().toLowerCase();
  const list = favs.filter(f => (!kind || f.kind === kind) && (!needle || `${f.title} ${f.subtitle}`.toLowerCase().includes(needle)));
  const canDrag = !needle && !kind;

  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const at = (k: string) => favs.findIndex(f => favKey(f.kind, f.ref, f.sub) === k);
    const next = [...favs];
    const [moved] = next.splice(at(drag), 1);
    next.splice(at(target), 0, moved); // lands after the target when moving down, before it when moving up
    reorderFavorites(next);
  };

  const chip = (k: FavKind | '', label: string, n: number) => (
    <button key={k || 'all'} onClick={() => setKind(k)}
      className={clsx('px-2 py-0.5 rounded-full text-[11px] border transition flex items-center gap-1.5',
        kind === k ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      {label}<span className="font-mono text-[10px] opacity-70">{n}</span>
    </button>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 animate-fade-in">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold tracking-tight flex-1 flex items-center gap-2"><Star className="w-5 h-5 text-amber-400 fill-amber-400" />{t('Favorites')}</h1>
          <a href="#/library" className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">{t('Library →')}</a>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-5">{t('Star chats, artifacts, Studio and Code projects, Projects, research notebooks and mega plans to keep them here. Drag to reorder.')}</p>

        <div className="relative mb-3">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search favorites')} />
        </div>
        {counts.size > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {chip('', 'All', favs.length)}
            {ORDER.filter(k => counts.has(k)).map(k => chip(k, FAV_LABEL[k], counts.get(k)!))}
          </div>
        )}

        {list.length === 0 ? (
          <div className="text-center py-16 text-sm text-[var(--text-muted)]">
            <Star className="w-8 h-8 mx-auto mb-2" />
            {favs.length ? t('Nothing matches.') : t('No favorites yet. Look for the ☆ on chats, artifacts, projects, notebooks and plans.')}
          </div>
        ) : (
          <ul className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            {list.map(f => {
              const k = favKey(f.kind, f.ref, f.sub);
              return (
                <li key={k} draggable={canDrag} onDragStart={() => setDrag(k)} onDragEnd={() => setDrag(null)}
                  onDragOver={e => { if (canDrag && drag) e.preventDefault(); }} onDrop={() => { drop(k); setDrag(null); }}
                  className={clsx('group flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--bg-hover)] transition', drag === k && 'opacity-40')}>
                  {canDrag && <GripVertical className="w-3.5 h-3.5 -mr-1 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 cursor-grab shrink-0" />}
                  <FavIcon f={f} agents={agents} size={18} />
                  <a href={f.href} className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{t(f.title)}</div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate flex items-center gap-1">
                      {f.kind === 'artifact' && <MessageSquare className="w-3 h-3 shrink-0" />}{t(f.subtitle)}
                    </div>
                  </a>
                  <span className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-muted)]">{FAV_LABEL[f.kind]}</span>
                  {f.updatedAt && <span className="hidden sm:inline text-[10px] font-mono text-[var(--text-muted)] w-16 text-right">{relTime(f.updatedAt)}</span>}
                  <FavoriteStar kind={f.kind} id={f.ref} sub={f.sub} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
