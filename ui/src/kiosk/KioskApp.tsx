import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, Boxes, Workflow, Sparkles } from 'lucide-react';
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
import { useChat } from '../useChat';
import { appById, appForHash, type AppId } from '../components/apps';
import { MessageView } from '../components/MessageView';
import { Composer } from '../components/Composer';
import { findMention } from '../components/ComposerShortcuts';
import { CommandPalette, SettingsModal, SettingsContent } from '../components/Panels';
import { IntegrationsModal } from '../components/Integrations';
import { NewProjectDialog, ProjectPage, ProjectsIndex } from '../components/Projects';
import { AgentAvatar } from '../components/common';
import { ArtifactViewer, Library } from '../components/Library';
import { FavoritesPage } from '../components/Favorites';
import { Scheduled, browserTz } from '../components/Scheduled';
import { Activity } from '../components/Activity';
import { Codex } from '../components/Codex';
import { Notes } from '../components/Notes';
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
import { FormFactorSwitcher } from '../mobile/FormFactorSwitcher';
import { nextTheme, setTheme as applyTheme, themeInfo, type ThemeId } from '../themes';

import type { KioskWindow } from './types';
import { WindowFrame } from './WindowFrame';
import { KioskTopBar } from './KioskTopBar';
import { KioskDock } from './KioskDock';
import { DesktopIcons } from './DesktopIcons';
import { DesktopWidgets } from './DesktopWidgets';
import { StartMenu } from './StartMenu';
import { KioskLockScreen } from './KioskLockScreen';
import {
  WALLPAPERS,
  getStoredWallpaperId,
  getStoredCustomUrl,
  getStoredWallpaperDim,
} from './wallpapers';
import { WallpaperModal } from './WallpaperModal';
import { loadAmbience } from '../ambience';

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

