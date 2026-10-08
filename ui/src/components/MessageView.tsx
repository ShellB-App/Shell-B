import { memo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Archive,
  AudioLines,
  ChevronDown,
  Crosshair,
  GitFork,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
} from 'lucide-react';
import type { Agent, ArtifactGroup, Block, Message, ToolDisplay } from '../types';
import { Markdown } from './Markdown';
import { LinkContext, adoptOrphanHtml, extractDefs, plainText, type Def } from './RichLinks';
import { ProcessCard } from './ProcessCard';
import { QuestionCard } from './QuestionCard';
import { AgentAvatar, btn, relTime } from './common';
import { LearnedNote, RecalledNote } from './MemoryManager';
import { FollowUpNote } from './FollowUps';
import { useFeedback } from './Feedback';

import { ArtifactCard, DownloadChip } from './message/ArtifactCard';
import { Outputs } from './message/Outputs';
import { CopyButton, SpeakButton, VerifyButton } from './message/MessageActions';
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
          b.display.plan)
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
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [showOriginals, setShowOriginals] = useState(false);
  const feedback = useFeedback(message, onAsk, busy);

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
              {compactExpanded ? 'Hide summary' : 'Show summary'}
            </button>
            {originals.length > 0 && (
              <button className="text-[var(--accent-soft)] hover:underline flex items-center gap-1" onClick={() => setShowOriginals(v => !v)}
                aria-expanded={showOriginals}>
                {showOriginals ? 'Hide originals' : `Show ${originals.length} originals`}
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
                  <span>{m.role === 'user' ? 'You' : 'Assistant'}</span>
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
      <div className="group flex flex-col items-end" data-msg={message.id}>
        {message.mode === 'plan' && (
          <span className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wide text-[var(--accent-soft)]">
            <ListChecks className="w-3 h-3" />Plan mode
          </span>
        )}
        {message.voice && (
          <span className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]" title="Spoken in voice mode and transcribed">
            <AudioLines className="w-3 h-3" />Spoken
          </span>
        )}
        {message.attachments && message.attachments.length > 0 && <Attachments items={message.attachments} />}
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
              <button className={btn.subtle} onClick={() => setEditing(false)}>Cancel</button>
              <button className={btn.primary} disabled={!draft.trim() || busy} onClick={() => { setEditing(false); onEdit(draft); }}>Send</button>
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
            <button className={btn.icon} title="Edit and resend" disabled={busy} onClick={() => { setDraft(message.content); setEditing(true); }}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            {onFork && (
              <button className={btn.icon} title="Fork conversation from here" onClick={() => onFork(message.id)}>
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
      <div className="group" data-msg={message.id}>
        <div className="flex items-center gap-2 mb-1.5 select-none">
          <AgentAvatar agent={agent} size={20} />
          <span className={clsx('text-xs font-semibold', !agent && 'text-[var(--brand-soft)]')}>{agent?.name ?? 'Shell:B'}</span>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">{message.model}</span>
          {/^(anthropic|gemini|openai|mammouth|claude-code|antigravity|codex)\//.test(message.model ?? '') && (
            <span className="px-1.5 rounded text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20" title="This reply came from a cloud model">cloud</span>
          )}
          {message.mode === 'plan' && (
            <span className="flex items-center gap-1 px-1.5 rounded text-[10px] bg-[var(--accent)]/10 text-[var(--accent-soft)] border border-[var(--accent)]/25"
              title="Plan mode: researched with read-only tools; nothing was changed">
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

        {streaming && segs.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" /> Waking {message.model}…
          </div>
        )}
        {streaming && lastSeg?.kind === 'text' && <span className="caret" />}

        {message.status === 'error' && (
          <div className="my-2 flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1 break-words">{message.error || 'Something went wrong.'}</span>
            {onVerify && <VerifyButton verifiers={verifiers} busy={busy} onVerify={onVerify} label="Diagnose" />}
          </div>
        )}
        {message.status === 'stopped' && <div className="mt-1 text-[11px] text-[var(--text-muted)] italic">Stopped.</div>}

        {message.mode === 'plan' && isLast && message.status === 'complete' && onPlan && (
          <div className="mt-3 flex flex-wrap items-center gap-2 p-3 rounded-xl border border-[var(--accent)]/35 bg-[var(--accent)]/[0.07]">
            <ListChecks className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span className="flex-1 min-w-[12rem] text-xs text-[var(--text-secondary)]">
              Nothing has changed yet. Approve to run this plan with all of {agent?.name ?? 'the agent'}’s tools, or keep planning and say what to change.
            </span>
            <button className={btn.subtle} disabled={busy} onClick={() => onPlan('revise')}>Keep planning</button>
            <button className={btn.primary} disabled={busy} onClick={() => onPlan('approve')}><Play className="w-3.5 h-3.5" />Approve and run</button>
          </div>
        )}

        {!streaming && (
          <div className="flex items-center gap-0.5 mt-1.5 opacity-60 group-hover:opacity-100 transition">
            {text && <CopyButton text={text} />}
            {text && <SpeakButton text={text} />}
            {feedback.buttons}
            {isLast && <button className={btn.icon} title="Regenerate" disabled={busy} onClick={onRegenerate}><RotateCcw className="w-3.5 h-3.5" /></button>}
            {onFork && (
              <button className={btn.icon} title="Fork conversation from here" onClick={() => onFork(message.id)}>
                <GitFork className="w-3.5 h-3.5" />
              </button>
            )}
            {onVerify && message.status !== 'error' && <VerifyButton verifiers={verifiers} busy={busy} onVerify={onVerify} />}
            <span className="ml-2 text-[10px] font-mono text-[var(--text-muted)]">
              {secs && `${secs}s`}
              {message.usage?.completion ? ` · ${message.usage.completion.toLocaleString()} tok` : ''}
            </span>
          </div>
        )}
        {!streaming && feedback.box}
        {!streaming && <RecalledNote message={message} />}
        {!streaming && <LearnedNote message={message} fresh={isLast} />}
        {!streaming && <FollowUpNote message={message} fresh={isLast} />}
      </div>
    </LinkContext.Provider>
  );
});
