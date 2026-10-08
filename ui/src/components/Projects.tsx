import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft, ArrowUp, Boxes, FileText, FolderKanban, Loader2, MessageSquare, MoreHorizontal, Pin, Plus, Search, Trash2, Upload, X,
} from 'lucide-react';
import type { Agent, ChatProject, ChatProjectDetail } from '../types';
import { api, fmtBytes } from '../api';
import { AgentAvatar, Modal, btn, relTime } from './common';
import { ProjectTodos } from './ProjectTodos';
import { FavoriteStar } from './Favorites';
import { openContextMenu } from './ContextMenu';
import { chatProjectMenu, PROJECT_EMOJIS } from './projectMenu';

const EMOJIS = PROJECT_EMOJIS;

export function ProjectGlyph({ project, size = 18 }: { project?: Pick<ChatProject, 'emoji' | 'name'>; size?: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] shrink-0 select-none"
      style={{ width: size, height: size, fontSize: size * 0.6 }} aria-hidden>
      {project?.emoji || <FolderKanban style={{ width: size * 0.6, height: size * 0.6 }} className="text-[var(--accent)]" />}
    </span>
  );
}

// ── new project ────────────────────────────────────────────────────────────

export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: ChatProject) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setName(''); setDescription(''); setEmoji(''); setError(''); } }, [open]);
  const create = async () => {
    try { onCreated(await api.createChatProject({ name: name.trim(), description, instructions: '', emoji })); }
    catch (e) { setError(String(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New project" icon={<FolderKanban className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="p-5 space-y-4 overflow-y-auto">
        <p className="text-xs text-[var(--text-muted)]">
          A project keeps related chats together with shared instructions and knowledge files. Every chat in it can see them.
        </p>
        <div className="flex gap-1.5 flex-wrap">
          {EMOJIS.map(e => (
            <button key={e} onClick={() => setEmoji(emoji === e ? '' : e)}
              className={clsx('w-8 h-8 rounded-lg text-base border transition', emoji === e ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>{e}</button>
          ))}
        </div>
        <label className="block text-[11px] text-[var(--text-muted)]">Name
          <input className={btn.input} value={name} autoFocus onChange={e => setName(e.target.value)} placeholder="e.g. 27510 product launch"
            onKeyDown={e => e.key === 'Enter' && name.trim() && create()} />
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">What is it about? <span className="opacity-75">(optional)</span>
          <textarea className={clsx(btn.input, 'min-h-[72px]')} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Goals, audience, anything every chat should know at a glance" />
        </label>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className={btn.subtle} onClick={onClose}>Cancel</button>
          <button className={btn.primary} disabled={!name.trim()} onClick={create}><Plus className="w-3.5 h-3.5" />Create project</button>
        </div>
      </div>
    </Modal>
  );
}

// ── all projects ───────────────────────────────────────────────────────────

export function ProjectsIndex({ projects, onOpen, onNew, onChanged }: {
  projects: ChatProject[]; onOpen: (id: string) => void; onNew: () => void;
  /** the list changed through a card's context menu (rename, icon, pin, delete) */
  onChanged?: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = projects.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-2xl font-semibold tracking-tight flex-1">Projects</h1>
          <button className={btn.primary} onClick={onNew}><Plus className="w-3.5 h-3.5" />New project</button>
        </div>
        <div className="relative mb-4">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder="Search projects" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {shown.map(p => (
            <button key={p.id} onClick={() => onOpen(p.id)}
              onContextMenu={e => openContextMenu(e, chatProjectMenu(p, { onOpen: () => onOpen(p.id), onChanged: () => onChanged?.() }), { own: true })}
              className="text-left p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition">
              <div className="flex items-center gap-2.5">
                <ProjectGlyph project={p} size={26} />
                <span className="font-medium truncate flex-1">{p.name}</span>
                {p.pinned && <Pin className="w-3 h-3 fill-[var(--accent)] text-[var(--accent)]" />}
                <FavoriteStar nested kind="group" id={p.id} title={p.name} />
              </div>
              {p.description && <p className="text-xs text-[var(--text-secondary)] mt-2 line-clamp-2">{p.description}</p>}
              <div className="text-[11px] text-[var(--text-muted)] mt-3 flex gap-3">
                <span>{p.chatCount ?? 0} chat{p.chatCount === 1 ? '' : 's'}</span>
                <span>{p.fileCount ?? 0} file{p.fileCount === 1 ? '' : 's'}</span>
                <span>updated {relTime(p.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
        {shown.length === 0 && (
          <div className="text-center py-16 text-sm text-[var(--text-muted)]">
            <FolderKanban className="w-8 h-8 mx-auto mb-2" />
            {projects.length ? 'No matches.' : 'No projects yet. Create one to keep related chats, instructions and files together.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── one project ────────────────────────────────────────────────────────────

interface PageProps {
  projectId: string;
  agents: Agent[];
  agent: Agent;
  onBack: () => void;
  onOpenChat: (convId: string, artifactId?: string) => void;
  onStartChat: (text: string) => void;
  onChanged: () => void; // project list (name, counts) changed
  onDeleted: () => void;
  refreshKey?: unknown;
}

export function ProjectPage({ projectId, agents, agent, onBack, onOpenChat, onStartChat, onChanged, onDeleted, refreshKey }: PageProps) {
  const [p, setP] = useState<ChatProjectDetail | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [instr, setInstr] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.chatProject(projectId).then(d => {
    setP(d); setInstr(i => (i === '' || i === p?.instructions ? d.instructions : i));
  }).catch(e => setError(String(e))), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setP(null); setInstr(''); load(); }, [projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p) { setName(p.name); setDesc(p.description); } }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // poll while files are being indexed
  useEffect(() => {
    if (!p?.files.some(f => f.status === 'indexing')) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [p, load]);

  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>;
  if (!p) return <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;

  const patch = async (x: Parameters<typeof api.patchChatProject>[1]) => { await api.patchChatProject(p.id, x); await load(); onChanged(); };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try { await api.uploadChatProjectFiles(p.id, files); await load(); onChanged(); } catch (e) { setError(String(e)); } finally { setUploading(false); }
  };
  const start = () => { if (draft.trim()) { onStartChat(draft.trim()); setDraft(''); } };
  const pct = Math.min(100, Math.round((p.knowledgeChars / 40000) * 100));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 animate-fade-in">
        <button className={clsx(btn.ghost, '-ml-2 mb-3')} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />All projects</button>

        <div className="flex items-start gap-3">
          <ProjectGlyph project={p} size={40} />
          <div className="flex-1 min-w-0">
            {editingName ? (
              <input className={clsx(btn.input, 'text-xl font-semibold')} value={name} autoFocus onChange={e => setName(e.target.value)}
                onBlur={() => { setEditingName(false); if (name.trim() && name !== p.name) patch({ name: name.trim() }); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(p.name); setEditingName(false); } }} />
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight truncate cursor-text" title="Click to rename" onClick={() => setEditingName(true)}>{p.name}</h1>
            )}
            <textarea className="mt-1 w-full bg-transparent text-sm text-[var(--text-secondary)] resize-none focus:outline-none focus:bg-[var(--bg-tertiary)] rounded px-1 -mx-1"
              rows={Math.min(4, Math.max(1, desc.split('\n').length))} value={desc} placeholder="Add a description"
              onChange={e => setDesc(e.target.value)} onBlur={() => desc !== p.description && patch({ description: desc })} />
          </div>
          <FavoriteStar kind="group" id={p.id} title={p.name} size={16} className="p-1.5" />
          <div className="relative">
            <button className={btn.icon} onClick={() => setMenu(m => !m)} aria-label="Project options"><MoreHorizontal className="w-4 h-4" /></button>
            {menu && (
              <div className="absolute right-0 top-full mt-1 w-56 z-30 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1" onMouseLeave={() => setMenu(false)}>
                <div className="flex flex-wrap gap-1 p-1.5 border-b border-[var(--border-subtle)] mb-1">
                  {EMOJIS.map(e => <button key={e} className="w-7 h-7 rounded hover:bg-[var(--bg-hover)]" onClick={() => { patch({ emoji: e }); setMenu(false); }}>{e}</button>)}
                </div>
                <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--bg-hover)]" onClick={() => { patch({ pinned: !p.pinned }); setMenu(false); }}>
                  <Pin className="w-3.5 h-3.5" />{p.pinned ? 'Unpin' : 'Pin to top'}
                </button>
                <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--bg-hover)] text-red-400" onClick={async () => {
                  setMenu(false);
                  if (!confirm(`Delete the project "${p.name}"? Its files are deleted; its ${p.chats.length} chat(s) are kept and move back to your chat list.`)) return;
                  await api.deleteChatProject(p.id, false); onDeleted();
                }}><Trash2 className="w-3.5 h-3.5" />Delete project</button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* chats */}
          <div className="min-w-0">
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-2 focus-within:border-[var(--accent)]/60 transition">
              <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3}
                placeholder={`Start a chat in ${p.name}…`}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); } }}
                className="w-full bg-transparent resize-none px-2 py-1.5 text-sm focus:outline-none placeholder-[var(--text-muted)]" />
              <div className="flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><AgentAvatar agent={agent} size={16} />{agent.name}</span>
                <button className={clsx(btn.primary, 'rounded-full w-8 h-8 px-0')} disabled={!draft.trim()} onClick={start} aria-label="Start chat"><ArrowUp className="w-4 h-4" /></button>
              </div>
            </div>

            <ProjectTodos projectId={p.id} agents={agents} agent={agent} onOpenChat={id => onOpenChat(id)}
              onActivity={() => { load(); onChanged(); }} />

            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mt-6 mb-2">Chats · {p.chats.length}</h2>
            <div className="space-y-1">
              {p.chats.map(c => {
                const a = agents.find(x => x.id === c.agentId);
                return (
                  <div key={c.id} className="group flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] cursor-pointer transition" onClick={() => onOpenChat(c.id)}>
                    <AgentAvatar agent={a} size={20} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{c.title}</span>
                      <span className="block text-[11px] text-[var(--text-muted)]">{a?.name ?? c.agentId} · {relTime(c.updatedAt)}</span>
                    </span>
                    <button className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100" title="Remove from project"
                      onClick={async e => { e.stopPropagation(); await api.patchConversation(c.id, { groupId: null }); load(); onChanged(); }}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
              {p.chats.length === 0 && (
                <div className="text-xs text-[var(--text-muted)] py-6 text-center border border-dashed border-[var(--border-subtle)] rounded-xl">
                  <MessageSquare className="w-5 h-5 mx-auto mb-1.5" />No chats yet. Start one above, or move existing chats here from the sidebar.
                </div>
              )}
            </div>
          </div>

          {/* context */}
          <div className="space-y-4">
            <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
              <h2 className="text-sm font-medium">Instructions</h2>
              <p className="text-[11px] text-[var(--text-muted)] mb-2">Added to every chat in this project: tone, role, rules, background.</p>
              <textarea className={clsx(btn.input, 'text-xs min-h-[110px] leading-relaxed')} value={instr} onChange={e => setInstr(e.target.value)}
                placeholder="e.g. I'm planning a home studio build. Keep answers practical, use metric units, and cite sources." />
              {instr !== p.instructions && (
                <div className="flex justify-end gap-1.5 mt-1.5">
                  <button className={btn.subtle} onClick={() => setInstr(p.instructions)}>Discard</button>
                  <button className={btn.primary} onClick={() => patch({ instructions: instr })}>Save</button>
                </div>
              )}
            </section>

            <section className={clsx('rounded-xl border bg-[var(--bg-secondary)] p-3 transition', drag ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border-subtle)]')}
              onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); upload(Array.from(e.dataTransfer.files)); }}>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium flex-1">Knowledge</h2>
                <button className={btn.subtle} onClick={() => fileInput.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Add files
                </button>
                <input ref={fileInput} type="file" multiple hidden onChange={e => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; upload(fs); }} />
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5 mb-2">PDF, Word, Excel, PowerPoint, text and code. Drop files here.</p>
              {p.files.length > 0 && (
                <div className="mb-2">
                  <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div className={clsx('h-full rounded-full', p.inline ? 'bg-[var(--accent)]' : 'bg-sky-400')} style={{ width: `${p.inline ? pct : 100}%` }} />
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-1">
                    {p.knowledgeChars.toLocaleString()} characters ·{' '}
                    {p.inline ? 'small enough that every chat reads it in full' : 'too large to read in full, so agents search it as needed'}
                  </div>
                </div>
              )}
              <div className="space-y-1">
                {p.files.map(f => (
                  <div key={f.name} className="group flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                    <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                    <a className="flex-1 min-w-0 truncate hover:text-[var(--accent)]" href={`/api/chat-projects/${p.id}/files/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer">{f.name}</a>
                    {f.status === 'indexing' && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" aria-label="Indexing" />}
                    {f.status === 'error' && <span className="text-[10px] text-red-400" title={f.error}>error</span>}
                    {f.status === 'no-text' && <span className="text-[10px] text-amber-400" title="No text could be extracted. The file is still available in the code sandbox.">no text</span>}
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">{fmtBytes(f.size)}</span>
                    <button className="p-0.5 rounded text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100" title="Remove"
                      onClick={async () => { await api.deleteChatProjectFile(p.id, f.name); load(); onChanged(); }}><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
                {p.files.length === 0 && <div className="text-[11px] text-[var(--text-muted)] py-3 text-center border border-dashed border-[var(--border-subtle)] rounded-lg">No files yet</div>}
              </div>
            </section>

            {p.artifacts.length > 0 && (
              <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                <h2 className="text-sm font-medium mb-2">Artifacts · {p.artifacts.length}</h2>
                <div className="space-y-1">
                  {p.artifacts.map(a => (
                    <button key={`${a.convId}-${a.id}`} onClick={() => onOpenChat(a.convId, a.id)}
                      className="w-full flex items-center gap-2 text-left text-xs px-2 py-1.5 rounded-lg hover:bg-[var(--bg-hover)]">
                      <Boxes className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{a.title}</span>
                        <span className="block text-[10px] text-[var(--text-muted)] truncate">{a.type} · v{a.version} · {a.chatTitle}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
