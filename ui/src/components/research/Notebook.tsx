import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft, Check, Download, ExternalLink, Loader2, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Plus, Search, Telescope, Trash2,
} from 'lucide-react';
import { api } from '../../api';
import type { Agent, ResearchBoard, ResearchBoardDetail, ResearchItem, StudioType } from '../../types';
import { AgentAvatar, Modal, btn, relTime } from '../common';
import { FavoriteStar } from '../Favorites';
import { isFavorite } from '../../favorites';
import { NotebookChat, type ChatHandle } from './Chat';
import { AddSourcesModal, DiscoverModal, SourcesPanel } from './Sources';
import { StudioPanel } from './Studio';
import { OutputBody } from './Viewers';
import { NotebookCtx, STUDIO_META, useConfirmDelete, type NotebookApi } from './shared';
import { t as tx } from '../../i18n';

const researchAgentsOf = (agents: Agent[]) => {
  const able = agents.filter(a => a.tools?.includes('research_board'));
  return able.length ? able : agents.filter(a => a.id === 'minerva');
};

function DeepResearchModal({ open, onClose, d, agents, activeConvs, onAsk, onOpenChat }: {
  open: boolean; onClose: () => void; d: ResearchBoardDetail; agents: Agent[]; activeConvs: string[];
  onAsk: (agentId: string, text: string) => void; onOpenChat: (id: string) => void;
}) {
  const able = researchAgentsOf(agents);
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState(able[0]?.id ?? 'minerva');
  useEffect(() => { if (open) setText(d.question || ''); }, [open, d.question]);
  return (
    <Modal open={open} onClose={onClose} title={tx('Deep research')} icon={<Telescope className="w-4 h-4 text-teal-500" />}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <p className="text-[13px] text-[var(--text-secondary)]">
          {tx('Minerva searches the web, reads what she finds and adds the useful pages to this notebook as sources, with findings and a cited report. She can also read the sources already here. It takes a few minutes and runs in its own chat.')}
        </p>
        <textarea autoFocus className={clsx(btn.input, 'min-h-[110px]')} value={text} onChange={e => setText(e.target.value)}
          placeholder={tx('What should she research?')} />
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-[var(--text-muted)]" htmlFor="dr-agent">{tx('Agent')}</label>
          <select id="dr-agent" value={agentId} onChange={e => setAgentId(e.target.value)} className={clsx(btn.input, '!w-auto !py-1 text-[13px]')}>
            {able.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {d.conversations.length > 0 && (
          <div>
            <div className="text-[11px] font-medium text-[var(--text-muted)] mb-1">{tx('Research chats on this notebook')}</div>
            {d.conversations.map(c => (
              <button key={c.id} onClick={() => onOpenChat(c.id)} className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--bg-secondary)] text-left">
                <AgentAvatar agent={agents.find(a => a.id === c.agentId)} size={18} />
                <span className="flex-1 truncate text-[13px]">{tx(c.title)}</span>
                {activeConvs.includes(c.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-500" /> : <span className="text-[10.5px] text-[var(--text-muted)]">{relTime(c.updatedAt)}</span>}
                <ExternalLink className="w-3 h-3 text-[var(--text-muted)]" />
              </button>
            ))}
          </div>
        )}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
        <button className={btn.ghost} onClick={onClose}>{tx('Cancel')}</button>
        <button className={clsx(btn.primary, '!bg-teal-600')} disabled={!text.trim()} onClick={() => { onAsk(agentId, text.trim()); onClose(); }}>
          <Telescope className="w-3.5 h-3.5" />{tx('Start research')}
        </button>
      </footer>
    </Modal>
  );
}

type Tab = 'sources' | 'chat' | 'studio';

export function ResearchBoardView({ boardId, agents, activeConvs, onBack, onOpenChat, onAsk }: {
  boardId: string; agents: Agent[]; activeConvs: string[];
  onBack: () => void; onOpenChat: (convId: string) => void; onAsk: (boardId: string, agentId: string, text: string) => void;
}) {
  const [d, setD] = useState<ResearchBoardDetail | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState<{ id: string; highlight?: string } | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);   // output id, or 'report'
  const [adding, setAdding] = useState(false);
  const [discover, setDiscover] = useState(false);
  const [deep, setDeep] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const [menu, setMenu] = useState(false);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [armed, setArmed] = useConfirmDelete();
  const chat = useRef<ChatHandle>(null);
  const stamp = useRef('');

  const load = useCallback(() => api.researchBoard(boardId).then(b => {
    const mark = `${b.updatedAt}|${b.items.map(i => `${i.id}:${i.updatedAt}`).join(',')}|${JSON.stringify(b.guide)}`;
    if (mark !== stamp.current) { stamp.current = mark; setD(b); }
    setError('');
  }).catch(e => setError(String(e))), [boardId]);

  useEffect(() => { stamp.current = ''; setD(null); load(); }, [load]);
  useEffect(() => {  // deep links: …/add (a brand-new notebook), …/view/<output>, …/source/<source>
    const m = /\/(add|view|source)(?:\/([\w-]+))?$/.exec(location.hash);
    if (!m) return;
    if (m[1] === 'add') setAdding(true);
    else if (m[1] === 'view' && m[2]) setViewer(m[2]);
    else if (m[1] === 'source' && m[2]) { setSource({ id: m[2] }); setTab('sources'); }
    history.replaceState(null, '', `#/research/${boardId}`);
  }, [boardId]);
  const busy = !!d && (d.conversations.some(c => activeConvs.includes(c.id))
    || d.items.some(i => ['pending', 'indexing'].includes(i.meta.index ?? '') || ['queued', 'generating', 'voicing'].includes(i.meta.status ?? ''))
    || (d.items.some(i => i.kind === 'source' && i.meta.index === 'ready') && !d.guide?.summary));
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, busy ? 2500 : 12000);
    return () => clearInterval(t);
  }, [load, busy]);

  const nb: NotebookApi | null = useMemo(() => d && ({
    d, agents,
    sourceByRef: new Map(d.items.filter(i => i.kind === 'source' && i.ref !== null).map(i => [i.ref!, i])),
    reload: () => { stamp.current = ''; load(); },
    openSource: (id, highlight) => { setSource({ id, highlight }); setLeft(true); setTab('sources'); setViewer(null); },
    ask: text => { setViewer(null); setTab('chat'); chat.current?.ask(text); },
    saveNote: async (title, body) => { await api.addResearchItem(d.id, { kind: 'note', title, body }); stamp.current = ''; load(); },
  }), [d, agents, load]);

  if (error && !d) return <div className="p-8 text-sm text-rose-500">{error.includes('404') ? tx('This notebook no longer exists.') : error}</div>;
  if (!d || !nb) return <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;

  const live = d.conversations.find(c => activeConvs.includes(c.id));
  const srcCount = d.items.filter(i => i.kind === 'source').length;
  const viewed: ResearchItem | null = viewer === 'report'
    ? { id: 'report', kind: 'output', ref: null, title: 'Minerva’s research report', body: d.summary, url: '', meta: { type: 'report' }, pinned: false,
        addedBy: 'agent:minerva', convId: null, createdAt: d.updatedAt, updatedAt: d.updatedAt }
    : d.items.find(i => i.id === viewer) ?? null;
  const commitTitle = async () => {
    if (editTitle !== null && editTitle.trim() && editTitle !== d.title) { await api.patchResearchBoard(d.id, { title: editTitle.trim() }); nb.reload(); }
    setEditTitle(null);
  };
  const remove = async () => {
    if (armed !== 'nb') { setArmed('nb'); return; }
    await api.deleteResearchBoard(d.id); onBack();
  };

  const head = (label: string, collapse?: () => void, Icon?: typeof PanelLeftClose, extra?: React.ReactNode) => (
    <div className={clsx('shrink-0 h-11 items-center gap-1 px-3 border-b border-[var(--border-subtle)]', label === 'Chat' ? 'hidden lg:flex' : 'flex')}>
      <span className="text-[13px] font-semibold flex-1">{label}</span>{extra}
      {collapse && Icon && <button className={clsx(btn.icon, 'hidden lg:inline-flex')} onClick={collapse} aria-label={tx('Collapse {label}', { label: label })}><Icon className="w-4 h-4" /></button>}
    </div>
  );
  const pane = 'min-h-0 flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] overflow-hidden';

  return (
    <NotebookCtx.Provider value={nb}>
      <div className="h-full flex flex-col min-h-0 bg-[var(--bg-secondary)]/40">
        {/* top bar */}
        <div className="shrink-0 flex items-center gap-2 px-3 sm:px-4 h-14">
          <button className={btn.icon} onClick={onBack} aria-label={tx('All notebooks')}><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-2xl leading-none" aria-hidden>{d.emoji || '📓'}</span>
          {editTitle !== null ? (
            <input autoFocus className={clsx(btn.input, '!text-[17px] font-semibold max-w-xl')} value={editTitle} onChange={e => setEditTitle(e.target.value)}
              onBlur={commitTitle} onKeyDown={e => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditTitle(null); }} />
          ) : (
            <button onClick={() => setEditTitle(d.title)} className="min-w-0 text-left text-[17px] font-semibold tracking-tight truncate hover:text-teal-600 dark:hover:text-teal-300" title={tx('Rename')}>
              {tx(d.title)}
            </button>
          )}
          <FavoriteStar kind="research" id={d.id} title={tx(d.title)} />
          {live && (
            <button onClick={() => onOpenChat(live.id)} className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-teal-500/10 text-teal-700 dark:text-teal-300 border border-teal-500/30">
              <span className="relative flex w-1.5 h-1.5"><span className="absolute inset-0 rounded-full bg-teal-400 animate-ping" /><span className="relative w-1.5 h-1.5 rounded-full bg-teal-500" /></span>
              {agents.find(a => a.id === live.agentId)?.name ?? tx('Minerva')} {tx('is researching')}
            </button>
          )}
          <span className="flex-1" />
          <button className={clsx(btn.subtle, '!rounded-full')} onClick={() => setDeep(true)}><Telescope className="w-3.5 h-3.5 text-teal-500" /><span className="hidden sm:inline">{tx('Deep research')}</span></button>
          <div className="relative">
            <button className={btn.icon} onClick={() => setMenu(m => !m)} aria-label={tx('More')}><MoreHorizontal className="w-4 h-4" /></button>
            {menu && (
              <div className="absolute right-0 top-full mt-1 z-30 w-52 p-1 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-primary)] shadow-xl" onMouseLeave={() => setMenu(false)}>
                <a className={clsx(btn.ghost, 'w-full')} href={`/api/research/${d.id}/export.md`} onClick={() => setMenu(false)}><Download className="w-3.5 h-3.5" />{tx('Export as Markdown')}</a>
                {d.conversations.length > 0 && <button className={clsx(btn.ghost, 'w-full')} onClick={() => { setMenu(false); setDeep(true); }}><MessageSquare className="w-3.5 h-3.5" />{tx('Research chats (')}{d.conversations.length})</button>}
                <button className={clsx(btn.ghost, 'w-full', armed === 'nb' && 'text-rose-500 hover:text-rose-500')} onClick={remove}>
                  {armed === 'nb' ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}{armed === 'nb' ? tx('Click again to delete') : tx('Delete notebook')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* mobile tabs */}
        <div className="lg:hidden shrink-0 flex gap-1 px-3 pb-2">
          {(['sources', 'chat', 'studio'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} className={clsx('flex-1 py-1.5 rounded-lg text-[13px] capitalize transition',
              tab === t ? 'bg-[var(--bg-primary)] border border-[var(--border-subtle)] font-medium shadow-sm' : 'text-[var(--text-secondary)]')}>
              {t}{t === 'sources' && srcCount ? ` (${srcCount})` : ''}
            </button>
          ))}
        </div>

        {/* panes */}
        <div className="flex-1 min-h-0 flex gap-3 px-3 pb-3">
          <aside className={clsx(pane, tab === 'sources' ? 'flex flex-1' : 'hidden', 'lg:flex lg:flex-none', left ? 'lg:w-[300px] xl:w-[320px]' : 'lg:w-12')}>
            {left ? (
              <>
                {head('Sources', () => setLeft(false), PanelLeftClose)}
                <div className="flex-1 min-h-0">
                  <SourcesPanel onAdd={() => setAdding(true)} onDiscover={() => setDiscover(true)} open={source} onOpen={setSource} />
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-2">
                <button className={btn.icon} onClick={() => setLeft(true)} aria-label={tx('Show sources')}><PanelLeftOpen className="w-4 h-4" /></button>
                <button className={btn.icon} onClick={() => setAdding(true)} aria-label={tx('Add sources')}><Plus className="w-4 h-4" /></button>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">{srcCount}</span>
              </div>
            )}
          </aside>

          <main className={clsx(pane, tab === 'chat' ? 'flex' : 'hidden', 'lg:flex flex-1 min-w-0')}>
            {head('Chat')}
            <div className="flex-1 min-h-0"><NotebookChat handle={chat} onAddSources={() => setAdding(true)} /></div>
          </main>

          <aside className={clsx(pane, tab === 'studio' ? 'flex flex-1' : 'hidden', 'lg:flex lg:flex-none', right ? 'lg:w-[330px] xl:w-[360px]' : 'lg:w-12')}>
            {right ? (
              <>
                {head('Studio', () => setRight(false), PanelRightClose)}
                <div className="flex-1 min-h-0"><StudioPanel onOpenOutput={setViewer} onOpenReport={() => setViewer('report')} /></div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-2">
                <button className={btn.icon} onClick={() => setRight(true)} aria-label={tx('Show Studio')}><PanelRightOpen className="w-4 h-4" /></button>
                {(Object.keys(STUDIO_META) as StudioType[]).slice(0, 5).map(t => {
                  const M = STUDIO_META[t];
                  return <button key={t} className={btn.icon} onClick={() => setRight(true)} title={tx(M.label)}><M.icon className="w-4 h-4" style={{ color: M.tint }} /></button>;
                })}
              </div>
            )}
          </aside>
        </div>
      </div>

      <AddSourcesModal open={adding} onClose={() => setAdding(false)} onDiscover={() => setDiscover(true)} />
      <DiscoverModal open={discover} onClose={() => setDiscover(false)} />
      <DeepResearchModal open={deep} onClose={() => setDeep(false)} d={d} agents={agents} activeConvs={activeConvs}
        onAsk={(aid, text) => onAsk(d.id, aid, text)} onOpenChat={onOpenChat} />
      {viewed && (
        <Modal open onClose={() => setViewer(null)} title={tx(viewed.title)} wide
          icon={(() => { const M = STUDIO_META[(viewed.meta.type as StudioType)] ?? STUDIO_META.report; return <M.icon className="w-4 h-4" style={{ color: M.tint }} />; })()}>
          <div className="h-[80vh] sm:h-[76vh] min-h-0"><OutputBody it={viewed} /></div>
        </Modal>
      )}
    </NotebookCtx.Provider>
  );
}

