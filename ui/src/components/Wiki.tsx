import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import clsx from 'clsx';
import { AlertTriangle, BookOpen, CornerDownLeft, Dices, ExternalLink, HardDrive, Home, Loader2, Search } from 'lucide-react';
import { req } from '../api';
import { btn } from './common';
import './wiki.css';
import { t as tx } from '../i18n';

interface Source { id: string; project: string; name: string; version: string; articles: number; date: string; mainPath: string | null }
interface Hit { source: string; sourceName: string; path: string; title: string; snippet?: string }
interface Article {
  title: string; html: string; toc: { id: string; title: string; level: number }[]; source: string; sourceName: string; path: string;
  redirectedFrom: string | null; anchor: string | null; snapshot: string; online: string;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const wikiApi = {
  sources: () => req<{ sources: Source[] }>('/api/wiki/sources'),
  suggest: (q: string, source: string) => req<{ items: Hit[] }>(`/api/wiki/suggest?q=${encodeURIComponent(q)}&source=${source}&n=6`),
  search: (q: string, source: string) => req<{ items: Hit[] }>(`/api/wiki/search?q=${encodeURIComponent(q)}&source=${source}&n=15`),
  random: (source: string) => req<{ source: string; path: string }>(`/api/wiki/random?source=${source}`),
  article: (source: string, path: string) => req<Article>(`/api/wiki/article/${source}/${enc(path)}`),
};
export const wikiHref = (source: string, path: string) => `#/wiki/${source}/${enc(path)}`;
const clean = (e: unknown) => String(e).replace(/^Error: \d+: /, '');
let pendingAnchor: string | null = null;  // set by a link to a section of another article, used once it loads

type Route = { kind: 'home' } | { kind: 'search'; q: string } | { kind: 'article'; source: string; path: string };
function parse(rest: string): Route {
  const m = /^\/search\/(.*)$/.exec(rest);
  if (m) return { kind: 'search', q: decodeURIComponent(m[1]) };
  const a = /^\/([\w-]+)\/(.+)$/.exec(rest);
  if (a) return { kind: 'article', source: a[1], path: a[2].split('/').map(decodeURIComponent).join('/') };
  return { kind: 'home' };
}

function SearchBox({ source, initial }: { source: string; initial: string }) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const seq = useRef(0);
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    const n = ++seq.current;
    const t = setTimeout(() => wikiApi.suggest(q.trim(), source).then(r => { if (n === seq.current) { setHits(r.items); setSel(-1); } }).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [q, source]);
  const go = (h?: Hit) => {
    setOpen(false);
    if (h) location.hash = wikiHref(h.source, h.path);
    else if (q.trim()) location.hash = `#/wiki/search/${encodeURIComponent(q.trim())}`;
  };
  return (
    <div className="relative flex-1 min-w-[200px] max-w-xl">
      <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
      <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, -1)); }
          else if (e.key === 'Enter') go(sel >= 0 ? hits[sel] : undefined);
          else if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={tx('Search the offline wiki')} aria-label={tx('Search the offline wiki')} role="combobox" aria-expanded={open && hits.length > 0}
        className={clsx(btn.input, 'pl-8 py-2')} />
      {open && hits.length > 0 && (
        <ul role="listbox" className="absolute z-20 left-0 right-0 mt-1 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-lg overflow-hidden">
          {hits.map((h, i) => (
            <li key={`${h.source}/${h.path}`} role="option" aria-selected={i === sel}>
              <button onMouseDown={e => e.preventDefault()} onClick={() => go(h)}
                className={clsx('w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm', i === sel ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]')}>
                <span className="truncate flex-1">{tx(h.title)}</span><span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{h.sourceName}</span>
              </button>
            </li>
          ))}
          <li><button onMouseDown={e => e.preventDefault()} onClick={() => go()} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] border-t border-[var(--border-subtle)]">
            <CornerDownLeft className="w-3.5 h-3.5" />{tx('Search every article for “')}{q.trim()}”</button></li>
        </ul>
      )}
    </div>
  );
}

