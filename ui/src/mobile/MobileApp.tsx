import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, Boxes, Workflow } from 'lucide-react';
import { api } from '../api';
import type {
  Agent,
  Attachment,
  ChatProject,
  Conversation,
  ConversationSummary,
  Effort,
  ModelInfo,
  Settings,
  SettingsTabId,
  Status,
  ToolInfo,
} from '../types';
import { useSuggestions } from '../suggestions';
import { useChat } from '../useChat';
import { appById, appForHash, type AppId } from '../components/apps';
import { MessageView } from '../components/MessageView';
import { findMention } from '../components/ComposerShortcuts';
import { CommandPalette, SettingsModal } from '../components/Panels';
import { IntegrationsModal } from '../components/Integrations';
import { NewProjectDialog, ProjectPage, ProjectsIndex } from '../components/Projects';
import { AgentAvatar } from '../components/common';
import { ArtifactViewer, Library } from '../components/Library';
import { FavoritesPage } from '../components/Favorites';
import { Scheduled, browserTz } from '../components/Scheduled';
import { Activity } from '../components/Activity';
import { Codex } from '../components/Codex';
import { Notes } from '../components/Notes';
import { Me } from '../components/Me';
import { Models } from '../components/Models';
import { Generate } from '../components/Generate';
import { Wiki } from '../components/Wiki';
import { OfflineData } from '../components/OfflineData';
import { VoiceMode } from '../components/VoiceMode';
import { ResearchBoardView, ResearchIndex } from '../components/Research';
import { MegaPlanBoard, MegaPlansIndex } from '../components/MegaPlans';
import { AssetLibraryView, AssetsIndex } from '../components/Assets';
import { Gibberlink } from '../components/Gibberlink';
import { Secretary } from '../components/Secretary';
import { MapsApp } from '../maps/MapsApp';
import { RadioApp } from '../radio/RadioApp';
import { AgentLab } from '../components/AgentLab';
import { nextTheme, setTheme as applyTheme, themeInfo, type ThemeId } from '../themes';

import { MobileTopBar } from './MobileTopBar';
import { MobileBottomNav, type MobileTab } from './MobileBottomNav';
import { MobileDrawer } from './MobileDrawer';
import { MobileComposer } from './MobileComposer';
import { MobileAppsSheet } from './MobileAppsSheet';
import { MobileArtifactSheet } from './MobileArtifactSheet';
import { MobileAgentPicker } from './MobileAgentPicker';
import { MobileRadioBar } from './MobileRadioBar';
import { FormFactorSwitcher } from './FormFactorSwitcher';

const Studio = lazy(() => import('../studio/Studio'));
const Code = lazy(() => import('../code/Code'));

