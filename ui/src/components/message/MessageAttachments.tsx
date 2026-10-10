import { FileSpreadsheet, FileText } from 'lucide-react';
import { chipClick, docTarget, isSheet } from '../../docView';
import { t } from '../../i18n';
import type { Attachment } from '../../types';
import { fmtBytes } from '../../api';
import { refIcon } from '../ComposerShortcuts';

export function MessageAttachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 justify-end mb-1.5">
      {items.map(a =>
        a.kind === 'ref' ? (
          <span
            key={a.id}
            title={a.refKind === 'url' ? a.ref : `${a.refKind} · ${a.ref}`}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[11px]"
          >
            <span className="text-[var(--accent)]">{refIcon(a.refKind)}</span>
            {a.refKind === 'url' && a.ref ? (
              <a
                href={a.ref}
                target="_blank"
                rel="noreferrer"
                className="font-medium max-w-[200px] truncate hover:underline"
              >
                {a.name}
              </a>
            ) : (
              <span className="font-medium max-w-[200px] truncate">{a.name}</span>
            )}
          </span>
        ) : a.kind === 'image' ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="block w-28 h-28 rounded-xl overflow-hidden border border-[var(--border-subtle)]"
          >
            <img src={a.url} alt={a.name} className="w-full h-full object-cover" />
          </a>
        ) : a.url && docTarget(a.url) ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            title={t('Open {path} beside the chat', { path: a.name })}
            onClick={e => chipClick(e, a.url)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] text-[11px]"
          >
            {isSheet(a.name) ? <FileSpreadsheet className="w-3.5 h-3.5 text-[var(--accent)]" /> : <FileText className="w-3.5 h-3.5 text-[var(--accent)]" />}
            <span className="font-medium max-w-[160px] truncate">{a.name}</span>
            <span className="text-[var(--text-muted)]">{fmtBytes(a.size)}</span>
          </a>
        ) : (
          <span
            key={a.id}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[11px]"
          >
            <FileText className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span className="font-medium max-w-[160px] truncate">{a.name}</span>
            <span className="text-[var(--text-muted)]">{fmtBytes(a.size)}</span>
          </span>
        )
      )}
    </div>
  );
}
