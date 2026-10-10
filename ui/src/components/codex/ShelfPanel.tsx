import { useEffect, useRef, useState } from 'react';
import { Loader2, Share2, Upload, Users } from 'lucide-react';
import { req } from '../../api';
import type { CodexEntry } from '../../types';
import { btn, relTime } from '../common';
import { t } from '../../i18n';

/** A shelf item as the host lists it (server/shelf.py). */
interface ShelfItem {
  id: string; title: string; author: string; description: string; version: string; source?: string;
  maintainers: string[]; maintainerNames: Record<string, string>; updated?: number; updatedBy?: string;
}
interface Listing { items: ShelfItem[]; guests: { id: string; name: string }[] }

const errText = (err: unknown) => String(err).replace(/^Error: \d+: /, '');

/** Owner side, on a Codex file: put it on the shared shelf every guest's Codex gets, and pick who may publish new versions. */
export function ShareWithGuests({ entry }: { entry: CodexEntry }) {
  const [data, setData] = useState<Listing | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', author: '', description: '', maintainers: [] as string[] });
  const item = data?.items.find(i => i.source === entry.id) ?? null;

  const load = () => req<Listing>('/api/shelf').then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = () => {
    setForm(item ? { title: item.title, author: item.author, description: item.description, maintainers: item.maintainers }
      : { title: entry.title, author: '', description: '', maintainers: [] });
    setError(''); setOpen(true);
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      await req(`/api/shelf/entries/${entry.id}`, { method: 'PUT', body: JSON.stringify(form) });
      await load(); setOpen(false);
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  const stop = async () => {
    if (!item || !confirm(t('Stop sharing this with guests? Guests who already have it keep their copy.'))) return;
    setBusy(true);
    try { await req(`/api/shelf/items/${item.id}`, { method: 'DELETE' }); await load(); setOpen(false); } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  if (!data) return null;  // not the signed-in owner, or the host has no shelf

  const names = item ? item.maintainers.map(g => item.maintainerNames[g] ?? g).join(', ') : '';
  return (
    <div className="p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="w-4 h-4 text-[var(--accent)]" />
        <span className="flex-1 min-w-[180px] text-[var(--text-secondary)]">
          {item ? <>
            {t('Shared with guests · version {v0}', { v0: item.version })}
            {item.updatedBy && <> · {t('updated by {v0} {v1}', { v0: item.updatedBy, v1: relTime((item.updated ?? 0) * 1000) })}</>}
            {names && <span className="block text-[var(--text-muted)]">{t('Can publish new versions: {v0}', { v0: names })}</span>}
          </> : t('Only you can see this. Share it to put a copy in every guest\'s Codex.')}
        </span>
        {!open && <button className={item ? btn.ghost : btn.primary} onClick={edit}><Share2 className="w-3.5 h-3.5" />{item ? t('Sharing settings') : t('Share with guests')}</button>}
      </div>
      {open && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input className={btn.input} value={form.title} placeholder={t('Title guests see')} onChange={ev => setForm({ ...form, title: ev.target.value })} />
            <input className={btn.input} value={form.author} placeholder={t('Author (shown as who added it)')} onChange={ev => setForm({ ...form, author: ev.target.value })} />
          </div>
          <textarea className={`${btn.input} min-h-[60px] resize-y`} value={form.description} placeholder={t('A line about it, for guests and their agents')}
            onChange={ev => setForm({ ...form, description: ev.target.value })} />
          {data.guests.length > 0 && (
            <div>
              <div className="text-[var(--text-secondary)] mb-1">{t('Who can publish new versions from their own Shell:B')}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {data.guests.map(g => (
                  <label key={g.id} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={form.maintainers.includes(g.id)}
                      onChange={ev => setForm({ ...form, maintainers: ev.target.checked ? [...form.maintainers, g.id] : form.maintainers.filter(x => x !== g.id) })} />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <div className="text-red-400">{error}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn.primary} disabled={busy} onClick={save}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}{item ? t('Save') : t('Share with guests')}</button>
            <button className={btn.ghost} onClick={() => setOpen(false)}>{t('Cancel')}</button>
            <span className="flex-1" />
            {item && <button className="px-2 py-1 rounded text-[11px] text-red-500 hover:bg-red-500/10" disabled={busy} onClick={stop}>{t('Stop sharing')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Guest side (a cell), on an entry from the shared shelf: where it came from, and a new version for those allowed. */
export function ShelfPublish({ entry, onUpdated }: { entry: CodexEntry; onUpdated: (e: CodexEntry) => void }) {
  const m = entry.meta;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const upload = async (f: File) => {
    setBusy(true); setError(''); setNote('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await req<CodexEntry & { published: { version: string; unchanged?: boolean } }>(`/api/codex/entries/${entry.id}/publish`, { method: 'POST', body: fd });
      setNote(r.published.unchanged ? t('That file is the same as the current version.') : t('Version {v0} published. Everyone\'s copy updates within a few minutes.', { v0: r.published.version }));
      onUpdated(r);
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  return (
    <div className="p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="w-4 h-4 text-[var(--accent)]" />
        <span className="flex-1 min-w-[180px] text-[var(--text-secondary)]">
          {m.author ? t('Shared with every guest · by {v0} · version {v1}', { v0: m.author, v1: m.shelfVersion ?? '1' }) : t('Shared with every guest · version {v0}', { v0: m.shelfVersion ?? '1' })}
          {m.shelfUpdatedBy && m.shelfUpdated && <span className="block text-[var(--text-muted)]">{t('updated by {v0} {v1}', { v0: m.shelfUpdatedBy, v1: relTime(m.shelfUpdated * 1000) })}</span>}
        </span>
        {m.shelfCanPublish && <>
          <input ref={input} type="file" className="hidden" onChange={ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) upload(f); }} />
          <button className={btn.primary} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{t('Publish a new version')}</button>
        </>}
      </div>
      {m.shelfCanPublish && !note && !error && <div className="text-[var(--text-muted)]">{t('Your new file replaces this one for every guest. The previous version is kept.')}</div>}
      {note && <div className="text-emerald-500">{note}</div>}
      {error && <div className="text-red-400">{error}</div>}
    </div>
  );
}
