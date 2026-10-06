import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import {
  AppWindow, AtSign, BookOpen, Brain, Calendar, Clipboard, Clock, Code2, EyeOff, FileText, FlaskConical, FolderKanban, Globe, Hash,
  Image as ImageIcon, Library, ListChecks, MessageSquarePlus, Music, Search, Sparkles, Terminal, UserRound, Variable, Wand2, Zap,
} from 'lucide-react';
import type { Agent, Attachment, Effort } from '../types';
import { composerApi, type ComposerCatalog, type ComposerRef } from '../composerApi';
import { AgentAvatar } from './common';

/**
 * Composer shortcuts. Typing a trigger opens a menu above the message box:
 *   /  at the start of a message: built-in actions (/new, /effort deep, /agent X), tool nudges (/image, /search…),
 *      skills and saved prompt templates. Templates can hold {{blanks}}; Tab jumps to the next one.
 *   @  anywhere: an agent. Sending a message that mentions one answers this turn as that agent.
 *   #  anywhere: a text variable (#date, #clipboard, saved ones) or a context reference (an artifact, a library item,
 *      a URL), which becomes a chip and is inlined for the agent by the server (server/composer.py).
 */

export type ComposerCommand = 'new' | 'incognito';

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

interface Token { trig: '/' | '@' | '#'; query: string; start: number; end: number }

const EFFORT_ITEMS: { id: Effort; word: string; hint: string }[] = [
  { id: 'off', word: 'instant', hint: 'No deliberation' },
  { id: 'low', word: 'low', hint: 'Quick answers' },
  { id: 'medium', word: 'think', hint: 'Reason before answering' },
  { id: 'high', word: 'deep', hint: 'Reason carefully and double-check' },
];

const TOOL_ICONS: Record<string, ReactNode> = {
  image: <ImageIcon className="w-3.5 h-3.5" />, music: <Music className="w-3.5 h-3.5" />, search: <Search className="w-3.5 h-3.5" />,
  fetch: <Globe className="w-3.5 h-3.5" />, run: <Terminal className="w-3.5 h-3.5" />, artifact: <AppWindow className="w-3.5 h-3.5" />,
  remember: <Brain className="w-3.5 h-3.5" />, recall: <Brain className="w-3.5 h-3.5" />, library: <Library className="w-3.5 h-3.5" />,
};

const REF_ICONS: Record<string, ReactNode> = {
  artifact: <AppWindow className="w-3.5 h-3.5" />, studio: <Wand2 className="w-3.5 h-3.5" />, code: <Code2 className="w-3.5 h-3.5" />,
  research: <FlaskConical className="w-3.5 h-3.5" />, 'chat-project': <FolderKanban className="w-3.5 h-3.5" />,
  media: <ImageIcon className="w-3.5 h-3.5" />, url: <Globe className="w-3.5 h-3.5" />,
};
export const refIcon = (kind?: string) => REF_ICONS[kind ?? ''] ?? <Hash className="w-3.5 h-3.5" />;

/** Built-in #variables; `clipboard` is async and needs the browser's permission. */
function builtinVars(agent: Agent): { name: string; hint: string; icon: ReactNode; value: () => string | Promise<string> }[] {
  const now = () => new Date();
  return [
    { name: 'date', hint: 'Today’s date', icon: <Calendar className="w-3.5 h-3.5" />, value: () => now().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) },
    { name: 'time', hint: 'The time now', icon: <Clock className="w-3.5 h-3.5" />, value: () => now().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) },
    { name: 'now', hint: 'Date and time', icon: <Clock className="w-3.5 h-3.5" />, value: () => now().toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }) },
    { name: 'weekday', hint: 'Day of the week', icon: <Calendar className="w-3.5 h-3.5" />, value: () => now().toLocaleDateString(undefined, { weekday: 'long' }) },
    { name: 'clipboard', hint: 'What you last copied', icon: <Clipboard className="w-3.5 h-3.5" />, value: readClipboard },
    { name: 'agent', hint: 'The agent’s name', icon: <UserRound className="w-3.5 h-3.5" />, value: () => agent.name },
  ];
}

async function readClipboard() {
  if (!window.isSecureContext || !navigator.clipboard?.readText) throw new Error('Reading the clipboard needs HTTPS (open Shell:B through the Tailscale URL)');
  return navigator.clipboard.readText();
}

