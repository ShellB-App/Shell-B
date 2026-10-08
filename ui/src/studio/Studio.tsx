import { useEffect, useRef, useState, type DragEvent } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft, Blocks, Box, Brush, Clapperboard, CodeXml, FileText, Gamepad2, LayoutDashboard, Loader2, Mail, Monitor, MoreHorizontal, Music, Palette, PenTool, Plus,
  Server,
  Presentation, Share2, Smartphone, Sparkles, Sun, Moon, Upload, X,
} from 'lucide-react';
import type { Agent, KindInfo, ModelInfo, ProjectKind, ProjectSummary } from '../types';
import { api, fmtBytes } from '../api';
import { Modal, btn, relTime } from '../components/common';
import { FavoriteStar } from '../components/Favorites';
import { isFavorite } from '../favorites';
import { ProjectView } from './ProjectView';
import { SearchButton } from '../components/SearchButton';
import { openContextMenu, openMenuAt } from '../components/ContextMenu';
import { workspaceMenu } from '../components/projectMenu';

export const KIND_ICON: Record<ProjectKind, typeof Monitor> = {
  website: Monitor, deck: Presentation, print: FileText, mobile: Smartphone, dashboard: LayoutDashboard,
  'design-system': Blocks, brand: PenTool, social: Share2, email: Mail, motion: Clapperboard, game: Gamepad2, '3d': Box,
  fullstack: Server, music: Music, illustration: Brush, blank: Sparkles, code: CodeXml,
};

const KIND_ORDER: ProjectKind[] = [
  'website', 'deck', 'print', 'mobile', 'dashboard', 'design-system', 'brand', 'social', 'email', 'motion', 'game', '3d', 'fullstack', 'music', 'illustration', 'blank',
];

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

export default function Studio(p: Props) {
  if (p.projectId) {
    return <ProjectView key={p.projectId} projectId={p.projectId} agents={p.agents} models={p.models} theme={p.theme}
      onToggleTheme={p.onToggleTheme} voiceOk={p.voiceOk} onBack={() => p.onOpenProject()} onOpenAgents={p.onOpenAgents} />;
  }
  return <StudioHome {...p} />;
}

