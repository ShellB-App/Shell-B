import { t } from '../i18n';
import { memo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Archive,
  AudioLines,
  ChevronDown,
  Crosshair,
  Flag,
  GitFork,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  RotateCcw, Languages, X } from 'lucide-react';
import type { Agent, ArtifactGroup, Block, Message, ToolDisplay } from '../types';
import { Markdown } from './Markdown';
import { LinkContext, adoptOrphanHtml, extractDefs, plainText, type Def } from './RichLinks';
import { ProcessCard } from './ProcessCard';
import { QuestionCard } from './QuestionCard';
import { AgentAvatar, btn, relTime } from './common';
import { LearnedNote, RecalledNote } from './MemoryManager';
import { CircleNotesUsed } from './CircleCards';
import { FollowUpNote } from './FollowUps';
import { useFeedback } from './Feedback';

import { ArtifactCard, DownloadChip } from './message/ArtifactCard';
import { Outputs } from './message/Outputs';
import { CopyButton, SpeakButton, VerifyButton } from './message/MessageActions';
import { Copy as CopyIcon, FileText, Quote, Square as StopIcon, Volume2 } from 'lucide-react';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { toast } from './toast';
import { api } from '../api';
import { copyText, quoteInComposer } from '../quote';
import { readAloud } from '../speech';
import { MessageAttachments as Attachments } from './message/MessageAttachments';

// Re-export for external consumers (e.g. WorkspaceFiles.tsx)
export { ArtifactCard, DownloadChip };

type ProcBlock = Extract<Block, { type: 'thinking' | 'tool' }>;
type ToolBlock = Extract<Block, { type: 'tool' }>;
type Segment =
  | { kind: 'process'; blocks: ProcBlock[]; outputs: ToolDisplay[] }
  | { kind: 'text'; text: string }
  | { kind: 'question'; block: ToolBlock };

function segment(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (!b.text) continue;
      const prev = out[out.length - 1];
      if (prev?.kind === 'text') prev.text += b.text;
      else out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'tool' && b.name === 'ask_user' && b.questions) {
      out.push({ kind: 'question', block: b }); // questions stand on their own, not inside the tool log
    } else {
      let prev = out[out.length - 1];
      if (prev?.kind !== 'process') {
        prev = { kind: 'process', blocks: [], outputs: [] };
        out.push(prev);
      }
      prev.blocks.push(b);
      if (
        b.type === 'tool' &&
        b.display &&
        (b.display.images?.length ||
          b.display.audio?.length ||
          b.display.artifact ||
          b.display.file ||
          b.display.downloads?.length ||
          b.display.board ||
          b.display.plan ||
          b.display.circleNote)
      ) {
        prev.outputs.push(b.display);
      }
    }
  }
  return out;
}

const SELECTION_RE = /\n*\[Selected element in (.+?): `(.+?)`\]\n```html\n[\s\S]*?```\s*$/;

/** Studio messages carry the picked element as a fenced block; show it as a chip instead. */
function splitSelection(text: string) {
  const m = SELECTION_RE.exec(text);
  return m ? { body: text.slice(0, m.index), file: m[1], selector: m[2] } : { body: text, file: '', selector: '' };
}

/** Text selected inside this message, or ''. */
function selectionIn(el: Element) {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.anchorNode || !el.contains(s.anchorNode)) return '';
  return s.toString().trim();
}

// one reading at a time from the context menu, so the next menu can offer to stop it
let stopReading: (() => void) | null = null;
function readEntry(text: string): MenuEntry {
  if (stopReading) return { label: t('Stop reading'), icon: StopIcon, onSelect: () => { stopReading?.(); stopReading = null; } };
  return { label: t('Read aloud'), icon: Volume2, disabled: !text, onSelect: () => {
    let stop: (() => void) | null = null;
    stop = readAloud(text, st => { if (st === 'idle' && stopReading === stop) stopReading = null; });
    stopReading = stop;
  } };
}

