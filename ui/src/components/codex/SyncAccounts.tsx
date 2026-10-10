import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { req } from '../../api';
import { btn, relTime } from '../common';
import { toast } from '../toast';

/** Codex → Calendar / Contacts → Sync…: CalDAV calendars and CardDAV address books kept in step with the Codex
 * (server/codex_sync.py). Passwords are written, never read back. */
interface Account { id: string; kind: 'caldav' | 'carddav'; name: string; url: string; user: string; collection: string; everyMinutes: number; enabled: boolean; lastSync: number | null; lastError: string; stats: Record<string, number>; hasPassword: boolean }
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '').replace(/^\d+: /, '');

export function SyncAccountsDialog({ kind, onClose, onChanged }: { kind: 'caldav' | 'carddav'; onClose: () => void; onChanged: () => void }) {
  const [accts, setAccts] = useState<Account[] | null>(null);
  const [form, setForm] = useState<{ name: string; url: string; user: string; password: string; everyMinutes: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = () => req<{ accounts: Account[] }>('/api/codex/sync').then(r => setAccts(r.accounts.filter(a => a.kind === kind))).catch(e => { setErr(errText(e)); setAccts([]); });
  useEffect(() => { load(); }, [kind]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const act = async (what: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(what); setErr('');
    try { await f(); await load(); onChanged(); if (done) toast(done); } catch (e) { setErr(errText(e)); } finally { setBusy(''); }
  };
  const label = kind === 'caldav' ? 'calendar' : 'address book';
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-label="Sync accounts" onClick={e => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">{kind === 'caldav' ? 'Calendar sync (CalDAV)' : 'Contacts sync (CardDAV)'}</h2>
          <button className={btn.icon} aria-label="Close" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-[var(--text-muted)] max-w-[60ch]">
          Every {kind === 'caldav' ? 'event' : 'contact'} here is pushed to the server (your edits win), then the server's {label} is pulled in; items are matched by UID so nothing doubles. Deletions aren't synced. Works with Nextcloud, Fastmail, Radicale, iCloud (app password) and the like; Google needs its CalDAV/CardDAV endpoints.
        </p>
        {accts === null && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />}
        {accts?.map(a => (
          <div key={a.id} className="rounded-lg border border-[var(--border-subtle)] p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={clsx('w-2 h-2 rounded-full', !a.enabled ? 'bg-[var(--text-muted)]' : a.lastError ? 'bg-amber-400' : 'bg-emerald-400')} />
              <span className="font-medium text-sm">{a.name}</span>
              <span className="text-[var(--text-muted)] truncate">{a.user} · every {a.everyMinutes} min{a.lastSync ? ` · synced ${relTime(a.lastSync * 1000)}` : ' · never synced'}</span>
              <span className="flex-1" />
              <button className={btn.icon} title="Sync now" disabled={busy === a.id} onClick={() => act(a.id, async () => { const r = await req<{ pushed: number; created: number; pulled: number; updated: number; error: string }>(`/api/codex/sync/${a.id}/run`, { method: 'POST' }); toast(r.error ? `Sync had trouble: ${r.error}` : `Pushed ${r.pushed + r.created}, pulled ${r.pulled} new, ${r.updated} updated`, { kind: r.error ? 'error' : 'info' }); })}>{busy === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}</button>
              <button className={btn.icon} title={a.enabled ? 'Pause' : 'Resume'} onClick={() => act(a.id, () => req(`/api/codex/sync/${a.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !a.enabled }) }))}>{a.enabled ? 'On' : 'Off'}</button>
              <button className={btn.icon} title="Remove" onClick={() => { if (confirm(`Stop syncing with ${a.name}? Entries stay here.`)) act(a.id, () => req(`/api/codex/sync/${a.id}`, { method: 'DELETE' })); }}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] truncate">{a.collection || a.url}</div>
            {a.lastError && <div className="text-[11px] text-amber-400 break-words">{a.lastError}</div>}
            {a.stats && Object.keys(a.stats).length > 0 && <div className="text-[11px] text-[var(--text-muted)]">last run: {Object.entries(a.stats).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
          </div>
        ))}
        {accts?.length === 0 && !form && <p className="text-xs text-[var(--text-muted)]">No {label} is synced yet.</p>}
        {!form && <button className={btn.subtle} onClick={() => setForm({ name: '', url: '', user: '', password: '', everyMinutes: 15 })}><Plus className="w-3.5 h-3.5" />Add a {label}</button>}
        {form && (
          <form className="space-y-2 text-xs" onSubmit={e => { e.preventDefault(); act('add', () => req('/api/codex/sync', { method: 'POST', body: JSON.stringify({ ...form, kind }) }), 'Account added; first sync runs now').then(() => setForm(null)); }}>
            <input className={btn.input} placeholder={kind === 'caldav' ? 'https://cloud.example.org/remote.php/dav/ (account root or a calendar URL)' : 'https://cloud.example.org/remote.php/dav/addressbooks/users/you/contacts/'} value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} required />
            <div className="grid sm:grid-cols-2 gap-2">
              <input className={btn.input} placeholder="Username" autoComplete="off" value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} required />
              <input className={btn.input} type="password" placeholder="Password or app password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
              <input className={btn.input} placeholder="Name (optional)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              <label className="flex items-center gap-2 text-[var(--text-muted)]">Every <input type="number" min={5} className={clsx(btn.input, 'w-20')} value={form.everyMinutes} onChange={e => setForm({ ...form, everyMinutes: Number(e.target.value) || 15 })} /> min</label>
            </div>
            <div className="flex gap-2"><button className={btn.primary} type="submit" disabled={busy === 'add'}>{busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}Add and sync</button><button className={btn.ghost} type="button" onClick={() => setForm(null)}>Cancel</button></div>
          </form>
        )}
        {err && <p className="text-xs text-red-400 break-words">{err}</p>}
      </div>
    </div>
  );
}
