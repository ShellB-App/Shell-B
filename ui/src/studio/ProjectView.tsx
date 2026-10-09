import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft, Check, ChevronDown, Download, ExternalLink, FolderTree, History, Loader2, MessageSquare, MonitorCheck, MonitorPlay, Moon, PanelLeft, Plus, SquareTerminal, Sun,
} from 'lucide-react';
import { PREVIEW_SAVER, loadAmbience, saveAmbience, useAmbience, type SaverStyle } from '../ambience';
import type { Agent, Attachment, Effort, ModelInfo, Project, ProjectFile, StreamEvent } from '../types';
import { api, rawUrl } from '../api';
import { useChat } from '../useChat';
import { MessageView } from '../components/MessageView';
import { RunCodeContext } from '../components/Markdown';
import { Composer } from '../components/Composer';
import { AgentAvatar, btn, relTime } from '../components/common';
import { Canvas, type Pick } from './Canvas';
import { FilesPanel, HistoryPanel } from './Sidebar';
import { KIND_ICON } from './Studio';
import { Terminal } from './Terminal';
import { foldSummarized } from '../summarized';

interface Props {
  projectId: string;
  agents: Agent[];
  models: ModelInfo[];
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  voiceOk: boolean;
  onBack: () => void;
  onOpenAgents: (id: string) => void;
}

const selectionBlock = (p: Pick) =>
  `\n\n[Selected element in ${p.file}: \`${p.selector}\`]\n\`\`\`html\n${p.html}\n\`\`\``;

