import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Boxes, ChevronDown, Compass, ChevronRight, Cloud, Database, FolderOpen, GitBranch, KeyRound, Link, ListOrdered, Loader2, Lock,
  Heart, MonitorUp, NotebookText, Pencil, Plug, Plus, RefreshCw, Share2, ShieldCheck, Sparkles, SquareTerminal, Trash2, Workflow, type LucideIcon,
} from 'lucide-react';
import type { CliAgent, Connector, McpServer, Provider, Settings, ToolInfo } from '../types';
import { adminKey, api } from '../api';
import { Modal, Toggle, btn, toolIcon } from './common';
import { SkillsPanel } from './Skills';
import { Discover } from './Discover';
import { ScreenTab } from './ScreenTab';

const ICONS: Record<string, LucideIcon> = {
  FolderOpen, Database, Workflow, Github: GitBranch, NotebookText, Share2, ListOrdered, Link, SquareTerminal, Plug, Compass,
};
export const connectorIcon = (name?: string) => ICONS[name ?? ''] ?? Plug;

const SERVICE_NAMES: Record<string, string> = {
  ollama: 'Ollama', searxng: 'VASSAGO', sandbox: 'Sandbox', nyx: 'NYX', orpheus: 'ORPHEUS', hermes: 'HERMES', embeddings: 'MIMIR-lite',
};
const SECRET = '__secret__';

type Tab = 'connectors' | 'servers' | 'skills' | 'discover' | 'tools' | 'cloud' | 'screen' | 'adult';

interface Props {
  open: boolean;
  onClose: () => void;
  tools: ToolInfo[];
  settings?: Settings;
  onChanged: () => void; // tools, agents, models or settings changed
  tab?: Tab;
}

export function IntegrationsModal({ open, onClose, tools, settings, onChanged, tab: initial }: Props) {
  const [tab, setTab] = useState<Tab>(initial ?? 'connectors');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [editing, setEditing] = useState<{ connector: Connector; server?: McpServer } | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(null);

  const load = useCallback(() => api.mcpServers().then(setServers).catch(() => {}), []);
  useEffect(() => {
    if (!open) return;
    setTab(initial ?? 'connectors');
    setEditing(null);
    load();
    api.connectors().then(setConnectors).catch(() => {});
    api.adminCheck().then(r => setAdmin(r.ok)).catch(() => setAdmin(false));
  }, [open, initial, load]);
  // poll while a server is starting (npx servers can take a while on first launch)
  useEffect(() => {
    if (!open || !servers.some(s => s.status === 'starting')) return;
    const t = setTimeout(() => { load(); onChanged(); }, 2000);
    return () => clearTimeout(t);
  }, [open, servers, load, onChanged]);

  const tabs = [
    { id: 'connectors', label: 'Connectors', icon: Plug },
    { id: 'servers', label: `MCP servers${servers.length ? ` · ${servers.length}` : ''}`, icon: Workflow },
    { id: 'skills', label: 'Skills', icon: Sparkles },
    { id: 'discover', label: 'Discover', icon: Compass },
    { id: 'tools', label: 'Built-in tools', icon: Boxes },
    { id: 'cloud', label: 'Cloud AI', icon: Cloud },
    { id: 'screen', label: 'Screen', icon: MonitorUp },
    { id: 'adult', label: 'Aphrodite', icon: Heart },
  ] as const;

  return (
    <Modal open={open} onClose={onClose} title="Tools & Connectors" icon={<Plug className="w-4 h-4 text-sky-400" />} wide>
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        <div className="sm:w-48 shrink-0 p-2 flex sm:flex-col gap-1 border-b sm:border-b-0 sm:border-r border-[var(--border-subtle)] overflow-x-auto">
          {tabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setEditing(null); }}
              className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] transition whitespace-nowrap', tab === t.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
              <t.icon className="w-4 h-4" />{t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
          {admin === false && (tab === 'connectors' || tab === 'servers' || tab === 'skills' || tab === 'discover' || tab === 'cloud' || tab === 'screen' || tab === 'adult') && <AdminGate onUnlocked={() => setAdmin(true)} />}
          {tab === 'connectors' && !editing && (
            <ConnectorGallery connectors={connectors} servers={servers} onPick={c => setEditing({ connector: c })} />
          )}
          {editing && (
            <ConnectorForm connector={editing.connector} server={editing.server} locked={!admin}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); setTab('servers'); load(); onChanged(); }} />
          )}
          {tab === 'servers' && !editing && (
            <ServerList servers={servers} connectors={connectors} locked={!admin} onReload={() => { load(); onChanged(); }}
              onEdit={s => {
                // a community server carries its own form fields (installed from Discover)
                const c = s.connector === 'community'
                  ? { id: 'community', name: s.name, icon: 'Compass', category: 'Community' as const, local: null,
                      description: `Installed from Discover: ${s.community?.registryName ?? ''} ${s.community?.version ?? ''} (unverified community server).`,
                      fields: s.community?.fields ?? [] }
                  : connectors.find(x => x.id === s.connector);
                if (c) setEditing({ connector: c, server: s });
              }}
              onAdd={() => setTab('connectors')} />
          )}
          {tab === 'skills' && !editing && <SkillsPanel locked={!admin} onChanged={onChanged} />}
          {tab === 'discover' && !editing && <Discover locked={!admin} onInstalled={() => { load(); onChanged(); }} />}
          {tab === 'tools' && <BuiltinTools tools={tools.filter(t => t.category !== 'mcp')} onChanged={onChanged} />}
          {tab === 'cloud' && <CloudTab settings={settings} locked={!admin} onChanged={onChanged} />}
          {tab === 'screen' && <ScreenTab locked={!admin} cloudScreen={!!settings?.cloudScreen} />}
          {tab === 'adult' && <AphroditeTab settings={settings} locked={!admin} onChanged={onChanged} />}
        </div>
      </div>
    </Modal>
  );
}

