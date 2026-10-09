import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  BookOpen, Brain, ChevronDown, Flag, Globe2, Info, Laptop, Loader2, LogOut, Menu, MessageSquare, Moon, Palette, Pencil,
  Plus, Radio, StickyNote, Sun, Trash2, UserRound, X, type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import { useChat } from '../useChat';
import { foldSummarized } from '../summarized';
import { MessageView } from '../components/MessageView';
import { Composer } from '../components/Composer';
import { ArtifactPanel } from '../components/ArtifactPanel';
import { VoiceMode } from '../components/VoiceMode';
import { AgentAvatar, btn, relTime } from '../components/common';
import { openContextMenu, openMenuAt, type MenuEntry } from '../components/ContextMenu';
import { toast } from '../components/toast';
import { THEMES, setTheme, useTheme } from '../themes';
import type { Agent, Attachment, ConversationSummary, Effort } from '../types';
import { guestApi, type GuestMe } from './guestApi';
import { AboutPanel, AccountPanel, DevicesPanel, MemoryPanel, ReportPanel } from './panels';

// Shell:B Guest: a friend's own Shell:B (server/guests.py). The chat is the owner's components (useChat, MessageView,
// Composer, ArtifactPanel) on the guest server, which answers the same paths but only with this guest's things.

const convFromHash = () => /^#\/c\/([\w-]+)/.exec(location.hash)?.[1] ?? null;

// The apps a guest has besides chat. Wiki and Worlds read the machine's offline data (shared, read-only); Radio runs in
// the browser; Notes are the guest's own (server/guest_notes.py). Same hashes as the owner's app, so links carry over.
const Notes = lazy(() => import('../components/Notes').then(m => ({ default: m.Notes })));
const Wiki = lazy(() => import('../components/Wiki').then(m => ({ default: m.Wiki })));
const MapsApp = lazy(() => import('../maps/MapsApp').then(m => ({ default: m.MapsApp })));
const RadioApp = lazy(() => import('../radio/RadioApp').then(m => ({ default: m.RadioApp })));
type View = 'chat' | 'notes' | 'wiki' | 'worlds' | 'radio';
const VIEWS: { id: View; label: string; icon: LucideIcon; hash: string }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, hash: '#/' },
  { id: 'notes', label: 'Notes', icon: StickyNote, hash: '#/codex/notes' },
  { id: 'wiki', label: 'Wiki', icon: BookOpen, hash: '#/wiki' },
  { id: 'worlds', label: 'Worlds', icon: Globe2, hash: '#/worlds' },
  { id: 'radio', label: 'Radio', icon: Radio, hash: '#/radio' },
];
const viewFromHash = (h = location.hash): View => /^#\/codex\/notes\b/.test(h) ? 'notes' : /^#\/wiki\b/.test(h) ? 'wiki'
  : /^#\/(worlds|maps)\b/.test(h) ? 'worlds' : /^#\/(radio|dj|fm)\b/.test(h) ? 'radio' : 'chat';

const STARTERS = [
  { title: 'Paint a picture', prompt: 'Paint a cozy reading nook on a rainy evening: warm lamplight, rain on the window, watercolor style.' },
  { title: 'Compose a loop', prompt: 'Compose a 30-second lo-fi loop with soft piano, brushed drums and a little vinyl crackle.' },
  { title: 'Build a tiny app', prompt: 'Build a Pomodoro timer as a single web page, with a calm design and a sound when time is up.' },
  { title: 'Look something up', prompt: "What's the best time to see the Milky Way this month where I live? Ask me where that is." },
];

type Panel = null | 'account' | 'memory' | 'devices' | 'about' | { report: { convId?: string; msgId?: string } };

