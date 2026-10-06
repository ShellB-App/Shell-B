import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Archive, ArrowDown, GitFork, Moon, PanelLeft, PanelRight, Radio, Search, Shapes, Smartphone, Sun, Telescope, Workflow } from 'lucide-react';
import { FormFactorSwitcher } from './mobile/FormFactorSwitcher';
import { api } from './api';
import type {
  Agent, Attachment, ChatProject, Conversation, ConversationSummary, Effort, ModelInfo, Settings, SettingsTabId, Status, ToolInfo,
} from './types';
import { useChat } from './useChat';
import { Sidebar } from './components/Sidebar';
import { AppRail } from './components/AppRail';
import { appById, appForHash, type AppId } from './components/apps';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import { findMention } from './components/ComposerShortcuts';
import { ArtifactPanel } from './components/ArtifactPanel';
import { AgentLab } from './components/AgentLab';
import { CommandPalette, SettingsModal } from './components/Panels';
import { IntegrationsModal } from './components/Integrations';
import { NewProjectDialog, ProjectGlyph, ProjectPage, ProjectsIndex } from './components/Projects';
import { AgentAvatar, btn } from './components/common';
import { WorkspaceFiles } from './components/WorkspaceFiles';
import { ArtifactViewer, Library } from './components/Library';
import { FavoriteStar, FavoritesPage } from './components/Favorites';
import { Scheduled, browserTz } from './components/Scheduled';
import { Activity } from './components/Activity';
import { Codex } from './components/Codex';
import { Notes } from './components/Notes';
import { Models } from './components/Models';
import { Wiki } from './components/Wiki';
import { OfflineData } from './components/OfflineData';
import { Downloads } from './components/Downloads';
import { VoiceMode } from './components/VoiceMode';
import { ResearchBoardView, ResearchIndex } from './components/Research';
import { MegaPlanBoard, MegaPlansIndex } from './components/MegaPlans';
import { AssetLibraryView, AssetsIndex } from './components/Assets';
import { Gibberlink } from './components/Gibberlink';
import { Secretary } from './components/Secretary';
import { MapsApp } from './maps/MapsApp';
import { RadioApp } from './radio/RadioApp';
import { nextTheme, setTheme as applyTheme, themeInfo, type ThemeId } from './themes';

const Studio = lazy(() => import('./studio/Studio'));
const Code = lazy(() => import('./code/Code'));