// ── admin key ──────────────────────────────────────────────────────────────

export function AdminGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    adminKey.set(key.trim());
    const r = await api.adminCheck().catch(() => ({ ok: false }));
    if (r.ok) onUnlocked(); else setErr('That key is not right.');
  };
  return (
    <div className="mb-4 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center gap-2 text-sm font-medium"><Lock className="w-4 h-4 text-amber-400" />Admin key needed to make changes</div>
      <p className="text-xs text-[var(--text-muted)] mt-1">
        Connectors can launch programs on this machine and cloud keys spend money, so changes need the admin key.
        It is on the server: <code className="font-mono">cat ~/shellb/web/data/admin.key</code>. This browser remembers it.
      </p>
      <div className="flex gap-2 mt-2">
        <input type="password" className={btn.input} value={key} onChange={e => { setKey(e.target.value); setErr(''); }}
          placeholder="Admin key" onKeyDown={e => e.key === 'Enter' && key.trim() && submit()} />
        <button className={btn.primary} disabled={!key.trim()} onClick={submit}><KeyRound className="w-3.5 h-3.5" />Unlock</button>
      </div>
      {err && <div className="text-[11px] text-red-400 mt-1">{err}</div>}
    </div>
  );
}

// ── connectors ─────────────────────────────────────────────────────────────

function Badge({ local }: { local: boolean | null }) {
  if (local === null) return null;
  return local
    ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">on this machine</span>
    : <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 inline-flex items-center gap-1"><Cloud className="w-2.5 h-2.5" />external service</span>;
}

