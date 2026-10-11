import { LOCALES, setLocalePref, t, type LocalePref } from '../i18n';
import { CommunityRepos } from './CommunityRepos';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Archive, AudioLines, Bell, BookMarked, Boxes, Brain, EyeOff, Inbox, Sparkles, Cpu, Monitor, Moon, Plus, Search, Settings as SettingsIcon, SlidersHorizontal, SquarePen, Star, Sun, Trash2, BrainCircuit, MessageSquare, KeyRound, Hash, Network, ShieldCheck, MonitorDown, PictureInPicture2, History, Palette, MonitorPlay, Keyboard, BarChart3, Users, Globe, Plug, Rocket, ListTodo, ClipboardCheck, Store, RefreshCw, UserRound, Workflow, Library } from 'lucide-react';
import type { ToolsTab } from './Integrations';
import type { Agent, ChatHit, ConversationSummary, Memory, ModelInfo, Settings, SettingsTabId, Status, ToolInfo } from '../types';
import { api, fmtBytes } from '../api';
import { AgentAvatar, Modal, Toggle, btn, relTime, toolIcon, Snippet } from './common';
import { jumpToMessage } from '../jump';
import { overlaySupported, toggleOverlay } from '../overlay';
import { toast } from './toast';
import { FAV_LABEL, useFavorites } from '../favorites';
import { FavIcon } from './Favorites';
import { APPS, shortcutLabel, useRailOrder, type AppId } from './apps';
import { searchIcon, searchedList, useEverythingSearch } from './SearchResults';
import { AccountTab } from './Account';
import { ApiKeysSettings } from './ApiKeysSettings';
import { ChangelogTab } from './ChangelogTab';
import { BackupsTab } from './BackupsTab';
import { NotificationsTab } from './NotificationsSettings';
import { MemoryManager } from './MemoryManager';
import { SpeechTab } from './SpeechSettings';
import { SCALES, setScale, useScale } from '../uiScale';
import { ShortcutsTab } from './ShortcutsSettings';
import { UsageTab } from './UsageTab';
import { promptInstall, useInstallState } from '../desktop';
import { SystemInfoPanel } from './SystemInfo';
import { NetworkSettings } from './NetworkSettings';
import { ThemePicker } from './ThemePicker';
import { THEMES, currentTheme, setAmbientOn, setTheme, useAmbientOn } from '../themes';
import { PREVIEW_SAVER, PREVIEW_SPLASH, SAVER_MINUTES, SAVER_STYLES, saveAmbience, useAmbience, type SaverStyle, type SplashMode } from '../ambience';
import { CommunitySavers } from './Gallery';
import { isCell, type GuestPanel } from '../cell';
import { CellAccountTab, GUEST_ENTRIES, toPanel } from './CellGuest';

const SERVICE_INFO: Record<string, [string, string]> = {
  ollama: ['Ollama', 'Language models · :11434'],
  searxng: ['VASSAGO', 'SearXNG web search · :8080'],
  sandbox: ['Sandbox', 'Docker image shellb-sandbox'],
  nyx: ['NYX', 'ComfyUI + FLUX images · :8188'],
  orpheus: ['ORPHEUS', 'MusicGen · :8002'],
  hermes: ['HERMES', 'Whisper + Kokoro voice · :8001'],
  stableaudio: ['Stable Audio', 'Sound effects and loops · :8003'],
  embeddings: ['MIMIR-lite', 'Embedding model for memory'],
};

// ── Tools ──────────────────────────────────────────────────────────────────

