/**
 * Rich links: agents "hyperlink" words in a reply to tooltips, live widgets, artifacts and follow-up questions.
 *
 *   [label](tip: short explanation, **markdown** and $math$ allowed)
 *   [label](tip:#key)      + a ```tip key``` fence anywhere in the reply (longer Markdown body)
 *   [label](widget:#key)   + a ```widget key``` fence holding HTML: an interactive control shown in the popover
 *   [label](artifact:id)   hover previews the artifact, click opens it (artifact:id@2 pins a version)
 *   [label](ask: question) click sends the question as the user's next message
 *   [label](button: reply) a real button; click sends the reply (or the label, if empty). Only the latest reply's work
 *   [label](file:path)     opens a project file (Studio), or a /work file in a new tab (chat)
 *
 * The fences are lifted out of the reply before rendering; links are rewritten to `sb:<scheme>:<payload>` so the
 * Markdown parser leaves them alone.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Boxes, CornerDownRight, FileText, Sparkles, Telescope, Workflow } from 'lucide-react';
import type { ArtifactGroup } from '../types';
import { srcDoc } from './ArtifactPanel';
import { localizeCdn } from '../offline';
import { Markdown } from './Markdown';

export type Def = { kind: 'tip' | 'widget'; body: string };

export interface LinkEnv {
  artifacts?: ArtifactGroup[];
  defs?: Record<string, Def>;
  busy?: boolean;
  onOpenArtifact?: (id: string, version?: number) => void;
  onAsk?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  /** an older reply: its action buttons are history, no longer clickable */
  stale?: boolean;
}

export const LinkContext = createContext<LinkEnv>({});

// ── parsing ─────────────────────────────────────────────────────────────────

const DEF_RE = /(^|\n)[ \t]*```(tip|widget)[ \t]+([^\s`]+)[^\n]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g;