function ConnectorGallery({ connectors, servers, onPick }: { connectors: Connector[]; servers: McpServer[]; onPick: (c: Connector) => void }) {
  const groups = ['Local', 'Cloud', 'Custom'] as const;
  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--text-muted)]">
        Connectors plug outside services and data into Shell:B agents through the Model Context Protocol. After adding one,
        give it to agents in the Agent Lab (it appears in their tool list).
      </p>
      {groups.map(g => {
        const list = connectors.filter(c => c.category === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">{g === 'Cloud' ? 'Online services' : g}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {list.map(c => {
                const Icon = connectorIcon(c.icon);
                const count = servers.filter(s => s.connector === c.id).length;
                return (
                  <button key={c.id} onClick={() => onPick(c)}
                    className="text-left p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/50 hover:bg-[var(--bg-hover)] transition">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4 text-sky-400" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium truncate">{c.name}</span>
                        <span className="block mt-0.5"><Badge local={c.local} /></span>
                      </span>
                      {count > 0 && <span className="text-[10px] text-emerald-500 shrink-0">{count} added</span>}
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] mt-2 leading-snug">{c.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConnectorForm({ connector, server, locked, onCancel, onSaved }: {
  connector: Connector; server?: McpServer; locked: boolean; onCancel: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(server?.name ?? connector.name);
  const [values, setValues] = useState<McpServer['values']>(() => {
    const v: McpServer['values'] = {};
    for (const f of connector.fields) v[f.key] = server?.values[f.key] ?? (f.default ?? (f.kind === 'bool' ? false : ''));
    return v;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const Icon = connectorIcon(connector.icon);
  const missing = connector.fields.some(f => f.required && !String(values[f.key] ?? '').trim());

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (server) await api.updateMcpServer(server.id, { name, values });
      else await api.createMcpServer({ connector: connector.id, name, values });
      onSaved();
    } catch (e) {
      setError(String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e).replace(/^Error: \d+: /, ''));
    } finally { setSaving(false); }
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center"><Icon className="w-5 h-5 text-sky-400" /></span>
        <div>
          <div className="text-sm font-semibold">{server ? `Edit ${server.name}` : `Add ${connector.name}`}</div>
          <div className="text-xs text-[var(--text-muted)]">{connector.description}</div>
        </div>
      </div>
      {connector.local === false && (
        <div className="text-[11px] p-2 rounded-lg border border-sky-500/20 bg-sky-500/5 text-[var(--text-secondary)]">
          This is an external service: whatever agents send to these tools leaves this machine.
        </div>
      )}
      <label className="block text-[11px] text-[var(--text-muted)]">Name
        <input className={btn.input} value={name} onChange={e => setName(e.target.value)} />
      </label>
      {connector.fields.map(f => (
        <div key={f.key}>
          {f.kind === 'bool' ? (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{f.label}{f.hint && <span className="block text-[11px] text-[var(--text-muted)]">{f.hint}</span>}</span>
              <Toggle on={!!values[f.key]} label={f.label} onChange={v => setValues(s => ({ ...s, [f.key]: v }))} />
            </label>
          ) : (
            <label className="block text-[11px] text-[var(--text-muted)]">{f.label}{f.required && ' *'}
              {f.multiline ? (
                <textarea className={clsx(btn.input, 'font-mono text-xs min-h-[72px]')} placeholder={values[f.key] === SECRET ? '•••• stored (type to replace)' : f.placeholder}
                  value={values[f.key] === SECRET ? '' : String(values[f.key] ?? '')}
                  onChange={e => setValues(s => ({ ...s, [f.key]: e.target.value || (server?.values[f.key] === SECRET ? SECRET : '') }))} />
              ) : (
                <input className={clsx(btn.input, f.kind !== 'text' && 'font-mono')} type={f.kind === 'secret' ? 'password' : 'text'}
                  placeholder={values[f.key] === SECRET ? '•••• stored (type to replace)' : f.placeholder} autoComplete="off"
                  value={values[f.key] === SECRET ? '' : String(values[f.key] ?? '')}
                  onChange={e => setValues(s => ({ ...s, [f.key]: e.target.value || (server?.values[f.key] === SECRET ? SECRET : '') }))} />
              )}
              {f.hint && <span className="block mt-0.5">{f.hint}</span>}
            </label>
          )}
        </div>
      ))}
      {error && <div className="text-xs text-red-400 whitespace-pre-wrap">{error}</div>}
      <div className="flex justify-end gap-2">
        <button className={btn.subtle} onClick={onCancel}>Cancel</button>
        <button className={btn.primary} disabled={saving || missing || locked || !name.trim()} onClick={save}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}{server ? 'Save' : 'Add connector'}
        </button>
      </div>
    </div>
  );
}

// ── servers ────────────────────────────────────────────────────────────────

const STATUS: Record<McpServer['status'], [string, string]> = {
  ready: ['bg-emerald-400', 'connected'], starting: ['bg-amber-400 animate-pulse', 'starting…'],
  error: ['bg-red-400', 'error'], stopped: ['bg-neutral-500', 'off'],
};

function ServerList({ servers, connectors, locked, onReload, onEdit, onAdd }: {
  servers: McpServer[]; connectors: Connector[]; locked: boolean; onReload: () => void; onEdit: (s: McpServer) => void; onAdd: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!servers.length) {
    return (
      <div className="text-center py-10">
        <Plug className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
        <p className="text-sm mt-2">No MCP servers yet.</p>
        <button className={clsx(btn.primary, 'mt-3')} onClick={onAdd}><Plus className="w-3.5 h-3.5" />Add a connector</button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--text-muted)] mb-3">Each server's tools go to the agents you tick it for in the Agent Lab. Switch a server off to hide it from every agent.</p>
      {servers.map(s => {
        const conn = connectors.find(c => c.id === s.connector);
        const Icon = connectorIcon(conn?.icon);
        const expanded = open === s.id;
        const [dot, label] = STATUS[s.status];
        return (
          <div key={s.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-3 p-3">
              <button onClick={() => setOpen(expanded ? null : s.id)} className="text-[var(--text-muted)]" aria-label="Details">
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              <span className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-sky-400" />
              </span>
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setOpen(expanded ? null : s.id)}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><span className={clsx('w-1.5 h-1.5 rounded-full', dot)} />{label}</span>
                  {conn && <Badge local={conn.local} />}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] truncate font-mono">
                  {s.transport === 'stdio' ? [s.command?.split('/').pop(), ...(s.args ?? []).map(a => a.split('/').pop())].join(' ') : s.url}
                  {s.status === 'ready' && ` · ${s.tools.filter(t => t.enabled).length}/${s.tools.length} tools`}
                </div>
              </div>
              <Toggle on={s.enabled} label={s.name} onChange={async v => { await api.patchMcpServer(s.id, { enabled: v }); onReload(); }} />
            </div>
            {expanded && (
              <div className="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)] space-y-2">
                {s.error && <pre className="text-[11px] text-red-400 whitespace-pre-wrap font-mono bg-red-500/5 rounded-lg p-2 max-h-40 overflow-auto">{s.error}</pre>}
                {s.tools.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {s.tools.map(t => (
                      <label key={t.name} className="flex items-start gap-2 p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] cursor-pointer">
                        <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={t.enabled}
                          onChange={async () => {
                            const disabled = t.enabled ? [...s.disabledTools, t.name] : s.disabledTools.filter(x => x !== t.name);
                            await api.patchMcpServer(s.id, { disabledTools: disabled }); onReload();
                          }} />
                        <span className="min-w-0">
                          <span className="block text-xs font-mono">{t.name}{t.readOnly && <span className="ml-1 text-[10px] text-emerald-500 font-sans">read-only</span>}</span>
                          <span className="block text-[11px] text-[var(--text-muted)] leading-snug line-clamp-2">{t.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="flex justify-end gap-1">
                  <button className={btn.ghost} disabled={busy === s.id} onClick={async () => { setBusy(s.id); try { await api.restartMcpServer(s.id); } finally { setBusy(null); onReload(); } }}>
                    <RefreshCw className={clsx('w-3.5 h-3.5', busy === s.id && 'animate-spin')} />Reconnect
                  </button>
                  <button className={btn.ghost} disabled={locked} onClick={() => onEdit(s)}><Pencil className="w-3.5 h-3.5" />Edit</button>
                  <button className={clsx(btn.ghost, 'hover:text-red-400')} disabled={locked}
                    onClick={async () => { if (confirm(`Remove ${s.name}? Agents that use it lose its tools.`)) { await api.deleteMcpServer(s.id); onReload(); } }}>
                    <Trash2 className="w-3.5 h-3.5" />Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── built-in tools ─────────────────────────────────────────────────────────

function BuiltinTools({ tools, onChanged }: { tools: ToolInfo[]; onChanged: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--text-muted)] mb-3">Switch a tool off here to disable it for every agent. Pick which agents get which tools in the Agent Lab.</p>
      {tools.map(t => {
        const Icon = toolIcon(t.id);
        return (
          <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <span className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
              <Icon className="w-4 h-4 text-sky-400" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t.displayName}</span>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">{t.id}</span>
                {t.scope === 'project' && <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20">Studio</span>}
              </div>
              <div className="text-xs text-[var(--text-muted)]">{t.description}</div>
              {!t.available && <div className="text-[11px] text-amber-400 mt-0.5">Backing service is offline: {SERVICE_NAMES[t.service ?? ''] ?? t.service}</div>}
            </div>
            <Toggle on={t.enabled} label={t.displayName} onChange={async v => { await api.setTool(t.id, v); onChanged(); }} />
          </div>
        );
      })}
    </div>
  );
}

// ── Aphrodite (adult agent) ───────────────────────────────────────────────

function AphroditeTab({ settings, locked, onChanged }: { settings?: Settings; locked: boolean; onChanged: () => void }) {
  const [ckpts, setCkpts] = useState<{ name: string; size: number }[] | null>(null);
  const [fluxDev, setFluxDev] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (locked) return;
    api.adultCheckpoints().then(r => { setCkpts(r.checkpoints); setFluxDev(r.fluxDev); }).catch(() => setCkpts([]));
  }, [locked]);
  if (!settings) return null;
  const on = !!settings.adultEnabled;
  const current = settings.adultImageCheckpoint ?? '';
  const save = async (patch: Partial<Settings>) => {
    setError('');
    try { await api.saveSettings(patch); onChanged(); } catch (e) { setError(String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e)); }
  };
  return (
    <div className="space-y-5 max-w-3xl">
      <div className={clsx('p-4 rounded-xl border', on ? 'border-rose-500/30 bg-rose-500/5' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]')}>
        <div className="flex items-start gap-3">
          <Heart className={clsx('w-5 h-5 mt-0.5 shrink-0', on ? 'text-rose-400' : 'text-[var(--text-muted)]')} />
          <div className="flex-1">
            <div className="text-sm font-semibold">{on ? 'Aphrodite is on' : 'Aphrodite is off'}</div>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed max-w-[65ch]">
              An adult (18+) agent for explicit fiction, roleplay and images of fictional adult characters. It appears only
              in the owner's signed-in session, runs on local models only, never delegates or is delegated to, and every
              chat is incognito. Original adult characters only; background checks run quietly on each request.
            </p>
          </div>
          <Toggle on={on} disabled={locked} label="Aphrodite" onChange={v => save({ adultEnabled: v })} />
        </div>
      </div>
      <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
        <div className="text-sm font-semibold">Image model</div>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-[65ch]">
          SDXL checkpoints in <code className="font-mono">~/comfyui/models/checkpoints</code>. FLUX.1-dev is the fallback,
          but it rarely renders explicit images.
        </p>
        <select className="w-full max-w-md px-2.5 py-1.5 rounded-lg text-sm bg-[var(--bg-primary)] border border-[var(--border-subtle)]"
          value={current} disabled={locked || ckpts === null} onChange={e => save({ adultImageCheckpoint: e.target.value })}>
          <option value="">{fluxDev ? 'FLUX.1-dev (fallback)' : 'None installed'}</option>
          {current && ckpts && !ckpts.some(c => c.name === current) && <option value={current}>{current} (missing)</option>}
          {(ckpts ?? []).map(c => <option key={c.name} value={c.name}>{c.name} · {(c.size / 1e9).toFixed(1)} GB</option>)}
        </select>
        {ckpts && ckpts.length === 0 && <div className="text-[11px] text-amber-400">No SDXL checkpoints installed yet.</div>}
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

// ── cloud AI ───────────────────────────────────────────────────────────────

function CloudTab({ settings, locked, onChanged }: { settings?: Settings; locked: boolean; onChanged: () => void }) {
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  const [error, setError] = useState('');
  const load = () => api.providers().then(setProviders).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!settings) return null;
  const save = async (patch: Partial<Settings>) => {
    setError('');
    try { await api.saveSettings(patch); onChanged(); } catch (e) { setError(String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e)); }
  };
  return (
    <div className="space-y-5 max-w-3xl">
      <div className={clsx('p-4 rounded-xl border', settings.cloudEnabled ? 'border-sky-500/30 bg-sky-500/5' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]')}>
        <div className="flex items-start gap-3">
          {settings.cloudEnabled ? <Cloud className="w-5 h-5 text-sky-400 mt-0.5 shrink-0" /> : <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />}
          <div className="flex-1">
            <div className="text-sm font-semibold">{settings.cloudEnabled ? 'Cloud AI is on' : 'Fully local: cloud AI is off'}</div>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
              With cloud AI on, the Claude and Gemini agents (and any agent you point at a cloud model) send their conversation to
              that provider. Every other agent stays on this machine. While it is off, nothing is ever sent.
            </p>
          </div>
          <Toggle on={settings.cloudEnabled} disabled={locked} label="Cloud AI" onChange={v => save({ cloudEnabled: v })} />
        </div>
        {settings.cloudEnabled && (
          <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] space-y-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Local agents may consult cloud agents
                <span className="block text-[11px] text-[var(--text-muted)]">Shell:B can occasionally hand a task to Claude or Gemini via ask_agent. It is told not to include confidential data and to say when it did.</span>
              </span>
              <Toggle on={settings.cloudDelegation} disabled={locked} label="Delegation" onChange={v => save({ cloudDelegation: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Share long-term memory with cloud agents
                <span className="block text-[11px] text-[var(--text-muted)]">Off: cloud agents get no recalled memories and no memory tools.</span>
              </span>
              <Toggle on={settings.cloudMemory} disabled={locked} label="Memory" onChange={v => save({ cloudMemory: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Share the library with cloud agents
                <span className="block text-[11px] text-[var(--text-muted)]">Off: cloud agents can't see other Studio designs, Code workspaces, research notebooks, Projects or artifacts, and run_code gets no /library.</span>
              </span>
              <Toggle on={settings.cloudLibrary} disabled={locked} label="Library" onChange={v => save({ cloudLibrary: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Share the Codex with cloud agents
                <span className="block text-[11px] text-[var(--text-muted)]">Off: cloud agents can't search or read your notes, saved links, snippets and files.</span>
              </span>
              <Toggle on={settings.cloudCodex} disabled={locked} label="Codex" onChange={v => save({ cloudCodex: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Let cloud agents look at a shared screen
                <span className="block text-[11px] text-[var(--text-muted)]">Off: only local vision models get look_at_screen, so screenshots stay on this machine.</span>
              </span>
              <Toggle on={!!settings.cloudScreen} disabled={locked} label="Screen" onChange={v => save({ cloudScreen: v })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm">Let cloud agents use the browser on your computer
                <span className="block text-[11px] text-[var(--text-muted)]">Off: only local models get the browser tool, so the pages it reads stay on this machine.</span>
              </span>
              <Toggle on={!!settings.cloudBrowser} disabled={locked} label="Browser" onChange={v => save({ cloudBrowser: v })} />
            </label>
          </div>
        )}
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <CliAgents />
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">API providers</h3>
        {Object.entries(providers).map(([id, p]) => <ProviderCard key={id} id={id} p={p} locked={locked} onSaved={() => { load(); onChanged(); }} />)}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        Keys are stored on this server only and never sent to the browser. Pick a cloud model for any agent in the Agent Lab;
        the Claude and Gemini agents come preconfigured.
      </p>
    </div>
  );
}

function CliAgents() {
  const [clis, setClis] = useState<Record<string, CliAgent>>({});
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; text?: string }>>({});
  const load = (fresh = false) => { setBusy(true); api.cliAgents(fresh).then(setClis).catch(() => {}).finally(() => setBusy(false)); };
  useEffect(() => { load(); }, []);
  const runTest = async (id: string) => {
    setTests(t => ({ ...t, [id]: { busy: true } }));
    const r = await api.cliAgentModels(id).catch(e => ({ ok: false, error: String(e), models: [] }));
    setTests(t => ({ ...t, [id]: { ok: r.ok, text: r.ok ? `${r.models.length} models: ${r.models.slice(0, 6).map(m => m.id).join(', ')}${r.models.length > 6 ? '…' : ''}` : r.error } }));
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Logged-in CLIs</h3>
        <button className={clsx(btn.subtle, 'ml-auto')} onClick={() => load(true)} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Recheck'}
        </button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        No API key needed: these agents think through the CLI you're logged in to on this machine and use its subscription.
        The CLI's own shell, file and browser tools are switched off; it only gets the Shell:B tools you give the agent, with
        the usual approvals. Pick a <span className="font-mono">claude-code/</span>, <span className="font-mono">antigravity/</span> or
        <span className="font-mono"> codex/</span> model in the Agent Lab.
      </p>
      {Object.entries(clis).map(([id, c]) => {
        const t = tests[id] ?? {};
        return (
          <div key={id} className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-[11px] text-[var(--text-muted)] font-mono">{c.bin}</span>
              <span className={clsx('ml-auto text-[11px]', c.loggedIn ? 'text-emerald-500' : c.installed ? 'text-amber-400' : 'text-[var(--text-muted)]')}>
                {c.loggedIn ? `logged in${c.account ? ` · ${c.account}` : ''}` : c.installed ? 'not logged in' : 'not installed'}
              </span>
              {c.loggedIn && <button className={btn.subtle} onClick={() => runTest(id)} disabled={t.busy}>{t.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Models'}</button>}
            </div>
            {c.installed && !c.loggedIn && (
              <div className="text-[11px] text-[var(--text-muted)]">Log in once from a terminal on this machine: <span className="font-mono">{c.login}</span>, then Recheck.</div>
            )}
            {t.text && <div className={clsx('text-[11px]', t.ok ? 'text-emerald-500' : 'text-red-400')}>{t.text}</div>}
          </div>
        );
      })}
    </div>
  );
}

function ProviderCard({ id, p, locked, onSaved }: { id: string; p: Provider; locked: boolean; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState(p.baseUrl ?? '');
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});
  const [error, setError] = useState('');
  useEffect(() => { setBase(p.baseUrl ?? ''); }, [p.baseUrl]);
  const runTest = async () => {
    setTest({ busy: true });
    const r = await api.providerModels(id).catch(e => ({ ok: false, error: String(e), models: [] }));
    setTest({ ok: r.ok, text: r.ok ? `Connected · ${r.models.length} models` : r.error });
  };
  const save = async () => {
    setError('');
    try {
      await api.saveProvider(id, { apiKey: key, ...(id === 'openai' ? { baseUrl: base } : {}) });
      setKey(''); onSaved(); runTest();
    } catch (e) { setError(String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e)); }
  };
  return (
    <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{p.product}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{p.name}</span>
        <span className={clsx('ml-auto text-[11px]', p.configured ? 'text-emerald-500' : 'text-[var(--text-muted)]')}>
          {p.configured ? `key …${p.keyTail}${p.fromEnv ? ` (from ${p.env})` : ''}` : 'no key'}
        </span>
      </div>
      <div className="flex gap-2">
        <input type="password" autoComplete="off" className={clsx(btn.input, 'font-mono')} value={key} onChange={e => setKey(e.target.value)}
          placeholder={p.configured ? 'Replace key…' : 'API key'} disabled={locked} />
        <button className={btn.primary} disabled={locked || (!key.trim() && (id !== 'openai' || base === (p.baseUrl ?? '')))} onClick={save}>Save</button>
        {p.configured && <button className={btn.subtle} onClick={runTest} disabled={test.busy}>{test.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Test'}</button>}
      </div>
      {id === 'openai' && (
        <label className="block text-[11px] text-[var(--text-muted)]">Base URL (any OpenAI-compatible endpoint)
          <input className={clsx(btn.input, 'font-mono')} value={base} onChange={e => setBase(e.target.value)} disabled={locked} />
        </label>
      )}
      <div className="text-[11px] text-[var(--text-muted)]">{p.keyHint}</div>
      {test.text && <div className={clsx('text-[11px]', test.ok ? 'text-emerald-500' : 'text-red-400')}>{test.text}</div>}
      {error && <div className="text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
