import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowUp, Code, Columns2, Crosshair, ExternalLink, Eye, Laptop, Loader2, Monitor, Play, RotateCw, ScrollText, Server, Smartphone, Square, Tablet, X,
} from 'lucide-react';
import type { ProjectFile, ProjectKind } from '../types';
import { api, frameRawUrl, rawUrl } from '../api';
import { Markdown } from '../components/Markdown';
import { btn } from '../components/common';

const CodeEditor = lazy(() => import('./CodeEditor'));

/** Unsaved editor text, by `<project>:<path>`. It outlives the editor, so switching to Preview or to another file (or
 *  leaving the workspace) keeps the edits until they're saved or thrown away. `version` is the project version the
 *  draft was based on, to spot the agent changing the file meanwhile. */
const drafts = new Map<string, { value: string; saved: string; version: number }>();
const draftKey = (projectId: string, path: string) => `${projectId}:${path}`;
window.addEventListener('beforeunload', e => { if (drafts.size) e.preventDefault(); });

const draftsOf = (projectId: string) =>
  [...drafts].filter(([k]) => k.startsWith(`${projectId}:`)).map(([k, d]) => ({ path: k.slice(projectId.length + 1), value: d.value }));

/** Sends the project's drafts to the server, whose /draft/ route serves them over the saved files (projects.py),
 *  so the preview shows the working version, linked CSS and scripts included. */
const synced = new Set<(projectId: string) => void>();  // previews that reload once the server has the new drafts
function syncDrafts(projectId: string) {
  const files = Object.fromEntries(draftsOf(projectId).map(d => [d.path, d.value]));
  return fetch(`/api/projects/${projectId}/drafts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) })
    .catch(() => undefined)
    .then(() => synced.forEach(f => f(projectId)));
}
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
function syncSoon(projectId: string) {
  clearTimeout(syncTimers.get(projectId));
  syncTimers.set(projectId, setTimeout(() => { syncTimers.delete(projectId); syncDrafts(projectId); }, 400));
}
const toDraft = (url: string) => url.replace('/raw/', '/draft/');

export interface Pick {
  file: string; selector: string; label: string; html: string; text: string;
  rect: { x: number; y: number; w: number; h: number };
}

const ARTBOARD = new Set<ProjectKind>(['mobile', 'deck', 'print', 'social', 'motion', 'game']);

const NATIVE_LABEL: Record<ProjectKind, string> = {
  website: 'Desktop', deck: 'Slide 16:9', print: 'US Letter', mobile: 'Phone', dashboard: 'Desktop', 'design-system': 'Desktop',
  brand: 'Desktop', social: 'Post 4:5', email: 'Email', motion: 'Stage 16:9', screensaver: 'Screen', game: 'Game 16:9', '3d': 'Desktop',
  fullstack: 'Desktop', music: 'Desktop', illustration: 'Desktop', blank: 'Default', code: 'Default',
};

interface DevStatus { configured: boolean; error: string | null; running: boolean; port: number | null; command: string | null;
  preview?: string | null; ticket?: string | null }

interface Props {
  projectId: string;
  kind: ProjectKind;
  file?: ProjectFile;
  /** The project's HTML pages and entry: editing CSS or JS in split view previews a page beside it. */
  pages?: ProjectFile[];
  entry?: string;
  viewport: [number, number];
  version: number;
  dark: boolean;
  onAsk: (text: string, pick?: Pick) => void;
  onSaved: () => void;
  /** Code workspaces: run a shell command in the terminal (the editor's Run button). */
  onRun?: (command: string) => void;
  busy: boolean;
}

/** How the editor's Run button runs a file in the sandbox, by extension; null when it can't. */
export function runCommand(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const tool = ext === 'py' ? 'python' : ext === 'sh' || ext === 'bash' ? 'bash'
    : ['js', 'mjs', 'cjs'].includes(ext) ? 'node' : ['ts', 'mts', 'cts'].includes(ext) ? 'tsx' : null;
  return tool && `${tool} '${path.replace(/'/g, `'\\''`)}'`;
}

