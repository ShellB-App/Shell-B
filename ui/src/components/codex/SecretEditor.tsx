import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Check, Copy, Eye, EyeOff, KeyRound, Loader2,
  ShieldCheck, Trash2, X
} from 'lucide-react';
import { api } from '../../api';
import type { CodexEntry, CodexIndex } from '../../types';
import { Toggle, btn, relTime } from '../common';
import { Draft, ownerOnly } from './types';
import { HostInput, TagInput } from './Inputs';
import { t as tx } from '../../i18n';

/** A secret: agents see its name and use it through codex action=request; the value only comes back to the owner. */
export function SecretEditor({ start, index, agentNames, onClose, onSaved, onDeleted }: {
  start: Draft; index: CodexIndex | null; agentNames: Record<string, string>;
  onClose: () => void; onSaved: (e: CodexEntry) => void; onDeleted: (id: string) => void;
}) {
  const isNew = !start.id;
  const [full, setFull] = useState<CodexEntry | null>(null);
  const [name, setName] = useState(start.title ?? '');
  const [desc, setDesc] = useState(start.body ?? '');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [hosts, setHosts] = useState<string[]>([]);
  const [ask, setAsk] = useState(true);
  const [collectionId, setCollectionId] = useState<string | null>(start.collectionId ?? null);
  const [tags, setTags] = useState<string[]>(start.tags ?? []);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [copied, setCopied] = useState(false);

  const fill = (f: CodexEntry) => {
    setFull(f); setName(f.title); setDesc(f.body ?? ''); setHosts(f.secret?.hosts ?? []); setAsk((f.secret?.approval ?? 'ask') === 'ask');
    setCollectionId(f.collectionId); setTags(f.tags);
  };
  useEffect(() => { if (start.id) api.codexSecret(start.id).then(fill).catch(err => setError(String(err))); }, [start.id]);
  useEffect(() => { if (!revealed) return; const t = setTimeout(() => setRevealed(null), 30000); return () => clearTimeout(t); }, [revealed]);
  const touch = <T,>(f: (v: T) => void) => (v: T) => { f(v); setDirty(true); };

  const save = async () => {
    setBusy(true); setError('');
    try {
      let saved: CodexEntry;
      if (isNew) {
        saved = await api.createCodexSecret({ name, value, description: desc, hosts, approval: ask ? 'ask' : 'auto', tags, collectionId });
      } else {
        const s: { name?: string; value?: string; hosts?: string[]; approval?: 'ask' | 'auto' } = { hosts, approval: ask ? 'ask' : 'auto' };
        if (name !== full?.title) s.name = name;
        if (value) s.value = value;
        await api.patchCodexSecret(start.id!, s);
        await api.patchCodexEntry(start.id!, { body: desc, tags, collectionId: collectionId ?? '' } as Partial<CodexEntry>);
        saved = await api.codexSecret(start.id!);
      }
      fill(saved); setValue(''); setShow(false); setDirty(false); onSaved(saved);
    } catch (err) { setError(ownerOnly(err)); }
    setBusy(false);
  };
  const reveal = async () => {
    setError('');
    try { setRevealed((await api.revealCodexSecret(start.id!)).value); } catch (err) { setError(ownerOnly(err)); }
  };
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => setError('Copying needs https or localhost; select the value instead.'));
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (dirty && !busy) save(); }
      else if (ev.key === 'Escape' && !dirty) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const placeholder = `{{secret:${name || 'NAME'}}}`;
  const sec = full?.secret;

  return (
    <div className="fixed inset-0 z-40 md:static md:z-auto md:w-[min(46vw,640px)] md:shrink-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)] shrink-0">
        <KeyRound className="w-4 h-4 text-rose-400" />
        <span className="text-xs text-[var(--text-secondary)] flex-1">{isNew ? tx('New secret') : tx('Secret')}{dirty && tx(' · unsaved')}</span>
        <button className={btn.icon} onClick={() => { if (!dirty || confirm(tx('Discard your changes?'))) onClose(); }} aria-label={tx('Close')}><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)]">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{tx('Agents see only the name. They use it by writing')} <code className="font-mono text-[var(--text-primary)]">{placeholder}</code> {tx('in an API request, and Shell:B fills in the value only for the hosts below, blanks it out of the response, and logs every use. The value is encrypted on disk.')}</span>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">{tx('Name')}</span>
          <input className={clsx(btn.input, 'font-mono uppercase')} value={name} placeholder="GITHUB_TOKEN" autoFocus={isNew}
            onChange={e => touch(setName)(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">{tx('What it is and what it\'s for (agents read this)')}</span>
          <textarea className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--accent)]/70 min-h-[70px] resize-y"
            value={desc} placeholder={tx('Fine-grained GitHub token for the shellb repos: read issues, open pull requests')} onChange={e => touch(setDesc)(e.target.value)} />
        </label>
        <div className="space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">{tx('Value')}</span>
          {!isNew && sec?.set && !value && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] text-sm font-mono break-all select-all">
                {revealed ?? '••••••••••••••••'}</code>
              {revealed ? (<>
                <button className={btn.ghost} onClick={() => copy(revealed)}>{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? tx('Copied') : tx('Copy')}</button>
                <button className={btn.ghost} onClick={() => setRevealed(null)}><EyeOff className="w-3.5 h-3.5" />{tx('Hide')}</button>
              </>) : <button className={btn.ghost} onClick={reveal}><Eye className="w-3.5 h-3.5" />{tx('Reveal')}</button>}
            </div>
          )}
          <div className="relative">
            <input className={clsx(btn.input, 'font-mono pr-9')} type={show ? 'text' : 'password'} autoComplete="new-password" value={value}
              placeholder={isNew ? tx('Paste the key, token or password') : tx('Paste a new value to replace it')} onChange={e => touch(setValue)(e.target.value)} />
            <button className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setShow(!show)}
              aria-label={show ? tx('Hide value') : tx('Show value')}>{show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}</button>
          </div>
          {revealed && <p className="text-[11px] text-[var(--text-muted)]">{tx('Hides itself after 30 seconds. Revealing is logged.')}</p>}
        </div>
        <div className="space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">{tx('May be sent to (https only; *.example.com covers subdomains)')}</span>
          <HostInput value={hosts} onChange={touch(setHosts)} />
          {!hosts.length && <p className="text-[11px] text-amber-500">{tx('With no hosts, agents can see this secret exists but can\'t use it.')}</p>}
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">{tx('Ask me before each use')}
            <span className="block text-[11px] text-[var(--text-muted)]">{tx('The request waits in the chat and the Activity inbox until you approve it. Turn off only for low-risk, read-only keys.')}</span>
          </span>
          <Toggle on={ask} onChange={touch(setAsk)} label={tx('Ask before each use')} />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_1fr] gap-2">
          <select className={btn.input} value={collectionId ?? ''} onChange={ev => touch(setCollectionId)(ev.target.value || null)} aria-label={tx('Collection')}>
            <option value="">{tx('Unfiled')}</option>
            {index?.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <TagInput value={tags} onChange={touch(setTags)} all={(index?.tags ?? []).map(([t]) => t)} />
        </div>
        {sec && (
          <div className="space-y-1.5">
            <span className="text-xs text-[var(--text-secondary)]">{tx('Used')} {sec.uses} time{sec.uses === 1 ? '' : 's'}{sec.lastUsed ? tx(', last {v0}', { v0: relTime(sec.lastUsed) }) : ''}</span>
            {sec.recent.length > 0 && (
              <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] text-[11px]">
                {sec.recent.map((u, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className={clsx('font-mono', /^2\d\d$/.test(u.outcome) ? 'text-emerald-500' : /^refused|^error|^[45]\d\d$/.test(u.outcome) ? 'text-red-400' : 'text-[var(--text-secondary)]')}>
                      {u.outcome.replace('refused-host', 'refused (host)').replace('changed:', 'changed ')}</span>
                    <span className="flex-1 truncate text-[var(--text-muted)]">{u.method ? `${u.method} ${u.host}` : ''}{u.agent ? ` · ${agentNames[u.agent] ?? u.agent}` : ''}</span>
                    {u.conv && <a className="text-[var(--text-secondary)] hover:text-[var(--accent)]" href={`#/c/${u.conv}`}>chat</a>}
                    <span className="text-[var(--text-muted)]">{relTime(u.t * 1000)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-4 pr-4 md:pr-16 py-2.5 border-t border-[var(--border-subtle)] shrink-0 text-[11px] text-[var(--text-muted)]">
        <span className="flex-1 min-w-[160px]">{full ? <>{tx('Added')} {relTime(full.createdAt)} {tx('· edited')} {relTime(full.updatedAt)}</> : tx('Only the signed-in owner can save, reveal or re-scope secrets.')}</span>
        {!isNew && (confirmDel ? (<>
          <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={async () => { await api.deleteCodexEntry(start.id!); onDeleted(start.id!); }}>{tx('Delete')}</button>
          <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(false)}>{tx('Keep')}</button>
        </>) : <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Delete')} onClick={() => setConfirmDel(true)}><Trash2 className="w-4 h-4" /></button>)}
        <button className={btn.primary} disabled={busy || !dirty || name.length < 2 || (isNew && !value)} onClick={save}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}{isNew ? tx('Add secret') : tx('Save')}
        </button>
      </div>
    </div>
  );
}
