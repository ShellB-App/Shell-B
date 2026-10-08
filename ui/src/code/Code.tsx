import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, Check, CodeXml, Copy, FolderGit2, GitBranch, Loader2, Moon, MoreHorizontal, Plus, Server, ShieldCheck, Sun, Trash2, Upload } from 'lucide-react';
import type { Agent, ModelInfo, ProjectSummary, SshHost } from '../types';
import { api } from '../api';
import { AgentAvatar, Modal, btn, relTime } from '../components/common';
import { FavoriteStar } from '../components/Favorites';
import { isFavorite } from '../favorites';
import { ProjectView } from '../studio/ProjectView';
import { SearchButton } from '../components/SearchButton';

interface Props {
  projectId?: string;
  agents: Agent[];
  models: ModelInfo[];
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  voiceOk: boolean;
  onOpenAgents: (id: string) => void;
  onExit: () => void;
  onOpenProject: (id?: string) => void;
}

/** Code: repositories you build, test and debug with a coding partner. Same folders + git as Studio, different workbench. */
export default function Code(p: Props) {
  if (p.projectId) {
    return <ProjectView key={p.projectId} projectId={p.projectId} agents={p.agents} models={p.models} theme={p.theme}
      onToggleTheme={p.onToggleTheme} voiceOk={p.voiceOk} onBack={() => p.onOpenProject()} onOpenAgents={p.onOpenAgents} />;
  }
  return <CodeHome {...p} />;
}

