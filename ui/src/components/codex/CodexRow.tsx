import clsx from 'clsx';
import {
  AlertTriangle, Cake, Clock, FolderClosed, Globe, KeyRound, Loader2, Mail, MapPin,
  Phone, Pin, Users
} from 'lucide-react';
import type { CodexEntry } from '../../types';
import { btn, relTime } from '../common';
import { KIND, busyIndex, who } from './types';
import { ContactAvatar } from './ContactAvatar';
import { t as tx } from '../../i18n';

export function CodexRow({ e, collection, agentNames, active, onOpen, onAccept, onDiscard, onPin }: {
  e: CodexEntry; collection?: string; agentNames: Record<string, string>; active: boolean;
  onOpen: () => void; onAccept: () => void; onDiscard: () => void; onPin: () => void;
}) {
  const K = KIND[e.kind];

  if (e.kind === 'contact') {
    const roleComp = [e.meta?.role, e.meta?.company].filter(Boolean).join(' · ');
    return (
      <div onClick={onOpen} role="link" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onOpen(); }}
        className={clsx('group flex items-start gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition',
          active ? 'border-[var(--accent)]/50 bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]')}>
        <ContactAvatar name={e.title} avatar={e.meta?.avatar} size="sm" shape="circle" className="mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">{tx(e.title)}</span>
            {e.pinned && <Pin className="w-3 h-3 shrink-0 fill-current text-[var(--accent)]" />}
            {e.draft && <span className="px-1.5 py-px rounded-md border text-[10px] font-medium shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25">{tx('Draft by {v0}', { v0: who(e, agentNames) })}</span>}
            {busyIndex(e) && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)] shrink-0" />}
            {e.meta.index === 'error' && <span title={e.meta.indexError}><AlertTriangle className="w-3 h-3 text-red-400 shrink-0" /></span>}
          </div>
          {roleComp && <p className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{roleComp}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-[var(--text-muted)]">
            {e.meta?.email && (
              <a href={`mailto:${e.meta.email}`} onClick={ev => ev.stopPropagation()} className="flex items-center gap-1 hover:text-[var(--text-primary)]">
                <Mail className="w-3 h-3 text-teal-400" />{e.meta.email}
              </a>
            )}
            {e.meta?.phone && (
              <a href={`tel:${e.meta.phone}`} onClick={ev => ev.stopPropagation()} className="flex items-center gap-1 hover:text-[var(--text-primary)]">
                <Phone className="w-3 h-3 text-teal-400" />{e.meta.phone}
              </a>
            )}
            {e.meta?.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3 text-[var(--text-muted)]" />{e.meta.location}
              </span>
            )}
            {e.meta?.birthday && (
              <span className="flex items-center gap-1">
                <Cake className="w-3 h-3 text-teal-400" />{e.meta.birthday}
              </span>
            )}
            {collection && <span className="flex items-center gap-1"><FolderClosed className="w-3 h-3" />{collection}</span>}
            {e.tags.slice(0, 5).map(t => <span key={t}>#{t}</span>)}
            <span>{relTime(e.updatedAt)}</span>
          </div>
          {e.body && <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-1 break-words">{e.body}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-0.5" onClick={ev => ev.stopPropagation()}>
          {e.draft ? (<>
            <button className="px-2 py-1 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500" onClick={onAccept}>{tx('Accept')}</button>
            <button className="px-2 py-1 rounded-lg text-[11px] text-red-400 hover:bg-red-500/10" onClick={onDiscard}>{tx('Discard')}</button>
          </>) : (
            <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus:opacity-100', e.pinned && 'opacity-100')} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={onPin}>
              <Pin className={clsx('w-3.5 h-3.5', e.pinned && 'fill-current text-[var(--accent)]')} /></button>
          )}
        </div>
      </div>
    );
  }

  if (e.kind === 'event') {
    const d = e.meta?.date;
    const [yr, mo, dy] = d ? d.split('-') : ['', '', ''];
    const monthName = mo ? ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][parseInt(mo, 10) - 1] : 'DATE';
    const timeStr = e.meta?.allDay ? tx('All day') : e.meta?.time ? `${e.meta.time}${e.meta.endTime ? ` – ${e.meta.endTime}` : ''}` : '';
    return (
      <div onClick={onOpen} role="link" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onOpen(); }}
        className={clsx('group flex items-start gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition',
          active ? 'border-[var(--accent)]/50 bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]')}>
        <div className="mt-0.5 w-10 h-10 rounded-xl flex flex-col items-center justify-center shrink-0 bg-orange-500/10 border border-orange-500/30 text-orange-400 font-mono leading-none select-none">
          <span className="text-[9px] font-bold uppercase tracking-wider">{monthName}</span>
          <span className="text-sm font-semibold mt-0.5 text-[var(--text-primary)]">{dy || '--'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">{tx(e.title)}</span>
            {e.pinned && <Pin className="w-3 h-3 shrink-0 fill-current text-[var(--accent)]" />}
            {e.draft && <span className="px-1.5 py-px rounded-md border text-[10px] font-medium shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25">{tx('Draft by {v0}', { v0: who(e, agentNames) })}</span>}
            {e.meta?.status && e.meta.status !== 'confirmed' && (
              <span className="px-1.5 py-px rounded text-[10px] uppercase font-mono bg-zinc-500/15 text-zinc-400 border border-zinc-500/30">{e.meta.status}</span>
            )}
            {busyIndex(e) && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)] shrink-0" />}
            {e.meta.index === 'error' && <span title={e.meta.indexError}><AlertTriangle className="w-3 h-3 text-red-400 shrink-0" /></span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-[11px] text-[var(--text-muted)]">
            {timeStr && <span className="flex items-center gap-1 font-mono text-[var(--text-secondary)]"><Clock className="w-3 h-3 text-orange-400" />{timeStr}</span>}
            {e.meta?.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-orange-400" />{e.meta.location}</span>}
            {e.meta?.attendees && e.meta.attendees.length > 0 && <span className="flex items-center gap-1"><Users className="w-3 h-3 text-[var(--text-muted)]" />{e.meta.attendees.join(', ')}</span>}
            {collection && <span className="flex items-center gap-1"><FolderClosed className="w-3 h-3" />{collection}</span>}
            {e.tags.slice(0, 5).map(t => <span key={t}>#{t}</span>)}
            <span>{relTime(e.updatedAt)}</span>
          </div>
          {e.body && <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-1 break-words">{e.body}</p>}
        </div>
        <div className="shrink-0 flex items-center gap-0.5" onClick={ev => ev.stopPropagation()}>
          {e.draft ? (<>
            <button className="px-2 py-1 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500" onClick={onAccept}>{tx('Accept')}</button>
            <button className="px-2 py-1 rounded-lg text-[11px] text-red-400 hover:bg-red-500/10" onClick={onDiscard}>{tx('Discard')}</button>
          </>) : (
            <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus:opacity-100', e.pinned && 'opacity-100')} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={onPin}>
              <Pin className={clsx('w-3.5 h-3.5', e.pinned && 'fill-current text-[var(--accent)]')} /></button>
          )}
        </div>
      </div>
    );
  }

  if (e.kind === 'secret') {
    const hosts = e.secret?.hosts ?? (e.meta?.hosts as string[] | undefined) ?? [];
    const approval = e.secret?.approval ?? e.meta?.approval ?? 'ask';
    const uses = e.secret?.uses ?? (e.meta?.uses as number | undefined) ?? 0;
    return (
      <div onClick={onOpen} role="link" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onOpen(); }}
        className={clsx('group flex items-start gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition',
          active ? 'border-[var(--accent)]/50 bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]')}>
        <span className="mt-0.5 w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-rose-500/10 text-rose-400 border border-rose-500/30" title={tx('API Key / Secret')}>
          <KeyRound className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold font-mono tracking-tight text-[var(--text-primary)] truncate">{tx(e.title)}</span>
            <span className="px-1.5 py-px rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20">{tx('Secret')}</span>
            <span className={clsx('px-1.5 py-px rounded text-[10px] font-medium border',
              approval === 'auto' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30')}>
              {approval === 'auto' ? tx('Auto-approved') : tx('Approval required')}
            </span>
            {e.pinned && <Pin className="w-3 h-3 shrink-0 fill-current text-[var(--accent)]" />}
            {e.draft && <span className="px-1.5 py-px rounded-md border text-[10px] font-medium shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25">{tx('Draft by {v0}', { v0: who(e, agentNames) })}</span>}
            {busyIndex(e) && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)] shrink-0" />}
            {e.meta.index === 'error' && <span title={e.meta.indexError}><AlertTriangle className="w-3 h-3 text-red-400 shrink-0" /></span>}
          </div>
          {e.body && <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-1 break-words">{e.body}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-[var(--text-muted)]">
            {hosts.length > 0 ? (
              <span className="flex items-center gap-1 font-mono text-[var(--text-secondary)]">
                <Globe className="w-3 h-3 text-rose-400" />
                {hosts.slice(0, 2).join(', ')}{hosts.length > 2 ? ` +${hosts.length - 2}` : ''}
              </span>
            ) : (
              <span className="text-amber-400 text-[11px]">{tx('no hosts configured (cannot be sent)')}</span>
            )}
            <span>{uses > 0 ? tx('{uses} use{v0}', { uses: uses, v0: uses === 1 ? '' : 's' }) : 'unused'}</span>
            {collection && <span className="flex items-center gap-1"><FolderClosed className="w-3 h-3" />{collection}</span>}
            {e.tags.slice(0, 5).map(t => <span key={t}>#{t}</span>)}
            <span>{relTime(e.updatedAt)}</span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-0.5" onClick={ev => ev.stopPropagation()}>
          {e.draft ? (<>
            <button className="px-2 py-1 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500" onClick={onAccept}>{tx('Accept')}</button>
            <button className="px-2 py-1 rounded-lg text-[11px] text-red-400 hover:bg-red-500/10" onClick={onDiscard}>{tx('Discard')}</button>
          </>) : (
            <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus:opacity-100', e.pinned && 'opacity-100')} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={onPin}>
              <Pin className={clsx('w-3.5 h-3.5', e.pinned && 'fill-current text-[var(--accent)]')} /></button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div onClick={onOpen} role="link" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onOpen(); }}
      className={clsx('group flex items-start gap-3 px-3.5 py-3 rounded-xl border cursor-pointer transition',
        active ? 'border-[var(--accent)]/50 bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]')}>
      <span className="mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]" title={tx(K.label)}>
        <K.icon className={clsx('w-4 h-4', K.color)} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{tx(e.title)}</span>
          {e.pinned && <Pin className="w-3 h-3 shrink-0 fill-current text-[var(--accent)]" />}
          {e.draft && <span className="px-1.5 py-px rounded-md border text-[10px] font-medium shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25">{tx('Draft by {v0}', { v0: who(e, agentNames) })}</span>}
          {busyIndex(e) && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)] shrink-0" />}
          {e.meta.index === 'error' && <span title={e.meta.indexError}><AlertTriangle className="w-3 h-3 text-red-400 shrink-0" /></span>}
        </div>
        {(e.passage || e.preview || e.url) && (
          <p className={clsx('text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2 break-words', e.kind === 'snippet' && !e.passage && 'font-mono')}>
            {e.passage ? e.passage.replace(/\s+/g, ' ') : e.preview || e.url}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[11px] text-[var(--text-muted)]">
          {collection && <span className="flex items-center gap-1"><FolderClosed className="w-3 h-3" />{collection}</span>}
          {e.tags.slice(0, 5).map(t => <span key={t}>#{t}</span>)}
          <span>{relTime(e.updatedAt)}</span>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-0.5" onClick={ev => ev.stopPropagation()}>
        {e.draft ? (<>
          <button className="px-2 py-1 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500" onClick={onAccept}>{tx('Accept')}</button>
          <button className="px-2 py-1 rounded-lg text-[11px] text-red-400 hover:bg-red-500/10" onClick={onDiscard}>{tx('Discard')}</button>
        </>) : (
          <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100 focus:opacity-100', e.pinned && 'opacity-100')} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={onPin}>
            <Pin className={clsx('w-3.5 h-3.5', e.pinned && 'fill-current text-[var(--accent)]')} /></button>
        )}
      </div>
    </div>
  );
}
