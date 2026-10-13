import { useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { t } from '../i18n';
import type { Agent } from '../types';
import type { Suggestion } from '../suggestions';
import { APPS, GROUP_LABEL, type AppGroup, type AppId } from './apps';
import { AgentAvatar } from './common';

/**
 * The empty chat: the agent's own starter cards, then "What Shell:B can do" for people who don't know yet. Three tabs:
 * Try something (everyday tasks, each answered by the agent best at it), Agents (who is who) and Apps (everything on the
 * rail and in All apps). People who know their way around hide it once; that and the tab are remembered per browser.
 */

interface Starter { title: string; blurb: string; prompt: string; agent: string }

// Everyday tasks across the range of people who use Shell:B. General on purpose: this screen can be seen by anyone.
const STARTERS: Starter[] = [
  { agent: 'shellb', title: 'Prepare for a job interview', blurb: 'A practice run with feedback after each answer.',
    prompt: "Run a mock job interview with me. First ask me about the role and the organisation, then ask one question at a time and give me honest feedback after each answer." },
  { agent: 'shellb', title: 'Polish a cover letter', blurb: 'Matched to the job ad, still in your voice.',
    prompt: 'I will paste a cover letter and the job ad it is for. Tighten the letter, match it to what the ad asks for, and keep my voice.' },
  { agent: 'thalassa', title: 'Identify a sea creature', blurb: 'Species names checked against the World Register of Marine Species.',
    prompt: 'Help me identify a marine animal. I will tell you where I saw it, its size, colour and shape. Give me the likely species with scientific names and how to tell them apart.' },
  { agent: 'mimir', title: 'Step back into the Neolithic', blurb: 'Ancient sites, skies and coastlines, worked out on this machine.',
    prompt: 'When Newgrange was built, about 5,200 years ago, where did the midwinter sun rise as seen from it, and how different was the sea level then?' },
  { agent: 'shellb', title: 'Get notes on my writing', blurb: "An editor's read on pacing, voice and clarity.",
    prompt: "I will paste a passage from something I am writing. Give me an editor's notes on pacing, voice and clarity, then suggest three lines I could cut." },
  { agent: 'minerva', title: 'Research a topic in depth', blurb: 'A report built from many sources, with citations.',
    prompt: 'Research a topic in depth for me: search widely, read the primary sources and write a short report with citations. Ask me for the topic first.' },
  { agent: 'shellb', title: 'Summarise a long document', blurb: 'The key points, decisions and deadlines.',
    prompt: 'I will attach a long document. Summarise it in one paragraph, then list the decisions, deadlines and open questions in it.' },
  { agent: 'nyx', title: 'Make a picture', blurb: 'Images, music and sound effects, made locally.',
    prompt: 'Paint a watercolour of a quiet harbour at dawn: fishing boats, gulls and soft pastel light.' },
  { agent: 'spark', title: 'Get a quick answer', blurb: 'Fast replies for small questions.',
    prompt: 'Convert 180 °C to Fahrenheit, and tell me which gas mark that is.' },
];

// each grid numbers its own cards in themes that number them (synthfield's 01, 02…)
const NUMBERED = { counterReset: 'sf-mission' };

// opt-in agents stay in the agent menu but are never advertised on a screen others can see
const NOT_SHOWCASED = new Set(['aphrodite']);
const APP_GROUPS: AppGroup[] = ['make', 'know', 'run'];

type Tab = 'try' | 'agents' | 'apps';
const KEY = 'shellb.home';
interface Prefs { hidden?: boolean; tab?: Tab }
const readPrefs = (): Prefs => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Prefs; } catch { return {}; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };

const card = 'sf-card rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] transition group text-left';

