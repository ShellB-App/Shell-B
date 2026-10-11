import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Brain, Loader2, RotateCcw, ThumbsDown, ThumbsUp, Undo2, X } from 'lucide-react';
import { req } from '../api';
import type { Message, MessageFeedback } from '../types';
import { btn } from './common';
import { t as tx } from '../i18n';

// Thumbs on a reply, plus "what should be different?" (server/feedback.py). With "remember" ticked, the server
// distills a lasting preference rule into memory; a one-off complaint can instead be sent back as a retry.

const DOWN = [
  ['too-long', 'Too long'], ['too-short', 'Too shallow'], ['wrong', 'Wrong'], ['ignored', 'Ignored my instructions'],
  ['format', 'Too many lists'], ['tone', 'Wrong tone'], ['didnt-do', 'Talked instead of doing'],
] as const;
const RETRY_TEXT: Record<string, string> = {
  'too-long': 'shorter', 'too-short': 'more depth', wrong: 'fix what was wrong', ignored: 'follow my instructions exactly',
  format: 'fewer lists and headings', tone: 'a different tone', 'didnt-do': 'actually do it instead of describing it',
};

type Res = { feedback: MessageFeedback | null; why?: string };
const send = (b: { msgId: string; rating: 'up' | 'down' | null; reasons?: string[]; note?: string; remember?: boolean }) =>
  req<Res>('/api/feedback', { method: 'POST', body: JSON.stringify(b) });

/** Thumbs for the reply footer, and the box that opens below the reply. Returns both so they can sit apart. */
export function useFeedback(message: Message, onAsk: ((t: string) => void) | undefined, busy: boolean) {
  const [fb, setFb] = useState<MessageFeedback | null>(message.feedback ?? null);
  const [open, setOpen] = useState<'up' | 'down' | null>(null);
  useEffect(() => { setFb(message.feedback ?? null); }, [message.feedback]);

  const rate = async (r: 'up' | 'down') => {
    if (fb?.rating === r && !open) {  // clicking the chosen thumb again clears it
      setFb(null);
      await send({ msgId: message.id, rating: null }).catch(() => {});
      return;
    }
    setFb(f => ({ ...(f ?? { reasons: [], note: '', at: Date.now() }), rating: r }));
    setOpen(r);
    send({ msgId: message.id, rating: r }).catch(() => {});
  };

  const buttons = message.role === 'assistant' && message.status === 'complete' && (
    <>
      <button className={clsx(btn.icon, fb?.rating === 'up' && 'text-emerald-400')} title={tx('Good reply')} onClick={() => rate('up')}>
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button className={clsx(btn.icon, fb?.rating === 'down' && 'text-red-400')} title={tx('Bad reply: say what to change')} onClick={() => rate('down')}>
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </>
  );
  const box = open && (
    <FeedbackBox key={open} rating={open} initial={fb} busy={busy}
      onClose={() => setOpen(null)}
      onSent={r => setFb(r.feedback)}
      submit={(reasons, note, remember) => send({ msgId: message.id, rating: open, reasons, note, remember })}
      onRetry={onAsk && open === 'down' ? text => { setOpen(null); onAsk(text); } : undefined} />
  );
  return { buttons, box };
}

