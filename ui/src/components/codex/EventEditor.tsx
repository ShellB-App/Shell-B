import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Calendar, Check, Clock, ExternalLink, Globe, Loader2,
  MapPin, Pin, Trash2, Users, X
} from 'lucide-react';
import { api } from '../../api';
import type { CodexEntry, CodexIndex, EventMeta } from '../../types';
import { Markdown } from '../Markdown';
import { btn, relTime } from '../common';
import { Draft, busyIndex, who } from './types';
import { IndexState, TagInput } from './Inputs';
import { ContactAvatar } from './ContactAvatar';
import { t as tx } from '../../i18n';

/** Opens, edits and creates an Event entry. */
export function EventEditor({ start, index, agentNames, allContacts, contacts = [], onClose, onSaved, onDeleted }: {
  start: Draft; index: CodexIndex | null; agentNames: Record<string, string>; allContacts: string[]; contacts?: CodexEntry[];
  onClose: () => void; onSaved: (e: CodexEntry) => void; onDeleted: (id: string) => void;
}) {
  const [e, setE] = useState<Draft>(start);
  const [full, setFull] = useState<CodexEntry | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'notes' | 'preview'>('notes');
  const [confirmDel, setConfirmDel] = useState(false);
  const [attendeeText, setAttendeeText] = useState('');

  const load = useCallback(async (id: string) => {
    const f = await api.codexEntry(id);
    setFull(f);
    setE(prev => (dirty ? prev : { ...f }));
    return f;
  }, [dirty]);

  useEffect(() => { if (start.id) load(start.id).catch(err => setError(String(err))); }, [start.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!full || !busyIndex(full)) return;
    const t = setTimeout(() => { api.codexEntry(full.id).then(f => { setFull(f); if (!dirty) setE(p => ({ ...p, title: f.title, meta: f.meta })); onSaved(f); }).catch(() => {}); }, 2000);
    return () => clearTimeout(t);
  }, [full, dirty, onSaved]);

  const setMeta = (patch: Partial<EventMeta>) => {
    setE(p => ({ ...p, meta: { ...(p.meta || {}), ...patch } }));
    setDirty(true);
  };
  const set = (patch: Partial<Draft>) => { setE(p => ({ ...p, ...patch })); setDirty(true); };

  const addAttendee = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const cur = e.meta?.attendees || [];
    if (!cur.includes(trimmed)) {
      setMeta({ attendees: [...cur, trimmed] });
    }
    setAttendeeText('');
  };
  const removeAttendee = (name: string) => {
    const cur = e.meta?.attendees || [];
    setMeta({ attendees: cur.filter(a => a !== name) });
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const payload = {
        title: e.title?.trim() || 'Untitled Event',
        body: e.body ?? '',
        tags: e.tags ?? [],
        url: e.url ?? '',
        collectionId: e.collectionId ?? '',
        pinned: e.pinned,
        meta: e.meta || {},
      };
      const saved = e.id ? await api.patchCodexEntry(e.id, payload) : await api.createCodexEntry({ ...payload, kind: 'event' });
      setDirty(false);
      onSaved(saved);
      await load(saved.id).catch(() => {});
      setE(saved.id === e.id ? (p => ({ ...p, ...saved })) : { ...saved, body: payload.body });
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    }
    setBusy(false);
  };

  const accept = async () => { if (!e.id) return; const s = await api.patchCodexEntry(e.id, { draft: false }); setE(p => ({ ...p, draft: false })); onSaved(s); };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (dirty && !busy) save(); }
      else if (ev.key === 'Escape' && !dirty) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const allTags = (index?.tags ?? []).map(([t]) => t);
  const m = e.meta || {};
  const area = 'w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--accent)]/70 resize-y';

  return (
    <div className="fixed inset-0 z-40 md:static md:z-auto md:w-[min(46vw,640px)] md:shrink-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)] shrink-0">
        <Calendar className="w-4 h-4 text-orange-400" />
        <span className="text-xs text-[var(--text-secondary)] flex-1">{e.id ? tx('Event') : tx('New Event')}{dirty && tx(' · unsaved')}</span>
        {e.id && <button className={btn.icon} title={e.pinned ? tx('Unpin') : 'Pin'} onClick={() => set({ pinned: !e.pinned })}>
          <Pin className={clsx('w-4 h-4', e.pinned && 'fill-current text-[var(--accent)]')} /></button>}
        <button className={btn.icon} onClick={() => { if (!dirty || confirm(tx('Discard your changes?'))) onClose(); }} aria-label={tx('Close')}><X className="w-4 h-4" /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {e.draft && (
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-amber-500/35 bg-amber-500/5 text-xs">
            <span className="flex-1 min-w-[180px]">{tx('Draft added by {v0}. Agents can see it, but it stays a draft until you accept it.', { v0: who(e as CodexEntry, agentNames) })}</span>
            <button className={btn.primary} onClick={accept}><Check className="w-3.5 h-3.5" />{tx('Accept')}</button>
          </div>
        )}

        <input className="w-full bg-transparent text-xl font-semibold focus:outline-none placeholder-[var(--text-muted)]"
          value={e.title ?? ''} placeholder={tx('Event Title')} onChange={ev => set({ title: ev.target.value })} autoFocus={!e.id} />

        <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-orange-400" />{tx('Date & Time')}
            </span>
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input type="checkbox" checked={!!m.allDay} onChange={ev => setMeta({ allDay: ev.target.checked })} className="rounded accent-[var(--accent)]" />
              <span>{tx('All day')}</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">{tx('Start Date')}</span>
              <input className={btn.input} type="date" value={m.date ?? ''} onChange={ev => setMeta({ date: ev.target.value })} />
            </label>
            {!m.allDay && (
              <label className="block space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">{tx('Start Time')}</span>
                <input className={btn.input} type="time" value={m.time ?? ''} onChange={ev => setMeta({ time: ev.target.value })} />
              </label>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">{tx('End Date (optional)')}</span>
              <input className={btn.input} type="date" value={m.endDate ?? ''} onChange={ev => setMeta({ endDate: ev.target.value })} />
            </label>
            {!m.allDay && (
              <label className="block space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">{tx('End Time')}</span>
                <input className={btn.input} type="time" value={m.endTime ?? ''} onChange={ev => setMeta({ endTime: ev.target.value })} />
              </label>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-[var(--border-subtle)]">
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">{tx('Recurrence')}</span>
              <select className={btn.input} value={m.recurrence ?? 'none'} onChange={ev => setMeta({ recurrence: ev.target.value as any })}>
                <option value="none">{tx('Does not repeat')}</option>
                <option value="daily">{tx('Daily')}</option>
                <option value="weekly">{tx('Weekly')}</option>
                <option value="monthly">{tx('Monthly')}</option>
                <option value="yearly">{tx('Yearly')}</option>
                <option value="custom">{tx('Custom rule (RRULE)')}</option>
              </select>
              {m.recurrence === 'custom' && (
                <input className={clsx(btn.input, 'font-mono text-xs')} placeholder="FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2" value={m.rrule ?? ''}
                  onChange={ev => setMeta({ rrule: ev.target.value })} aria-label={tx('Recurrence rule')} />
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">{tx('Remind me')}</span>
              <select className={btn.input} value={m.reminderMinutes ?? ''} onChange={ev => setMeta({ reminderMinutes: ev.target.value === '' ? undefined : Number(ev.target.value) })}>
                <option value="">{tx('No reminder')}</option>
                <option value="0">{tx('When it starts')}</option>
                <option value="5">{tx('5 minutes before')}</option>
                <option value="15">{tx('15 minutes before')}</option>
                <option value="30">{tx('30 minutes before')}</option>
                <option value="60">{tx('1 hour before')}</option>
                <option value="1440">{tx('1 day before')}</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">{tx('Status')}</span>
              <select className={btn.input} value={m.status ?? 'confirmed'} onChange={ev => setMeta({ status: ev.target.value as any })}>
                <option value="confirmed">{tx('Confirmed')}</option>
                <option value="tentative">{tx('Tentative')}</option>
                <option value="cancelled">{tx('Cancelled')}</option>
              </select>
            </label>
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-orange-400" />{tx('Location / Room')}</span>
          <input className={btn.input} value={m.location ?? ''} placeholder={tx('Conference Room 2B, or physical address')} onChange={ev => setMeta({ location: ev.target.value })} />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Globe className="w-3.5 h-3.5 text-orange-400" />{tx('Meeting Link / Video URL')}</span>
          <div className="flex gap-2">
            <input className={btn.input} value={e.url ?? ''} placeholder="https://meet.google.com/... or Zoom link" onChange={ev => set({ url: ev.target.value })} />
            {e.url && <a className={btn.subtle} href={e.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="w-3.5 h-3.5" />{tx('Open')}</a>}
          </div>
        </label>

        <div className="space-y-1">
          <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-orange-400" />{tx('Attendees / People')}</span>
          <div className="flex flex-wrap items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus-within:border-[var(--accent)]/70 min-h-[34px]">
            {(m.attendees || []).map(a => {
              const mc = contacts.find(c => c.title.toLowerCase() === a.toLowerCase());
              return (
                <span key={a} className="flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--text-primary)] border border-[var(--border-subtle)]">
                  {mc && <ContactAvatar name={mc.title} avatar={mc.meta?.avatar} size="xs" shape="circle" />}
                  <span>{a}</span>
                  <button type="button" className="p-0.5 hover:text-red-400" onClick={() => removeAttendee(a)} aria-label={tx('Remove {a}', { a: a })}><X className="w-3 h-3" /></button>
                </span>
              );
            })}
            <input className="flex-1 min-w-[120px] bg-transparent text-sm focus:outline-none" value={attendeeText} list="codex-contacts-list"
              placeholder={(m.attendees || []).length ? '' : tx('Add person (Jane Doe, Bob...)')}
              onChange={ev => {
                if (ev.target.value.endsWith(',')) addAttendee(ev.target.value.slice(0, -1));
                else setAttendeeText(ev.target.value);
              }}
              onKeyDown={ev => {
                if (ev.key === 'Enter' && attendeeText) { ev.preventDefault(); addAttendee(attendeeText); }
                else if (ev.key === 'Backspace' && !attendeeText && (m.attendees || []).length) {
                  removeAttendee((m.attendees || [])[(m.attendees || []).length - 1]);
                }
              }}
              onBlur={() => attendeeText && addAttendee(attendeeText)} />
            <datalist id="codex-contacts-list">
              {allContacts.filter(c => !(m.attendees || []).includes(c)).map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_1fr] gap-2">
          <select className={btn.input} value={e.collectionId ?? ''} onChange={ev => set({ collectionId: ev.target.value || null })} aria-label={tx('Collection')}>
            <option value="">{tx('Unfiled')}</option>
            {index?.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <TagInput value={e.tags ?? []} onChange={tags => set({ tags })} all={allTags} />
        </div>

        <div className="space-y-1.5 pt-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--text-secondary)] flex-1">{tx('Agenda & Prep Notes')}</span>
            {(['notes', 'preview'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={clsx('px-2 py-0.5 rounded text-[11px]', tab === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                {t === 'notes' ? tx('Edit') : tx('Preview')}
              </button>
            ))}
          </div>
          {tab === 'notes' ? (
            <textarea className={clsx(area, 'min-h-[140px]')} value={e.body ?? ''}
              placeholder={tx('Agenda items, preparation checklist, discussion topics, links to [[Notes]] or documents...')}
              onChange={ev => set({ body: ev.target.value })} />
          ) : (
            <div className="min-h-[80px] px-3 py-2 rounded-lg border border-[var(--border-subtle)] cursor-text" onDoubleClick={() => setTab('notes')} title={tx('Double-click to edit')}>
              {e.body ? <Markdown text={e.body} /> : <span className="text-sm text-[var(--text-muted)]">{tx('No agenda written yet. Double-click to edit.')}</span>}
            </div>
          )}
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-4 pr-4 md:pr-16 py-2.5 border-t border-[var(--border-subtle)] shrink-0 text-[11px] text-[var(--text-muted)]">
        <span className="flex-1 min-w-[160px]">
          {e.id && full ? <><IndexState e={full} /><span className="block">{tx('Added by {v0} {v1} · edited {v2}', { v0: who(full, agentNames), v1: relTime(full.createdAt), v2: relTime(full.updatedAt) })}</span></> : tx('Ctrl+S saves')}
        </span>
        {e.id && (confirmDel ? (<>
          <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={async () => { await api.deleteCodexEntry(e.id!); onDeleted(e.id!); }}>{tx('Delete')}</button>
          <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(false)}>{tx('Keep')}</button>
        </>) : <button className={clsx(btn.icon, 'hover:text-red-400')} title={tx('Delete')} onClick={() => setConfirmDel(true)}><Trash2 className="w-4 h-4" /></button>)}
        <button className={btn.primary} disabled={busy || !dirty || !e.title?.trim()} onClick={save}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}{e.id ? tx('Save') : tx('Add Event')}
        </button>
      </div>
    </div>
  );
}