/** What every message's menu starts with when text is selected in it. */
const selectionEntries = (sel: string): MenuEntry[] => sel ? [
  { label: t('Copy selection'), icon: CopyIcon, hint: 'Ctrl C', onSelect: () => copyText(sel) },
  { label: t('Quote selection in reply'), icon: Quote, onSelect: () => quoteInComposer(sel) },
  'sep',
] : [];

interface Props {
  message: Message;
  agent?: Agent;
  isLast: boolean;
  busy: boolean;
  activeArtifact?: string;
  onOpenArtifact: (id: string, version?: number) => void;
  onRegenerate: () => void;
  onEdit: (text: string) => void;
  onOpenFile?: (path: string) => void;
  /** conversation artifacts, so [label](artifact:id) links can preview and open them */
  artifacts?: ArtifactGroup[];
  /** [label](ask: …) links and widgets send follow-up questions through this */
  onAsk?: (text: string) => void;
  /** the buttons under the latest plan-mode reply: run it, or keep refining it */
  onPlan?: (action: 'approve' | 'revise') => void;
  /** cloud agents that can audit the chat, and the action that asks one to (verify.py) */
  verifiers?: Agent[];
  onVerify?: (agentId: string) => void;
  onFork?: (messageId: string) => void;
  /** Shell:B Guest (ui/src/guest/): no thumbs, memory or follow-up notes (those are the owner's), and a Report button */
  guest?: boolean;
  onReport?: () => void;
}

const TRANSLATE_TO = ['English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch', 'Japanese', 'Chinese (Simplified)', 'Korean', 'Arabic', 'Russian'];

/** A translation under the message (server/translate.py), as Markdown, with the detected language and a close button. */
function TranslationBlock({ t: tr, onClose }: { t: { to: string; text: string; detected?: string; busy?: boolean }; onClose: () => void }) {
  return (
    <div className="my-2 w-full max-w-[85%] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3.5 py-2.5 text-left">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] mb-1">
        <Languages className="w-3.5 h-3.5" />
        <span className="flex-1">{tr.busy ? t('Translating to {lang}…', { lang: t(tr.to) }) : `${tr.detected ? `${t(tr.detected)} → ` : ''}${t(tr.to)} · ${t('local model')}`}</span>
        <button className={btn.icon} aria-label={t('Close translation')} onClick={onClose}><X className="w-3.5 h-3.5" /></button>
      </div>
      {tr.busy ? <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" /> : <Markdown text={tr.text} />}
    </div>
  );
}

