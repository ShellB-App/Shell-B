import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowLeft, Compass, Download, ExternalLink, FileCode, Loader2, Package, Plus, RefreshCw, Search, Server, Sparkles, Trash2, WifiOff,
} from 'lucide-react';
import type { CommunityDetails, CommunityItem, CommunityOption, CommunitySource } from '../types';
import { req } from '../api';
import { btn, relTime } from './common';
import { t as tx } from '../i18n';

const KIND_LABEL: Record<CommunityItem['kind'], string> = { mcp: 'MCP server', skill: 'Skill', plugin: 'Plugin' };
const KIND_ICON = { mcp: Server, skill: Sparkles, plugin: Package } as const;
const post = <T,>(path: string, body: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body) });
const errText = (e: unknown) => String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e).replace(/^Error: \d+: /, '');

/** Discover (Tools & Connectors → Discover): browse MCP servers from the official MCP Registry and Agent Skills from
 *  GitHub (Anthropic's skills, Claude plugin marketplaces, any repo you add), and install them switched off for review.
 *  Everything here is community content: the detail view shows exactly what will run or be read before you install. */
export function Discover({ locked, onInstalled }: { locked: boolean; onInstalled: () => void }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'mcp' | 'skill' | 'plugin'>('all');
  const [source, setSource] = useState('');
  const [items, setItems] = useState<CommunityItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [sources, setSources] = useState<CommunitySource[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const seq = useRef(0);

  const loadSources = useCallback(() => req<CommunitySource[]>('/api/community/sources').then(setSources).catch(() => {}), []);
  const search = useCallback(async (more?: string) => {
    const n = ++seq.current;
    if (!more) setItems(null);
    setError('');
    try {
      const params = new URLSearchParams({ q, kind, source, ...(more ? { cursor: more } : {}) });
      const r = await req<{ items: CommunityItem[]; nextCursor: string | null; stale: boolean }>(`/api/community/search?${params}`);
      if (n !== seq.current) return;
      setItems(prev => (more ? [...(prev ?? []), ...r.items] : r.items));
      setCursor(r.nextCursor);
      setStale(r.stale);
      loadSources();
    } catch (e) {
      if (n === seq.current) { setError(errText(e)); setItems([]); }
    }
  }, [q, kind, source, loadSources]);

  useEffect(() => { const t = setTimeout(() => search(), 300); return () => clearTimeout(t); }, [search]);

  if (open) return <Detail id={open} locked={locked} onBack={() => { setOpen(null); search(); }} onInstalled={onInstalled} onOpen={setOpen} />;
  if (manage) return <Sources sources={sources} locked={locked} onBack={() => { setManage(false); search(); }} onChanged={loadSources} />;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2"><Compass className="w-4 h-4 text-[var(--text-muted)]" />{tx('Discover')}</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-[70ch]">
          {tx('MCP servers and skills other people published. They\'re unverified: read what an item does before installing. Installs arrive switched off, and package servers run in an isolated container, not on this machine.')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex-1 min-w-[12rem] flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] focus-within:border-[var(--accent)]">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tx('Search: pdf, github, calendar, postgres…')} aria-label={tx('Search community tools')}
            className="flex-1 bg-transparent text-sm outline-none" />
        </label>
        <select value={source} onChange={e => setSource(e.target.value)} aria-label={tx('Source')}
          className="px-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-xs">
          <option value="">{tx('All sources')}</option>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className={btn.ghost} onClick={() => setManage(true)}><Plus className="w-3.5 h-3.5" />{tx('Sources')}</button>
      </div>
      <div role="tablist" className="flex gap-1.5">
        {(['all', 'mcp', 'skill', 'plugin'] as const).map(k => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={clsx('px-2.5 py-1 rounded-lg text-xs border transition',
              kind === k ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]/60 font-medium'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
            {k === 'all' ? tx('Everything') : `${KIND_LABEL[k]}s`}
          </button>
        ))}
      </div>
      {stale && (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400"><WifiOff className="w-3.5 h-3.5" />
          {tx('Couldn\'t reach the registry; showing what was saved last time.')}</div>
      )}
      {error && <div className="text-xs text-red-500 dark:text-red-400">{error}</div>}
      {items === null ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />{tx('Searching (the first visit also indexes the skill sources)…')}
        </div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-sm text-[var(--text-muted)]">{tx('Nothing matches. Try a broader word, or add a source.')}</div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
          {items.map(i => {
            const Icon = KIND_ICON[i.kind];
            return (
              <li key={i.id}>
                <button onClick={() => setOpen(i.id)} className="w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] outline-none">
                  <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium">{i.title || i.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{KIND_LABEL[i.kind]}</span>
                      {i.publisher === 'Anthropic' && <span className="text-[10px] px-1.5 rounded border border-[var(--border-subtle)] text-[var(--text-secondary)]">{tx('Anthropic')}</span>}
                      {i.installed && <span className="text-[10px] px-1.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">{tx('Installed')}{i.installed.enabled === false ? tx(' · off') : ''}</span>}
                    </span>
                    <span className="block text-xs text-[var(--text-secondary)] line-clamp-2 mt-0.5">{i.description || tx('No description.')}</span>
                    <span className="block text-[10px] font-mono text-[var(--text-muted)] mt-0.5 truncate">
                      {i.kind === 'mcp' ? `${i.name} ${i.version ?? ''}` : `${i.repo ?? ''}${i.plugin ? ` · plugin ${i.plugin}` : ''}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && items && <button className={btn.ghost} onClick={() => search(cursor)}>{tx('Show more servers')}</button>}
    </div>
  );
}

function Detail({ id, locked, onBack, onInstalled, onOpen }: {
  id: string; locked: boolean; onBack: () => void; onInstalled: () => void; onOpen: (id: string) => void;
}) {
  const [d, setD] = useState<CommunityDetails | null>(null);
  const [error, setError] = useState('');
  const [opt, setOpt] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    req<CommunityDetails>(`/api/community/item?id=${encodeURIComponent(id)}`)
      .then(x => { setD(x); setOpt(x.options?.[0]?.key ?? ''); }).catch(e => setError(errText(e)));
  }, [id]);
  const option: CommunityOption | undefined = d?.options?.find(o => o.key === opt);

  const install = async () => {
    setBusy(true); setError('');
    try {
      const r = await post<{ kind: string; name: string; missing?: string[] }>('/api/community/install', { id, option: opt, values, name });
      setDone(r.kind === 'skill'
        ? `Installed as the skill “${r.name}”, switched off. Turn it on under Skills when you're ready.`
        : `Installed as the MCP server “${r.name}”, switched off${r.missing?.length ? `; it still needs ${r.missing.join(', ')}` : ''}. Review it under MCP servers, then switch it on.`);
      onInstalled();
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <button className={btn.ghost} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />{tx('Back to results')}</button>
      {error && <div className="text-xs text-red-500 dark:text-red-400">{error}</div>}
      {!d ? (!error && <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" aria-label={tx('Loading')} /></div>) : (<>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{KIND_LABEL[d.kind]}</div>
          <h3 className="text-base font-semibold tracking-tight">{d.title || d.name}</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-[70ch]">{tx(d.description)}</p>
          <div className="flex flex-wrap gap-3 mt-2 text-xs">
            {(d.url || d.repo) && (
              <a className="inline-flex items-center gap-1 text-[var(--accent-soft)] hover:underline" target="_blank" rel="noreferrer"
                href={d.url || (d.repo?.startsWith('http') ? d.repo : `https://github.com/${d.repo}`)}>
                <ExternalLink className="w-3 h-3" />{tx('Source')}{d.sha ? ` @ ${d.sha.slice(0, 7)}` : ''}
              </a>
            )}
            {d.license && <span className="text-[var(--text-muted)]">{tx('License: {license}', { license: d.license })}</span>}
            {d.version && d.kind === 'mcp' && <span className="text-[var(--text-muted)]">{tx('Version {version}', { version: d.version })}</span>}
          </div>
        </div>
        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>{tx('Unverified community')} {d.kind === 'mcp' ? 'software' : 'content'}.
            {d.kind === 'skill' ? tx(' A skill is instructions your agents will follow, so read it all. Its scripts only run in the offline sandbox.')
              : d.kind === 'mcp' ? tx(' It installs switched off; check what it runs before switching it on.') : tx(' Install its skills one by one below.')}
          </span>
        </div>

        {d.kind === 'plugin' && (
          <div className="space-y-2">
            {d.note && <p className="text-xs text-[var(--text-muted)]">{tx(d.note)}</p>}
            {d.mcpServers && d.mcpServers.length > 0 && (
              <p className="text-xs text-[var(--text-muted)]">{tx('Also ships MCP servers ({v0}); add those by hand under Connectors if you want them.', { v0: d.mcpServers.join(', ') })}</p>
            )}
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('Skills in this plugin')}</h4>
            {!d.skills?.length ? <p className="text-sm text-[var(--text-muted)]">{tx('This plugin has no skills.')}</p> : (
              <ul className="space-y-1">
                {d.skills.map(s => (
                  <li key={s.id}>
                    <button onClick={() => onOpen(s.id)} className="w-full text-left px-3 py-2 rounded-lg border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]">
                      <span className="text-sm font-medium">{s.name}</span>{s.installed && <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400">{tx('Installed')}</span>}
                      <span className="block text-xs text-[var(--text-secondary)] line-clamp-2">{tx(s.description)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {d.kind === 'skill' && (<>
          <div className="text-xs text-[var(--text-muted)] flex flex-wrap gap-x-3">
            <span>{d.files?.length ?? 0} files</span>
            {!!d.scripts?.length && <span className="inline-flex items-center gap-1"><FileCode className="w-3 h-3" />{tx('Scripts:')} {d.scripts.slice(0, 6).join(', ')}{d.scripts.length > 6 ? '…' : ''}</span>}
          </div>
          <pre className="p-3 rounded-lg bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-auto">{d.content}</pre>
        </>)}

        {d.kind === 'mcp' && (
          !d.options?.length ? <p className="text-sm text-[var(--text-muted)]">{tx('Shell:B can\'t run this one (no remote endpoint or npm/PyPI/container package).')}</p> : (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{tx('How to run it')}</h4>
              {d.options.map(o => (
                <label key={o.key} className={clsx('flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer',
                  opt === o.key ? 'border-[var(--accent)]/60 bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)]')}>
                  <input type="radio" name="opt" checked={opt === o.key} onChange={() => setOpt(o.key)} className="mt-1" />
                  <span className="min-w-0">
                    <span className="text-sm">{tx(o.label)}</span>
                    <span className="block text-[11px] text-[var(--text-muted)]">{o.local ? tx('Runs in an isolated container here (no capabilities, 1 GB, its own network; it can reach the internet).') : tx('A remote service: your requests to it leave this machine.')}</span>
                    <code className="block mt-1 text-[10px] font-mono text-[var(--text-secondary)] break-all">{o.preview}</code>
                  </span>
                </label>
              ))}
              {option && option.fields.length > 0 && (
                <div className="space-y-2">
                  {option.fields.map(f => (
                    <label key={f.key} className="block text-xs">
                      <span className="font-medium">{tx(f.label)}{f.required ? ' *' : ''}</span>
                      {f.hint && <span className="block text-[var(--text-muted)]">{tx(f.hint)}</span>}
                      <input type={f.kind === 'secret' ? 'password' : 'text'} value={values[f.key] ?? ''} autoComplete="off"
                        onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                        className="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] font-mono text-xs outline-none focus:border-[var(--accent)]" />
                    </label>
                  ))}
                  <p className="text-[11px] text-[var(--text-muted)]">{tx('You can leave keys empty now and fill them in under MCP servers before switching it on.')}</p>
                </div>
              )}
            </div>
          )
        )}

        {d.kind !== 'plugin' && (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <label className="text-xs">
              <span className="block text-[var(--text-muted)] mb-1">{tx('Install as')}</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder={d.name.split('/').pop()}
                className="px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-xs outline-none focus:border-[var(--accent)]" />
            </label>
            <button className={btn.primary} disabled={locked || busy || !!done || (d.kind === 'mcp' && !option)} onClick={install}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {d.installed ? tx('Reinstall') : tx('Install')} {tx('(switched off for review)')}
            </button>
            {locked && <span className="text-xs text-[var(--text-muted)]">{tx('Unlock with the admin key to install.')}</span>}
          </div>
        )}
        {done && <div className="text-sm text-emerald-700 dark:text-emerald-400">{done}</div>}
      </>)}
    </div>
  );
}

function Sources({ sources, locked, onBack, onChanged }: { sources: CommunitySource[]; locked: boolean; onBack: () => void; onChanged: () => void }) {
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await f(); onChanged(); } catch (e) { setError(errText(e)); }
    setBusy('');
  };
  return (
    <div className="space-y-3">
      <button className={btn.ghost} onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" />{tx('Back to results')}</button>
      <h3 className="text-sm font-semibold">{tx('Sources')}</h3>
      <ul className="space-y-1.5">
        {sources.map(s => (
          <li key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-subtle)]">
            <span className="flex-1 min-w-0">
              <span className="text-sm font-medium">{s.name}</span>
              <span className="block text-[11px] text-[var(--text-muted)]">
                {s.kind === 'registry' ? tx('Searched live') : tx('{items} items{v0}', { items: s.items, v0: s.fetched ? ` · fetched ${relTime(s.fetched)}` : ' · not fetched yet' })}{s.repo ? ` · ${s.repo}` : ''}
              </span>
            </span>
            {s.kind !== 'registry' && (
              <button className={btn.icon} title={tx('Fetch again')} aria-label={tx('Fetch {name} again', { name: s.name })} disabled={!!busy}
                onClick={() => act(s.id, () => post(`/api/community/sources/${s.id}/refresh`, {}))}>
                {busy === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
            )}
            {s.custom && (
              <button className={btn.icon} title={tx('Remove source')} aria-label={tx('Remove {name}', { name: s.name })} disabled={locked || !!busy}
                onClick={() => act(`rm-${s.id}`, () => req(`/api/community/sources/${s.id}`, { method: 'DELETE' }))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 items-center">
        <input value={repo} onChange={e => setRepo(e.target.value)} placeholder={tx('owner/repo, owner/repo@branch or owner/repo/folder')}
          aria-label={tx('GitHub repository to add')} className="flex-1 min-w-[16rem] px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-xs font-mono outline-none focus:border-[var(--accent)]" />
        <button className={btn.primary} disabled={locked || !repo.trim() || !!busy}
          onClick={() => act('add', async () => { await post('/api/community/sources', { repo }); setRepo(''); })}>
          {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}{tx('Add GitHub source')}
        </button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] max-w-[70ch]">{tx('A repository of skill folders (each with a SKILL.md) or a Claude plugin marketplace (with .claude-plugin/marketplace.json).')}</p>
      {error && <div className="text-xs text-red-500 dark:text-red-400">{error}</div>}
    </div>
  );
}