function FeedbackBox({ rating, initial, busy, onClose, onSent, submit, onRetry }: {
  rating: 'up' | 'down'; initial: MessageFeedback | null; busy: boolean; onClose: () => void; onSent: (r: Res) => void;
  submit: (reasons: string[], note: string, remember: boolean) => Promise<Res>; onRetry?: (text: string) => void;
}) {
  const [reasons, setReasons] = useState<string[]>(initial?.rating === rating ? initial.reasons : []);
  const [note, setNote] = useState(initial?.rating === rating ? initial.note : '');
  const [remember, setRemember] = useState(true);
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [result, setResult] = useState<Res | null>(null);
  const [undone, setUndone] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const said = reasons.length > 0 || note.trim().length > 0;

  const go = async () => {
    setState('sending');
    try {
      const r = await submit(reasons, note.trim(), remember && said);
      setResult(r); onSent(r); setState('done');
      if (!r.feedback?.learned && !(rating === 'down' && onRetry)) setTimeout(onClose, 900);
    } catch { setState('idle'); }
  };
  const retryText = () => {
    const bits = [...reasons.map(r => RETRY_TEXT[r]).filter(Boolean), note.trim()].filter(Boolean);
    return `That wasn't quite right. Please try again: ${bits.join('; ')}.`;
  };
  const learned = result?.feedback?.learned;

  return (
    <div className="mt-2 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2.5 text-xs"
      onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      {state !== 'done' ? (
        <>
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text-primary)] flex-1">{rating === 'down' ? tx('What should be different?') : tx('What did you like?')}</span>
            <button className={btn.icon} onClick={onClose} title={tx('Close')}><X className="w-3.5 h-3.5" /></button>
          </div>
          {rating === 'down' && (
            <div className="flex flex-wrap gap-1.5">
              {DOWN.map(([id, label]) => (
                <button key={id} onClick={() => setReasons(r => (r.includes(id) ? r.filter(x => x !== id) : [...r, id]))}
                  className={clsx('px-2 py-1 rounded-full border transition', reasons.includes(id)
                    ? 'border-[var(--accent)] bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <textarea ref={ref} rows={2} className={clsx(btn.input, 'resize-none text-xs')} value={note} onChange={e => setNote(e.target.value)}
            placeholder={rating === 'down' ? tx('Optional: say it in your own words, e.g. “just give me the table”') : tx('Optional: e.g. “keep explaining things conversationally like this”')}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); }} />
          <div className="flex flex-wrap items-center gap-2">
            <label className={clsx('flex items-center gap-1.5 text-[var(--text-secondary)] select-none', !said && 'opacity-50')}
              title={tx('Shell:B turns this into a lasting preference if it is about how you like answers in general')}>
              <input type="checkbox" checked={remember} disabled={!said} onChange={e => setRemember(e.target.checked)} className="accent-[var(--accent)]" />
              {tx('Remember this for next time')}
            </label>
            <span className="flex-1" />
            <button className={btn.primary} disabled={state === 'sending'} onClick={go}>
              {state === 'sending' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{said ? tx('Send') : tx('Just rate it')}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {learned && !undone ? (
            <div className="flex items-start gap-1.5 text-[var(--text-secondary)]">
              <Brain className="w-3.5 h-3.5 mt-px shrink-0 text-amber-400" />
              <span className="flex-1"><b className="text-[var(--text-primary)]">{learned.existing ? tx('Already known') : tx('Learned')}:</b> {tx(learned.text)}</span>
              {!learned.existing && (
                <button className="inline-flex items-center gap-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  onClick={async () => { await req(`/api/memory/${learned.id}/undo`, { method: 'POST' }).catch(() => {}); setUndone(true); }}>
                  <Undo2 className="w-3 h-3" />{tx('Undo')}
                </button>
              )}
            </div>
          ) : (
            <div className="text-[var(--text-muted)]">
              {undone ? 'Forgotten.' : result?.why === 'one-off' ? tx('Thanks. That sounds specific to this answer, so nothing was added to memory.')
                : result?.why === 'vague' ? tx('Thanks. To remember it for next time, add a note saying what you’d like instead.')
                : result?.why || tx('Thanks for the feedback.')}
            </div>
          )}
          <div className="flex items-center gap-2">
            {onRetry && said && <button className={btn.subtle} disabled={busy} onClick={() => onRetry(retryText())}><RotateCcw className="w-3.5 h-3.5" />{tx('Try again with this feedback')}</button>}
            <span className="flex-1" />
            <button className={btn.ghost} onClick={onClose}>{tx('Done')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