/** Fills {{date}}, {{clipboard}}… in a prompt template; other {{blanks}} stay for the user. */
async function fillTemplate(t: string, agent: Agent) {
  const vars = builtinVars(agent);
  let out = t;
  for (const v of vars) {
    const re = new RegExp(`\\{\\{\\s*${v.name}\\s*\\}\\}`, 'gi');
    if (re.test(out)) out = out.replace(re, await Promise.resolve(v.value()).catch(() => `{{${v.name}}}`));
  }
  return out;
}

/** Expands typed #variables (built-in and saved) when a message is sent; unknown #words are left as they are. */
export async function expandVariables(text: string, catalog: ComposerCatalog | null, agent: Agent) {
  if (!text.includes('#')) return text;
  const saved = new Map((catalog?.variables ?? []).map(v => [v.name, v.value]));
  const builtin = new Map(builtinVars(agent).map(v => [v.name, v.value]));
  const re = /(^|[\s(["'])#([a-z0-9][\w-]*)(?![\w-])/gi;
  const values = new Map<string, string>();
  for (const m of text.matchAll(re)) {
    const name = m[2].toLowerCase();
    if (values.has(name)) continue;
    if (saved.has(name)) values.set(name, saved.get(name)!);
    else if (builtin.has(name)) values.set(name, await Promise.resolve(builtin.get(name)!()).catch(() => `#${name}`));
  }
  return text.replace(re, (all, pre: string, name: string) => (values.has(name.toLowerCase()) ? pre + values.get(name.toLowerCase()) : all));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first agent @mentioned in the text (by its name or id), if any. */
export function findMention(text: string, agents: Agent[]): Agent | undefined {
  let best: { at: number; agent: Agent } | undefined;
  for (const a of agents) {
    for (const n of [a.name, a.id]) {
      const m = new RegExp(`(^|\\s)@${escapeRe(n)}(?=$|[\\s,.:;!?)])`, 'i').exec(text);
      if (m && (!best || m.index < best.at)) best = { at: m.index, agent: a };
    }
  }
  return best?.agent;
}

function tokenAt(text: string, caret: number): Token | null {
  const m = /(^|\s)([#@/])(\S*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const start = m.index + m[1].length;
  const trig = m[2] as Token['trig'];
  if (trig === '/' && start !== 0) return null; // commands only at the very start, so paths and fractions don't pop menus
  return { trig, query: m[3], start, end: caret };
}

const match = (q: string, ...fields: (string | undefined)[]) => !q || fields.some(f => f?.toLowerCase().includes(q.toLowerCase()));

interface Opts {
  text: string;
  setText: (t: string) => void;
  ta: RefObject<HTMLTextAreaElement | null>;
  agent: Agent;
  agents: Agent[];
  convId?: string;
  onEffort: (e: Effort) => void;
  onAgent: (a: Agent) => void;
  onCommand?: (c: ComposerCommand) => void;
  planMode?: boolean;
  onPlanMode?: (on: boolean) => void;
  addRef: (att: Attachment) => void;
  onError: (msg: string) => void;
}

export function useShortcuts(o: Opts) {
  const [catalog, setCatalog] = useState<ComposerCatalog | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [refs, setRefs] = useState<ComposerRef[]>([]);
  const optsRef = useRef(o);
  optsRef.current = o;

  const token = useMemo(() => tokenAt(o.text, caret), [o.text, caret]);
  const tokenKey = token ? `${token.trig}${token.start}` : null;
  const open = !!token && tokenKey !== dismissed;
  // cached; Settings → Shortcuts drops the cache, so a menu opened after an edit sees it
  useEffect(() => { composerApi.catalog().then(setCatalog).catch(() => {}); }, [open]);

  // # searches the library (debounced); this chat's artifacts come first
  useEffect(() => {
    if (!open || token?.trig !== '#') return;
    const t = setTimeout(() => { composerApi.refs(token.query, o.convId).then(setRefs).catch(() => setRefs([])); }, 150);
    return () => clearTimeout(t);
  }, [open, token?.trig, token?.query, o.convId]);

  useEffect(() => { setActive(0); }, [token?.trig, token?.query]);

  /** Puts `insert` where the token is and the caret after it; `select` highlights a range of the result instead. */
  const replaceToken = (insert: string, select?: [number, number]) => {
    const { text, setText, ta } = optsRef.current;
    if (!token) return;
    const next = text.slice(0, token.start) + insert + text.slice(token.end);
    setText(next);
    const [a, b] = select ?? [token.start + insert.length, token.start + insert.length];
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(a, b); setCaret(b); });
  };

  const items: Item[] = useMemo(() => {
    if (!open || !token) return [];
    const q = token.query;
    const { agent, agents } = o;
    const out: Item[] = [];
    if (token.trig === '/') {
      if (o.onCommand && match(q, 'new', 'clear')) {
        out.push({ key: 'new', group: 'Actions', label: '/new', hint: 'Start a new chat', icon: <MessageSquarePlus className="w-3.5 h-3.5" />,
          run: () => { replaceToken(''); o.onCommand?.('new'); } });
      }
      if (o.onCommand && match(q, 'incognito', 'private')) {
        out.push({ key: 'incognito', group: 'Actions', label: '/incognito', hint: 'New chat that isn’t remembered and is deleted after 24 h',
          icon: <EyeOff className="w-3.5 h-3.5" />, run: () => { replaceToken(''); o.onCommand?.('incognito'); } });
      }
      if (o.onPlanMode && match(q, 'plan')) {
        out.push({ key: 'plan', group: 'Actions', label: '/plan', icon: <ListChecks className="w-3.5 h-3.5" />,
          hint: o.planMode ? 'Turn plan mode off' : 'Plan first: research read-only, then propose a plan to approve (Shift+Tab)',
          run: () => { replaceToken(''); o.onPlanMode?.(!o.planMode); } });
      }
      for (const e of EFFORT_ITEMS) {
        if (match(q, `effort ${e.word}`, e.word)) out.push({ key: `effort-${e.id}`, group: 'Actions', label: `/effort ${e.word}`, hint: e.hint,
          icon: <Brain className="w-3.5 h-3.5" />, run: () => { replaceToken(''); o.onEffort(e.id); } });
      }
      for (const a of agents) {
        if (a.id !== agent.id && match(q, `agent ${a.name}`, a.id)) out.push({ key: `agent-${a.id}`, group: 'Actions', label: `/agent ${a.name}`,
          hint: `Switch this chat to ${a.name}`, icon: <AgentAvatar agent={a} size={14} />, run: () => { replaceToken(''); o.onAgent(a); } });
      }
      for (const c of catalog?.toolCommands ?? []) {
        if (match(q, c.name, c.description)) out.push({ key: `tool-${c.name}`, group: 'Tools', label: `/${c.name}`, hint: c.description,
          icon: TOOL_ICONS[c.name] ?? <Zap className="w-3.5 h-3.5" />, run: () => replaceToken(`/${c.name} `) });
      }
      for (const p of catalog?.prompts ?? []) {
        if (match(q, p.name, p.title, p.description)) out.push({ key: `prompt-${p.name}`, group: 'Saved prompts', label: `/${p.name}`,
          hint: p.title || p.description || p.content.slice(0, 80), icon: <FileText className="w-3.5 h-3.5" />,
          run: async () => {
            const body = await fillTemplate(p.content, agent);
            const blank = /\{\{[^}]*\}\}/.exec(body);
            const s = token.start;
            replaceToken(body, blank ? [s + blank.index, s + blank.index + blank[0].length] : undefined);
          } });
      }
      for (const s of catalog?.skills ?? []) {
        if (match(q, s.name, s.description)) out.push({ key: `skill-${s.name}`, group: 'Skills', label: `/${s.name}`, hint: s.description,
          icon: <BookOpen className="w-3.5 h-3.5" />, run: () => replaceToken(`/${s.name} `) });
      }
    } else if (token.trig === '@') {
      for (const a of agents) {
        if (match(q, a.name, a.id, a.title)) out.push({ key: `at-${a.id}`, group: 'Ask an agent (this message only)', label: `@${a.name}`,
          hint: a.unavailable || a.title, icon: <AgentAvatar agent={a} size={14} />, run: () => replaceToken(`@${a.name} `) });
      }
    } else {
      if (/^https?:\/\/\S+\.\S+/i.test(q)) {
        out.push({ key: 'url', group: 'Reference', label: q.replace(/^https?:\/\//, '').slice(0, 60), hint: 'Read this page into the message',
          icon: <Globe className="w-3.5 h-3.5" />, run: () => { replaceToken(''); o.addRef(refAttachment(q, q, 'url')); } });
      }
      for (const v of builtinVars(agent)) {
        if (match(q, v.name)) out.push({ key: `var-${v.name}`, group: 'Variables', label: `#${v.name}`, hint: v.hint, icon: v.icon,
          run: async () => {
            try { replaceToken(await v.value()); } catch (e) { o.onError(e instanceof Error ? e.message : String(e)); }
          } });
      }
      for (const v of catalog?.variables ?? []) {
        if (match(q, v.name, v.description)) out.push({ key: `uvar-${v.name}`, group: 'Variables', label: `#${v.name}`,
          hint: v.description || v.value.slice(0, 80), icon: <Variable className="w-3.5 h-3.5" />, run: () => replaceToken(v.value) });
      }
      for (const r of refs.slice(0, 20)) {
        out.push({ key: `ref-${r.ref}`, group: r.here ? 'This chat' : 'Library', label: r.title, hint: `${r.kind} · ${r.sub}`,
          icon: refIcon(r.kind), run: () => { replaceToken(''); o.addRef(refAttachment(r.ref, r.title, r.kind)); } });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token, catalog, refs, o.agent, o.agents, o.planMode]);

  const pick = (i: number) => {
    const it = items[i];
    if (it) void it.run();
  };

  /** Call first from the textarea's onKeyDown; returns true when the menu (or a {{blank}} jump) used the key. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + items.length) % items.length); return true; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(active); return true; }
    }
    if (open && e.key === 'Escape') { e.preventDefault(); setDismissed(tokenKey); return true; }
    if (e.key === 'Tab' && !e.shiftKey && o.text.includes('{{')) {
      // jump to the next {{blank}} of a prompt template
      const el = e.currentTarget;
      const re = /\{\{[^}]*\}\}/g;
      const all = [...o.text.matchAll(re)];
      const next = all.find(m => m.index! >= el.selectionEnd) ?? all[0];
      if (next) { e.preventDefault(); el.setSelectionRange(next.index!, next.index! + next[0].length); return true; }
    }
    return false;
  };

  const syncCaret = () => { const el = o.ta.current; if (el) setCaret(el.selectionEnd); };

  return { catalog, open: open && items.length > 0, items, active, setActive, pick, onKeyDown, syncCaret, trig: token?.trig };
}

function refAttachment(ref: string, title: string, kind: string): Attachment {
  return { id: `ref-${Math.random().toString(36).slice(2)}`, kind: 'ref', name: title, size: 0, type: kind, url: '', ref, refKind: kind };
}

export function ShortcutMenu({ items, active, onHover, onPick, trig }: {
  items: Item[]; active: number; onHover: (i: number) => void; onPick: (i: number) => void; trig?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  let last = '';
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl z-40 animate-fade-in overflow-hidden">
      <div ref={list} className="max-h-72 overflow-y-auto p-1" role="listbox">
        {items.map((it, i) => {
          const head = it.group !== last ? it.group : null;
          last = it.group;
          return (
            <div key={it.key}>
              {head && <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{head}</div>}
              <button data-i={i} role="option" aria-selected={i === active}
                onMouseDown={e => { e.preventDefault(); onPick(i); }} onMouseEnter={() => onHover(i)}
                className={clsx('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs', i === active ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]')}>
                <span className="w-4 flex justify-center shrink-0 text-[var(--text-muted)]">{it.icon}</span>
                <span className="font-medium shrink-0 max-w-[50%] truncate">{it.label}</span>
                {it.hint && <span className="text-[var(--text-muted)] truncate">{it.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 px-2.5 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
        <span>↑↓ choose · Enter or Tab pick · Esc close</span>
        <span className="ml-auto flex items-center gap-1">
          {trig === '@' ? <><AtSign className="w-3 h-3" />answers this message only</>
            : <><Sparkles className="w-3 h-3" />Your own in Settings → Shortcuts</>}
        </span>
      </div>
    </div>
  );
}