export function KioskApp() {
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
  const [groups, setGroups] = useState<ChatProject[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [groupRefresh, setGroupRefresh] = useState(0);
  const [focusTick, setFocusTick] = useState(0);
  const pendingGroup = useRef<string | null>(null);

  // Kiosk UI states
  const [startMenuOpen, setStartMenuOpen] = useState(() => /[?&]menu=1/.test(location.search));
  const [formFactorOpen, setFormFactorOpen] = useState(() => /[?&]switch=1/.test(location.search));
  const [kioskLocked, setKioskLocked] = useState(() => /[?&]lock=1/.test(location.search));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modal, setModal] = useState<null | 'agents' | 'tools' | 'settings' | 'palette'>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>(() => {
    if (typeof window !== 'undefined') {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t && ['general', 'speech', 'network', 'memory', 'shortcuts', 'system', 'backups', 'account'].includes(t)) {
        return t as SettingsTabId;
      }
    }
    return 'general';
  });
  const [labAgent, setLabAgent] = useState<string>();

  // Wallpaper states
  const [wallpaperModalOpen, setWallpaperModalOpen] = useState(() =>
    typeof window !== 'undefined' && /[?&]wallpaper=1/.test(window.location.search)
  );
  const [wallpaperId, setWallpaperId] = useState(getStoredWallpaperId);
  const [wallpaperCustomUrl, setWallpaperCustomUrl] = useState(getStoredCustomUrl);
  const [wallpaperDim, setWallpaperDim] = useState(getStoredWallpaperDim);

  useEffect(() => {
    const onWallpaper = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d) {
        if (d.id) setWallpaperId(d.id);
        if (d.customUrl !== undefined) setWallpaperCustomUrl(d.customUrl);
        if (d.dimPercent !== undefined) setWallpaperDim(d.dimPercent);
      }
    };
    window.addEventListener('shellb-kiosk-wallpaper', onWallpaper);
    return () => window.removeEventListener('shellb-kiosk-wallpaper', onWallpaper);
  }, []);

  const activeWallpaper = useMemo(() => {
    const def = WALLPAPERS.find(w => w.id === wallpaperId) ?? WALLPAPERS[0];
    return def.cssBackground(wallpaperCustomUrl);
  }, [wallpaperId, wallpaperCustomUrl]);

  // Kiosk screensaver idle detection: auto-lock after saverMinutes
  const lastUserActivity = useRef(Date.now());
  useEffect(() => {
    const bump = () => { lastUserActivity.current = Date.now(); };
    const events = ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach(ev => window.addEventListener(ev, bump, { capture: true, passive: true }));
    const t = setInterval(() => {
      if (kioskLocked) return;
      const saverMins = loadAmbience().saverMinutes;
      if (!saverMins) return; // 0 = disabled
      if (Date.now() - lastUserActivity.current >= saverMins * 60_000) {
        setKioskLocked(true);
      }
    }, 5000);
    return () => {
      events.forEach(ev => window.removeEventListener(ev, bump, { capture: true }));
      clearInterval(t);
    };
  }, [kioskLocked]);

  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const zCounter = useRef(10);

  // OS Windows state
  const [windows, setWindows] = useState<KioskWindow[]>(() => {
    const list: KioskWindow[] = [
      {
        id: 'chat-main',
        appId: 'chat',
        title: 'Shell:B Assistant',
        x: 32,
        y: 20,
        width: Math.min(760, typeof window !== 'undefined' ? window.innerWidth - 64 : 760),
        height: Math.min(680, typeof window !== 'undefined' ? window.innerHeight - 100 : 680),
        minWidth: 420,
        minHeight: 380,
        isMinimized: false,
        isMaximized: false,
        zIndex: 10,
      },
    ];
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search).get('open') as AppId | null;
      if (p && p !== 'chat') {
        const def = appById(p);
        if (def) {
          list.push({
            id: `${p}-init`,
            appId: p,
            title: def.label,
            x: 420,
            y: 40,
            width: 780,
            height: 640,
            minWidth: 400,
            minHeight: 320,
            isMinimized: false,
            isMaximized: false,
            zIndex: 11,
          });
        }
      }
    }
    return list;
  });
  const [activeWindowId, setActiveWindowId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search).get('open');
      if (p && p !== 'chat') return `${p}-init`;
    }
    return 'chat-main';
  });

  const loadConvs = useCallback(() => api.conversations().then(setConvs), []);
  const loadGroups = useCallback(() => api.chatProjects().then(setGroups).catch(() => {}), []);

  const { conv, setConv, convRef, busy, send: sendTurn, stop } = useChat({
    onEvent: (ev, id) => {
      if (ev.type === 'artifact' && convRef.current?.id === id) {
        // Open a dedicated artifact window beside the chat!
        openArtifactWindow(id, ev.artifact.id, ev.artifact.version);
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

  // Track fullscreen state
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const focusWindow = useCallback((id: string) => {
    zCounter.current += 1;
    setActiveWindowId(id);
    setWindows(prev =>
      prev.map(w => (w.id === id ? { ...w, zIndex: zCounter.current, isMinimized: false } : w))
    );
  }, []);

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => prev.filter(w => w.id !== id));
    setActiveWindowId(prev => (prev === id ? null : prev));
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows(prev => prev.map(w => (w.id === id ? { ...w, isMinimized: true } : w)));
    setActiveWindowId(prev => (prev === id ? null : prev));
  }, []);

  const toggleMaximize = useCallback((id: string) => {
    setWindows(prev =>
      prev.map(w => (w.id === id ? { ...w, isMaximized: !w.isMaximized } : w))
    );
  }, []);

  const moveWindow = useCallback((id: string, x: number, y: number) => {
    setWindows(prev => prev.map(w => (w.id === id ? { ...w, x, y } : w)));
  }, []);

  const resizeWindow = useCallback((id: string, width: number, height: number) => {
    setWindows(prev => prev.map(w => (w.id === id ? { ...w, width, height } : w)));
  }, []);

  const openApp = useCallback(
    (appId: AppId, params?: Record<string, any>) => {
      const def = appById(appId);
      if (appId === 'settings' && params?.tab) {
        setSettingsTab(params.tab);
      }
      const existing = windows.find(w => w.appId === appId && !w.params?.artifactId);
      if (existing) {
        focusWindow(existing.id);
        return;
      }

      zCounter.current += 1;
      const count = windows.length;
      const baseW = appId === 'maps' || appId === 'studio' || appId === 'code' || appId === 'settings' ? 880 : 780;
      const baseH = appId === 'maps' || appId === 'studio' || appId === 'code' || appId === 'settings' ? 660 : 620;
      const maxScreenW = typeof window !== 'undefined' ? window.innerWidth - 80 : baseW;
      const maxScreenH = typeof window !== 'undefined' ? window.innerHeight - 120 : baseH;

      const newWin: KioskWindow = {
        id: `${appId}-${Date.now()}`,
        appId,
        title: def?.label ?? appId,
        x: Math.min(80 + count * 32, Math.max(20, maxScreenW - 300)),
        y: Math.min(40 + count * 28, Math.max(20, maxScreenH - 200)),
        width: Math.min(baseW, maxScreenW),
        height: Math.min(baseH, maxScreenH),
        minWidth: 400,
        minHeight: 320,
        isMinimized: false,
        isMaximized: false,
        zIndex: zCounter.current,
        params,
      };

      setWindows(prev => [...prev, newWin]);
      setActiveWindowId(newWin.id);
    },
    [windows, focusWindow]
  );

  const openArtifactWindow = useCallback(
    (convId: string, artifactId: string, version?: number) => {
      const existing = windows.find(w => w.params?.artifactId === artifactId);
      if (existing) {
        focusWindow(existing.id);
        return;
      }

      zCounter.current += 1;
      const newWin: KioskWindow = {
        id: `artifact-${artifactId}-${Date.now()}`,
        appId: 'library',
        title: `Artifact: ${artifactId.slice(0, 12)}`,
        x: 420,
        y: 60,
        width: 720,
        height: 600,
        minWidth: 420,
        minHeight: 340,
        isMinimized: false,
        isMaximized: false,
        zIndex: zCounter.current,
        params: { convId, artifactId, version },
      };

      setWindows(prev => [...prev, newWin]);
      setActiveWindowId(newWin.id);
    },
    [windows, focusWindow]
  );

  const tileWindows = useCallback(() => {
    const visible = windows.filter(w => !w.isMinimized);
    if (!visible.length || typeof window === 'undefined') return;

    const screenW = window.innerWidth;
    const screenH = window.innerHeight - 90; // space between topbar and dock

    if (visible.length === 1) {
      setWindows(prev =>
        prev.map(w => (w.id === visible[0].id ? { ...w, x: 20, y: 10, width: screenW - 40, height: screenH } : w))
      );
    } else if (visible.length === 2) {
      const halfW = Math.floor((screenW - 30) / 2);
      setWindows(prev =>
        prev.map(w => {
          if (w.id === visible[0].id) return { ...w, x: 10, y: 10, width: halfW, height: screenH, isMaximized: false };
          if (w.id === visible[1].id) return { ...w, x: 20 + halfW, y: 10, width: halfW, height: screenH, isMaximized: false };
          return w;
        })
      );
    } else {
      // 3 or 4 windows: split in half or grid
      const halfW = Math.floor((screenW - 30) / 2);
      const halfH = Math.floor((screenH - 20) / 2);
      setWindows(prev =>
        prev.map(w => {
          const idx = visible.findIndex(v => v.id === w.id);
          if (idx === 0) return { ...w, x: 10, y: 10, width: halfW, height: halfH, isMaximized: false };
          if (idx === 1) return { ...w, x: 20 + halfW, y: 10, width: halfW, height: halfH, isMaximized: false };
          if (idx === 2) return { ...w, x: 10, y: 20 + halfH, width: halfW, height: halfH, isMaximized: false };
          if (idx === 3) return { ...w, x: 20 + halfW, y: 20 + halfH, width: halfW, height: halfH, isMaximized: false };
          return w;
        })
      );
    }
  }, [windows]);

  const cascadeWindows = useCallback(() => {
    const visible = windows.filter(w => !w.isMinimized);
    setWindows(prev =>
      prev.map(w => {
        const idx = visible.findIndex(v => v.id === w.id);
        if (idx >= 0) {
          return {
            ...w,
            x: 40 + idx * 36,
            y: 20 + idx * 32,
            width: Math.min(760, window.innerWidth - 100),
            height: Math.min(620, window.innerHeight - 140),
            isMaximized: false,
          };
        }
        return w;
      })
    );
  }, [windows]);

  const minimizeAll = useCallback(() => {
    setWindows(prev => prev.map(w => ({ ...w, isMinimized: true })));
    setActiveWindowId(null);
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      try {
        const c = await api.conversation(id);
        setConv(c);
        setAgentId(c.agentId);
        // Ensure chat window is open and focused
        const chatWin = windows.find(w => w.appId === 'chat');
        if (chatWin) focusWindow(chatWin.id);
        else openApp('chat');
        requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
      } catch {
        setConv(null);
      }
    },
    [windows, focusWindow, openApp, setConv]
  );

  const newChat = useCallback(
    (aid?: string) => {
      setConv(null);
      setAgentId(aid ?? settings?.defaultAgent ?? 'shellb');
      setFocusTick(t => t + 1);
      const chatWin = windows.find(w => w.appId === 'chat');
      if (chatWin) focusWindow(chatWin.id);
      else openApp('chat');
    },
    [settings, windows, focusWindow, openApp, setConv]
  );

  const ensureConversation = useCallback(async () => {
    if (convRef.current) return convRef.current.id;
    const c = await api.createConversation(agentId, pendingGroup.current ?? undefined);
    pendingGroup.current = null;
    const full: Conversation = { ...c, messages: [], artifacts: [] };
    convRef.current = full;
    setConv(full);
    setConvs(prev => [c, ...prev]);
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

  // Autoscroll
  useEffect(() => {
    if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conv?.messages, atBottom]);

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)] bg-[var(--bg-primary)]">
        {loadError ? `Can't reach the Shell:B server: ${loadError}` : 'Booting Shell:B Kiosk OS…'}
      </div>
    );
  }

  const messages = conv?.messages ?? [];
  const artifacts = conv?.artifacts ?? [];
  const voiceOk = !!status?.services.hermes?.ok;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

  const activeWin = windows.find(w => w.id === activeWindowId);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)] select-none relative font-sans">
      {/* OS Top Bar */}
      <KioskTopBar
        activeTitle={activeWin?.title}
        onOpenStartMenu={() => setStartMenuOpen(s => !s)}
        onOpenFormFactor={() => setFormFactorOpen(true)}
        onOpenPalette={() => setModal('palette')}
        onOpenWallpaper={() => setWallpaperModalOpen(true)}
        onOpenSettings={() => openApp('settings')}
        onToggleFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
        onLockKiosk={() => setKioskLocked(true)}
        onTileWindows={tileWindows}
        onCascadeWindows={cascadeWindows}
        onMinimizeAll={minimizeAll}
        theme={theme}
        onToggleTheme={toggleTheme}
        status={status}
      />

      {/* Desktop Workspace Canvas */}
      <div
        className="flex-1 min-h-0 relative overflow-hidden bg-cover bg-center transition-all duration-300"
        style={{ background: activeWallpaper }}
        onContextMenu={e => {
          if ((e.target as HTMLElement).closest('.sb-window-frame')) return;
          e.preventDefault();
          setWallpaperModalOpen(true);
        }}
      >
        {/* Dimmer overlay for text/icon legibility */}
        {wallpaperDim > 0 && (
          <div
            className="absolute inset-0 pointer-events-none transition-opacity duration-300"
            style={{ backgroundColor: `rgba(0, 0, 0, ${wallpaperDim / 100})` }}
          />
        )}

        {/* Desktop Ambient Icons Grid */}
        <DesktopIcons onOpenApp={openApp} status={status} />

        {/* Desktop Ambient Widgets */}
        <DesktopWidgets status={status} onOpenApp={openApp} />

        {/* Windows Stage */}
        <div className="absolute inset-0 pointer-events-none">
          {windows.map(win => {
            const isActive = win.id === activeWindowId;

            return (
              <div key={win.id} className="pointer-events-auto">
                <WindowFrame
                  win={win}
                  isActive={isActive}
                  onFocus={focusWindow}
                  onClose={closeWindow}
                  onMinimize={minimizeWindow}
                  onToggleMaximize={toggleMaximize}
                  onMove={moveWindow}
                  onResize={resizeWindow}
                >
                  {/* Dedicated Artifact Window */}
                  {win.params?.artifactId ? (
                    <ArtifactViewer
                      convId={win.params.convId!}
                      artifactId={win.params.artifactId}
                      dark={theme === 'dark'}
                    />
                  ) : win.appId === 'chat' ? (
                    /* Chat Window Content */
                    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-primary)]">
                      <div
                        ref={scroller}
                        className="flex-1 overflow-y-auto px-4 py-4"
                        onScroll={e => {
                          const el = e.currentTarget;
                          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
                        }}
                      >
                        {messages.length === 0 ? (
                          <div className="max-w-xl mx-auto min-h-full flex flex-col items-center justify-center text-center py-6 animate-fade-in">
                            <AgentAvatar agent={agent} size={52} className="rounded-2xl shadow-xl mb-3" />
                            <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                              {greeting()}.
                            </h2>
                            <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-sm">
                              <span className="font-semibold text-[var(--text-primary)]">{agent.name}</span> ·{' '}
                              {agent.description}
                            </p>

                            <div className="mt-6 grid grid-cols-2 gap-2.5 w-full text-left">
                              {(QUICK[agent.id] ?? QUICK.shellb).map(q => (
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

                            <p className="mt-6 text-[10px] text-[var(--text-muted)] font-mono">
                              Overthink. Overcomplicate. Overengineer. Strictly local.
                            </p>
                          </div>
                        ) : (
                          <div className="max-w-2xl mx-auto space-y-6 pb-4">
                            {messages.map(m => (
                              <MessageView
                                key={m.id}
                                message={m}
                                agent={agents.find(a => a.id === m.agentId) ?? agent}
                                isLast={m === lastAssistant}
                                busy={busy || !!conv?.streaming}
                                onOpenArtifact={(id, version) => {
                                  openArtifactWindow(conv!.id, id, version);
                                }}
                                onRegenerate={regenerate}
                                onEdit={text => send(text, m.attachments ?? [], m.id, undefined, m.mode)}
                                onPlan={onPlan}
                                artifacts={artifacts}
                                onAsk={text => send(text, [])}
                                verifiers={verifiers}
                                onVerify={vid => {
                                  const n = messages.indexOf(m) + 1;
                                  send(`/verify-chat Check reply #${n}.`, [], undefined, vid);
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

                      {/* Jump to bottom button */}
                      {!atBottom && messages.length > 0 && (
                        <button
                          onClick={() => {
                            setAtBottom(true);
                            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
                          }}
                          className="absolute bottom-24 right-6 p-2 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] shadow-xl text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition z-20"
                          aria-label="Scroll to bottom"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                      )}

                      {/* Voice Mode */}
                      {voiceMode && (
                        <div className="px-3 pb-2">
                          <VoiceMode
                            reply={lastAssistant}
                            busy={busy || !!conv?.streaming}
                            onStop={stop}
                            onClose={() => setVoiceMode(false)}
                            onSend={t => send(t, [], undefined, undefined, undefined, true)}
                          />
                        </div>
                      )}

                      {/* Composer */}
                      <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        <Composer
                          agent={agent}
                          agents={chatAgents}
                          model={model}
                          effort={effort}
                          onEffort={e => setEfforts(prev => ({ ...prev, [agent.id]: e }))}
                          modelChoices={modelChoices}
                          onModel={m => setModelPicks(prev => ({ ...prev, [agent.id]: m }))}
                          onAgent={selectAgent}
                          busy={busy || !!conv?.streaming}
                          onSend={(t, a, o) => send(t, a, undefined, o?.agentId, o?.mode)}
                          onStop={stop}
                          convId={conv?.id}
                          onCommand={() => newChat()}
                          planMode={planMode}
                          onPlanMode={setPlanMode}
                          ensureConversation={ensureConversation}
                          voiceOk={voiceOk}
                          focusKey={`${conv?.id ?? 'new'}:${focusTick}`}
                          onVoiceMode={voiceMode ? undefined : () => setVoiceMode(true)}
                        />
                      </div>
                    </div>
                  ) : win.appId === 'radio' ? (
                    <div className="h-full overflow-y-auto">
                      <RadioApp />
                    </div>
                  ) : win.appId === 'maps' ? (
                    <div className="h-full overflow-hidden">
                      <MapsApp />
                    </div>
                  ) : win.appId === 'notes' ? (
                    <div className="h-full overflow-y-auto">
                      <Notes
                        sub=""
                        onDiscuss={async (text, note) => {
                          const id = await ensureConversation();
                          const att = await api.upload(id, note);
                          send(text, [att]);
                          openApp('chat');
                        }}
                      />
                    </div>
                  ) : win.appId === 'codex' ? (
                    <div className="h-full overflow-y-auto">
                      <Codex
                        sub=""
                        agentNames={Object.fromEntries(agents.map(a => [a.id, a.name]))}
                      />
                    </div>
                  ) : win.appId === 'library' ? (
                    <div className="h-full overflow-y-auto">
                      <Library
                        agents={agents}
                        dark={theme === 'dark'}
                        onOpenArtifact={(cid, aid) => openArtifactWindow(cid, aid)}
                        initial="all"
                      />
                    </div>
                  ) : win.appId === 'activity' ? (
                    <div className="h-full overflow-y-auto">
                      <Activity live={status?.activity} />
                    </div>
                  ) : win.appId === 'plans' ? (
                    <div className="h-full overflow-y-auto">
                      <MegaPlansIndex agents={agents} live={status?.megaPlan} onOpen={() => {}} />
                    </div>
                  ) : win.appId === 'research' ? (
                    <div className="h-full overflow-y-auto">
                      <ResearchIndex
                        agents={agents}
                        activeConvs={status?.active ?? []}
                        onOpen={() => {}}
                        onStart={async (q, aid) => {
                          const b = await api.createResearchBoard({ title: q.slice(0, 50), question: q });
                          await api.linkResearchChat(b.id, { agentId: aid });
                          openApp('chat');
                        }}
                      />
                    </div>
                  ) : win.appId === 'assets' ? (
                    <div className="h-full overflow-y-auto">
                      <AssetsIndex
                        agents={agents}
                        live={status?.assetJob}
                        onOpen={() => {}}
                        onOpenChat={() => openApp('chat')}
                      />
                    </div>
                  ) : win.appId === 'secretary' ? (
                    <div className="h-full overflow-y-auto">
                      <Secretary onBack={() => closeWindow(win.id)} />
                    </div>
                  ) : win.appId === 'gibberlink' ? (
                    <div className="h-full overflow-y-auto">
                      <Gibberlink />
                    </div>
                  ) : win.appId === 'models' ? (
                    <div className="h-full overflow-y-auto">
                      <Models busyTurns={status?.active.length ?? 0} />
                    </div>
                  ) : win.appId === 'generate' ? (
                    <div className="h-full min-h-0">
                      <Generate />
                    </div>
                  ) : win.appId === 'data' ? (
                    <div className="h-full overflow-y-auto">
                      <OfflineData />
                    </div>
                  ) : win.appId === 'scheduled' ? (
                    <div className="h-full overflow-y-auto">
                      <Scheduled
                        agents={agents}
                        groups={groups}
                        defaultAgent={settings?.defaultAgent ?? 'shellb'}
                        onOpenChat={id => openConversation(id)}
                      />
                    </div>
                  ) : win.appId === 'studio' ? (
                    <div className="h-full overflow-hidden">
                      <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Loading Studio…</div>}>
                        <Studio
                          agents={agents}
                          models={models}
                          theme={theme}
                          onToggleTheme={toggleTheme}
                          voiceOk={voiceOk}
                          onOpenAgents={id => {
                            setLabAgent(id);
                            setModal('agents');
                          }}
                          onExit={() => closeWindow(win.id)}
                          onOpenProject={() => {}}
                        />
                      </Suspense>
                    </div>
                  ) : win.appId === 'code' ? (
                    <div className="h-full overflow-hidden">
                      <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">Loading Code…</div>}>
                        <Code
                          agents={agents}
                          models={models}
                          theme={theme}
                          onToggleTheme={toggleTheme}
                          voiceOk={voiceOk}
                          onOpenAgents={id => {
                            setLabAgent(id);
                            setModal('agents');
                          }}
                          onExit={() => closeWindow(win.id)}
                          onOpenProject={() => {}}
                        />
                      </Suspense>
                    </div>
                  ) : win.appId === 'settings' ? (
                    <div className="h-full overflow-hidden bg-[var(--bg-primary)]">
                      <SettingsContent
                        settings={settings}
                        agents={chatAgents}
                        models={models}
                        status={status}
                        theme={theme}
                        onTheme={t => t !== theme && toggleTheme()}
                        onSaved={loadSettings}
                        tab={settingsTab}
                        onClose={() => closeWindow(win.id)}
                      />
                    </div>
                  ) : null}
                </WindowFrame>
              </div>
            );
          })}
        </div>
      </div>

      {/* OS Taskbar / Dock */}
      <KioskDock
        windows={windows}
        activeWindowId={activeWindowId}
        onSelectWindow={focusWindow}
        onOpenApp={openApp}
        onShowDesktop={minimizeAll}
      />

      {/* Start Menu */}
      <StartMenu
        open={startMenuOpen}
        onClose={() => setStartMenuOpen(false)}
        onOpenApp={appId => {
          openApp(appId);
          setStartMenuOpen(false);
        }}
        onOpenFormFactor={() => {
          setStartMenuOpen(false);
          setFormFactorOpen(true);
        }}
        onOpenSettings={() => {
          setStartMenuOpen(false);
          openApp('settings');
        }}
        onOpenWallpaper={() => {
          setStartMenuOpen(false);
          setWallpaperModalOpen(true);
        }}
        onToggleFullscreen={toggleFullscreen}
        onLockKiosk={() => {
          setStartMenuOpen(false);
          setKioskLocked(true);
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
        status={status}
      />

      {/* Kiosk Lock / Standby Screen */}
      <KioskLockScreen
        open={kioskLocked}
        onUnlock={() => setKioskLocked(false)}
        status={status}
      />

      {/* Wallpaper Picker Modal */}
      <WallpaperModal
        open={wallpaperModalOpen}
        onClose={() => setWallpaperModalOpen(false)}
      />

      {/* Form Factor Switcher Modal */}
      <FormFactorSwitcher
        open={formFactorOpen}
        onClose={() => setFormFactorOpen(false)}
      />

      {/* Shared Modals */}
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
          openApp('chat');
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
