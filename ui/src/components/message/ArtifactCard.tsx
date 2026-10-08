import clsx from 'clsx';
import {
  Boxes,
  Code,
  Download,
  ExternalLink,
  FileText,
  Palette,
  Workflow,
} from 'lucide-react';
import type { ToolDisplay, WorkspaceFile } from '../../types';
import { fmtBytes } from '../../api';
import { artifactMenu } from '../artifactMenu';
import { openContextMenu } from '../ContextMenu';

// the chat on screen (#/c/<id>): artifact cards only appear inside one
const currentConv = () => /^#\/c\/([\w-]+)/.exec(location.hash)?.[1];

export function ArtifactCard({
  art,
  active,
  onOpen,
}: {
  art: NonNullable<ToolDisplay['artifact']>;
  active: boolean;
  onOpen: () => void;
}) {
  const Icon =
    art.type === 'svg'
      ? Palette
      : art.type === 'markdown'
      ? FileText
      : art.type === 'mermaid'
      ? Workflow
      : art.type === 'code'
      ? Code
      : Boxes;
  const label =
    {
      html: 'Interactive page',
      svg: 'Vector graphic',
      markdown: 'Document',
      mermaid: 'Diagram',
      code: 'Code',
    }[art.type] ?? 'Artifact';

  return (
    <button
      onClick={onOpen}
      onContextMenu={e => {
        const convId = currentConv();
        if (convId) openContextMenu(e, artifactMenu({ convId, id: art.id, title: art.title, type: art.type, version: art.version, onOpen }));
      }}
      className={clsx(
        'w-full max-w-md my-2 p-3 rounded-xl border text-left flex items-center gap-3 transition group',
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/10'
          : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
      )}
    >
      <span className="w-9 h-9 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-[var(--accent)]" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold truncate">{art.title}</span>
          <span className="text-[10px] font-mono px-1.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
            v{art.version}
          </span>
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          {label} · {art.language}
        </span>
      </span>
      <ExternalLink className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] shrink-0" />
    </button>
  );
}

/** A file Shell:B wrote to /work: click the name to open it in a tab, the arrow to save it. */
export function DownloadChip({ file }: { file: WorkspaceFile }) {
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <span className="inline-flex items-stretch rounded-lg text-[11px] bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] overflow-hidden max-w-full">
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        title={`Open ${file.path}`}
        className="flex items-center gap-1.5 px-2 py-1 min-w-0 hover:bg-[var(--bg-hover)]"
      >
        <FileText className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
        <span className="font-mono truncate">{name}</span>
        <span className="text-[var(--text-muted)] shrink-0">{fmtBytes(file.size)}</span>
      </a>
      <a
        href={`${file.url}?download=1`}
        download={name}
        title={`Download ${name}`}
        className="flex items-center px-1.5 border-l border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      >
        <Download className="w-3.5 h-3.5" />
      </a>
    </span>
  );
}
