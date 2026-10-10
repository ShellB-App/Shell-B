import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { WorkspaceFile } from '../types';
import { DownloadChip } from './MessageView';
import { docTarget } from '../docView';

/** Header button + dropdown listing every file in the chat's /work folder (uploads and everything the agents wrote). */
export function WorkspaceFiles({ convId, refreshKey }: { convId: string; refreshKey?: unknown }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoading(true);
    api.workspaceFiles(convId).then(setFiles).catch(() => setFiles([])).finally(() => setLoading(false));
  };
  useEffect(load, [convId, refreshKey]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!files?.length) return null;
  return (
    <div ref={box} className="relative">
      <button onClick={() => { setOpen(o => !o); if (!open) load(); }} title="Files in this chat"
        className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition',
          open ? 'bg-[var(--accent)]/15 text-[var(--accent-soft)] border-[var(--accent)]/40' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
        <FolderOpen className="w-3.5 h-3.5" /><span className="hidden sm:inline">Files</span>
        <span className="font-mono text-[10px]">{files.length}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-[min(22rem,calc(100vw-1.5rem))] max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-2">
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Files in this chat</span>
            <button onClick={load} title="Refresh" className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {files.map(f => (
              <div key={f.path} className="flex flex-col min-w-0" onClick={() => { if (docTarget(f.url)) setOpen(false); }}>
                <DownloadChip file={f} />
                {f.path.includes('/') && <span className="pl-2 pt-0.5 text-[10px] font-mono text-[var(--text-muted)] truncate">/work/{f.path}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
