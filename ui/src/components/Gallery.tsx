// Community gallery (server/gallery.py): themes and screensavers published on GitHub, browsed from Settings →
// Appearance and installed with one click. Themes arrive as data and go through the server's validator; screensavers
// become Screensaver projects in the Studio. Installing needs the owner (or the admin key), browsing doesn't.
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Download, ExternalLink, Globe, MonitorCheck, MonitorPlay, RefreshCw } from 'lucide-react';
import { api, req } from '../api';
import type { Settings } from '../types';
import { customInfo, loadCustomThemes, setTheme, useTheme, type CustomTheme, type Mode } from '../themes';
import { PREVIEW_SAVER, loadAmbience, saveAmbience, useAmbience } from '../ambience';
import { Thumb } from './ThemePicker';
import { Modal, btn } from './common';
import { toast } from './toast';
import { t as tx } from '../i18n';

interface Item { id: string; name: string; blurb: string; author: string; authorUrl?: string; license: string; version: string; tags: string[];
  installed?: string | null; installedVersion?: string | null }
export interface GalleryTheme extends Item { mode: Mode; theme: CustomTheme }
export interface GallerySaver extends Item { clockSafe: boolean; preview: string | null; files: string[] }
export interface GalleryTemplate extends Item { kind: string; entry: string; brief: string; preview: string | null; files: string[] }
interface Source<T> { source: string; repo: string; sha: string; fetched: number; url: string; items: T[] }
interface Listing<T> { kind: string; sources: Source<T>[]; errors: string[] }

function useListing<T>(kind: 'theme' | 'screensaver' | 'template', open = true) {
  const [data, setData] = useState<Listing<T> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setData(await req<Listing<T>>(`/api/gallery/${kind}${refresh ? '?refresh=1' : ''}`)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [kind]);
  useEffect(() => { if (open) load(); }, [load, open]);
  return { data, loading, error, load };
}

/** "by Author · MIT", the author linked when the item gives a URL. */
function Credit({ it }: { it: Item }) {
  if (!it.author) return <span className="text-[10.5px] text-[var(--text-muted)] truncate">{it.license}</span>;
  return (
    <span className="text-[10.5px] text-[var(--text-muted)] truncate">
      {it.authorUrl
        ? <>{tx('by')} <a href={it.authorUrl} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-[var(--text-primary)]">{it.author}</a></>
        : tx('by {author}', { author: it.author })}
      {it.license ? ` · ${it.license}` : ''}
    </span>
  );
}

const installError = (e: unknown) => {
  const s = String(e);
  toast(s.startsWith('Error: 403') ? tx('Sign in as the owner to install from the gallery') : tx('Couldn\'t install: {e}', { e: s }), { kind: 'error' });
};

function Header({ title, hint, data, loading, onRefresh }: { title: string; hint: string; data: Listing<unknown> | null; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Globe className="w-3.5 h-3.5 text-[var(--accent-soft)]" />
      <div className="text-sm">{title}</div>
      <div className="text-[11px] text-[var(--text-muted)] min-w-0 truncate">{hint}</div>
      <div className="ml-auto flex items-center gap-1.5">
        {data?.sources.map(s => (
          <a key={s.source} href={s.url} target="_blank" rel="noreferrer" title={s.repo}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <ExternalLink className="w-3 h-3" />{s.repo.split('/')[1]}
          </a>
        ))}
        <button className={btn.icon} onClick={onRefresh} disabled={loading} title={tx('Fetch the latest from GitHub')} aria-label={tx('Refresh')}>
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
    </div>
  );
}

function Notes({ data, error, loading, empty }: { data: Listing<unknown> | null; error: string; loading: boolean; empty: string }) {
  const none = data && data.sources.every(s => s.items.length === 0);
  return (
    <>
      {error && <div className="mt-2 text-[11px] text-red-400">{tx('Couldn\'t reach the gallery: {e}', { e: error })}</div>}
      {data?.errors.map(e => <div key={e} className="mt-2 text-[11px] text-[var(--text-muted)]">{tx('Showing the last fetched copy. {e}', { e })}</div>)}
      {!data && loading && <div className="mt-2 text-[11px] text-[var(--text-muted)]">{tx('Fetching the gallery…')}</div>}
      {none && !loading && <div className="mt-2 text-[11px] text-[var(--text-muted)]">{empty}</div>}
    </>
  );
}