export const MessageView = memo(function MessageView({
  message,
  agent,
  isLast,
  busy,
  activeArtifact,
  onOpenArtifact,
  onRegenerate,
  onEdit,
  onOpenFile,
  artifacts,
  onAsk,
  onPlan,
  verifiers = [],
  onVerify,
  onFork,
  guest,
  onReport,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [showOriginals, setShowOriginals] = useState(false);
  const [translation, setTranslation] = useState<{ to: string; text: string; detected?: string; busy?: boolean } | null>(null);
  const feedback = useFeedback(message, onAsk, busy);
  // right-click → Translate to…: the local utility model (server/translate.py); shown under the message until closed
  const translateEntry = (source: string): MenuEntry => source ? {
    label: t('Translate to…'), icon: Languages, items: TRANSLATE_TO.map(to => ({ label: t(to), onSelect: () => {
      setTranslation({ to, text: '', busy: true });
      api.translate(source, to).then(r => setTranslation({ to, text: r.translation, detected: r.detected }))
        .catch(e => { setTranslation(null); toast(t("Couldn't translate: {error}", { error: String(e).replace(/^Error: \d+: /, '') }), { kind: 'error' }); });
    } })),
  } : null;

  if (message.role === 'summary') {
    const originals = message.originals ?? [];
    const count = message.count ?? originals.length;
    return (
      <div className="w-full my-4 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--bg-secondary)]" data-msg={message.id}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
          <span className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
            <Archive className="w-4 h-4 text-[var(--text-muted)]" aria-hidden />
            Summarized {count} earlier {count === 1 ? 'message' : 'messages'}
          </span>
          <span className="text-[var(--text-muted)]">The agent now sees this summary instead; the originals are kept and searchable.</span>
          <span className="ml-auto flex gap-3">
            <button className="text-[var(--accent-soft)] hover:underline" onClick={() => setCompactExpanded(v => !v)}
              aria-expanded={compactExpanded}>
              {compactExpanded ? t('Hide summary') : t('Show summary')}
            </button>
            {originals.length > 0 && (
              <button className="text-[var(--accent-soft)] hover:underline flex items-center gap-1" onClick={() => setShowOriginals(v => !v)}
                aria-expanded={showOriginals}>
                {showOriginals ? t('Hide originals') : t('Show {n} originals', { n: originals.length })}
                <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', showOriginals && 'rotate-180')} aria-hidden />
              </button>
            )}
          </span>
        </div>
        {compactExpanded && (
          <div className="px-4 pb-4 text-xs leading-relaxed text-[var(--text-secondary)] max-w-[75ch]">
            <Markdown text={message.content} />
          </div>
        )}
        {showOriginals && (
          <div className="border-t border-[var(--border-subtle)] p-4 space-y-3 max-h-[28rem] overflow-y-auto">
            {originals.map(m => (
              <div key={m.id} className="text-xs p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                <div className="flex items-center justify-between mb-1 text-[11px] text-[var(--text-muted)] font-medium">
                  <span>{m.role === 'user' ? t('You') : t('Assistant')}</span>
                  {m.timestamp && <span className="font-mono text-[10px]">{relTime(m.timestamp)}</span>}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (message.role === 'user') {
    const sel = splitSelection(message.content);
    return (
      <div className="group flex flex-col items-end" data-msg={message.id} onContextMenu={e => {
        if (editing) return;
        const picked = selectionIn(e.currentTarget);
        openContextMenu(e, [
          ...selectionEntries(picked),
          { label: t('Copy message'), icon: CopyIcon, onSelect: () => copyText(sel.body) },
          !picked && { label: t('Quote in reply'), icon: Quote, onSelect: () => quoteInComposer(sel.body) },
          readEntry(sel.body),
          translateEntry(sel.body),
          'sep',
          { label: t('Edit and resend'), icon: Pencil, disabled: busy, onSelect: () => { setDraft(message.content); setEditing(true); } },
          onFork && { label: t('Fork from here'), icon: GitFork, onSelect: () => onFork(message.id) },
        ]);
      }}>
        {message.mode === 'plan' && (
          <span className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wide text-[var(--accent-soft)]">
            <ListChecks className="w-3 h-3" />{t('Plan mode')}
          </span>
        )}
        {message.voice && (
          <span className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]" title={t('Spoken in voice mode and transcribed')}>
            <AudioLines className="w-3 h-3" />{t('Spoken')}
          </span>
        )}
        {message.attachments && message.attachments.length > 0 && <Attachments items={message.attachments} />}
        {translation && <TranslationBlock t={translation} onClose={() => setTranslation(null)} />}
        {editing ? (
          <div className="w-full max-w-[85%] rounded-2xl border border-[var(--accent)]/50 bg-[var(--bg-secondary)] p-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              autoFocus
              rows={Math.min(12, draft.split('\n').length + 1)}
              className="w-full bg-transparent resize-none text-sm focus:outline-none p-1"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  setEditing(false);
                  onEdit(draft);
                }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="flex justify-end gap-1.5">
              <button className={btn.subtle} onClick={() => setEditing(false)}>{t('Cancel')}</button>
              <button className={btn.primary} disabled={!draft.trim() || busy} onClick={() => { setEditing(false); onEdit(draft); }}>{t('Send')}</button>
            </div>
          </div>
        ) : (
          message.content && (
            <div className="max-w-[85%] rounded-2xl px-4 py-2.5 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words">
              {sel.selector && (
                <span className="flex items-center gap-1.5 mb-1.5 text-[11px] font-mono text-[var(--accent-soft)]">
                  <Crosshair className="w-3 h-3 shrink-0" />
                  <span className="truncate">{sel.selector}</span>
                  <span className="text-[var(--text-muted)] shrink-0">in {sel.file}</span>
                </span>
              )}
              {sel.body}
            </div>
          )
        )}
        {!editing && (
          <div className="flex gap-0.5 mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
            <CopyButton text={message.content} />
            <button className={btn.icon} title={t('Edit and resend')} disabled={busy} onClick={() => { setDraft(message.content); setEditing(true); }}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            {onFork && (
              <button className={btn.icon} title={t('Fork conversation from here')} onClick={() => onFork(message.id)}>
                <GitFork className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const blocks = message.blocks ?? [];
  const segs = segment(blocks);
  const streaming = message.status === 'streaming';
  const lastSeg = segs[segs.length - 1];
  // ```tip key``` / ```widget key``` fences may sit in any text segment and are referenced from any other
  const defs: Record<string, Def> = {};
  const textSegs = segs.filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text');
  for (const s of textSegs) {
    const r = extractDefs(s.text);
    s.text = r.body;
    Object.assign(defs, r.defs);
  }
  adoptOrphanHtml(textSegs.map(s => s.text), defs).forEach((t, i) => { textSegs[i].text = t; });
  const text = plainText(textSegs.map(s => s.text).join('\n\n')).trim();
  const secs = message.durationMs ? (message.durationMs / 1000).toFixed(1) : null;

  return (
    <LinkContext.Provider value={{ artifacts, defs, busy, onOpenArtifact, onAsk, onOpenFile, stale: !isLast || streaming }}>
      <div className="group" data-msg={message.id} onContextMenu={e => {
        const picked = selectionIn(e.currentTarget);
        const markdown = textSegs.map(t => t.text).join('\n\n').trim();
        openContextMenu(e, [
          ...selectionEntries(picked),
          { label: t('Copy'), icon: CopyIcon, disabled: !text, onSelect: () => copyText(text) },
          { label: t('Copy as Markdown'), icon: FileText, disabled: !markdown, onSelect: () => copyText(markdown, t('Markdown copied')) },
          !picked && { label: t('Quote in reply'), icon: Quote, disabled: !text, onSelect: () => quoteInComposer(text) },
          readEntry(text),
          translateEntry(markdown || text),
          'sep',
          isLast && { label: t('Regenerate'), icon: RotateCcw, disabled: busy || streaming, onSelect: onRegenerate },
          onFork && !streaming && { label: t('Fork from here'), icon: GitFork, onSelect: () => onFork(message.id) },
        ]);
      }}>
        <div className="flex items-center gap-2 mb-1.5 select-none">
          <AgentAvatar agent={agent} size={20} />
          <span className={clsx('text-xs font-semibold', !agent && 'text-[var(--brand-soft)]')}>{agent?.name ?? 'Shell:B'}</span>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">{message.model}</span>
          {/^(anthropic|gemini|openai|mammouth|claude-code|antigravity|codex)\//.test(message.model ?? '') && (
            <span className="px-1.5 rounded text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20" title={t('This reply came from a cloud model')}>cloud</span>
          )}
          {message.mode === 'plan' && (
            <span className="flex items-center gap-1 px-1.5 rounded text-[10px] bg-[var(--accent)]/10 text-[var(--accent-soft)] border border-[var(--accent)]/25"
              title={t('Plan mode: researched with read-only tools; nothing was changed')}>
              <ListChecks className="w-3 h-3" />plan
            </span>
          )}
        </div>

        {segs.map((s, i) =>
          s.kind === 'question' ? (
            <QuestionCard key={i} b={s.block} live={streaming} isLast={isLast} busy={busy} onAsk={onAsk} />
          ) : s.kind === 'process' ? (
            <div key={i}>
              <ProcessCard blocks={s.blocks} live={streaming && i === segs.length - 1} />
              <Outputs outputs={s.outputs} activeArtifact={activeArtifact} onOpenArtifact={onOpenArtifact} onOpenFile={onOpenFile} />
            </div>
          ) : (
            <Markdown key={i} text={s.text} className={clsx(streaming && i === segs.length - 1 && 'streaming-text')} />
          )
        )}

        {translation && <TranslationBlock t={translation} onClose={() => setTranslation(null)} />}
        {streaming && segs.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" /> Waking {message.model}…
          </div>
        )}
        {streaming && lastSeg?.kind === 'text' && <span className="caret" />}

        {message.status === 'error' && (
          <div className="my-2 flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1 break-words">{message.error || t('Something went wrong.')}</span>
            {onVerify && <VerifyButton verifiers={verifiers} busy={busy} onVerify={onVerify} label={t('Diagnose')} />}
          </div>
        )}
        {message.status === 'stopped' && <div className="mt-1 text-[11px] text-[var(--text-muted)] italic">{t('Stopped.')}</div>}

        {message.mode === 'plan' && isLast && message.status === 'complete' && onPlan && (
          <div className="mt-3 flex flex-wrap items-center gap-2 p-3 rounded-xl border border-[var(--accent)]/35 bg-[var(--accent)]/[0.07]">
            <ListChecks className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span className="flex-1 min-w-[12rem] text-xs text-[var(--text-secondary)]">
              {t('Nothing has changed yet. Approve to run this plan with all of {name}’s tools, or keep planning and say what to change.', { name: agent?.name ?? t('the agent') })}
            </span>
            <button className={btn.subtle} disabled={busy} onClick={() => onPlan('revise')}>{t('Keep planning')}</button>
            <button className={btn.primary} disabled={busy} onClick={() => onPlan('approve')}><Play className="w-3.5 h-3.5" />{t('Approve and run')}</button>
          </div>
        )}

        {!streaming && (
          <div className="flex items-center gap-0.5 mt-1.5 opacity-60 group-hover:opacity-100 transition">
            {text && <CopyButton text={text} />}
            {text && <SpeakButton text={text} />}
            {!guest && feedback.buttons}
            {onReport && <button className={btn.icon} title={t('Report a problem with this reply to Evie')} onClick={onReport}><Flag className="w-3.5 h-3.5" /></button>}
            {isLast && <button className={btn.icon} title={t('Regenerate')} disabled={busy} onClick={onRegenerate}><RotateCcw className="w-3.5 h-3.5" /></button>}
            {onFork && (
              <button className={btn.icon} title={t('Fork conversation from here')} onClick={() => onFork(message.id)}>
                <GitFork className="w-3.5 h-3.5" />
              </button>
            )}
            {onVerify && message.status !== 'error' && <VerifyButton verifiers={verifiers} busy={busy} onVerify={onVerify} />}
            <span className="ml-2 text-[10px] font-mono text-[var(--text-muted)]">
              {secs && `${secs}s`}
              {message.usage?.completion ? ` · ${message.usage.completion.toLocaleString()} tok` : ''}
              {message.usage?.node && <span title={t('Written on this fleet machine (Models → Fleet)')}> · {t('on {node}', { node: message.usage.node })}</span>}
            </span>
          </div>
        )}
        {!streaming && !guest && feedback.box}
        {!streaming && !guest && <RecalledNote message={message} />}
        {!streaming && <CircleNotesUsed message={message} />}
        {!streaming && !guest && <LearnedNote message={message} fresh={isLast} />}
        {!streaming && !guest && <FollowUpNote message={message} fresh={isLast} />}
      </div>
    </LinkContext.Provider>
  );
});
