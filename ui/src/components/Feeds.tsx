import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, CheckCheck, Download, ExternalLink, Loader2, MessageSquare, Plus, RefreshCw, Rss, Settings2, Trash2, Upload } from 'lucide-react';
import { req } from '../api';
import { startChatWith } from '../desktop';
import { btn, relTime } from './common';
import { toast, toastError } from './toast';
import { t as tx } from '../i18n';

/** The Feeds app (#/feeds, server/feeds.py): RSS/Atom subscriptions, unread items, one item open at a time, "Ask about
 * this" hands the item to a new chat. Items are the publisher's words: shown as text, never rendered as HTML. */
interface Feed { id: string; url: string; title: string; site: string; folder: string; everyMinutes: number; lastChecked: number | null; lastOk: number | null; error: string; unread: number }
interface Item { id: string; feedId: string; title: string; link: string; author: string; published: number | null; summary: string; read: boolean; created: number; content?: string }

const route = () => { const m = /^#\/feeds(?:\/([^/?]+))?/.exec(location.hash); return m?.[1] ?? ''; };

export function Feeds() {
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [sel, setSel] = useState<string>(route);  // '' = all, or a feed id
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Feed | null>(null);
  const opml = useRef<HTMLInputElement>(null);

  const loadFeeds = useCallback(() => req<{ feeds: Feed[] }>('/api/feeds').then(r => setFeeds(r.feeds)).catch(toastError(tx('Feeds'))), []);
  const loadItems = useCallback(() => {
    const p = new URLSearchParams({ limit: '80' });
    if (sel) p.set('feed', sel);
    if (unreadOnly && !q) p.set('unread', '1');
    if (q) p.set('q', q);
    return req<{ items: Item[] }>(`/api/feeds/items?${p}`).then(r => setItems(r.items)).catch(toastError(tx('Feeds')));
  }, [sel, unreadOnly, q]);
  useEffect(() => { loadFeeds(); }, [loadFeeds]);
  // actions reload through this counter rather than by calling loadItems() directly: a subscribe changes sel and
  // unreadOnly, and the stale closure's fetch could land after the fresh one and blank the list
  const [tick, setTick] = useState(0);
  useEffect(() => { loadItems(); }, [loadItems, tick]);
  useEffect(() => {
    const onHash = () => setSel(route());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const pick = (id: string) => { setSel(id); setOpen(null); history.replaceState(null, '', id ? `#/feeds/${id}` : '#/feeds'); };

  const act = async (what: string, f: () => Promise<unknown>) => { setBusy(what); try { await f(); await loadFeeds(); setTick(t => t + 1); } catch (e) { toastError(tx('Feeds'))(e); } finally { setBusy(''); } };
  const subscribe = (e: React.FormEvent) => {
    e.preventDefault();
    act('add', async () => {
      const r = await req<Feed & { existing: boolean; items?: number }>('/api/feeds', { method: 'POST', body: JSON.stringify({ url }) });
      // a new subscription starts read (the backlog isn't news), so show everything or the reader looks empty
      toast(r.existing ? `Already following ${r.title}` : `Following ${r.title}${r.items ? ` · ${r.items} items so far` : ''}`);
      if (!r.existing) setUnreadOnly(false);
      setUrl(''); setAdding(false); pick(r.id);
    });
  };
  const openItem = async (it: Item) => {
    try {
      const full = await req<Item>(`/api/feeds/items/${it.id}`);
      setOpen(full);
      if (!it.read) {
        await req('/api/feeds/items/read', { method: 'POST', body: JSON.stringify({ ids: [it.id] }) });
        setItems(p => p?.map(x => x.id === it.id ? { ...x, read: true } : x) ?? null);
        setFeeds(p => p?.map(f => f.id === it.id ? f : f.id === it.feedId ? { ...f, unread: Math.max(0, f.unread - 1) } : f) ?? null);
      }
    } catch (e) { toastError(tx('Feeds'))(e); }
  };
  // hands the item to a new chat the way a share from another app would (desktop.ts): the app shell opens the chat
  // and its composer takes the text
  const askAbout = (it: Item) => startChatWith(`About this feed item: "${it.title}"${it.link ? ` (${it.link})` : ''}\n\n${(it.content || it.summary || '').slice(0, 2000)}\n\n`);
  const totalUnread = feeds?.reduce((n, f) => n + f.unread, 0) ?? 0;
  const folders = Array.from(new Set((feeds ?? []).map(f => f.folder))).sort();
  const feedOf = (id: string) => feeds?.find(f => f.id === id);

  return (
    <div className="h-full flex flex-col sm:flex-row min-h-0">
      <aside className="sm:w-64 shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--border-subtle)] flex flex-col min-h-0">
        <div className="p-3 flex items-center gap-2 border-b border-[var(--border-subtle)]">
          <Rss className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-semibold flex-1">{tx('Feeds')}</span>
          <button className={btn.icon} title={tx('Refresh all')} disabled={busy === 'all'} onClick={() => act('all', () => req('/api/feeds/refresh', { method: 'POST' }))}>
            {busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <button className={btn.icon} title={tx('Follow a site or feed')} onClick={() => setAdding(a => !a)}><Plus className="w-3.5 h-3.5" /></button>
        </div>
        {adding && (
          <form className="p-2 border-b border-[var(--border-subtle)] flex gap-1.5" onSubmit={subscribe}>
            <input className={clsx(btn.input, 'flex-1 text-xs')} placeholder="https://example.com or a feed URL" value={url} onChange={e => setUrl(e.target.value)} autoFocus />
            <button className={btn.primary} type="submit" disabled={busy === 'add' || !url.trim()}>{busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : tx('Follow')}</button>
          </form>
        )}
        <div className="flex-1 overflow-y-auto p-1.5 text-[13px]">
          <button onClick={() => pick('')} className={clsx('w-full flex items-center justify-between px-2 py-1.5 rounded-lg', !sel ? 'bg-[var(--bg-hover)] font-medium' : 'hover:bg-[var(--bg-tertiary)]')}>
            <span>{tx('All feeds')}</span>{totalUnread > 0 && <span className="text-[10px] px-1.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">{totalUnread}</span>}
          </button>
          {feeds === null && <div className="px-2 py-1 text-xs text-[var(--text-muted)]">{tx('Loading…')}</div>}
          {feeds?.length === 0 && <div className="px-2 py-3 text-xs text-[var(--text-muted)] max-w-[32ch]">{tx('Nothing followed yet. Paste a site\'s address above; Shell:B finds its feed. Or import an OPML file from another reader.')}</div>}
          {folders.map(folder => (
            <div key={folder || '_'}>
              {folder && <div className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{folder}</div>}
              {feeds!.filter(f => f.folder === folder).map(f => (
                <div key={f.id} className={clsx('group flex items-center gap-1 rounded-lg', sel === f.id ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-tertiary)]')}>
                  <button onClick={() => pick(f.id)} className="flex-1 min-w-0 flex items-center justify-between px-2 py-1.5 text-left" title={f.error ? tx('Last check failed: {error}', { error: f.error }) : f.url}>
                    <span className={clsx('truncate', f.error && 'text-amber-400')}>{f.title || f.url}</span>
                    {f.unread > 0 && <span className="ml-2 text-[10px] text-[var(--text-muted)] tabular-nums">{f.unread}</span>}
                  </button>
                  <button className={clsx(btn.icon, 'opacity-0 group-hover:opacity-100')} title={tx('Settings')} onClick={() => setEditing(f)}><Settings2 className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="p-2 border-t border-[var(--border-subtle)] flex gap-1.5 text-[11px]">
          <button className={btn.ghost} onClick={() => opml.current?.click()}><Upload className="w-3 h-3" />{tx('Import OPML')}</button>
          <input ref={opml} type="file" accept=".opml,.xml,text/xml" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const fd = new FormData(); fd.append('files', f); act('opml', async () => { const r = await req<{ added: number; skipped: number; failed: string[] }>('/api/feeds/import', { method: 'POST', body: fd }); toast(tx('Added {added}, already had {skipped}{v0}', { added: r.added, skipped: r.skipped, v0: r.failed.length ? `, ${r.failed.length} failed` : '' })); }); }} />
          <a className={btn.ghost} href="/api/feeds/export.opml" download="shellb-feeds.opml"><Download className="w-3 h-3" />{tx('Export')}</a>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="p-2 sm:p-3 flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)]">
          <h2 className="text-sm font-semibold truncate">{sel ? feedOf(sel)?.title ?? tx('Feed') : tx('All feeds')}</h2>
          {sel && feedOf(sel)?.site && <a className="text-[11px] text-[var(--text-muted)] hover:underline truncate" href={feedOf(sel)!.site} target="_blank" rel="noreferrer">{feedOf(sel)!.site.replace(/^https?:\/\//, '')}</a>}
          <span className="flex-1" />
          <input className={clsx(btn.input, 'w-44 text-xs')} placeholder={tx('Search items')} value={q} onChange={e => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} />{tx('Unread only')}</label>
          <button className={btn.subtle} title={tx('Mark everything shown as read')} onClick={() => act('read', () => req('/api/feeds/items/read', { method: 'POST', body: JSON.stringify(sel ? { feed: sel } : { all: true }) }))}><CheckCheck className="w-3.5 h-3.5" />{tx('Mark all read')}</button>
          {sel && <button className={btn.icon} title={tx('Refresh this feed')} disabled={busy === sel} onClick={() => act(sel, () => req(`/api/feeds/${sel}/refresh`, { method: 'POST' }))}>{busy === sel ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}</button>}
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className={clsx('overflow-y-auto min-h-0', open ? 'hidden md:block md:w-80 lg:w-96 shrink-0 border-r border-[var(--border-subtle)]' : 'flex-1')}>
            {items === null && <div className="p-4 text-xs text-[var(--text-muted)]">{tx('Loading…')}</div>}
            {items?.length === 0 && (
              <div className="p-6 text-sm text-[var(--text-muted)] text-center">
                {unreadOnly && !q ? <>{tx('All caught up.')} <button type="button" className="underline hover:text-[var(--text-primary)]" onClick={() => setUnreadOnly(false)}>{tx('Show everything')}</button></> : tx('Nothing here.')}
              </div>
            )}
            {items?.map(it => (
              <button key={it.id} onClick={() => openItem(it)} className={clsx('w-full text-left px-4 py-2.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)]', open?.id === it.id && 'bg-[var(--bg-hover)]')}>
                <div className="flex items-start gap-2">
                  <span className={clsx('mt-1.5 w-1.5 h-1.5 rounded-full shrink-0', it.read ? 'bg-transparent' : 'bg-[var(--accent)]')} />
                  <div className="min-w-0 flex-1">
                    <div className={clsx('text-[13px] leading-snug', it.read ? 'text-[var(--text-secondary)]' : 'font-medium')}>{tx(it.title)}</div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">{!sel && feedOf(it.feedId)?.title}{!sel && ' · '}{it.published ? relTime(it.published * 1000) : relTime(it.created * 1000)}{it.author ? ` · ${it.author}` : ''}</div>
                    {!open && it.summary && <div className="text-[12px] text-[var(--text-secondary)] line-clamp-2 mt-0.5 max-w-[75ch]">{tx(it.summary)}</div>}
                  </div>
                </div>
              </button>
            ))}
          </div>
          {open && (
            <article className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
              <button className={clsx(btn.ghost, 'md:hidden mb-2')} onClick={() => setOpen(null)}>{tx('← Back')}</button>
              <div className="text-[11px] text-[var(--text-muted)] mb-1">{feedOf(open.feedId)?.title}{open.author ? ` · ${open.author}` : ''}{open.published ? ` · ${new Date(open.published * 1000).toLocaleString()}` : ''}</div>
              <h1 className="text-xl font-semibold tracking-tight leading-tight max-w-[65ch]">{tx(open.title)}</h1>
              <div className="flex flex-wrap gap-2 my-3">
                {open.link && <a className={btn.subtle} href={open.link} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" />{tx('Open the article')}</a>}
                <button className={btn.subtle} onClick={() => askAbout(open)}><MessageSquare className="w-3.5 h-3.5" />{tx('Ask about this')}</button>
                <button className={btn.ghost} onClick={() => act('unread', () => req('/api/feeds/items/read', { method: 'POST', body: JSON.stringify({ ids: [open.id], read: false }) }))}><Check className="w-3.5 h-3.5" />{tx('Keep unread')}</button>
              </div>
              <p className="text-[14px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap max-w-[70ch]">{open.content || open.summary || tx('The feed carried only a title. Open the article for the text.')}</p>
            </article>
          )}
        </div>
      </main>

      {editing && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <form className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-4 space-y-3 text-sm" onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); act('edit', () => req(`/api/feeds/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ title: editing.title, folder: editing.folder, everyMinutes: editing.everyMinutes }) })).then(() => setEditing(null)); }}>
            <h3 className="font-semibold">{tx('Feed settings')}</h3>
            <label className="block text-xs text-[var(--text-muted)]">{tx('Title')}<input className={btn.input} value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label>
            <label className="block text-xs text-[var(--text-muted)]">{tx('Folder')}<input className={btn.input} value={editing.folder} placeholder={tx('News, Work, Hobbies…')} onChange={e => setEditing({ ...editing, folder: e.target.value })} /></label>
            <label className="block text-xs text-[var(--text-muted)]">{tx('Check every (minutes, 15 or more)')}<input type="number" min={15} className={btn.input} value={editing.everyMinutes} onChange={e => setEditing({ ...editing, everyMinutes: Number(e.target.value) || 60 })} /></label>
            <div className="text-[11px] text-[var(--text-muted)] break-all">{editing.url}{editing.error && <span className="block text-amber-400 mt-1">{tx('Last check failed: {error}', { error: editing.error })}</span>}</div>
            <div className="flex gap-2 justify-between">
              <button type="button" className={clsx(btn.ghost, 'text-red-400')} onClick={() => { if (confirm(tx('Unfollow {title}? Its items go too.', { title: editing.title }))) act('del', () => req(`/api/feeds/${editing.id}`, { method: 'DELETE' })).then(() => { setEditing(null); if (sel === editing.id) pick(''); }); }}><Trash2 className="w-3.5 h-3.5" />{tx('Unfollow')}</button>
              <span className="flex gap-2"><button type="button" className={btn.ghost} onClick={() => setEditing(null)}>{tx('Cancel')}</button><button className={btn.primary} type="submit">{tx('Save')}</button></span>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