export function NewChatHome({ agent, agents, quick, greeting, onSend, onStart, onSelectAgent, onOpenApp }: {
  agent: Agent;
  agents: Agent[];
  quick: Suggestion[];
  greeting: string;
  /** a starter card for the agent on screen */
  onSend: (prompt: string) => void;
  /** a "Try something" card: switch the new chat to that agent, then send */
  onStart: (agent: Agent, prompt: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onOpenApp: (app: AppId) => void;
}) {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const tab = prefs.tab ?? 'try';
  const update = (p: Prefs) => { const next = { ...prefs, ...p }; setPrefs(next); savePrefs(next); };
  const top = useRef<HTMLDivElement>(null);

  const showcased = agents.filter(a => !a.unavailable && !NOT_SHOWCASED.has(a.id));
  const byId = new Map(showcased.map(a => [a.id, a]));
  const starters = STARTERS.flatMap(s => { const a = byId.get(s.agent); return a ? [{ ...s, a }] : []; });
  const local = showcased.filter(a => !a.cloud), cloud = showcased.filter(a => a.cloud);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'try', label: t('Try something') }, { id: 'agents', label: t('Agents') }, { id: 'apps', label: t('Apps') },
  ];

  const agentCard = (a: Agent) => (
    <button key={a.id} onClick={() => { onSelectAgent(a); top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}
      aria-pressed={a.id === agent.id} title={t('Chat with {name}', { name: a.name })}
      className={clsx(card, 'p-3 flex gap-3 items-start', a.id === agent.id && 'border-[var(--accent)]')}>
      <AgentAvatar agent={a} size={32} className="rounded-lg mt-0.5" />
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-xs font-semibold group-hover:text-[var(--accent-soft)] transition">{a.name}</span>
          <span className="text-[11px] text-[var(--text-muted)]">{t(a.title)}</span>
          {a.id === agent.id && <span className="text-[10px] px-1.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)]">{t('In use')}</span>}
        </span>
        <span className="block text-[12px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{a.description}</span>
      </span>
    </button>
  );

  return (
    <div ref={top} className="sf-hero max-w-3xl mx-auto px-4 min-h-full flex flex-col items-center justify-center text-center py-10 animate-fade-in">
      <AgentAvatar agent={agent} size={56} className="rounded-2xl shadow-xl mb-4" />
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{greeting}.</h1>
      <p className="text-sm text-[var(--text-secondary)] mt-2 max-w-md">
        <span className="font-medium text-[var(--text-primary)]">{agent.name}</span> · {agent.description}
      </p>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-2xl text-left">
        {quick.map(q => (
          <button key={q.title} onClick={() => onSend(q.prompt)} className={clsx(card, 'p-3.5')}>
            <div className="text-xs font-semibold group-hover:text-[var(--accent-soft)] transition">{q.title}</div>
            <div className="text-[12px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{q.prompt}</div>
          </button>
        ))}
      </div>

      {prefs.hidden ? (
        <button onClick={() => update({ hidden: false })}
          className="mt-8 inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition">
          {t('Show what Shell:B can do')} <ChevronDown className="w-3.5 h-3.5" />
        </button>
      ) : (
        <section aria-label={t('What Shell:B can do')} className="mt-10 w-full text-left">
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <h2 className="text-sm font-semibold">{t('What Shell:B can do')}</h2>
            <div role="tablist" className="flex gap-1 p-0.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
              {tabs.map(x => (
                <button key={x.id} role="tab" aria-selected={tab === x.id} onClick={() => update({ tab: x.id })}
                  className={clsx('px-2.5 py-1 rounded-md text-xs transition',
                    tab === x.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                  {x.label}
                </button>
              ))}
            </div>
            <button onClick={() => update({ hidden: true })} title={t('Hide this until you show it again')}
              className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition">
              {t('Hide')} <ChevronUp className="w-3.5 h-3.5" />
            </button>
          </div>

          {tab === 'try' && (
            <div role="tabpanel" style={NUMBERED} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {starters.map(s => (
                <button key={s.title} onClick={() => onStart(s.a, t(s.prompt))} title={t(s.prompt)} className={clsx(card, 'p-3 flex flex-col')}>
                  <span className="text-xs font-semibold group-hover:text-[var(--accent-soft)] transition">{t(s.title)}</span>
                  <span className="text-[12px] text-[var(--text-secondary)] mt-0.5 flex-1">{t(s.blurb)}</span>
                  <span className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                    <AgentAvatar agent={s.a} size={14} className="rounded" /> {s.a.name}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tab === 'agents' && (
            <div role="tabpanel">
              <p className="text-[12px] text-[var(--text-secondary)] mb-2.5">
                {t('Each agent is good at something different. Pick one for this chat, or type @ and a name to ask one for a single reply.')}
              </p>
              <div style={NUMBERED} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">{local.map(agentCard)}</div>
              {cloud.length > 0 && (<>
                <h3 className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-4 mb-2">{t('Cloud')}</h3>
                <div style={NUMBERED} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">{cloud.map(agentCard)}</div>
              </>)}
              <button onClick={() => onOpenApp('agents')} className="mt-3 text-xs text-[var(--accent-soft)] hover:underline">
                {t('Create or tune agents in the Agent Lab')}
              </button>
            </div>
          )}

          {tab === 'apps' && (
            <div role="tabpanel" className="space-y-4">
              {APP_GROUPS.map(g => {
                const apps = APPS.filter(a => a.group === g);
                if (!apps.length) return null;
                return (
                  <div key={g}>
                    <h3 className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">{t(GROUP_LABEL[g])}</h3>
                    <div style={NUMBERED} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {apps.map(a => {
                        const Icon = a.icon;
                        return (
                          <button key={a.id} onClick={() => onOpenApp(a.id)} className={clsx(card, 'p-3 flex gap-2.5 items-start')}>
                            <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: a.tint }} />
                            <span className="min-w-0">
                              <span className="block text-xs font-semibold group-hover:text-[var(--accent-soft)] transition">{t(a.label)}</span>
                              <span className="block text-[12px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{t(a.hint)}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <p className="sf-tagline mt-8 text-[11px] text-[var(--text-muted)]">{t('Overthink. Overcomplicate. Overengineer.')}</p>
    </div>
  );
}