export function ProjectView({ projectId, agents, models, theme, onToggleTheme, voiceOk, onBack, onOpenAgents }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [version, setVersion] = useState(0);
  const [leftTab, setLeftTab] = useState<'files' | 'history'>('files');
  const [left, setLeft] = useState(() => window.innerWidth >= 1100);
  const [chatOpen, setChatOpen] = useState(true);
  const [agentId, setAgentId] = useState('daedalus');
  const [planMode, setPlanMode] = useState(false);
  const [isCode, setIsCode] = useState(false);
  const [term, setTerm] = useState(false);
  const [termRun, setTermRun] = useState<{ command: string; n: number }>();
  useEffect(() => { if (!term) setTermRun(undefined); }, [term]); // a reopened terminal mustn't replay the last Run
  const [efforts, setEfforts] = useState<Record<string, Effort>>({});
  const [threadMenu, setThreadMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<number | undefined>(undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const refresh = useCallback(async () => {
    const p = await api.project(projectId);
    setProject(p);
    return p;
  }, [projectId]);

  // file events from the agent: refresh the tree and hot-reload the preview (debounced)
  const onEvent = useCallback((ev: StreamEvent) => {
    if (ev.type === 'file') {
      window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(async () => {
        const p = await refresh();
        setVersion(v => v + 1);
        const cur = selectedRef.current;
        if (p.kind === 'code') {
          if (!cur || !p.files.some(f => f.path === cur)) setSelected(p.files.some(f => f.path === ev.path) ? ev.path : p.entry);
          return;
        }
        const htmls = p.files.filter(f => f.kind === 'html');
        if ((!cur || cur === 'DESIGN.md' || !p.files.some(f => f.path === cur)) && htmls.length) {
          setSelected((htmls.find(f => f.path === p.entry) ?? htmls[0]).path);
        }
      }, 350);
    }
    if (ev.type === 'commit') { refresh(); setVersion(v => v + 1); }
  }, [refresh]);

  const chat = useChat({ onEvent, onSettled: () => { refresh(); } });

  // the kind's own partner first: Daedalus for design, Hephaestus for code
  const studioAgents = useMemo(() => [...agents].sort((a, b) => isCode
    ? Number(b.id === 'hephaestus') - Number(a.id === 'hephaestus') || Number(!!a.studio) - Number(!!b.studio)
    : Number(!!b.studio) - Number(!!a.studio)), [agents, isCode]);
  const agent = agents.find(a => a.id === agentId) ?? studioAgents[0];
  const model = models.find(m => m.name === agent?.model || `${m.name}:latest` === agent?.model);
  const effort: Effort = (agent && efforts[agent.id]) ?? agent?.effort ?? 'medium';

  // initial load: project, default file, latest thread, optional auto-start from the brief
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await refresh();
        if (!alive) return;
        const code = p.kind === 'code';
        setIsCode(code);
        const htmls = p.files.filter(f => f.kind === 'html');
        setSelected((p.files.find(f => f.path === p.entry) ?? (code ? p.files[0] : htmls[0]) ?? p.files.find(f => f.path === 'DESIGN.md'))?.path);
        if (p.threads.length) {
          const c = await chat.load(p.threads[0].id);
          setAgentId(c.agentId);
        } else if (code) setAgentId('hephaestus');
        let brief: string | null = null;
        try { brief = sessionStorage.getItem(`shellb.autostart.${projectId}`); sessionStorage.removeItem(`shellb.autostart.${projectId}`); } catch { /* private mode */ }
        if (brief && !p.threads.length) {
          sendMessage(code
            ? `Let's start. Here's what I want to build:\n\n${brief}\n\nLook at what's in the workspace first. Propose a short plan (structure, key decisions, how we'll test it), then build the first working version, run it and its tests, and record how to run and test it in README.md.`
            : `Let's start this project. Here's the brief:\n\n${brief}\n\nLook at any uploaded assets first, set the design direction in DESIGN.md, then build the first version and review it with a screenshot.`, [], undefined, undefined, code ? 'hephaestus' : undefined);
        }
      } catch (e) { setError(String(e)); }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const ensureThread = useCallback(async (asAgent?: string) => {
    if (chat.convRef.current) return chat.convRef.current.id;
    const t = await api.createThread(projectId, asAgent ?? agentId);
    const c = await chat.load(t.id);
    setProject(p => (p ? { ...p, threads: [t, ...p.threads] } : p));
    return c.id;
  }, [projectId, agentId, chat]);

  const sendMessage = useCallback(async (text: string, attachments: Attachment[], pick?: Pick, fromMessageId?: string, asAgent?: string, routeTo?: string, mode?: 'plan') => {
    if (chat.busy) return;
    const id = await ensureThread(asAgent);
    setChatOpen(true);
    await chat.send(id, { content: text + (pick ? selectionBlock(pick) : ''), attachments, agentId: routeTo ?? asAgent ?? agent?.id ?? agentId, effort, fromMessageId,
      routeOnly: !!routeTo, mode });
  }, [chat, ensureThread, agent, agentId, effort]);

  const uploader = useCallback(async (f: File): Promise<Attachment> => {
    const r = await api.uploadAssets(projectId, [f], isCode ? 'uploads' : 'assets');
    refresh();
    const path = r.saved[0];
    return { id: `att-${Date.now()}`, name: path.split('/').pop() ?? f.name, size: f.size, type: f.type,
      kind: f.type.startsWith('image/') ? 'image' : 'file', url: rawUrl(projectId, path), projectPath: path };
  }, [projectId, refresh, isCode]);

  const newThread = async () => {
    setThreadMenu(false);
    const t = await api.createThread(projectId, agentId);
    await chat.load(t.id);
    setProject(p => (p ? { ...p, threads: [t, ...p.threads] } : p));
  };

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [chat.conv?.messages]);

  // Run on chat code blocks: same sandbox and rules as the terminal
  const runSnippet = useCallback(async (command: string) => {
    const r = await api.exec(projectId, command);
    if (r.commit) { refresh(); setVersion(v => v + 1); }
    return r;
  }, [projectId, refresh]);

  if (error) return <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Couldn't open this project: {error} <button className="underline ml-2" onClick={onBack}>Back</button></div>;
  if (!project) return <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin mr-2" />Opening project…</div>;

  const file: ProjectFile | undefined = project.files.find(f => f.path === selected);
  const KindIcon = KIND_ICON[project.kind];
  const messages = chat.conv?.messages ?? [];
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const busy = chat.busy || !!chat.conv?.streaming;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--border-subtle)]">
        <button className={btn.icon} onClick={onBack} title="All projects"><ArrowLeft className="w-4 h-4" /></button>
        <button className={clsx(btn.icon, left && 'text-[var(--text-primary)] bg-[var(--bg-hover)]')} onClick={() => setLeft(v => !v)} title="Files & history"><PanelLeft className="w-4 h-4" /></button>
        <KindIcon className="w-4 h-4 text-[var(--accent)] ml-1 shrink-0" />
        {editingName ? (
          <input autoFocus defaultValue={project.name} className="bg-[var(--bg-tertiary)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-sm focus:outline-none"
            onBlur={async e => { setEditingName(false); const n = e.target.value.trim(); if (n && n !== project.name) { await api.patchProject(projectId, { name: n }); refresh(); } }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingName(false); }} />
        ) : (
          <button className="text-sm font-semibold truncate hover:underline decoration-dotted underline-offset-4" onClick={() => setEditingName(true)} title="Rename">{project.name}</button>
        )}
        <span className="hidden sm:inline text-[11px] text-[var(--text-muted)] truncate">· {project.files.length} files · saved {relTime(project.updatedAt)}</span>
        <div className="flex-1" />
        {project.entry.toLowerCase().endsWith('.html') && <a className={clsx(btn.ghost, 'hidden md:inline-flex')} href={`${rawUrl(projectId, project.entry)}`} target="_blank" rel="noreferrer" title="Open the entry page in a new tab"><ExternalLink className="w-3.5 h-3.5" />Open</a>}
        {project.kind === 'screensaver' && <SaverButtons projectId={projectId} />}
        <a className={clsx(btn.ghost, 'hidden md:inline-flex')} href={`/api/projects/${projectId}/export.zip`} title="Download all files"><Download className="w-3.5 h-3.5" />Export</a>
        {isCode && (
          <button className={clsx(btn.ghost, term && 'text-[var(--text-primary)] bg-[var(--bg-hover)]')} onClick={() => setTerm(v => !v)} title="Terminal (sandbox, no network)">
            <SquareTerminal className="w-3.5 h-3.5" /><span className="hidden sm:inline">Terminal</span>
          </button>
        )}
        <button className={btn.icon} onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
        <button className={clsx(btn.ghost, chatOpen && 'text-[var(--text-primary)] bg-[var(--bg-hover)]')} onClick={() => setChatOpen(v => !v)} title="Agent chat">
          <MessageSquare className="w-3.5 h-3.5" /><span className="hidden sm:inline">Chat</span>{busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />}
        </button>
      </header>

      <div className="flex-1 min-h-0 flex relative">
        {left && (
          <aside className="w-64 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex flex-col absolute lg:static inset-y-0 left-0 z-20 shadow-2xl lg:shadow-none">
            <div className="flex p-1.5 gap-1 border-b border-[var(--border-subtle)]">
              {([['files', 'Files', FolderTree], ['history', 'History', History]] as const).map(([id, label, I]) => (
                <button key={id} onClick={() => setLeftTab(id)}
                  className={clsx('flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs transition', leftTab === id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                  <I className="w-3.5 h-3.5" />{label}
                </button>
              ))}
            </div>
            {leftTab === 'files' ? (
              <FilesPanel projectId={projectId} files={project.files} selected={selected} entry={project.entry} code={isCode}
                onSelect={path => { setSelected(path); if (window.innerWidth < 1024) setLeft(false); }}
                onChanged={() => { refresh(); setVersion(v => v + 1); }} />
            ) : (
              <HistoryPanel projectId={projectId} version={version} onRestored={() => { refresh(); setVersion(v => v + 1); }} />
            )}
          </aside>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <Canvas projectId={projectId} kind={project.kind} file={file} pages={project.files.filter(f => f.kind === 'html')} entry={project.entry} viewport={project.viewport} version={version} dark={theme === 'dark'}
            busy={busy} onAsk={(text, pick) => sendMessage(text, [], pick)} onSaved={() => { refresh(); setVersion(v => v + 1); }}
            onRun={isCode ? command => { setTerm(true); setTermRun(r => ({ command, n: (r?.n ?? 0) + 1 })); } : undefined} />
          {isCode && term && (
            <Terminal projectId={projectId} busy={busy} pending={termRun} onClose={() => setTerm(false)} onRan={() => { refresh(); setVersion(v => v + 1); }}
              onAsk={text => sendMessage(text, [])} />
          )}
        </div>

        {chatOpen && (
          <section className="w-full sm:w-[420px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col absolute sm:static inset-0 z-30">
            <div className="h-10 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--border-subtle)]">
              <div className="relative min-w-0 flex-1">
                <button onClick={() => setThreadMenu(v => !v)} className="flex items-center gap-1.5 text-xs font-medium min-w-0 max-w-full">
                  <span className="truncate">{chat.conv?.title ?? (isCode ? 'New coding session' : 'New design session')}</span><ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                </button>
                {threadMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setThreadMenu(false)} />
                    <div className="absolute left-0 top-full mt-1 w-72 z-50 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1">
                      <button onClick={newThread} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs hover:bg-[var(--bg-hover)]"><Plus className="w-3.5 h-3.5" />New session</button>
                      {project.threads.map(t => (
                        <button key={t.id} onClick={async () => { setThreadMenu(false); const c = await chat.load(t.id); setAgentId(c.agentId); }}
                          className={clsx('w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex justify-between gap-2', t.id === chat.conv?.id ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]')}>
                          <span className="truncate">{t.title}</span><span className="text-[var(--text-muted)] shrink-0">{relTime(t.updatedAt)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button className={clsx(btn.icon, 'sm:hidden')} onClick={() => setChatOpen(false)} aria-label="Close chat">✕</button>
            </div>

            <RunCodeContext.Provider value={isCode ? runSnippet : null}>
            <div ref={scroller} className="studio-chat flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-6">
              {messages.length === 0 ? (
                <div className="pt-6 text-center">
                  <AgentAvatar agent={agent} size={40} className="rounded-xl mx-auto mb-3" />
                  <div className="text-sm font-semibold">{agent?.name}</div>
                  <p className="text-xs text-[var(--text-muted)] mt-1 px-4">{agent?.description}</p>
                  <div className="mt-5 space-y-1.5 text-left">
                    {(isCode ? [
                      'Walk me through this codebase: what it does, how it is structured, and how to run and test it.',
                      'Run the tests and fix whatever fails.',
                      'Review the code for bugs and risky spots, most severe first. Don\'t change anything yet.',
                    ] : [
                      'Look at my uploaded assets and propose a design direction in DESIGN.md.',
                      `Build the first version of the ${project.kind === 'deck' ? 'deck' : project.kind === 'print' ? 'one-pager' : 'page'} from the brief, then review it with a screenshot.`,
                      'Generate a hero image that fits the brand and use it.',
                    ]).map(q => (
                      <button key={q} onClick={() => sendMessage(q, [])} className="w-full text-left px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-xs text-[var(--text-secondary)]">{q}</button>
                    ))}
                  </div>
                </div>
              ) : foldSummarized(messages).map(m => (
                <MessageView key={m.id} message={m} agent={agents.find(a => a.id === m.agentId) ?? agent}
                  isLast={m === lastAssistant} busy={busy} onOpenArtifact={() => {}} onOpenFile={setSelected}
                  onRegenerate={() => {
                    const lastUser = [...messages].reverse().find(x => x.role === 'user');
                    if (lastUser) sendMessage(lastUser.content, lastUser.attachments ?? [], undefined, lastUser.id, undefined, undefined, lastUser.mode);
                  }}
                  onEdit={text => sendMessage(text, m.attachments ?? [], undefined, m.id, undefined, undefined, m.mode)} onAsk={text => sendMessage(text, [])}
                  onPlan={action => {
                    if (action === 'revise') { setPlanMode(true); return; }
                    setPlanMode(false);
                    const planner = lastAssistant?.agentId;
                    sendMessage('Approved. Go ahead and carry out the plan.', [], undefined, undefined, undefined, planner && planner !== agent?.id ? planner : undefined);
                  }} />
              ))}
            </div>
            </RunCodeContext.Provider>

            <div className="shrink-0 p-2.5">
              {agent && (
                <Composer agent={agent} agents={studioAgents} model={model} effort={effort}
                  onEffort={e => setEfforts(prev => ({ ...prev, [agent.id]: e }))}
                  onAgent={a => { setAgentId(a.id); if (chat.conv) api.patchConversation(chat.conv.id, { agentId: a.id }); }}
                  busy={busy} onSend={(t, a, o) => sendMessage(t, a, undefined, undefined, undefined, o?.agentId, o?.mode)} convId={chat.conv?.id} planMode={planMode} onPlanMode={setPlanMode} onStop={chat.stop} ensureConversation={ensureThread}
                  voiceOk={voiceOk} focusKey={chat.conv?.id ?? 'new'} uploader={uploader}
                  placeholder={isCode ? `Ask ${agent.name} to build, fix, explain or review…${file ? ` (open: ${file.path})` : ''}`
                    : file?.kind === 'html' ? `Ask ${agent.name} to change ${file.path}… or click Comment to point at something` : `Describe what to design…`} />
              )}
              <div className="flex items-center justify-between mt-1 px-1 text-[10px] text-[var(--text-muted)]">
                <span>{agent?.model} · every reply is {isCode ? 'a git commit' : 'saved as a version'}</span>
                <button className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline" onClick={() => onOpenAgents(agent?.id ?? (isCode ? 'hephaestus' : 'daedalus'))}>Tune agent</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** A Screensaver project's header buttons: preview it full screen as the screensaver, or make it the screensaver. */
function SaverButtons({ projectId }: { projectId: string }) {
  const prefs = useAmbience();
  const style: SaverStyle = `studio:${projectId}`;
  const using = prefs.saverStyle === style;
  return (
    <>
      <button className={btn.ghost} title="Show it full screen, the way the screensaver will (move the mouse or press a key to exit)"
        onClick={() => window.dispatchEvent(new CustomEvent(PREVIEW_SAVER, { detail: style }))}>
        <MonitorPlay className="w-3.5 h-3.5" /><span className="hidden sm:inline">Preview</span>
      </button>
      <button className={clsx(btn.ghost, using && '!text-[var(--accent-soft)]')} disabled={using}
        title={using ? 'This is your screensaver (change it in Settings → Appearance)' : 'Make this your screensaver (Settings → Appearance)'}
        onClick={() => saveAmbience({ saverStyle: style, saverMinutes: loadAmbience().saverMinutes || 10 })}>
        {using ? <Check className="w-3.5 h-3.5" /> : <MonitorCheck className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline">{using ? 'Your screensaver' : 'Use as screensaver'}</span>
      </button>
    </>
  );
}
