import { useState } from 'react';
import clsx from 'clsx';
import { Check, MessageCircleQuestion } from 'lucide-react';
import type { AskAnswer, Block } from '../types';
import { api } from '../api';
import { btn } from './common';
import { t } from '../i18n';

type ToolBlock = Extract<Block, { type: 'tool' }>;

/** The text an answer given after the turn ended is sent as (the same shape the tool hands back to the model). */
function answerText(b: ToolBlock, answers: AskAnswer[]) {
  return ['Answers to your questions:', ...b.questions!.map((q, i) => {
    const a = answers[i];
    const parts = [...(a.selected.length ? [a.selected.join(', ')] : []), ...(a.other ? [`in my own words: ${a.other}`] : [])];
    return `${i + 1}. ${q.question}\n   → ${parts.join('; ') || '(skipped)'}`;
  })].join('\n');
}

/** Multiple-choice questions an agent asked with ask_user. While the turn waits, answers go straight back to it; if
 *  the turn already ended unanswered (timed out or stopped), they're sent as the next chat message instead. Every
 *  question also takes a typed answer. */
export function QuestionCard({ b, live, isLast, busy, onAsk }: {
  b: ToolBlock; live: boolean; isLast: boolean; busy: boolean; onAsk?: (text: string) => void;
}) {
  const qs = b.questions!;
  const waiting = live && b.status === 'approval' && b.approval?.kind === 'question';
  const late = !b.answers && !waiting && !live && isLast && !!onAsk && b.decision !== 'deny';
  const open = waiting || late;
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []));
  const [other, setOther] = useState<string[]>(() => qs.map(() => ''));
  const [useOther, setUseOther] = useState<boolean[]>(() => qs.map(() => false));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const shown: AskAnswer[] = b.answers ?? qs.map((_, i) => ({ selected: picked[i], other: useOther[i] ? other[i].trim() : '' }));
  const complete = shown.every(a => a.selected.length > 0 || a.other);

  const submit = async (answers: AskAnswer[]) => {
    setSending(true); setError('');
    try {
      if (waiting) await api.answerQuestion(b.approval!.id, answers);
      else onAsk?.(answerText(b, answers));
    } catch (e) {
      setError(String(e).includes('admin-key-required') ? 'Only the signed-in owner can answer this.' : String(e));
      setSending(false);
    }
  };
  const skip = async () => {
    setSending(true); setError('');
    try { await api.answerApproval(b.approval!.id, 'deny'); } catch (e) { setError(String(e)); setSending(false); }
  };

  const choose = (qi: number, label: string) => {
    if (!open || sending || (late && busy)) return;
    const q = qs[qi];
    if (q.multiSelect) {
      setPicked(p => p.map((s, i) => i !== qi ? s : s.includes(label) ? s.filter(x => x !== label) : [...s, label]));
      return;
    }
    setPicked(p => p.map((s, i) => i === qi ? [label] : s));
    setUseOther(u => u.map((v, i) => i === qi ? false : v));
    if (qs.length === 1) void submit([{ selected: [label], other: '' }]);  // one single-choice question: a click answers it
  };
  const toggleOther = (qi: number, on: boolean) => {
    setUseOther(u => u.map((v, i) => i === qi ? on : v));
    if (on && !qs[qi].multiSelect) setPicked(p => p.map((s, i) => i === qi ? [] : s));
  };

  return (
    <div className={clsx('my-2 rounded-xl border overflow-hidden', open ? 'border-[var(--accent)]/40 bg-[var(--bg-secondary)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60')}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs border-b border-[var(--border-subtle)]">
        <MessageCircleQuestion className={clsx('w-3.5 h-3.5 shrink-0', open ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
        <span className={clsx('font-medium', open ? 'text-[var(--accent-soft)]' : 'text-[var(--text-secondary)]')}>
          {waiting ? (qs.length > 1 ? t('{length} questions for you', { length: qs.length }) : t('A question for you'))
            : late ? t('Unanswered: your answer will be sent as a new message')
              : b.answers ? t('You answered') : b.decision === 'deny' ? t('Skipped') : t('Not answered')}
        </span>
      </div>

      <div className="px-3 py-3 space-y-4">
        {qs.map((q, qi) => (
          <fieldset key={qi} className="space-y-1.5" disabled={!open || sending}>
            <legend className="flex items-start gap-2 text-sm font-medium mb-1.5">
              {q.header && <span className="mt-px px-1.5 py-px rounded-md text-[10px] font-semibold uppercase tracking-wide bg-[var(--accent)]/10 text-[var(--accent-soft)] border border-[var(--accent)]/25 shrink-0">{q.header}</span>}
              <span>{q.question}{q.multiSelect && <span className="ml-1.5 text-[11px] font-normal text-[var(--text-muted)]">{t('(pick any)')}</span>}</span>
            </legend>
            {q.options.map(o => {
              const on = shown[qi].selected.includes(o.label);
              return (
                <button key={o.label} type="button" onClick={() => choose(qi, o.label)} aria-pressed={on}
                  className={clsx('w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg border text-left transition',
                    on ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10' : 'border-[var(--border-subtle)]',
                    open && !on && 'hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]', !open && !on && 'opacity-50')}>
                  <span className={clsx('mt-0.5 w-4 h-4 shrink-0 flex items-center justify-center border',
                    q.multiSelect ? 'rounded' : 'rounded-full', on ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-fg)]' : 'border-[var(--border-strong)]')}>
                    {on && <Check className="w-3 h-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-[var(--text-primary)]">{t(o.label)}</span>
                    {o.description && <span className="block text-[11px] text-[var(--text-secondary)] mt-0.5">{t(o.description)}</span>}
                  </span>
                </button>
              );
            })}
            {open ? (
              <div className={clsx('flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border transition',
                useOther[qi] ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10' : 'border-[var(--border-subtle)] border-dashed')}>
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`other-${b.approval?.id ?? b.startedAt}-${qi}`} checked={useOther[qi]}
                  onChange={e => toggleOther(qi, e.target.checked)} className="accent-[var(--accent)] shrink-0" aria-label={t('Answer in my own words')} />
                <input value={other[qi]} placeholder={t('Other: type your own answer')}
                  onChange={e => { const v = e.target.value; setOther(o => o.map((x, i) => i === qi ? v : x)); toggleOther(qi, !!v.trim()); }}
                  onKeyDown={e => { if (e.key === 'Enter' && complete && !sending) { e.preventDefault(); void submit(shown); } }}
                  className="flex-1 min-w-0 bg-transparent text-[13px] placeholder-[var(--text-muted)] focus:outline-none py-0.5" />
              </div>
            ) : shown[qi].other ? (
              <div className="px-2.5 py-2 rounded-lg border border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[13px] whitespace-pre-wrap break-words">
                <span className="text-[11px] text-[var(--text-muted)] mr-1.5">{t('Own answer:')}</span>{shown[qi].other}
              </div>
            ) : null}
          </fieldset>
        ))}

        {error && <div className="text-[11px] text-red-400">{error}</div>}
        {open && (qs.length > 1 || qs[0].multiSelect || useOther[0]) && (
          <div className="flex items-center gap-1.5">
            <button className={btn.primary} disabled={!complete || sending || (late && busy)} onClick={() => submit(shown)}>
              {late ? t('Send answers') : t('Submit')}
            </button>
            {waiting && <button className={btn.ghost} disabled={sending} onClick={skip} title={t('Let the agent go ahead with its best judgment')}>{t('Skip')}</button>}
            {!complete && <span className="text-[11px] text-[var(--text-muted)]">{t('Answer every question to submit')}</span>}
          </div>
        )}
        {open && qs.length === 1 && !qs[0].multiSelect && !useOther[0] && waiting && (
          <button className={btn.ghost} disabled={sending} onClick={skip} title={t('Let the agent go ahead with its best judgment')}>{t('Skip')}</button>
        )}
      </div>
    </div>
  );
}
