import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Box, Check, ChevronLeft, ChevronRight, Copy, Download, EyeOff, Images, Loader2, MessageSquare, Music, Palette, Search, Shapes,
  Telescope, X, CodeXml } from 'lucide-react';
import { req } from '../api';
import { assetsApi, type AssetLib } from '../assetsApi';
import type { Agent } from '../types';
import { AudioCard } from './AudioCard';
import { AgentAvatar, btn, relTime } from './common';
import { t as tx } from '../i18n';

export interface MediaItem {
  id: string;
  url: string;
  kind: 'image' | 'audio' | 'model';
  tool: string;
  prompt: string;
  convId: string | null;
  convTitle: string;
  agentId: string | null;
  projectId: string | null;
  projectName: string;
  projectKind: string;
  boardId?: string | null;
  boardTitle: string;
  name: string;
  size: number;
  meta: { previews?: string[]; audioInfo?: Record<string, unknown> };
  createdAt: number;
}

const mediaApi = {
  list: (q: { kind?: string; q?: string; source?: string }) =>
    req<{ items: MediaItem[]; counts: Record<string, number> }>(`/api/media?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  hide: (id: string) => req(`/api/media/${id}/hide`, { method: 'POST' }),
  toAssets: (id: string, libId: string) =>
    req<{ status: string; lib: { id: string; name: string } }>(`/api/media/${id}/to-assets`, { method: 'POST', body: JSON.stringify({ libId }) }),
};

const TOOL_LABEL: Record<string, string> = {
  generate_image: 'FLUX image', generate_sprite: 'Sprite', generate_texture: 'Texture', generate_music: 'Music', generate_sfx: 'Sound effect',
  generate_voice: 'Voice', generate_3d: '3D model', audio_overview: 'Audio Overview', edit_image: 'Edited image',
};
const label = (m: MediaItem) => TOOL_LABEL[m.tool] ?? (m.tool ? m.tool.replace(/_/g, ' ') : m.kind === 'image' ? 'Image' : m.kind === 'audio' ? 'Audio' : '3D model');
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function sourceLink(m: MediaItem): { href: string; text: string; icon: typeof MessageSquare } | null {
  if (m.boardId) return { href: `#/research/${m.boardId}`, text: m.boardTitle || 'Notebook', icon: Telescope };
  if (m.projectId) return { href: `#/${m.projectKind === 'code' ? 'code' : 'studio'}/${m.projectId}`, text: m.projectName || 'Project',
    icon: m.projectKind === 'code' ? CodeXml : Palette };
  if (m.convId) return { href: `#/c/${m.convId}`, text: m.convTitle || 'Chat', icon: MessageSquare };
  return null;
}

function Tile({ m, onOpen }: { m: MediaItem; onOpen: () => void }) {
  const preview = m.kind === 'image' ? m.url : m.meta.previews?.[0];
  return (
    <button onClick={onOpen} className="group relative aspect-square rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--border-strong)] transition text-left">
      {preview ? (
        <img src={preview} alt={m.prompt.slice(0, 120) || m.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 bg-gradient-to-br from-[var(--bg-tertiary)] to-[var(--bg-secondary)]">
          {m.kind === 'audio' ? <Music className="w-8 h-8 text-pink-400" /> : <Box className="w-8 h-8 text-sky-400" />}
          <p className="text-[11px] text-[var(--text-secondary)] text-center line-clamp-4">{m.prompt || m.name}</p>
        </div>
      )}
      {m.kind !== 'image' && preview && (
        <span className="absolute top-2 left-2 p-1 rounded-md bg-black/55 text-white">{m.kind === 'audio' ? <Music className="w-3.5 h-3.5" /> : <Box className="w-3.5 h-3.5" />}</span>
      )}
      <span className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/75 to-transparent text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition">
        <span className="block text-[11px] font-medium">{label(m)}</span>
        <span className="block text-[10px] opacity-80 truncate">{m.prompt || m.name}</span>
      </span>
    </button>
  );
}

function Lightbox({ m, agents, onClose, onPrev, onNext, onHidden }: {
  m: MediaItem; agents: Agent[]; onClose: () => void; onPrev?: () => void; onNext?: () => void; onHidden: () => void;
}) {
  const [libs, setLibs] = useState<AssetLib[] | null>(null);
  const [lib, setLib] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && onPrev) onPrev();
      else if (e.key === 'ArrowRight' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);
  useEffect(() => { setMsg(''); }, [m.id]);
  const loadLibs = () => { if (!libs) assetsApi.libs().then(l => { const ok = l.filter(x => !x.locked); setLibs(ok); setLib(ok[0]?.id ?? ''); }).catch(() => setLibs([])); };
  const agent = agents.find(a => a.id === m.agentId);
  const src = sourceLink(m);
  const preview = m.kind === 'image' ? m.url : m.meta.previews?.[0];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-6" onClick={onClose} role="dialog" aria-modal="true" aria-label={tx('Media viewer')}>
      <div className="relative w-full max-w-6xl max-h-full flex flex-col lg:flex-row rounded-2xl overflow-hidden border border-[var(--border-strong)] bg-[var(--bg-primary)]" onClick={e => e.stopPropagation()}>
        <div className="relative flex-1 min-h-[240px] lg:min-h-[560px] bg-black/40 flex items-center justify-center p-3">
          {m.kind === 'audio' ? (
            <div className="w-full max-w-xl"><AudioCard src={m.url} /></div>
          ) : preview ? (
            <img src={preview} alt={m.prompt.slice(0, 200)} className="max-w-full max-h-[50vh] lg:max-h-[80vh] object-contain rounded-lg" />
          ) : <Box className="w-16 h-16 text-sky-400" />}
          {onPrev && <button className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70" onClick={onPrev} aria-label={tx('Previous')}><ChevronLeft className="w-5 h-5" /></button>}
          {onNext && <button className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70" onClick={onNext} aria-label={tx('Next')}><ChevronRight className="w-5 h-5" /></button>}
        </div>
        <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] flex flex-col max-h-[45vh] lg:max-h-none overflow-y-auto">
          <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)] shrink-0">
            <span className="text-sm font-medium flex-1">{label(m)}</span>
            <button className={btn.icon} onClick={onClose} aria-label={tx('Close')}><X className="w-4 h-4" /></button>
          </div>
          <div className="p-4 space-y-4 text-sm">
            {m.prompt && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-[var(--text-secondary)]">{m.tool === 'audio_overview' ? tx('Title') : tx('Prompt')}</span>
                  <button className="flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    onClick={() => navigator.clipboard?.writeText(m.prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {})}>
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? tx('Copied') : tx('Copy')}</button>
                </div>
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words select-text">{m.prompt}</p>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              {agent && <><dt className="text-[var(--text-muted)]">{tx('Made by')}</dt><dd className="flex items-center gap-1.5"><AgentAvatar agent={agent} size={16} />{agent.name}</dd></>}
              <dt className="text-[var(--text-muted)]">{tx('When')}</dt><dd title={new Date(m.createdAt).toLocaleString()}>{relTime(m.createdAt)}</dd>
              <dt className="text-[var(--text-muted)]">{tx('File')}</dt><dd className="truncate" title={m.name}>{m.name} · {fmtSize(m.size)}</dd>
              {src && <><dt className="text-[var(--text-muted)]">{tx('From')}</dt>
                <dd><a href={src.href} onClick={onClose} className="flex items-center gap-1 hover:text-[var(--accent)] min-w-0"><src.icon className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{tx(src.text)}</span></a></dd></>}
            </dl>
            <div className="flex flex-wrap gap-1.5">
              <a className={btn.subtle} href={m.url} download={m.name}><Download className="w-3.5 h-3.5" />{tx('Download')}</a>
              {src && <a className={btn.subtle} href={src.href} onClick={onClose}><src.icon className="w-3.5 h-3.5" />{tx('Open source')}</a>}
            </div>
            <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
              <span className="block pt-3 text-xs text-[var(--text-secondary)]">{tx('Keep it in an asset library')}</span>
              {libs === null ? (
                <button className={btn.subtle} onClick={loadLibs}><Shapes className="w-3.5 h-3.5 text-lime-400" />{tx('Add to asset library…')}</button>
              ) : libs.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)]">{tx('No unlocked asset libraries yet. Create one on the')} <a className="underline" href="#/assets">{tx('Assets')}</a> page.</p>
              ) : (
                <div className="flex gap-1.5">
                  <select className={btn.input} value={lib} onChange={e => setLib(e.target.value)} aria-label={tx('Asset library')}>
                    {libs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <button className={btn.primary} disabled={!lib || busy} onClick={async () => {
                    setBusy(true); setMsg('');
                    try { const r = await mediaApi.toAssets(m.id, lib); setMsg(r.status === 'duplicate' ? `Already in ${r.lib.name}.` : `Added to ${r.lib.name}.`); }
                    catch (e) { setMsg(String(e).replace(/^Error: \d+: /, '')); }
                    setBusy(false);
                  }}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : tx('Add')}</button>
                </div>
              )}
              {msg && <p className="text-[11px] text-[var(--text-secondary)]">{msg}</p>}
            </div>
            <button className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] hover:text-red-400" onClick={async () => { await mediaApi.hide(m.id); onHidden(); }}
              title={tx('Hides it here; the file itself stays where it is')}>
              <EyeOff className="w-3.5 h-3.5" />{tx('Remove from the gallery')}</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Library → Media: every picture, sound and model Shell:B has generated, wherever it was saved. */