export function GuestApp({ me, refresh }: { me: GuestMe; refresh: () => void }) {
  const agents = me.agents;
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [agentId, setAgentId] = useState(() => (agents.find(a => a.id === me.defaultAgent) ?? agents[0])?.id ?? '');
  const [efforts, setEfforts] = useState<Record<string, Effort>>({});
  const [artifact, setArtifact] = useState<{ id: string; version?: number } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [queued, setQueued] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [dark, setDark] = useState(() => !document.documentElement.classList.contains('light'));
  const [focusTick, setFocusTick] = useState(0);
  const [view, setView] = useState<View>(viewFromHash);
  const [hash, setHash] = useState(location.hash);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const loadConvs = useCallback(() => api.conversations().then(setConvs).catch(() => {}), []);
  const { conv, setConv, convRef, busy, load, send: sendTurn, stop } = useChat({
    onEvent: (ev, id) => {
      const type = (ev as { type: string }).type;
      if (type === 'queued') setQueued(true);
      else if (type === 'start') setQueued(false);
      if (ev.type === 'artifact' && convRef.current?.id === id) setArtifact({ id: ev.artifact.id, version: ev.artifact.version });
      if (ev.type === 'title') setConvs(prev => prev.map(c => (c.id === id ? { ...c, title: ev.title } : c)));
    },
    onSettled: () => { setQueued(false); loadConvs(); },
  });

  const agent: Agent | undefined = agents.find(a => a.id === agentId) ?? agents[0];
  const effort: Effort = (agent && efforts[agent.id]) ?? agent?.effort ?? 'medium';
  const working = busy || !!conv?.streaming;

  useEffect(() => { loadConvs(); }, [loadConvs]);

  // #/c/<id> is the open chat; anything else is a new one
  useEffect(() => {
    const go = () => {
      setHash(location.hash);
      const v = viewFromHash();
      setView(v);
      setDrawer(false);
      if (v !== 'chat') return;  // the open chat stays loaded behind the other apps
      const id = convFromHash();
      setArtifact(null);
      setVoiceMode(false);
      setDrawer(false);
      if (!id) { setConv(null); setFocusTick(t => t + 1); return; }
      if (convRef.current?.id === id) return;
      load(id).then(c => { if (agents.some(a => a.id === c.agentId)) setAgentId(c.agentId); })
        .catch(() => { history.replaceState(null, '', '#/'); setConv(null); });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = useCallback(() => {
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    else { setConv(null); setArtifact(null); setDrawer(false); setFocusTick(t => t + 1); }
  }, [setConv]);

  const ensureConversation = useCallback(async () => {
    if (convRef.current) return convRef.current.id;
    const c = await api.createConversation(agentId);
    const full = { ...c, messages: [], artifacts: [] };
    convRef.current = full;
    setConv(full);
    setConvs(prev => [c, ...prev]);
    history.replaceState(null, '', `#/c/${c.id}`);
    return c.id;
  }, [agentId, convRef, setConv]);

  const send = useCallback(async (content: string, attachments: Attachment[], fromMessageId?: string, routeTo?: string, voice?: boolean) => {
    if (working || !agent) return;
    const id = await ensureConversation();
    atBottom.current = true;
    const other = routeTo && routeTo !== agent.id ? agents.find(a => a.id === routeTo) : undefined;
    const who = other ?? agent;
    await sendTurn(id, {
      content, attachments, agentId: who.id, effort: efforts[who.id] ?? who.effort ?? 'medium', fromMessageId,
      routeOnly: other ? true : undefined, voice,
    });
  }, [working, agent, agents, efforts, ensureConversation, sendTurn]);

  // Notes → "Discuss": a new chat with the note attached (like the owner's App.startNoteChat)
  const discussNote = useCallback(async (text: string, note: File) => {
    convRef.current = null;
    setConv(null);
    history.replaceState(null, '', '#/');
    setView('chat');
    const id = await ensureConversation();
    const att = await api.upload(id, note);
    await send(text, [att]);
  }, [convRef, setConv, ensureConversation, send]);

  const messages = useMemo(() => foldSummarized(conv?.messages ?? []), [conv?.messages]);
  const lastAssistant = useMemo(() => [...messages].reverse().find(m => m.role === 'assistant'), [messages]);
  const regenerate = useCallback(() => {
    const lastUser = [...(conv?.messages ?? [])].reverse().find(m => m.role === 'user');
    if (lastUser) send(lastUser.content, lastUser.attachments ?? [], lastUser.id);
  }, [conv, send]);

  // stay pinned to the newest message unless the reader scrolled up
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current && messages.length) el.scrollTop = el.scrollHeight;
  }, [messages, queued]);

  const pickAgent = (a: Agent) => {
    setAgentId(a.id);
    if (conv) api.patchConversation(conv.id, { agentId: a.id }).catch(() => {});
  };
  const agentMenu = (e: ReactMouseEvent<HTMLButtonElement>) => openMenuAt(e, agents.map(a => ({
    label: `${a.name} · ${a.title}`, checked: a.id === agent?.id, onSelect: () => pickAgent(a),
  })));

  const removeChat = async (c: ConversationSummary) => {
    if (!confirm(`Delete "${c.title}" and its files? This can't be undone.`)) return;
    await api.deleteConversation(c.id).catch(e => toast(String(e), { kind: 'error' }));
    setConvs(prev => prev.filter(x => x.id !== c.id));
    if (conv?.id === c.id) newChat();
  };
  const renameChat = async (c: ConversationSummary) => {
    const title = prompt('Rename chat', c.title)?.trim();
    if (!title || title === c.title) return;
    await api.patchConversation(c.id, { title }).catch(e => toast(String(e), { kind: 'error' }));
    setConvs(prev => prev.map(x => (x.id === c.id ? { ...x, title } : x)));
    if (conv?.id === c.id) setConv({ ...conv, title });
  };

  const toggleMode = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(next);
    try { localStorage.setItem('shellb.theme', next); } catch { /* private mode */ }
    setDark(!dark);
  };
  const theme = useTheme();
  const accountMenu = (e: ReactMouseEvent<HTMLButtonElement>) => openMenuAt(e, [
    { label: 'Account and security', icon: UserRound, onSelect: () => setPanel('account') },
    { label: 'What Shell:B remembers', icon: Brain, onSelect: () => setPanel('memory') },
    { label: 'Your devices', icon: Laptop, onSelect: () => { refresh(); setPanel('devices'); } },
    { label: 'Theme', icon: Palette, items: THEMES.map(t => ({ label: t.label, checked: t.id === theme, onSelect: () => setTheme(t.id) })) },
    { label: dark ? 'Light mode' : 'Dark mode', icon: dark ? Sun : Moon, onSelect: toggleMode },
    'sep',
    { label: 'About and limits', icon: Info, onSelect: () => { refresh(); setPanel('about'); } },
    { label: 'Report to Evie', icon: Flag, onSelect: () => setPanel({ report: { convId: conv?.id } }) },
    'sep',
    { label: 'Sign out of this device', icon: LogOut, danger: true, onSelect: () => { guestApi.logout().finally(refresh); } },
  ]);

  const sidebar = (
    <Sidebar me={me} convs={convs} current={view === 'chat' ? conv?.id : undefined} openConv={conv?.id} view={view} onNew={newChat} onAccount={accountMenu}
      onContext={(e, c) => openContextMenu(e, [
        { label: 'Rename', icon: Pencil, onSelect: () => renameChat(c) },
        { label: 'Delete', icon: Trash2, danger: true, onSelect: () => removeChat(c) },
      ] satisfies MenuEntry[])}
      onDelete={removeChat} />
  );
  const groups = conv?.artifacts ?? [];
  const showArtifact = !!artifact && groups.length > 0;

  return (
    <div className="h-full flex overflow-hidden">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]">{sidebar}</aside>
      {drawer && (
        <div className="md:hidden fixed inset-0 z-40 flex" role="dialog" aria-modal="true" aria-label="Chats">
          <div className="w-[82%] max-w-xs flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] animate-slide-up">{sidebar}</div>
          <button className="flex-1 bg-black/50" aria-label="Close chats" onClick={() => setDrawer(false)} />
        </div>
      )}

      {view !== 'chat' && (
        <main className="flex-1 min-w-0 flex flex-col">
          <header className="md:hidden h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)] pt-[env(safe-area-inset-top)]">
            <button className={btn.icon} aria-label="Menu" onClick={() => setDrawer(true)}><Menu className="w-4 h-4" /></button>
            <span className="text-sm font-semibold">{VIEWS.find(v => v.id === view)?.label}</span>
          </header>
          <div className="flex-1 min-h-0">
            <Suspense fallback={<div className="h-full grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>}>
              {view === 'notes' && <Notes sub={/^#\/codex\/(.*)$/.exec(hash)?.[1] ?? 'notes'} onDiscuss={discussNote} guest />}
              {view === 'wiki' && <Wiki route={/^#\/wiki(\/.*)?$/.exec(hash)?.[1] ?? ''} />}
              {view === 'worlds' && <MapsApp />}
              {view === 'radio' && <RadioApp />}
            </Suspense>
          </div>
        </main>
      )}

      <main className={clsx('flex-1 min-w-0 flex flex-col', view !== 'chat' && 'hidden')}>
        <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)] pt-[env(safe-area-inset-top)]">
          <button className={clsx(btn.icon, 'md:hidden')} aria-label="Chats" onClick={() => setDrawer(true)}><Menu className="w-4 h-4" /></button>
          {agent && (
            <button onClick={agentMenu} aria-haspopup="menu" className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-[var(--bg-hover)] transition">
              <AgentAvatar agent={agent} size={22} />
              <span className="text-sm font-semibold">{agent.name}</span>
              <span className="hidden sm:inline text-xs text-[var(--text-muted)]">{agent.title}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
          )}
          <span className="flex-1 min-w-0 truncate text-xs text-[var(--text-muted)] text-center">{conv && conv.title !== 'New conversation' ? conv.title : ''}</span>
          <button className={btn.ghost} onClick={() => setPanel({ report: { convId: conv?.id } })} title="Tell Evie something is broken">
            <Flag className="w-3.5 h-3.5" /><span className="hidden sm:inline">Report to Evie</span>
          </button>
        </header>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">
            <div ref={scroller} className="flex-1 overflow-y-auto"
              onScroll={e => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
              {messages.length === 0 ? (
                <Welcome me={me} agents={agents} agent={agent} onPick={pickAgent} onStart={p => send(p, [])} />
              ) : (
                <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                  {messages.map(m => (
                    <MessageView key={m.id} message={m} agent={agents.find(a => a.id === m.agentId) ?? agent}
                      isLast={m === lastAssistant} busy={working} activeArtifact={artifact?.id}
                      onOpenArtifact={(id, version) => setArtifact({ id, version })}
                      onRegenerate={regenerate} onEdit={text => send(text, m.attachments ?? [], m.id)}
                      artifacts={groups} onAsk={text => send(text, [])}
                      onOpenFile={path => conv && window.open(`/api/workspace/${conv.id}/${path.replace(/^\/?work\//, '').split('/').map(encodeURIComponent).join('/')}`, '_blank', 'noopener')}
                      guest onReport={m.role === 'assistant' ? () => setPanel({ report: { convId: conv?.id, msgId: m.id } }) : undefined} />
                  ))}
                  {queued && (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]" role="status">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                      Waiting for its turn: Shell:B is finishing another reply on the same machine.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-1 max-w-3xl w-full mx-auto">
              {voiceMode && (
                <div className="pb-1">
                  <VoiceMode reply={lastAssistant} busy={working} onStop={stop} onClose={() => setVoiceMode(false)}
                    onSend={t => send(t, [], undefined, undefined, true)} />
                </div>
              )}
              {agent && (
                <Composer agent={agent} agents={agents} effort={effort} onEffort={e => setEfforts(p => ({ ...p, [agent.id]: e }))}
                  onAgent={pickAgent} busy={working} onSend={(t, a, o) => send(t, a, undefined, o?.agentId)} onStop={stop}
                  ensureConversation={ensureConversation} voiceOk focusKey={`${conv?.id ?? 'new'}:${focusTick}`} convId={conv?.id}
                  onCommand={c => { if (c === 'new') newChat(); }}
                  onVoiceMode={voiceMode ? undefined : () => setVoiceMode(true)} guest
                  placeholder={`Message ${agent.name}…`} />
              )}
            </div>
          </div>

          {showArtifact && (
            <div className="fixed inset-0 z-30 md:static md:z-auto md:w-[46%] md:shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col">
              <ArtifactPanel groups={groups} activeId={artifact!.id} version={artifact!.version} dark={dark}
                onSelect={(id, version) => setArtifact({ id, version })} onClose={() => setArtifact(null)} convId={conv?.id} noFavorite />
            </div>
          )}
        </div>
      </main>

      {panel === 'account' && <AccountPanel onClose={() => setPanel(null)} onChanged={refresh} />}
      {panel === 'memory' && <MemoryPanel onClose={() => setPanel(null)} />}
      {panel === 'devices' && <DevicesPanel me={me} onClose={() => setPanel(null)} onChanged={refresh} />}
      {panel === 'about' && <AboutPanel me={me} onClose={() => setPanel(null)} />}
      {panel && typeof panel === 'object' && <ReportPanel {...panel.report} onClose={() => setPanel(null)} />}
    </div>
  );
}

function Sidebar({ me, convs, current, openConv, view, onNew, onAccount, onContext, onDelete }: {
  me: GuestMe; convs: ConversationSummary[]; current?: string; openConv?: string; view: View; onNew: () => void;
  onAccount: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onContext: (e: ReactMouseEvent, c: ConversationSummary) => void; onDelete: (c: ConversationSummary) => void;
}) {
  return (
    <>
      <div className="h-12 shrink-0 flex items-center justify-between px-3 pt-[env(safe-area-inset-top)]">
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">Shell:B</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">guest</span>
        </span>
        <button className={btn.icon} onClick={onNew} title="New chat" aria-label="New chat"><Plus className="w-4 h-4" /></button>
      </div>
      <nav className="shrink-0 px-2 pb-2 grid grid-cols-5 gap-1" aria-label="Apps">
        {VIEWS.map(v => (
          <a key={v.id} href={v.id === 'chat' && openConv ? `#/c/${openConv}` : v.hash} aria-current={view === v.id ? 'page' : undefined} title={v.label}
            className={clsx('flex flex-col items-center gap-1 py-1.5 rounded-lg text-[10px] tracking-wide transition',
              view === v.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
            <v.icon className="w-4 h-4" aria-hidden />{v.label}
          </a>
        ))}
      </nav>
      <div className="mx-3 mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Chats</div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Your chats">
        {convs.length === 0 ? (
          <p className="px-2 py-6 text-xs leading-relaxed text-[var(--text-muted)]">Your chats will show up here.</p>
        ) : (
          <ul className="space-y-px">
            {convs.map(c => (
              <li key={c.id} className="group relative" onContextMenu={e => onContext(e, c)}>
                <a href={`#/c/${c.id}`} aria-current={c.id === current ? 'page' : undefined}
                  className={clsx('block pl-2.5 pr-8 py-2 rounded-lg text-[13px] transition',
                    c.id === current ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
                  <span className="block truncate">{c.title}</span>
                  <span className="block text-[10px] text-[var(--text-muted)]">{c.streaming ? 'replying…' : relTime(c.updatedAt)}</span>
                </a>
                <button className={clsx(btn.icon, 'absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100')}
                  title="Delete chat" aria-label={`Delete ${c.title}`} onClick={() => onDelete(c)}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="shrink-0 border-t border-[var(--border-subtle)] p-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <button onClick={onAccount} aria-haspopup="menu" className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition text-left">
          <span className="w-7 h-7 rounded-full grid place-items-center text-xs font-semibold bg-[var(--accent)] text-[var(--accent-fg)]">
            {me.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm truncate">{me.name}</span>
            <span className="block text-[10px] text-[var(--text-muted)]">
              {me.limits.turnsPerDay ? `${Math.max(0, me.limits.turnsPerDay - me.today.turns)} messages left today` : 'Guest'}
            </span>
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        </button>
      </div>
    </>
  );
}

function Welcome({ me, agents, agent, onPick, onStart }: {
  me: GuestMe; agents: Agent[]; agent?: Agent; onPick: (a: Agent) => void; onStart: (prompt: string) => void;
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-[10vh] pb-10">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Shell:B · on Evie's DGX Spark</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight leading-[1.15]">Hi {me.name}.</h1>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[60ch]">
        Pick who you'd like to talk to, or just start typing. Everything runs on this one machine.
      </p>
      {agents.length > 1 && (
        <Section title="Agents">
          <div className="grid gap-2 sm:grid-cols-2">
            {agents.map(a => (
              <button key={a.id} onClick={() => onPick(a)} aria-pressed={a.id === agent?.id}
                className={clsx('flex items-start gap-3 p-3 rounded-xl border text-left transition',
                  a.id === agent?.id ? 'border-[var(--accent)]/70 bg-[var(--accent)]/[0.06]' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>
                <AgentAvatar agent={a} size={28} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{a.name} <span className="font-normal text-[var(--text-muted)]">· {a.title}</span></span>
                  {a.description && <span className="block mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-2">{a.description}</span>}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title="Try">
        <div className="grid gap-2 sm:grid-cols-2">
          {STARTERS.map(s => (
            <button key={s.title} onClick={() => onStart(s.prompt)}
              className="p-3 rounded-xl border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-left transition">
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="block mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-2">{s.prompt}</span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{title}</h2>
      {children}
    </section>
  );
}
