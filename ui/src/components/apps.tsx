import { AudioLines, BookMarked, BookOpen, Brain, BrainCircuit, Boxes, CalendarClock, CodeXml, Cpu, HardDrive, ImagePlus, Inbox, LibraryBig, Map as MapIcon, MessageSquare, NotebookPen, Palette, Radio, RadioTower, Settings, Shapes, Telescope, UserRound, Workflow, type LucideIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { Status } from '../types';
import { djLive } from '../dj/live';

export type AppId = 'chat' | 'studio' | 'code' | 'library' | 'maps' | 'wiki' | 'me' | 'notes' | 'codex' | 'memory' | 'research' | 'plans' | 'assets' | 'scheduled' | 'activity'
  | 'secretary' | 'gibberlink' | 'radio' | 'generate' | 'models' | 'data' | 'agents' | 'tools' | 'settings';

export type AppGroup = 'chat' | 'make' | 'know' | 'run' | 'system';

export const GROUP_LABEL: Record<AppGroup, string> = { chat: 'Chat', make: 'Make', know: 'Know', run: 'Run', system: 'System' };

/** Pinned to the rail until you change it in All apps. */
export const DEFAULT_PINS: AppId[] = ['studio', 'code', 'library', 'radio', 'notes', 'codex', 'memory', 'plans', 'activity'];

export interface AppLive {
  label?: string;            // replaces the label while something is going on ("Mega plans · running")
  busy?: boolean;            // pulsing dot on the icon
  badge?: number;            // count bubble on the icon
  urgent?: boolean;          // badge turns amber
  dot?: boolean;             // small amber warning dot
}

export interface AppDef {
  id: AppId;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** CSS colour for the icon. The rail shows it only on hover and for the current app; lists show it always. */
  tint: string;
  /** Where the app lives. Apps without one (chat, and the modal ones) are opened by App.tsx itself. */
  hash?: string;
  /** Matches location.hash when this app is the one on screen. */
  route?: RegExp;
  /** Section in the All apps launcher. `system` apps live in the gear menu instead of the rail. */
  group: AppGroup;
  /** Extra words the command palette matches on. */
  keywords?: string;
  live?: (s?: Status) => AppLive | undefined;
}

/**
 * Every app in Shell:B, in rail order. The rail, the gear menu, the command palette and App.tsx's routing all read this list,
 * so a new app is one entry here (plus its page in App.tsx).
 */
export const APPS: AppDef[] = [
  { id: 'chat', label: 'Chat', hint: 'Talk to your agents', icon: MessageSquare, tint: 'var(--text-secondary)', group: 'chat' },
  { id: 'studio', label: 'Studio', hint: 'Design projects', icon: Palette, tint: '#fb7185', group: 'make',
    hash: '#/studio', route: /^#\/studio\b/, keywords: 'design projects' },
  { id: 'code', label: 'Code', hint: 'Workspaces with a coding partner', icon: CodeXml, tint: '#38bdf8', group: 'make',
    hash: '#/code', route: /^#\/code(?![\w-])/, keywords: 'coding partner workspaces' },
  { id: 'radio', label: 'Radio / DJ', hint: 'Procedural FM station, dual-deck DJ rig, stem mixer and track forge', icon: Radio, tint: '#ff2e97', group: 'make',
    hash: '#/radio', route: /^#\/(radio|dj|fm)\b/, keywords: 'radio dj fm music synth procedural beats stems mixer synthfield generator turntable',
    live: () => djLive.state.playing ? { label: `Radio · ${djLive.state.song ? `${djLive.state.song.title} (${djLive.state.song.bpm} BPM)` : 'on air'}`, busy: true } : undefined },
  { id: 'generate', label: 'Generate', hint: 'Make images, music and sound effects directly and compare variations', icon: ImagePlus, tint: '#38bdf8', group: 'make',
    hash: '#/generate', route: /^#\/generate\b/, keywords: 'image flux comfyui nyx music musicgen orpheus sound effect sfx stable audio playground seed variations' },
  { id: 'library', label: 'Library', hint: 'Every artifact and web app built in Shell:B', icon: LibraryBig, tint: '#fbbf24', group: 'know',
    hash: '#/library', route: /^#\/library\b/, keywords: 'artifacts web apps' },
  { id: 'maps', label: 'Worlds', hint: 'The solar system, plus offline maps of Earth, the Moon, Mars and other worlds', icon: MapIcon, tint: '#4ade80', group: 'know',
    hash: '#/worlds', route: /^#\/(worlds|maps)\b/, keywords: 'map maps globe earth moon mars planets world atlas solar system sol orrery' },
  { id: 'wiki', label: 'Wiki', hint: 'Offline Wikipedia, Wiktionary and Wikivoyage', icon: BookOpen, tint: '#7dd3fc', group: 'know',
    hash: '#/wiki', route: /^#\/wiki\b/, keywords: 'wikipedia encyclopedia kiwix offline dictionary wiktionary wikivoyage travel' },
  // before Codex: these routes start with #/codex, and the first match wins
  { id: 'me', label: 'Me', hint: 'Everything Shell:B knows about you: a portrait, your facts, your people and what’s coming up', icon: UserRound, tint: '#fb7185', group: 'know',
    hash: '#/codex/me', route: /^#\/codex\/me\b/, keywords: 'profile about me myself portrait people family friends birthdays memory' },
  { id: 'notes', label: 'Notes', hint: 'Write and brainstorm in Markdown; notes are saved to your Codex', icon: NotebookPen, tint: '#fcd34d', group: 'know',
    hash: '#/codex/notes', route: /^#\/codex\/notes\b/, keywords: 'markdown brainstorm ideas write documents' },
  { id: 'codex', label: 'Codex', hint: 'Your long-term reference shelf: notes, links, snippets, files, contacts and calendar', icon: BookMarked, tint: '#818cf8', group: 'know',
    hash: '#/codex', route: /^#\/codex\b/, keywords: 'notes links snippets files secrets contacts people address book calendar events agenda schedule' },
  { id: 'memory', label: 'Memory', hint: 'What Shell:B knows about you, and what it has learned lately', icon: Brain, tint: '#f59e0b', group: 'know',
    keywords: 'remember forget profile about me learn',
    live: s => s?.memoryPending ? { label: `Memory · ${s.memoryPending} to review`, badge: s.memoryPending, urgent: true } : undefined },
  { id: 'research', label: 'Research', hint: 'Sources, findings and syntheses gathered by Minerva', icon: Telescope, tint: '#2dd4bf', group: 'know',
    hash: '#/research', route: /^#\/research\b/, keywords: 'boards sources' },
  { id: 'plans', label: 'Mega plans', hint: 'Big jobs broken into steps that agents carry out one by one', icon: Workflow, tint: '#a78bfa', group: 'run',
    hash: '#/plans', route: /^#\/plans\b/,
    live: s => s?.megaPlan ? { label: 'Mega plans · running', busy: true } : undefined },
  { id: 'assets', label: 'Assets', hint: 'Reusable sounds, textures, sprites, models and fonts', icon: Shapes, tint: '#a3e635', group: 'know',
    hash: '#/assets', route: /^#\/assets\b/, keywords: 'sounds textures sprites fonts',
    live: s => s?.assetJob ? { label: 'Assets · scout running', busy: true } : undefined },
  { id: 'scheduled', label: 'Scheduled', hint: 'Prompts that run on their own at set times', icon: CalendarClock, tint: '#34d399', group: 'run',
    hash: '#/scheduled', route: /^#\/scheduled\b/, keywords: 'cron timer' },
  { id: 'activity', label: 'Activity', hint: 'What ran while you were away, and approvals agents are waiting on', icon: Inbox, tint: '#fb923c', group: 'run',
    hash: '#/activity', route: /^#\/activity\b/, keywords: 'inbox approvals',
    live: s => {
      const a = s?.activity;
      if (!a) return undefined;
      const waiting = a.pending ?? 0;
      return {
        label: waiting ? `Activity · ${waiting} waiting for you` : a.unread ? `Activity · ${a.unread} unread` : undefined,
        badge: waiting + (a.unread ?? 0),
        urgent: waiting > 0 || (a.attention ?? 0) > 0,
      };
    } },
  { id: 'secretary', label: 'Secretary', hint: 'Transcribe meetings with speaker identification and compile summaries', icon: AudioLines, tint: '#38bdf8', group: 'run',
    hash: '#/secretary', route: /^#\/secretary\b/, keywords: 'meeting secretary transcribe audio voice notes minutes speech diarization speakers summary' },
  { id: 'gibberlink', label: 'Gibberlink', hint: 'Send and receive short messages over audio', icon: RadioTower, tint: '#f472b6', group: 'run',
    hash: '#/gibberlink', route: /^#\/gibberlink\b/, keywords: 'audio sound wave agent message' },
  { id: 'models', label: 'Models', hint: 'Download, load and unload models; see what is using memory', icon: Cpu, tint: '#22d3ee', group: 'system',
    hash: '#/models', route: /^#\/models\b/, keywords: 'ollama gpu memory' },
  { id: 'data', label: 'Offline data', hint: 'Downloaded maps and encyclopedias: sizes, versions and update schedules', icon: HardDrive, tint: '#22d3ee', group: 'system',
    hash: '#/data', route: /^#\/data\b/, keywords: 'downloads storage disk updates planet pmtiles zim kiwix',
    live: s => s?.dataJob ? { label: `Offline data · ${s.dataJob.phase === 'verify' ? 'verifying' : `${Math.round((s.dataJob.done / s.dataJob.bytes) * 100)}%`}`, busy: true } : undefined },
  { id: 'agents', label: 'Agent Lab', hint: 'Create and tune your agents', icon: BrainCircuit, tint: 'var(--accent)', group: 'system' },
  { id: 'tools', label: 'Tools & Connectors', hint: 'Tools, MCP servers, skills and cloud models', icon: Boxes, tint: '#38bdf8', group: 'system',
    keywords: 'mcp skills' },
  { id: 'settings', label: 'Settings', hint: 'System status and preferences', icon: Settings, tint: 'var(--text-secondary)', group: 'system',
    keywords: 'preferences',
    live: s => Object.values(s?.services ?? {}).some(v => !v.ok) ? { label: 'Settings · some services are offline', dot: true } : undefined },
];

export const appById = (id: AppId) => APPS.find(a => a.id === id)!;

/** The app on screen for a hash. Anything no app claims (chats, projects) belongs to Chat. */
export const appForHash = (hash: string): AppId => APPS.find(a => a.route?.test(hash))?.id ?? 'chat';

// ── Pins ───────────────────────────────────────────────────────────────────
// Which apps get a rail tile. Per browser (localStorage), shared by the rail, the All apps launcher and the command palette.

const PINS_KEY = 'shellb.rail.pins';
export const PINNABLE = new Set(APPS.filter(a => a.group !== 'chat' && a.group !== 'system').map(a => a.id));
const pinListeners = new Set<() => void>();

function readPins(): AppId[] {
  try {
    if (typeof window !== 'undefined' && /[?&]unpin=radio/.test(window.location.search)) {
      return DEFAULT_PINS.filter(id => id !== 'radio');
    }
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? 'null');
    if (Array.isArray(raw)) return raw.filter((id): id is AppId => PINNABLE.has(id));
  } catch { /* private mode or bad JSON */ }
  return DEFAULT_PINS;
}
let pins = readPins();
if (typeof window !== 'undefined') addEventListener('storage', e => {
  if (e.key !== PINS_KEY && e.key !== null) return;
  pins = readPins();   // pinned or unpinned in another tab
  pinListeners.forEach(f => f());
});

/** Replaces the pin list (null = back to the defaults). Kept in APPS order so the rail order is stable. */
export function setPins(next: AppId[] | null) {
  const want = new Set(next ?? DEFAULT_PINS);
  pins = APPS.map(a => a.id).filter(id => want.has(id) && PINNABLE.has(id));
  try { if (next) localStorage.setItem(PINS_KEY, JSON.stringify(pins)); else localStorage.removeItem(PINS_KEY); } catch { /* private mode */ }
  pinListeners.forEach(f => f());
}
export const togglePin = (id: AppId) => setPins(pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id]);

export function usePins(): AppId[] {
  return useSyncExternalStore(f => { pinListeners.add(f); return () => { pinListeners.delete(f); }; }, () => pins);
}

// ── Rail shortcuts ─────────────────────────────────────────────────────────
// Alt+Shift+1…9 open the rail's tiles in order. Plain Alt+digit is taken: Chrome and Firefox on Linux switch tabs with it,
// and a page can't stop that. The rail publishes what's on it so the palette can show the same numbers.

let railOrder: AppId[] = [];
const railListeners = new Set<() => void>();
export function setRailOrder(next: AppId[]) {
  if (next.join() === railOrder.join()) return;
  railOrder = next;
  railListeners.forEach(f => f());
}
export function useRailOrder(): AppId[] {
  return useSyncExternalStore(f => { railListeners.add(f); return () => { railListeners.delete(f); }; }, () => railOrder);
}
export const shortcutLabel = (i: number) => `Alt+Shift+${i + 1}`;
