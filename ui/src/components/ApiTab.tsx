import { Fragment, useCallback, useEffect, useState } from 'react';
import { Activity, Bot, Check, Copy, Cpu, KeyRound, Loader2, Pause, Pencil, Play, Plus, Theater, Trash2, X } from 'lucide-react';
import { req } from '../api';
import { btn } from './common';
import { toast } from './toast';
import { WebhooksPanel } from './WebhooksPanel';
import { t as tx } from '../i18n';

/** Settings → Tools & Connectors → API: keys that let other systems use Shell:B (server/public_api.py, docs/API.md).
 *  A key's token is shown once; only its hash is stored. Each key has a mode (full agent, persona, raw model), its own
 *  limits, and an audit trail of every request it made. */

type Mode = 'agent' | 'persona' | 'raw';
interface KeyConfig {
  perMinute: number; concurrent: number; dailyRequests: number; dailyTokens: number; maxTokens: number;
  logContent: boolean; disabled: boolean; memory?: boolean; instructions: string; tools: string[]; model: string; models: string[]; thinking: string;
}
interface Totals { calls: number; errors: number; refused: number; promptTokens: number; completionTokens: number; avgMs: number; last: number }
interface ApiKey {
  id: string; name: string; hint: string; agents: string[]; incognito: boolean; mode: Mode; config: KeyConfig;
  created: number; lastUsed?: number; uses: number; week?: Totals | null;
}
interface AgentLite { id: string; name: string; adult?: boolean }
interface Options { personaTools: string[]; models: string[]; defaultRawModel: string; limits: Record<string, number> }
interface LogRow {
  id: number; ts: number; key_name?: string; method: string; endpoint: string; mode?: string; target?: string; conv_id?: string;
  status: number; prompt_tokens: number; completion_tokens: number; ms: number; ip?: string; ua?: string; error?: string;
  tools?: string[]; request?: string; reply?: string;
}
interface Usage { totals?: Totals | null; daily: { day: string; calls: number; failed: number; tokens: number }[]; targets: { target: string; calls: number }[]; log: LogRow[] }

const MODES: { id: Mode; label: string; icon: typeof Bot; blurb: string }[] = [
  { id: 'agent', label: 'Full agent', icon: Bot, blurb: 'Agent turns with tools and memory, like a scheduled task. For your own scripts and automations.' },
  { id: 'persona', label: 'Persona', icon: Theater, blurb: "The agent's personality and nothing of yours: no memories read or learned, no calendar, contacts or files, only the tools you pick. Chats are incognito. For bots other people talk to." },
  { id: 'raw', label: 'Raw model', icon: Cpu, blurb: 'Plain inference on a local model: the caller sends its own prompts, Shell:B adds nothing and stores no chat. For games and apps that bring their own characters.' },
];
const TOOL_LABEL: Record<string, string> = {
  web_search: 'Web search', web_fetch: 'Read web pages', wiki: 'Offline wiki', legal: 'Offline law', weather: 'Weather',
  geocode: 'Place lookup', track_flight: 'Flights', generate_image: 'Images',
};
const BLANK: KeyConfig = { perMinute: 30, concurrent: 2, dailyRequests: 0, dailyTokens: 0, maxTokens: 0, logContent: false, disabled: false, instructions: '', tools: [], model: '', models: [], thinking: 'off' };

const ago = (t?: number) => {
  if (!t) return 'never used';
  const s = Date.now() / 1000 - t;
  return 'used ' + (s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
};
const num = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString();
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const errText = (e: unknown) => String(e).replace(/^Error: \d+: /, '');

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-xs border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
      {children}
    </button>
  );
}

function NumField({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block text-xs text-[var(--text-secondary)]">
      {label}{hint && <span className="text-[var(--text-muted)]"> {hint}</span>}
      <input type="number" min={0} className={btn.input + ' mt-1'} value={value} onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))} />
    </label>
  );
}

