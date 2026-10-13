import { t } from '../../i18n';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Cpu,
  ListChecks,
  MoreHorizontal,
  Pin,
  Search,
  Store,
} from 'lucide-react';
import type { Agent, Effort, ModelInfo } from '../../types';
import { AgentAvatar } from '../common';
import { matchesAgent, openAgentStore, quickAgents, recordAgentPick, resetAgentPins, toggleAgentPin, useAgentPicks } from '../../agentPicks';

export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: 'off', label: 'Instant', hint: 'No deliberation' },
  { id: 'low', label: 'Low', hint: 'Quick answers' },
  { id: 'medium', label: 'Think', hint: 'Reason before answering' },
  { id: 'high', label: 'Deep', hint: 'Reason carefully and double-check' },
];

interface ComposerMenusProps {
  agent: Agent;
  agents: Agent[];
  onAgent: (a: Agent) => void;
  model?: ModelInfo;
  modelChoices?: ModelInfo[];
  onModel?: (name: string) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  canThink: boolean;
  planMode?: boolean;
  onPlanMode?: (on: boolean) => void;
}

export function ComposerMenus({
  agent,
  agents,
  onAgent,
  model,
  modelChoices = [],
  onModel,
  effort,
  onEffort,
  canThink,
  planMode,
  onPlanMode,
}: ComposerMenusProps) {
  const [menu, setMenu] = useState<'agent' | 'effort' | 'model' | null>(null);
  const [cloudOpen, setCloudOpen] = useState(false);
  // 'quick': the pinned or most-used agents; 'all': every agent, searchable, with pins
  const [view, setView] = useState<'quick' | 'all'>('quick');
  const [query, setQuery] = useState('');
  const picks = useAgentPicks();

  useEffect(() => {
    if (menu !== 'agent') {
      setCloudOpen(false);
      setView('quick');
      setQuery('');
    }
  }, [menu]);

  const quick = quickAgents(agents, picks);
  // the agent in use always shows, even when it isn't pinned (a cloud one already shows on the Cloud row)
  if (!agent.cloud && !quick.some(a => a.id === agent.id) && agents.some(a => a.id === agent.id)) quick.unshift(agent);
  const quickIds = quick.map(a => a.id);
  const cloudAgents = agents.filter(a => a.cloud && !quickIds.includes(a.id));
  const hidden = agents.length - quick.length - cloudAgents.length;
  const found = [...agents.filter(a => !a.cloud), ...agents.filter(a => a.cloud)].filter(a => matchesAgent(a, query));

  const choose = (a: Agent) => {
    recordAgentPick(a.id);
    onAgent(a);
    setMenu(null);
  };

  const agentItem = (a: Agent) => (
    <button
      key={a.id}
      role="menuitem"
      title={a.unavailable || a.description}
      onClick={() => choose(a)}
      className={clsx(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition',
        a.id === agent.id ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]'
      )}
    >
      <AgentAvatar agent={a} size={20} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold truncate">
          {a.name} <span className="font-normal text-[var(--text-muted)]">· {a.title}</span>
          {a.cloud && <Cloud className="inline w-3 h-3 ml-1 -mt-0.5 text-sky-400" aria-label={t('Cloud')} />}
        </span>
        <span className="block text-[11px] text-[var(--text-muted)] truncate">
          {a.unavailable || a.description}
        </span>
      </span>
    </button>
  );

  const pinnedRow = (a: Agent) => {
    const pinned = quickIds.includes(a.id);
    return (
      <div key={a.id} className="flex items-center gap-0.5">
        <div className="min-w-0 flex-1">{agentItem(a)}</div>
        <button
          onClick={() => toggleAgentPin(a.id, quickIds)}
          aria-pressed={pinned}
          title={pinned ? t('Remove from the menu') : t('Show in the menu')}
          aria-label={pinned ? t('Remove {name} from the menu', { name: a.name }) : t('Show {name} in the menu', { name: a.name })}
          className={clsx(
            'shrink-0 p-1.5 rounded-lg transition hover:bg-[var(--bg-hover)]',
            pinned ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] opacity-50 hover:opacity-100'
          )}
        >
          <Pin className={clsx('w-3.5 h-3.5', pinned && 'fill-current')} />
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        {/* Agent picker */}
        <div className="relative">
          <button
            onClick={() => setMenu(menu === 'agent' ? null : 'agent')}
            className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-xs transition"
            aria-haspopup="menu"
          >
            <AgentAvatar agent={agent} size={16} />
            <span className="font-medium">{agent.name}</span>
            <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
          </button>
          {menu === 'agent' && (
            <div
              className={clsx(
                'absolute bottom-full left-0 mb-1.5 w-72 max-w-[calc(100vw-2rem)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1 z-40 animate-fade-in',
                view === 'all' && 'sm:w-80'
              )}
              role="menu"
            >
              {view === 'all' ? (
                <>
                  <div className="flex items-center gap-1 p-0.5">
                    <button
                      onClick={() => { setView('quick'); setQuery(''); }}
                      className="shrink-0 p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                      aria-label={t('Back')}
                      title={t('Back')}
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <label className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                      <Search className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                      <input
                        autoFocus
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && found[0]) choose(found[0]);
                          if (e.key === 'Escape') setMenu(null);
                        }}
                        placeholder={t('Search agents')}
                        aria-label={t('Search agents')}
                        className="w-full min-w-0 bg-transparent text-xs placeholder-[var(--text-muted)] focus:outline-none"
                      />
                    </label>
                  </div>
                  <div className="max-h-[min(55vh,26rem)] overflow-y-auto mt-0.5">
                    {found.map(pinnedRow)}
                    {found.length === 0 && (
                      <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">{t('No agent matches')}</div>
                    )}
                  </div>
                  <div className="mt-1 pt-1 border-t border-[var(--border-subtle)] flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--text-muted)]">
                    <span className="flex-1 min-w-0">
                      {picks.pinned ? t('Pinned agents show in the menu') : t('The menu shows your most-used agents; pin some to choose')}
                    </span>
                    {picks.pinned && (
                      <button onClick={resetAgentPins} className="shrink-0 underline hover:text-[var(--text-primary)]">
                        {t('Use most-used')}
                      </button>
                    )}
                  </div>
                  <button
                    role="menuitem"
                    onClick={() => { setMenu(null); openAgentStore(); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs font-semibold transition hover:bg-[var(--bg-hover)]"
                  >
                    <Store className="w-3.5 h-3.5 text-[var(--accent)]" />
                    {t('Browse the Agent Store')}
                  </button>
                </>
              ) : (
              <>
              <div className="max-h-[min(60vh,30rem)] overflow-y-auto">
                {quick.map(agentItem)}
              </div>
              {cloudAgents.length > 0 && (
                <div
                  className="relative"
                  onMouseEnter={() => setCloudOpen(true)}
                  onMouseLeave={() => setCloudOpen(false)}
                >
                  {quick.length > 0 && <div className="my-1 border-t border-[var(--border-subtle)]" />}
                  <button
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={cloudOpen}
                    onClick={() => setCloudOpen(o => !o)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition',
                      cloudOpen ? 'bg-[var(--bg-hover)]' : agent.cloud && !quickIds.includes(agent.id) ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]'
                    )}
                  >
                    <span className="w-5 h-5 rounded-full bg-sky-500/15 flex items-center justify-center shrink-0">
                      <Cloud className="w-3.5 h-3.5 text-sky-400" />
                    </span>
                    <span className="flex-1 min-w-0 text-xs font-semibold">
                      Cloud{' '}
                      <span className="font-normal text-[var(--text-muted)]">
                        · {agent.cloud && !quickIds.includes(agent.id) ? agent.name : `${cloudAgents.length} agent${cloudAgents.length === 1 ? '' : 's'}`}
                      </span>
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </button>
                  {cloudOpen && (
                    <div className="absolute bottom-0 left-0 sm:left-full w-[17.5rem] sm:w-72 sm:pl-1.5 z-50">
                      <div
                        className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1 max-h-[60vh] overflow-y-auto animate-fade-in"
                        role="menu"
                        aria-label="Cloud agents"
                      >
                        <button
                          onClick={() => setCloudOpen(false)}
                          className="sm:hidden w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          Back
                        </button>
                        {cloudAgents.map(agentItem)}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                role="menuitem"
                onClick={() => { setCloudOpen(false); setView('all'); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition hover:bg-[var(--bg-hover)]"
              >
                <span className="w-5 h-5 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
                  <MoreHorizontal className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                </span>
                <span className="flex-1 min-w-0 text-xs font-semibold">
                  {t('More agents')}
                  {hidden > 0 && <span className="font-normal text-[var(--text-muted)]"> · {t('{n} more', { n: hidden })}</span>}
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </button>
              </>
              )}
            </div>
          )}
        </div>

        {/* Model choices for cloud agents */}
        {onModel && modelChoices.length > 1 && (
          <div className="relative">
            <button
              onClick={() => setMenu(menu === 'model' ? null : 'model')}
              title="Model for this agent"
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] transition max-w-[11rem]"
            >
              <Cpu className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {model?.label ?? model?.name.split('/').slice(1).join('/') ?? agent.model}
              </span>
              <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
            </button>
            {menu === 'model' && (
              <div
                className="absolute bottom-full left-0 mb-1.5 w-64 max-h-[50vh] overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1 z-40 animate-fade-in"
                role="menu"
              >
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {agent.name} model
                </div>
                {modelChoices.map(m => (
                  <button
                    key={m.name}
                    role="menuitemradio"
                    aria-checked={m.name === model?.name}
                    onClick={() => {
                      onModel(m.name);
                      setMenu(null);
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition',
                      m.name === model?.name ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]'
                    )}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium truncate">{m.label ?? m.name}</span>
                      <span className="block text-[10px] font-mono text-[var(--text-muted)] truncate">
                        {m.name}
                        {m.name === agent.model ? ' · default' : ''}
                      </span>
                    </span>
                    {m.name === model?.name && (
                      <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reasoning effort picker */}
        <div className="relative">
          <button
            onClick={() => canThink && setMenu(menu === 'effort' ? null : 'effort')}
            disabled={!canThink}
            title={canThink ? t('Reasoning effort') : t("{model} doesn't have a thinking mode", { model: model?.name ?? '' })}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] transition disabled:opacity-40 disabled:hover:bg-[var(--bg-tertiary)]"
          >
            <Brain
              className={clsx(
                'w-3 h-3',
                canThink && (effort === 'medium' || effort === 'high') ? 'text-[var(--accent)]' : ''
              )}
            />
            <span>{canThink ? t(EFFORTS.find(e => e.id === effort)?.label ?? '') : t('No thinking')}</span>
          </button>
          {menu === 'effort' && (
            <div
              className="absolute bottom-full left-0 mb-1.5 w-56 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1 z-40 animate-fade-in"
              role="menu"
            >
              {EFFORTS.map(e => (
                <button
                  key={e.id}
                  role="menuitemradio"
                  aria-checked={e.id === effort}
                  onClick={() => {
                    onEffort(e.id);
                    setMenu(null);
                  }}
                  className={clsx(
                    'w-full flex flex-col px-2.5 py-1.5 rounded-lg text-left transition',
                    e.id === effort ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]'
                  )}
                >
                  <span className="text-xs font-medium">{t(e.label)}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{t(e.hint)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Plan Mode toggle */}
        {onPlanMode && (
          <button
            onClick={() => onPlanMode(!planMode)}
            aria-pressed={!!planMode}
            title={
              planMode
                ? t('Plan mode is on: read-only research, then a plan for you to approve (Shift+Tab to turn off)')
                : t('Plan mode: research read-only and propose a plan before changing anything (Shift+Tab)')
            }
            className={clsx(
              'flex items-center gap-1 px-2 py-1 rounded-lg border text-xs transition',
              planMode
                ? 'bg-[var(--accent)]/15 border-[var(--accent)]/50 text-[var(--accent-soft)]'
                : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            <ListChecks className="w-3 h-3" />
            <span>{t('Plan')}</span>
          </button>
        )}
      </div>

      {menu && <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />}
    </>
  );
}
