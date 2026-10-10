import { useState } from 'react';
import { AlertTriangle, Globe, Loader2, Tag, X } from 'lucide-react';
import type { CodexEntry } from '../../types';
import { t as tx } from '../../i18n';

export function IndexState({ e }: { e: CodexEntry }) {
  const snap = e.meta.snapshot;
  if (snap?.status === 'pending') {
    return (
      <span className="flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        {tx('Saving a copy of the page…')}
      </span>
    );
  }
  if (e.meta.index === 'pending' || e.meta.index === 'indexing') {
    return (
      <span className="flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        {tx('Indexing…')}
      </span>
    );
  }
  if (e.meta.index === 'error') {
    return (
      <span className="flex items-center gap-1 text-red-400" title={e.meta.indexError}>
        <AlertTriangle className="w-3 h-3" />
        {tx('Not searchable:')} {e.meta.indexError}
      </span>
    );
  }
  return (
    <span>
      {tx('Searchable ·')} {e.meta.chunks ?? 0} passage{e.meta.chunks === 1 ? '' : 's'}
    </span>
  );
}

export function TagInput({ value, onChange, all }: { value: string[]; onChange: (t: string[]) => void; all: string[] }) {
  const [text, setText] = useState('');
  const add = (t: string) => {
    const v = t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (v && !value.includes(v)) onChange([...value, v]);
    setText('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus-within:border-[var(--accent)]/70 min-h-[34px]">
      <Tag className="w-3.5 h-3.5 text-[var(--text-muted)]" />
      {value.map(t => (
        <span key={t} className="flex items-center gap-0.5 pl-1.5 pr-0.5 rounded bg-[var(--bg-hover)] text-[11px]">
          #{t}
          <button
            className="p-0.5 hover:text-red-400"
            onClick={() => onChange(value.filter(x => x !== t))}
            aria-label={tx('Remove {t}', { t: t })}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[80px] bg-transparent text-sm focus:outline-none"
        value={text}
        list="codex-tags"
        placeholder={value.length ? '' : tx('Add tags')}
        onChange={e => {
          if (e.target.value.endsWith(',')) add(e.target.value.slice(0, -1));
          else setText(e.target.value);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && text) {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id="codex-tags">
        {all.filter(t => !value.includes(t)).map(t => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

export function HostInput({ value, onChange }: { value: string[]; onChange: (h: string[]) => void }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const hs = raw
      .split(/[\s,]+/)
      .map(h => {
        const v = h.trim().toLowerCase();
        try {
          return v.includes('://') ? new URL(v).hostname : v.split('/')[0];
        } catch {
          return '';
        }
      })
      .filter(h => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !value.includes(h));
    if (hs.length) onChange([...value, ...hs]);
    setText('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus-within:border-[var(--accent)]/70 min-h-[34px]">
      <Globe className="w-3.5 h-3.5 text-[var(--text-muted)]" />
      {value.map(h => (
        <span key={h} className="flex items-center gap-0.5 pl-1.5 pr-0.5 rounded bg-[var(--bg-hover)] text-[11px] font-mono">
          {h}
          <button
            className="p-0.5 hover:text-red-400"
            onClick={() => onChange(value.filter(x => x !== h))}
            aria-label={tx('Remove {h}', { h: h })}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[140px] bg-transparent text-sm focus:outline-none"
        value={text}
        placeholder={value.length ? '' : tx('api.github.com, *.example.com')}
        onChange={e => {
          if (/[\s,]$/.test(e.target.value)) add(e.target.value);
          else setText(e.target.value);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && text) {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
    </div>
  );
}
