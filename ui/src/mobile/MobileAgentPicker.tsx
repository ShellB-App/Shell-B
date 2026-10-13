import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, X, Sparkles, Cloud, Search, Store } from 'lucide-react';
import type { Agent } from '../types';
import { AgentAvatar } from '../components/common';
import { matchesAgent, openAgentStore, recordAgentPick } from '../agentPicks';
import { t } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  activeId: string;
  onSelect: (agent: Agent) => void;
}

export function MobileAgentPicker({ open, onClose, agents, activeId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-primary)] border-t border-[var(--border-subtle)] rounded-t-2xl max-h-[80vh] flex flex-col overflow-hidden animate-slide-up pb-[env(safe-area-inset-bottom)]"
        onClick={e => e.stopPropagation()}
      >
        <header className="h-12 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--accent)]" />
            <span className="text-sm font-semibold">Select Agent</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {agents.length > 6 && (
          <label className="shrink-0 mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <Search className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('Search agents')}
              aria-label={t('Search agents')}
              className="w-full min-w-0 bg-transparent text-base placeholder-[var(--text-muted)] focus:outline-none"
            />
          </label>
        )}

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {agents.filter(a => matchesAgent(a, query)).map(a => {
            const active = a.id === activeId;
            return (
              <button
                key={a.id}
                onClick={() => {
                  recordAgentPick(a.id);
                  onSelect(a);
                  onClose();
                }}
                className={clsx(
                  'w-full flex items-start gap-3 p-3 rounded-xl border text-left transition',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/30'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                <AgentAvatar agent={a} size={28} className="mt-0.5 rounded-lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{a.name}</span>
                    {a.cloud ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center gap-1">
                        <Cloud className="w-2.5 h-2.5" /> Cloud
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        Local
                      </span>
                    )}
                    {active && <Check className="w-4 h-4 text-[var(--accent)] ml-auto" />}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2 leading-relaxed">
                    {a.description}
                  </p>
                  <div className="mt-1.5 text-[10px] font-mono text-[var(--text-muted)]">
                    {a.model}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => { onClose(); openAgentStore(); }}
          className="shrink-0 mx-3 mb-3 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-sm font-medium hover:bg-[var(--bg-hover)]"
        >
          <Store className="w-4 h-4 text-[var(--accent)]" />
          {t('Browse the Agent Store')}
        </button>
      </div>
    </div>
  );
}
