import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AppWindow, Boxes, CodeXml, ExternalLink, FileCode2, FileText, GitFork, Image as ImageIcon, LayoutGrid, Loader2, MessageSquare, Palette, RotateCw, Search, Star,
} from 'lucide-react';
import type { Agent, ArtifactVersion, Library as LibraryData, LibraryArtifact, ProjectSummary } from '../types';
import { api, frameRawUrl, rawUrl } from '../api';
import { artifactScope, srcDoc } from './ArtifactPanel';
import { Markdown } from './Markdown';
import { AgentAvatar, btn, relTime } from './common';
import { FavoriteStar } from './Favorites';
import { MediaGallery } from './Media';
import { useFavorites } from '../favorites';
import { artifactMenu, artifactViewUrl } from './artifactMenu';
import { openContextMenu } from './ContextMenu';
import { workspaceMenu } from './projectMenu';
import { t } from '../i18n';

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock';
const TYPE_LABEL: Record<string, string> = { html: 'HTML', svg: 'SVG', markdown: 'Markdown', mermaid: 'Diagram', code: 'Code' };
const KIND_LABEL: Record<string, string> = { website: 'Website', deck: 'Deck', print: 'Print', mobile: 'Mobile', dashboard: 'Dashboard', blank: 'Canvas', code: 'Code workspace' };
const TYPE_ICON: Record<string, typeof Boxes> = { html: AppWindow, svg: ImageIcon, markdown: FileText, mermaid: GitFork, code: FileCode2 };

export { artifactViewUrl } from './artifactMenu';

type Item =
  | { kind: 'artifact'; key: string; ts: number; a: LibraryArtifact }
  | { kind: 'app'; key: string; ts: number; p: ProjectSummary };

/** Renders its children only once scrolled near the viewport, so a big library doesn't boot every iframe at once. */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** A live page shrunk into a card: lays the iframe out at desktop width and scales it to fit. */
function ScaledFrame({ title, src, doc }: { title: string; src?: string; doc?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="absolute inset-0 overflow-hidden">
      <iframe title={title} src={src} srcDoc={doc} sandbox={SANDBOX} tabIndex={-1} loading="lazy"
        className="border-0 bg-white origin-top-left pointer-events-none" style={{ width: 1280, height: 800, transform: `scale(${scale})` }} />
    </div>
  );
}

function ArtifactThumb({ a, dark }: { a: LibraryArtifact; dark: boolean }) {
  const [ref, seen] = useNearViewport<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {!seen ? null : a.type === 'markdown' ? (
        <div className="absolute inset-0 overflow-hidden p-3 text-[10px] leading-snug text-[var(--text-secondary)] [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]">
          <div className="origin-top-left scale-[0.8] w-[125%]"><Markdown text={a.content.slice(0, 1500)} /></div>
        </div>
      ) : a.type === 'code' ? (
        <pre className="absolute inset-0 overflow-hidden p-3 text-[9.5px] leading-snug font-mono text-[var(--text-secondary)] bg-[var(--bg-code)] [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]">
          {a.content.split('\n').slice(0, 24).join('\n')}
        </pre>
      ) : (
        <ScaledFrame title={t(a.title)} doc={srcDoc(a.type, a.content, dark, artifactScope(a.convId, a.id), true, a.convId)} />
      )}
    </div>
  );
}

function AppThumb({ p }: { p: ProjectSummary }) {
  const [ref, seen] = useNearViewport<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {p.cover ? <img src={p.cover} alt="" className="absolute inset-0 w-full h-full object-cover object-top" loading="lazy" />
        : seen && <ScaledFrame title={p.name} src={`${frameRawUrl(p.id, p.entry)}?__ro=1`} />}
    </div>
  );
}

interface Props {
  agents: Agent[];
  dark: boolean;
  onOpenArtifact: (convId: string, artifactId: string) => void;
  initial?: 'all' | 'media';
}

