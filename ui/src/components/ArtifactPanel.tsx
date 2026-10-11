import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import hljs from 'highlight.js/lib/common';
import {
  Boxes, Check, ChevronDown, Code, Copy, Download, Eraser, Eye, Maximize2, Minimize2, RotateCw, X,
} from 'lucide-react';
import type { ArtifactGroup } from '../types';
import { frameApi } from '../api';
import { Markdown } from './Markdown';
import { btn } from './common';
import { FavoriteStar } from './Favorites';
import { downloadArtifact } from './artifactMenu';
import { localizeCdn } from '../offline';
import { t as tx } from '../i18n';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Saved-state scope of a chat artifact (server/appstate.py); shared by all its versions. */
export const artifactScope = (convId: string, artId: string) => `art:${convId}:${artId}`;

/** A sandboxed frame gets no cookie, so /api file URLs in its content go through its frame key (server/auth.py), which
 *  reaches this chat's /work and the asset libraries only. */
const viaFrameKey = (content: string, api: string) => api === '/api' ? content
  : content.replace(/(["'(=\s])\/api\/(workspace|assets\/file|files)\//g, `$1${api}/$2/`);

/** `scope` gives the page a localStorage saved on the server (read-only with `ro`); without it, one that forgets.
 *  With `convId`, relative URLs (fonts, images, data) resolve against that chat's /work folder. */
export function srcDoc(type: string, content: string, dark: boolean, scope?: string, ro?: boolean, convId?: string) {
  const api = frameApi(convId ? `w-${convId}` : 'x');
  const base = `<base href="${location.origin}${convId ? `${api}/workspace/${encodeURIComponent(convId)}/` : '/'}">`;
  if (type === 'html' || type === 'svg') content = viaFrameKey(localizeCdn(content), api);
  if (type === 'html') {
    // first in <head>, a blocking script, so localStorage is ready before the page's own scripts run
    const q = scope ? `?s=${encodeURIComponent(scope)}${ro ? '&ro=1' : ''}` : '';
    const head = `${base}<script src="${api}/appstate/boot.js${q}"></script>`;
    if (/<head[^>]*>/i.test(content)) return content.replace(/<head([^>]*)>/i, `<head$1>${head}`);
    if (/<html[^>]*>/i.test(content)) return content.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    return `<!doctype html><html><head>${head}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`;
  }
  if (type === 'svg') {
    const bg = dark ? '#141416' : '#ffffff';
    return `<!doctype html><html><head>${base}<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:${bg};
      background-image:linear-gradient(45deg,rgba(128,128,128,.08) 25%,transparent 25%,transparent 75%,rgba(128,128,128,.08) 75%),linear-gradient(45deg,rgba(128,128,128,.08) 25%,transparent 25%,transparent 75%,rgba(128,128,128,.08) 75%);
      background-size:24px 24px;background-position:0 0,12px 12px}svg{max-width:96vw;max-height:96vh;width:auto;height:auto}</style></head><body>${content}</body></html>`;
  }
  if (type === 'mermaid') {
    return `<!doctype html><html><head>${base}<meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:${dark ? '#191919' : '#faf8f5'}}
      body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}.mermaid{width:100%}</style>
      <script src="/vendor/mermaid.js"></script></head><body><pre class="mermaid">${esc(content)}</pre>
      <script>mermaid.initialize({startOnLoad:true,theme:${dark ? "'dark'" : "'default'"},securityLevel:'strict'});</script></body></html>`;
  }
  return '';
}


interface Props {
  groups: ArtifactGroup[];
  activeId: string;
  version?: number;
  dark: boolean;
  onSelect: (id: string, version?: number) => void;
  onClose: () => void;
  convId?: string; // for the Favorites star
  /** Shell:B Guest has no Favorites */
  noFavorite?: boolean;
}

export function ArtifactPanel({ groups, activeId, version, dark, onSelect, onClose, convId, noFavorite }: Props) {
  const group = groups.find(g => g.id === activeId) ?? groups[groups.length - 1];
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picker, setPicker] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  const current = group?.versions.find(v => v.version === version) ?? group?.versions[group.versions.length - 1];
  const previewable = current && current.type !== 'code';
  useEffect(() => { if (current?.type === 'code') setTab('code'); }, [current?.type]);

  const highlighted = useMemo(() => {
    if (!current) return '';
    const lang = current.language && hljs.getLanguage(current.language) ? current.language : undefined;
    try {
      return lang ? hljs.highlight(current.content, { language: lang }).value : hljs.highlightAuto(current.content).value;
    } catch { return esc(current.content); }
  }, [current]);

  if (!group || !current) return null;

  const download = () => downloadArtifact(current);

  return (
    <section
      className={clsx('flex flex-col bg-[var(--bg-primary)] border-l border-[var(--border-subtle)] min-w-0',
        full ? 'fixed inset-0 z-50' : 'fixed inset-0 z-40 md:static md:z-auto md:w-[48%] lg:w-[50%] md:shrink-0 h-full')}
      aria-label={tx('Artifact')}
    >
      <header className="h-12 shrink-0 border-b border-[var(--border-subtle)] px-3 flex items-center gap-2 bg-[var(--bg-secondary)]">
        <div className="relative min-w-0 flex-1">
          <button onClick={() => groups.length > 1 && setPicker(!picker)} className="flex items-center gap-2 min-w-0 max-w-full text-left">
            <span className="w-6 h-6 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] flex items-center justify-center shrink-0"><Boxes className="w-3.5 h-3.5" /></span>
            <span className="text-sm font-semibold truncate">{tx(current.title)}</span>
            {groups.length > 1 && <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />}
            {convId && !noFavorite && <FavoriteStar nested kind="artifact" id={convId} sub={current.id} title={tx(current.title)} />}
          </button>
          {picker && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPicker(false)} />
              <div className="absolute left-0 top-full mt-1 w-72 z-50 bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl shadow-2xl p-1">
                {groups.map(g => (
                  <button key={g.id} onClick={() => { onSelect(g.id); setPicker(false); }}
                    className={clsx('w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex justify-between gap-2', g.id === group.id ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-hover)]')}>
                    <span className="truncate font-medium">{tx(g.title)}</span>
                    <span className="text-[var(--text-muted)] font-mono shrink-0">{g.type} · v{g.versions.length}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {group.versions.length > 1 && (
          <select
            value={current.version} onChange={e => onSelect(group.id, Number(e.target.value))}
            className="text-[11px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-lg px-1.5 py-1 focus:outline-none"
            aria-label={tx('Version')}
          >
            {group.versions.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
          </select>
        )}

        {previewable && (
          <div className="flex items-center bg-[var(--bg-tertiary)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
            {(['preview', 'code'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={clsx('flex items-center gap-1 px-2 py-1 rounded-md text-xs transition', tab === t ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                {t === 'preview' ? <Eye className="w-3.5 h-3.5" /> : <Code className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline capitalize">{t}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center shrink-0">
          {tab === 'preview' && previewable && current.type !== 'markdown' && (
            <button className={btn.icon} title={tx('Reload')} onClick={() => setReloadKey(k => k + 1)}><RotateCw className="w-3.5 h-3.5" /></button>
          )}
          {tab === 'preview' && current.type === 'html' && convId && (
            <button className={btn.icon} title={tx('Clear saved data')} onClick={async () => {
              if (!confirm(tx('Clear everything "{title}" has saved? This can\'t be undone.', { title: current.title }))) return;
              await fetch(`/api/appstate?s=${encodeURIComponent(artifactScope(convId, current.id))}`, { method: 'DELETE' });
              setReloadKey(k => k + 1);
            }}><Eraser className="w-3.5 h-3.5" /></button>
          )}
          <button className={btn.icon} title={tx('Copy source')} onClick={() => { navigator.clipboard.writeText(current.content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button className={btn.icon} title={tx('Download')} onClick={download}><Download className="w-3.5 h-3.5" /></button>
          <button className={clsx(btn.icon, 'hidden md:inline-flex')} title={full ? tx('Exit full screen') : tx('Full screen')} onClick={() => setFull(!full)}>
            {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button className={btn.icon} title={tx('Close')} onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
      </header>

      <div className="flex-1 min-h-0 relative">
        {tab === 'preview' && previewable ? (
          current.type === 'markdown' ? (
            <div className="h-full overflow-y-auto px-6 py-6 md:px-10"><div className="max-w-3xl mx-auto"><Markdown text={current.content} /></div></div>
          ) : (
            <iframe
              key={`${current.id}-${current.version}-${reloadKey}-${dark}`}
              ref={frame}
              title={tx(current.title)}
              srcDoc={srcDoc(current.type, current.content, dark, convId && artifactScope(convId, current.id), false, convId)}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"
              className="w-full h-full border-0 bg-white"
            />
          )
        ) : (
          <div className="h-full overflow-auto bg-[var(--bg-code)]">
            <pre className="p-4 text-[12.5px] leading-relaxed font-mono"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
          </div>
        )}
      </div>

      <footer className="h-7 shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 flex items-center justify-between text-[10px] text-[var(--text-muted)] font-mono">
        <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{tx('sandboxed · offline')}{current.type === 'html' && convId ? tx(' · saves its data') : ''}</span>
        <span>{current.type}{current.type === 'code' ? ` · ${current.language}` : ''} · v{current.version} · {current.content.split('\n').length} lines</span>
      </footer>
    </section>
  );
}