function StudioHome({ theme, onToggleTheme, onExit, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [kinds, setKinds] = useState<Record<ProjectKind, KindInfo>>();
  const [creating, setCreating] = useState<ProjectKind | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  // Code workspaces share the project machinery but have their own home (#/code)
  const load = () => api.projects().then(ps => setProjects(ps.filter(pr => pr.kind !== 'code'))).catch(() => setProjects([]));
  useEffect(() => { load(); api.kinds().then(setKinds); }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
        <button className={btn.ghost} onClick={onExit} title="Back to chat"><ArrowLeft className="w-4 h-4" />Chat</button>
        <div className="flex items-center gap-2 ml-1">
          <span className="w-6 h-6 rounded-lg flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#e11d48,#f59e0b)' }}><Palette className="w-3.5 h-3.5" /></span>
          <span className="font-semibold tracking-tight">Studio</span>
        </div>
        <div className="flex-1" />
        <SearchButton />
        <button className={btn.icon} onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
        <input ref={importInput} type="file" accept=".zip,.html,.htm" className="hidden" onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          setImporting(true); setImportError('');
          try { onOpenProject((await api.importProject(f)).id); } catch (err) { setImportError(String(err)); setImporting(false); }
        }} />
        <button className={btn.subtle} onClick={() => importInput.current?.click()} disabled={importing} title="Import a Claude Design export (.zip or .html)">
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Import from Claude Design
        </button>
        <button className={btn.primary} onClick={() => setCreating('website')}><Plus className="w-3.5 h-3.5" />New project</button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight">Design with Daedalus</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">
              Upload your logos, photos, fonts and references, describe what you need, and iterate on real files: pages, decks,
              flyers, app screens, design systems, brands, games and 3D scenes. Point at anything in the preview to change it. Every turn is a version you can restore.
            </p>
          </div>

          {importError && <div className="text-xs text-red-400 mb-4">{importError}</div>}
          {kinds && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7 gap-2 mb-10">
              {KIND_ORDER.map(k => {
                const I = KIND_ICON[k];
                return (
                  <button key={k} onClick={() => setCreating(k)}
                    className="text-left p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] transition group">
                    <I className="w-5 h-5 text-[var(--accent)] mb-2" />
                    <div className="text-xs font-semibold group-hover:text-[var(--accent-soft)]">{kinds[k].label}</div>
                    <div className="text-[11px] text-[var(--text-muted)] leading-snug mt-0.5">{kinds[k].blurb}</div>
                  </button>
                );
              })}
            </div>
          )}

          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">Projects</h2>
          {projects === null ? (
            <div className="text-sm text-[var(--text-muted)] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-10 text-center">
              <div className="text-sm font-medium">No projects yet</div>
              <p className="text-xs text-[var(--text-muted)] mt-1">Pick a format above to start your first one.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map(pr => {
                const I = KIND_ICON[pr.kind] ?? Sparkles;
                return (
                  <div key={pr.id} className="group relative rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden hover:border-[var(--border-strong)] transition"
                    onContextMenu={e => openContextMenu(e, workspaceMenu(pr, { onOpen: () => onOpenProject(pr.id), reload: load }), { own: true })}>
                    <button onClick={() => onOpenProject(pr.id)} className="block w-full text-left">
                      <div className="aspect-[16/10] bg-[var(--bg-tertiary)] overflow-hidden flex items-center justify-center">
                        {pr.cover ? <img src={pr.cover} alt="" className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform duration-300" />
                          : <I className="w-8 h-8 text-[var(--text-muted)]" />}
                      </div>
                      <div className="p-3">
                        <div className="text-sm font-semibold truncate pr-6">{pr.name}</div>
                        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 flex items-center gap-1.5">
                          <I className="w-3 h-3" />{kinds?.[pr.kind]?.label ?? pr.kind} · {pr.fileCount} files · {relTime(pr.updatedAt)}
                        </div>
                      </div>
                    </button>
                    <FavoriteStar kind="project" id={pr.id} title={pr.name}
                      className={clsx('absolute right-2 top-2 bg-black/50 backdrop-blur hover:bg-black/60', !isFavorite('project', pr.id) && 'opacity-0 group-hover:opacity-100 focus:opacity-100 !text-white/80')} />
                    <button onClick={e => openMenuAt(e, workspaceMenu(pr, { onOpen: () => onOpenProject(pr.id), reload: load }))} aria-label="Project actions" aria-haspopup="menu"
                      className="absolute right-2 bottom-3 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {kinds && creating && (
        <NewProjectModal kinds={kinds} initialKind={creating} onClose={() => setCreating(null)}
          onCreated={id => { setCreating(null); onOpenProject(id); }} />
      )}
    </div>
  );
}

function NewProjectModal({ kinds, initialKind, onClose, onCreated }: {
  kinds: Record<ProjectKind, KindInfo>; initialKind: ProjectKind; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<ProjectKind>(initialKind);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async () => {
    setBusy(true); setError('');
    try {
      const pr = await api.createProject({ name: name.trim() || `Untitled ${kinds[kind].label.toLowerCase()}`, kind, brief });
      if (files.length) await api.uploadAssets(pr.id, files);
      if (start && brief.trim()) {
        try { sessionStorage.setItem(`shellb.autostart.${pr.id}`, brief.trim()); } catch { /* private mode */ }
      }
      onCreated(pr.id);
    } catch (e) { setError(String(e)); setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="New Studio project" icon={<Palette className="w-4 h-4 text-rose-400" />}>
      <div className="overflow-y-auto p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {KIND_ORDER.map(k => {
            const I = KIND_ICON[k];
            return (
              <button key={k} onClick={() => setKind(k)}
                className={clsx('text-left p-2.5 rounded-xl border transition', kind === k ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]')}>
                <div className="flex items-center gap-1.5 text-xs font-semibold"><I className="w-3.5 h-3.5 text-[var(--accent)]" />{kinds[k].label}</div>
                <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5">{kinds[k].viewport[0]}×{kinds[k].viewport[1]}</div>
              </button>
            );
          })}
        </div>
        <label className="block text-[11px] text-[var(--text-muted)]">Name
          <input className={btn.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Indie game launch page" autoFocus />
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">Brief
          <textarea className={clsx(btn.input, 'min-h-[110px] leading-relaxed')} value={brief} onChange={e => setBrief(e.target.value)}
            placeholder="What is it, who is it for, and what should it make them do? Mention tone, must-have content, and anything to avoid." />
        </label>
        <div
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => { e.preventDefault(); setFiles(f => [...f, ...Array.from(e.dataTransfer.files)]); }}
          className="rounded-xl border border-dashed border-[var(--border-strong)] p-3">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { setFiles(f => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-[var(--text-secondary)]">Assets <span className="text-[var(--text-muted)]">(logos, photos, fonts, brand PDFs, references)</span></div>
            <button className={btn.subtle} onClick={() => fileInput.current?.click()}><Upload className="w-3.5 h-3.5" />Add</button>
          </div>
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={i} className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] text-[11px]">
                  {f.name} <span className="text-[var(--text-muted)]">{fmtBytes(f.size)}</span>
                  <button onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} aria-label="Remove"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} className="accent-[var(--accent)]" disabled={!brief.trim()} />
          Have Daedalus start designing from the brief right away
        </label>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
      <footer className="shrink-0 px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2 bg-[var(--bg-secondary)]">
        <button className={btn.subtle} onClick={onClose}>Cancel</button>
        <button className={btn.primary} onClick={create} disabled={busy}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Create project</button>
      </footer>
    </Modal>
  );
}
