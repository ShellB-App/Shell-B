import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { req } from '../api';
import { btn } from './common';
import { toast } from './toast';

/** Settings → Tools & Connectors → API: keys that let other systems talk to Shell:B's agents (server/public_api.py,
 *  docs/API.md). A key's token is shown once; only its hash is stored. */

interface ApiKey { id: string; name: string; hint: string; agents: string[]; incognito: boolean; created: number; lastUsed?: number; uses: number }
interface AgentLite { id: string; name: string; adult?: boolean }

const ago = (t?: number) => {
  if (!t) return 'never used';
  const s = Date.now() / 1000 - t;
  return 'used ' + (s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
};

export function ApiTab({ locked }: { locked: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string[]>([]);
  const [incognito, setIncognito] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    if (locked) return;
    req<ApiKey[]>('/api/apikeys').then(setKeys).catch(() => setKeys([]));
  }, [locked]);
  useEffect(() => {
    load();
    req<AgentLite[]>('/api/agents').then(a => setAgents(a.filter(x => !x.adult))).catch(() => {});
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const k = await req<ApiKey & { token: string }>('/api/apikeys', { method: 'POST', body: JSON.stringify({ name: name.trim() || 'API key', agents: pick, incognito }) });
      setMade({ name: k.name, token: k.token });
      setName(''); setPick([]); setIncognito(false);
      load();
    } catch (e) { toast(`Couldn't create the key: ${String(e).replace(/^Error: \d+: /, '')}`, { kind: 'error' }); }
    finally { setBusy(false); }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke “${k.name}”? Anything using it stops working at once.`)) return;
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
  const curl = made ? `curl ${base}/chat -H "Authorization: Bearer ${made.token}" -H "Content-Type: application/json" -d '{"message": "Hello Shell:B"}'` : '';
  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  return (
    <div className="space-y-6 max-w-3xl">
      <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="flex items-start gap-3">
          <KeyRound className="w-5 h-5 mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Let other systems use Shell:B</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed max-w-[65ch]">
              Scripts, n8n, Home Assistant or any OpenAI-compatible app can send messages to your agents with an API key.
              Each message is a full agent turn with that agent's tools and memory, run like a scheduled task: nobody is asked
              questions, screens and browsers stay off, and anything that needs approval still comes to you. A key sees only
              the chats it started. Aphrodite never answers the API.
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-2 leading-relaxed max-w-[65ch]">
              Base URL <code>{base}</code> · OpenAI-compatible at <code>{base}/chat/completions</code> with an agent's id as the model.
              MCP clients (Claude Code, Claude Desktop, Cursor) connect to <code>{base}/mcp</code> with the key as a Bearer header.
              Full reference: <code>docs/API.md</code>.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Keys</h3>
        {keys === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
          : keys.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No keys yet. Nothing outside can use Shell:B.</p>
          : keys.map(k => (
            <div key={k.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--border-subtle)]">
              <KeyRound className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{k.name} <span className="text-[var(--text-muted)] font-mono text-xs">{k.hint}</span></div>
                <div className="text-[11px] text-[var(--text-muted)] truncate">
                  {k.agents.length ? k.agents.map(nameOf).join(', ') : 'All agents'}{k.incognito ? ' · incognito chats' : ''} · {ago(k.lastUsed)}{k.uses ? ` · ${k.uses} call${k.uses === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <button className={btn.icon} title={`Revoke ${k.name}`} aria-label={`Revoke ${k.name}`} onClick={() => revoke(k)}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">New key</h3>
        <input className={btn.input} placeholder="What will use it, e.g. Home Assistant" value={name} maxLength={60}
          onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} />
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-1.5">Agents it may use <span className="text-[var(--text-muted)]">(none picked = all)</span></div>
          <div className="flex flex-wrap gap-1.5">
            {agents.map(a => {
              const on = pick.includes(a.id);
              return (
                <button key={a.id} type="button" aria-pressed={on} onClick={() => setPick(p => on ? p.filter(x => x !== a.id) : [...p, a.id])}
                  className={`px-2.5 py-1 rounded-md text-xs border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
                  {a.name}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={incognito} onChange={e => setIncognito(e.target.checked)} />
          Incognito chats: nothing remembered or learned, and they delete themselves after a while
        </label>
        <button className={btn.primary} onClick={create} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create key
        </button>
        {made && (
          <div className="p-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2 text-xs leading-relaxed">
            <div className="text-sm font-medium">Key for {made.name}. Copy it now: it won't be shown again.</div>
            <code className="block p-2 rounded bg-[var(--bg-tertiary)] font-mono break-all select-all">{made.token}</code>
            <div className="flex gap-2 flex-wrap">
              <button className={btn.subtle} onClick={() => copy(made.token, 'key')}>{copied === 'key' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy key</button>
              <button className={btn.ghost} onClick={() => copy(curl, 'curl')}>{copied === 'curl' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy a test command</button>
            </div>
            <p className="text-[var(--text-muted)]">Keep it like a password. It works from your tailnet at <code>{location.origin}</code>; the public
              address sits behind Cloudflare Access, which needs its own service token as well.</p>
          </div>
        )}
      </section>
    </div>
  );
}
