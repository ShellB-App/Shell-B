import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Archive, AudioLines, BookMarked, Boxes, Brain, Inbox, Sparkles, Cpu, Monitor, Moon, Plus, Search, Settings as SettingsIcon, SlidersHorizontal, SquarePen, Star, Sun, Trash2, BrainCircuit, MessageSquare, KeyRound, Hash, Network, ShieldCheck,
} from 'lucide-react';
import type { Agent, ChatHit, ConversationSummary, Memory, ModelInfo, Settings, SettingsTabId, Status, ToolInfo } from '../types';
import { api, fmtBytes } from '../api';
import { AgentAvatar, Modal, Toggle, btn, relTime, toolIcon, Snippet } from './common';
import { jumpToMessage } from '../jump';
import { FAV_LABEL, useFavorites } from '../favorites';
import { FavIcon } from './Favorites';
import { APPS, shortcutLabel, useRailOrder, type AppId } from './apps';
import { AccountTab } from './Account';
import { ApiKeysSettings } from './ApiKeysSettings';
import { BackupsTab } from './BackupsTab';
import { MemoryManager } from './MemoryManager';
import { SpeechTab } from './SpeechSettings';
import { SCALES, setScale, useScale } from '../uiScale';
import { ShortcutsTab } from './ShortcutsSettings';
import { SystemInfoPanel } from './SystemInfo';
import { NetworkSettings } from './NetworkSettings';
import { ThemePicker } from './ThemePicker';
import { THEMES, currentTheme, setTheme } from '../themes';
import { PREVIEW_SAVER, PREVIEW_SPLASH, SAVER_MINUTES, SAVER_STYLES, saveAmbience, useAmbience, type SaverStyle, type SplashMode } from '../ambience';

const SERVICE_INFO: Record<string, [string, string]> = {
  ollama: ['Ollama', 'Language models · :11434'],
  searxng: ['VASSAGO', 'SearXNG web search · :8080'],
  sandbox: ['Sandbox', 'Docker image shellb-sandbox'],
  nyx: ['NYX', 'ComfyUI + FLUX images · :8188'],
  orpheus: ['ORPHEUS', 'MusicGen · :8002'],
  hermes: ['HERMES', 'Whisper + Kokoro voice · :8001'],
  embeddings: ['MIMIR-lite', 'Embedding model for memory'],
};

// ── Tools ──────────────────────────────────────────────────────────────────