function CodeHome({ agents, theme, onToggleTheme, onExit, onOpenProject }: Props) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [dialog, setDialog] = useState<null | 'new' | 'clone' | 'ssh'>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const zipInput = useRef<HTMLInputElement>(null);
  const partner = agents.find(a => a.id === 'hephaestus');
  const load = () => api.projects().then(ps => setItems(ps.filter(x => x.kind === 'code'))).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
        <button className={btn.ghost} onClick={onExit} title="Back to chat"><ArrowLeft className="w-4 h-4" />Chat</button>
        <div className="flex items-center gap-2 ml-1">
          <span className="w-6 h-6 rounded-lg flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#0284c7,#4f46e5)' }}><CodeXml className="w-3.5 h-3.5" /></span>
          <span className="font-semibold tracking-tight">Code</span>
        </div>
        <div className="flex-1" />
        <SearchButton />
        <button className={btn.icon} onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
        <input ref={zipInput} type="file" accept=".zip" className="hidden" onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          setImporting(true); setError('');
          try { onOpenProject((await api.importCode(f)).id); } catch (err) { setError(String(err)); setImporting(false); }
        }} />
        <button className={clsx(btn.subtle, 'hidden sm:inline-flex')} onClick={() => zipInput.current?.click()} disabled={importing} title="Upload a .zip of a repository">
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Import .zip
        </button>
        <button className={btn.subtle} onClick={() => setDialog('clone')}><GitBranch className="w-3.5 h-3.5" /><span className="hidden sm:inline">Clone</span></button>
        <button className={btn.subtle} onClick={() => setDialog('ssh')} title="Work in a folder on another machine over SSH"><Server className="w-3.5 h-3.5" /><span className="hidden sm:inline">SSH</span></button>
        <button className={btn.primary} onClick={() => setDialog('new')}><Plus className="w-3.5 h-3.5" />New workspace</button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-8 flex items-start gap-4">
            {partner && <AgentAvatar agent={partner} size={44} className="rounded-xl shrink-0 hidden sm:flex" />}
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Code with {partner?.name ?? 'your partner'}</h1>
              <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">
                A workspace is a real git repository. Your partner reads and searches the code, makes focused edits, runs tests in the
                sandbox, and reviews its own diff. You get the file tree, an editor and a terminal. Every turn is a commit you can inspect or roll back.
              </p>
            </div>
          </div>

          {error && <div className="text-xs text-red-400 mb-4">{error}</div>}

          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">Workspaces</h2>
          {items === null ? (
            <div className="text-sm text-[var(--text-muted)] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-10 text-center">
              <FolderGit2 className="w-8 h-8 mx-auto text-[var(--text-muted)] mb-3" />
              <div className="text-sm font-medium">No workspaces yet</div>
              <p className="text-xs text-[var(--text-muted)] mt-1">Start from scratch, upload a .zip of a project, or clone a repository.</p>
              <div className="mt-4 flex justify-center gap-2">
                <button className={btn.subtle} onClick={() => setDialog('clone')}><GitBranch className="w-3.5 h-3.5" />Clone a repo</button>
                <button className={btn.primary} onClick={() => setDialog('new')}><Plus className="w-3.5 h-3.5" />New workspace</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map(w => (
                <div key={w.id} className="group relative rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition">
                  <button onClick={() => onOpenProject(w.id)} className="block w-full text-left p-3.5">
                    <div className="flex items-center gap-2">
                      {w.remote ? <Server className="w-4 h-4 text-amber-400 shrink-0" /> : <FolderGit2 className="w-4 h-4 text-[var(--accent)] shrink-0" />}
                      <span className="text-sm font-semibold truncate pr-14">{w.name}</span>
                    </div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1.5 line-clamp-2 min-h-[2.5em]">{w.description || 'No description'}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-2 truncate">{w.remote ? `${w.remote.target}:${w.remote.path}${w.remote.autoApprove ? ' · auto' : ''}` : `${w.fileCount} files`} · {relTime(w.updatedAt)}</div>
                  </button>
                  <FavoriteStar kind="project" id={w.id} title={w.name} className={clsx('absolute right-9 top-3', !isFavorite('project', w.id) && 'opacity-0 group-hover:opacity-100 focus:opacity-100')} />
                  <button onClick={() => setMenu(menu === w.id ? null : w.id)} aria-label="Workspace actions"
                    className="absolute right-2 top-3 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                  {menu === w.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                      <div className="absolute right-2 top-10 z-20 w-40 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl p-1 text-xs">
                        <button className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-hover)]"
                          onClick={async () => { const n = prompt('Rename workspace', w.name); setMenu(null); if (n?.trim()) { await api.patchProject(w.id, { name: n.trim() }); load(); } }}>Rename</button>
                        {!w.remote && <button className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-hover)]"
                          onClick={async () => { const n = prompt('Name for the copy', `${w.name} (copy)`); setMenu(null); if (n === null) return; try { await api.duplicateProject(w.id, n.trim()); load(); } catch (e) { alert(`Couldn't duplicate: ${e}`); } }}>Duplicate</button>}
                        <a className="block px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-hover)]" href={`/api/projects/${w.id}/export.zip`} onClick={() => setMenu(null)}>Download .zip</a>
                        <button className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-red-500/15 text-red-400 flex items-center gap-1.5"
                          onClick={async () => { setMenu(null); if (confirm(w.remote ? `Remove "${w.name}" and its chats? The files on ${w.remote.host} stay where they are.` : `Delete "${w.name}" with all its files, history and chats? This cannot be undone.`)) { await api.deleteProject(w.id); load(); } }}>
                          <Trash2 className="w-3.5 h-3.5" />Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {dialog === 'new' && <NewWorkspace onClose={() => setDialog(null)} onCreated={id => { setDialog(null); onOpenProject(id); }} />}
      {dialog === 'ssh' && <SshWorkspace onClose={() => setDialog(null)} onCreated={id => { setDialog(null); onOpenProject(id); }} />}
      {dialog === 'clone' && <CloneRepo onClose={() => setDialog(null)} onCreated={id => { setDialog(null); onOpenProject(id); }} />}
    </div>
  );
}

function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true); setError('');
    try {
      const w = await api.createProject({ name: name.trim() || 'Untitled workspace', kind: 'code', brief });
      if (start && brief.trim()) {
        try { sessionStorage.setItem(`shellb.autostart.${w.id}`, brief.trim()); } catch { /* private mode */ }
      }
      onCreated(w.id);
    } catch (e) { setError(String(e)); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New code workspace" icon={<CodeXml className="w-4 h-4 text-sky-400" />}>
      <div className="overflow-y-auto p-4 sm:p-5 space-y-4">
        <label className="block text-[11px] text-[var(--text-muted)]">Name
          <input className={btn.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. test-station log parser" autoFocus />
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">What are we building?
          <textarea className={clsx(btn.input, 'min-h-[120px] leading-relaxed')} value={brief} onChange={e => setBrief(e.target.value)}
            placeholder="What it should do, inputs and outputs, language or framework, and how you'll know it works." />
        </label>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} className="accent-[var(--accent)]" disabled={!brief.trim()} />
          Have Hephaestus plan and build the first version right away
        </label>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2 bg-[var(--bg-secondary)]">
        <button className={btn.subtle} onClick={onClose}>Cancel</button>
        <button className={btn.primary} onClick={create} disabled={busy}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Create workspace</button>
      </footer>
    </Modal>
  );
}