/** Settings → Appearance: the community themes, as tiles with an Install button. */
export function CommunityThemes({ settings, mode }: { settings?: Settings; mode: Mode }) {
  const { data, loading, error, load } = useListing<GalleryTheme>('theme');
  const current = useTheme();
  const [busy, setBusy] = useState('');
  const apply = (id: string) => {
    setTheme(id as `custom:${string}`);
    if (settings && 'theme' in settings) api.saveSettings({ theme: id }).catch(() => {});
  };
  const install = async (source: string, it: GalleryTheme) => {
    setBusy(`${source}:${it.id}`);
    try {
      const res = await req<{ theme: CustomTheme; notes: string[] }>('/api/gallery/install', { method: 'POST', body: JSON.stringify({ kind: 'theme', source, id: it.id }) });
      await loadCustomThemes();
      apply(`custom:${res.theme.id}`);
      toast(res.notes.length ? tx('Installed {name}; adjusted for contrast: {notes}', { name: it.name, notes: res.notes.join('; ') }) : tx('Installed {name}', { name: it.name }));
      load();
    } catch (e) { installError(e); } finally { setBusy(''); }
  };
  return (
    <div className="mt-5">
      <Header title={tx('Community themes')} hint={tx('Shared on GitHub; checked by Shell:B before they can touch the page')} data={data} loading={loading} onRefresh={() => load(true)} />
      <Notes data={data} error={error} loading={loading} empty={tx('No themes published yet. Export one of yours and open a pull request.')} />
      {data?.sources.map(s => s.items.length > 0 && (
        <div key={s.source} className="mt-2.5 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {s.items.map(it => {
            const info = customInfo({ ...it.theme, id: `gallery-${s.source}-${it.id}` });
            const on = !!it.installed && current === `custom:${it.installed}`;
            const update = !!it.installed && it.installedVersion !== it.version;
            const key = `${s.source}:${it.id}`;
            return (
              <div key={key} className={clsx('relative p-2 rounded-lg border bg-[var(--bg-tertiary)] transition',
                on ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]/40' : 'border-[var(--border-subtle)]')}>
                <Thumb t={info} mode={it.mode} />
                <div className="mt-2 flex items-center gap-1.5 text-[13px] font-medium">
                  <span className="truncate">{it.name}</span>
                  {on && <Check className="w-3.5 h-3.5 shrink-0 text-[var(--accent-soft)]" />}
                  <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--text-muted)]">{it.mode === 'light' ? tx('light only') : tx('dark only')}</span>
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)] line-clamp-3">{it.blurb}</div>
                <div className="mt-2 flex items-center gap-2">
                  <Credit it={it} />
                  <div className="ml-auto flex gap-1.5">
                    {it.installed && !update && (
                      <button className={btn.subtle} disabled={on} onClick={() => apply(`custom:${it.installed}`)}>
                        {on ? <><Check className="w-3.5 h-3.5" />{tx('Applied')}</> : tx('Apply')}
                      </button>
                    )}
                    {(!it.installed || update) && (
                      <button className={btn.primary} disabled={busy === key} onClick={() => install(s.source, it)}>
                        <Download className="w-3.5 h-3.5" />{update ? tx('Update') : tx('Install')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Settings → Appearance → Screensaver style → Browse community: previews with an Install button; installing makes a
 *  Screensaver project and selects it. `onInstalled` lets the picker list the new project at once. */
export function CommunitySavers({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (pid: string, name: string) => void }) {
  const { data, loading, error, load } = useListing<GallerySaver>('screensaver', open);
  const amb = useAmbience();
  const [busy, setBusy] = useState('');
  const use = (pid: string) => saveAmbience({ saverStyle: `studio:${pid}`, saverMinutes: loadAmbience().saverMinutes || 10 });
  const install = async (source: string, it: GallerySaver) => {
    setBusy(`${source}:${it.id}`);
    try {
      const res = await req<{ project: { id: string; name: string } }>('/api/gallery/install', { method: 'POST', body: JSON.stringify({ kind: 'screensaver', source, id: it.id }) });
      onInstalled(res.project.id, res.project.name);
      use(res.project.id);
      toast(tx('{name} is your screensaver now. Its code is in the Studio.', { name: it.name }));
      load();
    } catch (e) { installError(e); } finally { setBusy(''); }
  };
  return (
    <Modal open={open} onClose={onClose} title={tx('Community screensavers')} icon={<Globe className="w-4 h-4" />} wide>
      <div className="p-4">
        <Header title={tx('Shared on GitHub')} hint={tx('Each one runs in a sandboxed frame: scripts only, no network, no sound')} data={data} loading={loading} onRefresh={() => load(true)} />
        <Notes data={data} error={error} loading={loading} empty={tx('No screensavers published yet. Make one in the Studio and open a pull request.')} />
        {data?.sources.map(s => s.items.length > 0 && (
          <div key={s.source} className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {s.items.map(it => {
              const key = `${s.source}:${it.id}`;
              const using = !!it.installed && amb.saverStyle === `studio:${it.installed}`;
              const update = !!it.installed && it.installedVersion !== it.version;
              return (
                <div key={key} className={clsx('rounded-lg border overflow-hidden bg-[var(--bg-tertiary)]', using ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]/40' : 'border-[var(--border-subtle)]')}>
                  <div className="aspect-video bg-black">
                    {it.preview
                      ? <img src={`/api/gallery/screensaver/${encodeURIComponent(s.source)}/${encodeURIComponent(it.id)}/preview`} alt="" loading="lazy" className="w-full h-full object-cover" />
                      : <div className="w-full h-full grid place-items-center text-[var(--text-muted)]"><MonitorPlay className="w-6 h-6" /></div>}
                  </div>
                  <div className="p-2.5">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <span className="truncate">{it.name}</span>
                      {using && <Check className="w-3.5 h-3.5 shrink-0 text-[var(--accent-soft)]" />}
                      {!it.clockSafe && <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--text-muted)]" title={tx('The clock may sit over part of the picture')}>{tx('full screen')}</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)] line-clamp-3">{it.blurb}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <Credit it={it} />
                      <div className="ml-auto flex gap-1.5">
                        {it.installed && (
                          <button className={btn.icon} title={tx('Preview')} aria-label={tx('Preview')}
                            onClick={() => { onClose(); window.dispatchEvent(new CustomEvent(PREVIEW_SAVER, { detail: `studio:${it.installed}` })); }}>
                            <MonitorPlay className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {it.installed && !update && (
                          <button className={btn.subtle} disabled={using} onClick={() => use(it.installed!)}>
                            {using ? <><Check className="w-3.5 h-3.5" />{tx('In use')}</> : <><MonitorCheck className="w-3.5 h-3.5" />{tx('Use')}</>}
                          </button>
                        )}
                        {(!it.installed || update) && (
                          <button className={btn.primary} disabled={busy === key} onClick={() => install(s.source, it)}>
                            <Download className="w-3.5 h-3.5" />{update ? tx('Update') : tx('Install')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Studio → New project → Start from a template: community templates as cards; picking one creates the project
 *  (of the template's kind, with its files and brief) and hands the id back. Templates of the selected kind come first. */
export function TemplatePicker({ kind, name, onCreated }: { kind: string; name: string; onCreated: (pid: string) => void }) {
  const { data, loading, error, load } = useListing<GalleryTemplate>('template');
  const [busy, setBusy] = useState('');
  const all = (data?.sources ?? []).flatMap(s => s.items.map(it => ({ source: s.source, it })));
  const sorted = [...all].sort((a, b) => Number(b.it.kind === kind) - Number(a.it.kind === kind));
  const start = async (source: string, it: GalleryTemplate) => {
    setBusy(`${source}:${it.id}`);
    try {
      const res = await req<{ project: { id: string } }>('/api/gallery/install', { method: 'POST', body: JSON.stringify({ kind: 'template', source, id: it.id, name }) });
      onCreated(res.project.id);
    } catch (e) { installError(e); setBusy(''); }
  };
  if (!data && !loading && !error) return null;
  return (
    <div>
      <Header title={tx('Start from a template')} hint={tx('Shared on GitHub; a copy of its files becomes your project')} data={data} loading={loading} onRefresh={() => load(true)} />
      <Notes data={data} error={error} loading={loading} empty={tx('No templates published yet.')} />
      {sorted.length > 0 && (
        <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sorted.map(({ source, it }) => {
            const key = `${source}:${it.id}`, match = it.kind === kind;
            return (
              <button key={key} type="button" disabled={busy !== ''} onClick={() => start(source, it)} title={it.blurb}
                className={clsx('text-left rounded-lg border overflow-hidden bg-[var(--bg-tertiary)] transition hover:border-[var(--border-strong)] disabled:opacity-60',
                  match ? 'border-[var(--border-subtle)]' : 'border-[var(--border-subtle)] opacity-70 hover:opacity-100')}>
                <div className="aspect-[16/10] bg-[var(--bg-primary)]">
                  {it.preview
                    ? <img src={`/api/gallery/template/${encodeURIComponent(source)}/${encodeURIComponent(it.id)}/preview`} alt="" loading="lazy" className="w-full h-full object-cover object-top" />
                    : <div className="w-full h-full grid place-items-center text-[var(--text-muted)]"><Download className="w-5 h-5" /></div>}
                </div>
                <div className="p-2">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium">
                    <span className="truncate">{it.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--text-muted)]">{it.kind}</span>
                  </div>
                  <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-secondary)] line-clamp-2">{it.blurb}</div>
                  <div className="mt-1 flex items-center gap-1"><Credit it={it} />{busy === key && <span className="ml-auto text-[10px] text-[var(--text-muted)]">{tx('Creating…')}</span>}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
