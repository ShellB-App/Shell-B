import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { BrainCircuit, Cloud, Copy, Cpu, Network, Plus, RotateCcw, Save, Sparkles, Store, Trash2 } from 'lucide-react';
import type { Agent, Effort, ModelInfo, Skill, ToolInfo } from '../types';
import { api, fmtBytes } from '../api';
import { AgentAvatar, Modal, btn, toolIcon } from './common';
import { connectorIcon } from './Integrations';
import { t as tx } from '../i18n';
import { AgentStore } from './Gallery';
import { OPEN_AGENT_STORE, loadAgentPicks, pinAgent, quickAgents } from '../agentPicks';

const isCloudModel = (m: string) => /^(anthropic|gemini|openai|claude-code|antigravity|codex)\//.test(m);

/** Where an agent's model runs. Models on other machines are not a separate source: Models → Fleet routes local model
 * calls to them by name, so they appear under Local. */
type ModelSource = 'local' | 'cloud';
const SOURCES: { id: ModelSource; label: string; icon: typeof Cpu }[] = [
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
];
const sourceOf = (m: string): ModelSource => isCloudModel(m) ? 'cloud' : 'local';

const PALETTE: [string, string][] = [
  ['#c96442', '#da7756'], ['#0284c7', '#4f46e5'], ['#059669', '#0f766e'], ['#7c3aed', '#2563eb'],
  ['#a855f7', '#f43f5e'], ['#d97706', '#ea580c'], ['#475569', '#1e293b'], ['#db2777', '#9333ea'],
];

interface Props {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  tools: ToolInfo[];
  models: ModelInfo[];
  initialId?: string;
  onChanged: (focusId?: string) => void;
  /** start chatting with an agent (the Store's Chat button); the Lab closes */
  onChat?: (id: string) => void;
}