const QUICK: Record<string, { title: string; prompt: string }[]> = {
  shellb: [
    { title: 'Catch me up', prompt: "What's new in open-weight LLMs this month? Search, read a few sources, and give me a tight summary with links." },
    { title: 'Build a tool', prompt: 'Build an interactive electronics unit converter (Ω, F, H, Hz, dBm↔mW, AWG↔mm²) as a polished HTML artifact.' },
    { title: 'Run the numbers', prompt: "Plot the Bode magnitude and phase of a 2nd-order Butterworth low-pass filter with fc = 1 kHz. Use the sandbox and show me the plot." },
    { title: 'Teach me something', prompt: 'Explain how a transformer language model works, from tokens to logits, with a Mermaid diagram artifact.' },
  ],
  hephaestus: [
    { title: 'Write & test', prompt: 'Write a Python CSV test-results analyzer that flags outliers with a robust z-score. Generate synthetic data and prove it works in the sandbox.' },
    { title: 'Ship an app', prompt: 'Build a Kanban board as a single-file HTML artifact: drag-and-drop columns, inline editing, localStorage persistence, keyboard shortcuts.' },
    { title: 'Bit-level work', prompt: 'Implement CRC-16/CCITT-FALSE in Python and C. Verify against the standard check value "123456789" → 0x29B1 in the sandbox.' },
    { title: 'Review code', prompt: 'I will paste some code. Review it for bugs first, then style. Ready?' },
  ],
  minerva: [
    { title: 'Deep research', prompt: 'Research the current state of solid-state batteries for consumer devices: who is shipping, energy density, cost, and timelines. Cite sources.' },
    { title: 'Compare options', prompt: 'Compare SGLang, vLLM, and llama.cpp for serving MoE models on a single GB10 (DGX Spark). Search for recent benchmarks.' },
    { title: 'Analyze data', prompt: 'I will attach a CSV. Profile it, find the interesting patterns, and chart the key findings.' },
    { title: 'Fact check', prompt: 'Fact-check this claim with sources: "ISO 13485 requires annual management review."' },
  ],
  heimdall: [
    { title: 'Read a document', prompt: 'I will attach a photo of a document. Transcribe it exactly, then summarize.' },
    { title: 'Critique a UI', prompt: 'I will attach a screenshot of an interface. List concrete usability problems, most severe first.' },
    { title: 'Extract a chart', prompt: 'I will attach a chart image. Extract the underlying data as a table and re-plot it.' },
    { title: 'Inspect a board', prompt: 'I will attach a PCB photo. Identify the major components and anything that looks wrong.' },
  ],
  nyx: [
    { title: 'Paint', prompt: 'Generate an image: a compact AI supercomputer glowing on a designer desk at golden hour, cinematic depth of field, warm terracotta accents.' },
    { title: 'Compose', prompt: 'Compose 15 seconds of mellow lo-fi with soft piano and vinyl crackle, for focus.' },
    { title: 'Design a mark', prompt: 'Design an SVG logo for "Shell:B": a terminal prompt merged with a small constellation. Give me three variants in one SVG.' },
    { title: 'Generative art', prompt: 'Make an interactive generative-art HTML artifact: flow-field particles that react to the mouse, with a palette picker.' },
  ],
  spark: [
    { title: 'Rewrite', prompt: 'Give me three crisper ways to say: "We are currently in the process of evaluating the feasibility of the proposal."' },
    { title: 'Convert', prompt: 'Convert 3.3 V across 220 Ω to current and power.' },
    { title: 'Define', prompt: 'What is the difference between ESD and EOS damage? Two sentences.' },
    { title: 'Quick lookup', prompt: 'What time is it in Tokyo right now?' },
  ],
};

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const readHash = () => /^#\/c\/([\w-]+)/.exec(location.hash)?.[1];
const readHashArtifact = () => /^#\/c\/[\w-]+\/([\w-]+)/.exec(location.hash)?.[1];
const readGroupRoute = () => {
  if (/^#\/projects\b/.test(location.hash)) return { id: undefined as string | undefined };
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  return m ? { id: m[1] as string | undefined } : null;
};
const readStudio = () => { const m = /^#\/studio(?:\/([\w-]+))?/.exec(location.hash); return m ? { projectId: m[1] } : null; };
const readLibrary = () => { const m = /^#\/library(\/favorites|\/media)?\b/.exec(location.hash); return m ? (m[1] === '/favorites' ? 'favorites' as const : m[1] === '/media' ? 'media' as const : 'all' as const) : false; };
const readScheduled = () => /^#\/scheduled\b/.test(location.hash);
const readActivity = () => /^#\/activity\b/.test(location.hash);
const readModels = () => /^#\/models\b/.test(location.hash);
const readSecretary = () => /^#\/secretary\b/.test(location.hash);
const readGibberlink = () => /^#\/gibberlink\b/.test(location.hash);
const readMaps = () => /^#\/(worlds|maps)\b/.test(location.hash);  // #/maps: the app's old name
const readWiki = () => { const m = /^#\/wiki(\/.*)?$/.exec(location.hash); return m ? m[1] ?? '' : null; };
const readData = () => /^#\/data\b/.test(location.hash);
const readCodex = () => { const m = /^#\/codex(?:\/(.*))?$/.exec(location.hash); return m ? m[1] ?? '' : null; };
const readResearch = () => { const m = /^#\/research(?:\/([\w-]+))?/.exec(location.hash); return m ? { boardId: m[1] } : null; };
const readAssets = () => { const m = /^#\/assets(?:\/([\w-]+))?/.exec(location.hash); return m ? { libId: m[1] } : null; };
const readPlans = () => { const m = /^#\/plans(?:\/([\w-]+))?/.exec(location.hash); return m ? { planId: m[1] } : null; };
const readView = () => { const m = /^#\/view\/([\w-]+)\/([\w-]+)/.exec(location.hash); return m ? { convId: m[1], artifactId: m[2] } : null; };
const readCode = () => { const m = /^#\/code(?:\/([\w-]+))?(?![\w-])/.exec(location.hash); return m ? { projectId: m[1] } : null; };
const readRadio = () => /^#\/(radio|dj|fm)\b/.test(location.hash);

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.classList.contains('light') ? 'light' : 'dark'));
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<Status>();
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('shellb');
  const [efforts, setEfforts] = useState<Record<string, Effort>>({});
  const [planMode, setPlanMode] = useState(false);
  const [studio, setStudio] = useState(readStudio);
  const [code, setCode] = useState(readCode);
  const [library, setLibrary] = useState(readLibrary);
  const [scheduled, setScheduled] = useState(readScheduled);
  const [activity, setActivity] = useState(readActivity);
  const [codexRoute, setCodexRoute] = useState(readCodex);
  const [modelsRoute, setModelsRoute] = useState(readModels);
  const [secretaryRoute, setSecretaryRoute] = useState(readSecretary);
  const [gibberlinkRoute, setGibberlinkRoute] = useState(readGibberlink);
  const [radioRoute, setRadioRoute] = useState(readRadio);
  const [mapsRoute, setMapsRoute] = useState(readMaps);
  const [wikiRoute, setWikiRoute] = useState(readWiki);
  const [dataRoute, setDataRoute] = useState(readData);
  const [research, setResearch] = useState(readResearch);
  const [plans, setPlans] = useState(readPlans);
  const [assetRoute, setAssetRoute] = useState(readAssets);
  const [view] = useState(readView);
  const [groupRoute, setGroupRoute] = useState(readGroupRoute);
  const [groups, setGroups] = useState<ChatProject[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [groupRefresh, setGroupRefresh] = useState(0);
  const [focusTick, setFocusTick] = useState(0); // bumped by newChat so the composer refocuses even when already on a blank chat
  const pendingGroup = useRef<string | null>(null); // project the next new chat is created in
  const [sidebar, setSidebar] = useState(() =>
    window.innerWidth >= 768 &&
    !/[?&](?:sidebar=0|nosidebar|shot)\b/.test(location.search) &&
    (!location.hash || /^#\/(?:c\/|$)/.test(location.hash))
  );
  const [panel, setPanel] = useState<{ id: string; version?: number } | null>(null);
  const [modal, setModal] = useState<null | 'agents' | 'tools' | 'settings' | 'palette'>(null);
  const [formFactorOpen, setFormFactorOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const [labAgent, setLabAgent] = useState<string>();
  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState('');

  const scroller = useRef<HTMLDivElement>(null);
  const loadConvs = useCallback(() => api.conversations().then(setConvs), []);
  const loadGroups = useCallback(() => api.chatProjects().then(setGroups).catch(() => {}), []);
  const { conv, setConv, convRef, busy, send: sendTurn, stop } = useChat({
    onEvent: (ev, id) => {
      if (ev.type === 'artifact' && convRef.current?.id === id) setPanel({ id: ev.artifact.id, version: ev.artifact.version });
      if (ev.type === 'title') setConvs(prev => prev.map(x => (x.id === id ? { ...x, title: ev.title } : x)));
    },
    onSettled: () => { loadConvs(); loadGroups(); setGroupRefresh(n => n + 1); },
  });

  const chatAgents = useMemo(() => agents.filter(a => !a.studio), [agents]);
  // agents that can audit a chat (verify.py): the cloud ones, Claude and Gemini by default
  const verifiers = useMemo(() => agents.filter(a => a.cloud), [agents]);
  const agent = agents.find(a => a.id === agentId) ?? chatAgents[0] ?? agents[0];
  // the composer's model picker (cloud agents): per agent, for this browser session, like efforts
  const [modelPicks, setModelPicks] = useState<Record<string, string>>({});
  const providerOf = (name?: string) => /^([\w-]+)\//.exec(name ?? '')?.[1];
  const modelChoices = useMemo(() => {
    const prov = agent?.cloud ? providerOf(agent.model) : undefined;
    if (!prov) return [];
    // Antigravity also serves other vendors' models; the Gemini agent offers just the Gemini ones
    return models.filter(m => providerOf(m.name) === prov && (prov !== 'antigravity' || /\/gemini/.test(m.name)));
  }, [agent, models]);
  const pickFor = (a?: Agent) => {
    const p = a ? modelPicks[a.id] : undefined;
    return p && p !== a?.model && providerOf(p) === providerOf(a?.model) ? p : undefined;
  };
  const activeModel = pickFor(agent) ?? agent?.model;
  const model = models.find(m => m.name === activeModel || `${m.name}:latest` === activeModel);
  const effort: Effort = (agent && efforts[agent.id]) ?? agent?.effort ?? 'medium';

  // ── data loading ────────────────────────────────────────────────────────
  const loadAgents = useCallback(() => api.agents().then(setAgents), []);
  const loadTools = useCallback(() => api.tools().then(setTools), []);
  const loadSettings = useCallback(() => api.settings().then(setSettings), []);
  // connectors and cloud settings change tools, agent availability, settings and the model list together
  const loadIntegrations = useCallback(() => {
    loadTools(); loadAgents(); loadSettings();
    api.models().then(setModels).catch(() => {});
  }, [loadTools, loadAgents, loadSettings]);

  useEffect(() => {
    Promise.all([loadAgents(), loadTools(), loadConvs(), api.settings().then(s => {
      setSettings(s); setAgentId(s.defaultAgent);
      // a theme saved on the server follows you from another device
      if (s.theme && themeInfo(s.theme)) applyTheme(s.theme as ThemeId);
      // agents' clock and scheduled tasks use this machine's users' time zone, not the server's (UTC)
      if (!s.timeZone) api.saveSettings({ timeZone: browserTz() }).then(setSettings).catch(() => {});
    })])
      .catch(e => setLoadError(String(e)));
    api.models().then(setModels).catch(() => {});
    loadGroups();
    const m = /[?&]modal=(agents|tools|settings|memory|system|network|apikeys|palette)/.exec(location.search)?.[1];
    if (m === 'memory' || m === 'system' || m === 'network' || m === 'apikeys') { setSettingsTab(m as SettingsTabId); setModal('settings'); }
    else if (m) setModal(m as 'agents' | 'tools' | 'settings' | 'palette');
    const poll = () => api.status().then(setStatus).catch(() => setStatus(undefined));
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    try {
      const c = await api.conversation(id);
      setConv(c);
      setGroupRoute(null);
      setLibrary(false);
      setScheduled(false);
      setActivity(false);
      setCodexRoute(null);
      setModelsRoute(false);
      setRadioRoute(false);
      setResearch(null);
      setPlans(null);
      setAssetRoute(null);
      pendingGroup.current = null;
      setAgentId(c.agentId);
      const art = readHashArtifact();
      setPanel(art && c.artifacts.some(a => a.id === art) ? { id: art } : null);
      if (!location.hash.startsWith(`#/c/${id}`)) history.replaceState(null, '', `#/c/${id}`);
      if (window.innerWidth < 768) setSidebar(false);
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
    } catch {
      history.replaceState(null, '', '#/');
      setConv(null);
    }
  }, []);

  useEffect(() => {
    const id = readHash();
    if (id) openConversation(id);
    const onHash = () => {
      // When apps are opened, collapse the chat panel
      if (location.hash && !/^#\/(?:c\/|$)/.test(location.hash)) {
        setSidebar(false);
      }
      setStudio(readStudio());
      setCode(readCode());
      setLibrary(readLibrary());
      setScheduled(readScheduled());
      setActivity(readActivity());
      setCodexRoute(readCodex());
      setModelsRoute(readModels());
      setSecretaryRoute(readSecretary());
      setGibberlinkRoute(readGibberlink());
      setRadioRoute(readRadio());
      setMapsRoute(readMaps());
      setWikiRoute(readWiki());
      setDataRoute(readData());
      setModal(m => (m === 'palette' ? m : null));  // following a link out of Settings or the Agent Lab closes it
      if (/^#\/memory\b/.test(location.hash)) {  // #/memory (Activity links) opens Settings → Memory over the current chat
        setSettingsTab('memory'); setModal('settings');
        history.replaceState(null, '', convRef.current ? `#/c/${convRef.current.id}` : location.pathname + location.search);
      }
      if (/^#\/backups\b/.test(location.hash)) {
        setSettingsTab('backups'); setModal('settings');
        history.replaceState(null, '', convRef.current ? `#/c/${convRef.current.id}` : location.pathname + location.search);
      }
      if (/^#\/apikeys\b/.test(location.hash)) {
        setSettingsTab('apikeys'); setModal('settings');
        history.replaceState(null, '', convRef.current ? `#/c/${convRef.current.id}` : location.pathname + location.search);
      }
      setResearch(readResearch());
      setPlans(readPlans());
      setAssetRoute(readAssets());
      setGroupRoute(readGroupRoute());
      const h = readHash();
      if (h && h !== convRef.current?.id) openConversation(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openConversation]);

  const newChat = useCallback((aid?: string) => {
    setConv(null);
    setStudio(null);
    setCode(null);
    setLibrary(false);
    setScheduled(false);
    setActivity(false);
    setCodexRoute(null);
    setModelsRoute(false);
    setSecretaryRoute(false);
    setResearch(null);
    setPlans(null);
    setAssetRoute(null);
    setGibberlinkRoute(false);
    setRadioRoute(false);
    setMapsRoute(false);
    setWikiRoute(null);
    setDataRoute(false);
    setGroupRoute(null);
    pendingGroup.current = null;
    setPanel(null);
    setAgentId(aid ?? settings?.defaultAgent ?? 'shellb');
    setFocusTick(t => t + 1);
    history.replaceState(null, '', '#/');
    if (window.innerWidth < 768) setSidebar(false);
  }, [settings]);

  const ensureConversation = useCallback(async () => {
    if (convRef.current) return convRef.current.id;
    const c = await api.createConversation(agentId, pendingGroup.current ?? undefined);
    pendingGroup.current = null;
    const full: Conversation = { ...c, messages: [], artifacts: [] };
    convRef.current = full;
    setConv(full);
    setConvs(prev => [c, ...prev]);
    history.replaceState(null, '', `#/c/${c.id}`);
    return c.id;
  }, [agentId]);

  // ── chat ────────────────────────────────────────────────────────────────
  const [voiceMode, setVoiceMode] = useState(false);  // hands-free conversation (components/VoiceMode.tsx)
  const send = useCallback(async (content: string, attachments: Attachment[], fromMessageId?: string, routeTo?: string, mode?: 'plan', voice?: boolean) => {
    if (busy || !agent) return;
    const id = await ensureConversation();
    setAtBottom(true);
    // an @mention answers this one turn as another agent, with that agent's effort; the chat keeps its own agent.
    // Edits and regenerations find the mention in the text again.
    const mentioned = routeTo ? agents.find(a => a.id === routeTo) : findMention(content, agents);
    const routed = mentioned && mentioned.id !== agent.id ? mentioned : undefined;
    await sendTurn(id, routed
      ? { content, attachments, agentId: routed.id, effort: efforts[routed.id] ?? routed.effort ?? 'medium', fromMessageId, routeOnly: true, mode, model: pickFor(routed), voice }
      : { content, attachments, agentId: agent.id, effort, fromMessageId, mode, model: pickFor(agent), voice });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, agent, agents, efforts, effort, modelPicks, ensureConversation, sendTurn]);

  // ── projects ────────────────────────────────────────────────────────────
  const openGroup = useCallback((id?: string) => { location.hash = id ? `#/p/${id}` : '#/projects'; if (window.innerWidth < 768) setSidebar(false); }, []);
  const startProjectChat = useCallback((gid: string, text: string) => {
    convRef.current = null;
    setConv(null);
    setPanel(null);
    setGroupRoute(null);
    pendingGroup.current = gid;
    history.replaceState(null, '', '#/');
    send(text, []);
  }, [send]);
  // Notes → "Brainstorm in a new chat": the note goes into the chat's /work as a file, then the prompt is sent
  const startNoteChat = useCallback(async (text: string, note: File) => {
    convRef.current = null;
    setConv(null);
    setPanel(null);
    setCodexRoute(null);
    pendingGroup.current = null;
    history.replaceState(null, '', '#/');
    const id = await ensureConversation();
    const att = await api.upload(id, note);
    await send(text, [att]);
  }, [ensureConversation, send]);
  const moveToGroup = useCallback(async (convId: string, gid: string | null) => {
    await api.patchConversation(convId, { groupId: gid });
    if (convRef.current?.id === convId) setConv(c => (c ? { ...c, groupId: gid } : c));
    loadConvs(); loadGroups(); setGroupRefresh(n => n + 1);
  }, [loadConvs, loadGroups]);
  const convGroup = groups.find(g => g.id === conv?.groupId);

  const regenerate = useCallback(() => {
    if (!conv) return;
    const lastUser = [...conv.messages].reverse().find(m => m.role === 'user');
    if (lastUser) send(lastUser.content, lastUser.attachments ?? [], lastUser.id, undefined, lastUser.mode);
  }, [conv, send]);

  // the buttons under a plan-mode reply: approving turns plan mode off and has the agent carry the plan out
  const onPlan = useCallback((action: 'approve' | 'revise') => {
    if (action === 'approve') {
      // the agent that wrote the plan carries it out, even if it was an @mention
      const planner = [...(conv?.messages ?? [])].reverse().find(m => m.role === 'assistant')?.agentId;
      setPlanMode(false);
      send('Approved. Go ahead and carry out the plan.', [], undefined, planner);
    } else { setPlanMode(true); setFocusTick(t => t + 1); }
  }, [conv, send]);

  // ── conversation ops ────────────────────────────────────────────────────
  const selectAgent = useCallback((a: Agent) => {
    setAgentId(a.id);
    if (conv) {
      api.patchConversation(conv.id, { agentId: a.id });
      setConv(c => (c ? { ...c, agentId: a.id } : c));
      setConvs(prev => prev.map(x => (x.id === conv.id ? { ...x, agentId: a.id } : x)));
    }
  }, [conv]);

  const forkChat = useCallback(async (convId: string, messageId?: string) => {
    try {
      const newConv = await api.forkConversation(convId, { messageId });
      await loadConvs();
      location.hash = `#/c/${newConv.id}`;
      setConv(null);
    } catch (err: unknown) {
      alert(`Failed to fork conversation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [loadConvs]);

  const compactChat = useCallback(async (convId: string) => {
    try {
      const res = await api.compactConversation(convId, { keepRecent: 4 });
      if (res.ok && res.compacted) {
        const c = await api.conversation(convId);
        setConv(c);
      } else if (res.message) {
        alert(res.message);
      }
    } catch (err: unknown) {
      alert(`Failed to compact conversation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const toggleSkin = useCallback(() => applyTheme(nextTheme()), []);

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.className = next;
      try { localStorage.setItem('shellb.theme', next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setModal(m => (m === 'palette' ? null : 'palette')); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setSidebar(s => !s); }
      else if (e.key === 'Escape' && !modal && panel) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, modal, panel]);

  // scheduled runs start and finish chats on their own; the status poll notices and refreshes the list
  const runMark = `${status?.scheduledRunAt ?? 0}|${status?.active.join(',') ?? ''}`;
  useEffect(() => { if (status) loadConvs(); }, [runMark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── autoscroll (only when already at the bottom) ────────────────────────
  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conv?.messages, atBottom]);

  const openStudio = useCallback((projectId?: string) => {
    location.hash = projectId ? `#/studio/${projectId}` : '#/studio';
  }, []);
  const openCode = useCallback((projectId?: string) => {
    location.hash = projectId ? `#/code/${projectId}` : '#/code';
  }, []);
  const openAssets = useCallback((libId?: string) => { location.hash = libId ? `#/assets/${libId}` : '#/assets'; setSidebar(false); }, []);
  const openPlans = useCallback((planId?: string) => { location.hash = planId ? `#/plans/${planId}` : '#/plans'; setSidebar(false); }, []);
  const openResearch = useCallback((boardId?: string) => { location.hash = boardId ? `#/research/${boardId}` : '#/research'; setSidebar(false); }, []);
  /** A new chat already attached to a research board, sent its first message straight away. */
  const startBoardChat = useCallback(async (boardId: string, aid: string, text: string) => {
    const c = await api.linkResearchChat(boardId, { agentId: aid });
    const full: Conversation = { ...c, messages: [], artifacts: [], researchBoard: { id: boardId, title: '' } };
    convRef.current = full;
    setConv(full);
    setConvs(prev => [c, ...prev]);
    setAgentId(c.agentId);
    setResearch(null); setLibrary(false); setScheduled(false); setActivity(false); setCodexRoute(null); setModelsRoute(false); setGroupRoute(null); setPanel(null);
    history.replaceState(null, '', `#/c/${c.id}`);
    const a = agents.find(x => x.id === c.agentId);
    await sendTurn(c.id, { content: text, attachments: [], agentId: c.agentId, effort: efforts[c.agentId] ?? a?.effort ?? 'medium' });
  }, [agents, efforts, sendTurn, setConv, convRef]);
  const startResearch = useCallback(async (question: string, aid: string) => {
    const b = await api.createResearchBoard({ title: question.length <= 80 ? question : '', question });
    await startBoardChat(b.id, aid, question);
  }, [startBoardChat]);
  const openLibraryArtifact = useCallback((convId: string, artifactId: string) => {
    location.hash = `#/c/${convId}/${artifactId}`;
    if (convRef.current?.id === convId) { setLibrary(false); setPanel({ id: artifactId }); }
  }, []);

  const openApp = useCallback((app: AppId) => {
    if (app === 'chat') { if (convRef.current) location.hash = `#/c/${convRef.current.id}`; else newChat(); }
    else if (app === 'agents') { setLabAgent(agentId); setModal('agents'); }
    else if (app === 'tools') setModal('tools');
    else if (app === 'settings') { setSettingsTab('system'); setModal('settings'); }
    else if (app === 'memory') { setSettingsTab('memory'); setModal('settings'); }
    else { location.hash = appById(app).hash!; setSidebar(false); }
  }, [newChat, agentId]);

  const paletteActions = useMemo(() => ({
    newChat, openConversation, toggleTheme, toggleSkin, openApp,
    openSettings: (tab: SettingsTabId = 'general') => { setSettingsTab(tab); setModal('settings'); },
    openFormFactor: () => setFormFactorOpen(true),
  }), [newChat, openConversation, toggleTheme, toggleSkin, openApp]);

  if (view) return <ArtifactViewer convId={view.convId} artifactId={view.artifactId} dark={theme === 'dark'} />;

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
        {loadError ? `Can't reach the Shell:B server: ${loadError}` : 'Waking Shell:B…'}
      </div>
    );
  }

  const modals = (
    <>
      <CommandPalette open={modal === 'palette'} onClose={() => setModal(null)} agents={chatAgents} conversations={convs} theme={theme} actions={paletteActions} />
      <AgentLab open={modal === 'agents'} onClose={() => setModal(null)} agents={agents} tools={tools} models={models} initialId={labAgent}
        onChanged={id => { loadAgents(); if (id) setLabAgent(id); }} />
      <IntegrationsModal open={modal === 'tools'} onClose={() => setModal(null)} tools={tools} settings={settings} onChanged={loadIntegrations}
        tab={/[?&]tab=(connectors|servers|skills|tools|cloud)/.exec(location.search)?.[1] as 'connectors' | undefined} />
      <NewProjectDialog open={newProject} onClose={() => setNewProject(false)}
        onCreated={g => { setNewProject(false); loadGroups(); openGroup(g.id); }} />
      <SettingsModal open={modal === 'settings'} onClose={() => setModal(null)} settings={settings} agents={chatAgents} models={models}
        status={status} theme={theme} onTheme={t => t !== theme && toggleTheme()} onSaved={loadSettings} tab={settingsTab} />
      <FormFactorSwitcher open={formFactorOpen} onClose={() => setFormFactorOpen(false)} />
    </>
  );

  const railApp = appForHash(location.hash);
  const rail = <AppRail active={railApp} status={status} onOpen={openApp} />;

  if (code) {
    return (
      <div className="h-full flex overflow-hidden">
        {rail}
        <div className="flex-1 min-w-0 h-full">
          <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Opening Code…</div>}>
            <Code projectId={code.projectId} agents={agents} models={models} theme={theme} onToggleTheme={toggleTheme}
              voiceOk={!!status?.services.hermes?.ok} onOpenAgents={id => { setLabAgent(id); setModal('agents'); }}
              onExit={() => { location.hash = '#/'; newChat(); }} onOpenProject={openCode} />
          </Suspense>
        </div>
        {modals}
      </div>
    );
  }

  if (studio) {
    return (
      <div className="h-full flex overflow-hidden">
        {rail}
        <div className="flex-1 min-w-0 h-full">
          <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Opening Studio…</div>}>
            <Studio projectId={studio.projectId} agents={agents} models={models} theme={theme} onToggleTheme={toggleTheme}
              voiceOk={!!status?.services.hermes?.ok} onOpenAgents={id => { setLabAgent(id); setModal('agents'); }}
              onExit={() => { location.hash = '#/'; newChat(); }} onOpenProject={openStudio} />
          </Suspense>
        </div>
        {modals}
      </div>
    );
  }

  const messages = conv?.messages ?? [];
  const artifacts = conv?.artifacts ?? [];
  const voiceOk = !!status?.services.hermes?.ok;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  // the chat's research board: from the server, or from a research_board call made during this session
  const chatBoard = conv?.researchBoard?.id ?? [...messages].reverse().flatMap(m => (m.blocks ?? []).flatMap(b => (b.type === 'tool' && b.display?.board ? [b.display.board.id] : [])))[0];

  return (
    <div className="h-full flex overflow-hidden">
      {rail}
      <Sidebar
        conversations={convs} activeId={conv?.id} agents={agents} status={status} open={sidebar} favoritesActive={library === 'favorites'}
        onClose={() => setSidebar(false)} onSelect={openConversation} onNew={() => newChat()}
        onDelete={async id => { await api.deleteConversation(id); if (conv?.id === id) newChat(); loadConvs(); }}
        onPin={async (id, pinned) => { await api.patchConversation(id, { pinned }); loadConvs(); }}
        onRename={async (id, title) => { await api.patchConversation(id, { title }); if (conv?.id === id) setConv(c => (c ? { ...c, title } : c)); loadConvs(); }}
        onFork={id => forkChat(id)}
        onOpenSettings={() => { setSettingsTab('system'); setModal('settings'); }}
        groups={groups} activeGroupId={groupRoute?.id ?? (groupRoute ? '' : undefined)} onOpenGroup={openGroup}
        onNewGroup={() => setNewProject(true)} onMoveToGroup={moveToGroup}
      />

      <main className="flex-1 flex flex-col min-w-0 h-full">
        <header className="sf-topbar h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
          {!sidebar && <button className={btn.icon} onClick={() => setSidebar(true)} title="Show sidebar (Ctrl+B)"><PanelLeft className="w-4 h-4" /></button>}
          <div className="flex-1 flex items-center gap-2 min-w-0">
            {radioRoute ? (
              <span className="text-sm font-medium flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#ff2e97]" />
                Shell:B FM · Radio &amp; DJ Workstation
              </span>
            ) : secretaryRoute ? <span className="text-sm font-medium">Secretary</span> : gibberlinkRoute ? <span className="text-sm font-medium">Gibberlink</span> : mapsRoute ? <span className="text-sm font-medium">Worlds</span> : wikiRoute !== null ? <span className="text-sm font-medium">Wiki</span> : dataRoute ? <span className="text-sm font-medium">Offline data</span> : assetRoute ? (
              <button className="text-sm font-medium hover:text-[var(--accent)] flex items-center gap-1.5" onClick={() => openAssets()}>
                <Shapes className="w-4 h-4 text-lime-500" />Assets
              </button>
            ) : plans ? (
              <button className="text-sm font-medium hover:text-[var(--accent)] flex items-center gap-1.5" onClick={() => openPlans()}>
                <Workflow className="w-4 h-4 text-violet-500" />Mega Plans
              </button>
            ) : research ? (
              <button className="text-sm font-medium hover:text-[var(--accent)] flex items-center gap-1.5" onClick={() => openResearch()}>
                <Telescope className="w-4 h-4 text-teal-500" />Research
              </button>
            ) : library || scheduled || activity || codexRoute !== null || modelsRoute ? (
              <span className="text-sm font-medium">{library === 'favorites' ? 'Favorites' : library ? 'Library' : scheduled ? 'Scheduled' : activity ? 'Activity' : codexRoute !== null ? (/^notes\b/.test(codexRoute) ? 'Notes' : /^contacts\b/.test(codexRoute) ? 'Contacts' : /^(events|calendar)\b/.test(codexRoute) ? 'Calendar' : 'Codex') : 'Models'}</span>
            ) : groupRoute ? (
              <>
                <button className="text-sm font-medium hover:text-[var(--accent)]" onClick={() => openGroup()}>Projects</button>
                {groupRoute.id && <span className="text-sm text-[var(--text-muted)] truncate">/ {groups.find(g => g.id === groupRoute.id)?.name ?? ''}</span>}
              </>
            ) : (
              <>
                {convGroup && (
                  <button onClick={() => openGroup(convGroup.id)} className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] min-w-0 max-w-[40%]" title="Open project">
                    <ProjectGlyph project={convGroup} size={18} /><span className="truncate">{convGroup.name}</span><span className="text-[var(--text-muted)]">/</span>
                  </button>
                )}
                <AgentAvatar agent={agent} size={18} />
                <span className="text-sm font-medium truncate">{conv?.title ?? `New chat with ${agent.name}`}</span>
                {conv && <FavoriteStar kind="chat" id={conv.id} title={conv.title} />}
                {conv && (
                  <div className="flex items-center gap-0.5 ml-1">
                    <button className={btn.icon} onClick={() => forkChat(conv.id)} title="Fork this conversation">
                      <GitFork className="w-3.5 h-3.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" />
                    </button>
                    {messages.length > 4 && (
                      <button className={btn.icon} onClick={() => compactChat(conv.id)} title="Compact conversation (summarize older history to save context)">
                        <Archive className="w-3.5 h-3.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <Downloads initial={status?.downloads} />
          <button onClick={() => setModal('palette')} className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
            <Search className="w-3.5 h-3.5" /><span>Search</span>
            <kbd className="text-[9px] font-mono px-1 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">Ctrl K</kbd>
          </button>
          <button onClick={() => setModal('palette')} className={clsx(btn.icon, 'sm:hidden')} aria-label="Search"><Search className="w-4 h-4" /></button>
          {conv?.megaPlan && !plans && !research && !groupRoute && !library && !scheduled && !activity && codexRoute === null && !modelsRoute && !assetRoute && !radioRoute && (
            <button onClick={() => openPlans(conv.megaPlan!.id)} title={`This chat is ${conv.megaPlan.role === 'step' ? 'a step' : conv.megaPlan.role === 'orchestrator' ? 'the orchestrator' : 'the creator'} of the mega plan "${conv.megaPlan.title}"`}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-violet-500/40 text-xs text-violet-600 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 transition">
              <Workflow className="w-3.5 h-3.5" /><span className="hidden sm:inline">Mega plan</span>
            </button>
          )}
          {chatBoard && !plans && !research && !groupRoute && !library && !scheduled && !activity && codexRoute === null && !modelsRoute && !assetRoute && !radioRoute && (
            <button onClick={() => openResearch(chatBoard)} title="Open this chat's research board"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-teal-500/40 text-xs text-teal-600 dark:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 transition">
              <Telescope className="w-3.5 h-3.5" /><span className="hidden sm:inline">Research board</span>
            </button>
          )}
          {conv && !plans && !research && !groupRoute && !library && !scheduled && !activity && codexRoute === null && !modelsRoute && !assetRoute && !radioRoute && <WorkspaceFiles convId={conv.id} refreshKey={`${messages.length}-${busy}`} />}
          {artifacts.length > 0 && !plans && !research && !library && !scheduled && !activity && codexRoute === null && !modelsRoute && !assetRoute && !groupRoute && !radioRoute && (
            <button onClick={() => setPanel(p => (p ? null : { id: artifacts[artifacts.length - 1].id }))}
              className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition',
                panel ? 'bg-[var(--accent)]/15 text-[var(--accent-soft)] border-[var(--accent)]/40' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
              <PanelRight className="w-3.5 h-3.5" /><span className="hidden sm:inline">Artifacts</span>
              <span className="font-mono text-[10px]">{artifacts.length}</span>
            </button>
          )}
          <button className={btn.icon} onClick={() => setFormFactorOpen(true)} title="Display Form Factor (Desktop / Mobile / Kiosk)"><Smartphone className="w-4 h-4" /></button>
          <button className={btn.icon} onClick={toggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
        </header>

        {secretaryRoute ? (
          <div className="flex-1 min-h-0"><Secretary onBack={() => { location.hash = '#'; }} /></div>
        ) : radioRoute ? (
          <div className="flex-1 min-h-0"><RadioApp /></div>
        ) : gibberlinkRoute ? (
          <div className="flex-1 min-h-0"><Gibberlink /></div>
        ) : mapsRoute ? (
          <div className="flex-1 min-h-0"><MapsApp /></div>
        ) : wikiRoute !== null ? (
          <div className="flex-1 min-h-0"><Wiki route={wikiRoute} /></div>
        ) : dataRoute ? (
          <div className="flex-1 min-h-0"><OfflineData /></div>
        ) : assetRoute ? (
          <div className="flex-1 min-h-0">
            {assetRoute.libId ? (
              <AssetLibraryView key={assetRoute.libId} libId={assetRoute.libId} agents={agents} live={status?.assetJob}
                onBack={() => openAssets()} onOpen={id => openAssets(id)} onOpenChat={id => { location.hash = `#/c/${id}`; }} />
            ) : (
              <AssetsIndex agents={agents} live={status?.assetJob} onOpen={id => openAssets(id)} onOpenChat={id => { location.hash = `#/c/${id}`; }} />
            )}
          </div>
        ) : plans ? (
          <div className="flex-1 min-h-0">
            {plans.planId ? (
              <MegaPlanBoard key={plans.planId} planId={plans.planId} agents={agents} live={status?.megaPlan}
                onBack={() => openPlans()} onOpenChat={id => { location.hash = `#/c/${id}`; }} onOpenWorkspace={id => openCode(id)} />
            ) : (
              <MegaPlansIndex agents={agents} live={status?.megaPlan} onOpen={id => openPlans(id)} />
            )}
          </div>
        ) : research ? (
          <div className="flex-1 min-h-0">
            {research.boardId ? (
              <ResearchBoardView key={research.boardId} boardId={research.boardId} agents={agents} activeConvs={status?.active ?? []}
                onBack={() => openResearch()} onOpenChat={id => { location.hash = `#/c/${id}`; }}
                onAsk={(bid, aid, text) => { startBoardChat(bid, aid, text).catch(() => {}); }} />
            ) : (
              <ResearchIndex agents={agents} activeConvs={status?.active ?? []} onOpen={(id, add) => openResearch(add ? `${id}/add` : id)}
                onStart={(q, aid) => { startResearch(q, aid).catch(() => {}); }} />
            )}
          </div>
        ) : modelsRoute && !library && !scheduled && !activity && codexRoute === null ? (
          <div className="flex-1 min-h-0">
            <Models busyTurns={status?.active.length ?? 0} />
          </div>
        ) : codexRoute !== null && !library && !scheduled && !activity ? (
          <div className="flex-1 min-h-0">
            {/^notes\b/.test(codexRoute) ? <Notes sub={codexRoute} onDiscuss={startNoteChat} />
              : <Codex sub={codexRoute} agentNames={Object.fromEntries(agents.map(a => [a.id, a.name]))} />}
          </div>
        ) : activity && !library && !scheduled ? (
          <div className="flex-1 min-h-0">
            <Activity live={status?.activity} />
          </div>
        ) : scheduled && !library ? (
          <div className="flex-1 min-h-0">
            <Scheduled agents={agents} groups={groups} defaultAgent={settings?.defaultAgent ?? 'shellb'}
              onOpenChat={id => { location.hash = `#/c/${id}`; }} />
          </div>
        ) : library ? (
          <div className="flex-1 min-h-0">
            {library === 'favorites' ? <FavoritesPage agents={agents} />
              : <Library agents={agents} dark={theme === 'dark'} onOpenArtifact={openLibraryArtifact} initial={library === 'media' ? 'media' : 'all'} />}
          </div>
        ) : groupRoute ? (
          <div className="flex-1 min-h-0">
            {groupRoute.id ? (
              <ProjectPage projectId={groupRoute.id} agents={agents} agent={agent} refreshKey={groupRefresh}
                onBack={() => openGroup()} onOpenChat={(id, art) => { location.hash = art ? `#/c/${id}/${art}` : `#/c/${id}`; }}
                onStartChat={text => startProjectChat(groupRoute.id!, text)} onChanged={loadGroups}
                onDeleted={() => { loadGroups(); loadConvs(); openGroup(); }} />
            ) : (
              <ProjectsIndex projects={groups} onOpen={id => openGroup(id)} onNew={() => setNewProject(true)} />
            )}
          </div>
        ) : (<>
        <div className="flex-1 min-h-0 relative">
          <div ref={scroller} className="h-full overflow-y-auto"
            onScroll={e => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }}>
            {messages.length === 0 ? (
              <div className="sf-hero max-w-2xl mx-auto px-4 min-h-full flex flex-col items-center justify-center text-center py-10 animate-fade-in">
                <AgentAvatar agent={agent} size={56} className="rounded-2xl shadow-xl mb-4" />
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{greeting()}.</h1>
                <p className="text-sm text-[var(--text-secondary)] mt-2 max-w-md">
                  <span className="font-medium text-[var(--text-primary)]">{agent.name}</span> · {agent.description}
                </p>
                <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                  {(QUICK[agent.id] ?? QUICK.shellb).map(q => (
                    <button key={q.title} onClick={() => send(q.prompt, [])}
                      className="sf-card p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] transition group text-left">
                      <div className="text-xs font-semibold group-hover:text-[var(--accent-soft)] transition">{q.title}</div>
                      <div className="text-[12px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{q.prompt}</div>
                    </button>
                  ))}
                </div>
                <p className="sf-tagline mt-8 text-[11px] text-[var(--text-muted)]">Overthink. Overcomplicate. Overengineer. Nothing you type leaves this machine.</p>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-7">
                {messages.map(m => (
                  <MessageView
                    key={m.id} message={m} agent={agents.find(a => a.id === m.agentId) ?? agent}
                    isLast={m === lastAssistant} busy={busy || !!conv?.streaming} activeArtifact={panel?.id}
                    onOpenArtifact={(id, version) => setPanel({ id, version })}
                    onRegenerate={regenerate}
                    onFork={msgId => conv && forkChat(conv.id, msgId)}
                    onEdit={text => send(text, m.attachments ?? [], m.id, undefined, m.mode)} onPlan={onPlan}
                    artifacts={artifacts} onAsk={text => send(text, [])}
                    verifiers={verifiers}
                    onVerify={vid => {
                      const n = messages.indexOf(m) + 1;
                      const what = m.status === 'error' ? `Reply #${n} failed: find out why and how to fix it.`
                        : m.status === 'stopped' ? `Reply #${n} was stopped: check what it got done and what is missing.`
                        : `Check reply #${n} and what led to it.`;
                      send(`/verify-chat ${what}`, [], undefined, vid);
                    }}
                    onOpenFile={path => conv && window.open(`/api/workspace/${conv.id}/${path.replace(/^\/?work\//, '').split('/').map(encodeURIComponent).join('/')}`, '_blank', 'noopener')}
                  />
                ))}
                <div className="h-4" />
              </div>
            )}
          </div>
          {!atBottom && messages.length > 0 && (
            <button onClick={() => { setAtBottom(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }); }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 p-2 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] shadow-lg hover:bg-[var(--bg-hover)]" aria-label="Jump to latest">
              <ArrowDown className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="shrink-0 px-3 sm:px-4 pb-3 pt-1">
          <div className="max-w-3xl mx-auto">
            {voiceMode && (
              <VoiceMode reply={lastAssistant} busy={busy || !!conv?.streaming} onStop={stop} onClose={() => setVoiceMode(false)}
                onSend={t => send(t, [], undefined, undefined, undefined, true)} />
            )}
            <Composer
              agent={agent} agents={chatAgents} model={model} effort={effort}
              onEffort={e => setEfforts(prev => ({ ...prev, [agent.id]: e }))}
              modelChoices={modelChoices} onModel={m => setModelPicks(prev => ({ ...prev, [agent.id]: m }))}
              onAgent={selectAgent} busy={busy || !!conv?.streaming} onSend={(t, a, o) => send(t, a, undefined, o?.agentId, o?.mode)} onStop={stop}
              convId={conv?.id} onCommand={() => newChat()} planMode={planMode} onPlanMode={setPlanMode}
              ensureConversation={ensureConversation} voiceOk={voiceOk} focusKey={`${conv?.id ?? 'new'}:${focusTick}`}
              onVoiceMode={voiceMode ? undefined : () => setVoiceMode(true)}
            />
            <div className="text-center text-[10px] text-[var(--text-muted)] mt-1.5">
              {activeModel}{agent.cloud ? '' : ' · local'} · Shell:B can make mistakes; check anything important.
            </div>
          </div>
        </div>
        </>)}
      </main>

      {panel && artifacts.length > 0 && !plans && !research && !groupRoute && !library && !scheduled && !activity && codexRoute === null && !modelsRoute && !assetRoute && (
        <ArtifactPanel groups={artifacts} activeId={panel.id} version={panel.version} dark={theme === 'dark'} convId={conv?.id}
          onSelect={(id, version) => setPanel({ id, version })} onClose={() => setPanel(null)} />
      )}

      {modals}
    </div>
  );
}