function CloneRepo({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clone = async () => {
    setBusy(true); setError('');
    try { onCreated((await api.cloneRepo(url.trim())).id); } catch (e) { setError(String(e)); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Clone a repository" icon={<GitBranch className="w-4 h-4 text-sky-400" />}>
      <div className="p-4 sm:p-5 space-y-3">
        <label className="block text-[11px] text-[var(--text-muted)]">Repository URL (https)
          <input className={clsx(btn.input, 'font-mono')} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repo"
            autoFocus onKeyDown={e => { if (e.key === 'Enter' && url.trim() && !busy) clone(); }} />
        </label>
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          Public repositories only (no credentials). The server clones it here; the sandbox that runs code stays offline, so
          dependencies that need downloading won't install.
        </p>
        {error && <div className="text-xs text-red-400 break-words">{error}</div>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2 bg-[var(--bg-secondary)]">
        <button className={btn.subtle} onClick={onClose}>Cancel</button>
        <button className={btn.primary} onClick={clone} disabled={busy || !url.trim()}>{busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Cloning…</> : <><GitBranch className="w-3.5 h-3.5" />Clone</>}</button>
      </footer>
    </Modal>
  );
}

/** Remote workspaces: pin a host's key, install the Shell:B key there, then open a folder on it. Owner only. */
function SshWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [pub, setPub] = useState('');
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '22', user: '' });
  const [pick, setPick] = useState('');
  const [path, setPath] = useState('');
  const [tested, setTested] = useState<Record<string, string>>({});
  const [pwFor, setPwFor] = useState('');
  const [pw, setPw] = useState('');
  // a password typed here crosses the network in the clear unless the page is HTTPS, local, or reached over Tailscale
  const plainNet = location.protocol === 'http:' && !/^(localhost|127\.|\[::1\]|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(location.hostname)
    && !location.hostname.endsWith('.ts.net');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = () => api.sshHosts().then(h => { setHosts(h); setPick(p => p || h.find(x => x.trusted)?.id || ''); });
  useEffect(() => {
    Promise.all([load(), api.sshKey().then(k => setPub(k.publicKey))])
      .catch(e => setError(String(e).includes('admin-key-required') ? 'Sign in as the owner to manage SSH hosts.' : String(e)));
  }, []);
  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await f(); } catch (e) { setError(String(e)); }
    setBusy('');
  };
  const trusted = (hosts ?? []).filter(h => h.trusted);
  return (
    <Modal open onClose={onClose} title="Remote workspace over SSH" icon={<Server className="w-4 h-4 text-amber-400" />}>
      <div className="overflow-y-auto p-4 sm:p-5 space-y-5 text-xs">
        <section className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">1 · Shell:B's key</div>
          <p className="text-[var(--text-secondary)] leading-relaxed">Add this line to <code>~/.ssh/authorized_keys</code> for the user on the remote machine, or let Shell:B
            install it with the user's password once the host is trusted. Shell:B never uses your own keys or ssh-agent.</p>
          <div className="flex gap-1.5">
            <code className="flex-1 min-w-0 p-2 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] font-mono text-[10px] break-all">{pub || '…'}</code>
            <button className={btn.icon} title="Copy" disabled={!pub}
              onClick={() => { navigator.clipboard?.writeText(pub).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">2 · Hosts</div>
          {(hosts ?? []).map(h => (
            <div key={h.id} className="rounded-xl border border-[var(--border-subtle)] p-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{h.name}</span>
                <span className="font-mono text-[var(--text-muted)] truncate">{h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ''}</span>
                <button className="ml-auto text-[var(--text-muted)] hover:text-red-400" title="Remove host"
                  onClick={() => confirm(`Remove ${h.name}? Workspaces on it stop working.`) && run('del', async () => { await api.deleteSshHost(h.id); await load(); })}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="font-mono text-[10px] text-[var(--text-secondary)] break-all">{h.fingerprint}</div>
              {!h.trusted ? (
                <div className="space-y-1.5">
                  <p className="text-amber-400 leading-relaxed">Check this fingerprint on the machine itself (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>) before trusting it.</p>
                  <button className={btn.subtle} disabled={!!busy} onClick={() => run('trust', async () => { await api.trustSshHost(h.id, h.fingerprint); await load(); })}>
                    <ShieldCheck className="w-3.5 h-3.5" />It matches, trust this host
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button className={btn.subtle} disabled={!!busy} onClick={() => run('test', async () => {
                    try { const t = await api.testSshHost(h.id); setTested(x => ({ ...x, [h.id]: `✓ ${t.system} · ${t.home}` })); if (!path) setPath(t.home); }
                    catch (e) { setTested(x => ({ ...x, [h.id]: `✗ ${String(e)}` })); }
                  })}>{busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}Test connection</button>
                  <label className="flex items-center gap-1.5 text-[var(--text-secondary)]" title="Run the agent's commands and file changes on this host without asking">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={h.autoApprove}
                      onChange={e => { const on = e.target.checked; if (!on || confirm(`Auto mode lets agents run any command on ${h.name} without asking. Turn it on?`)) run('auto', async () => { await api.patchSshHost(h.id, { autoApprove: on }); await load(); }); }} />
                    Auto mode (don't ask before commands and edits)
                  </label>
                  {tested[h.id] && <div className={clsx('w-full font-mono text-[10px] break-words', tested[h.id].startsWith('✓') ? 'text-emerald-400' : 'text-red-400')}>{tested[h.id]}</div>}
                  {pwFor !== h.id ? (
                    <button className="text-[11px] text-[var(--accent)] hover:underline" onClick={() => { setPwFor(h.id); setPw(''); }}>Install the key with a password…</button>
                  ) : (
                    <form className="w-full space-y-1.5" onSubmit={e => {
                      e.preventDefault();
                      const secret = pw; setPw('');
                      run('install', async () => {
                        const r = await api.installSshKey(h.id, secret);
                        setPwFor('');
                        setTested(x => ({ ...x, [h.id]: r.result === 'added' ? '✓ Key installed; key login works' : '✓ Key was already installed; key login works' }));
                      });
                    }}>
                      <p className="text-[var(--text-secondary)] leading-relaxed">Shell:B logs in once with {h.user}'s password, adds its public key to <code>~/.ssh/authorized_keys</code>, then
                        checks that key login works. The password isn't stored or logged.</p>
                      {plainNet && <p className="text-amber-400 leading-relaxed">This page is plain HTTP, so the password crosses your network unencrypted on its way to Shell:B. Use Tailscale or the machine itself, or paste the key by hand.</p>}
                      <div className="flex gap-1.5">
                        <input type="password" autoComplete="off" className={clsx(btn.input, 'mt-0 flex-1')} placeholder={`password for ${h.user}@${h.host}`} value={pw} onChange={e => setPw(e.target.value)} autoFocus />
                        <button type="submit" className={btn.subtle} disabled={!!busy || !pw}>{busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}Install key</button>
                        <button type="button" className={btn.subtle} onClick={() => { setPwFor(''); setPw(''); }}>Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="grid grid-cols-6 gap-1.5">
            <input className={clsx(btn.input, 'col-span-3 mt-0')} placeholder="host or IP" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
            <input className={clsx(btn.input, 'col-span-1 mt-0')} placeholder="port" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} />
            <input className={clsx(btn.input, 'col-span-2 mt-0')} placeholder="user" value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} />
            <input className={clsx(btn.input, 'col-span-4 mt-0')} placeholder="name (optional)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <button className={clsx(btn.subtle, 'col-span-2 justify-center')} disabled={!!busy || !form.host.trim() || !form.user.trim()}
              onClick={() => run('add', async () => { await api.addSshHost({ ...form, port: Number(form.port) || 22 }); setForm({ name: '', host: '', port: '22', user: '' }); await load(); })}>
              {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Add host
            </button>
          </div>
        </section>

        <section className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">3 · Folder</div>
          <div className="flex gap-1.5">
            <select className={clsx(btn.input, 'mt-0 w-48')} value={pick} onChange={e => setPick(e.target.value)} disabled={!trusted.length}>
              {!trusted.length && <option value="">No trusted hosts</option>}
              {trusted.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <input className={clsx(btn.input, 'mt-0 flex-1 font-mono')} placeholder="/home/me/project" value={path} onChange={e => setPath(e.target.value)} />
          </div>
          <p className="text-[var(--text-muted)] leading-relaxed">Agents work in this folder as the SSH user. Unless auto mode is on, you approve each command and file change in the chat.
            Remote folders have no Shell:B version history, so use git there.</p>
        </section>
        {error && <div className="text-red-400 break-words">{error}</div>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2 bg-[var(--bg-secondary)]">
        <button className={btn.subtle} onClick={onClose}>Cancel</button>
        <button className={btn.primary} disabled={!!busy || !pick || !path.trim()}
          onClick={() => run('open', async () => onCreated((await api.createRemoteWorkspace(pick, path.trim())).id))}>
          {busy === 'open' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}Open workspace
        </button>
      </footer>
    </Modal>
  );
}