export function AgentLab({ open, onClose, agents, tools, models, initialId, onChanged, onChat }: Props) {
  // the Store (community agents) in place of the editor; "Browse the Agent Store" in the agent menu opens the Lab on it
  const [store, setStore] = useState(false);
  useEffect(() => {
    const on = () => setStore(true);
    window.addEventListener(OPEN_AGENT_STORE, on);
    return () => window.removeEventListener(OPEN_AGENT_STORE, on);
  }, []);
  useEffect(() => { if (!open) setStore(false); }, [open]);
  const [selId, setSelId] = useState<string | undefined>(initialId ?? agents[0]?.id);
  const [draft, setDraft] = useState<Agent | null>(null);
  const [ratings, setRatings] = useState<Record<string, { up: number; down: number }>>({});  // thumbs per agent, last 30 days (server/feedback.py)
  useEffect(() => { if (open) api.feedbackStats(30).then(setRatings).catch(() => setRatings({})); }, [open]);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [source, setSource] = useState<ModelSource>('local');
  useEffect(() => { if (open) api.skills().then(setSkills).catch(() => setSkills([])); }, [open]);

  useEffect(() => { if (open) { setSelId(initialId ?? agents[0]?.id); setIsNew(false); } }, [open, initialId]);
  useEffect(() => {
    if (isNew) return;
    const a = agents.find(x => x.id === selId) ?? agents[0];
    setDraft(a ? structuredClone(a) : null);
    setSource(a ? sourceOf(a.model) : 'local');
    setError('');
  }, [selId, agents, isNew]);

  if (!draft) return null;
  const original = agents.find(a => a.id === selId);
  const dirty = isNew || JSON.stringify(original) !== JSON.stringify(draft);
  const model = models.find(m => m.name === draft.model || `${m.name}:latest` === draft.model);
  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setDraft(d => (d ? { ...d, [k]: v } : d));
  const sourceModels = source === 'cloud' ? models.filter(m => m.cloud) : source === 'local' ? models.filter(m => !m.cloud) : [];
  const pickSource = (s: ModelSource) => {
    setSource(s);
    // switching between Local and Cloud moves the agent to that side's first model
    const list = s === 'cloud' ? models.filter(m => m.cloud) : s === 'local' ? models.filter(m => !m.cloud) : [];
    if (list.length && sourceOf(draft.model) !== s) set('model', list[0].name);
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const saved = await api.saveAgent(isNew ? draft.id : selId!, draft);
      setIsNew(false);
      setSelId(saved.id);
      onChanged(saved.id);
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };

  const startNew = (from?: Agent) => {
    const base: Agent = from ? { ...structuredClone(from), builtin: false } : {
      id: '', name: 'New Agent', title: 'Specialist', avatar: '◆', color: PALETTE[6], description: '',
      systemPrompt: 'You are a specialist agent inside Shell:B, a private local AI system.\n\n',
      model: 'ShellB-Swift', temperature: 0.6, effort: 'medium', tools: ['web_search', 'web_fetch'], builtin: false,
    };
    base.name = from ? `${from.name} copy` : base.name;
    base.id = `${(from?.id ?? 'agent')}-${Math.random().toString(36).slice(2, 6)}`;
    setIsNew(true);
    setDraft(base);
  };

  return (
    <Modal open={open} onClose={onClose} title={tx('Agent Lab')} icon={<BrainCircuit className="w-4 h-4 text-[var(--accent)]" />} wide>
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        <div className="sm:w-56 shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--border-subtle)] p-2 overflow-y-auto flex sm:flex-col gap-1">
          {agents.map(a => (
            <button key={a.id} onClick={() => { setStore(false); setIsNew(false); setSelId(a.id); }}
              className={clsx('flex items-center gap-2 px-2 py-1.5 rounded-lg text-left shrink-0 sm:w-full transition',
                !store && !isNew && a.id === selId ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]')}>
              <AgentAvatar agent={a} size={24} />
              <span className="min-w-0 hidden sm:block">
                <span className="block text-xs font-semibold truncate">{a.name}</span>
                <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] truncate">
                  {a.cloud && <Cloud className="w-2.5 h-2.5 text-sky-400 shrink-0" />}{a.model}
                </span>
              </span>
            </button>
          ))}
          <button onClick={() => { setStore(false); startNew(); }} className={clsx(btn.ghost, 'sm:w-full justify-center sm:mt-1 border border-dashed border-[var(--border-strong)] shrink-0')}>
            <Plus className="w-3.5 h-3.5" /><span className="hidden sm:inline">{tx('New agent')}</span>
          </button>
          <button onClick={() => setStore(true)} aria-pressed={store}
            className={clsx(btn.ghost, 'sm:w-full justify-center shrink-0 border', store ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]' : 'border-[var(--border-subtle)]')}>
            <Store className="w-3.5 h-3.5" /><span>{tx('Store')}</span>
          </button>
        </div>

        {store ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
            <AgentStore agents={agents} tools={tools}
              onInstalled={id => { pinAgent(id, quickAgents(agents, loadAgentPicks()).map(a => a.id)); onChanged(); }}
              onOpen={id => { setStore(false); setIsNew(false); setSelId(id); }}
              onChat={onChat ? id => { onChat(id); onClose(); } : undefined} />
          </div>
        ) : (<>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-5">
          <div className="flex items-start gap-3">
            <AgentAvatar agent={draft} size={48} className="rounded-xl" />
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_1fr_72px] gap-2">
              <label className="text-[11px] text-[var(--text-muted)]">{tx('Name')}
                <input className={btn.input} value={draft.name} onChange={e => set('name', e.target.value)} />
              </label>
              <label className="text-[11px] text-[var(--text-muted)]">{tx('Role')}
                <input className={btn.input} value={draft.title} onChange={e => set('title', e.target.value)} />
              </label>
              <label className="text-[11px] text-[var(--text-muted)]">{tx('Glyph')}
                <input className={clsx(btn.input, 'text-center')} maxLength={2} value={draft.avatar} onChange={e => set('avatar', e.target.value)} />
              </label>
            </div>
          </div>
          {!isNew && ratings[draft.id] && (ratings[draft.id].up || ratings[draft.id].down) ? (
            <div className="text-[11px] text-[var(--text-muted)]" title={tx('Thumbs under this agent\'s replies in the last 30 days (Activity → Memory digest has the repeated complaints)')}>
              {tx('Last 30 days: 👍 {up} · 👎 {down}', { up: ratings[draft.id].up, down: ratings[draft.id].down })}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            {PALETTE.map(c => (
              <button key={c.join()} onClick={() => set('color', c)} aria-label={tx('Color')}
                className={clsx('w-6 h-6 rounded-md ring-offset-2 ring-offset-[var(--bg-primary)]', draft.color.join() === c.join() && 'ring-2 ring-[var(--text-primary)]')}
                style={{ background: `linear-gradient(135deg, ${c[0]}, ${c[1]})` }} />
            ))}
          </div>

          <label className="block text-[11px] text-[var(--text-muted)]">{tx('Description')}
            <input className={btn.input} value={draft.description} onChange={e => set('description', e.target.value)} />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-[11px] text-[var(--text-muted)]">{tx('Model')}
              <div className="flex gap-2">
                <select className={clsx(btn.input, 'w-28 shrink-0')} value={source} onChange={e => pickSource(e.target.value as ModelSource)} aria-label={tx('Model source')}>
                  {SOURCES.map(o => <option key={o.id} value={o.id}>{tx(o.label)}</option>)}
                </select>
                  <select className={btn.input} value={model?.name ?? draft.model} onChange={e => set('model', e.target.value)}>
                    {!model && sourceOf(draft.model) === source && <option value={draft.model}>{draft.model} ({source === 'cloud' ? tx('cloud AI off or no key') : tx('not installed')})</option>}
                    {sourceOf(draft.model) !== source && <option value={draft.model} disabled>{tx('Pick a {source} model', { source: source })}</option>}
                    {!sourceModels.length && source === 'cloud' && <option disabled>{tx('Turn on Cloud AI and add a key or log in a CLI in Integrations')}</option>}
                    {sourceModels.map(m => (
                      <option key={m.name} value={m.name}>
                        {m.cloud ? `${m.label && m.label !== m.name.split('/')[1] ? `${m.label} · ` : ''}${m.name}` : `${m.name} · ${m.parameterSize} · ${fmtBytes(m.size)}`}
                      </option>
                    ))}
                  </select>
              </div>
              {source === 'local' && (
                <span className="mt-1 flex items-start gap-1 text-[10px] text-[var(--text-muted)]">
                  <Network className="w-3 h-3 shrink-0 mt-px" />
                  {tx('Other machines run these same models through')} <a className="underline hover:text-[var(--text-primary)]" href="#/models/fleet">{tx('Models → Fleet')}</a>.
                </span>
              )}
              {isCloudModel(draft.model) && (
                <span className="mt-1 flex items-start gap-1 text-[10px] text-sky-400">
                  <Cloud className="w-3 h-3 shrink-0 mt-px" />
                  {draft.unavailable || tx('Cloud model: this agent\'s conversations go to the provider. Its tools still run here.')}
                </span>
              )}
              {model && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {model.capabilities.filter(c => c !== 'completion').map(c => (
                    <span key={c} className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">{c}</span>
                  ))}
                  <span className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)]">ctx {(model.numCtx || 0).toLocaleString() || '?'} / {model.nativeCtx.toLocaleString()}</span>
                </span>
              )}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-[11px] text-[var(--text-muted)]">{tx('Reasoning')}
                <select className={btn.input} value={draft.effort} onChange={e => set('effort', e.target.value as Effort)}
                  disabled={!!model && !model.capabilities.includes('thinking')}>
                  <option value="off">{tx('Instant')}</option><option value="low">Low</option><option value="medium">{tx('Think')}</option><option value="high">{tx('Deep')}</option>
                </select>
              </label>
              <label className="block text-[11px] text-[var(--text-muted)]">{tx('Context tokens')}
                <input className={btn.input} type="number" step={4096} min={2048} placeholder={String(model?.numCtx || 'model default')}
                  value={draft.numCtx ?? ''} onChange={e => set('numCtx', e.target.value ? Number(e.target.value) : undefined)} />
              </label>
            </div>
          </div>

          <label className="block text-[11px] text-[var(--text-muted)]">
            <span className="flex justify-between">{tx('Temperature')} <span className="font-mono">{draft.temperature.toFixed(2)}</span></span>
            <input type="range" min={0} max={1.5} step={0.05} value={draft.temperature} onChange={e => set('temperature', Number(e.target.value))}
              className="w-full accent-[var(--accent)]" />
          </label>

          <div>
            <div className="text-[11px] text-[var(--text-muted)] mb-1.5">{tx('Tools')} <span className="opacity-75">{tx('(file and screenshot tools are added automatically in Studio projects)')}</span> {model && !model.capabilities.includes('tools') && <span className="text-amber-400">{tx('— this model can\'t call tools')}</span>}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {tools.filter(t => t.scope === 'agent' || t.category === 'mcp').map(t => {
                const Icon = t.category === 'mcp' ? connectorIcon(t.icon) : toolIcon(t.id);
                const on = draft.tools.includes(t.id);
                return (
                  <label key={t.id} className={clsx('flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition',
                    on ? 'border-[var(--accent)]/50 bg-[var(--accent)]/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>
                    <input type="checkbox" checked={on} className="mt-0.5 accent-[var(--accent)]"
                      onChange={() => set('tools', on ? draft.tools.filter(x => x !== t.id) : [...draft.tools, t.id])} />
                    <Icon className="w-3.5 h-3.5 mt-0.5 text-sky-400 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">
                        {t.displayName}
                        {t.category === 'mcp' && <span className="ml-1 px-1 rounded text-[9px] font-normal bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]">connector</span>}
                        {t.cloud && <Cloud className="inline w-3 h-3 ml-1 text-sky-400" />}
                        {!t.enabled && <span className="text-[var(--text-muted)] font-normal"> {tx('(disabled globally)')}</span>}
                      </span>
                      <span className="block text-[11px] text-[var(--text-muted)] leading-snug">{tx(t.description)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {tools.some(t => t.scope === 'global' || t.scope === 'group') && (
              <details className="mt-2 text-[11px] text-[var(--text-muted)]">
                <summary className="cursor-pointer select-none hover:text-[var(--text-primary)]">{tx('Added automatically (')}{tools.filter(t => t.scope === 'global' || t.scope === 'group').length} tools)</summary>
                <ul className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  {tools.filter(t => t.scope === 'global' || t.scope === 'group').map(t => {
                    const Icon = toolIcon(t.id);
                    return (
                      <li key={t.id} className="flex items-start gap-1.5 leading-snug">
                        <Icon className="w-3 h-3 mt-0.5 shrink-0 text-[var(--text-muted)]" />
                        <span><span className="text-[var(--text-secondary)]">{t.displayName}</span>{t.auto ? ` · ${t.auto}` : ''}{!t.enabled && tx(' (disabled globally)')}</span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </div>

          <div>
            <div className="text-[11px] text-[var(--text-muted)] mb-1.5 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />{tx('Skills')}
              <select className={clsx(btn.input, 'w-auto py-0.5 text-xs')} aria-label={tx('Skill access')}
                value={draft.skills === undefined || draft.skills === 'all' ? 'all' : draft.skills.length ? 'some' : 'none'}
                onChange={e => set('skills', e.target.value === 'all' ? 'all' : e.target.value === 'none' ? [] : skills.filter(s => s.enabled).map(s => s.name))}>
                <option value="all">{tx('All enabled skills')}</option><option value="some">{tx('Only these…')}</option><option value="none">{tx('None')}</option>
              </select>
              <span className="opacity-75">{skills.filter(s => s.enabled).length} enabled in Tools &amp; Connectors → Skills</span>
            </div>
            {Array.isArray(draft.skills) && draft.skills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {skills.filter(s => s.enabled).map(s => {
                  const on = (draft.skills as string[]).includes(s.name);
                  return (
                    <button key={s.name} title={tx(s.description)}
                      onClick={() => set('skills', on ? (draft.skills as string[]).filter(x => x !== s.name) : [...(draft.skills as string[]), s.name])}
                      className={clsx('px-2 py-0.5 rounded-md text-[11px] font-mono border transition',
                        on ? 'border-amber-400/60 bg-amber-400/10 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]')}>
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <label className="block text-[11px] text-[var(--text-muted)]">{tx('System prompt')}
            <textarea className={clsx(btn.input, 'font-mono text-xs leading-relaxed min-h-[220px]')} value={draft.systemPrompt}
              onChange={e => set('systemPrompt', e.target.value)} />
          </label>

          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>
        </>)}
      </div>

      {!store && <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-1">
          {!isNew && <button className={btn.ghost} onClick={() => startNew(draft)}><Copy className="w-3.5 h-3.5" />{tx('Duplicate')}</button>}
          {!isNew && draft.builtin && (
            <button className={btn.ghost} onClick={async () => { await api.resetAgent(draft.id); onChanged(draft.id); }}><RotateCcw className="w-3.5 h-3.5" />{tx('Reset')}</button>
          )}
          {!isNew && agents.length > 1 && (
            <button className={clsx(btn.ghost, 'hover:text-red-400')} onClick={async () => { if (confirm(tx('Delete {name}?', { name: draft.name }))) { await api.deleteAgent(draft.id); setSelId(agents.find(a => a.id !== draft.id)?.id); onChanged(); } }}>
              <Trash2 className="w-3.5 h-3.5" />{tx('Delete')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty && !isNew && <button className={btn.subtle} onClick={() => setDraft(structuredClone(original!))}>{tx('Discard')}</button>}
          {isNew && <button className={btn.subtle} onClick={() => setIsNew(false)}>{tx('Cancel')}</button>}
          <button className={btn.primary} disabled={!dirty || saving || !draft.name.trim()} onClick={save}><Save className="w-3.5 h-3.5" />{isNew ? tx('Create') : tx('Save')}</button>
        </div>
      </footer>}
    </Modal>
  );
}