export function Canvas({ projectId, kind, file, pages, entry, viewport, version, dark, onAsk, onSaved, onRun, busy }: Props) {
  const [mode, setMode] = useState<'preview' | 'code' | 'split'>('preview');
  // split view: the editor's share of the width, dragged on the divider and remembered
  const [splitPct, setSplitPct] = useState(() => { try { return Number(localStorage.getItem('shellb.splitPct')) || 50; } catch { return 50; } });
  const [dragging, setDragging] = useState(false);
  const splitBox = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState<'native' | 'desktop' | 'tablet' | 'mobile'>('native');
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [inspect, setInspect] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [ask, setAsk] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [reloadKey, setReloadKey] = useState(0);
  const [draftRev, setDraftRev] = useState(0);  // bumped once the server has the latest drafts, to reload the preview
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);

  // live dev server (server/devserver.py): the app runs on its own port, so it gets its own browser origin
  const [dev, setDev] = useState<DevStatus | null>(null);
  const [live, setLive] = useState(true);
  const [livePath, setLivePath] = useState('/');
  const [devBusy, setDevBusy] = useState(false);
  const [devLogs, setDevLogs] = useState<string | null>(null);
  const configured = !!dev?.configured;
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/projects/${projectId}/dev`).then(r => (r.ok ? r.json() : null)).then(d => { if (!stop) setDev(d); }).catch(() => {});
    load();
    const t = configured ? setInterval(load, 5000) : undefined;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [projectId, version, configured]);
  const devAction = async (action: 'start' | 'stop' | 'restart') => {
    setDevBusy(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const d = await r.json();
      if (r.ok) { setDev(d); if (d.logs && !d.httpStatus) setDevLogs(d.logs); if (action !== 'stop') setLive(true); }
      else setDevLogs(String(d.detail ?? 'Failed'));
    } finally { setDevBusy(false); }
  };
  const showDevLogs = async () => {
    const r = await fetch(`/api/projects/${projectId}/dev/logs`);
    setDevLogs(r.ok ? ((await r.json()).logs || '(no output yet)') : 'Could not read the logs.');
  };
  const showLive = live && !!dev?.running && !!dev.port && (!file || file.kind === 'html');
  // a preview host of its own when the server has one (setting previewHost: https://previewN.<host>, signed in with the
  // ticket); otherwise this host's port, which over HTTPS (tailscale serve) is published as https on 84xx for 82xx
  const livePort = dev?.port ? (window.location.protocol === 'https:' ? dev.port + 200 : dev.port) : 0;
  const liveBase = dev?.preview || (livePort ? `${window.location.protocol}//${window.location.hostname}:${livePort}` : '');
  const liveUrl = `${liveBase}${livePath.startsWith('/') ? livePath : `/${livePath}`}`;
  const ticketed = (u: string) => dev?.preview && dev.ticket ? `${u}${u.includes('?') ? '&' : '?'}__pt=${dev.ticket}` : u;

  // a stylesheet or script has no preview of its own; in split view it previews the last page you looked at
  const lastPage = useRef<string | undefined>(undefined);
  if (file?.kind === 'html') lastPage.current = file.path;
  const companion = file?.kind === 'text'
    ? pages?.find(p => p.path === lastPage.current) ?? pages?.find(p => p.path === entry) ?? pages?.[0] : undefined;
  const view = mode === 'split' && companion ? companion : file;  // what the preview pane shows
  const isHtml = view?.kind === 'html' || showLive;
  const editable = file && ['html', 'svg', 'text', 'markdown'].includes(file.kind);

  useEffect(() => {
    setPick(null); setErrors([]); scrollY.current = 0;
    if (file?.kind === 'text') setMode(m => (m === 'split' && companion ? 'split' : 'code'));
    else if (!editable) setMode('preview');
  }, [file?.path]);
  useEffect(() => { setErrors([]); }, [version]);
  // the preview follows the drafts: reload whenever they reach the server (as you type, in split view)
  useEffect(() => {
    if (mode === 'code') return;
    const on = (pid: string) => { if (pid === projectId) setDraftRev(r => r + 1); };
    synced.add(on);
    return () => { synced.delete(on); };
  }, [mode, projectId]);
  useEffect(() => { if (mode !== 'code' && draftsOf(projectId).length) syncDrafts(projectId); }, [mode, projectId, view?.path]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, view?.kind]);

  const size: [number, number] = device === 'desktop' ? [1440, 900] : device === 'tablet' ? [834, 1112] : device === 'mobile' ? [390, 844] : viewport;
  // fixed-size artboards keep their aspect and fit whole; pages scroll inside the frame
  const fixedHeight = device === 'mobile' || (device === 'native' && ARTBOARD.has(kind));
  const pad = 32;
  const scale = zoom === 'fit' ? Math.min(1, (box.w - pad * 2) / size[0], fixedHeight ? (box.h - pad * 2) / size[1] : 1) : zoom;
  const frameH = fixedHeight ? size[1] : Math.max(size[1] * 0.5, (box.h - pad * 2) / scale);
  const frameLeft = Math.max(pad, (box.w - size[0] * scale) / 2);

  const post = useCallback((msg: object) => frame.current?.contentWindow?.postMessage({ target: 'shellb-preview', ...msg }, '*'), []);

  useEffect(() => { post({ type: 'inspect', on: inspect }); if (!inspect) { setPick(null); post({ type: 'clear' }); } }, [inspect, post]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.source !== 'shellb-preview' || e.source !== frame.current?.contentWindow) return;
      if (d.type === 'ready') { post({ type: 'inspect', on: inspect }); if (scrollY.current) post({ type: 'scroll', y: scrollY.current }); }
      if (d.type === 'scroll') scrollY.current = d.y;
      if (d.type === 'picked' && view) { setPick({ ...d, file: showLive ? `${livePath} (live server page)` : view.path }); setAsk(''); }
      if (d.type === 'escape') setPick(null);
      if (d.type === 'error') setErrors(prev => (prev.includes(d.message) ? prev : [...prev, `${d.message}${d.line ? ` (line ${d.line})` : ''}`].slice(-8)));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [inspect, post, file, showLive, livePath]);

  const submitAsk = () => {
    if (!ask.trim() || !pick) return;
    onAsk(ask.trim(), pick);
    setPick(null);
    setAsk('');
    post({ type: 'clear' });
  };

  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center text-center p-8 bg-[var(--bg-primary)]">
        <div className="max-w-sm">
          <div className="text-sm font-medium">Nothing to preview yet</div>
          <p className="text-xs text-[var(--text-muted)] mt-1">Describe what you want in the chat. Files the agent creates appear here live, and you can drop assets into the file panel.</p>
        </div>
      </div>
    );
  }

  const src = showLive ? ticketed(`${liveUrl}${liveUrl.includes('?') ? '&' : '?'}__inspect=1`)
    : `${toDraft(frameRawUrl(projectId, view!.path))}?__inspect=1&v=${version}-${reloadKey}-${draftRev}`;
  const plainSrc = showLive ? ticketed(liveUrl) : `${toDraft(rawUrl(projectId, view!.path))}?v=${version}-${reloadKey}-${draftRev}`;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--bg-primary)]">
      {/* toolbar */}
      <div className="h-11 shrink-0 flex items-center gap-1.5 px-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs">
        {showLive ? (
          <input value={livePath} onChange={e => setLivePath(e.target.value)} aria-label="Path on the live server"
            onKeyDown={e => { if (e.key === 'Enter') setReloadKey(k => k + 1); }}
            className="font-mono text-[12px] min-w-0 w-40 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 focus:outline-none focus:border-[var(--accent)]/60" />
        ) : <span className="font-mono text-[12px] truncate min-w-0 px-1">{file.path}</span>}
        {configured && (
          <div className="flex items-center gap-0.5 bg-[var(--bg-tertiary)] p-0.5 rounded-lg border border-[var(--border-subtle)] ml-1 shrink-0"
            title={dev?.error ?? (dev?.running ? `Live server: ${dev.command}` : 'Dev server stopped')}>
            <button onClick={() => dev?.running && setLive(v => !v)}
              className={clsx('flex items-center gap-1 px-2 py-1 rounded-md transition', showLive ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              <Server className="w-3.5 h-3.5" />
              <span className={clsx('w-1.5 h-1.5 rounded-full', dev?.running ? 'bg-emerald-400' : 'bg-[var(--text-muted)]/50')} />
              <span className="hidden lg:inline">{dev?.running ? (showLive ? 'Live' : 'Files') : 'Server'}</span>
            </button>
            <button className="px-1.5 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40" disabled={devBusy}
              title={dev?.running ? 'Restart the server' : 'Start the server'} onClick={() => devAction(dev?.running ? 'restart' : 'start')}>
              {devBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : dev?.running ? <RotateCw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            {dev?.running && (
              <button className="px-1.5 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40" disabled={devBusy}
                title="Stop the server" onClick={() => devAction('stop')}><Square className="w-3.5 h-3.5" /></button>
            )}
            <button className="px-1.5 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Server logs" onClick={showDevLogs}>
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {editable && (
          <div className="flex items-center bg-[var(--bg-tertiary)] p-0.5 rounded-lg border border-[var(--border-subtle)] ml-1 shrink-0">
            {(['preview', 'split', 'code'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} disabled={file.kind === 'text' && (m === 'preview' || (m === 'split' && !companion))}
                title={m === 'split' ? (companion && file.kind === 'text' ? `Edit ${file.path.split('/').pop()} beside ${companion.path}; the preview follows your edits` : 'Code and preview side by side; the preview follows your edits') : undefined}
                className={clsx('flex items-center gap-1 px-2 py-1 rounded-md transition disabled:opacity-30', mode === m ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                {m === 'preview' ? <Eye className="w-3.5 h-3.5" /> : m === 'split' ? <Columns2 className="w-3.5 h-3.5" /> : <Code className="w-3.5 h-3.5" />}<span className="hidden lg:inline capitalize">{m}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        {isHtml && mode !== 'code' && (
          <>
            <div className="hidden md:flex items-center bg-[var(--bg-tertiary)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
              {([
                ['native', NATIVE_LABEL[kind], kind === 'mobile' ? Smartphone : kind === 'deck' ? Monitor : Laptop],
                ['desktop', 'Desktop 1440', Monitor], ['tablet', 'Tablet 834', Tablet], ['mobile', 'Mobile 390', Smartphone],
              ] as const).map(([id, label, Icon]) => (
                <button key={id} title={label} onClick={() => setDevice(id)}
                  className={clsx('flex items-center gap-1 px-2 py-1 rounded-md transition', device === id ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                  <Icon className="w-3.5 h-3.5" />{id === 'native' && <span className="hidden xl:inline">{label}</span>}
                </button>
              ))}
            </div>
            <select value={String(zoom)} onChange={e => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
              className="bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-lg px-1.5 py-1 text-[11px] focus:outline-none" aria-label="Zoom">
              <option value="fit">Fit {zoom === 'fit' ? `(${Math.round(scale * 100)}%)` : ''}</option>
              {[0.25, 0.5, 0.75, 1].map(z => <option key={z} value={z}>{z * 100}%</option>)}
            </select>
            <button onClick={() => setInspect(v => !v)} title="Point at an element to comment on it"
              className={clsx('flex items-center gap-1 px-2 py-1 rounded-lg border transition', inspect ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-transparent' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
              <Crosshair className="w-3.5 h-3.5" /><span className="hidden lg:inline">Comment</span>
            </button>
          </>
        )}
        <button className={btn.icon} title="Reload preview" onClick={() => setReloadKey(k => k + 1)}><RotateCw className="w-3.5 h-3.5" /></button>
        <a className={btn.icon} title="Open in a new tab" href={plainSrc} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /></a>
      </div>

      {devLogs !== null && (
        <div className="shrink-0 max-h-56 flex flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-[var(--text-muted)]">
            <ScrollText className="w-3.5 h-3.5" /><span>Dev server logs</span>
            <button className="ml-auto underline disabled:opacity-40" disabled={busy}
              onClick={() => { onAsk(`The dev server has a problem. Read its logs (dev_server action=logs), find the cause and fix it. Latest output:\n${devLogs.slice(-1500)}`); setDevLogs(null); }}>Ask to fix</button>
            <button onClick={() => setDevLogs(null)} aria-label="Close logs"><X className="w-3.5 h-3.5" /></button>
          </div>
          <pre className="flex-1 overflow-auto px-3 pb-2 text-[11px] font-mono whitespace-pre-wrap">{devLogs}</pre>
        </div>
      )}

      {errors.length > 0 && mode !== 'code' && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-1.5 text-[11px] bg-red-500/10 border-b border-red-500/20 text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0 font-mono truncate" title={errors.join('\n')}>{errors.length} script error{errors.length > 1 ? 's' : ''}: {errors[errors.length - 1]}</span>
          <button className="underline shrink-0 disabled:opacity-40" disabled={busy}
            onClick={() => onAsk(`The preview of ${view!.path} throws JavaScript errors. Find and fix the cause:\n${errors.map(e => `- ${e}`).join('\n')}`)}>Ask to fix</button>
          <button onClick={() => setErrors([])} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {mode === 'preview' && !showLive && draftsOf(projectId).length > 0 && (
        <UnsavedBar projectId={projectId} onSaved={onSaved} onEdit={editable ? () => setMode('code') : undefined} />
      )}

      {mode === 'code' && editable && !showLive ? (
        <CodePane projectId={projectId} path={file.path} version={version} dark={dark} onSaved={onSaved} onRun={onRun} />
      ) : (
        <div ref={splitBox} className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {mode === 'split' && editable && (<>
          <div className="min-w-0 min-h-0 flex flex-col shrink-0 basis-1/2 lg:basis-[var(--split)]" style={{ '--split': `${splitPct}%` } as React.CSSProperties}>
            <CodePane projectId={projectId} path={file.path} version={version} dark={dark} onSaved={onSaved} onRun={onRun} />
          </div>
          <div role="separator" aria-orientation="vertical" title="Drag to resize · double-click to reset"
            className={clsx('hidden lg:block w-1.5 shrink-0 cursor-col-resize border-x border-[var(--border-subtle)] transition',
              dragging ? 'bg-[var(--accent)]/60' : 'bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/30')}
            onDoubleClick={() => { setSplitPct(50); try { localStorage.setItem('shellb.splitPct', '50'); } catch { /* private mode */ } }}
            onPointerDown={e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic event */ } setDragging(true); }}
            onPointerMove={e => {
              const box = splitBox.current?.getBoundingClientRect();
              if (!dragging || !box) return;
              setSplitPct(Math.min(80, Math.max(20, ((e.clientX - box.left) / box.width) * 100)));
            }}
            onPointerUp={() => { setDragging(false); try { localStorage.setItem('shellb.splitPct', String(Math.round(splitPct))); } catch { /* private mode */ } }} />
        </>)}
        <div ref={area} className="flex-1 min-w-0 min-h-0 relative overflow-auto"
          onWheel={e => {
            // wheel over the margin: scroll the page in the frame once the canvas itself can't scroll that way
            const el = area.current;
            if (!isHtml || !el) return;
            const down = e.deltaY > 0;
            if (down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return;
            post({ type: 'scrollBy', x: e.deltaX / scale, y: e.deltaY / scale });
          }}
          style={{ backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1px)', backgroundSize: '16px 16px' }}>
          {isHtml ? (
            <div style={{ position: 'absolute', left: frameLeft, top: pad, width: size[0] * scale, height: frameH * scale }}>
              <iframe
                ref={frame} key={showLive ? `live-${reloadKey}-${version}` : `${view!.path}`} src={src} title={showLive ? liveUrl : view!.path}
                // a live server is its own origin (another port), so it may keep it: cookies and storage then work normally
                sandbox={showLive ? 'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin' : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads'}
                className={clsx('bg-white shadow-2xl border border-[var(--border-subtle)]', (device === 'mobile' || (device === 'native' && kind === 'mobile')) && 'rounded-[28px]')}
                style={{ width: size[0], height: frameH, transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: dragging ? 'none' : undefined }}
              />
              {pick && (
                <div className="absolute z-10 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-2.5 animate-fade-in"
                  style={{
                    left: Math.min(Math.max(0, pick.rect.x * scale), size[0] * scale - 320),
                    top: Math.min((pick.rect.y + pick.rect.h) * scale + 8, frameH * scale - 120),
                  }}>
                  <div className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--accent-soft)] mb-1.5">
                    <Crosshair className="w-3 h-3 shrink-0" /><span className="truncate">{pick.label}</span>
                    <button className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => { setPick(null); post({ type: 'clear' }); }} aria-label="Cancel"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="flex items-end gap-1.5">
                    <textarea autoFocus rows={2} value={ask} onChange={e => setAsk(e.target.value)} placeholder="What should change here?"
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAsk(); } if (e.key === 'Escape') setPick(null); }}
                      className="flex-1 resize-none bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)]/60" />
                    <button onClick={submitAsk} disabled={!ask.trim() || busy} className="p-2 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-40" title="Send to the agent">
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <AssetView projectId={projectId} file={view!} src={plainSrc} version={version} draftRev={draftRev} dark={dark} />
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function AssetView({ projectId, file, src, version, draftRev, dark }: { projectId: string; file: ProjectFile; src: string; version: number; draftRev: number; dark: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (file.kind !== 'markdown') return;
    const d = drafts.get(draftKey(projectId, file.path));  // the working version, like every other preview
    if (d) setText(d.value);
    else api.rawText(projectId, file.path).then(setText).catch(() => setText('(could not load)'));
  }, [projectId, file.path, file.kind, version, draftRev]);
  const fontFamily = `asset-${file.path.replace(/\W/g, '')}`;
  switch (file.kind) {
    case 'image': case 'svg':
      return (
        <div className="min-h-full flex items-center justify-center p-8">
          <img src={src} alt={file.path} className="max-w-full max-h-[80vh] shadow-xl" style={{ background: 'repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%) 50% / 16px 16px' }} />
        </div>
      );
    case 'font':
      return (
        <div className="p-8 max-w-4xl mx-auto">
          <style>{`@font-face { font-family: "${fontFamily}"; src: url("${src}"); }`}</style>
          <div className="text-[11px] font-mono text-[var(--text-muted)] mb-4">{file.path}</div>
          <div style={{ fontFamily }} className="space-y-4">
            <div className="text-6xl leading-tight">Overthink. Overcomplicate. Overengineer.</div>
            <div className="text-3xl">The quick brown fox jumps over the lazy dog</div>
            <div className="text-xl">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &amp;@#%?!</div>
            <div className="text-base leading-relaxed max-w-2xl">Shell:B Studio previews uploaded typefaces at several sizes so you can judge texture, rhythm and legibility before the agent puts them to work in a layout.</div>
          </div>
        </div>
      );
    case 'markdown':
      return <div className="p-8 max-w-3xl mx-auto"><Markdown text={text} /></div>;
    case 'pdf':
      return <iframe src={src} title={file.path} className="w-full h-full border-0" />;
    case 'video':
      return <div className="min-h-full flex items-center justify-center p-8"><video src={src} controls className="max-w-full max-h-[80vh]" /></div>;
    case 'audio':
      return <div className="min-h-full flex items-center justify-center p-8"><audio src={src} controls /></div>;
    case 'model':
      return <iframe src={`/vendor/three/viewer.html?src=${encodeURIComponent(src)}&dark=${dark ? 1 : 0}`} title={file.path} className="w-full h-full border-0" />;
    default:
      return <div className="min-h-full flex items-center justify-center text-xs text-[var(--text-muted)]">No preview for this file type. <a className="underline ml-1" href={src} download>Download</a></div>;
  }
}

function CodePane({ projectId, path, version, dark, onSaved, onRun }: {
  projectId: string; path: string; version: number; dark: boolean; onSaved: () => void; onRun?: (command: string) => void;
}) {
  const key = draftKey(projectId, path);
  const draft = drafts.get(key);
  const [value, setValue] = useState(draft?.value ?? '');
  const [saved, setSaved] = useState(draft?.saved ?? '');
  const [stale, setStale] = useState(!!draft && draft.version !== version);
  const [saving, setSaving] = useState(false);
  const dirty = value !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const versionRef = useRef(version);
  versionRef.current = version;

  const load = useCallback(() => api.rawText(projectId, path).then(t => {
    if (drafts.delete(key)) syncSoon(projectId);
    setValue(t); setSaved(t); setStale(false);
  }), [projectId, path, key]);
  useEffect(() => {
    const d = drafts.get(key);  // a file reopened with unsaved edits picks them up instead of the copy on disk
    if (d) { setValue(d.value); setSaved(d.saved); setStale(d.version !== versionRef.current); } else load();
  }, [key, load]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (dirtyRef.current) setStale(true); else load();
  }, [version]);
  useEffect(() => {
    const had = drafts.has(key);
    if (value !== saved) {
      const d = drafts.get(key);
      drafts.set(key, { value, saved, version: d && stale ? d.version : versionRef.current });
    } else drafts.delete(key);
    if (had || drafts.has(key)) syncSoon(projectId);  // keeps a preview open in another tab current too
  }, [key, value, saved, stale, projectId]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveFile(projectId, path, value);
      if (drafts.delete(key)) await syncDrafts(projectId);
      setSaved(value); setStale(false); onSaved();
    } finally { setSaving(false); }
  }, [projectId, path, key, value, onSaved]);

  const command = onRun && runCommand(path);
  // command-line arguments for Run, remembered per file
  const argsKey = `shellb.runargs.${projectId}.${path}`;
  const [args, setArgs] = useState(() => { try { return localStorage.getItem(argsKey) ?? ''; } catch { return ''; } });
  useEffect(() => { try { setArgs(localStorage.getItem(argsKey) ?? ''); } catch { setArgs(''); } }, [argsKey]);
  const run = useCallback(async () => {
    if (!command || !onRun) return;
    if (dirtyRef.current) await save();
    try { localStorage.setItem(argsKey, args); } catch { /* private mode */ }
    onRun(args.trim() ? `${command} ${args.trim()}` : command);
  }, [command, onRun, save, args, argsKey]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {stale && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] bg-amber-500/10 border-b border-amber-500/20 text-amber-300">
          The agent changed this file while you were editing.
          <button className="underline" onClick={load}>Load theirs</button>
          <button className="underline" onClick={() => setStale(false)}>Keep mine</button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="p-4 text-xs text-[var(--text-muted)]">Loading editor…</div>}>
          <CodeEditor path={path} value={value} onChange={setValue} onSave={save} onRun={command ? run : undefined} dark={dark} />
        </Suspense>
      </div>
      <div className="h-8 shrink-0 flex items-center justify-between px-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-muted)]">
        <span>{dirty ? 'Unsaved changes' : 'Saved · every save is a version'}</span>
        <div className="flex items-center gap-1.5">
          {command && (
            <input value={args} onChange={e => setArgs(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
              placeholder="arguments" spellCheck={false} aria-label="Arguments for Run" title="Command-line arguments, e.g. 100 C F"
              className="w-28 sm:w-44 h-6 px-2 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
          )}
          {command && (
            <button className={btn.subtle} disabled={saving} onClick={run} title={`Save and run \`${command}\` in the terminal (sandbox, no network)`}>
              <Play className="w-3.5 h-3.5" />Run <kbd className="opacity-70 font-mono text-[10px]">Ctrl ↵</kbd>
            </button>
          )}
          {dirty && <button className={btn.subtle} disabled={saving} onClick={load} title="Throw away your changes and reload the saved file">Discard</button>}
          <button className={btn.primary} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'} <kbd className="opacity-70 font-mono text-[10px]">Ctrl S</kbd></button>
        </div>
      </div>
    </div>
  );
}

/** Over a preview that includes unsaved edits: says which files, and saves them all in one go. */
function UnsavedBar({ projectId, onSaved, onEdit }: { projectId: string; onSaved: () => void; onEdit?: () => void }) {
  const [saving, setSaving] = useState(false);
  const list = draftsOf(projectId);
  const names = list.map(d => d.path.split('/').pop()).join(', ');
  const saveAll = async () => {
    setSaving(true);
    try {
      for (const d of list) {
        await api.saveFile(projectId, d.path, d.value);
        drafts.delete(draftKey(projectId, d.path));
      }
      await syncDrafts(projectId);
      onSaved();
    } finally { setSaving(false); }
  };
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] bg-sky-500/10 border-b border-sky-500/20 text-sky-300">
      <span className="flex-1 min-w-0 truncate" title={list.map(d => d.path).join('\n')}>
        Previewing your unsaved changes{list.length > 1 ? ` to ${list.length} files` : ''}: {names}
      </span>
      {onEdit && <button className="underline shrink-0" onClick={onEdit}>Back to code</button>}
      <button className={clsx(btn.primary, 'shrink-0')} disabled={saving} onClick={saveAll}>{saving ? 'Saving…' : list.length > 1 ? 'Save all' : 'Save'}</button>
    </div>
  );
}