export function MediaGallery({ agents }: { agents: Agent[] }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    mediaApi.list({ kind, source, q: query }).then(r => { setItems(r.items); setCounts(r.counts); setError(''); }).catch(e => setError(String(e)));
  }, [kind, source, query]);
  useEffect(load, [load]);
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);

  const chip = (on: boolean, text: string, onClick: () => void, n?: number, Icon?: typeof Images) => (
    <button onClick={onClick} className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border transition',
      on ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
      {Icon && <Icon className="w-3 h-3" />}{text}{n !== undefined && <span className="font-mono text-[10px] opacity-70">{n}</span>}
    </button>
  );
  const list = items ?? [];
  const cur = open !== null ? list[open] : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input className={clsx(btn.input, 'pl-8')} value={q} onChange={e => setQ(e.target.value)} placeholder={tx('Search prompts')} />
        </div>
        <div className="w-full sm:w-52"><select className={btn.input} value={source} onChange={e => setSource(e.target.value)} aria-label={tx('Where it was made')}>
          <option value="">{tx('Made anywhere')}</option>
          <option value="chat">{tx('In chats')}</option>
          <option value="project">{tx('In Studio or Code')}</option>
          <option value="notebook">{tx('In notebooks')}</option>
        </select></div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {chip(kind === '', tx('Everything'), () => setKind(''), total)}
        {chip(kind === 'image', tx('Pictures'), () => setKind('image'), counts.image ?? 0, Images)}
        {chip(kind === 'audio', tx('Audio'), () => setKind('audio'), counts.audio ?? 0, Music)}
        {chip(kind === 'model', tx('3D models'), () => setKind('model'), counts.model ?? 0, Box)}
      </div>
      {error ? <div className="text-center py-16 text-sm text-red-400">{error}</div>
        : items === null ? <div className="flex justify-center py-16 text-[var(--text-muted)]"><Loader2 className="w-5 h-5 animate-spin" /></div>
          : list.length === 0 ? (
            <div className="text-center py-16 text-sm text-[var(--text-muted)]">
              <Images className="w-8 h-8 mx-auto mb-2" />
              {total ? tx('Nothing matches.') : tx('Nothing generated yet. Ask NYX for a picture, a song or a sound effect, and it shows up here.')}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {list.map((m, i) => <Tile key={m.id} m={m} onOpen={() => setOpen(i)} />)}
            </div>
          )}
      {cur && (
        <Lightbox m={cur} agents={agents} onClose={() => setOpen(null)}
          onPrev={open! > 0 ? () => setOpen(open! - 1) : undefined}
          onNext={open! < list.length - 1 ? () => setOpen(open! + 1) : undefined}
          onHidden={() => { setItems(list.filter(x => x.id !== cur.id)); setOpen(null); setCounts(c => ({ ...c, [cur.kind]: Math.max(0, (c[cur.kind] ?? 1) - 1) })); }} />
      )}
    </div>
  );
}