const QUICK: Record<string, { title: string; prompt: string }[]> = {
  shellb: [
    { title: 'Catch me up', prompt: "What's new in open-weight LLMs this month? Search, read a few sources, and give me a tight summary with links." },
    { title: 'Build a tool', prompt: 'Build an interactive electronics unit converter (Ω, F, H, Hz, dBm↔mW, AWG↔mm²) as a polished HTML artifact.' },
    { title: 'Run the numbers', prompt: 'Plot the Bode magnitude and phase of a 2nd-order Butterworth low-pass filter with fc = 1 kHz. Use the sandbox and show me the plot.' },
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
const readGenerate = () => /^#\/generate\b/.test(location.hash);
const readSecretary = () => /^#\/secretary\b/.test(location.hash);
const readGibberlink = () => /^#\/gibberlink\b/.test(location.hash);
const readMaps = () => /^#\/(worlds|maps)\b/.test(location.hash);
const readWiki = () => { const m = /^#\/wiki(\/.*)?$/.exec(location.hash); return m ? m[1] ?? '' : null; };
const readData = () => /^#\/data\b/.test(location.hash);
const readCodex = () => { const m = /^#\/codex(?:\/(.*))?$/.exec(location.hash); return m ? m[1] ?? '' : null; };
const readResearch = () => { const m = /^#\/research(?:\/([\w-]+))?/.exec(location.hash); return m ? { boardId: m[1] } : null; };
const readAssets = () => { const m = /^#\/assets(?:\/([\w-]+))?/.exec(location.hash); return m ? { libId: m[1] } : null; };
const readPlans = () => { const m = /^#\/plans(?:\/([\w-]+))?/.exec(location.hash); return m ? { planId: m[1] } : null; };
const readView = () => { const m = /^#\/view\/([\w-]+)\/([\w-]+)/.exec(location.hash); return m ? { convId: m[1], artifactId: m[2] } : null; };
const readCode = () => { const m = /^#\/code(?:\/([\w-]+))?(?![\w-])/.exec(location.hash); return m ? { projectId: m[1] } : null; };
const readRadio = () => /^#\/(radio|dj|fm)\b/.test(location.hash);

export function MobileApp() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.classList.contains('light') ? 'light' : 'dark'
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<Status>();
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('shellb');
  const [efforts, setEfforts] = useState<Record<string, Effort>>({});
  const [planMode, setPlanMode] = useState(false);

  // App routing states
  const [studio, setStudio] = useState(readStudio);
  const [code, setCode] = useState(readCode);
  const [library, setLibrary] = useState(readLibrary);
  const [scheduled, setScheduled] = useState(readScheduled);
  const [activity, setActivity] = useState(readActivity);
  const [codexRoute, setCodexRoute] = useState(readCodex);
  const [modelsRoute, setModelsRoute] = useState(readModels);
  const [generateRoute, setGenerateRoute] = useState(readGenerate);
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
  const [focusTick, setFocusTick] = useState(0);
  const pendingGroup = useRef<string | null>(null);

  // Mobile navigation drawers & modals
  const [drawerOpen, setDrawerOpen] = useState(() => /[?&]drawer=1/.test(location.search));
  const [agentPickerOpen, setAgentPickerOpen] = useState(() => /[?&]agents=1/.test(location.search));
  const [appsSheetOpen, setAppsSheetOpen] = useState(() => /[?&]apps=1/.test(location.search));
  const [formFactorOpen, setFormFactorOpen] = useState(() => /[?&]switch=1/.test(location.search));
  const [artifactSheetOpen, setArtifactSheetOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<{ id: string; version?: number } | null>(null);
  const [modal, setModal] = useState<null | 'agents' | 'tools' | 'settings' | 'palette'>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('general');
  const [labAgent, setLabAgent] = useState<string>();

  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const loadConvs = useCallback(() => api.conversations().then(setConvs), []);
  const loadGroups = useCallback(() => api.chatProjects().then(setGroups).catch(() => {}), []);

  const { conv, setConv, convRef, busy, send: sendTurn, stop } = useChat({
    onEvent: (ev, id) => {
      if (ev.type === 'artifact' && convRef.current?.id === id) {
        setActiveArtifact({ id: ev.artifact.id, version: ev.artifact.version });
        setArtifactSheetOpen(true);
      }
      if (ev.type === 'title') {
        setConvs(prev => prev.map(x => (x.id === id ? { ...x, title: ev.title } : x)));
      }
    },
    onSettled: () => {
      loadConvs();
      loadGroups();
      setGroupRefresh(n => n + 1);
    },
  });

  const chatAgents = useMemo(() => agents.filter(a => !a.studio), [agents]);
  const verifiers = useMemo(() => agents.filter(a => a.cloud), [agents]);
  const agent = agents.find(a => a.id === agentId) ?? chatAgents[0] ?? agents[0];
  const quick = useSuggestions(agent?.id ?? 'shellb', QUICK[agent?.id ?? 'shellb'] ?? QUICK.shellb);

  const [modelPicks, setModelPicks] = useState<Record<string, string>>({});
  const providerOf = (name?: string) => /^([\w-]+)\//.exec(name ?? '')?.[1];
  const modelChoices = useMemo(() => {
    const prov = agent?.cloud ? providerOf(agent.model) : undefined;
    if (!prov) return [];
    return models.filter(m => providerOf(m.name) === prov && (prov !== 'antigravity' || /\/gemini/.test(m.name)));
  }, [agent, models]);
  const pickFor = (a?: Agent) => {
    const p = a ? modelPicks[a.id] : undefined;
    return p && p !== a?.model && providerOf(p) === providerOf(a?.model) ? p : undefined;
  };
  const activeModel = pickFor(agent) ?? agent?.model;
  const model = models.find(m => m.name === activeModel || `${m.name}:latest` === activeModel);
  const effort: Effort = (agent && efforts[agent.id]) ?? agent?.effort ?? 'medium';

  // Data loading
  const loadAgents = useCallback(() => api.agents().then(setAgents), []);
  const loadTools = useCallback(() => api.tools().then(setTools), []);
  const loadSettings = useCallback(() => api.settings().then(setSettings), []);
  const loadIntegrations = useCallback(() => {
    loadTools();
    loadAgents();
    loadSettings();
    api.models().then(setModels).catch(() => {});
  }, [loadTools, loadAgents, loadSettings]);

  useEffect(() => {
    Promise.all([
      loadAgents(),
      loadTools(),
      loadConvs(),
      api.settings().then(s => {
        setSettings(s);
        setAgentId(s.defaultAgent);
        if (s.theme && themeInfo(s.theme)) applyTheme(s.theme as ThemeId);
        if (!s.timeZone) api.saveSettings({ timeZone: browserTz() }).then(setSettings).catch(() => {});
      }),
    ]).catch(e => setLoadError(String(e)));
    api.models().then(setModels).catch(() => {});
    loadGroups();
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
      setGenerateRoute(false);
      setRadioRoute(false);
      setResearch(null);
      setPlans(null);
      setAssetRoute(null);
      pendingGroup.current = null;
      setAgentId(c.agentId);
      const art = readHashArtifact();
      if (art && c.artifacts.some(a => a.id === art)) {
        setActiveArtifact({ id: art });
        setArtifactSheetOpen(true);
      }
      if (!location.hash.startsWith(`#/c/${id}`)) history.replaceState(null, '', `#/c/${id}`);
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
    } catch {
      history.replaceState(null, '', '#/');
      setConv(null);
    }
  }, [setConv]);

  useEffect(() => {
    const id = readHash();
    if (id) openConversation(id);
    const onHash = () => {
      setStudio(readStudio());
      setCode(readCode());
      setLibrary(readLibrary());
      setScheduled(readScheduled());
      setActivity(readActivity());
      setCodexRoute(readCodex());
      setModelsRoute(readModels());
      setGenerateRoute(readGenerate());
      setSecretaryRoute(readSecretary());
      setGibberlinkRoute(readGibberlink());
      setRadioRoute(readRadio());
      setMapsRoute(readMaps());
      setWikiRoute(readWiki());
      setDataRoute(readData());
      setResearch(readResearch());
      setPlans(readPlans());
      setAssetRoute(readAssets());
      setGroupRoute(readGroupRoute());
      const h = readHash();
      if (h && h !== convRef.current?.id) openConversation(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openConversation, convRef]);

  const newChat = useCallback((aid?: string) => {
    setConv(null);
    setStudio(null);
    setCode(null);
    setLibrary(false);
    setScheduled(false);
    setActivity(false);
    setCodexRoute(null);
    setModelsRoute(false);
    setGenerateRoute(false);
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
    setActiveArtifact(null);
    setArtifactSheetOpen(false);
    setAgentId(aid ?? settings?.defaultAgent ?? 'shellb');
    setFocusTick(t => t + 1);
    history.replaceState(null, '', '#/');
  }, [settings, setConv]);

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
  }, [agentId, setConv, convRef]);

  const send = useCallback(
    async (
      content: string,
      attachments: Attachment[],
      fromMessageId?: string,
      routeTo?: string,
      mode?: 'plan',
      voice?: boolean
    ) => {
      if (busy || !agent) return;
      const id = await ensureConversation();
      setAtBottom(true);
      const mentioned = routeTo ? agents.find(a => a.id === routeTo) : findMention(content, agents);
      const routed = mentioned && mentioned.id !== agent.id ? mentioned : undefined;
      await sendTurn(
        id,
        routed
          ? {
              content,
              attachments,
              agentId: routed.id,
              effort: efforts[routed.id] ?? routed.effort ?? 'medium',
              fromMessageId,
              routeOnly: true,
              mode,
              model: pickFor(routed),
              voice,
            }
          : {
              content,
              attachments,
              agentId: agent.id,
              effort,
              fromMessageId,
              mode,
              model: pickFor(agent),
              voice,
            }
      );
    },
    [busy, agent, agents, efforts, effort, ensureConversation, sendTurn]
  );

  const openGroup = useCallback((id?: string) => {
    location.hash = id ? `#/p/${id}` : '#/projects';
  }, []);

  const openApp = useCallback(
    (app: AppId) => {
      if (app === 'chat') {
        if (convRef.current) location.hash = `#/c/${convRef.current.id}`;
        else newChat();
      } else if (app === 'agents') {
        setLabAgent(agentId);
        setModal('agents');
      } else if (app === 'tools') {
        setModal('tools');
      } else if (app === 'settings') {
        setSettingsTab('general');
        setModal('settings');
      } else if (app === 'memory') {
        setSettingsTab('memory');
        setModal('settings');
      } else {
        location.hash = appById(app).hash!;
      }
    },
    [newChat, agentId, convRef]
  );

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.className = next;
      try {
        localStorage.setItem('shellb.theme', next);
      } catch {}
      return next;
    });
  }, []);

  const regenerate = useCallback(() => {
    if (!conv) return;
    const lastUser = [...conv.messages].reverse().find(m => m.role === 'user');
    if (lastUser) send(lastUser.content, lastUser.attachments ?? [], lastUser.id, undefined, lastUser.mode);
  }, [conv, send]);

  const onPlan = useCallback(
    (action: 'approve' | 'revise') => {
      if (action === 'approve') {
        const planner = [...(conv?.messages ?? [])].reverse().find(m => m.role === 'assistant')?.agentId;
        setPlanMode(false);
        send('Approved. Go ahead and carry out the plan.', [], undefined, planner);
      } else {
        setPlanMode(true);
        setFocusTick(t => t + 1);
      }
    },
    [conv, send]
  );

  const selectAgent = useCallback(
    (a: Agent) => {
      setAgentId(a.id);
      if (conv) {
        api.patchConversation(conv.id, { agentId: a.id });
        setConv(c => (c ? { ...c, agentId: a.id } : c));
        setConvs(prev => prev.map(x => (x.id === conv.id ? { ...x, agentId: a.id } : x)));
      }
    },
    [conv, setConv]
  );

  const moveToGroup = useCallback(
    async (convId: string, gid: string | null) => {
      await api.patchConversation(convId, { groupId: gid });
      if (convRef.current?.id === convId) setConv(c => (c ? { ...c, groupId: gid } : c));
      loadConvs();
      loadGroups();
      setGroupRefresh(n => n + 1);
    },
    [loadConvs, loadGroups, setConv, convRef]
  );

  // Autoscroll
  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conv?.messages, atBottom]);

  if (view) return <ArtifactViewer convId={view.convId} artifactId={view.artifactId} dark={theme === 'dark'} />;

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)] bg-[var(--bg-primary)]">
        {loadError ? `Can't reach the Shell:B server: ${loadError}` : 'Waking Shell:B Mobile…'}
      </div>
    );
  }

  const messages = conv?.messages ?? [];
  const artifacts = conv?.artifacts ?? [];
  const voiceOk = !!status?.services.hermes?.ok;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const convGroup = groups.find(g => g.id === conv?.groupId);

  // Check if any sub-app route is active
  const isAppActive =
    studio ||
    code ||
    radioRoute ||
    secretaryRoute ||
    gibberlinkRoute ||
    mapsRoute ||
    wikiRoute !== null ||
    dataRoute ||
    assetRoute ||
    plans ||
    research ||
    modelsRoute ||
    generateRoute ||
    codexRoute !== null ||
    activity ||
    scheduled ||
    library ||
    groupRoute;

  let currentAppTitle: string | undefined;
  if (radioRoute) currentAppTitle = 'Shell:B FM · Radio & DJ';
  else if (secretaryRoute) currentAppTitle = 'Secretary';
  else if (gibberlinkRoute) currentAppTitle = 'Gibberlink';
  else if (mapsRoute) currentAppTitle = 'Worlds (Maps)';
  else if (wikiRoute !== null) currentAppTitle = 'Wiki';
  else if (dataRoute) currentAppTitle = 'Offline Data';
  else if (assetRoute) currentAppTitle = 'Assets';
  else if (plans) currentAppTitle = 'Mega Plans';
  else if (research) currentAppTitle = 'Research';
  else if (modelsRoute) currentAppTitle = 'Models';
  else if (generateRoute) currentAppTitle = 'Generate';
  else if (codexRoute !== null) currentAppTitle = /^me\b/.test(codexRoute) ? 'Me' : /^notes\b/.test(codexRoute) ? 'Notes' : 'Codex';
  else if (activity) currentAppTitle = 'Activity';
  else if (scheduled) currentAppTitle = 'Scheduled';
  else if (library) currentAppTitle = library === 'favorites' ? 'Favorites' : 'Library';
  else if (groupRoute) currentAppTitle = 'Projects';

  const currentTab: MobileTab = isAppActive
    ? activity
      ? 'activity'
      : 'apps'
    : 'chat';

  const handleTabChange = (t: MobileTab) => {
    if (t === 'chat') {
      if (isAppActive) {
        if (convRef.current) location.hash = `#/c/${convRef.current.id}`;
        else newChat();
      }
    } else if (t === 'recents') {
      setDrawerOpen(true);
    } else if (t === 'apps') {
      setAppsSheetOpen(true);
    } else if (t === 'activity') {
      location.hash = '#/activity';
    } else if (t === 'more') {
      setSettingsTab('general');
      setModal('settings');
    }
  };

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Mobile Top Bar */}
      <MobileTopBar
        agent={agent}
        conv={conv}
        status={status}
        onOpenDrawer={() => setDrawerOpen(true)}
        onOpenAgentPicker={() => setAgentPickerOpen(true)}
        onNewChat={() => newChat()}
        onOpenPalette={() => setModal('palette')}
        onOpenSettings={() => {
          setSettingsTab('general');
          setModal('settings');
        }}
        onOpenFormFactor={() => setFormFactorOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        appTitle={currentAppTitle}
        onBackFromApp={() => {
          if (convRef.current) location.hash = `#/c/${convRef.current.id}`;
          else newChat();
        }}
        group={convGroup}
        onOpenGroup={openGroup}
      />

      {/* Main View Area */}
      <main className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
        {secretaryRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Secretary onBack={() => newChat()} />
          </div>
        ) : radioRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <RadioApp />
          </div>
        ) : gibberlinkRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Gibberlink />
          </div>
        ) : mapsRoute ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <MapsApp />
          </div>
        ) : wikiRoute !== null ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Wiki route={wikiRoute} />
          </div>
        ) : dataRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <OfflineData />
          </div>
        ) : assetRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {assetRoute.libId ? (
              <AssetLibraryView
                libId={assetRoute.libId}
                agents={agents}
                live={status?.assetJob}
                onBack={() => {
                  location.hash = '#/assets';
                }}
                onOpen={id => {
                  location.hash = `#/assets/${id}`;
                }}
                onOpenChat={id => {
                  location.hash = `#/c/${id}`;
                }}
              />
            ) : (
              <AssetsIndex
                agents={agents}
                live={status?.assetJob}
                onOpen={id => {
                  location.hash = `#/assets/${id}`;
                }}
                onOpenChat={id => {
                  location.hash = `#/c/${id}`;
                }}
              />
            )}
          </div>
        ) : plans ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {plans.planId ? (
              <MegaPlanBoard
                planId={plans.planId}
                agents={agents}
                live={status?.megaPlan}
                onBack={() => {
                  location.hash = '#/plans';
                }}
                onOpenChat={id => {
                  location.hash = `#/c/${id}`;
                }}
                onOpenWorkspace={id => {
                  location.hash = `#/code/${id}`;
                }}
              />
            ) : (
              <MegaPlansIndex
                agents={agents}
                live={status?.megaPlan}
                onOpen={id => {
                  location.hash = `#/plans/${id}`;
                }}
              />
            )}
          </div>
        ) : research ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {research.boardId ? (
              <ResearchBoardView
                boardId={research.boardId}
                agents={agents}
                activeConvs={status?.active ?? []}
                onBack={() => {
                  location.hash = '#/research';
                }}
                onOpenChat={id => {
                  location.hash = `#/c/${id}`;
                }}
                onAsk={async (bid, aid, text) => {
                  const c = await api.linkResearchChat(bid, { agentId: aid });
                  location.hash = `#/c/${c.id}`;
                }}
              />
            ) : (
              <ResearchIndex
                agents={agents}
                activeConvs={status?.active ?? []}
                onOpen={(id, add) => {
                  location.hash = `#/research/${id}${add ? '/add' : ''}`;
                }}
                onStart={async (q, aid) => {
                  const b = await api.createResearchBoard({ title: q.slice(0, 50), question: q });
                  const c = await api.linkResearchChat(b.id, { agentId: aid });
                  location.hash = `#/c/${c.id}`;
                }}
              />
            )}
          </div>
        ) : modelsRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Models busyTurns={status?.active.length ?? 0} />
          </div>
        ) : generateRoute ? (
          <div className="flex-1 min-h-0">
            <Generate />
          </div>
        ) : codexRoute !== null ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/^me\b/.test(codexRoute) ? (
              <Me />
            ) : /^notes\b/.test(codexRoute) ? (
              <Notes
                sub={codexRoute}
                onDiscuss={async (text, note) => {
                  const id = await ensureConversation();
                  const att = await api.upload(id, note);
                  send(text, [att]);
                }}
              />
            ) : (
              <Codex
                sub={codexRoute}
                agentNames={Object.fromEntries(agents.map(a => [a.id, a.name]))}
              />
            )}
          </div>
        ) : activity ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Activity live={status?.activity} />
          </div>
        ) : scheduled ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Scheduled
              agents={agents}
              groups={groups}
              defaultAgent={settings?.defaultAgent ?? 'shellb'}
              onOpenChat={id => {
                location.hash = `#/c/${id}`;
              }}
            />
          </div>
        ) : library ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {library === 'favorites' ? (
              <FavoritesPage agents={agents} />
            ) : (
              <Library
                agents={agents}
                dark={theme === 'dark'}
                onOpenArtifact={(cid, aid) => {
                  location.hash = `#/c/${cid}/${aid}`;
                  setActiveArtifact({ id: aid });
                  setArtifactSheetOpen(true);
                }}
                initial={library === 'media' ? 'media' : 'all'}
              />
            )}
          </div>
        ) : groupRoute ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {groupRoute.id ? (
              <ProjectPage
                projectId={groupRoute.id}
                agents={agents}
                agent={agent}
                refreshKey={groupRefresh}
                onBack={() => openGroup()}
                onOpenChat={(id, art) => {
                  location.hash = art ? `#/c/${id}/${art}` : `#/c/${id}`;
                }}
                onStartChat={text => {
                  pendingGroup.current = groupRoute.id!;
                  send(text, []);
                }}
                onChanged={loadGroups}
                onDeleted={() => {
                  loadGroups();
                  loadConvs();
                  openGroup();
                }}
              />
            ) : (
              <ProjectsIndex
                projects={groups}
                onOpen={id => openGroup(id)}
                onNew={() => setNewProject(true)}
              />
            )}
          </div>
        ) : code ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Opening Code…</div>}>
              <Code
                projectId={code.projectId}
                agents={agents}
                models={models}
                theme={theme}
                onToggleTheme={toggleTheme}
                voiceOk={voiceOk}
                onOpenAgents={id => {
                  setLabAgent(id);
                  setModal('agents');
                }}
                onExit={() => newChat()}
                onOpenProject={id => {
                  location.hash = id ? `#/code/${id}` : '#/code';
                }}
              />
            </Suspense>
          </div>
        ) : studio ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Opening Studio…</div>}>
              <Studio
                projectId={studio.projectId}
                agents={agents}
                models={models}
                theme={theme}
                onToggleTheme={toggleTheme}
                voiceOk={voiceOk}
                onOpenAgents={id => {
                  setLabAgent(id);
                  setModal('agents');
                }}
                onExit={() => newChat()}
                onOpenProject={id => {
                  location.hash = id ? `#/studio/${id}` : '#/studio';
                }}
              />
            </Suspense>
          </div>
        ) : (
          /* Mobile Chat Canvas */
          <div className="flex-1 flex flex-col min-h-0 relative">
            <div
              ref={scroller}
              className="flex-1 overflow-y-auto px-3 py-4"
              onScroll={e => {
                const el = e.currentTarget;
                setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
              }}
            >
              {messages.length === 0 ? (
                <div className="max-w-md mx-auto min-h-full flex flex-col items-center justify-center text-center py-6 animate-fade-in">
                  <AgentAvatar agent={agent} size={48} className="rounded-2xl shadow-lg mb-3" />
                  <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                    {greeting()}.
                  </h1>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-xs">
                    <span className="font-medium text-[var(--text-primary)]">{agent.name}</span> ·{' '}
                    {agent.description}
                  </p>

                  {/* Suggestion Chips */}
                  <div className="mt-6 grid grid-cols-1 gap-2 w-full text-left">
                    {quick.map(q => (
                      <button
                        key={q.title}
                        onClick={() => send(q.prompt, [])}
                        className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-left transition group"
                      >
                        <div className="text-xs font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-soft)] transition">
                          {q.title}
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 line-clamp-2 leading-relaxed">
                          {q.prompt}
                        </div>
                      </button>
                    ))}
                  </div>

                  <p className="mt-6 text-[10px] text-[var(--text-muted)]">
                    Strictly local. Nothing you type leaves this machine.
                  </p>
                </div>
              ) : (
                <div className="max-w-xl mx-auto space-y-5 pb-4">
                  {messages.map(m => (
                    <MessageView
                      key={m.id}
                      message={m}
                      agent={agents.find(a => a.id === m.agentId) ?? agent}
                      isLast={m === lastAssistant}
                      busy={busy || !!conv?.streaming}
                      activeArtifact={activeArtifact?.id}
                      onOpenArtifact={(id, version) => {
                        setActiveArtifact({ id, version });
                        setArtifactSheetOpen(true);
                      }}
                      onRegenerate={regenerate}
                      onEdit={text => send(text, m.attachments ?? [], m.id, undefined, m.mode)}
                      onPlan={onPlan}
                      artifacts={artifacts}
                      onAsk={text => send(text, [])}
                      verifiers={verifiers}
                      onVerify={vid => {
                        const n = messages.indexOf(m) + 1;
                        const what =
                          m.status === 'error'
                            ? `Reply #${n} failed: check why.`
                            : `Check reply #${n}.`;
                        send(`/verify-chat ${what}`, [], undefined, vid);
                      }}
                      onOpenFile={path =>
                        conv &&
                        window.open(
                          `/api/workspace/${conv.id}/${path.replace(/^\/?work\//, '').split('/').map(encodeURIComponent).join('/')}`,
                          '_blank',
                          'noopener'
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Jump to latest FAB */}
            {!atBottom && messages.length > 0 && (
              <button
                onClick={() => {
                  setAtBottom(true);
                  scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
                }}
                className="absolute bottom-3 right-4 p-2.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] shadow-xl text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition z-20"
                aria-label="Scroll to bottom"
              >
                <ArrowDown className="w-4 h-4" />
              </button>
            )}

            {/* Floating Artifacts indicator */}
            {artifacts.length > 0 && (
              <div className="absolute top-2 right-3 z-20">
                <button
                  onClick={() => {
                    if (!activeArtifact && artifacts.length > 0) {
                      setActiveArtifact({ id: artifacts[artifacts.length - 1].id });
                    }
                    setArtifactSheetOpen(true);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-secondary)]/90 backdrop-blur-md border border-[var(--border-strong)] text-xs text-[var(--accent-soft)] shadow-md hover:bg-[var(--bg-hover)] transition"
                >
                  <Boxes className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>Artifacts</span>
                  <span className="font-mono text-[10px] bg-[var(--bg-tertiary)] px-1 rounded-full text-[var(--text-primary)]">
                    {artifacts.length}
                  </span>
                </button>
              </div>
            )}

            {/* Radio mini-player bar if playing */}
            <MobileRadioBar
              onOpenRadio={() => {
                location.hash = '#/radio';
              }}
            />

            {/* Voice Mode Overlay */}
            {voiceMode && (
              <div className="px-3 pb-1">
                <VoiceMode
                  reply={lastAssistant}
                  busy={busy || !!conv?.streaming}
                  onStop={stop}
                  onClose={() => setVoiceMode(false)}
                  onSend={t => send(t, [], undefined, undefined, undefined, true)}
                />
              </div>
            )}

            {/* Mobile Composer */}
            <MobileComposer
              agent={agent}
              agents={chatAgents}
              model={model}
              effort={effort}
              onEffort={e => setEfforts(prev => ({ ...prev, [agent.id]: e }))}
              onAgentSelect={() => setAgentPickerOpen(true)}
              busy={busy || !!conv?.streaming}
              onSend={(t, a, o) => send(t, a, undefined, o?.agentId, o?.mode)}
              onStop={stop}
              ensureConversation={ensureConversation}
              voiceOk={voiceOk}
              onVoiceMode={voiceMode ? undefined : () => setVoiceMode(true)}
              planMode={planMode}
              onPlanMode={setPlanMode}
              modelChoices={modelChoices}
              onModel={m => setModelPicks(prev => ({ ...prev, [agent.id]: m }))}
              focusKey={`${conv?.id ?? 'new'}:${focusTick}`}
            />
          </div>
        )}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <MobileBottomNav
        activeTab={currentTab}
        onTabChange={handleTabChange}
        status={status}
      />

      {/* Slide-over Drawers & Sheets */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        conversations={convs}
        activeId={conv?.id}
        agents={agents}
        status={status}
        onSelect={openConversation}
        onNew={newChat}
        onDelete={async id => {
          await api.deleteConversation(id);
          if (conv?.id === id) newChat();
          loadConvs();
        }}
        onPin={async (id, pinned) => {
          await api.patchConversation(id, { pinned });
          loadConvs();
        }}
        onRename={async (id, title) => {
          await api.patchConversation(id, { title });
          if (conv?.id === id) setConv(c => (c ? { ...c, title } : c));
          loadConvs();
        }}
        groups={groups}
        activeGroupId={groupRoute?.id ?? (groupRoute ? '' : undefined)}
        onOpenGroup={openGroup}
        onNewGroup={() => setNewProject(true)}
        onOpenSettings={() => {
          setSettingsTab('general');
          setModal('settings');
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <MobileAppsSheet
        open={appsSheetOpen}
        onClose={() => setAppsSheetOpen(false)}
        status={status}
        onOpenApp={openApp}
      />

      <MobileAgentPicker
        open={agentPickerOpen}
        onClose={() => setAgentPickerOpen(false)}
        agents={chatAgents}
        activeId={agent.id}
        onSelect={selectAgent}
      />

      {artifactSheetOpen && activeArtifact && (
        <MobileArtifactSheet
          groups={artifacts}
          activeId={activeArtifact.id}
          version={activeArtifact.version}
          dark={theme === 'dark'}
          convId={conv?.id}
          onSelect={(id, v) => setActiveArtifact({ id, version: v })}
          onClose={() => setArtifactSheetOpen(false)}
        />
      )}

      <FormFactorSwitcher
        open={formFactorOpen}
        onClose={() => setFormFactorOpen(false)}
      />

      {/* Modals & Dialogs */}
      <CommandPalette
        open={modal === 'palette'}
        onClose={() => setModal(null)}
        agents={chatAgents}
        conversations={convs}
        theme={theme}
        actions={{
          newChat,
          openConversation,
          toggleTheme,
          toggleSkin: () => applyTheme(nextTheme()),
          openApp,
          openSettings: tab => {
            setSettingsTab(tab ?? 'general');
            setModal('settings');
          },
        }}
      />

      <AgentLab
        open={modal === 'agents'}
        onClose={() => setModal(null)}
        agents={agents}
        tools={tools}
        models={models}
        initialId={labAgent}
        onChanged={id => {
          loadAgents();
          if (id) setLabAgent(id);
        }}
      />

      <IntegrationsModal
        open={modal === 'tools'}
        onClose={() => setModal(null)}
        tools={tools}
        settings={settings}
        onChanged={loadIntegrations}
      />

      <NewProjectDialog
        open={newProject}
        onClose={() => setNewProject(false)}
        onCreated={g => {
          setNewProject(false);
          loadGroups();
          openGroup(g.id);
        }}
      />

      <SettingsModal
        open={modal === 'settings'}
        onClose={() => setModal(null)}
        settings={settings}
        agents={chatAgents}
        models={models}
        status={status}
        theme={theme}
        onTheme={t => t !== theme && toggleTheme()}
        onSaved={loadSettings}
        tab={settingsTab}
      />
    </div>
  );
}