export function ToolsModal({ open, onClose, tools, onChanged }: { open: boolean; onClose: () => void; tools: ToolInfo[]; onChanged: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={t('Tools')} icon={<Boxes className="w-4 h-4 text-sky-400" />}>
      <div className="overflow-y-auto p-4 space-y-2">
        <p className="text-xs text-[var(--text-muted)] mb-3">{t('Switch a tool off here to disable it for every agent. Pick which agents get which tools in the Agent Lab.')}</p>
        {tools.map(tool => {
          const Icon = toolIcon(tool.id);
          return (
            <div key={tool.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <span className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-sky-400" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tool.displayName}</span>
                  <span className="text-[10px] font-mono text-[var(--text-muted)]">{tool.id}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)]">{t(tool.description)}</div>
                {!tool.available && <div className="text-[11px] text-amber-400 mt-0.5">{t('Backing service is offline: {v0}', { v0: SERVICE_INFO[tool.service ?? '']?.[0] ?? tool.service })}</div>}
              </div>
              <Toggle on={tool.enabled} label={tool.displayName} onChange={async v => { await api.setTool(tool.id, v); onChanged(); }} />
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
  /** a guest's own Shell:B (cell.ts): Account opens the gateway's panels instead of the owner's password and sessions */
  onGuest?: (panel: GuestPanel) => void;
}

// In a guest's cell the host's tabs don't exist: API keys, the network, host stats, backups and the owner's account.
const CELL_SETTINGS = new Set<SettingsTabId>(['general', 'appearance', 'speech', 'memory', 'shortcuts', 'notifications', 'changelog', 'account', 'usage']);
const settingsTab = (t?: SettingsTabId): SettingsTabId => (t && (!isCell() || CELL_SETTINGS.has(t)) ? t : 'general');

export function SettingsContent(p: SettingsProps) {
  const [tab, setTab] = useState<SettingsTabId>(() => settingsTab(p.tab));
  useEffect(() => { if (p.tab) setTab(settingsTab(p.tab)); }, [p.tab]);
  const tabs = ([
    { id: 'general', label: 'General', icon: SlidersHorizontal },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'community', label: 'Community', icon: Library },
    { id: 'apikeys', label: 'API Keys', icon: KeyRound },
    { id: 'speech', label: 'Speech', icon: AudioLines },
    { id: 'network', label: 'Network', icon: Network },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'shortcuts', label: 'Shortcuts', icon: Hash },
    { id: 'system', label: 'System', icon: Cpu },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'backups', label: 'Backups', icon: Archive },
    { id: 'changelog', label: 'Changelog', icon: History },
    { id: 'account', label: 'Account', icon: ShieldCheck },
    { id: 'usage', label: 'Usage', icon: BarChart3 },
  ] as const).filter(t => !isCell() || CELL_SETTINGS.has(t.id));

  return (
    <div className="flex-1 min-h-0 flex flex-col sm:flex-row h-full">
      <div className="sm:w-44 shrink-0 p-2 flex sm:flex-col gap-1 border-b sm:border-b-0 sm:border-r border-[var(--border-subtle)] overflow-x-auto">
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition whitespace-nowrap', tab === tb.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
            <tb.icon className="w-4 h-4 shrink-0" />{t(tb.label)}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
        {tab === 'general' && <General {...p} onOpenTab={setTab} />}
        {tab === 'appearance' && <Appearance {...p} />}
        {tab === 'community' && <CommunityRepos onOpenTab={setTab} />}
        {tab === 'apikeys' && <ApiKeysSettings settings={p.settings} onSaved={p.onSaved} />}
        {tab === 'speech' && <SpeechTab settings={p.settings} onSaved={p.onSaved} />}
        {tab === 'network' && <NetworkSettings />}
        {tab === 'memory' && <MemoryManager />}
        {tab === 'shortcuts' && <ShortcutsTab />}
        {tab === 'system' && <SystemTab status={p.status} models={p.models} onOpenTab={setTab} />}
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'backups' && <BackupsTab />}
        {tab === 'changelog' && <ChangelogTab />}
        {tab === 'account' && (isCell() ? <CellAccountTab onGuest={p.onGuest} /> : <AccountTab />)}
        {tab === 'usage' && <UsageTab models={p.models} />}
      </div>
    </div>
  );
}