function ArticleView({ source, path }: { source: string; path: string }) {
  const [a, setA] = useState<Article | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setError('');
    wikiApi.article(source, path).then(r => { if (live) setA(r); }).catch(e => { if (live) { setError(clean(e)); setA(null); } });
    return () => { live = false; };
  }, [source, path]);

  useEffect(() => {
    if (!a) return;
    document.title = `${a.title} · ${a.sourceName}`;
    const anchor = pendingAnchor ?? a.anchor;
    pendingAnchor = null;
    const el = anchor ? body.current?.querySelector(`[id="${CSS.escape(anchor)}"]`) : null;
    if (el) el.scrollIntoView({ block: 'start' }); else scroller.current?.scrollTo({ top: 0 });
  }, [a]);

  // which section is on screen, for the contents list
  useEffect(() => {
    const root = scroller.current;
    if (!a || !root) return;
    const heads = a.toc.map(t => body.current?.querySelector(`[id="${CSS.escape(t.id)}"]`)).filter(Boolean) as Element[];
    const io = new IntersectionObserver(es => {
      const top = es.filter(e => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { root, rootMargin: '0px 0px -70% 0px' });
    heads.forEach(h => io.observe(h));
    return () => io.disconnect();
  }, [a]);

  const onClick = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a');
    if (!link) return;
    const sec = link.getAttribute('data-sec');
    if (sec) {
      e.preventDefault();
      body.current?.querySelector(`[id="${CSS.escape(sec)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (link.getAttribute('data-frag')) {
      pendingAnchor = link.getAttribute('data-frag');
    }
  };
  const jump = (id: string) => body.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (error) return <div className="max-w-[65ch] mx-auto px-4 py-16 text-sm"><AlertTriangle className="w-5 h-5 text-amber-500 mb-3" /><p className="font-medium mb-1">{tx('This article couldn\'t be opened.')}</p><p className="text-[var(--text-secondary)]">{error}</p></div>;
  if (!a) return (
    <div className="max-w-[68ch] mx-auto px-4 py-10 space-y-4" aria-busy="true">
      <div className="h-9 w-2/3 rounded bg-[var(--bg-secondary)] animate-pulse" />
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-4 rounded bg-[var(--bg-secondary)] animate-pulse" style={{ width: `${92 - i * 7}%` }} />)}
    </div>
  );
  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 lg:px-8 py-8 flex gap-10">
        {a.toc.length > 2 && (
          <nav aria-label={tx('Contents')} className="hidden lg:block w-56 shrink-0 sticky top-6 self-start max-h-[calc(100vh-8rem)] overflow-y-auto text-[13px]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">{tx('Contents')}</div>
            <button onClick={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })} className="block w-full text-left py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">(Top)</button>
            {a.toc.map(t => (
              <button key={t.id} onClick={() => jump(t.id)}
                className={clsx('block w-full text-left py-0.5 leading-snug border-l-2 transition', t.level === 3 ? 'pl-5' : 'pl-2',
                  active === t.id ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>{tx(t.title)}</button>
            ))}
          </nav>
        )}
        <article className="min-w-0 flex-1 max-w-[70ch]">
          <header className="mb-6 pb-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">
              <span>{a.sourceName}</span><span aria-hidden>·</span><span title={tx('When Kiwix took this snapshot; the live article may have changed since')}>snapshot {a.snapshot}</span>
              <a href={a.online} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal hover:text-[var(--text-primary)]" title={tx('Needs the internet')}>{tx('Live version')}<ExternalLink className="w-3 h-3" /></a>
            </div>
            <h1 className="sb-wiki-title text-[2.25rem] leading-[1.15] tracking-tight">{a.title.replace(/_/g, ' ')}</h1>
            {a.redirectedFrom && <p className="text-xs text-[var(--text-muted)] mt-1">{tx('Redirected from {v0}', { v0: a.redirectedFrom.replace(/_/g, ' ') })}</p>}
          </header>
          <div ref={body} className="sb-wiki" onClick={onClick} dangerouslySetInnerHTML={{ __html: a.html }} />
        </article>
      </div>
    </div>
  );
}

function Results({ q, source }: { q: string; source: string }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setHits(null); setError('');
    wikiApi.search(q, source).then(r => setHits(r.items)).catch(e => setError(clean(e)));
  }, [q, source]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[70ch] mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold tracking-tight mb-1">{tx('Results for “{q}”', { q: q })}</h1>
        <p className="text-xs text-[var(--text-muted)] mb-6">{tx('Full-text search of the offline archives, best match first.')}</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!hits && !error && <div className="space-y-5">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-1.5"><div className="h-4 w-1/3 rounded bg-[var(--bg-secondary)] animate-pulse" /><div className="h-3 w-full rounded bg-[var(--bg-secondary)] animate-pulse" /></div>)}</div>}
        {hits?.length === 0 && <p className="text-sm text-[var(--text-secondary)]">{tx('Nothing matches. Try fewer words, or a different spelling.')}</p>}
        <ol className="space-y-5">
          {hits?.map(h => (
            <li key={`${h.source}/${h.path}`}>
              <a href={wikiHref(h.source, h.path)} className="group block focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] rounded">
                <div className="flex items-baseline gap-2"><span className="sb-wiki-title text-lg group-hover:text-[var(--accent)] transition">{tx(h.title)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{h.sourceName}</span></div>
                {h.snippet && <p className="text-sm text-[var(--text-secondary)] leading-relaxed mt-0.5">{h.snippet}</p>}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function HomeView({ sources }: { sources: Source[] }) {
  if (!sources.length) return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[60ch] mx-auto px-4 py-16">
        <BookOpen className="w-8 h-8 text-sky-400 mb-4" />
        <h1 className="sb-wiki-title text-3xl tracking-tight mb-3">{tx('An encyclopedia that works offline')}</h1>
        <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed mb-2">{tx('Download Wikipedia (about 49 GB as text only), Wiktionary or Wikivoyage, and read them here with no internet. Every agent also gets a')} <code className="text-[13px]">wiki</code> {tx('tool, so local models can look facts up instead of guessing.')}</p>
        <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed mb-6">{tx('Archives come from Kiwix, which republishes them every one to three months. Shell:B can check for new versions weekly or monthly.')}</p>
        <a href="#/data" className={btn.primary}><HardDrive className="w-3.5 h-3.5" />{tx('Choose what to download')}</a>
      </div>
    </div>
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-12">
        <h1 className="sb-wiki-title text-4xl tracking-tight mb-2">{tx('Wiki')}</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-8 max-w-[60ch]">{tx('Offline snapshots, searchable above. Agents read the same archives through the wiki tool.')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {sources.map(s => (
            <div key={s.id} className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="flex items-baseline gap-2 mb-1"><span className="sb-wiki-title text-xl">{s.name}</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{s.date || s.version}</span></div>
              <p className="text-xs text-[var(--text-secondary)] mb-3">{tx('{n} articles', { n: s.articles.toLocaleString() })}</p>
              <div className="flex gap-1">
                {s.mainPath && <a className={btn.subtle} href={wikiHref(s.id, s.mainPath)}><Home className="w-3.5 h-3.5" />{tx('Main page')}</a>}
                <button className={btn.ghost} onClick={() => wikiApi.random(s.id).then(r => { location.hash = wikiHref(r.source, r.path); })}><Dices className="w-3.5 h-3.5" />{tx('Random article')}</button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[var(--text-muted)] mt-6"><a href="#/data" className="underline hover:text-[var(--text-primary)]">{tx('Offline data')}</a> {tx('has sizes, versions and the update schedule.')}</p>
      </div>
    </div>
  );
}

/** #/wiki, #/wiki/search/<q>, #/wiki/<source>/<path>: a reader for the offline Kiwix archives (server/wiki.py). */
export function Wiki({ route }: { route: string }) {
  const r = useMemo(() => parse(route), [route]);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { wikiApi.sources().then(s => setSources(s.sources)).catch(e => setError(clean(e))); }, []);
  useEffect(() => () => { document.title = 'Shell:B'; }, []);
  const current = r.kind === 'article' ? r.source : '';
  const random = useCallback(() => wikiApi.random(current).then(x => { location.hash = wikiHref(x.source, x.path); }).catch(() => {}), [current]);

  return (
    <div className="h-full flex flex-col">
      {sources && sources.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border-subtle)]">
          <a href="#/wiki" className={btn.icon} title={tx('Wiki home')} aria-label={tx('Wiki home')}><BookOpen className="w-4 h-4" /></a>
          <SearchBox source="" initial={r.kind === 'search' ? r.q : ''} />
          <button className={btn.ghost} onClick={random} title={tx('Open a random article')}><Dices className="w-3.5 h-3.5" /><span className="hidden sm:inline">{tx('Random')}</span></button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {error ? <p className="p-8 text-sm text-red-400">{error}</p>
          : !sources ? <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
          : r.kind === 'article' ? <ArticleView source={r.source} path={r.path} />
          : r.kind === 'search' ? <Results q={r.q} source="" />
          : <HomeView sources={sources} />}
      </div>
    </div>
  );
}