export function Library({ agents, dark, onOpenArtifact, initial = 'all' }: Props) {
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [show, setShowRaw] = useState<'all' | 'artifacts' | 'apps' | 'media'>(initial);
  useEffect(() => { setShowRaw(initial); }, [initial]);
  const setShow = (v: typeof show) => {  // Media has its own address, so it can be linked and reopened
    setShowRaw(v);
    history.replaceState(null, '', v === 'media' ? '#/library/media' : '#/library');
  };
  const [type, setType] = useState<string>('');
  const favCount = useFavorites().length;

  const load = () => { setError(''); api.library().then(setData).catch(e => setError(String(e))); };
  useEffect(load, []);

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const arts: Item[] = data.artifacts
      .filter(a => !type || a.type === type)
      .filter(a => !needle || `${a.title} ${a.convTitle} ${a.type} ${a.language}`.toLowerCase().includes(needle))
      .map(a => ({ kind: 'artifact', key: `a:${a.convId}:${a.id}`, ts: a.timestamp ?? a.createdAt, a }));
    const apps: Item[] = data.apps
      .filter(p => !type || p.kind === type)
      .filter(p => !needle || `${p.name} ${p.description} ${p.kind}`.toLowerCase().includes(needle))
      .map(p => ({ kind: 'app', key: `p:${p.id}`, ts: p.updatedAt, p }));
    return [...(show === 'apps' ? [] : arts), ...(show === 'artifacts' ? [] : apps)].sort((x, y) => y.ts - x.ts);
  }, [data, q, show, type]);

  // type chips follow what's actually in the library for the current view
  const chips = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, string>();
    if (show !== 'apps') data.artifacts.forEach(a => seen.set(a.type, TYPE_LABEL[a.type] ?? a.type));
    if (show !== 'artifacts') data.apps.forEach(p => seen.set(p.kind, KIND_LABEL[p.kind] ?? p.kind));
    return [...seen.entries()];
  }, [data, show]);
  useEffect(() => { if (type && !chips.some(([k]) => k === type)) setType(''); }, [chips, type]);

  const tab = (id: typeof show, label: string, n?: number) => (
    <button onClick={() => setShow(id)}
      className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition',
        show === id ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
      {label}{n !== undefined && <span className="font-mono text-[10px] opacity-70">{n}</span>}
    </button>
  );

  const card = (it: Item) => {
    if (it.kind === 'artifact') {
      const a = it.a;
      const agent = agents.find(x => x.id === a.agentId);
      const Icon = TYPE_ICON[a.type] ?? Boxes;
      return (
        <div key={it.key} className="group rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] transition overflow-hidden flex flex-col"
          onContextMenu={e => openContextMenu(e, artifactMenu({ ...a, content: a, onOpen: () => onOpenArtifact(a.convId, a.id), openLabel: 'Open in its chat' }), { own: true })}>
          <button onClick={() => onOpenArtifact(a.convId, a.id)} className="relative aspect-[16/10] bg-[var(--bg-tertiary)] border-b border-[var(--border-subtle)] overflow-hidden text-left" title={t('Open in its chat')}>
            <ArtifactThumb a={a} dark={dark} />
            <span className="absolute inset-0 group-hover:bg-black/5 transition" />
          </button>
          <div className="p-3 flex-1 flex flex-col gap-1.5 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <button onClick={() => onOpenArtifact(a.convId, a.id)} className="text-sm font-medium truncate flex-1 text-left hover:text-[var(--accent-soft)]">{t(a.title)}</button>
              <FavoriteStar kind="artifact" id={a.convId} sub={a.id} title={t(a.title)} />
              <a href={artifactViewUrl(a.convId, a.id)} target="_blank" rel="noopener" className={clsx(btn.icon, 'p-1 shrink-0')} title={t('Open full page in a new tab')}>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] min-w-0">
              <AgentAvatar agent={agent} size={14} />
              <span className="truncate flex-1" title={a.convTitle}><MessageSquare className="w-3 h-3 inline -mt-0.5 mr-1" />{a.convTitle}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--text-muted)]">
              <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">{TYPE_LABEL[a.type] ?? a.type}{a.type === 'code' && a.language ? ` · ${a.language}` : ''}</span>
              <span>v{a.version}</span>
              <span className="ml-auto">{relTime(it.ts)}</span>
            </div>
          </div>
        </div>
      );
    }
    const p = it.p;
    const isCode = p.kind === 'code';
    return (
      <div key={it.key} className="group rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] transition overflow-hidden flex flex-col"
        onContextMenu={e => openContextMenu(e, workspaceMenu(p, { onOpen: () => { location.hash = isCode ? `#/code/${p.id}` : `#/studio/${p.id}`; }, reload: load }), { own: true })}>
        <a href={rawUrl(p.id, p.entry)} target="_blank" rel="noopener" className="relative block aspect-[16/10] bg-[var(--bg-tertiary)] border-b border-[var(--border-subtle)] overflow-hidden" title={t('Launch in a new tab')}>
          <AppThumb p={p} />
          <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-black/60 text-white backdrop-blur">{t('Web app')}</span>
        </a>
        <div className="p-3 flex-1 flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {isCode ? <CodeXml className="w-3.5 h-3.5 text-sky-400 shrink-0" /> : <Palette className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
            <a href={rawUrl(p.id, p.entry)} target="_blank" rel="noopener" className="text-sm font-medium truncate flex-1 hover:text-[var(--accent-soft)]">{p.name}</a>
            <FavoriteStar kind="project" id={p.id} title={p.name} />
            <a href={rawUrl(p.id, p.entry)} target="_blank" rel="noopener" className={clsx(btn.icon, 'p-1 shrink-0')} title={t('Launch in a new tab')}>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
          <div className="text-[11px] text-[var(--text-muted)] truncate">{p.description || t('{fileCount} file{v0} · {entry}', { fileCount: p.fileCount, v0: p.fileCount === 1 ? '' : 's', entry: p.entry })}</div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--text-muted)]">
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">{KIND_LABEL[p.kind] ?? p.kind}</span>
            <a href={isCode ? `#/code/${p.id}` : `#/studio/${p.id}`} className="hover:text-[var(--accent-soft)] font-sans">{t('Edit in')} {isCode ? t('Code') : t('Studio')}</a>
            <span className="ml-auto">{relTime(it.ts)}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-8 animate-fade-in">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-semibold tracking-tight flex-1">{t('Library')}</h1>
          <a href="#/library/favorites" className={clsx(btn.icon, 'flex items-center gap-1.5 text-xs')} title={t('Everything you\'ve starred')}>
            <Star className="w-4 h-4 text-amber-400" />{t('Favorites')}{favCount > 0 && <span className="font-mono text-[10px] opacity-70">{favCount}</span>}
          </a>
          <button className={btn.icon} onClick={load} title={t('Refresh')}><RotateCw className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-5">{show === 'media' ? t('Every picture, song, sound effect, voice clip and 3D model Shell:B has generated, wherever it was saved.')
          : t('Every artifact from your chats and every web app built in Studio or Code, newest first.')}</p>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center bg-[var(--bg-tertiary)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
            {tab('all', t('All'), data ? data.artifacts.length + data.apps.length : undefined)}
            {tab('artifacts', t('Artifacts'), data?.artifacts.length)}
            {tab('apps', t('Web apps'), data?.apps.length)}
            {tab('media', t('Media'))}
          </div>
          {show !== 'media' && <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search by title or chat')} />
          </div>}
        </div>
        {show === 'media' ? <MediaGallery agents={agents} /> : <>
        {chips.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-5">
            {[['', t('Any type')] as [string, string], ...chips].map(([k, label]) => (
              <button key={k || 'any'} onClick={() => setType(k)}
                className={clsx('px-2 py-0.5 rounded-full text-[11px] border transition',
                  type === k ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
                {t(label)}
              </button>
            ))}
          </div>
        )}

        {error ? (
          <div className="text-center py-16 text-sm text-red-400">{error}</div>
        ) : !data ? (
          <div className="flex justify-center py-16 text-[var(--text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-sm text-[var(--text-muted)]">
            <LayoutGrid className="w-8 h-8 mx-auto mb-2" />
            {data.artifacts.length + data.apps.length ? t('Nothing matches.') : t('Nothing built yet. Ask an agent for an HTML artifact, or start a Studio project.')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{items.map(card)}</div>
        )}
        </>}
      </div>
    </div>
  );
}

/** `#/view/<conv>/<artifact>`: one artifact, full window, same sandbox as the side panel. */
export function ArtifactViewer({ convId, artifactId, dark }: { convId: string; artifactId: string; dark: boolean }) {
  const [art, setArt] = useState<ArtifactVersion | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.conversation(convId).then(c => {
      const g = c.artifacts.find(x => x.id === artifactId);
      if (!g) throw new Error('This artifact no longer exists.');
      setArt(g.versions[g.versions.length - 1]);
      document.title = `${g.title} · Shell:B`;
    }).catch(e => setError(String(e.message ?? e)));
  }, [convId, artifactId]);

  if (error) return <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">{error}</div>;
  if (!art) return <div className="h-full flex items-center justify-center text-[var(--text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (art.type === 'markdown') return <div className="h-full overflow-y-auto px-6 py-8"><div className="max-w-3xl mx-auto"><Markdown text={art.content} /></div></div>;
  if (art.type === 'code') return <pre className="h-full overflow-auto p-4 text-[12.5px] leading-relaxed font-mono bg-[var(--bg-code)]">{art.content}</pre>;
  return <iframe title={t(art.title)} srcDoc={srcDoc(art.type, art.content, dark, artifactScope(convId, artifactId), false, convId)} sandbox={SANDBOX} className="w-full h-full border-0 bg-white" />;
}