export function ToolsModal({ open, onClose, tools, onChanged }: { open: boolean; onClose: () => void; tools: ToolInfo[]; onChanged: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Tools" icon={<Boxes className="w-4 h-4 text-sky-400" />}>
      <div className="overflow-y-auto p-4 space-y-2">
        <p className="text-xs text-[var(--text-muted)] mb-3">Switch a tool off here to disable it for every agent. Pick which agents get which tools in the Agent Lab.</p>
        {tools.map(t => {
          const Icon = toolIcon(t.id);
          return (
            <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <span className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-sky-400" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t.displayName}</span>
                  <span className="text-[10px] font-mono text-[var(--text-muted)]">{t.id}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)]">{t.description}</div>
                {!t.available && <div className="text-[11px] text-amber-400 mt-0.5">Backing service is offline: {SERVICE_INFO[t.service ?? '']?.[0] ?? t.service}</div>}
              </div>
              <Toggle on={t.enabled} label={t.displayName} onChange={async v => { await api.setTool(t.id, v); onChanged(); }} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

interface SettingsProps {
  open?: boolean;
  onClose?: () => void;
  settings?: Settings;
  agents: Agent[];
  models: ModelInfo[];
  status?: Status;
  theme: 'dark' | 'light';
  onTheme: (t: 'dark' | 'light') => void;
  onSaved: () => void;
  tab?: SettingsTabId;
  onOpenTab?: (tab: SettingsTabId) => void;
}

export function SettingsContent(p: SettingsProps) {
  const [tab, setTab] = useState<SettingsTabId>(p.tab ?? 'general');
  useEffect(() => { if (p.tab) setTab(p.tab); }, [p.tab]);
  const tabs = [
    { id: 'general', label: 'General', icon: SlidersHorizontal },
    { id: 'apikeys', label: 'API Keys', icon: KeyRound },
    { id: 'speech', label: 'Speech', icon: AudioLines },
    { id: 'network', label: 'Network', icon: Network },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'shortcuts', label: 'Shortcuts', icon: Hash },
    { id: 'system', label: 'System', icon: Cpu },
    { id: 'backups', label: 'Backups', icon: Archive },
    { id: 'account', label: 'Account', icon: ShieldCheck },
  ] as const;

  return (
    <div className="flex-1 min-h-0 flex flex-col sm:flex-row h-full">
      <div className="sm:w-44 shrink-0 p-2 flex sm:flex-col gap-1 border-b sm:border-b-0 sm:border-r border-[var(--border-subtle)] overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition whitespace-nowrap', tab === t.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
            <t.icon className="w-4 h-4 shrink-0" />{t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
        {tab === 'general' && <General {...p} onOpenTab={setTab} />}
        {tab === 'apikeys' && <ApiKeysSettings settings={p.settings} onSaved={p.onSaved} />}
        {tab === 'speech' && <SpeechTab settings={p.settings} onSaved={p.onSaved} />}
        {tab === 'network' && <NetworkSettings />}
        {tab === 'memory' && <MemoryManager />}
        {tab === 'shortcuts' && <ShortcutsTab />}
        {tab === 'system' && <SystemTab status={p.status} models={p.models} onOpenTab={setTab} />}
        {tab === 'backups' && <BackupsTab />}
        {tab === 'account' && <AccountTab />}
      </div>
    </div>
  );
}

export function SettingsModal(p: SettingsProps) {
  return (
    <Modal open={p.open ?? false} onClose={p.onClose ?? (() => {})} title="Settings" icon={<SettingsIcon className="w-4 h-4" />} wide>
      <SettingsContent {...p} />
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 py-3 border-b border-[var(--border-subtle)] last:border-0">
      <div className="sm:w-56 shrink-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function General({ settings, agents, models, theme, onTheme, onSaved, onOpenTab }: SettingsProps) {
  if (!settings) return null;
  const save = async (patch: Partial<Settings>) => { await api.saveSettings(patch); onSaved(); };
  const vision = models.filter(m => m.capabilities.includes('vision'));
  const embedders = models.filter(m => m.capabilities.includes('embedding') || /embed/i.test(m.name));
  return (
    <div>
      <ThemePicker settings={settings} mode={theme} onMode={onTheme} />
      <ScaleRow />
      <DisplayRows />
      <Row label="Default agent" hint="Used for new chats">
        <select className={btn.input} value={settings.defaultAgent} onChange={e => save({ defaultAgent: e.target.value })}>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
        </select>
      </Row>
      <Row label="Vision fallback" hint="Handles images when the agent's model can't see">
        <select className={btn.input} value={settings.visionFallbackModel} onChange={e => save({ visionFallbackModel: e.target.value })}>
          {vision.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label="Utility model" hint="Writes conversation titles">
        <select className={btn.input} value={settings.utilityModel} onChange={e => save({ utilityModel: e.target.value })}>
          {models.filter(m => m.capabilities.includes('completion')).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label="Memory embeddings" hint="Changing this makes existing memories unsearchable">
        <select className={btn.input} value={settings.embeddingModel} onChange={e => save({ embeddingModel: e.target.value })}>
          {(embedders.length ? embedders : models).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label="Remember on request" hint="Agents can save, correct and forget memories when you ask. Background learning is set in the Memory tab">
        <Toggle on={settings.autoMemory} onChange={v => save({ autoMemory: v })} label="Auto-remember" />
      </Row>
      <Row label="Suggest replies" hint="After each reply, the utility model guesses your next message; Tab accepts it">
        <Toggle on={settings.promptSuggestions ?? true} onChange={v => save({ promptSuggestions: v })} label="Suggest replies" />
      </Row>
      <Row label="API Keys" hint="Credentials for external services and cloud AI providers">
        <button className={btn.subtle} onClick={() => onOpenTab?.('apikeys')}><KeyRound className="w-3.5 h-3.5 text-rose-400" />API keys & external services</button>
      </Row>
      <Row label="Voice" hint="Reading voice, speed, and the voice library">
        <button className={btn.subtle} onClick={() => onOpenTab?.('speech')}><AudioLines className="w-3.5 h-3.5" />Speech settings</button>
      </Row>
      <Row label="Network" hint="Wi-Fi, Ethernet, and active VPN tunnels">
        <button className={btn.subtle} onClick={() => onOpenTab?.('network')}><Network className="w-3.5 h-3.5" />Network settings</button>
      </Row>
      <Row label="Max tool rounds" hint="Safety cap on tool calls per reply">
        <input type="number" min={1} max={50} className={clsx(btn.input, 'w-24')} value={settings.maxToolRounds}
          onChange={e => save({ maxToolRounds: Math.max(1, Math.min(50, Number(e.target.value) || 16)) })} />
      </Row>
      <Row label="Loop guard" hint="Evaluates progress every X turns: auto-extends budget, prevents runaway loops">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={settings.runawayLoopChecker ?? true}
              onChange={e => save({ runawayLoopChecker: e.target.checked })} />
            Active
          </label>
          <span className="text-xs text-[var(--text-muted)]">Check every</span>
          <input type="number" min={3} max={30} className={clsx(btn.input, 'w-16 text-center')}
            value={settings.loopCheckInterval ?? 10}
            onChange={e => save({ loopCheckInterval: Math.max(3, Math.min(30, Number(e.target.value) || 10)) })} />
          <span className="text-xs text-[var(--text-muted)]">turns</span>
        </div>
      </Row>
    </div>
  );
}

// Interface zoom. Saved per browser (localStorage), like the theme.
function ScaleRow() {
  const scale = useScale();
  const pct = (s: number) => `${Math.round(s * 100)}%`;
  return (
    <Row label="UI scale" hint="Zooms text and controls. Saved in this browser">
      <div className="flex gap-1.5">
        <select className={btn.input} value={scale} onChange={e => setScale(Number(e.target.value))}>
          {[...new Set([...SCALES, scale])].sort((a, b) => a - b).map(s => <option key={s} value={s}>{pct(s)}{s === 1 ? ' (default)' : ''}</option>)}
        </select>
        <button className={btn.subtle} disabled={scale === 1} onClick={() => setScale(1)}>Reset</button>
      </div>
    </Row>
  );
}

// Startup animation and screensaver. Saved per browser (localStorage), like the theme.
function DisplayRows() {
  const amb = useAmbience();
  const preview = (ev: string) => window.dispatchEvent(new Event(ev));
  return (
    <>
      <Row label="Startup animation" hint="Plays when Shell:B opens; click or press a key to skip">
        <div className="flex gap-1.5">
          <select className={btn.input} value={amb.splash} onChange={e => saveAmbience({ splash: e.target.value as SplashMode })}>
            <option value="off">Off</option>
            <option value="session">Once per browser session</option>
            <option value="always">Every time the page loads</option>
          </select>
          <button className={btn.subtle} onClick={() => preview(PREVIEW_SPLASH)}>Preview</button>
        </div>
      </Row>
      <Row label="Screensaver" hint="Starts after this long without mouse, keyboard or touch input">
        <div className="flex gap-1.5">
          <select className={btn.input} value={amb.saverMinutes} onChange={e => saveAmbience({ saverMinutes: Number(e.target.value) })}>
            {SAVER_MINUTES.map(m => <option key={m} value={m}>{m ? `After ${m} minute${m > 1 ? 's' : ''}` : 'Off'}</option>)}
          </select>
          <button className={btn.subtle} onClick={() => preview(PREVIEW_SAVER)}>Preview</button>
        </div>
      </Row>
      <Row label="Screensaver style">
        <div className="flex items-center gap-3">
          <select className={btn.input} value={amb.saverStyle} onChange={e => saveAmbience({ saverStyle: e.target.value as SaverStyle })}>
            {SAVER_STYLES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] whitespace-nowrap">
            <Toggle on={amb.saverClock} onChange={v => saveAmbience({ saverClock: v })} label="Show clock" />Clock
          </label>
        </div>
      </Row>
    </>
  );
}

function SystemTab({ status, models, onOpenTab }: { status?: Status; models: ModelInfo[]; onOpenTab?: (t: SettingsTabId) => void }) {
  const mem = status?.memory;
  return (
    <div className="space-y-5">
      <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[var(--brand-soft)]/10 text-[var(--brand-soft)] flex items-center justify-center shrink-0">
            <Archive className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-[var(--text-primary)]">Backups & Disaster Recovery</div>
            <div className="text-[11px] text-[var(--text-muted)]">Atomic database snapshots, filesystem archives & safety restores</div>
          </div>
        </div>
        <button type="button" className={btn.subtle} onClick={() => onOpenTab?.('backups')}>
          Manage Backups →
        </button>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Services</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {Object.entries(SERVICE_INFO).map(([id, [name, desc]]) => {
            const ok = status?.services[id]?.ok;
            return (
              <div key={id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', ok == null ? 'bg-neutral-500' : ok ? 'bg-emerald-400' : 'bg-red-400')} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{name} <span className={clsx('text-[11px] font-normal', ok ? 'text-emerald-400' : 'text-red-400')}>{ok == null ? '' : ok ? 'online' : 'offline'}</span></div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate">{desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <SystemInfoPanel />
      {mem && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Models in memory</h3>
          <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden flex">
            {status?.loaded.map((m, i) => (
              <div key={m.name} className="h-full" title={`${m.name} · ${fmtBytes(m.size)}`}
                style={{ width: `${(m.size / mem.MemTotal) * 100}%`, background: ['#c96442', '#0284c7', '#059669', '#a855f7'][i % 4] }} />
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--text-muted)] font-mono">
            {fmtBytes(mem.MemTotal - mem.MemAvailable)} used of {fmtBytes(mem.MemTotal)} · {fmtBytes(mem.MemAvailable)} free
          </div>
          <div className="mt-2 space-y-1">
            {status?.loaded.map((m, i) => (
              <div key={m.name} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-sm" style={{ background: ['#c96442', '#0284c7', '#059669', '#a855f7'][i % 4] }} />
                <span className="font-medium">{m.name}</span>
                <span className="text-[var(--text-muted)] font-mono">{fmtBytes(m.size)}{m.context ? ` · ctx ${m.context.toLocaleString()}` : ''}</span>
              </div>
            ))}
            {status?.loaded.length === 0 && <div className="text-xs text-[var(--text-muted)]">No models loaded. They load on first use.</div>}
          </div>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center">Installed models
          <a href="#/models" className="ml-auto normal-case tracking-normal font-normal text-[11px] text-[var(--accent)] hover:underline">Manage models →</a></h3>
        <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              <tr><th className="text-left font-medium px-2.5 py-1.5">Model</th><th className="text-left font-medium px-2.5 py-1.5 hidden sm:table-cell">Abilities</th><th className="text-right font-medium px-2.5 py-1.5">Size</th></tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.name} className="border-t border-[var(--border-subtle)]">
                  <td className="px-2.5 py-1.5"><span className="font-medium">{m.name}</span> <span className="text-[var(--text-muted)]">{m.parameterSize} {m.quantization}</span>{m.loaded && <span className="ml-1.5 text-emerald-400">●</span>}</td>
                  <td className="px-2.5 py-1.5 text-[var(--text-muted)] hidden sm:table-cell">{m.capabilities.filter(c => c !== 'completion').join(', ')}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-[var(--text-muted)]">{fmtBytes(m.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-[11px] text-[var(--text-muted)]">Shell:B Web v{status?.version} · everything above runs locally on this system.</div>
    </div>
  );
}

// ── Command palette ────────────────────────────────────────────────────────

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  conversations: ConversationSummary[];
  theme: 'dark' | 'light';
  actions: {
    newChat: (agentId?: string) => void; openConversation: (id: string) => void; toggleTheme: () => void; toggleSkin: () => void;
    openApp: (app: AppId) => void; openSettings: (tab?: SettingsTabId) => void;
  };
}

export function CommandPalette({ open, onClose, agents, conversations, theme, actions }: PaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [msgHits, setMsgHits] = useState<ChatHit[]>([]);
  const favs = useFavorites();
  const railOrder = useRailOrder();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setSel(0); setMsgHits([]); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setMsgHits([]); return; }
    const t = setTimeout(() => {
      api.searchChats(term, 8).then(res => setMsgHits(res.results)).catch(() => setMsgHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  type Item = { id: string; label: string; hint?: string; search?: string; snippet?: string; icon: React.ReactNode; run: () => void };
  const items = useMemo<Item[]>(() => {
    const ql = q.toLowerCase();
    const cmds = ([
      { id: 'new', label: 'New chat', icon: <SquarePen className="w-4 h-4" />, run: () => actions.newChat() },
      ...agents.map(a => ({ id: `agent-${a.id}`, label: `New chat with ${a.name}`, hint: a.title, icon: <AgentAvatar agent={a} size={16} />, run: () => actions.newChat(a.id) })),
      { id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, icon: theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />, run: actions.toggleTheme },
      ...THEMES.map(t => ({ id: `theme-${t.id}`, label: `Theme: ${t.label}`, hint: t.id === currentTheme() ? 'current' : undefined, search: `skin look style ${t.blurb}`,
        icon: <Sparkles className="w-4 h-4 text-fuchsia-400" />, run: () => setTheme(t.id) })),
      { id: 'skin', label: 'Next theme', search: 'cycle skin', icon: <Sparkles className="w-4 h-4 text-fuchsia-400" />, run: actions.toggleSkin },
      { id: 'dj', label: 'Shell:B FM: play / pause the AI DJ', icon: <Sparkles className="w-4 h-4 text-pink-400" />, run: () => dispatchEvent(new CustomEvent('shellb:dj', { detail: 'toggle' })) },
      { id: 'dj-skip', label: 'Shell:B FM: next song', icon: <Sparkles className="w-4 h-4 text-pink-400" />, run: () => dispatchEvent(new CustomEvent('shellb:dj', { detail: 'skip' })) },
      ...APPS.filter(a => a.id !== 'chat' && a.id !== 'settings').map(a => {
        const Icon = a.icon;
        const i = railOrder.indexOf(a.id);
        return { id: `app-${a.id}`, label: `Open ${a.label}`, hint: i >= 0 && i < 9 ? shortcutLabel(i) : undefined, search: `${a.hint} ${a.keywords ?? ''}`, icon: <Icon className="w-4 h-4" style={{ color: a.tint }} />, run: () => actions.openApp(a.id) };
      }),
      { id: 'media', label: 'Open Media (generated pictures, music, sounds, 3D)', icon: <Boxes className="w-4 h-4 text-pink-400" />, run: () => { location.hash = '#/library/media'; } },
      { id: 'favorites', label: 'Open Favorites', icon: <Star className="w-4 h-4 text-amber-400" />, run: () => { location.hash = '#/library/favorites'; } },
      { id: 'memory', label: 'Manage memory', icon: <Brain className="w-4 h-4" />, run: () => actions.openSettings('memory') },
      { id: 'network', label: 'Network status', icon: <Network className="w-4 h-4" />, run: () => actions.openSettings('network') },
      { id: 'system', label: 'System status', icon: <Monitor className="w-4 h-4" />, run: () => actions.openSettings('system') },
      { id: 'apikeys', label: 'API Keys & External Services', search: 'api keys secrets tokens credentials external services', icon: <KeyRound className="w-4 h-4 text-rose-400" />, run: () => actions.openSettings('apikeys') },
      { id: 'codex-secrets', label: 'Codex: API Keys & Secrets', search: 'codex secrets api keys external tokens', icon: <KeyRound className="w-4 h-4 text-rose-400" />, run: () => { location.hash = '#/codex/secrets'; } },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon className="w-4 h-4" />, run: () => actions.openSettings() },
    ] as Item[]).filter(c => `${c.label} ${c.search ?? ''}`.toLowerCase().includes(ql));
    const stars: Item[] = favs.filter(f => `${f.title} ${f.subtitle}`.toLowerCase().includes(ql)).slice(0, q ? 12 : 8)
      .map(f => ({ id: `fav-${f.kind}-${f.ref}-${f.sub}`, label: f.title, hint: `★ ${FAV_LABEL[f.kind]}`, icon: <FavIcon f={f} agents={agents} />, run: () => { location.hash = f.href; } }));
    const starred = new Set(favs.filter(f => f.kind === 'chat').map(f => f.ref));
    const convs: Item[] = conversations.filter(c => !starred.has(c.id) && c.title.toLowerCase().includes(ql)).slice(0, 8)
      .map(c => ({ id: c.id, label: c.title, hint: relTime(c.updatedAt), icon: <MessageSquare className="w-4 h-4" />, run: () => actions.openConversation(c.id) }));

    const ftsItems: Item[] = [];
    for (const h of msgHits) {
      for (const match of h.hits.slice(0, 2)) {
        ftsItems.push({
          id: `fts-${match.msgId}`,
          label: h.title,
          hint: h.where !== 'Chat' ? h.where : relTime(h.updatedAt),
          snippet: match.snippet,
          icon: <MessageSquare className="w-4 h-4 text-[var(--accent)]" />,
          run: () => {
            actions.openConversation(h.convId);
            jumpToMessage(match.msgId);
          }
        });
      }
    }

    return q ? [...stars, ...convs, ...ftsItems, ...cmds] : [...cmds.slice(0, 1), ...stars, ...convs.slice(0, 6), ...cmds.slice(1)];
  }, [q, agents, conversations, theme, actions, favs, railOrder, msgHits]);

  if (!open) return null;
  const run = (i: number) => { items[i]?.run(); onClose(); };
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-3" onMouseDown={onClose}>
      <div className="w-full max-w-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl overflow-hidden animate-slide-up" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          <input ref={input} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} placeholder="Search messages, chats, and commands…"
            className="flex-1 bg-transparent py-3 text-sm focus:outline-none"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
              if (e.key === 'Enter') run(sel);
              if (e.key === 'Escape') onClose();
            }} />
          <kbd className="text-[10px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)]">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5 space-y-0.5">
          {items.map((it, i) => (
            <button key={it.id} onMouseEnter={() => setSel(i)} onClick={() => run(i)}
              className={clsx('w-full flex flex-col gap-1 px-2.5 py-2 rounded-lg text-left text-sm transition', i === sel ? 'bg-[var(--bg-hover)]' : '')}>
              <div className="flex items-center gap-2.5 w-full">
                <span className="text-[var(--text-secondary)] shrink-0">{it.icon}</span>
                <span className="flex-1 truncate font-medium">{it.label}</span>
                {it.hint && <span className="text-[11px] text-[var(--text-muted)] shrink-0">{it.hint}</span>}
              </div>
              {it.snippet && (
                <div className="text-[11px] leading-snug text-[var(--text-muted)] pl-6.5 line-clamp-2">
                  <Snippet text={it.snippet} />
                </div>
              )}
            </button>
          ))}
          {items.length === 0 && <div className="text-xs text-[var(--text-muted)] text-center py-6">No matches</div>}
        </div>
      </div>
    </div>
  );
}
