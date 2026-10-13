import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Sparkles, X } from 'lucide-react';
import { api } from '../api';
import type { Onboarding } from '../types';
import { t } from '../i18n';
import { btn } from './common';

/**
 * The first-visit welcome and the What's new card, both shown on the new chat page (server/onboarding.py remembers
 * them per person, across devices). The welcome is three short screens and always skippable; its last button leads to
 * the page's own "What Shell:B can do" section rather than repeating it. What's new lists the `news` lines of
 * docs/changelog.json the person hasn't seen, once. Everyone gets the same two things.
 */

let pending: Promise<Onboarding> | undefined; // one request per page load; the new chat page mounts again for every chat

export function useOnboarding() {
  const [state, setState] = useState<Onboarding>();
  useEffect(() => {
    let live = true;
    pending ??= api.onboarding().catch(() => ({ welcome: false, news: [] }));
    pending.then(s => { if (live) setState(s); });
    return () => { live = false; };
  }, []);
  const update = (s: Onboarding) => { pending = Promise.resolve(s); setState(s); };
  return {
    welcome: !!state?.welcome,
    news: state?.welcome ? [] : state?.news ?? [],
    /** finished or skipped: the welcome counts as the introduction, so nothing older shows as new afterwards */
    doneWelcome: () => { api.onboardingSeen('welcome').catch(() => {}); update({ welcome: false, news: [] }); },
    closeNews: () => update({ welcome: false, news: [] }),
  };
}

// a function so the i18n scan sees each string and the language can change between visits
const steps = () => [
  { title: t('Welcome to Shell:B'),
    body: t('Shell:B is an AI assistant that runs on its own computer, not in a company’s cloud. Type a question or a task in the box at the bottom, and send it.') },
  { title: t('Agents for different jobs'),
    body: t('Each agent is good at something different: writing, research, the sea, the distant past, pictures. Pick one in the agent menu by the message box, or type @ and a name.') },
  { title: t('Start with an example'),
    body: t('Below each new chat, What Shell:B can do lists everyday things to try, every agent and every app. Pick one and Shell:B takes it from there.') },
];

export function Welcome({ onDone, onShowMe }: { onDone: () => void; onShowMe: () => void }) {
  const [step, setStep] = useState(0);
  const all = steps(), last = step === all.length - 1;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onDone]);
  const s = all[step];
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4 text-left">
      <div role="dialog" aria-modal aria-labelledby="welcome-title"
        className="w-full max-w-md rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-5 animate-fade-in">
        <h2 id="welcome-title" className="text-base font-semibold tracking-tight">{s.title}</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-2 leading-relaxed min-h-[4.5rem]">{s.body}</p>
        <div className="mt-5 flex items-center gap-2">
          <button onClick={onDone} className={btn.ghost}>{t('Skip')}</button>
          <span className="flex-1 flex justify-center gap-1.5" aria-label={t('Step {n} of {total}', { n: step + 1, total: all.length })}>
            {all.map((_, i) => (
              <span key={i} className={clsx('w-1.5 h-1.5 rounded-full', i === step ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]')} />
            ))}
          </span>
          {step > 0 && <button onClick={() => setStep(step - 1)} className={btn.subtle}>{t('Back')}</button>}
          {last
            ? <button autoFocus onClick={() => { onDone(); onShowMe(); }} className={btn.primary}>{t('Show me')}</button>
            : <button autoFocus onClick={() => setStep(step + 1)} className={btn.primary}>{t('Next')}</button>}
        </div>
      </div>
    </div>
  );
}

export function WhatsNew({ news, onClose, onSeeAll }: { news: Onboarding['news']; onClose: () => void; onSeeAll: () => void }) {
  useEffect(() => { api.onboardingSeen('news').catch(() => {}); }, []); // shown once: stays up on this page until closed
  return (
    <section aria-label={t("What's new")}
      className="mt-6 w-full max-w-2xl text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3.5">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-[var(--accent-soft)]" />
        <h2 className="text-xs font-semibold flex-1">{t("What's new")}</h2>
        <button onClick={onClose} title={t('Close')} aria-label={t('Close')} className={btn.icon}><X className="w-3.5 h-3.5" /></button>
      </div>
      <ul className="mt-1.5 space-y-1 text-[12.5px] text-[var(--text-secondary)] list-disc pl-5">
        {news.map(n => <li key={n.title}>{t(n.news)}</li>)}
      </ul>
      <button onClick={() => { onClose(); onSeeAll(); }} className="mt-2 text-xs text-[var(--accent-soft)] hover:underline">
        {t('See all changes')}
      </button>
    </section>
  );
}
