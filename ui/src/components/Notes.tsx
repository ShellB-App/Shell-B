import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, BookMarked, Check, ChevronDown, Columns2, Eye, FilePlus2, Link2, Loader2, MessageSquarePlus, PenLine, Pin, Plus, Search, StickyNote, Trash2, X } from 'lucide-react';
import { api, req } from '../api';
import type { CodexEntry, CodexIndex } from '../types';
import { Markdown } from './Markdown';
import { TagInput } from './Codex';
import { btn, relTime } from './common';
import { toastError } from './toast';

/**
 * Notes: a writing-first view of the Codex's notes, at #/codex/notes(/<entry id>). Same entries as the Codex page, so
 * agents still find them with the `codex` tool; this page only adds a note list beside a full-height Markdown editor
 * that saves as you type.
 */

type ViewMode = 'write' | 'split' | 'preview';
const VIEW_KEY = 'shellb.notes.view';
const SAVE_AFTER = 800;

function readView(): ViewMode {
  try { const v = localStorage.getItem(VIEW_KEY); if (v === 'write' || v === 'split' || v === 'preview') return v; } catch { /* private mode */ }
  return 'split';
}

/** A title from the first line that says something, for notes whose title you never typed. */
const deriveTitle = (body: string) => {
  const line = body.split('\n').map(l => l.replace(/^\s*(#+|[-*+]|\d+[.)]|>)\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()).find(Boolean) ?? '';
  return line.replace(/[*_`]+/g, '').slice(0, 80) || 'Untitled';
};

const setNoteHash = (id?: string) => history.replaceState(null, '', id ? `#/codex/notes/${id}` : '#/codex/notes');

// ── wiki links ──────────────────────────────────────────────────────────────
// [[Title]] and [[Title|shown text]] link to the note with that title (ignoring case); code doesn't count. In the
// preview they become ordinary links to #/codex/notes/t/<title>, or …/new/<title> when no such note exists yet, so a
// middle-click opens them in a new tab too. The server's matching rules are in codex.py (WIKI, wiki_targets).

export interface NoteTitle { id: string; title: string }
interface Backlink { id: string; title: string; line: string; updatedAt: number }
export interface RelinkResult { from: string; to: string; updated: { id: string; title: string }[]; skipped?: string }
const RELINK_AFTER = 6000;

const WIKI = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;
const unwiki = (s: string) => s.replace(WIKI, (_, t: string, alias?: string) => (alias?.trim() || t.trim()));
const NOTE_LINK = /^#\/codex\/notes\/(t|new)\/(.+)$/;
const noteHref = (title: string, exists: boolean) =>
  `#/codex/notes/${exists ? 't' : 'new'}/${encodeURIComponent(title).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

function linkify(body: string, known: Set<string>): string {
  return body.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(WIKI, (_, t: string, alias?: string) => {
    const target = t.trim();
    return `[${(alias?.trim() || target).replace(/[\\\]]/g, '\\$&')}](${noteHref(target, known.has(target.toLowerCase()))})`;
  }))).join('');
}

// links to notes that don't exist yet look unfinished until you click one, which creates it
const NOTES_CSS = `.notes-preview a[href^="#/codex/notes/new/"] { opacity: .65; text-decoration-style: dashed; }`;

/** Where the caret is inside a textarea, in px from its top-left (a hidden copy of the text measures it). */
function caretXY(el: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize', 'paddingTop', 'paddingLeft'] as const) div.style[k] = cs[k];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'content-box',
    width: `${el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`, top: '0', left: '-9999px' });
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  div.appendChild(mark);
  document.body.appendChild(div);
  const xy = { x: mark.offsetLeft, y: mark.offsetTop + mark.offsetHeight - el.scrollTop };
  div.remove();
  return xy;
}

// ── Markdown keys ───────────────────────────────────────────────────────────
// Enter continues a list (bullets, numbers, checkboxes) and ends it on an empty item; Tab and Shift+Tab indent and
// outdent the selected lines. Text goes in through execCommand so Ctrl+Z still undoes it.

const LIST = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

function insert(el: HTMLTextAreaElement, from: number, to: number, text: string) {
  el.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, text)) el.setRangeText(text, from, to, 'end');
}

function onMarkdownKey(ev: React.KeyboardEvent<HTMLTextAreaElement>) {
  const el = ev.currentTarget;
  const { selectionStart: s, selectionEnd: e, value } = el;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.nativeEvent.isComposing && s === e) {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, s);
    const m = LIST.exec(line);
    if (!m) return;
    ev.preventDefault();
    if (line.length === m[0].length) { insert(el, lineStart, s, ''); return; }   // empty item: end the list
    const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    insert(el, s, e, `\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`);
  } else if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const multi = value.slice(s, e).includes('\n');
    if (!multi && !ev.shiftKey && !LIST.test(value.slice(lineStart))) { ev.preventDefault(); insert(el, s, e, '  '); return; }
    ev.preventDefault();
    const lineEnd = (() => { const i = value.indexOf('\n', Math.max(e - (e > s && value[e - 1] === '\n' ? 1 : 0), s)); return i < 0 ? value.length : i; })();
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const changed = lines.map(l => (ev.shiftKey ? l.replace(/^( {1,2}|\t)/, '') : `  ${l}`));
    const text = changed.join('\n');
    if (text === lines.join('\n')) return;
    insert(el, lineStart, lineEnd, text);
    if (multi) el.setSelectionRange(lineStart, lineStart + text.length);
    else { const p = Math.max(lineStart, s + changed[0].length - lines[0].length); el.setSelectionRange(p, p); }
  }
}

// ── editor ──────────────────────────────────────────────────────────────────

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

function NoteEditor({ id, index, titles, view, onView, onSaved, onDeleted, onBack, onOpen, onOpenTitle, onRelinked, onDiscuss }: {
  id: string | null; index: CodexIndex | null; titles: NoteTitle[]; view: ViewMode; onView: (v: ViewMode) => void;
  onSaved: (e: CodexEntry) => void; onDeleted: (id: string) => void; onBack: () => void;
  onOpen: (id: string) => void; onOpenTitle: (title: string) => void;
  onRelinked: (r: RelinkResult) => void;
  onDiscuss?: (prompt: string, note: File) => Promise<void>;
}) {
  const [entry, setEntry] = useState<CodexEntry | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [title, setTitle] = useState('');
  const [autoTitle, setAutoTitle] = useState(true);
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState('');
  const [discuss, setDiscuss] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  const [showBacklinks, setShowBacklinks] = useState(true);
  // the [[ autocomplete: where the partial title starts, what it says so far, the highlighted row, and where to draw it
  const [ac, setAc] = useState<{ start: number; query: string; sel: number; x: number; y: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // what the server has, and what to send next; refs so the unmount flush sees the latest
  const cur = useRef({ id, title: '', body: '', tags: [] as string[] });
  const saved = useRef({ title: '', body: '', tags: '[]' });
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The title other notes' [[links]] use. A rename is carried over to them once it settles (leaving the title box,
  // switching notes, closing the tab, or RELINK_AFTER without edits), not on every autosave: a title taken from the
  // first line changes with each keystroke, and its in-between values could match some other note's links.
  const linked = useRef<string | null>(null);
  const relinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!id) { requestAnimationFrame(() => area.current?.focus()); return; }
    api.codexEntry(id).then(e => {
      const b = e.body ?? '';
      const auto = !e.title || e.title === 'Untitled' || e.title === deriveTitle(b);
      setEntry(e); setBody(b); setTags(e.tags); setAutoTitle(auto); setTitle(auto ? '' : e.title);
      cur.current = { id, title: e.title, body: b, tags: e.tags };
      saved.current = { title: e.title, body: b, tags: JSON.stringify(e.tags) };
      linked.current = e.title;
      setLoading(false);
      requestAnimationFrame(() => { if (view !== 'preview') area.current?.focus(); });
    }).catch(ex => { setError(String(ex)); setLoading(false); });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps -- once: a new note gets its id later without reloading

  const save = useCallback(async (opts?: { keepalive?: boolean }) => {
    clearTimeout(timer.current);
    if (inflight.current) await inflight.current;   // a create must land before the next save knows the id
    const c = cur.current, s = saved.current;
    const patch: Record<string, unknown> = {};
    if (c.title !== s.title) patch.title = c.title;
    if (c.body !== s.body) patch.body = c.body;
    if (JSON.stringify(c.tags) !== s.tags) patch.tags = c.tags;
    if (!Object.keys(patch).length) { setState('saved'); return; }
    if (!c.id && !c.body.trim() && !c.tags.length && c.title === 'Untitled') { setState('saved'); return; }
    setState('saving');
    const run = (async () => {
      try {
        const e = c.id
          ? await req<CodexEntry>(`/api/codex/entries/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch), keepalive: opts?.keepalive })
          : await api.createCodexEntry({ kind: 'note', title: c.title, body: c.body, tags: c.tags });
        if (!c.id) { cur.current.id = e.id; linked.current = e.title; setNoteHash(e.id); }
        saved.current = { title: c.title, body: c.body, tags: JSON.stringify(c.tags) };
        setEntry(e); onSaved(e); setError('');
        const now = cur.current;
        setState(now.title !== c.title || now.body !== c.body || JSON.stringify(now.tags) !== JSON.stringify(c.tags) ? 'pending' : 'saved');
      } catch (ex) { setState('error'); setError(String(ex)); }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, [onSaved]);

  const change = (next: { title?: string; body?: string; tags?: string[]; auto?: boolean }) => {
    const auto = next.auto ?? autoTitle;
    const b = next.body ?? body;
    const t = auto ? deriveTitle(b) : (next.title ?? title).trim() || deriveTitle(b);
    cur.current = { ...cur.current, title: t, body: b, tags: next.tags ?? tags };
    setState('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { save(); }, SAVE_AFTER);
    clearTimeout(relinkTimer.current);
    if (linked.current !== null && t !== linked.current) relinkTimer.current = setTimeout(() => { relink(); }, RELINK_AFTER);
  };

  const relink = useCallback((opts?: { keepalive?: boolean }) => {
    clearTimeout(relinkTimer.current);
    const eid = cur.current.id, from = linked.current, to = cur.current.title;
    if (!eid || from === null || from === to) return;
    linked.current = to;
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) return;   // links match titles ignoring case
    req<RelinkResult>(`/api/codex/entries/${eid}/relink`, { method: 'POST', body: JSON.stringify({ from, to }), keepalive: opts?.keepalive })
      .then(r => { if (r.updated.length || r.skipped) onRelinked({ ...r, from, to }); })
      .catch(() => { linked.current = from; });
  }, [onRelinked]);

  // flush on switching notes, leaving the page, or closing the tab
  useEffect(() => {
    const flush = () => { if (timer.current) save({ keepalive: true }); relink({ keepalive: true }); };
    addEventListener('beforeunload', flush);
    return () => { removeEventListener('beforeunload', flush); flush(); };
  }, [save, relink]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (!entry?.id) return;
    req<Backlink[]>(`/api/codex/entries/${entry.id}/backlinks`).then(setBacklinks).catch(() => {});
  }, [entry?.id, entry?.title]);

  const known = useMemo(() => new Set(titles.map(t => t.title.toLowerCase())), [titles]);
  const matches = useMemo(() => {
    if (!ac) return [];
    const q = ac.query.trim().toLowerCase();
    const own = cur.current.id;
    const hits = titles.filter(t => t.id !== own && t.title.toLowerCase().includes(q));
    hits.sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)));
    const rows = hits.slice(0, 8).map(t => ({ title: t.title, isNew: false }));
    if (q && !titles.some(t => t.title.toLowerCase() === q)) rows.push({ title: ac.query.trim(), isNew: true });
    return rows;
  }, [ac, titles]);

  const updateAc = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    const m = pos === el.selectionEnd ? /\[\[([^[\]|\n]*)$/.exec(el.value.slice(Math.max(0, pos - 120), pos)) : null;
    if (!m) { setAc(null); return; }
    const start = pos - m[1].length;
    const { x, y } = caretXY(el, start);
    setAc(a => ({ start, query: m[1], sel: a?.start === start ? a.sel : 0, x, y }));
  };

  const pickTitle = (title: string) => {
    const el = area.current;
    if (!el || !ac) return;
    const pos = el.selectionStart;
    insert(el, ac.start, el.value.startsWith(']]', pos) ? pos + 2 : pos, `${title}]]`);
    setAc(null);
  };

  const onKey = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ac && matches.length) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const d = ev.key === 'ArrowDown' ? 1 : -1;
        setAc({ ...ac, sel: (ac.sel + d + matches.length) % matches.length });
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); pickTitle(matches[Math.min(ac.sel, matches.length - 1)].title); return; }
    }
    if (ac && ev.key === 'Escape') { ev.preventDefault(); setAc(null); return; }
    onMarkdownKey(ev);
  };

  const onPreviewClick = (ev: React.MouseEvent) => {
    const a = (ev.target as HTMLElement).closest('a');
    const m = a && NOTE_LINK.exec(a.getAttribute('href') ?? '');
    if (!m || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return;
    ev.preventDefault();
    onOpenTitle(decodeURIComponent(m[2]));
  };

  const remove = async () => {
    const eid = cur.current.id;
    clearTimeout(timer.current); timer.current = undefined;
    if (!eid) { onBack(); return; }
    clearTimeout(relinkTimer.current);
    if (!confirm(`Delete "${cur.current.title}"? This can't be undone.`)) return;
    try { await api.deleteCodexEntry(eid); } catch (e) { toastError("Couldn't delete the note")(e); return; }
    onDeleted(eid);
  };

  const togglePin = async () => {
    const eid = cur.current.id;
    if (!eid || !entry) return;
    const e = await api.patchCodexEntry(eid, { pinned: !entry.pinned });
    setEntry(e); onSaved(e);
  };

  const accept = async () => {
    if (!entry) return;
    const e = await api.patchCodexEntry(entry.id, { draft: false });
    setEntry(e); onSaved(e);
  };

  const sendDiscuss = async () => {
    if (!onDiscuss || discuss === null) return;
    setSending(true);
    try {
      await save();
      const c = cur.current;
      const name = `${c.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'note'}.md`;
      const text = (c.title && !c.body.trimStart().startsWith('#') ? `# ${c.title}\n\n` : '') + c.body;
      await onDiscuss(discuss.trim() || DISCUSS_DEFAULT, new File([text], name, { type: 'text/markdown' }));
    } catch (ex) { setError(String(ex)); setSending(false); }
  };

  const shownTitle = autoTitle ? '' : title;
  const words = useMemo(() => (body.match(/\S+/g) ?? []).length, [body]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--border-subtle)]">
        <button className={clsx(btn.icon, 'md:hidden')} onClick={onBack} aria-label="All notes"><ArrowLeft className="w-4 h-4" /></button>
        <input className={clsx('flex-1 min-w-0 bg-transparent text-base font-semibold focus:outline-none',
          autoTitle && body.trim() ? 'placeholder-[var(--text-primary)]' : 'placeholder-[var(--text-muted)]')}
          value={shownTitle} placeholder={autoTitle ? deriveTitle(body) : 'Untitled'}
          onChange={ev => { const v = ev.target.value; setTitle(v); setAutoTitle(!v.trim()); change({ title: v, auto: !v.trim() }); }}
          onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === 'ArrowDown') { ev.preventDefault(); area.current?.focus(); } }}
          onBlur={() => relink()} />
        <span className={clsx('text-[11px] whitespace-nowrap px-1', state === 'error' ? 'text-red-400' : 'text-[var(--text-muted)]')} title={error || undefined}>
          {state === 'saving' ? 'Saving…' : state === 'pending' ? 'Edited' : state === 'error' ? 'Not saved' : entry ? `Saved ${relTime(entry.updatedAt)}` : 'New note'}
        </span>
        <div className="hidden sm:flex items-center rounded-lg border border-[var(--border-subtle)] p-0.5 ml-1">
          {([['write', PenLine, 'Write'], ['split', Columns2, 'Write and preview side by side'], ['preview', Eye, 'Preview']] as const).map(([v, Icon, label]) => (
            <button key={v} title={label} aria-label={label} onClick={() => onView(v)}
              className={clsx('p-1 rounded-md transition', view === v ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
        <button className={clsx(btn.icon, 'sm:hidden')} onClick={() => onView(view === 'preview' ? 'write' : 'preview')} aria-label="Toggle preview">
          {view === 'preview' ? <PenLine className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
        {entry && <button className={clsx(btn.icon, entry.pinned && 'text-[var(--accent)]')} onClick={togglePin} title={entry.pinned ? 'Unpin' : 'Pin to the top'}><Pin className="w-4 h-4" /></button>}
        {onDiscuss && <button className={btn.icon} onClick={() => setDiscuss(d => (d === null ? '' : null))} title="Brainstorm this note in a new chat"><MessageSquarePlus className="w-4 h-4" /></button>}
        {entry && <a className={btn.icon} href={`#/codex/e/${entry.id}`} title="Open in Codex"><BookMarked className="w-4 h-4" /></a>}
        <button className={clsx(btn.icon, 'hover:text-red-400')} onClick={remove} title="Delete note"><Trash2 className="w-4 h-4" /></button>
      </div>

      {entry?.draft && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs bg-amber-500/10 border-b border-amber-500/30 text-amber-700 dark:text-amber-300">
          <span className="flex-1">An agent wrote this draft. Accept it to make it part of your Codex.</span>
          <button className={btn.subtle} onClick={accept}><Check className="w-3.5 h-3.5" />Accept</button>
        </div>
      )}

      {discuss !== null && (
        <div className="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
          <textarea autoFocus rows={2} className={clsx(btn.input, 'resize-y')} value={discuss} placeholder={DISCUSS_DEFAULT}
            onChange={ev => setDiscuss(ev.target.value)}
            onKeyDown={ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendDiscuss(); } else if (ev.key === 'Escape') setDiscuss(null); }} />
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="flex-1">Starts a new chat with this note attached. Write @Agent to pick who answers.</span>
            <button className={btn.ghost} onClick={() => setDiscuss(null)}>Cancel</button>
            <button className={btn.primary} disabled={sending} onClick={sendDiscuss}>
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquarePlus className="w-3.5 h-3.5" />}Start chat
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {view !== 'preview' && (
          <div className={clsx('relative flex-1 min-w-0 flex', view === 'split' && 'md:border-r border-[var(--border-subtle)]')}>
            <textarea ref={area} spellCheck
              className="flex-1 min-w-0 h-full resize-none bg-transparent px-5 py-4 font-mono text-[13.5px] leading-relaxed focus:outline-none placeholder-[var(--text-muted)]"
              value={body} placeholder={'Start typing. Markdown works:\n\n# A heading\n- an idea\n  - a thought under it\n- [ ] something to try\n\nLink another note with [[its title]].'}
              onChange={ev => { setBody(ev.target.value); change({ body: ev.target.value }); updateAc(ev.target); }}
              onKeyDown={onKey} onClick={ev => updateAc(ev.currentTarget)}
              onKeyUp={ev => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') updateAc(ev.currentTarget); }}
              onBlur={() => setAc(null)} onScroll={() => setAc(null)} />
            {ac && matches.length > 0 && (
              <div className="absolute z-20 w-72 max-w-[calc(100%-16px)] py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-xl text-sm"
                style={{ left: Math.max(8, Math.min(ac.x, (area.current?.clientWidth ?? 300) - 296)), top: ac.y + 4 }}>
                {matches.map((m, i) => (
                  <button key={`${m.isNew}-${m.title}`} onMouseDown={ev => { ev.preventDefault(); pickTitle(m.title); }}
                    className={clsx('w-full flex items-center gap-2 px-2.5 py-1.5 text-left', i === ac.sel ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]/60')}>
                    {m.isNew ? <FilePlus2 className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" /> : <StickyNote className="w-3.5 h-3.5 shrink-0 text-amber-400" />}
                    <span className="truncate">{m.isNew ? <>New note “{m.title}”</> : m.title}</span>
                  </button>
                ))}
                <div className="px-2.5 pt-1 text-[10px] text-[var(--text-muted)]">↑↓ to choose · Enter to link · Esc to close</div>
              </div>
            )}
          </div>
        )}
        {view !== 'write' && (
          <div className={clsx('notes-preview flex-1 min-w-0 overflow-y-auto px-6 py-4', view === 'split' && 'hidden md:block')} onClick={onPreviewClick}
            onDoubleClick={() => { if (view === 'preview') { onView('write'); requestAnimationFrame(() => area.current?.focus()); } }}>
            {body.trim() ? <Markdown text={linkify(body, known)} /> : <p className="text-sm text-[var(--text-muted)]">Nothing written yet.</p>}
          </div>
        )}
      </div>

      {backlinks && backlinks.length > 0 && (
        <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40">
          <button className="w-full flex items-center gap-1.5 px-4 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => setShowBacklinks(v => !v)}>
            <Link2 className="w-3.5 h-3.5" />Linked from {backlinks.length} note{backlinks.length === 1 ? '' : 's'}
            <ChevronDown className={clsx('w-3.5 h-3.5 ml-auto transition', !showBacklinks && '-rotate-90')} />
          </button>
          {showBacklinks && (
            <div className="max-h-40 overflow-y-auto px-2 pb-2 grid gap-1 sm:grid-cols-2">
              {backlinks.map(b => (
                <button key={b.id} onClick={() => onOpen(b.id)} className="text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] min-w-0">
                  <span className="block truncate text-sm font-medium">{b.title}</span>
                  {b.line && <span className="block truncate text-xs text-[var(--text-muted)]">{unwiki(b.line)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--border-subtle)]">
        <div className="flex-1 min-w-0"><TagInput value={tags} all={(index?.tags ?? []).map(([t]) => t)} onChange={t => { setTags(t); change({ tags: t }); }} /></div>
        <span className="hidden sm:block text-[11px] text-[var(--text-muted)] whitespace-nowrap">{words.toLocaleString()} word{words === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

const DISCUSS_DEFAULT = 'Brainstorm with me on this note. Push the ideas further, point out gaps and suggest what to try next.';

// ── page ────────────────────────────────────────────────────────────────────

/** `guest`: Shell:B Guest, where notes are the guest's own (server/guest_notes.py), not the owner's Codex. */
export function Notes({ sub, onDiscuss, guest }: { sub: string; onDiscuss?: (prompt: string, note: File) => Promise<void>; guest?: boolean }) {
  const [items, setItems] = useState<CodexEntry[]>([]);
  const [index, setIndex] = useState<CodexIndex | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  // `open` is the note on screen (null: none, 'new': unsaved). `session` remounts the editor only when you pick another note,
  // not when a new note gets its id on its first save.
  const [open, setOpen] = useState<string | null>(() => (/^notes\/(t|new)\//.test(sub) ? null : sub.split('/')[1] || null));
  const [session, setSession] = useState(0);
  const [view, setViewState] = useState<ViewMode>(readView);
  const [titles, setTitles] = useState<NoteTitle[]>([]);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const loadTitles = useCallback(() => req<NoteTitle[]>('/api/codex/notes/titles').then(t => { setTitles(t); return t; }), []);
  useEffect(() => { loadTitles().catch(() => {}); }, [loadTitles]);

  /** Opens the note with this title, or makes it: what clicking a [[link]] does. */
  const openTitle = useCallback(async (title: string) => {
    const find = (list: NoteTitle[]) => list.find(t => t.title.toLowerCase() === title.trim().toLowerCase());
    try {
      let hit = find(await loadTitles());
      if (!hit) {
        const e = await api.createCodexEntry({ kind: 'note', title: title.trim(), body: '' });
        hit = { id: e.id, title: e.title };
        setTitles(prev => [hit!, ...prev]);
        setItems(prev => [{ ...e, preview: '' }, ...prev]);
      }
      setOpen(hit.id); setSession(n => n + 1); setNoteHash(hit.id);
    } catch { /* leave the current note open */ }
  }, [loadTitles]);

  // #/codex/notes/<id>, or …/t/<title> and …/new/<title> from a link opened in a new tab
  useEffect(() => {
    const [, a, ...rest] = sub.split('/');
    if ((a === 't' || a === 'new') && rest.length) { openTitle(decodeURIComponent(rest.join('/'))); return; }
    setOpen(a || null); setSession(n => n + 1);
  }, [sub]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    try { setItems(await api.codexEntries({ kind: 'note', q: query, tag })); } catch { /* keep the old list */ }
    setLoaded(true);
  }, [query, tag]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.codex().then(setIndex).catch(() => {}); }, []);

  const setView = (v: ViewMode) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };
  const pick = (id: string | null) => { setOpen(id); setSession(n => n + 1); setNoteHash(id && id !== 'new' ? id : undefined); };

  const onSaved = useCallback((e: CodexEntry) => {
    setOpen(o => (o === 'new' ? e.id : o));
    setTitles(prev => [{ id: e.id, title: e.title }, ...prev.filter(t => t.id !== e.id)]);
    setItems(prev => {
      const row: CodexEntry = { ...e, preview: unwiki(e.body ?? '').replace(/[#*_`>|]+/g, '').split(/\s+/).join(' ').trim().slice(0, 240) };
      const rest = prev.filter(x => x.id !== e.id);
      return [row, ...rest].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (query ? 0 : b.updatedAt - a.updatedAt));
    });
  }, [query]);

  // Alt+N: a new note from anywhere on the page; / jumps to search
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing = ev.target instanceof HTMLElement && (ev.target.closest('input, textarea, [contenteditable="true"]'));
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === 'n') { ev.preventDefault(); pick('new'); }
      else if (ev.key === '/' && !typing) { ev.preventDefault(); searchBox.current?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const onRelinked = useCallback((r: RelinkResult) => {
    const n = r.updated.length;
    setNotice(r.skipped
      ? { text: `Links to “${r.from}” were left alone: ${r.skipped}.`, warn: true }
      : { text: `Renamed “${r.from}” to “${r.to}” in ${n} linking note${n === 1 ? '' : 's'}: ${r.updated.map(u => u.title).join(', ')}.`, warn: false });
    if (n) { load(); loadTitles().catch(() => {}); }
  }, [load, loadTitles]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const topTags = (index?.tags ?? []).slice(0, 12);

  return (
    <div className="h-full flex">
      <style>{NOTES_CSS}</style>
      {notice && (
        <div role="status" className={clsx('fixed bottom-4 right-4 z-40 max-w-sm flex items-start gap-2 px-3 py-2 rounded-lg border shadow-xl text-xs animate-fade-in',
          notice.warn ? 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-200' : 'bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--text-secondary)]')}>
          <Link2 className="w-3.5 h-3.5 mt-px shrink-0" /><span className="flex-1">{notice.text}</span>
          <button className="p-0.5 hover:text-[var(--text-primary)]" onClick={() => setNotice(null)} aria-label="Dismiss"><X className="w-3 h-3" /></button>
        </div>
      )}
      <aside className={clsx('w-full md:w-72 shrink-0 flex flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40', open && 'hidden md:flex')}>
        <div className="p-2.5 space-y-2 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input ref={searchBox} className={clsx(btn.input, 'pl-8 pr-7')} placeholder="Search notes" value={q} onChange={ev => setQ(ev.target.value)}
                onKeyDown={ev => { if (ev.key === 'Escape') { setQ(''); (ev.target as HTMLInputElement).blur(); } else if (ev.key === 'Enter' && items[0]) pick(items[0].id); }} />
              {q && <button className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setQ('')} aria-label="Clear search"><X className="w-3.5 h-3.5" /></button>}
            </div>
            <button className={btn.primary} onClick={() => pick('new')} title="New note (Alt+N)"><Plus className="w-3.5 h-3.5" />New</button>
          </div>
          {topTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {topTags.map(([t]) => (
                <button key={t} onClick={() => setTag(x => (x === t ? '' : t))}
                  className={clsx('px-1.5 py-0.5 rounded text-[11px] transition', tag === t ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>#{t}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!loaded ? (
            <div className="p-6 flex justify-center text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--text-muted)]">
              {query || tag ? 'No notes match.' : <>No notes yet.<br /><button className="mt-2 text-[var(--accent)] hover:underline" onClick={() => pick('new')}>Write the first one</button></>}
            </div>
          ) : items.map(n => (
            <button key={n.id} onClick={() => pick(n.id)}
              className={clsx('w-full text-left px-3 py-2.5 border-b border-[var(--border-subtle)]/60 transition',
                open === n.id ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]/60')}>
              <div className="flex items-center gap-1.5">
                {n.pinned && <Pin className="w-3 h-3 shrink-0 text-[var(--accent)]" />}
                <span className="flex-1 min-w-0 truncate text-sm font-medium">{n.title || 'Untitled'}</span>
                {n.draft && <span className="text-[10px] px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-300">draft</span>}
                <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">{relTime(n.updatedAt)}</span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)] line-clamp-2">{n.passage ? n.passage.slice(0, 200) : n.preview || <span className="italic text-[var(--text-muted)]">Empty</span>}</p>
            </button>
          ))}
        </div>
      </aside>

      {open ? (
        <NoteEditor key={session} id={open === 'new' ? null : open} index={index} titles={titles} view={view} onView={setView} onSaved={onSaved}
          onDeleted={id => { setItems(prev => prev.filter(x => x.id !== id)); setTitles(prev => prev.filter(t => t.id !== id)); pick(null); }}
          onBack={() => pick(null)} onOpen={pick} onOpenTitle={openTitle} onRelinked={onRelinked} onDiscuss={onDiscuss} />
      ) : (
        <div className="hidden md:flex flex-1 flex-col items-center justify-center gap-3 text-center text-[var(--text-muted)]">
          <StickyNote className="w-10 h-10 opacity-40" />
          <p className="text-sm">Pick a note, or start a new one.</p>
          <button className={btn.subtle} onClick={() => pick('new')}><Plus className="w-3.5 h-3.5" />New note<kbd className="ml-1 text-[10px] font-mono opacity-70">Alt+N</kbd></button>
          <p className="text-[11px] max-w-xs">{guest ? 'Your notes are yours alone, saved on this machine. Press / to search.'
            : 'Notes live in your Codex, so agents can search them too. Press / to search.'}</p>
        </div>
      )}
    </div>
  );
}
