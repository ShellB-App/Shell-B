// Settings → Community (server/family.py): every GitHub repository Shell:B installs community work from. The official
// Shell-B-* repositories are always listed; the owner can add their own collections (same layout, any GitHub repo)
// and remove them again. Kinds with an installer are handed to the matching picker; the rest show where they'll land.
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { ExternalLink, Library, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { req } from '../api';
import type { SettingsTabId } from '../types';
import { btn, relTime } from './common';
import { toast } from './toast';
import { t } from '../i18n';

interface Stats { sha?: string; fetched?: number; count?: number; names?: string[]; error?: string; tried?: number }
interface Repo { id: string; kind: string; kindLabel: string; repo: string; ref: string; name: string; blurb: string; official: boolean;
  where: string; installs: boolean; url: string; stats: Stats | null }
interface Kind { label: string; folder: string; where: string; installs: boolean }
interface Listing { repos: Repo[]; kinds: Record<string, Kind> }

const TAB_FOR: Record<string, SettingsTabId | undefined> = { theme: 'appearance', screensaver: 'appearance', voice: 'speech' };

export function CommunityRepos({ onOpenTab }: { onOpenTab?: (tab: SettingsTabId) => void }) {
  const [data, setData] = useState<Listing | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'theme', repo: '', name: '' });

  const load = useCallback(async (refresh = false) => {
    setBusy(refresh ? 'all' : 'load'); setError('');
    try { setData(await req<Listing>(`/api/family${refresh ? '?refresh=1' : ''}`)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(''); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {  // first visit: count the repositories that were never fetched, in the background
    if (data && data.repos.some(r => !r.stats)) load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data === null]);

  const refreshOne = async (r: Repo) => {
    setBusy(r.id);
    try { const stats = await req<Stats>(`/api/family/${r.id}/refresh`, { method: 'POST' }); setData(d => d && { ...d, repos: d.repos.map(x => x.id === r.id ? { ...x, stats } : x) }); }
    catch (e) { toast(t("Couldn't refresh {repo}: {e}", { repo: r.repo, e: String(e) }), { kind: 'error' }); }
    finally { setBusy(''); }
  };
  const remove = async (r: Repo) => {
    if (!confirm(t('Remove {name} from the list? Anything already installed from it stays.', { name: r.name }))) return;
    try { await req(`/api/family/${r.id}`, { method: 'DELETE' }); load(); }
    catch (e) { toast(String(e).startsWith('Error: 403') ? t('Sign in as the owner to change the list') : String(e), { kind: 'error' }); }
  };
  const submit = async () => {
    if (!form.repo.trim()) return;
    setBusy('add');
    try {
      await req('/api/family', { method: 'POST', body: JSON.stringify(form) });
      setAdding(false); setForm({ kind: form.kind, repo: '', name: '' }); load();
      toast(t('Added. Its items are counted once fetched.'));
    } catch (e) {
      const s = String(e);
      toast(s.startsWith('Error: 403') ? t('Sign in as the owner to change the list') : t("Couldn't add it: {e}", { e: s }), { kind: 'error' });
    } finally { setBusy(''); }
  };

  const official = data?.repos.filter(r => r.official) ?? [];
  const mine = data?.repos.filter(r => !r.official) ?? [];

  return (
    <div className="space-y-6 max-w-[760px]">
      <div className="flex items-start gap-3">
        <Library className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">{t('Community repositories')}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-1 max-w-[65ch]">
            {t('Shell:B installs themes, screensavers, templates, skills, agents, worlds, voices and apps from GitHub repositories laid out like the official ones. The official Shell:B repositories are always here; add your own collection or a friend\'s, and the matching picker starts browsing it. Nothing is fetched until a picker opens or you press Refresh, and every item is checked again on install.')}
          </p>
        </div>
        <button className={btn.subtle} disabled={busy === 'all'} onClick={() => load(true)} title={t('Fetch every repository again')}>
          <RefreshCw className={clsx('w-3.5 h-3.5', busy === 'all' && 'animate-spin')} />{t('Refresh all')}
        </button>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}

      <section>
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
          <h4 className="text-sm font-semibold flex-1">{t('Official')}</h4>
          <span className="text-[11px] text-[var(--text-muted)]">{t('maintained with Shell:B, always listed')}</span>
        </div>
        <div className="grid gap-2">
          {official.map(r => <Row key={r.id} r={r} busy={busy} onRefresh={refreshOne} onOpenTab={onOpenTab} />)}
          {!data && !error && <div className="text-xs text-[var(--text-muted)]">{t('Loading…')}</div>}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-sm font-semibold flex-1">{t('Yours')}</h4>
          <button className={btn.subtle} onClick={() => setAdding(a => !a)}><Plus className="w-3.5 h-3.5" />{t('Add a repository')}</button>
        </div>
        {adding && data && (
          <div className="p-3 mb-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2">
            <div className="grid sm:grid-cols-[150px_1fr] gap-2">
              <select className={btn.input} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} aria-label={t('What it holds')}>
                {Object.entries(data.kinds).map(([k, v]) => <option key={k} value={k}>{t(v.label)}</option>)}
              </select>
              <input className={btn.input} placeholder="owner/name or https://github.com/owner/name" value={form.repo} autoFocus
                onChange={e => setForm({ ...form, repo: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
            </div>
            <input className={btn.input} placeholder={t('Name (optional)')} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <p className="text-[11px] text-[var(--text-muted)]">
              {t('The repository must be public on GitHub and laid out like {official}: a folder per item and an index.json. Fork an official one to start.', { official: official.find(o => o.kind === form.kind)?.repo ?? 'the official one' })}
            </p>
            <div className="flex gap-2 justify-end">
              <button className={btn.ghost} onClick={() => setAdding(false)}>{t('Cancel')}</button>
              <button className={btn.primary} disabled={busy === 'add' || !form.repo.trim()} onClick={submit}>{busy === 'add' ? t('Checking…') : t('Add')}</button>
            </div>
          </div>
        )}
        <div className="grid gap-2">
          {mine.map(r => <Row key={r.id} r={r} busy={busy} onRefresh={refreshOne} onRemove={remove} onOpenTab={onOpenTab} />)}
          {data && mine.length === 0 && !adding && (
            <div className="text-xs text-[var(--text-muted)] p-3 rounded-lg border border-dashed border-[var(--border-subtle)]">
              {t('No repositories of your own yet. Anyone can publish a collection: fork an official repository, keep its layout, and add it here.')}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Row({ r, busy, onRefresh, onRemove, onOpenTab }: { r: Repo; busy: string; onRefresh: (r: Repo) => void; onRemove?: (r: Repo) => void; onOpenTab?: (tab: SettingsTabId) => void }) {
  const s = r.stats;
  const tab = TAB_FOR[r.kind];
  return (
    <div className="flex gap-3 p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]">{t(r.kindLabel)}</span>
          <span className="text-sm font-medium truncate">{r.name}</span>
          <a href={r.url} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 truncate">
            {r.repo}<ExternalLink className="w-3 h-3" />
          </a>
        </div>
        {r.blurb && <div className="text-xs text-[var(--text-secondary)] mt-1 max-w-[65ch]">{t(r.blurb)}</div>}
        <div className="text-[11px] text-[var(--text-muted)] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          <span>{t(r.where)}</span>
          {s?.count !== undefined && !s.error && <span>{t('{n} items', { n: s.count })}{s.fetched ? ` · ${relTime(s.fetched * 1000)}` : ''}</span>}
          {s?.error && <span className="text-amber-500/90">{s.error}</span>}
          {!s && <span>{t('not fetched yet')}</span>}
        </div>
        {s?.names && s.names.length > 0 && !s.error && (
          <div className="text-[11px] text-[var(--text-muted)] mt-1 truncate" title={s.names.join(', ')}>{s.names.join(' · ')}</div>
        )}
      </div>
      <div className="flex flex-col gap-1 items-end shrink-0">
        {tab && onOpenTab && <button className={btn.ghost} onClick={() => onOpenTab(tab)}>{t('Browse')}</button>}
        <button className={btn.ghost} disabled={busy === r.id} onClick={() => onRefresh(r)} title={t('Fetch again and count the items')}>
          <RefreshCw className={clsx('w-3.5 h-3.5', busy === r.id && 'animate-spin')} />
        </button>
        {onRemove && <button className={clsx(btn.ghost, 'hover:text-red-400')} onClick={() => onRemove(r)} title={t('Remove from the list')}><Trash2 className="w-3.5 h-3.5" /></button>}
      </div>
    </div>
  );
}
