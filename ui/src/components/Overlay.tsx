import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { ArrowUp, Camera, Eye, Loader2, ScreenShare, ScreenShareOff, ShieldQuestion, Square, X } from 'lucide-react';
import type { Attachment, Block, Message } from '../types';
import { api } from '../api';
import { closeOverlay, useOverlayWindow } from '../overlay';
import { screenSupported, snapshot, startLive, stopLive, useLiveShare } from '../screenShare';
import { Markdown } from './Markdown';
import { TOOL_LABELS } from './common';

type ToolBlock = Extract<Block, { type: 'tool' }>;

interface Props {
  messages: Message[];
  agentName: string;
  busy: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  ensureConversation: () => Promise<string>;
}

const errText = (e: unknown) => String(e).replace(/^Error: (\d+: )?/, '');

/**
 * The overlay's contents (overlay.ts opens the window): the latest exchange of the open chat, a one-line composer, the
 * live screen share, and any approval the reply is waiting on. Renders nothing while the overlay is closed.
 */
export function Overlay(props: Props) {
  const win = useOverlayWindow();
  const root = win?.document.getElementById('overlay-root');
  return root ? createPortal(<OverlayBody {...props} />, root) : null;
}

function OverlayBody({ messages, agentName, busy, onSend, onStop, ensureConversation }: Props) {
  const share = useLiveShare();
  const [text, setText] = useState('');
  const [withShot, setWithShot] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const visible = messages.filter(m => m.role !== 'summary');
  const reply = [...visible].reverse().find(m => m.role === 'assistant');
  const asked = [...visible].reverse().find(m => m.role === 'user');
  const answering = reply && asked && reply.timestamp >= asked.timestamp ? reply : undefined;
  const blocks = answering?.blocks ?? [];
  const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
  const waiting = tools.filter(b => b.status === 'approval');
  const running = [...tools].reverse().find(b => b.status === 'running');
  const textOut = blocks.length
    ? blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n\n')
    : answering?.content ?? '';
  const thinking = busy && !textOut && blocks.some(b => b.type === 'thinking');

  // a short glow around the window each time Shell:B takes a look
  const looks = share?.looks ?? 0;
  const lastLooks = useRef(looks);
  useEffect(() => {
    if (looks > lastLooks.current) { setFlash(true); const t = setTimeout(() => setFlash(false), 1200); lastLooks.current = looks; return () => clearTimeout(t); }
    lastLooks.current = looks;
  }, [looks]);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [textOut, waiting.length, running?.name]);
  useEffect(() => { input.current?.focus(); }, []);

  async function toggleShare() {
    setError('');
    try {
      if (share) await stopLive();
      else if (!screenSupported()) setError('Screen sharing needs HTTPS and a desktop browser.');
      else await startLive();
    } catch (e) {
      if (!/NotAllowed|AbortError|Permission/i.test(String(e))) setError(`Couldn't share the screen: ${errText(e)}`);
    }
  }

  async function submit() {
    const t = text.trim();
    if (!t || busy || working) return;
    setError('');
    let atts: Attachment[] = [];
    if (withShot) {
      try {
        setWorking('Taking a screenshot…');
        const shot = await snapshot();
        const id = await ensureConversation();
        atts = [await api.upload(id, shot)];
      } catch (e) {
        setWorking('');
        if (!/NotAllowed|AbortError|Permission/i.test(String(e))) setError(`Couldn't take a screenshot: ${errText(e)}`);
        return;
      }
    }
    setWorking('');
    setText('');
    onSend(t, atts);
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  const status = working || (waiting.length ? 'Waiting for you'
    : running ? (running.name === 'look_at_screen' ? 'Looking at your screen…' : `${TOOL_LABELS[running.name]?.[0] ?? running.name}…`)
      : thinking ? 'Thinking…' : busy && !textOut ? 'Working…' : '');

  return (
    <div className={clsx('h-full flex flex-col text-sm transition-shadow duration-500', flash && 'shadow-[inset_0_0_0_2px_var(--accent)]')}>
      <header className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <span className="text-xs font-semibold tracking-wider">Shell:B</span>
        <span className="text-xs text-[var(--text-muted)] truncate flex-1">· {agentName}</span>
        <button onClick={toggleShare} disabled={!!working}
          className={clsx('flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border max-w-[55%]',
            share ? 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10' : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
          title={share ? `Sharing ${share.label}${looks ? `, looked ${looks}×` : ''}: click to stop` : 'Let Shell:B look at your screen when it helps'}>
          {share ? <Eye className="w-3 h-3 shrink-0" /> : <ScreenShare className="w-3 h-3 shrink-0" />}
          <span className="truncate">{share ? `${share.label}${looks ? ` · ${looks}` : ''}` : 'Share screen'}</span>
          {share && <ScreenShareOff className="w-3 h-3 shrink-0 opacity-70" />}
        </button>
        <button onClick={closeOverlay} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" aria-label="Close overlay" title="Close overlay">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {asked ? (
          <div className="text-xs text-[var(--text-muted)] line-clamp-3 whitespace-pre-wrap">
            {asked.attachments?.length ? '📎 ' : ''}{asked.content}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-1 text-xs text-[var(--text-muted)] px-4">
            <p>Ask {agentName} anything while you work in another app.</p>
            <p>Share your screen and it can look when it helps, or tick <Camera className="inline w-3 h-3" /> to send a screenshot with your message.</p>
          </div>
        )}
        {textOut && <Markdown text={textOut} streaming={busy} className="text-[13px]" />}
        {answering?.status === 'error' && <div className="text-xs text-red-400">{answering.error}</div>}
        {waiting.map(b => <Approval key={b.approval?.id ?? b.name} b={b} />)}
      </div>

      {(status || error) && (
        <div className={clsx('shrink-0 px-3 py-1 text-[11px] flex items-center gap-1.5', error ? 'text-red-400' : 'text-[var(--text-muted)]')}>
          {!error && <Loader2 className="w-3 h-3 animate-spin" />}{error || status}
        </div>
      )}

      <div className="shrink-0 p-2 border-t border-[var(--border-subtle)] flex items-end gap-1.5">
        <button onClick={() => setWithShot(v => !v)}
          className={clsx('p-1.5 rounded-lg border', withShot ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-hover)]' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
          aria-pressed={withShot} title={withShot ? 'A screenshot goes with this message' : 'Send a screenshot with this message'}>
          <Camera className="w-4 h-4" />
        </button>
        <textarea ref={input} value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} rows={1}
          placeholder={share ? `Ask about your screen…` : `Message ${agentName}…`}
          className="flex-1 resize-none max-h-28 min-h-[2rem] px-2.5 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[13px] outline-none focus:border-[var(--border-strong)]"
          style={{ fieldSizing: 'content' } as CSSProperties} />
        {busy ? (
          <button onClick={onStop} className="p-1.5 rounded-lg bg-[var(--bg-hover)] hover:opacity-80" aria-label="Stop" title="Stop">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={() => void submit()} disabled={!text.trim() || !!working}
            className="p-1.5 rounded-lg bg-[var(--accent)] text-white disabled:opacity-40" aria-label="Send" title="Send (Enter)">
            <ArrowUp className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** An approval the reply waits on. Allow/deny right here; questions and anything long open in the main window. */
function Approval({ b }: { b: ToolBlock }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const question = b.approval?.kind === 'question' || !!b.questions?.length;
  const title = b.approval?.title ?? (question ? 'A question for you' : `Allow ${TOOL_LABELS[b.name]?.[0] ?? b.name}?`);
  const answer = async (d: 'allow' | 'deny') => {
    setBusy(true); setError('');
    try { await api.answerApproval(b.approval!.id, d); } catch (e) { setError(errText(e)); setBusy(false); }
  };
  const showMain = () => window.focus();
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400"><ShieldQuestion className="w-3.5 h-3.5" />{title}</div>
      {b.approval?.detail && <div className="text-[11px] text-[var(--text-secondary)] line-clamp-4 whitespace-pre-wrap font-mono">{b.approval.detail}</div>}
      {error && <div className="text-[11px] text-red-400">{error.includes('admin-key-required') ? 'Only the signed-in owner can answer this.' : error}</div>}
      <div className="flex gap-1.5">
        {!question && b.approval && <>
          <button disabled={busy} onClick={() => answer('allow')} className="px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">Allow</button>
          <button disabled={busy} onClick={() => answer('deny')} className="px-2 py-0.5 rounded-md text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50">Deny</button>
        </>}
        <button onClick={showMain} className="px-2 py-0.5 rounded-md text-xs border border-[var(--border-strong)] hover:bg-[var(--bg-hover)]">
          {question ? 'Answer in Shell:B' : 'Details'}
        </button>
      </div>
    </div>
  );
}