export function SettingsModal(p: SettingsProps) {
  return (
    <Modal open={p.open ?? false} onClose={p.onClose ?? (() => {})} title={t('Settings')} icon={<SettingsIcon className="w-4 h-4" />} wide>
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

/** Settings → Appearance: the theme (and Shell:B-designed ones), the living backdrop, scale, startup animation, screensaver. */
function Appearance({ settings, theme, onTheme, onClose }: SettingsProps) {
  const ambient = useAmbientOn();
  return (
    <div>
      <ThemePicker settings={settings} mode={theme} onMode={onTheme} onDone={onClose} />
      <Row label={t('Moving backdrop')} hint={t('The particles and scenery motion some themes have (fireflies, rain, aurora…). Saved in this browser')}>
        <Toggle on={ambient} onChange={setAmbientOn} label={t('Moving backdrop')} />
      </Row>
      <ScaleRow />
      <DisplayRows onDone={onClose} />
    </div>
  );
}

function General({ settings, agents, models, onSaved, onOpenTab }: SettingsProps) {
  if (!settings) return null;
  const save = async (patch: Partial<Settings>) => { await api.saveSettings(patch); onSaved(); };
  const vision = models.filter(m => m.capabilities.includes('vision'));
  const embedders = models.filter(m => m.capabilities.includes('embedding') || /embed/i.test(m.name));
  return (
    <div>
      <InstallRow />
      <Row label={t('Default agent')} hint={t('Used for new chats')}>
        <select className={btn.input} value={settings.defaultAgent} onChange={e => save({ defaultAgent: e.target.value })}>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name} — {t(a.title)}</option>)}
        </select>
      </Row>
      <Row label={t('Language')} hint={t('Interface and replies. Automatic follows the browser')}>
        <select className={btn.input} value={settings.language ?? ''} onChange={e => { const v = e.target.value as LocalePref; save({ language: v }); setLocalePref(v); }}>
          <option value="">{t('Automatic')}</option>
          {LOCALES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Row>
      <Row label={t('Vision fallback')} hint={t('Handles images when the agent\'s model can\'t see')}>
        <select className={btn.input} value={settings.visionFallbackModel} onChange={e => save({ visionFallbackModel: e.target.value })}>
          {vision.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label={t('Utility model')} hint={t('Writes conversation titles')}>
        <select className={btn.input} value={settings.utilityModel} onChange={e => save({ utilityModel: e.target.value })}>
          {models.filter(m => m.capabilities.includes('completion')).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label={t('Memory embeddings')} hint={t('Changing this makes existing memories unsearchable')}>
        <select className={btn.input} value={settings.embeddingModel} onChange={e => save({ embeddingModel: e.target.value })}>
          {(embedders.length ? embedders : models).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </Row>
      <Row label={t('Remember on request')} hint={t('Agents can save, correct and forget memories when you ask. Background learning is set in the Memory tab')}>
        <Toggle on={settings.autoMemory} onChange={v => save({ autoMemory: v })} label={t('Auto-remember')} />
      </Row>
      <Row label={t('Suggest replies')} hint={t('After each reply, the utility model guesses your next message; Tab accepts it')}>
        <Toggle on={settings.promptSuggestions ?? true} onChange={v => save({ promptSuggestions: v })} label={t('Suggest replies')} />
      </Row>
      <Row label={t('Fresh starter cards')} hint={t('Every 12 hours, while nobody is chatting, the utility model writes new suggestions for the empty-chat screen')}>
        <Toggle on={settings.suggestionsRefresh ?? true} onChange={v => save({ suggestionsRefresh: v })} label={t('Fresh starter cards')} />
      </Row>
      {!isCell() && (
        <Row label={t('API Keys')} hint={t('Credentials for external services and cloud AI providers')}>
          <button className={btn.subtle} onClick={() => onOpenTab?.('apikeys')}><KeyRound className="w-3.5 h-3.5 text-rose-400" />{t('API keys & external services')}</button>
        </Row>
      )}
      <Row label={t('Voice')} hint={t('Reading voice, speed, and the voice library')}>
        <button className={btn.subtle} onClick={() => onOpenTab?.('speech')}><AudioLines className="w-3.5 h-3.5" />{t('Speech settings')}</button>
      </Row>
      {!isCell() && (
        <Row label={t('Network')} hint={t('Wi-Fi, Ethernet, and active VPN tunnels')}>
          <button className={btn.subtle} onClick={() => onOpenTab?.('network')}><Network className="w-3.5 h-3.5" />{t('Network settings')}</button>
        </Row>
      )}
      <Row label={t('Max tool rounds')} hint={t('Safety cap on tool calls per reply; the loop guard may extend it up to the hard cap')}>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={50} className={clsx(btn.input, 'w-24')} value={settings.maxToolRounds}
            onChange={e => save({ maxToolRounds: Math.max(1, Math.min(50, Number(e.target.value) || 16)) })} />
          <span className="text-xs text-[var(--text-muted)]">{t('hard cap')}</span>
          <input type="number" min={20} max={500} className={clsx(btn.input, 'w-20 text-center')} value={settings.maxToolRoundsHardCap ?? 100}
            onChange={e => save({ maxToolRoundsHardCap: Math.max(20, Math.min(500, Number(e.target.value) || 100)) })} />
        </div>
      </Row>
      <Row label={t('Stream stall')} hint={t('End a local turn when the model sends nothing for this long (minutes)')}>
        <input type="number" min={2} max={60} className={clsx(btn.input, 'w-24')} value={settings.streamStallMinutes ?? 10}
          onChange={e => save({ streamStallMinutes: Math.max(2, Math.min(60, Number(e.target.value) || 10)) })} />
      </Row>
      <Row label={t('Loop guard')} hint={t('Evaluates progress every X turns: auto-extends budget, prevents runaway loops')}>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={settings.runawayLoopChecker ?? true}
              onChange={e => save({ runawayLoopChecker: e.target.checked })} />
            {t('Active')}
          </label>
          <span className="text-xs text-[var(--text-muted)]">{t('Check every')}</span>
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
    <Row label={t('UI scale')} hint={t('Zooms text and controls. Saved in this browser')}>
      <div className="flex gap-1.5">
        <select className={btn.input} value={scale} onChange={e => setScale(Number(e.target.value))}>
          {[...new Set([...SCALES, scale])].sort((a, b) => a - b).map(s => <option key={s} value={s}>{pct(s)}{s === 1 ? ' (default)' : ''}</option>)}
        </select>
        <button className={btn.subtle} disabled={scale === 1} onClick={() => setScale(1)}>{t('Reset')}</button>
      </div>
    </Row>
  );
}

// Startup animation and screensaver. Saved per browser (localStorage), like the theme.
/** Offered while the browser can install Shell:B as an app (desktop.ts); hidden where it can't, or already has. */
function InstallRow() {
  const state = useInstallState();
  if (state === 'unavailable') return null;
  return (
    <Row label={t('Desktop app')} hint={state === 'installed' ? t('Shell:B is running as an installed app on this device')
      : t('Its own window and dock icon with a badge for what’s waiting, “Open with Shell:B” for files, and Share → Shell:B')}>
      {state === 'installed'
        ? <span className="text-xs text-emerald-400">{t('Installed')}</span>
        : <button className={btn.subtle} onClick={() => { promptInstall().catch(() => {}); }}><MonitorDown className="w-3.5 h-3.5" />{t('Install Shell:B')}</button>}
    </Row>
  );
}

function DisplayRows({ onDone }: { onDone?: () => void }) {
  const amb = useAmbience();
  const preview = (ev: string) => window.dispatchEvent(new Event(ev));
  // screensavers made in the Studio (Screensaver projects) join the built-in styles
  const [made, setMade] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.projects().then(ps => setMade(ps.filter(p => p.kind === 'screensaver').map(p => ({ id: p.id, name: p.name }))), () => {}); }, []);
  const [creating, setCreating] = useState(false);
  const makeOne = async () => {
    setCreating(true);
    try {
      const p = await api.createProject({ name: 'Screensaver', kind: 'screensaver', brief: '' });
      onDone?.();
      location.hash = `#/studio/${p.id}`;
    } catch (e) { toast(t('Couldn\'t create the project: {e}', { e: String(e) }), { kind: 'error' }); } finally { setCreating(false); }
  };
  const [browsing, setBrowsing] = useState(false);
  const missing = amb.saverStyle.startsWith('studio:') && !made.some(m => `studio:${m.id}` === amb.saverStyle);
  return (
    <>
      <Row label={t('Startup animation')} hint={t('Plays when Shell:B opens; click or press a key to skip')}>
        <div className="flex gap-1.5">
          <select className={btn.input} value={amb.splash} onChange={e => saveAmbience({ splash: e.target.value as SplashMode })}>
            <option value="off">{t('Off')}</option>
            <option value="session">{t('Once per browser session')}</option>
            <option value="always">{t('Every time the page loads')}</option>
          </select>
          <button className={btn.subtle} onClick={() => preview(PREVIEW_SPLASH)}>{t('Preview')}</button>
        </div>
      </Row>
      <Row label={t('Screensaver')} hint={t('Starts after this long without mouse, keyboard or touch input')}>
        <div className="flex gap-1.5">
          <select className={btn.input} value={amb.saverMinutes} onChange={e => saveAmbience({ saverMinutes: Number(e.target.value) })}>
            {SAVER_MINUTES.map(m => <option key={m} value={m}>{m ? t('After {m} minute{v0}', { m: m, v0: m > 1 ? 's' : '' }) : t('Off')}</option>)}
          </select>
          <button className={btn.subtle} onClick={() => preview(PREVIEW_SAVER)}>{t('Preview')}</button>
        </div>
      </Row>
      <Row label={t('Screensaver style')}>
        <div className="flex items-center gap-3">
          <select className={btn.input} value={amb.saverStyle} onChange={e => saveAmbience({ saverStyle: e.target.value as SaverStyle })}>
            <optgroup label={t('Built in')}>
              {SAVER_STYLES.map(s => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
            </optgroup>
            {(made.length > 0 || missing) && (
              <optgroup label={t('Made in the Studio')}>
                {made.map(m => <option key={m.id} value={`studio:${m.id}`}>{m.name}</option>)}
                {missing && <option value={amb.saverStyle}>{t('(deleted project)')}</option>}
              </optgroup>
            )}
          </select>
          <button className={btn.subtle} disabled={creating} onClick={makeOne}
            title={t('Start a Screensaver project in the Studio and describe what you\'d like; Shell:B builds it')}>
            <MonitorPlay className="w-3.5 h-3.5" />{t('Make one in the Studio')}
          </button>
          <button className={btn.subtle} onClick={() => setBrowsing(true)} title={t('Screensavers other people shared on GitHub; install one with a click')}>
            <Globe className="w-3.5 h-3.5" />{t('Browse community')}
          </button>
          <CommunitySavers open={browsing} onClose={() => setBrowsing(false)}
            onInstalled={(id, name) => setMade(m => m.some(x => x.id === id) ? m : [...m, { id, name }])} />
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] whitespace-nowrap">
            <Toggle on={amb.saverClock} onChange={v => saveAmbience({ saverClock: v })} label={t('Show clock')} />{t('Clock')}
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
            <div className="text-xs font-semibold text-[var(--text-primary)]">{t('Backups & Disaster Recovery')}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('Atomic database snapshots, filesystem archives & safety restores')}</div>
          </div>
        </div>
        <button type="button" className={btn.subtle} onClick={() => onOpenTab?.('backups')}>
          {t('Manage Backups →')}
        </button>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">{t('Services')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {Object.entries(SERVICE_INFO).map(([id, [name, desc]]) => {
            const ok = status?.services[id]?.ok;
            return (
              <div key={id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', ok == null ? 'bg-neutral-500' : ok ? 'bg-emerald-400' : 'bg-red-400')} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{name} <span className={clsx('text-[11px] font-normal', ok ? 'text-emerald-400' : 'text-red-400')}>{ok == null ? '' : ok ? t('online') : t('offline')}</span></div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate">{t(desc)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <SystemInfoPanel />
      {mem && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">{t('Models in memory')}</h3>
          <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden flex">
            {status?.loaded.map((m, i) => (
              <div key={m.name} className="h-full" title={`${m.name} · ${fmtBytes(m.size)}`}
                style={{ width: `${(m.size / mem.MemTotal) * 100}%`, background: ['#c96442', '#0284c7', '#059669', '#a855f7'][i % 4] }} />
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--text-muted)] font-mono">
            {t('{v0} used of {v1} · {v2} free', { v0: fmtBytes(mem.MemTotal - mem.MemAvailable), v1: fmtBytes(mem.MemTotal), v2: fmtBytes(mem.MemAvailable) })}
          </div>
          <div className="mt-2 space-y-1">
            {status?.loaded.map((m, i) => (
              <div key={m.name} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-sm" style={{ background: ['#c96442', '#0284c7', '#059669', '#a855f7'][i % 4] }} />
                <span className="font-medium">{m.name}</span>
                <span className="text-[var(--text-muted)] font-mono">{fmtBytes(m.size)}{m.context ? t(' · ctx {v0}', { v0: m.context.toLocaleString() }) : ''}</span>
              </div>
            ))}
            {status?.loaded.length === 0 && <div className="text-xs text-[var(--text-muted)]">{t('No models loaded. They load on first use.')}</div>}
          </div>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center">{t('Installed models')}
          <a href="#/models" className="ml-auto normal-case tracking-normal font-normal text-[11px] text-[var(--accent)] hover:underline">{t('Manage models →')}</a></h3>
        <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
              <tr><th className="text-left font-medium px-2.5 py-1.5">{t('Model')}</th><th className="text-left font-medium px-2.5 py-1.5 hidden sm:table-cell">{t('Abilities')}</th><th className="text-right font-medium px-2.5 py-1.5">{t('Size')}</th></tr>
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
      <div className="text-[11px] text-[var(--text-muted)]">{t('Shell:B Web v{version} · everything above runs locally on this system.', { version: status?.version ?? '' })}</div>
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
    newChat: (agentId?: string, incognito?: boolean) => void; openConversation: (id: string) => void; toggleTheme: () => void; toggleSkin: () => void;
    openApp: (app: AppId) => void; openSettings: (tab?: SettingsTabId) => void;
    /** Tools & Connectors on a given tab (desktop only; the kiosk opens the modal on its default tab) */
    openTools?: (tab?: ToolsTab) => void;
    /** a guest's own Shell:B (cell.ts): the gateway's account, limits and Report to Evie panels */
    openGuest?: (panel: GuestPanel) => void;
  };
  /** for entries that exist only when a feature is on (Aphrodite's tab) */
  settings?: Settings;
}

// palette commands that are the host's own (server/cell_boot.py skips their routers in a guest's cell)
const CELL_HIDDEN = new Set(['network', 'system', 'apikeys', 'codex-secrets', 'backups', 'account', 'tools-discover', 'tools-servers',
  'tools-api', 'tools-guests', 'tools-screen', 'tools-cloud', 'tools-adult', 'nightshift', 'findings', 'model-store', 'model-updates', 'fleet']);

export function CommandPalette({ open, onClose, agents, conversations, theme, actions, settings }: PaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [msgHits, setMsgHits] = useState<ChatHit[]>([]);
  const favs = useFavorites();
  const railOrder = useRailOrder();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setSel(0); setMsgHits([]); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  const everything = useEverythingSearch(q, open);  // Codex, follow-ups, Library, /work files, media, wiki (SearchResults.tsx)
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setMsgHits([]); return; }
    const t = setTimeout(() => {
      api.searchChats(term, 8).then(res => setMsgHits(res.results)).catch(() => setMsgHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  type Item = { id: string; label: string; hint?: string; search?: string; snippet?: string; section?: string; icon: React.ReactNode; run: () => void };
  const items = useMemo<Item[]>(() => {
    const ql = q.toLowerCase();
    const cmds = ([
      { id: 'new', label: 'New chat', icon: <SquarePen className="w-4 h-4" />, run: () => actions.newChat() },
      { id: 'new-incognito', label: 'New incognito chat', hint: 'Not remembered · deleted automatically', search: 'private incognito forget',
        icon: <EyeOff className="w-4 h-4 text-slate-500 dark:text-slate-400" />, run: () => actions.newChat(undefined, true) },
      ...agents.map(a => ({ id: `agent-${a.id}`, label: `New chat with ${a.name}`, hint: a.title, icon: <AgentAvatar agent={a} size={16} />, run: () => actions.newChat(a.id) })),
      { id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, icon: theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />, run: actions.toggleTheme },
      ...THEMES.map(t => ({ id: `theme-${t.id}`, label: `Theme: ${t.label}`, hint: t.id === currentTheme() ? 'current' : undefined, search: `skin look style ${t.blurb}`,
        icon: <Sparkles className="w-4 h-4 text-fuchsia-400" />, run: () => setTheme(t.id) })),
      ...(overlaySupported() ? [{ id: 'overlay', label: 'Overlay: a small Shell:B window that stays on top', hint: 'Ctrl+Shift+Y', search: 'picture in picture pip float always on top screen',
        icon: <PictureInPicture2 className="w-4 h-4 text-sky-400" />, run: () => { toggleOverlay().catch(e => toast(String(e), { kind: 'error' })); } }] : []),
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
      { id: 'appearance', label: 'Appearance & themes', search: 'theme skin look style colors design custom scale screensaver', icon: <Palette className="w-4 h-4 text-fuchsia-400" />, run: () => actions.openSettings('appearance') },
      { id: 'memory', label: 'Manage memory', icon: <Brain className="w-4 h-4" />, run: () => actions.openSettings('memory') },
      { id: 'network', label: 'Network status', icon: <Network className="w-4 h-4" />, run: () => actions.openSettings('network') },
      { id: 'system', label: 'System status', icon: <Monitor className="w-4 h-4" />, run: () => actions.openSettings('system') },
      { id: 'apikeys', label: 'API Keys & External Services', search: 'api keys secrets tokens credentials external services', icon: <KeyRound className="w-4 h-4 text-rose-400" />, run: () => actions.openSettings('apikeys') },
      { id: 'codex-secrets', label: 'Codex: API Keys & Secrets', search: 'codex secrets api keys external tokens', icon: <KeyRound className="w-4 h-4 text-rose-400" />, run: () => { location.hash = '#/codex/secrets'; } },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon className="w-4 h-4" />, run: () => actions.openSettings() },
      { id: 'speech', label: 'Speech & voices', search: 'tts voice read aloud dictation whisper kokoro clone', icon: <AudioLines className="w-4 h-4" />, run: () => actions.openSettings('speech') },
      { id: 'shortcuts', label: 'Shortcuts: /prompts, #variables and keys', search: 'composer templates variables keyboard hotkeys', icon: <Hash className="w-4 h-4" />, run: () => actions.openSettings('shortcuts') },
      { id: 'keys', label: 'Keyboard shortcuts', hint: '?', search: 'hotkeys keys bindings', icon: <Keyboard className="w-4 h-4" />, run: () => actions.openSettings('shortcuts') },
      { id: 'notifications', label: 'Notifications', search: 'push devices alerts email', icon: <Bell className="w-4 h-4" />, run: () => actions.openSettings('notifications') },
      { id: 'backups', label: 'Backups', search: 'backup restore export archive', icon: <Archive className="w-4 h-4" />, run: () => actions.openSettings('backups') },
      { id: 'changelog', label: "What's new (changelog)", search: 'changes release notes version', icon: <History className="w-4 h-4" />, run: () => actions.openSettings('changelog') },
      { id: 'account', label: 'Account: password, devices, audit log', search: 'login sessions sign out security', icon: <ShieldCheck className="w-4 h-4" />, run: () => actions.openSettings('account') },
      { id: 'usage', label: 'Usage & costs: tokens per agent, model and day', search: 'tokens cost spend dashboard statistics', icon: <BarChart3 className="w-4 h-4" />, run: () => actions.openSettings('usage') },
      ...(actions.openTools ? [
        { id: 'tools-skills', label: 'Skills', search: 'skill.md agent skills install', icon: <Sparkles className="w-4 h-4 text-amber-400" />, run: () => actions.openTools!('skills') },
        { id: 'tools-discover', label: 'Discover: community MCP servers and skills', search: 'marketplace registry community install', icon: <Globe className="w-4 h-4 text-sky-400" />, run: () => actions.openTools!('discover') },
        { id: 'tools-servers', label: 'MCP servers & connectors', search: 'mcp connectors servers integrations', icon: <Plug className="w-4 h-4 text-sky-400" />, run: () => actions.openTools!('servers') },
        { id: 'tools-api', label: 'Shell:B API keys & webhooks', search: 'api v1 keys mcp server openai compatible', icon: <KeyRound className="w-4 h-4 text-rose-400" />, run: () => actions.openTools!('api') },
        { id: 'tools-guests', label: 'Guests: invites, accounts, containers', search: 'guest invite cells reports', icon: <Users className="w-4 h-4 text-fuchsia-400" />, run: () => actions.openTools!('guests') },
        { id: 'tools-screen', label: 'Screen & browser helper', search: 'screen share pair computer browser helper', icon: <MonitorPlay className="w-4 h-4" />, run: () => actions.openTools!('screen') },
        { id: 'tools-cloud', label: 'Cloud AI', search: 'claude gemini openai cloud keys', icon: <Rocket className="w-4 h-4" />, run: () => actions.openTools!('cloud') },
        ...(settings?.adultEnabled ? [{ id: 'tools-adult', label: 'Aphrodite settings', search: 'adult after dark', icon: <UserRound className="w-4 h-4 text-rose-400" />, run: () => actions.openTools!('adult') }] : []),
      ] : []),
      { id: 'followups', label: 'Follow-ups and the morning brief', search: 'reminders todo commitments brief', icon: <ListTodo className="w-4 h-4 text-orange-400" />, run: () => { location.hash = '#/activity/follow-ups'; } },
      { id: 'nightshift', label: 'Night shift queue', search: 'overnight research redraft big model', icon: <Moon className="w-4 h-4 text-indigo-300" />, run: () => { location.hash = '#/activity/night-shift'; } },
      { id: 'findings', label: 'Self-review findings', search: 'audit review ledger bugs', icon: <ClipboardCheck className="w-4 h-4 text-rose-400" />, run: () => { location.hash = '#/activity/findings'; } },
      { id: 'model-store', label: 'Model Store', search: 'download models ollama hugging face', icon: <Store className="w-4 h-4 text-cyan-400" />, run: () => { location.hash = '#/models/store'; } },
      { id: 'model-updates', label: 'Model updates', search: 'newer model versions', icon: <RefreshCw className="w-4 h-4 text-cyan-400" />, run: () => { location.hash = '#/models/updates'; } },
      { id: 'fleet', label: 'Fleet: other machines running models', search: 'nodes machines spread overflow', icon: <Workflow className="w-4 h-4 text-cyan-400" />, run: () => { location.hash = '#/models/fleet'; } },
      ...(actions.openGuest ? GUEST_ENTRIES.map(e => ({ id: `guest-${e.id}`, label: e.label, hint: e.hint, search: 'guest evie', icon: <e.icon className="w-4 h-4 text-[var(--accent)]" />,
        run: () => actions.openGuest!(toPanel(e.id)) })) : []),
    ] as Item[]).filter(c => !(isCell() && CELL_HIDDEN.has(c.id)) && `${c.label} ${c.search ?? ''}`.toLowerCase().includes(ql));
    const stars: Item[] = favs.filter(f => `${f.title} ${f.subtitle}`.toLowerCase().includes(ql)).slice(0, q ? 12 : 8)
      .map(f => ({ id: `fav-${f.kind}-${f.ref}-${f.sub}`, label: f.title, hint: `★ ${FAV_LABEL[f.kind]}`, icon: <FavIcon f={f} agents={agents} />, run: () => { location.hash = f.href; } }));
    const starred = new Set(favs.filter(f => f.kind === 'chat').map(f => f.ref));
    const convs: Item[] = conversations.filter(c => !starred.has(c.id) && c.title.toLowerCase().includes(ql)).slice(0, 8)
      .map(c => ({ id: c.id, label: c.title, hint: relTime(c.updatedAt), icon: c.incognito ? <EyeOff className="w-4 h-4 text-slate-500 dark:text-slate-400" /> : <MessageSquare className="w-4 h-4" />, run: () => actions.openConversation(c.id) }));

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

    // everything else the owner has (server/search.py), one section per group, under the chats and commands
    const found: Item[] = q.trim() ? everything.groups.flatMap(g => g.items.map(it => ({
      id: `s-${it.id}`, label: it.title, hint: it.hint, snippet: it.snippet || undefined, section: g.group,
      icon: searchIcon(it), run: () => { location.hash = it.route; },
    }))) : [];

    return q ? [...stars, ...convs, ...ftsItems, ...cmds, ...found] : [...cmds.slice(0, 1), ...stars, ...convs.slice(0, 6), ...cmds.slice(1)];
  }, [q, agents, conversations, theme, actions, favs, railOrder, msgHits, everything.groups]);

  if (!open) return null;
  const run = (i: number) => { items[i]?.run(); onClose(); };
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-3" onMouseDown={onClose}>
      <div className="w-full max-w-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl shadow-2xl overflow-hidden animate-slide-up" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          <input ref={input} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} placeholder={t('Search everything: chats, notes, files, commands…')}
            className="flex-1 bg-transparent py-3 text-sm focus:outline-none"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
              if (e.key === 'Enter') run(sel);
              if (e.key === 'Escape') onClose();
            }} />
          <kbd className="text-[10px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)]">esc</kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5 space-y-0.5">
          {items.map((it, i) => (
            <Fragment key={it.id}>
            {it.section && it.section !== items[i - 1]?.section && (
              <div className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{it.section}</div>
            )}
            <button onMouseEnter={() => setSel(i)} onClick={() => run(i)} data-sel={i === sel}
              className={clsx('w-full flex flex-col gap-1 px-2.5 py-2 rounded-lg text-left text-sm transition', i === sel ? 'bg-[var(--bg-hover)]' : '')}>
              <div className="flex items-center gap-2.5 w-full">
                <span className="text-[var(--text-secondary)] shrink-0">{it.icon}</span>
                <span className="flex-1 truncate font-medium">{t(it.label)}</span>
                {it.hint && <span className="text-[11px] text-[var(--text-muted)] shrink-0">{t(it.hint)}</span>}
              </div>
              {it.snippet && (
                <div className="text-[11px] leading-snug text-[var(--text-muted)] pl-6.5 line-clamp-2">
                  <Snippet text={it.snippet} />
                </div>
              )}
            </button>
            </Fragment>
          ))}
          {items.length === 0 && !everything.loading && !(everything.empty && everything.searched.length) && <div className="text-xs text-[var(--text-muted)] text-center py-6">{t('No matches')}</div>}
          {q.trim().length >= 2 && everything.loading && (
            <div className="px-2.5 py-2 text-[11px] text-[var(--text-muted)] animate-pulse">{t('Searching notes, follow-ups, the Library, chat files, media and the wiki…')}</div>
          )}
          {q.trim().length >= 2 && everything.empty && everything.searched.length > 0 && (
            <div className="px-2.5 py-2 text-[11px] leading-snug text-[var(--text-muted)]">
              {t('Nothing in your {v0} matches “{query}”.', { v0: searchedList(everything.searched), query: everything.query })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
