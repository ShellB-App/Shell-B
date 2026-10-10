import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, Loader2, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react';
import { req } from '../api';
import { btn, relTime } from './common';
import { toast, toastError } from './toast';

/** Tools & Connectors → API → Webhooks (server/hooks.py): inbound hooks that start a turn, outbound hooks that post
 * Activity events (and approvals) to a URL. Owner/admin only, like API keys. */
interface HookIn { id: string; name: string; secret: string; agent: string; template: string; groupId: string | null; reuse: boolean; enabled: boolean; convId: string | null; lastUsed: number | null; uses: number }
interface HookOut { id: string; name: string; url: string; kinds: string[]; enabled: boolean; lastUsed: number | null; failures: number; hasSecret: boolean }
interface LogRow { id: number; ts: number; hook_id: string; direction: 'in' | 'out'; status: number; detail: string }
interface Data { inbound: HookIn[]; outbound: HookOut[]; kinds: string[]; log: LogRow[] }
interface AgentLite { id: string; name: string; adult?: boolean }

const KIND_LABEL: Record<string, string> = {
  approval: 'Approvals', schedule: 'Scheduled runs', plan: 'Mega Plans', todo: 'To-dos', deploy: 'Self-deploys', scout: 'Asset scouts',
  notebook: 'Notebooks', codex: 'Codex drafts', memory: 'Memory', data: 'Offline data', brief: 'Morning brief', health: 'System health',
  shopping: 'Price watch', nightshift: 'Night shift', circles: 'Circles', guest: 'Guests', calendar: 'Calendar reminders', feeds: 'Feeds', email: 'Email',
};

