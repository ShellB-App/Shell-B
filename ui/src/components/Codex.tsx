import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  BookMarked,
  Calendar,
  ChevronDown,
  FolderClosed,
  Inbox,
  KeyRound,
  Loader2,
  Pin,
  Plus,
  Search,
  Sparkles,
  Upload,
  User,
  X,
  UserRound,
} from 'lucide-react';
import { toast } from './toast';
import { api } from '../api';
import type { CodexEntry, CodexIndex, CodexKind } from '../types';
import { btn } from './common';

import { KIND, parseCodexRoute, type Draft, busyIndex } from './codex/types';
import { TagInput } from './codex/Inputs';
import { Editor } from './codex/Editor';
import { ContactEditor } from './codex/ContactEditor';
import { EventEditor } from './codex/EventEditor';
import { SecretEditor } from './codex/SecretEditor';
import { CodexRow as Row } from './codex/CodexRow';
import { CalendarView } from './codex/CalendarView';
import { ContactsView } from './codex/ContactsView';
import { SyncAccountsDialog } from './codex/SyncAccounts';

// Re-export helpers for external consumers (e.g. Notes.tsx, App.tsx)
export { parseCodexRoute, TagInput };

/** The Codex (#/codex): the owner's long-term reference shelf of notes, links, snippets, files, contacts and events. */
export function Codex({ sub, agentNames }: { sub: string; agentNames: Record<string, string> }) {
  const route = useMemo(() => parseCodexRoute(sub), [sub]);
  const [index, setIndex] = useState<CodexIndex | null>(null);
  const [items, setItems] = useState<CodexEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<CodexKind | ''>('');
  const [tag, setTag] = useState('');
  const [open, setOpen] = useState<Draft | null>(null);
  const [newCol, setNewCol] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [populating, setPopulating] = useState(false);
  const [popStatus, setPopStatus] = useState('');
  const [contactNames, setContactNames] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const autoPopulate = async () => {
    setPopulating(true);
    setPopStatus('Analyzing memories for people & events…');
    setError('');
    try {
      const res = await api.populateCodexFromMemories('auto');
      const c = (res.created?.contacts || 0) + (res.updated?.contacts || 0);
      const ev = (res.created?.events || 0) + (res.updated?.events || 0);
      setPopStatus(`Imported ${c} contact${c === 1 ? '' : 's'} and ${ev} event${ev === 1 ? '' : 's'} from memories!`);
      setTimeout(() => setPopStatus(''), 6000);
      loadIndex();
      loadItems();
    } catch (err) {
      setError(String(err));
      setPopStatus('');
    } finally {
      setPopulating(false);
    }
  };

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const [selectedDate, setSelectedDate] = useState(() => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const [syncKind, setSyncKind] = useState<'caldav' | 'carddav' | null>(null);  // Sync… dialog (codex/SyncAccounts.tsx)
  const loadIndex = useCallback(() => api.codex().then(setIndex).catch(e => setError(String(e))), []);
  const loadItems = useCallback(async () => {
    try {
      const view = route.view === 'drafts' || route.view === 'pinned' || route.view === 'contacts' || route.view === 'calendar' || route.view === 'events' || route.view === 'secrets' ? route.view : '';
      const collection = route.view === 'collection' ? route.collection : route.view === 'unfiled' ? 'unfiled' : '';
      const effectiveKind = route.view === 'contacts' ? 'contact' : (route.view === 'calendar' || route.view === 'events') ? 'event' : route.view === 'secrets' ? 'secret' : kind;
      setItems(await api.codexEntries({ collection, kind: effectiveKind, tag, q: query, view }));
      setError('');
    } catch (e) { setError(String(e)); }
    setLoaded(true);
  }, [route, kind, tag, query]);
  const [allContacts, setAllContacts] = useState<CodexEntry[]>([]);
  useEffect(() => { loadIndex(); }, [loadIndex]);
  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => {
    api.codexEntries({ kind: 'contact' }).then(cs => {
      setAllContacts(cs);
      setContactNames(cs.map(c => c.title).filter(Boolean));
    }).catch(() => {});
  }, [index?.counts.contacts]);
  useEffect(() => {  // keep rows fresh while pages are copied and entries indexed
    if (!items.some(busyIndex)) return;
    const t = setTimeout(loadItems, 2500);
    return () => clearTimeout(t);
  }, [items, loadItems]);
  useEffect(() => {
    if (route.entry) api.codexEntry(route.entry).then(e => setOpen({ ...e })).catch(() => setError('That entry no longer exists.'));
  }, [route.entry]);

  const colName = (id: string | null) => index?.collections.find(c => c.id === id)?.name;
  const current = route.view === 'collection' ? index?.collections.find(c => c.id === route.collection) : undefined;
  const defaultCollection = route.view === 'collection' ? route.collection ?? null : null;
  const refresh = () => { loadIndex(); loadItems(); };
  const onSaved = useCallback((e: CodexEntry) => {
    setItems(prev => (prev.some(i => i.id === e.id) ? prev.map(i => (i.id === e.id ? { ...i, ...e } : i)) : [e, ...prev]));
    if (e.kind === 'contact') {
      setAllContacts(prev => prev.some(c => c.id === e.id) ? prev.map(c => c.id === e.id ? { ...c, ...e } : c) : [e, ...prev]);
      setContactNames(prev => prev.includes(e.title) ? prev : [...prev, e.title]);
    }
    setOpen(o => (o && !o.id ? { ...e } : o));
    loadIndex();
  }, [loadIndex]);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true); setError('');
    try { const added = await api.uploadCodex(files, defaultCollection ?? ''); setItems(prev => [...added, ...prev]); loadIndex(); }
    catch (e) { setError(String(e).replace(/^Error: \d+: /, '')); }
    setUploading(false);
  };
  const go = (h: string) => { location.hash = h; setOpen(null); };

  const nav = (on: boolean, label: string, onClick: () => void, icon: React.ReactNode, n?: number, warn?: boolean) => (
    <button onClick={onClick} className={clsx('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition text-left',
      on ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
      {icon}<span className="flex-1 truncate">{label}</span>
      {!!n && <span className={clsx('text-[11px] font-mono', warn ? 'text-amber-500' : 'text-[var(--text-muted)]')}>{n}</span>}
    </button>
  );
  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button onClick={onClick} className={clsx('px-2.5 py-1 rounded-lg text-xs border transition',
      on ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]/60 font-medium' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>{label}</button>
  );
  const title = route.view === 'drafts' ? 'Drafts from agents'
    : route.view === 'pinned' ? 'Pinned'
    : route.view === 'unfiled' ? 'Unfiled'
    : route.view === 'secrets' ? 'API Keys & Secrets'
    : route.view === 'contacts' ? 'Contacts'
    : (route.view === 'calendar' || route.view === 'events') ? 'Calendar'
    : current?.name ?? 'Codex';

  const description = current?.description || (
    route.view === 'drafts' ? 'What agents saved for you. Agents can already find drafts; accept the ones worth keeping.'
    : route.view === 'secrets' ? 'Encrypted API keys, tokens, and credentials for external services. Agents can reference them safely by name without exposing the secret values.'
    : route.view === 'contacts' ? 'People, roles, contact details and notes. Agents search contacts when you refer to people.'
    : (route.view === 'calendar' || route.view === 'events') ? 'Meetings, milestones and scheduled events. Browse by month or upcoming timeline.'
    : 'Your long-term reference shelf: notes, links, snippets, files, contacts and calendar events. Agents search it when they need it, so it never crowds their prompt the way memories can.'
  );

  const isCalendarView = route.view === 'calendar' || route.view === 'events';
  const isContactsView = route.view === 'contacts';

  return (
    <div className="h-full flex min-h-0">
      <aside className={clsx('hidden w-56 shrink-0 flex-col border-r border-[var(--border-subtle)] overflow-y-auto px-2 py-4 gap-0.5', open ? '2xl:flex' : 'md:flex')}>
        {nav(false, 'Me', () => go('#/codex/me'), <UserRound className="w-4 h-4 text-rose-400" />)}
        {nav(route.view === 'all' && !route.entry, 'Everything', () => go('#/codex'), <BookMarked className="w-4 h-4 text-indigo-400" />, index?.counts.all)}
        {nav(route.view === 'secrets', 'API Keys & Secrets', () => go('#/codex/secrets'), <KeyRound className="w-4 h-4 text-rose-400" />, index?.counts.secrets)}
        {nav(route.view === 'contacts', 'Contacts', () => go('#/codex/contacts'), <User className="w-4 h-4 text-teal-400" />, index?.counts.contacts)}
        {nav(route.view === 'calendar' || route.view === 'events', 'Calendar', () => go('#/codex/calendar'), <Calendar className="w-4 h-4 text-orange-400" />, index?.counts.events)}
        {nav(route.view === 'pinned', 'Pinned', () => go('#/codex/pinned'), <Pin className="w-4 h-4" />, index?.counts.pinned)}
        {nav(route.view === 'drafts', 'Drafts from agents', () => go('#/codex/drafts'), <Inbox className="w-4 h-4" />, index?.counts.drafts, true)}
        {nav(route.view === 'unfiled', 'Unfiled', () => go('#/codex/unfiled'), <FolderClosed className="w-4 h-4" />, index?.counts.unfiled)}
        <div className="flex items-center justify-between mt-4 mb-1 px-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Collections</span>
          <button className={btn.icon} title="New collection" onClick={() => setNewCol('')}><Plus className="w-3.5 h-3.5" /></button>
        </div>
        {newCol !== null && (
          <input className={clsx(btn.input, 'mb-1')} autoFocus value={newCol} placeholder="Collection name" onChange={e => setNewCol(e.target.value)}
            onKeyDown={async e => {
              if (e.key === 'Escape') setNewCol(null);
              if (e.key === 'Enter' && newCol.trim()) {
                try { const c = await api.createCodexCollection(newCol.trim()); setNewCol(null); await loadIndex(); go(`#/codex/c/${c.id}`); }
                catch (err) { setError(String(err).replace(/^Error: \d+: /, '')); }
              }
            }} onBlur={() => !newCol.trim() && setNewCol(null)} />
        )}
        {index?.collections.map(c => nav(route.view === 'collection' && route.collection === c.id, c.name, () => go(`#/codex/c/${c.id}`),
          <FolderClosed className="w-4 h-4 text-indigo-300" />, c.count))}
        {index && !index.collections.length && newCol === null && <p className="px-2.5 text-[11px] text-[var(--text-muted)]">Group entries by topic: Lab, Work, Projects…</p>}
        {!!index?.tags.length && (
          <>
            <span className="mt-4 mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tags</span>
            <div className="flex flex-wrap gap-1 px-2">
              {index.tags.slice(0, 30).map(([t, n]) => (
                <button key={t} onClick={() => setTag(tag === t ? '' : t)} title={`${n} entries`}
                  className={clsx('px-1.5 py-0.5 rounded text-[11px] border', tag === t ? 'border-[var(--accent)]/60 bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>#{t}</button>
              ))}
            </div>
          </>
        )}
      </aside>

      <div className={clsx('flex-1 min-w-0 overflow-y-auto relative', drag && 'ring-2 ring-inset ring-[var(--accent)]/60')}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDrag(false); }}
        onDrop={e => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}>
        <div className="max-w-4xl mx-auto px-4 py-6 animate-fade-in">
          <div className={clsx('mb-3', open ? '2xl:hidden' : 'md:hidden')}>
            <select className={btn.input} aria-label="Section" value={route.view === 'collection' ? `#/codex/c/${route.collection}` : route.view === 'all' ? '#/codex' : `#/codex/${route.view}`}
              onChange={e => go(e.target.value)}>
              <option value="#/codex">Everything ({index?.counts.all ?? 0})</option>
              <option value="#/codex/secrets">API Keys & Secrets ({index?.counts.secrets ?? 0})</option>
              <option value="#/codex/me">Me</option>
              <option value="#/codex/contacts">Contacts ({index?.counts.contacts ?? 0})</option>
              <option value="#/codex/calendar">Calendar ({index?.counts.events ?? 0})</option>
              <option value="#/codex/pinned">Pinned ({index?.counts.pinned ?? 0})</option>
              <option value="#/codex/drafts">Drafts from agents ({index?.counts.drafts ?? 0})</option>
              <option value="#/codex/unfiled">Unfiled ({index?.counts.unfiled ?? 0})</option>
              {index?.collections.map(c => <option key={c.id} value={`#/codex/c/${c.id}`}>{c.name} ({c.count})</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="text-2xl font-semibold tracking-tight flex-1 min-w-0 truncate">{title}</h1>
            {current && (
              <div className="relative">
                <button className={btn.ghost} onClick={() => setColMenu(!colMenu)}>Collection<ChevronDown className="w-3 h-3" /></button>
                {colMenu && (
                  <div className="absolute right-0 top-full mt-1 z-30 w-48 p-1 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-xl" onMouseLeave={() => setColMenu(false)}>
                    <button className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-[var(--bg-hover)]" onClick={async () => {
                      setColMenu(false); const n = prompt('Rename collection', current.name)?.trim();
                      if (n) { await api.patchCodexCollection(current.id, { name: n }).catch(e => setError(String(e))); loadIndex(); }
                    }}>Rename</button>
                    <button className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-[var(--bg-hover)]" onClick={async () => {
                      setColMenu(false); const d = prompt('Describe this collection (agents see it)', current.description);
                      if (d !== null && d !== undefined) { await api.patchCodexCollection(current.id, { description: d }); loadIndex(); }
                    }}>Edit description</button>
                    <button className="w-full text-left px-2.5 py-1.5 rounded text-xs text-red-400 hover:bg-red-500/10" onClick={async () => {
                      setColMenu(false);
                      if (confirm(`Delete the collection “${current.name}”? Its ${current.count} entries move to Unfiled.`)) { await api.deleteCodexCollection(current.id); go('#/codex'); loadIndex(); }
                    }}>Delete collection</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            {description}
          </p>

          {isContactsView ? (
            <ContactsView
              contacts={items.filter(i => i.kind === 'contact')}
              agentNames={agentNames}
              onOpenContact={c => setOpen({ ...c })}
              onCreateContact={() => setOpen({ kind: 'contact', title: '', body: '', tags: tag ? [tag] : [], collectionId: defaultCollection, url: '', meta: {} })}
              onAutoPopulate={autoPopulate}
              populating={populating}
              onAccept={async c => { onSaved(await api.patchCodexEntry(c.id, { draft: false })); }}
              onDiscard={async c => { await api.deleteCodexEntry(c.id); setItems(p => p.filter(i => i.id !== c.id)); setAllContacts(p => p.filter(i => i.id !== c.id)); loadIndex(); }}
              onPin={async c => onSaved(await api.patchCodexEntry(c.id, { pinned: !c.pinned }))}
              onImported={r => { toast(`Imported ${r.added} new, updated ${r.updated}`); loadItems(); loadIndex(); }}
              onSync={() => setSyncKind('carddav')}
            />
          ) : !isCalendarView ? (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder="Search by meaning or words" />
                </div>
                {(['note', 'link', 'snippet', 'contact', 'event', 'secret'] as CodexKind[]).map(k => {
                  const I = KIND[k].icon;
                  return <button key={k} className={btn.subtle} onClick={() => setOpen({ kind: k, title: '', body: '', tags: tag ? [tag] : [], collectionId: defaultCollection, url: '', language: '', meta: {} })}>
                    <I className={clsx('w-3.5 h-3.5', KIND[k].color)} />{KIND[k].label}</button>;
                })}
                <button className={btn.subtle} onClick={() => fileInput.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5 text-violet-400" />}Files</button>
                <input ref={fileInput} type="file" multiple hidden onChange={e => { upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
                <button className={clsx(btn.subtle, 'text-amber-400 border-amber-500/30 hover:bg-amber-500/10')} onClick={autoPopulate} disabled={populating} title="Extract people and calendar events from what Shell:B knows in Memory">
                  {populating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Auto-populate
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mb-4">
                {chip(kind === '', 'All kinds', () => setKind(''))}
                {(Object.keys(KIND) as CodexKind[]).map(k => chip(kind === k, KIND[k].plural, () => setKind(kind === k ? '' : k)))}
                {tag && <button className="ml-1 flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-[var(--accent)]/60" onClick={() => setTag('')}>#{tag}<X className="w-3 h-3" /></button>}
              </div>
              {popStatus && (
                <div className="mb-3 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs flex items-center gap-2">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <span className="flex-1 font-medium">{popStatus}</span>
                  <button onClick={() => setPopStatus('')}><X className="w-3.5 h-3.5" /></button>
                </div>
              )}
              {error && <div className="mb-3 text-xs text-red-500 dark:text-red-400">{error}</div>}

              {!loaded ? (
                <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
              ) : items.length === 0 ? (
                route.view === 'secrets' ? (
                  <div className="p-8 text-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/25 text-rose-400 flex items-center justify-center mx-auto">
                      <KeyRound className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold">No API keys or secrets stored yet</h3>
                      <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto mt-1">
                        Store credentials for external APIs, GitHub tokens, webhooks, or third-party services. Shell:B encrypts them on disk with AES-256-GCM and lets agents use them safely.
                      </p>
                    </div>
                    <div className="flex items-center justify-center gap-2 pt-2">
                      <button className={btn.primary} onClick={() => setOpen({ kind: 'secret', title: '', body: '', tags: [], collectionId: defaultCollection, url: '', language: '', meta: {} })}>
                        <Plus className="w-3.5 h-3.5" />New Secret / API Key
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-16 text-sm text-[var(--text-muted)]">
                    <BookMarked className="w-8 h-8 mx-auto mb-2" />
                    {query ? 'Nothing matches that search.' : route.view === 'drafts' ? 'No drafts waiting. When an agent saves something to the Codex, it lands here first.'
                      : 'Nothing here yet. Add a note, contact, event, link or snippet, or drop files anywhere on this page.'}
                  </div>
                )
              ) : (
                <div className="space-y-1.5">
                  {items.map(e => (
                    <Row key={e.id} e={e} agentNames={agentNames} active={open?.id === e.id}
                      collection={route.view === 'collection' ? undefined : colName(e.collectionId)}
                      onOpen={() => setOpen({ ...e })}
                      onAccept={async () => { onSaved(await api.patchCodexEntry(e.id, { draft: false })); if (route.view === 'drafts') loadItems(); }}
                      onDiscard={async () => { await api.deleteCodexEntry(e.id); setItems(p => p.filter(i => i.id !== e.id)); loadIndex(); }}
                      onPin={async () => onSaved(await api.patchCodexEntry(e.id, { pinned: !e.pinned }))} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <CalendarView
              events={items.filter(i => i.kind === 'event')}
              contacts={allContacts}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              onOpenEvent={ev => setOpen({ ...ev })}
              onOpenContact={c => setOpen({ ...c })}
              onCreateEvent={d => setOpen({ kind: 'event', title: '', body: '', tags: [], collectionId: defaultCollection, url: '', meta: { date: d || selectedDate } })}
              onAutoPopulate={autoPopulate}
              populating={populating}
              onImported={r => { toast(`Imported ${r.added} new, updated ${r.updated}`); loadItems(); loadIndex(); }}
              onSync={() => setSyncKind('caldav')}
            />
          )}
        </div>
        {drag && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)]/60 text-sm font-medium">
          Drop to add {current ? `to ${current.name}` : 'to the Codex'}</div>}
      </div>

      {open && open.kind === 'contact' && (
        <ContactEditor key={open.id ?? 'new-contact'} start={open} index={index} agentNames={agentNames}
          onClose={() => { setOpen(null); if (route.entry) history.replaceState(null, '', location.hash.split('/e/')[0] || '#/codex'); }}
          onSaved={onSaved}
          onDeleted={id => { setItems(p => p.filter(i => i.id !== id)); setOpen(null); refresh(); }} />
      )}
      {open && open.kind === 'event' && (
        <EventEditor key={open.id ?? 'new-event'} start={open} index={index} agentNames={agentNames}
          allContacts={contactNames} contacts={allContacts}
          onClose={() => { setOpen(null); if (route.entry) history.replaceState(null, '', location.hash.split('/e/')[0] || '#/codex'); }}
          onSaved={onSaved}
          onDeleted={id => { setItems(p => p.filter(i => i.id !== id)); setOpen(null); refresh(); }} />
      )}
      {open && open.kind === 'secret' && (
        <SecretEditor key={open.id ?? 'new-secret'} start={open} index={index} agentNames={agentNames}
          onClose={() => { setOpen(null); if (route.entry) history.replaceState(null, '', location.hash.split('/e/')[0] || '#/codex'); }}
          onSaved={onSaved}
          onDeleted={id => { setItems(p => p.filter(i => i.id !== id)); setOpen(null); refresh(); }} />
      )}
      {open && open.kind !== 'contact' && open.kind !== 'event' && open.kind !== 'secret' && (
        <Editor key={open.id ?? `new-${open.kind}`} start={open} index={index} agentNames={agentNames}
          onClose={() => { setOpen(null); if (route.entry) history.replaceState(null, '', location.hash.split('/e/')[0] || '#/codex'); }}
          onSaved={onSaved}
          onDeleted={id => { setItems(p => p.filter(i => i.id !== id)); setOpen(null); refresh(); }} />
      )}
    {syncKind && <SyncAccountsDialog kind={syncKind} onClose={() => setSyncKind(null)} onChanged={() => { loadItems(); loadIndex(); }} />}
      </div>
  );
}
