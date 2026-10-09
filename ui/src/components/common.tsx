import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  BookMarked, BookOpen,
  Boxes, Brain, BrainCircuit, CalendarClock, History, Camera, FileSearch, FolderSearch, GitCompare, TextSearch, ScanEye, ScanText, Sparkles, WandSparkles, Eye, FilePen, FilePlus, FileSymlink, FileText, FolderTree, GitFork, Globe, Image, Library, ListChecks, ListTodo, MessageCircleQuestion, Music,
  ScanFace, Search, Shapes, Download, Telescope, Terminal, Trash2, UsersRound, Workflow, Wrench, X, type LucideIcon,
} from 'lucide-react';
import type { Agent } from '../types';

export const TOOL_ICONS: Record<string, LucideIcon> = {
  web_search: Search, web_fetch: Globe, run_code: Terminal, create_artifact: Boxes, generate_image: Image, generate_adult_image: Image,
  generate_music: Music, memory_save: Brain, memory_search: BrainCircuit, memory_forget: Brain, recall_conversations: History, ask_agent: GitFork,
  list_files: FolderTree, read_file: FileText, write_file: FilePlus, edit_file: FilePen, delete_file: Trash2,
  rename_file: FileSymlink, view_image: Eye, screenshot: Camera,
  search_files: TextSearch, find_files: FolderSearch, project_diff: GitCompare,
  read_document: FileSearch, view_document: ScanEye, ocr: ScanText,
  use_skill: Sparkles, read_skill_file: FileText, save_skill: WandSparkles, schedule_task: CalendarClock, project_todos: ListChecks,
  research_board: Telescope, mega_plan: Workflow, library: Library, codex: BookMarked, circles: UsersRound, follow_ups: ListTodo, asset_library: Shapes, scrape: Download,
  shellb_self: ScanFace, ask_user: MessageCircleQuestion, wiki: BookOpen, look_at_screen: Camera, browser: Globe,
};
export const toolIcon = (name: string) => TOOL_ICONS[name] ?? Wrench;

export const TOOL_LABELS: Record<string, [string, string]> = {
  // [while running, when done]
  web_search: ['Searching the web', 'Searched the web'],
  web_fetch: ['Reading a page', 'Read a page'],
  run_code: ['Running code', 'Ran code'],
  create_artifact: ['Building artifact', 'Built artifact'],
  generate_image: ['Painting with NYX', 'Generated image'],
  generate_adult_image: ['Painting with Aphrodite', 'Generated image'],
  generate_music: ['Composing with ORPHEUS', 'Generated music'],
  memory_save: ['Remembering', 'Saved to memory'],
  memory_search: ['Recalling', 'Searched memory'],
  memory_forget: ['Forgetting', 'Forgot a memory'],
  recall_conversations: ['Looking back', 'Looked through past chats'],
  ask_agent: ['Delegating', 'Delegated'],
  ask_user: ['Asking you', 'Asked you'],
  look_at_screen: ['Looking at your screen', 'Looked at your screen'],
  browser: ['Using your browser', 'Used your browser'],
  schedule_task: ['Scheduling', 'Scheduled a task'],
  project_todos: ['Updating the to-do list', 'Updated the to-do list'],
  research_board: ['Updating the research board', 'Updated the research board'],
  mega_plan: ['Updating the mega plan', 'Updated the mega plan'],
  library: ['Checking the library', 'Checked the library'],
  codex: ['Checking the Codex', 'Checked the Codex'],
  follow_ups: ['Checking follow-ups', 'Checked follow-ups'],
  wiki: ['Looking it up in the wiki', 'Looked it up in the wiki'],
  asset_library: ['Working in the asset libraries', 'Used the asset libraries'],
  scrape: ['Scouting the web', 'Scouted the web'],
  shellb_self: ['Looking at myself', 'Looked at myself'],
  list_files: ['Looking through files', 'Listed files'],
  search_files: ['Searching the code', 'Searched the code'],
  find_files: ['Finding files', 'Found files'],
  project_diff: ['Reviewing the diff', 'Reviewed the diff'],
  read_file: ['Reading', 'Read a file'],
  write_file: ['Writing', 'Wrote a file'],
  edit_file: ['Editing', 'Edited a file'],
  delete_file: ['Deleting', 'Deleted a file'],
  rename_file: ['Renaming', 'Renamed a file'],
  view_image: ['Looking at an image', 'Looked at an image'],
  screenshot: ['Rendering the page', 'Rendered and reviewed'],
  read_document: ['Reading a document', 'Read a document'],
  view_document: ['Looking at the pages', 'Looked at the pages'],
  ocr: ['Identifying text', 'Identified text'],
  use_skill: ['Loading a skill', 'Used a skill'],
  read_skill_file: ['Reading skill files', 'Read a skill file'],
  save_skill: ['Writing a skill', 'Saved a skill'],
};

export function AgentAvatar({ agent, size = 20, className }: { agent?: Agent; size?: number; className?: string }) {
  const [a, b] = agent?.color ?? ['#7c3aed', '#a78bfa'];
  return (
    <span
      className={clsx('inline-flex items-center justify-center rounded-md text-white shrink-0 select-none', className)}
      style={{ width: size, height: size, fontSize: size * 0.55, background: `linear-gradient(135deg, ${a}, ${b})` }}
      aria-hidden
    >
      {agent?.avatar ?? '✦'}
    </span>
  );
}

export function Modal({ open, onClose, title, icon, children, wide }: {
  open: boolean; onClose: () => void; title: string; icon?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // keyboard users land inside the dialog, Tab stays in it, and focus goes back where it was on close
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(box.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
      .filter(el => el.offsetParent !== null);
    if (box.current && !box.current.contains(document.activeElement)) (focusables()[1] ?? focusables()[0] ?? box.current).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !box.current) return;
      const els = focusables();
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap);
    return () => { window.removeEventListener('keydown', trap); if (before?.isConnected) before.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 bg-black/55 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div ref={box} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={title}
        className={clsx('bg-[var(--bg-primary)] border border-[var(--border-subtle)] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-slide-up focus:outline-none',
          'w-full h-full sm:h-auto sm:max-h-[86vh]', wide ? 'sm:max-w-5xl' : 'sm:max-w-2xl')}
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="h-12 shrink-0 px-4 flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={clsx('relative w-9 h-5 rounded-full transition shrink-0 disabled:opacity-40', on ? 'bg-[var(--accent)]' : 'bg-[var(--bg-hover)]')}
    >
      <span className={clsx('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export const btn = {
  ghost: 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition',
  icon: 'p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition',
  primary: 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] hover:brightness-110 text-[var(--accent-fg)] transition disabled:opacity-40',
  subtle: 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] transition disabled:opacity-40',
  input: 'w-full px-2.5 py-1.5 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/70',
};

export function relTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Snippet({ text }: { text: string }) {
  return (
    <span>
      {text.split(/(\[\[.*?\]\])/g).map((part, i) =>
        part.startsWith('[[') && part.endsWith(']]')
          ? <mark key={i} className="sf-mark font-medium bg-[var(--accent)]/20 text-[var(--accent-soft)] px-0.5 rounded">{part.slice(2, -2)}</mark>
          : part
      )}
    </span>
  );
}
