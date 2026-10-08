import { useState } from 'react';
import clsx from 'clsx';
import { Brain, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Loader2, ShieldQuestion } from 'lucide-react';
import type { Block } from '../types';
import { api } from '../api';
import { TOOL_LABELS, toolIcon } from './common';

type ProcBlock = Extract<Block, { type: 'thinking' | 'tool' }>;
type ToolBlock = Extract<Block, { type: 'tool' }>;

export function argSummary(b: ToolBlock): string {
  const a = b.args || {};
  const pick = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (b.name) {
    case 'web_search': return pick('query');
    case 'web_fetch': return pick('url').replace(/^https?:\/\//, '');
    case 'run_code': return (pick('code').trim().split('\n')[0] || '').slice(0, 90);
    case 'create_artifact': return pick('title') || pick('id');
    case 'generate_image': case 'generate_adult_image': case 'generate_music': return pick('prompt');
    case 'memory_save': return pick('text');
    case 'memory_search': return pick('query');
    case 'ask_agent': return `${pick('agent_id')}: ${pick('task')}`;
    case 'read_file': case 'write_file': case 'edit_file': case 'delete_file': case 'view_image': return pick('path');
    case 'rename_file': return `${pick('from')} → ${pick('to')}`;
    case 'screenshot': return `${pick('path') || 'entry file'}${a.width ? ` @ ${a.width}×${a.height ?? ''}` : ''}`;
    case 'list_files': return 'project';
    default: return JSON.stringify(a).slice(0, 90);
  }
}

/** A remote (SSH) workspace call, or a deploy of Shell:B's own code, waiting for the owner: shows exactly what will
 *  happen, with allow / deny. */
function ApprovalPrompt({ b }: { b: ToolBlock }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const a = b.args || {};
  // any approval with a kind (self-deploy, secret, schedule, install) explains itself; kind-less ones are remote tool calls
  const self = !!b.approval?.kind;
  const detail = self ? b.approval!.detail ?? '' : b.name === 'run_code' ? String(a.code ?? '')
    : b.name === 'write_file' ? `${a.path}\n\n${String(a.content ?? '').slice(0, 4000)}`
      : b.name === 'edit_file' ? `${a.path}\n\n− ${String(a.old_string ?? '').slice(0, 2000)}\n+ ${String(a.new_string ?? '').slice(0, 2000)}`
        : JSON.stringify(a, null, 2);
  const answer = async (d: 'allow' | 'allow_turn' | 'deny') => {
    setBusy(true); setError('');
    try { await api.answerApproval(b.approval!.id, d); } catch (e) { setError(String(e)); setBusy(false); }
  };
  return (
    <div className="px-3 py-2.5 border-t border-amber-500/30 bg-amber-500/5 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
        <ShieldQuestion className="w-3.5 h-3.5" />{self ? `${b.approval!.title}?` : `Allow ${TOOL_LABELS[b.name]?.[0] ?? b.name} on the remote host?`}
      </div>
      <pre className={clsx('p-2 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono overflow-auto whitespace-pre-wrap break-words', self ? 'max-h-[28rem]' : 'max-h-64')}>
        {b.approval?.kind === 'self' ? detail.split('\n').map((l, i) => <span key={i} className={clsx('block', /^\+(?!\+\+)/.test(l) && 'text-emerald-400', /^-(?!--)/.test(l) && 'text-red-400', /^@@/.test(l) && 'text-sky-400')}>{l || ' '}</span>) : detail}
      </pre>
      {error && <div className="text-[11px] text-red-400">{error.includes('admin-key-required') ? 'Only the signed-in owner can answer this.' : error}</div>}
      <div className="flex flex-wrap gap-1.5">
        <button disabled={busy} onClick={() => answer('allow')} className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">{self ? 'Approve' : 'Allow'}</button>
        {!self && <button disabled={busy} onClick={() => answer('allow_turn')} className="px-2.5 py-1 rounded-lg text-xs border border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-50">Allow for the rest of this turn</button>}
        <button disabled={busy} onClick={() => answer('deny')} className="px-2.5 py-1 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50">Deny</button>
      </div>
    </div>
  );
}

const secs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function ToolRow({ b }: { b: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(b.name);
  const label = TOOL_LABELS[b.name]?.[b.status === 'running' ? 0 : 1] ?? b.name;
  const sources = b.display?.sources ?? [];
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full flex items-start gap-2 text-left group">
        <span className={clsx('mt-0.5 w-5 h-5 rounded-md flex items-center justify-center shrink-0 border',
          b.status === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-sky-500/10 border-sky-500/25 text-sky-400')}>
          <Icon className="w-3 h-3" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
            {b.status === 'running' && <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />}
            {b.status === 'error' && <CircleAlert className="w-3 h-3 text-red-400" />}
            <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">{secs(b.durationMs)}</span>
          </span>
          <span className="block text-[11px] text-[var(--text-secondary)] truncate font-mono">{argSummary(b)}</span>
        </span>
      </button>

      {sources.length > 0 && b.name === 'web_search' && (
        <div className="ml-7 mt-1.5 flex flex-wrap gap-1">
          {sources.slice(0, 8).map(s => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.title}
              className="px-1.5 py-0.5 rounded-md text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] max-w-[180px] truncate">
              {safeHost(s.url)}
            </a>
          ))}
        </div>
      )}

      {b.children && b.children.length > 0 && (
        <div className="ml-7 mt-1.5 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
          {b.children.map((c, i) => {
            const CIcon = toolIcon(c.name);
            return (
              <div key={i} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                <CIcon className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="truncate font-mono">{c.name}: {c.args}</span>
                {c.status === 'running' && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="ml-7 mt-2 space-y-2 text-[11px] font-mono">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-sans font-semibold mb-0.5">Arguments</div>
            <pre className="p-2 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
              {JSON.stringify(b.args, null, 2)}
            </pre>
          </div>
          {b.result != null && (
            <div>
              <div className={clsx('text-[9px] uppercase tracking-wider font-sans font-semibold mb-0.5', b.status === 'error' ? 'text-red-400' : 'text-emerald-400')}>
                Result
              </div>
              <pre className="p-2 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] overflow-x-auto max-h-80 whitespace-pre-wrap break-words">
                {b.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeHost(u: string) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

export function ProcessCard({ blocks, live }: { blocks: ProcBlock[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
  const thinkMs = blocks.reduce((s, b) => s + (b.type === 'thinking' ? b.durationMs ?? 0 : 0), 0);
  const last = blocks[blocks.length - 1];
  const runningTool = tools.find(t => t.status === 'running');
  const waiting = tools.filter(t => t.status === 'approval' && t.approval);
  const lastThought = last?.type === 'thinking' ? last.text.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '' : '';

  const failed = tools.filter(t => t.status === 'error').length;
  const allFailed = tools.length > 0 && failed === tools.length;
  let headline: string;
  if (live && waiting.length) headline = 'Waiting for your approval';
  else if (live && runningTool) headline = `${TOOL_LABELS[runningTool.name]?.[0] ?? runningTool.name}…`;
  else if (live) headline = 'Thinking…';
  else if (thinkMs > 0) headline = `Thought for ${secs(thinkMs)}`;
  else if (allFailed) headline = tools.length === 1 ? `${tools[0].name} failed` : `${failed} tool calls failed`;
  else headline = tools.length === 1 ? (TOOL_LABELS[tools[0].name]?.[1] ?? tools[0].name) : `Used ${tools.length} tools`;

  return (
    <div className="my-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className={clsx('w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition', live ? 'think-stream' : 'hover:bg-[var(--bg-hover)]')}
        aria-expanded={open}
      >
        {live ? <Loader2 className="w-3.5 h-3.5 text-[var(--accent)] animate-spin shrink-0" />
          : thinkMs > 0 ? <Brain className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            : allFailed ? <CircleAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
              : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
        <span className={clsx('font-medium shrink-0', live ? 'text-[var(--accent-soft)]' : 'text-[var(--text-secondary)]')}>{headline}</span>
        {live && !runningTool && lastThought && !open && (
          <span className="truncate text-[var(--text-muted)] italic min-w-0">{lastThought}</span>
        )}
        {live && runningTool && !open && (
          <span className="truncate text-[var(--text-muted)] font-mono text-[11px] min-w-0">{argSummary(runningTool)}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[var(--text-muted)]">
          {tools.length > 0 && !live && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/10 text-sky-400 border border-sky-500/20">
              {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
            </span>
          )}
          {failed > 0 && !live && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">{failed} failed</span>
          )}
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>

      {live && waiting.map(t => <ApprovalPrompt key={t.approval!.id} b={t} />)}

      {open && (
        <div className="px-3 py-3 border-t border-[var(--border-subtle)] space-y-3 bg-[var(--bg-primary)]/50">
          {blocks.map((b, i) => b.type === 'thinking' ? (
            <div key={i} className="flex gap-2">
              <span className="mt-0.5 w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-[var(--accent)]/10 border border-[var(--accent)]/25 text-[var(--accent)]">
                <Brain className="w-3 h-3" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)] mb-0.5">
                  Reasoning {b.durationMs != null && <span className="font-mono normal-case tracking-normal">· {secs(b.durationMs)}</span>}
                </div>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap max-h-96 overflow-y-auto">{b.text.trim()}</p>
              </div>
            </div>
          ) : <ToolRow key={i} b={b} />)}
        </div>
      )}
    </div>
  );
}