export function WebhooksPanel({ agents }: { agents: AgentLite[] }) {
  const [data, setData] = useState<Data | null>(null);
  const [newIn, setNewIn] = useState<{ name: string; agent: string; template: string; reuse: boolean } | null>(null);
  const [newOut, setNewOut] = useState<{ name: string; url: string; secret: string; kinds: string[] } | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => req<Data>('/api/webhooks').then(setData).catch(() => setData({ inbound: [], outbound: [], kinds: [], log: [] })), []);
  useEffect(() => { load(); }, [load]);
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500); };
  const act = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); load(); } catch (e) { toastError('Webhooks')(e); } finally { setBusy(''); } };
  if (!data) return null;
  const base = `${location.origin}/api/v1/hooks`;
  const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2"><Webhook className="w-3.5 h-3.5" />Webhooks</h3>
        <p className="text-xs text-[var(--text-muted)] mt-1 max-w-[65ch]">Inbound hooks let n8n, GitHub, Home Assistant or a cron job start an agent turn with a payload. Outbound hooks post what happened (a plan finished, a reminder is due, an approval is waiting) to a URL you run. Both are described in docs/API.md.</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium flex items-center gap-1.5"><ArrowDownToLine className="w-3.5 h-3.5 text-emerald-400" />Inbound: start a turn</h4>
          {!newIn && <button className={btn.subtle} onClick={() => setNewIn({ name: '', agent: agents[0]?.id ?? 'shellb', template: '', reuse: false })}><Plus className="w-3.5 h-3.5" />New inbound hook</button>}
        </div>
        {newIn && (
          <form className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2 text-xs" onSubmit={e => { e.preventDefault(); act('in', () => req('/api/webhooks/in', { method: 'POST', body: JSON.stringify(newIn) })).then(() => setNewIn(null)); }}>
            <div className="grid sm:grid-cols-2 gap-2">
              <input className={btn.input} placeholder="Name (e.g. GitHub pushes)" value={newIn.name} onChange={e => setNewIn({ ...newIn, name: e.target.value })} required />
              <select className={btn.input} value={newIn.agent} onChange={e => setNewIn({ ...newIn, agent: e.target.value })}>
                {agents.filter(a => !a.adult).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <textarea className={clsx(btn.input, 'font-mono min-h-[72px]')} placeholder={'Message template. Empty = the payload itself. Fields: {{json}} {{text}} {{payload.repository.name}} {{header.x-github-event}} {{query.q}}\ne.g. A push landed on {{payload.ref}}: summarize {{payload.head_commit.message}}'} value={newIn.template} onChange={e => setNewIn({ ...newIn, template: e.target.value })} />
            <label className="flex items-center gap-2"><input type="checkbox" checked={newIn.reuse} onChange={e => setNewIn({ ...newIn, reuse: e.target.checked })} />Continue one chat across deliveries (otherwise each delivery starts a new chat)</label>
            <div className="flex gap-2"><button className={btn.primary} type="submit" disabled={busy === 'in'}>Create</button><button className={btn.ghost} type="button" onClick={() => setNewIn(null)}>Cancel</button></div>
          </form>
        )}
        {data.inbound.length === 0 && !newIn && <p className="text-[11px] text-[var(--text-muted)]">No inbound hooks yet.</p>}
        {data.inbound.map(h => (
          <div key={h.id} className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={clsx('w-2 h-2 rounded-full', h.enabled ? 'bg-emerald-400' : 'bg-[var(--text-muted)]')} />
              <span className="font-medium">{h.name}</span>
              <span className="text-[var(--text-muted)]">→ {nameOf(h.agent)}{h.reuse ? ' · one chat' : ''}{h.uses ? ` · ${h.uses} deliveries` : ''}{h.lastUsed ? ` · last ${relTime(h.lastUsed * 1000)}` : ''}</span>
              <span className="flex-1" />
              <button className={btn.icon} title={h.enabled ? 'Switch off' : 'Switch on'} onClick={() => act(h.id, () => req(`/api/webhooks/in/${h.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !h.enabled }) }))}>{h.enabled ? 'On' : 'Off'}</button>
              <button className={btn.icon} title="New secret (the old one stops working)" onClick={() => act(h.id, () => req(`/api/webhooks/in/${h.id}`, { method: 'PATCH', body: JSON.stringify({ rotate: true }) }))}><RefreshCw className="w-3.5 h-3.5" /></button>
              <button className={btn.icon} title="Delete" onClick={() => { if (confirm(`Delete “${h.name}”?`)) act(h.id, () => req(`/api/webhooks/in/${h.id}`, { method: 'DELETE' })); }}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <code className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] break-all">POST {base}/{h.id}</code>
              <button className={btn.ghost} onClick={() => copy(`${base}/${h.id}`, `url-${h.id}`)}>{copied === `url-${h.id}` ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} URL</button>
              <button className={btn.ghost} onClick={() => copy(h.secret, `sec-${h.id}`)}>{copied === `sec-${h.id}` ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Secret</button>
              <button className={btn.ghost} onClick={() => copy(`curl -X POST ${base}/${h.id} -H "X-Hook-Secret: ${h.secret}" -H "Content-Type: application/json" -d '{"hello": "world"}'`, `curl-${h.id}`)}>{copied === `curl-${h.id}` ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Test command</button>
              {h.convId && <a className="text-[var(--accent)] hover:underline" href={`#/c/${h.convId}`}>Last chat</a>}
            </div>
            {h.template && <pre className="text-[11px] text-[var(--text-muted)] whitespace-pre-wrap font-mono">{h.template}</pre>}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium flex items-center gap-1.5"><ArrowUpFromLine className="w-3.5 h-3.5 text-sky-400" />Outbound: tell a URL what happened</h4>
          {!newOut && <button className={btn.subtle} onClick={() => setNewOut({ name: '', url: '', secret: '', kinds: ['approval', 'plan', 'schedule'] })}><Plus className="w-3.5 h-3.5" />New outbound hook</button>}
        </div>
        {newOut && (
          <form className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2 text-xs" onSubmit={e => { e.preventDefault(); act('out', () => req('/api/webhooks/out', { method: 'POST', body: JSON.stringify(newOut) })).then(() => setNewOut(null)); }}>
            <div className="grid sm:grid-cols-2 gap-2">
              <input className={btn.input} placeholder="Name (e.g. n8n alerts)" value={newOut.name} onChange={e => setNewOut({ ...newOut, name: e.target.value })} required />
              <input className={btn.input} placeholder="https://… (public internet; not this machine or the tailnet)" value={newOut.url} onChange={e => setNewOut({ ...newOut, url: e.target.value })} required />
            </div>
            <input className={btn.input} placeholder="Shared secret for X-Shellb-Signature (optional)" value={newOut.secret} onChange={e => setNewOut({ ...newOut, secret: e.target.value })} />
            <div className="flex flex-wrap gap-1.5">
              {data.kinds.map(k => (
                <button key={k} type="button" onClick={() => setNewOut({ ...newOut, kinds: newOut.kinds.includes(k) ? newOut.kinds.filter(x => x !== k) : [...newOut.kinds, k] })}
                  className={clsx('px-2 py-0.5 rounded-lg border text-[11px]', newOut.kinds.includes(k) ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]')}>{KIND_LABEL[k] ?? k}</button>
              ))}
            </div>
            <div className="flex gap-2"><button className={btn.primary} type="submit" disabled={busy === 'out' || !newOut.kinds.length}>Create</button><button className={btn.ghost} type="button" onClick={() => setNewOut(null)}>Cancel</button></div>
          </form>
        )}
        {data.outbound.length === 0 && !newOut && <p className="text-[11px] text-[var(--text-muted)]">No outbound hooks yet.</p>}
        {data.outbound.map(h => (
          <div key={h.id} className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs space-y-1">
            <div className="flex items-center gap-2">
              <span className={clsx('w-2 h-2 rounded-full', !h.enabled ? 'bg-[var(--text-muted)]' : h.failures ? 'bg-amber-400' : 'bg-emerald-400')} />
              <span className="font-medium">{h.name}</span>
              <span className="text-[var(--text-muted)] truncate">{h.url}</span>
              <span className="flex-1" />
              <button className={btn.icon} title="Send a test event" disabled={busy === `t-${h.id}`} onClick={() => act(`t-${h.id}`, async () => { const r = await req<LogRow>(`/api/webhooks/out/${h.id}/test`, { method: 'POST' }); toast(r.status && r.status < 300 ? `Delivered (HTTP ${r.status})` : `Failed: ${r.detail}`, { kind: r.status && r.status < 300 ? 'info' : 'error' }); })}>{busy === `t-${h.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Test'}</button>
              <button className={btn.icon} title={h.enabled ? 'Switch off' : 'Switch on'} onClick={() => act(h.id, () => req(`/api/webhooks/out/${h.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !h.enabled }) }))}>{h.enabled ? 'On' : 'Off'}</button>
              <button className={btn.icon} title="Delete" onClick={() => { if (confirm(`Delete “${h.name}”?`)) act(h.id, () => req(`/api/webhooks/out/${h.id}`, { method: 'DELETE' })); }}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">{h.kinds.map(k => KIND_LABEL[k] ?? k).join(', ')}{h.hasSecret ? ' · signed' : ''}{h.failures ? ` · ${h.failures} failed in a row` : ''}{h.lastUsed ? ` · last ${relTime(h.lastUsed * 1000)}` : ''}</div>
          </div>
        ))}
      </div>

      {data.log.length > 0 && (
        <details className="text-[11px] text-[var(--text-muted)]">
          <summary className="cursor-pointer">Recent deliveries ({data.log.length})</summary>
          <ul className="mt-1 divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg max-h-48 overflow-y-auto">
            {data.log.map(r => (
              <li key={r.id} className="px-2.5 py-1 flex items-center gap-2">
                <span className="w-16 shrink-0">{relTime(r.ts * 1000)}</span>
                <span className={clsx('w-7 shrink-0 font-mono', r.direction === 'in' ? 'text-emerald-400' : 'text-sky-400')}>{r.direction}</span>
                <span className={clsx('w-9 shrink-0 font-mono', r.status && r.status < 400 ? '' : 'text-red-400')}>{r.status || 'ERR'}</span>
                <span className="truncate">{[data.inbound, data.outbound].flat().find(h => h.id === r.hook_id)?.name ?? r.hook_id} · {r.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