// ── index ──────────────────────────────────────────────────────────────────

function hue(s: string) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }

export function ResearchIndex({ agents, activeConvs, onOpen, onStart }: {
  agents: Agent[]; activeConvs: string[]; onOpen: (id: string, add?: boolean) => void; onStart: (question: string, agentId: string) => void;
}) {
  const [boards, setBoards] = useState<ResearchBoard[] | null>(null);
  const [q, setQ] = useState('');
  const [prompt, setPrompt] = useState('');
  const able = researchAgentsOf(agents);
  const [agentId, setAgentId] = useState(able[0]?.id ?? 'minerva');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.researchBoards().then(setBoards).catch(() => setBoards([])), []);
  useEffect(() => { load(); const t = setInterval(() => document.visibilityState === 'visible' && load(), 15000); return () => clearInterval(t); }, [load]);
  const shown = (boards ?? []).filter(b => !q.trim() || `${b.title} ${b.question}`.toLowerCase().includes(q.trim().toLowerCase()));
  const create = async () => {
    setCreating(true);
    try { const b = await api.createResearchBoard({ title: '', question: '' }); onOpen(b.id, true); } finally { setCreating(false); }
  };
  const start = () => { if (prompt.trim()) onStart(prompt.trim(), agentId); };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8">
        <div className="flex items-end gap-4 flex-wrap mb-6">
          <div className="flex-1 min-w-[16rem]">
            <h1 className="text-[28px] font-semibold tracking-tight flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl" style={{ background: 'linear-gradient(135deg, #059669, #0f766e)' }}>
                <Telescope className="w-[18px] h-[18px] text-white" />
              </span>
              {tx('Research')}
            </h1>
            <p className="text-[13.5px] text-[var(--text-muted)] mt-1.5 max-w-xl">
              {tx('Notebooks for your sources. Chat with them, get cited answers, and turn them into briefings, mind maps, quizzes and audio overviews. Minerva can also research a question for you and fill a notebook herself.')}
            </p>
          </div>
          {(boards?.length ?? 0) > 4 && (
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={tx('Search notebooks')} className={clsx(btn.input, 'pl-8 !text-[13px]')} />
            </div>
          )}
        </div>

        <form onSubmit={e => { e.preventDefault(); start(); }}
          className="mb-8 flex items-end gap-2 p-2 pl-4 rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] focus-within:border-teal-500/60 transition">
          <Telescope className="w-4 h-4 text-teal-500 self-center shrink-0" />
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={1}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); } }}
            placeholder={tx('Ask Minerva to research something, and she’ll build a notebook for it…')}
            className="flex-1 min-w-0 resize-none bg-transparent text-[14px] py-1.5 placeholder-[var(--text-muted)] focus:outline-none [field-sizing:content] max-h-32" />
          {able.length > 1 && (
            <select value={agentId} onChange={e => setAgentId(e.target.value)} aria-label={tx('Agent')} className="self-center text-[12px] bg-transparent text-[var(--text-secondary)] focus:outline-none">
              {able.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <button type="submit" disabled={!prompt.trim()} className={clsx(btn.primary, '!bg-teal-600 !rounded-xl shrink-0')}>{tx('Research')}</button>
        </form>

        {boards === null ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <button onClick={create} disabled={creating}
              className="aspect-[4/3] rounded-2xl border-2 border-dashed border-[var(--border-subtle)] hover:border-teal-500/60 hover:bg-[var(--bg-secondary)] transition flex flex-col items-center justify-center gap-2 text-[var(--text-secondary)]">
              <span className="w-12 h-12 rounded-full bg-teal-500/15 flex items-center justify-center">
                {creating ? <Loader2 className="w-5 h-5 animate-spin text-teal-600" /> : <Plus className="w-6 h-6 text-teal-600" />}
              </span>
              <span className="text-[14px] font-medium">{tx('Create new notebook')}</span>
            </button>
            {shown.map(b => {
              const live = b.convIds?.some(id => activeConvs.includes(id));
              const h = hue(b.id);
              return (
                <button key={b.id} onClick={() => onOpen(b.id)}
                  className="group aspect-[4/3] text-left p-4 rounded-2xl border border-[var(--border-subtle)] hover:shadow-lg hover:-translate-y-0.5 transition flex flex-col min-w-0"
                  style={{ background: `linear-gradient(160deg, hsl(${h} 70% 50% / 0.16), hsl(${(h + 40) % 360} 70% 50% / 0.05))` }}>
                  <span className="flex items-start justify-between">
                    <span className="text-[34px] leading-none">{b.emoji || '📓'}</span>
                    <FavoriteStar nested kind="research" id={b.id} title={tx(b.title)} className={isFavorite('research', b.id) ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} />
                  </span>
                  <span className="mt-auto text-[15px] font-semibold leading-snug line-clamp-2">{tx(b.title)}</span>
                  <span className="mt-1 text-[11.5px] text-[var(--text-muted)] flex items-center gap-1.5">
                    {live && <Loader2 className="w-3 h-3 animate-spin text-teal-500" />}
                    {new Date(b.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {b.counts.source} source{b.counts.source === 1 ? '' : 's'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {boards && boards.length > 0 && shown.length === 0 && <p className="py-8 text-center text-[13px] text-[var(--text-muted)]">{tx('No notebooks match.')}</p>}
      </div>
    </div>
  );
}

/** Chat-side card for a research_board tool call: opens the notebook. */
export function BoardCard({ board }: { board: { id: string; title: string; counts: { source: number; finding: number; openQuestions: number }; synthesized?: boolean } }) {
  return (
    <a href={`#/research/${board.id}`}
      className="w-full max-w-md my-2 p-3 rounded-xl border border-teal-500/30 bg-teal-500/[0.06] hover:bg-teal-500/[0.12] flex items-center gap-3 transition group no-underline">
      <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #059669, #0f766e)' }}>
        <Telescope className="w-4 h-4 text-white" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold truncate text-[var(--text-primary)]">{tx(board.title)}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">
          {tx('Research notebook ·')} {board.counts.source} {tx('sources ·')} {board.counts.finding} findings{board.synthesized ? tx(' · report updated') : ''}
        </span>
      </span>
      <ExternalLink className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] shrink-0" />
    </a>
  );
}