/** The new-key form and the edit form. */
function KeyForm({ initial, agents, options, onSave, onCancel, saveLabel }: {
  initial?: ApiKey; agents: AgentLite[]; options: Options | null; saveLabel: string;
  onSave: (body: object) => Promise<void>; onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [mode, setMode] = useState<Mode>(initial?.mode ?? 'agent');
  const [pick, setPick] = useState<string[]>(initial?.agents ?? []);
  const [incognito, setIncognito] = useState(initial?.incognito ?? false);
  const [cfg, setCfg] = useState<KeyConfig>({ ...BLANK, ...initial?.config });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof KeyConfig>(k: K, v: KeyConfig[K]) => setCfg(c => ({ ...c, [k]: v }));
  const toggle = (list: string[], x: string) => list.includes(x) ? list.filter(y => y !== x) : [...list, x];
  const rawDefault = cfg.model || options?.defaultRawModel || '';

  async function save() {
    setBusy(true);
    try {
      const config = { ...cfg, model: mode === 'raw' ? rawDefault : '', models: mode === 'raw' ? cfg.models.filter(m => m !== rawDefault) : [] };
      await onSave({ name: name.trim() || 'API key', mode, agents: mode === 'raw' ? [] : pick, incognito: mode === 'agent' && incognito, config });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <input className={btn.input} placeholder={tx('What will use it, e.g. Skyrim NPCs')} value={name} maxLength={60} onChange={e => setName(e.target.value)} />

      <div role="radiogroup" aria-label={tx('Mode')} className="grid gap-2 sm:grid-cols-3">
        {MODES.map(m => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}
            className={`text-left p-2.5 rounded-lg border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${mode === m.id ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)]'}`}>
            <div className="flex items-center gap-1.5 text-sm font-medium"><m.icon className="w-4 h-4" />{tx(m.label)}</div>
            <div className="text-[11px] leading-snug text-[var(--text-muted)] mt-1">{tx(m.blurb)}</div>
          </button>
        ))}
      </div>

      {mode !== 'raw' && (
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-1.5">{tx('Agents it may use')} <span className="text-[var(--text-muted)]">{tx('(none picked = all)')}</span></div>
          <div className="flex flex-wrap gap-1.5">{agents.map(a => <Chip key={a.id} on={pick.includes(a.id)} onClick={() => setPick(p => toggle(p, a.id))}>{a.name}</Chip>)}</div>
        </div>
      )}
      {mode === 'agent' && (
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={incognito} onChange={e => setIncognito(e.target.checked)} />
          {tx('Incognito chats: nothing remembered or learned, and they delete themselves after a while')}
        </label>
      )}
      {mode === 'persona' && (<>
        <label className="block text-xs text-[var(--text-secondary)]">
          {tx('Brief')} <span className="text-[var(--text-muted)]">{tx('(the topic, the audience, what to stay away from; sits above anything the caller sends)')}</span>
          <textarea className={btn.input + ' mt-1 min-h-[90px] font-normal'} value={cfg.instructions} maxLength={20000}
            placeholder={tx('You answer questions about … for visitors of … Stay on that topic; for anything else, point them to …')}
            onChange={e => set('instructions', e.target.value)} />
        </label>
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-1.5">{tx('Tools')} <span className="text-[var(--text-muted)]">{tx('(none = conversation only)')}</span></div>
          <div className="flex flex-wrap gap-1.5">
            {(options?.personaTools ?? []).map(t => <Chip key={t} on={cfg.tools.includes(t)} onClick={() => set('tools', toggle(cfg.tools, t))}>{TOOL_LABEL[t] ?? t}</Chip>)}
          </div>
        </div>
      </>)}
      {mode === 'raw' && (
        <div className="space-y-2">
          <label className="block text-xs text-[var(--text-secondary)]">
            {tx('Default model')} <span className="text-[var(--text-muted)]">{tx('(used when the caller asks for a model the key doesn\'t allow, e.g. "gpt-4o")')}</span>
            <select className={btn.input + ' mt-1'} value={rawDefault} onChange={e => set('model', e.target.value)}>
              {!options?.models.includes(rawDefault) && rawDefault && <option value={rawDefault}>{rawDefault}</option>}
              {(options?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="block text-xs text-[var(--text-secondary)]">
            {tx('Thinking')} <span className="text-[var(--text-muted)]">{tx('(off is fastest and best for dialogue; thinking tokens count against max tokens)')}</span>
            <select className={btn.input + ' mt-1'} value={cfg.thinking} onChange={e => set('thinking', e.target.value)}>
              <option value="off">{tx('Off')}</option><option value="low">Low</option><option value="medium">{tx('Medium')}</option><option value="high">{tx('High')}</option>
              <option value="caller">{tx('Let the caller decide (reasoning_effort)')}</option>
            </select>
          </label>
          <div>
            <div className="text-xs text-[var(--text-secondary)] mb-1.5">{tx('Other models it may load')} <span className="text-[var(--text-muted)]">{tx('(each one competes for the Spark\'s memory)')}</span></div>
            <div className="flex flex-wrap gap-1.5">
              {(options?.models ?? []).filter(m => m !== rawDefault).map(m => <Chip key={m} on={cfg.models.includes(m)} onClick={() => set('models', toggle(cfg.models, m))}>{m}</Chip>)}
            </div>
          </div>
        </div>
      )}

      <details className="rounded-lg border border-[var(--border-subtle)] p-2.5" open={!!initial}>
        <summary className="text-xs text-[var(--text-secondary)] cursor-pointer select-none">{tx('Limits and logging')}</summary>
        <div className="grid gap-3 sm:grid-cols-3 mt-3">
          <NumField label={tx('Requests a minute')} value={cfg.perMinute} onChange={n => set('perMinute', n)} />
          <NumField label={tx('At once')} value={cfg.concurrent} onChange={n => set('concurrent', n)} />
          <NumField label={tx('Requests a day')} hint={tx('(0 = no cap)')} value={cfg.dailyRequests} onChange={n => set('dailyRequests', n)} />
          <NumField label={tx('Tokens a day')} hint={tx('(0 = no cap)')} value={cfg.dailyTokens} onChange={n => set('dailyTokens', n)} />
          {mode === 'raw' && <NumField label={tx('Max tokens a reply')} hint={tx('(0 = caller\'s)')} value={cfg.maxTokens} onChange={n => set('maxTokens', n)} />}
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mt-3">
          <input type="checkbox" checked={cfg.logContent} onChange={e => set('logContent', e.target.checked)} />
          {tx('Keep the start of each message and reply in the usage log (14 days)')}
        </label>
        {mode === 'agent' && (
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mt-2">
            <input type="checkbox" checked={!!cfg.memory} onChange={e => set('memory', e.target.checked)} />
            {tx('May read and add your memories (GET/POST /api/v1/memory, MCP shellb_memory_*)')}
          </label>
        )}
      </details>

      <div className="flex gap-2">
        <button className={btn.primary} onClick={save} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : initial ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {saveLabel}
        </button>
        {onCancel && <button className={btn.ghost} onClick={onCancel}>{tx('Cancel')}</button>}
      </div>
    </div>
  );
}

/** One key's (or every key's) audit trail: a 7-day summary and the newest requests. */
function UsagePanel({ path, showKey }: { path: string; showKey?: boolean }) {
  const [data, setData] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    setData(null);
    req<Usage>(`${path}?days=7&limit=100${failed ? '&failed=true' : ''}`).then(setData).catch(() => setData({ daily: [], targets: [], log: [] }));
  }, [path, failed]);
  if (!data) return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />;
  const max = Math.max(1, ...data.daily.map(d => d.calls));
  const t = data.totals;
  return (
    <div className="space-y-3 text-xs">
      {t && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[var(--text-secondary)]">
          <span><b className="text-[var(--text-primary)]">{num(t.calls)}</b> {tx('requests in 7 days')}</span>
          <span><b className="text-[var(--text-primary)]">{num(t.promptTokens + t.completionTokens)}</b> tokens</span>
          <span>{t.avgMs ? tx('{v0} s average', { v0: (t.avgMs / 1000).toFixed(1) }) : ''}</span>
          {t.refused > 0 && <span className="text-amber-400">{t.refused} refused</span>}
          {t.errors > 0 && <span className="text-red-400">{t.errors} failed</span>}
        </div>
      )}
      {data.daily.length > 0 && (
        <div className="flex items-end gap-1 h-12" aria-label={tx('Requests per day')}>
          {data.daily.map(d => (
            <div key={d.day} className="flex-1 flex flex-col justify-end h-full" title={tx('{day}: {calls} requests, {failed} refused or failed, {v0} tokens', { day: d.day, calls: d.calls, failed: d.failed, v0: num(d.tokens) })}>
              <div className="rounded-sm bg-[var(--accent)]/70" style={{ height: `${Math.max(4, (d.calls / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      )}
      {data.targets.length > 0 && (
        <div className="text-[var(--text-muted)]">{tx('Most used:')} {data.targets.map(x => `${x.target} (${x.calls})`).join(' · ')}</div>
      )}
      <label className="flex items-center gap-2 text-[var(--text-secondary)]">
        <input type="checkbox" checked={failed} onChange={e => setFailed(e.target.checked)} /> {tx('Only refused and failed requests')}
      </label>
      {data.log.length === 0 ? <p className="text-[var(--text-muted)]">{tx('No requests yet.')}</p> : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
          <table className="w-full text-left whitespace-nowrap">
            <thead className="text-[var(--text-muted)] bg-[var(--bg-tertiary)]">
              <tr>{['When', ...(showKey ? ['Key'] : []), 'Call', 'Agent / model', 'Status', 'Tokens', 'Time', 'From'].map(h => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.log.map(r => (
                <Fragment key={r.id}>
                  <tr className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer" onClick={() => setOpen(o => o === r.id ? null : r.id)}>
                    <td className="px-2 py-1">{when(r.ts)}</td>
                    {showKey && <td className="px-2 py-1">{r.key_name ?? <span className="text-amber-400">{tx('no valid key')}</span>}</td>}
                    <td className="px-2 py-1 font-mono">{r.method} {r.endpoint}</td>
                    <td className="px-2 py-1">{r.target ?? ''}</td>
                    <td className={`px-2 py-1 ${r.status >= 500 ? 'text-red-400' : r.status >= 400 ? 'text-amber-400' : ''}`}>{r.status}</td>
                    <td className="px-2 py-1">{r.prompt_tokens || r.completion_tokens ? `${num(r.prompt_tokens)} → ${num(r.completion_tokens)}` : ''}</td>
                    <td className="px-2 py-1">{r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : tx('{ms} ms', { ms: r.ms })}</td>
                    <td className="px-2 py-1">{r.ip ?? ''}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="bg-[var(--bg-secondary)]">
                      <td colSpan={showKey ? 8 : 7} className="px-3 py-2 whitespace-normal space-y-1.5">
                        {r.error && <div className="text-red-400">{tx('Error: {error}', { error: r.error })}</div>}
                        {r.tools && <div>{tx('Tools: {v0}', { v0: r.tools.join(', ') })}</div>}
                        {r.conv_id && <div>{tx('Conversation:')} <code>{r.conv_id}</code></div>}
                        {r.ua && <div className="text-[var(--text-muted)]">{tx('Client: {ua}', { ua: r.ua })}</div>}
                        {r.request && <div><div className="text-[var(--text-muted)]">{tx('Message')}</div><pre className="whitespace-pre-wrap font-sans">{r.request}</pre></div>}
                        {r.reply && <div><div className="text-[var(--text-muted)]">{tx('Reply')}</div><pre className="whitespace-pre-wrap font-sans">{r.reply}</pre></div>}
                        {!r.request && !r.reply && !r.error && <div className="text-[var(--text-muted)]">{tx('Content isn\'t kept for this key (Edit → Limits and logging).')}</div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApiTab({ locked }: { locked: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [options, setOptions] = useState<Options | null>(null);
  const [made, setMade] = useState<{ name: string; token: string; mode: Mode } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (locked) return;
    req<ApiKey[]>('/api/apikeys').then(setKeys).catch(() => setKeys([]));
  }, [locked]);
  useEffect(() => {
    load();
    if (locked) return;
    req<AgentLite[]>('/api/agents').then(a => setAgents(a.filter(x => !x.adult))).catch(() => {});
    req<Options>('/api/apikeys/options').then(setOptions).catch(() => {});
  }, [load, locked]);

  async function create(body: object) {
    try {
      const k = await req<ApiKey & { token: string }>('/api/apikeys', { method: 'POST', body: JSON.stringify(body) });
      setMade({ name: k.name, token: k.token, mode: k.mode });
      setFormKey(n => n + 1);
      load();
    } catch (e) { toast(tx('Couldn\'t create the key: {v0}', { v0: errText(e) }), { kind: 'error' }); }
  }

  async function update(k: ApiKey, body: object) {
    try {
      await req(`/api/apikeys/${k.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(null);
      load();
    } catch (e) { toast(tx('Couldn\'t save {name}: {v0}', { name: k.name, v0: errText(e) }), { kind: 'error' }); }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(tx('Revoke “{name}”? Anything using it stops working at once.', { name: k.name }))) return;
    await req(`/api/apikeys/${k.id}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  function copy(text: string, what: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  }

  if (locked) return null;
  const base = `${location.origin}/api/v1`;
  const curl = !made ? '' : made.mode === 'raw'
    ? `curl ${base}/chat/completions -H "Authorization: Bearer ${made.token}" -H "Content-Type: application/json" -d '{"messages": [{"role": "system", "content": "You are a guard in Whiterun."}, {"role": "user", "content": "Hello"}]}'`
    : `curl ${base}/chat -H "Authorization: Bearer ${made.token}" -H "Content-Type: application/json" -d '{"message": "Hello Shell:B"}'`;
  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  const describe = (k: ApiKey) => {
    const c = k.config;
    const what = k.mode === 'raw' ? [c.model, ...c.models].filter(Boolean).join(', ') || 'default model'
      : (k.agents.length ? k.agents.map(nameOf).join(', ') : 'All agents');
    const extra = k.mode === 'persona' ? (c.tools.length ? ` · ${c.tools.map(t => TOOL_LABEL[t] ?? t).join(', ')}` : ' · no tools')
      : k.mode === 'agent' && k.incognito ? ' · incognito chats' : '';
    return `${what}${extra}`;
  };
  return (
    <div className="space-y-6 max-w-3xl">
      <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="flex items-start gap-3">
          <KeyRound className="w-5 h-5 mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">{tx('Let other systems use Shell:B')}</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed max-w-[65ch]">
              {tx('Scripts, apps, games or any OpenAI-compatible client can use Shell:B with an API key. Each key has a mode: a')} <b>{tx('full agent')}</b> {tx('with tools and memory for your own automations, a')} <b>persona</b> {tx('that keeps an agent\'s personality but nothing of yours for bots other people talk to, or a')} <b>{tx('raw model')}</b> {tx('for apps that bring their own prompts. Every request is logged below. Aphrodite never answers the API.')}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-2 leading-relaxed max-w-[65ch]">
              {tx('Base URL')} <code>{base}</code> {tx('· OpenAI-compatible at')} <code>{base}/chat/completions</code> {tx('(an agent\'s id as the model; raw keys take a model name). MCP clients connect to')} <code>{base}/mcp</code> {tx('with the key as a Bearer header. Full reference:')} <code>docs/API.md</code>.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('Keys')}</h3>
        {keys === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
          : keys.length === 0 ? <p className="text-sm text-[var(--text-muted)]">{tx('No keys yet. Nothing outside can use Shell:B.')}</p>
          : keys.map(k => {
            const M = MODES.find(m => m.id === k.mode) ?? MODES[0];
            const off = k.config.disabled;
            return (
              <div key={k.id} className={`rounded-lg border border-[var(--border-subtle)] ${off ? 'opacity-70' : ''}`}>
                <div className="flex items-center gap-3 px-3 py-2">
                  <M.icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-label={tx(M.label)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">
                      {k.name} <span className="text-[var(--text-muted)] font-mono text-xs">{tx(k.hint)}</span>
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{tx(M.label)}</span>
                      {off && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-400">paused</span>}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">
                      {describe(k)} · {ago(k.lastUsed)}
                      {k.week ? tx(' · {v0} this week, {v1} tokens', { v0: num(k.week.calls), v1: num(k.week.promptTokens + k.week.completionTokens) }) : ''}
                      {k.week?.errors ? tx(' · {errors} failed', { errors: k.week.errors }) : ''}
                    </div>
                  </div>
                  <button className={btn.icon} title={tx('Usage')} aria-label={tx('Usage of {name}', { name: k.name })} aria-pressed={usage === k.id} onClick={() => setUsage(u => u === k.id ? null : k.id)}><Activity className="w-4 h-4" /></button>
                  <button className={btn.icon} title={tx('Edit')} aria-label={tx('Edit {name}', { name: k.name })} onClick={() => setEditing(e => e === k.id ? null : k.id)}><Pencil className="w-4 h-4" /></button>
                  <button className={btn.icon} title={off ? tx('Resume') : tx('Pause')} aria-label={`${off ? 'Resume' : 'Pause'} ${k.name}`}
                    onClick={() => update(k, { config: { disabled: !off } })}>{off ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}</button>
                  <button className={btn.icon} title={tx('Revoke')} aria-label={tx('Revoke {name}', { name: k.name })} onClick={() => revoke(k)}><Trash2 className="w-4 h-4" /></button>
                </div>
                {editing === k.id && (
                  <div className="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)]">
                    <KeyForm initial={k} agents={agents} options={options} saveLabel="Save" onSave={b => update(k, b)} onCancel={() => setEditing(null)} />
                  </div>
                )}
                {usage === k.id && (
                  <div className="px-3 pb-3 pt-2 border-t border-[var(--border-subtle)]">
                    <UsagePanel path={`/api/apikeys/${k.id}/usage`} />
                  </div>
                )}
              </div>
            );
          })}
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('New key')}</h3>
        <KeyForm key={formKey} agents={agents} options={options} saveLabel="Create key" onSave={create} />
        {made && (
          <div className="p-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2 text-xs leading-relaxed">
            <div className="flex items-start gap-2">
              <div className="text-sm font-medium flex-1">{tx('Key for {name}. Copy it now: it won\'t be shown again.', { name: made.name })}</div>
              <button className={btn.icon} aria-label={tx('Dismiss')} onClick={() => setMade(null)}><X className="w-3.5 h-3.5" /></button>
            </div>
            <code className="block p-2 rounded bg-[var(--bg-tertiary)] font-mono break-all select-all">{made.token}</code>
            <div className="flex gap-2 flex-wrap">
              <button className={btn.subtle} onClick={() => copy(made.token, 'key')}>{copied === 'key' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {tx('Copy key')}</button>
              <button className={btn.ghost} onClick={() => copy(curl, 'curl')}>{copied === 'curl' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {tx('Copy a test command')}</button>
            </div>
            <p className="text-[var(--text-muted)]">{tx('Keep it like a password. It works from your tailnet at')} <code>{location.origin}</code>{tx('; the public address sits behind Cloudflare Access, which needs its own service token as well.')}</p>
          </div>
        )}
      </section>

      <WebhooksPanel agents={agents} />

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('All API activity')}</h3>
        <p className="text-xs text-[var(--text-muted)]">{tx('Every request from the last 90 days, including ones with a wrong or revoked key.')}</p>
        <UsagePanel path="/api/apikeys/usage" showKey />
      </section>
    </div>
  );
}