/** Lift ```tip key``` / ```widget key``` fences out of a reply. Unclosed fences (mid-stream) are hidden too. */
export function extractDefs(text: string): { body: string; defs: Record<string, Def> } {
  const defs: Record<string, Def> = {};
  const body = text.replace(DEF_RE, (_m, lead: string, kind: 'tip' | 'widget', key: string, content: string) => {
    defs[key.replace(/^#/, '')] = { kind, body: content };
    return lead;
  });
  return { body, defs };
}

const BLOCK_TAGS = 'div|details|section|form|table|svg|canvas|script|style';
const OPEN_RE = new RegExp(`<(${BLOCK_TAGS})\\b(?![^>]*/>)`, 'gi');
const CLOSE_RE = new RegExp(`</(${BLOCK_TAGS})\\s*>`, 'gi');
const HTML_START = /^\s*<(?!https?:|\/\/)[a-z!/]/i;

/** Split a reply into raw-HTML runs (paragraphs starting with a tag, kept together while tags are unbalanced). */
function liftHtml(text: string): { body: string; chunks: string[] } {
  const paras = text.split(/(\n[ \t]*\n)/); // keep separators at odd indexes
  const keep: string[] = [], chunks: string[] = [];
  let run: string[] | null = null, depth = 0, inFence = false;
  for (let i = 0; i < paras.length; i += 2) {
    const p = paras[i], sep = paras[i + 1] ?? '';
    if (!run && (inFence || !HTML_START.test(p))) {
      if (((p.match(/^[ \t]*```/gm) ?? []).length) % 2) inFence = !inFence;
      keep.push(p + sep);
      continue;
    }
    run ??= [];
    run.push(p + sep);
    depth += (p.match(OPEN_RE) ?? []).length - (p.match(CLOSE_RE) ?? []).length;
    const next = paras[i + 2];
    if (depth <= 0 && (next === undefined || !HTML_START.test(next))) { chunks.push(run.join('').trim()); run = null; depth = 0; }
  }
  if (run) chunks.push(run.join('').trim());
  return { body: keep.join(''), chunks };
}

/** Models sometimes link (widget:key) but write the HTML straight into the reply instead of a ```widget``` fence.
 *  Markdown drops raw HTML anyway, so hand those runs to the unresolved widgets, in order. */
export function adoptOrphanHtml(texts: string[], defs: Record<string, Def>): string[] {
  const missing = [...new Set(texts.flatMap(t => [...t.matchAll(/\]\(\s*widget\s*:\s*#?([\w.-]+)\s*\)/gi)].map(m => m[1])))]
    .filter(k => !defs[k]);
  if (!missing.length) return texts;
  return texts.map(t => {
    if (!missing.length) return t;
    const { body, chunks } = liftHtml(t);
    if (!chunks.length) return t;
    // consecutive runs (e.g. markup then its <script>) belong to the same widget when there are more runs than widgets
    while (chunks.length > missing.length && chunks.length > 1) chunks.splice(-2, 2, chunks[chunks.length - 2] + '\n' + chunks[chunks.length - 1]);
    for (const c of chunks) { const k = missing.shift(); if (!k) break; defs[k] = { kind: 'widget', body: c }; }
    return body;
  });
}

const LINK_RE =/\]\(\s*(tip|widget|artifact|ask|button|file|board|plan)\s*:/gi;

/** Rewrite rich links (whose payloads may hold spaces and parentheses) into parser-safe `sb:` URLs. */
export function rewriteLinks(s: string): string {
  let out = '', i = 0, m: RegExpExecArray | null, lastButton = -1;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    let depth = 1, j = m.index + m[0].length, broke = false;
    for (; j < s.length && depth; j++) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '\n' && s[j + 1] === '\n') { broke = true; break; }
    }
    if (broke) continue; // malformed: leave it as written
    let scheme = m[1].toLowerCase();
    // a button right after another one (only its own [label] between them) is an alternative: drawn outlined
    if (scheme === 'button' && lastButton >= 0 && /^\s*\[[^\]]*$/.test(s.slice(lastButton, m.index))) scheme = 'button-alt';
    if (depth) { // still streaming: show the label, finish the link when the payload arrives
      out += s.slice(i, m.index) + '](sb:pending)';
      i = s.length;
      break;
    }
    const payload = s.slice(m.index + m[0].length, j - 1).trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    const enc = encodeURIComponent(payload).replace(/[()'!*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    out += s.slice(i, m.index) + `](sb:${scheme}:${enc})`;
    lastButton = scheme.startsWith('button') ? j : -1;
    i = j;
    LINK_RE.lastIndex = j;
  }
  return out + s.slice(i);
}

/** Text for copy / read-aloud: rich links become their labels, definition fences disappear. */
export function plainText(text: string): string {
  return rewriteLinks(extractDefs(text).body).replace(/\[([^\]]*)\]\(sb:[^)]*\)/g, '$1');
}

function findArtifact(groups: ArtifactGroup[] | undefined, ref: string) {
  if (!groups?.length) return undefined;
  const [raw, ver] = ref.split('@');
  const key = raw.trim().replace(/^#/, '').toLowerCase();
  const slug = key.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const g = groups.find(x => x.id === key) ?? groups.find(x => x.id === slug) ?? groups.find(x => x.title.toLowerCase() === key);
  if (!g) return undefined;
  const version = ver ? Number(ver.replace(/^v/i, '')) || undefined : undefined;
  const v = g.versions.find(x => x.version === version) ?? g.versions[g.versions.length - 1];
  return { group: g, version: v };
}

const isDark = () => !document.documentElement.classList.contains('light');

// ── popover ─────────────────────────────────────────────────────────────────

function useHoverCard() {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const enter = useCallback((delay = 140) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), delay); }, []);
  const leave = useCallback(() => { clearTimeout(timer.current); timer.current = window.setTimeout(() => { setOpen(false); setPinned(false); }, 220); }, []);
  const close = useCallback(() => { clearTimeout(timer.current); setOpen(false); setPinned(false); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { anchor, open, pinned, setPinned, setOpen, enter, leave, close };
}

type Card = ReturnType<typeof useHoverCard>;

function Popover({ card, width = 340, children }: { card: Card; width?: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!card.open) { setPos(null); return; }
    const place = () => {
      const a = card.anchor.current?.getBoundingClientRect();
      if (!a) return;
      const h = box.current?.offsetHeight ?? 160;
      const w = Math.min(width, window.innerWidth - 24);
      const above = a.bottom + 8 + h > window.innerHeight - 8 && a.top - 8 - h > 8;
      const left = Math.max(12, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 12));
      setPos({ left, top: above ? a.top - 8 - h : a.bottom + 8, above });
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [card.open, card.anchor, width]);

  useEffect(() => {
    if (!card.pinned) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !card.anchor.current?.contains(t)) card.close();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') card.close(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [card.pinned, card]);

  if (!card.open) return null;
  return createPortal(
    <div
      ref={box} role="tooltip"
      onPointerEnter={e => e.pointerType === 'mouse' && card.enter(0)}
      onPointerLeave={e => e.pointerType === 'mouse' && !card.pinned && card.leave()}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: Math.min(width, window.innerWidth - 24), visibility: pos ? 'visible' : 'hidden' }}
      className={clsx('fixed z-[60] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl text-left overflow-hidden',
        'animate-fade-in', card.pinned && 'border-[color:var(--accent)]')}
    >
      {children}
    </div>,
    document.body,
  );
}

function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  return ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--border-subtle', '--border-strong', '--text-primary',
    '--text-secondary', '--text-muted', '--accent', '--accent-soft'].map(v => `${v}:${cs.getPropertyValue(v).trim()}`).join(';');
}

/** An agent-written HTML control in a sandboxed iframe that sizes itself to its content. */
function WidgetFrame({ html, onAsk }: { html: string; onAsk?: (t: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== 'object') return;
      if (e.data.sb === 'h') setH(Math.min(480, Math.max(40, Number(e.data.h) || 0)));
      // only act on asks that follow a real interaction with this widget, never on load
      if (e.data.sb === 'ask' && onAsk && document.activeElement === frame.current && typeof e.data.text === 'string') onAsk(e.data.text.slice(0, 4000));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onAsk]);
  const head = `<base href="${location.origin}/"><meta charset="utf-8"><style>:root{${themeVars()}}
    html,body{margin:0;background:transparent;color:var(--text-primary);font:13px/1.5 'Inter Variable',Inter,system-ui,sans-serif;color-scheme:${isDark() ? 'dark' : 'light'}}
    body{padding:12px}button,input,select,textarea{font:inherit}</style>
    <script>window.shellb={ask:function(t){parent.postMessage({sb:'ask',text:String(t)},'*')}};
    addEventListener('DOMContentLoaded',function(){var r=function(){parent.postMessage({sb:'h',h:document.documentElement.scrollHeight},'*')};
    new ResizeObserver(r).observe(document.body);r()});</script>`;
  const local = localizeCdn(html);
  const doc = /<head[^>]*>/i.test(local) ? local.replace(/<head([^>]*)>/i, `<head$1>${head}`) : `<!doctype html><html><head>${head}</head><body>${local}</body></html>`;
  return <iframe ref={frame} title="widget" srcDoc={doc} sandbox="allow-scripts" style={{ height: h }} className="w-full block border-0 bg-transparent" />;
}

function ArtifactPeek({ hit }: { hit: NonNullable<ReturnType<typeof findArtifact>> }) {
  const v = hit.version;
  const visual = v.type === 'html' || v.type === 'svg' || v.type === 'mermaid';
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
        <Boxes className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
        <span className="text-xs font-semibold truncate flex-1">{v.title}</span>
        <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">{v.type} · v{v.version}</span>
      </div>
      {visual ? (
        <div className="relative h-[180px] overflow-hidden bg-white pointer-events-none">
          <iframe title={v.title} srcDoc={srcDoc(v.type, v.content, isDark())} sandbox="allow-scripts" tabIndex={-1}
            className="absolute top-0 left-0 border-0 origin-top-left" style={{ width: '200%', height: 360, transform: 'scale(0.5)' }} />
        </div>
      ) : (
        <pre className="max-h-[180px] overflow-hidden px-3 py-2 text-[11px] leading-snug font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
          {v.content.split('\n').slice(0, 12).join('\n')}
        </pre>
      )}
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] border-t border-[var(--border-subtle)]">Click to open in the artifact panel</div>
    </>
  );
}

// ── the link ────────────────────────────────────────────────────────────────

function plainLabel(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(plainLabel).join('');
  if (n && typeof n === 'object' && 'props' in n) return plainLabel((n as { props: { children?: ReactNode } }).props.children);
  return '';
}

const termCls = 'cursor-help text-inherit underline decoration-dotted decoration-[var(--accent)] decoration-[1.5px] underline-offset-[3px] hover:bg-[var(--accent)]/10 rounded-sm transition';

export function RichLink({ href, children }: { href: string; children: ReactNode }) {
  const env = useContext(LinkContext);
  const card = useHoverCard();
  const [, scheme, ...rest] = href.split(':');
  const payload = (() => { try { return decodeURIComponent(rest.join(':')); } catch { return rest.join(':'); } })();

  const hoverProps = {
    ref: (el: HTMLElement | null) => { card.anchor.current = el; },
    'data-richlink': scheme,
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === 'mouse' && card.enter(),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === 'mouse' && !card.pinned && card.leave(),
    onFocus: () => card.enter(0),
    onBlur: () => !card.pinned && card.leave(),
  };

  if (scheme === 'pending') return <span className={termCls}>{children}</span>;

  if (scheme === 'ask') {
    return (
      <button type="button" disabled={env.busy || !env.onAsk} title={`Ask: ${payload}`} onClick={() => env.onAsk?.(payload || String(children))}
        className="inline-flex items-baseline gap-1 px-1.5 -my-px rounded-md border border-[var(--accent)]/35 bg-[var(--accent)]/10 text-[var(--accent-soft)] hover:bg-[var(--accent)]/20 disabled:opacity-50 disabled:cursor-default transition">
        <CornerDownRight className="w-3 h-3 self-center shrink-0" />{children}
      </button>
    );
  }

  if (scheme === 'button' || scheme === 'button-alt') {  // an action button: one click answers the reply that offered it
    const off = env.busy || env.stale || !env.onAsk;
    return (
      <button type="button" disabled={off} title={env.stale ? undefined : `Send: ${payload || String(children)}`}
        onClick={() => env.onAsk?.(payload || plainLabel(children))}
        className={clsx('inline-flex items-center justify-center my-1 mr-2 px-4 py-1.5 rounded-lg text-sm font-semibold no-underline border active:scale-[0.98] transition disabled:bg-[var(--bg-tertiary)] disabled:border-[var(--border-subtle)] disabled:text-[var(--text-muted)] disabled:shadow-none disabled:cursor-default',
          // (the Synthwave and Synthfield themes paint anything whose class names bg-[var(--accent)] with its gradient, so only an
          // enabled primary button may carry it)
          off ? '' : scheme === 'button' ? 'bg-[var(--accent)] border-transparent text-[var(--accent-fg)] shadow-sm hover:brightness-110'
            : 'bg-transparent border-[var(--accent)]/60 text-[var(--accent-soft)] hover:bg-[var(--bg-hover)]')}>
        {children}
      </button>
    );
  }

  if (scheme === 'board') {  // a research board: opens its page
    return (
      <a href={`#/research/${encodeURIComponent(payload)}`}
        className="inline-flex items-baseline gap-1 text-teal-600 dark:text-teal-300 underline decoration-teal-500/40 underline-offset-2 hover:decoration-current">
        <Telescope className="w-3 h-3 self-center shrink-0" />{children}
      </a>
    );
  }

  if (scheme === 'plan') {  // a mega plan: opens its board
    return (
      <a href={`#/plans/${encodeURIComponent(payload)}`}
        className="inline-flex items-baseline gap-1 text-violet-600 dark:text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:decoration-current">
        <Workflow className="w-3 h-3 self-center shrink-0" />{children}
      </a>
    );
  }

  if (scheme === 'file') {
    return (
      <button type="button" disabled={!env.onOpenFile} onClick={() => env.onOpenFile?.(payload)} title={payload}
        className="inline-flex items-baseline gap-1 font-mono text-[0.85em] px-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] disabled:cursor-default">
        <FileText className="w-3 h-3 self-center text-[var(--accent)]" />{children}
      </button>
    );
  }

  if (scheme === 'artifact') {
    const hit = findArtifact(env.artifacts, payload);
    if (!hit) return <span className="text-[var(--accent-soft)]" title={`Artifact "${payload}" isn't in this conversation`}>{children}</span>;
    return (
      <>
        <button type="button" {...hoverProps} onClick={() => { card.close(); env.onOpenArtifact?.(hit.group.id, hit.version.version); }}
          className="inline-flex items-baseline gap-1 text-[var(--accent-soft)] underline decoration-[var(--accent)]/40 underline-offset-2 hover:decoration-current">
          <Boxes className="w-3 h-3 self-center shrink-0" />{children}
        </button>
        <Popover card={card} width={340}><ArtifactPeek hit={hit} /></Popover>
      </>
    );
  }

  // tip / widget
  // models often drop the '#': a bare single-token payload names a definition when one exists (always, for widgets)
  const bare = /^[\w.-]+$/.test(payload) && (scheme === 'widget' || !!env.defs?.[payload]);
  const ref = payload.startsWith('#') ? payload.slice(1) : bare ? payload : '';
  const def = ref ? env.defs?.[ref] : undefined;
  const kind = def?.kind ?? (scheme === 'widget' ? 'widget' : 'tip');
  const body = ref ? def?.body ?? '' : payload;
  if (!body.trim()) return <span className={termCls}>{children}</span>; // definition not streamed in yet

  return (
    <>
      <span role="button" tabIndex={0} {...hoverProps} aria-expanded={card.open}
        onClick={() => { if (card.pinned) card.close(); else { card.setPinned(true); card.setOpen(true); } }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.setPinned(!card.pinned); card.setOpen(!card.pinned); } }}
        className={termCls}>
        {children}{kind === 'widget' && <Sparkles className="inline w-2.5 h-2.5 ml-0.5 -mt-2 text-[var(--accent)]" />}
      </span>
      <Popover card={card} width={kind === 'widget' ? 380 : 320}>
        {kind === 'widget' ? (
          <WidgetFrame html={body} onAsk={env.onAsk && !env.busy ? (t => { card.close(); env.onAsk!(t); }) : undefined} />
        ) : (
          <div className="px-3.5 py-2.5 max-h-[50vh] overflow-y-auto">
            <Markdown text={body} className="text-[13px] leading-relaxed [&_p]:my-0" />
          </div>
        )}
      </Popover>
    </>
  );
}
