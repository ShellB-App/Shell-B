import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  ArrowLeft, AudioLines, Box, Check, CheckSquare, Copy, Download, File as FileIcon, FileArchive, FileText, Film, FolderInput, GitFork,
  Image as ImageIcon, Loader2, Lock, MessageSquare, Pause, Play, Plus, RotateCw, Search, Shapes, Square, Trash2, Type, Unlock, Upload,
  X, type LucideIcon,
} from 'lucide-react';
import type { Agent, ProjectSummary } from '../types';
import { api, fmtBytes } from '../api';
import {
  assetFileUrl, assetThumbUrl, assetsApi, hasThumb, CATEGORIES, LICENSES,
  type Asset, type AssetJob, type AssetKind, type AssetLib, type AssetLibDetail, type AssetPatch, type LicensePolicy,
} from '../assetsApi';
import { AgentAvatar, Modal, btn, relTime } from './common';

const KIND_ICON: Record<AssetKind, LucideIcon> = {
  image: ImageIcon, audio: AudioLines, video: Film, model: Box, font: Type, data: FileText, archive: FileArchive, other: FileIcon,
};
const CAT_HUE: Record<string, number> = {
  picture: 200, texture: 30, sprite: 280, tileset: 300, icon: 50, ui: 220, background: 190, sound: 160, music: 140, ambience: 120,
  voice: 340, model: 15, font: 260, vector: 330, video: 0, data: 210, other: 0,
};
const CHECKER = { background: 'repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-secondary) 0% 50%) 50% / 14px 14px' };
const SIZES = { s: 118, m: 168, l: 236 } as const;
type Size = keyof typeof SIZES;

const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
const catStyle = (c: string) => {
  const h = CAT_HUE[c] ?? 0;
  return c === 'other' || c === 'data' ? undefined : { color: `hsl(${h} 70% 45%)`, background: `hsl(${h} 70% 50% / 0.12)` };
};
const scoutAgents = (agents: Agent[]) =>
  [...agents].filter(a => !a.model?.includes('/') || a.id === 'magpie').sort((a, b) => Number(b.id === 'magpie') - Number(a.id === 'magpie'));

export function CategoryChip({ c, className }: { c: string; className?: string }) {
  return <span className={clsx('px-1.5 py-px rounded text-[10px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]', className)} style={catStyle(c)}>{c}</span>;
}

// ── previews ────────────────────────────────────────────────────────────────

let playing: { audio: HTMLAudioElement; stop: () => void } | null = null;

function PlayButton({ url, className, size = 'w-4 h-4' }: { url: string; className?: string; size?: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => () => { if (playing && on) playing.stop(); }, [on]);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (on && playing) { playing.stop(); return; }
    playing?.stop();
    const audio = new Audio(url);
    const stop = () => { audio.pause(); setOn(false); if (playing?.audio === audio) playing = null; };
    audio.onended = stop;
    audio.onerror = stop;
    playing = { audio, stop };
    setOn(true);
    audio.play().catch(stop);
  };
  return (
    <button onClick={toggle} title={on ? 'Stop' : 'Play'}
      className={clsx('rounded-full bg-[var(--accent)] text-[var(--accent-fg)] flex items-center justify-center shadow hover:brightness-110 transition', className)}>
      {on ? <Pause className={size} /> : <Play className={clsx(size, 'translate-x-px')} />}
    </button>
  );
}

const loadedFonts = new Set<string>();
function FontSample({ a, text = 'Aa Gg 123', className }: { a: Asset; text?: string; className?: string }) {
  const family = `asset-${a.id}`;
  const [ok, setOk] = useState(loadedFonts.has(family));
  useEffect(() => {
    if (ok) return;
    const f = new FontFace(family, `url(${assetFileUrl(a)})`);
    f.load().then(ff => { document.fonts.add(ff); loadedFonts.add(family); setOk(true); }).catch(() => {});
  }, [a, family, ok]);
  return <div className={clsx('leading-tight text-[var(--text-primary)]', className)} style={{ fontFamily: ok ? family : undefined }}>{text}</div>;
}

/** Plays a sprite sheet using the frame size stored in the asset's meta (frameWidth/frameHeight, optional frames and fps). */
function SpriteAnim({ a, scale }: { a: Asset; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fw = Number(a.meta.frameWidth), fh = Number(a.meta.frameHeight || a.meta.frameWidth);
  const fps = Number(a.meta.fps) || 8;
  const gap = Number(a.meta.spacing) || 0, edge = Number(a.meta.margin) || 0;   // pixels between frames / around the sheet
  useEffect(() => {
    const img = new Image();
    img.src = assetFileUrl(a);
    let raf = 0, alive = true;
    img.onload = () => {
      const cols = Math.max(1, Math.floor((img.width - 2 * edge + gap) / (fw + gap))), rows = Math.max(1, Math.floor((img.height - 2 * edge + gap) / (fh + gap)));
      const n = Math.min(Number(a.meta.frames) || cols * rows, cols * rows);
      const t0 = performance.now();
      const draw = (t: number) => {
        if (!alive) return;
        const c = ref.current?.getContext('2d');
        if (c) {
          const i = Math.floor(((t - t0) / 1000) * fps) % n;
          c.imageSmoothingEnabled = false;
          c.clearRect(0, 0, fw * scale, fh * scale);
          c.drawImage(img, edge + (i % cols) * (fw + gap), edge + Math.floor(i / cols) * (fh + gap), fw, fh, 0, 0, fw * scale, fh * scale);
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    };
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [a, fw, fh, fps, gap, edge, scale]);
  return <canvas ref={ref} width={fw * scale} height={fh * scale} />;
}
const isSheet = (a: Asset) => a.kind === 'image' && Number(a.meta.frameWidth) > 0 && !!a.width && Number(a.meta.frameWidth) < a.width;

function Thumb({ a, className }: { a: Asset; className?: string }) {
  const [broken, setBroken] = useState(false);
  const Icon = KIND_ICON[a.kind] ?? FileIcon;
  const small = a.kind === 'image' && (a.width ?? 999) <= 128 && (a.height ?? 999) <= 128;
  if (hasThumb(a) && !broken) {
    return (
      <div className={clsx('absolute inset-0 flex items-center justify-center p-2', className)} style={CHECKER}>
        <img src={assetThumbUrl(a)} alt={a.title} loading="lazy" onError={() => setBroken(true)} draggable={false}
          className={clsx('max-w-full max-h-full object-contain', small && '[image-rendering:pixelated] w-3/5 h-3/5')} />
      </div>
    );
  }
  return (
    <div className={clsx('absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-tertiary)]', className)}>
      {a.kind === 'font' ? <FontSample a={a} className="text-2xl" /> : <Icon className="w-8 h-8 text-[var(--text-muted)]" />}
      {a.kind === 'audio' && <PlayButton url={assetFileUrl(a)} className="w-9 h-9" />}
    </div>
  );
}

function BigPreview({ a }: { a: Asset }) {
  const [zoom, setZoom] = useState(1);
  const url = assetFileUrl(a);
  const ext = a.path.toLowerCase().split('.').pop() ?? '';
  if (a.kind === 'image') {
    const small = Math.max(a.width ?? 999, a.height ?? 999) <= 256;
    return (
      <div className="space-y-2">
        <div className="relative rounded-xl overflow-auto max-h-[46vh] flex items-center justify-center p-3" style={CHECKER}>
          <img src={url} alt={a.title} style={small && a.width ? { width: a.width * zoom * 2 } : undefined}
            className={clsx('max-w-none', !small && 'max-w-full max-h-[42vh] object-contain', small && '[image-rendering:pixelated]')} />
        </div>
        {small && (
          <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            Zoom {[1, 2, 4].map(z => <button key={z} onClick={() => setZoom(z)} className={clsx('px-1.5 rounded', zoom === z && 'bg-[var(--bg-hover)] text-[var(--text-primary)]')}>{z * 2}×</button>)}
          </div>
        )}
        {isSheet(a) && (
          <div className="flex items-center gap-3 p-2 rounded-lg bg-[var(--bg-tertiary)]">
            <div style={CHECKER} className="rounded p-1"><SpriteAnim a={a} scale={Math.max(1, Math.floor(96 / Number(a.meta.frameHeight || a.meta.frameWidth)))} /></div>
            <div className="text-[11px] text-[var(--text-secondary)]">Sprite sheet · {String(a.meta.frameWidth)}×{String(a.meta.frameHeight || a.meta.frameWidth)} frames
              {a.meta.fps ? ` · ${String(a.meta.fps)} fps` : ''}</div>
          </div>
        )}
      </div>
    );
  }
  if (a.kind === 'audio') return <audio src={url} controls className="w-full" preload="metadata" />;
  if (a.kind === 'video') return <video src={url} controls className="w-full rounded-xl bg-black max-h-[46vh]" preload="metadata" />;
  if (a.kind === 'model' && ['glb', 'gltf', 'obj', 'stl'].includes(ext)) {
    return <iframe title={a.title} src={`/vendor/three/viewer.html?src=${encodeURIComponent(url)}`} className="w-full h-[46vh] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]" />;
  }
  if (a.kind === 'font') {
    return (
      <div className="p-4 rounded-xl bg-[var(--bg-tertiary)] space-y-2 overflow-hidden">
        <FontSample a={a} text="Aa Bb Cc 0123" className="text-4xl" />
        <FontSample a={a} text="The quick brown fox jumps over the lazy dog." className="text-lg" />
        <FontSample a={a} text="ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz !?&@#" className="text-sm" />
      </div>
    );
  }
  const Icon = KIND_ICON[a.kind] ?? FileIcon;
  return <div className="h-40 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center"><Icon className="w-10 h-10 text-[var(--text-muted)]" /></div>;
}

// ── small editors ───────────────────────────────────────────────────────────

export function TagEditor({ tags, onChange, suggestions = [], placeholder = 'Add tag…', disabled }: {
  tags: string[]; onChange: (t: string[]) => void; suggestions?: string[]; placeholder?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const listId = useMemo(() => `tags-${Math.random().toString(36).slice(2)}`, []);
  const add = (raw: string) => {
    const t = raw.split(/[,;]/).map(s => s.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    const next = [...tags, ...t.filter(x => !tags.includes(x))];
    if (next.length !== tags.length) onChange(next);
    setDraft('');
  };
  return (
    <div className={clsx('flex flex-wrap items-center gap-1 p-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus-within:border-[var(--accent)]/70', disabled && 'opacity-60')}>
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-0.5 pl-1.5 pr-0.5 py-px rounded-md text-[11px] bg-[var(--bg-hover)] text-[var(--text-primary)]">
          {t}{!disabled && <button onClick={() => onChange(tags.filter(x => x !== t))} className="p-0.5 rounded hover:text-red-400" aria-label={`Remove ${t}`}><X className="w-2.5 h-2.5" /></button>}
        </span>
      ))}
      {!disabled && (
        <input value={draft} list={listId} onChange={e => { const v = e.target.value; if (/[,;]$/.test(v)) add(v); else setDraft(v); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); add(draft); }
            if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)} placeholder={tags.length ? '' : placeholder}
          className="flex-1 min-w-[80px] bg-transparent text-xs px-1 py-0.5 focus:outline-none placeholder-[var(--text-muted)]" />
      )}
      <datalist id={listId}>{suggestions.filter(s => !tags.includes(s)).slice(0, 50).map(s => <option key={s} value={s} />)}</datalist>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
      {hint && <span className="block text-[10.5px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

/** A text input that saves on blur / Enter when its value changed. */
function SaveInput({ value, onSave, placeholder, mono, list, multiline }: {
  value: string; onSave: (v: string) => void; placeholder?: string; mono?: boolean; list?: string; multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value.trim()) onSave(v.trim()); };
  const cls = clsx(btn.input, 'text-[13px]', mono && 'font-mono text-[12px]');
  return multiline
    ? <textarea value={v} onChange={e => setV(e.target.value)} onBlur={commit} rows={3} placeholder={placeholder} className={clsx(cls, 'resize-y')} />
    : <input value={v} list={list} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder} className={cls} />;
}

function MetaEditor({ meta, onSave }: { meta: Record<string, unknown>; onSave: (m: Record<string, unknown>) => void }) {
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  const parse = (s: string): unknown => { if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s); if (s === 'true' || s === 'false') return s === 'true'; return s; };
  return (
    <div className="space-y-1">
      {Object.entries(meta).map(([key, val]) => (
        <div key={key} className="flex items-center gap-1.5 text-xs">
          <span className="w-28 shrink-0 truncate font-mono text-[11px] text-[var(--text-secondary)]" title={key}>{key}</span>
          <input defaultValue={typeof val === 'string' ? val : JSON.stringify(val)} key={`${key}-${JSON.stringify(val)}`}
            onBlur={e => { const nv = parse(e.target.value.trim()); if (JSON.stringify(nv) !== JSON.stringify(val)) onSave({ [key]: e.target.value.trim() === '' ? null : nv }); }}
            className={clsx(btn.input, 'py-1 text-xs font-mono')} />
          <button className={btn.icon} title="Remove" onClick={() => onSave({ [key]: null })}><X className="w-3 h-3" /></button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input value={k} onChange={e => setK(e.target.value)} placeholder="field (e.g. frameWidth, bpm)" list="asset-meta-keys" className={clsx(btn.input, 'py-1 text-xs font-mono !w-28 shrink-0')} />
        <input value={v} onChange={e => setV(e.target.value)} placeholder="value" className={clsx(btn.input, 'py-1 text-xs font-mono')}
          onKeyDown={e => { if (e.key === 'Enter' && k.trim()) { onSave({ [k.trim()]: parse(v.trim()) }); setK(''); setV(''); } }} />
        <button className={btn.icon} disabled={!k.trim()} onClick={() => { onSave({ [k.trim()]: parse(v.trim()) }); setK(''); setV(''); }}><Plus className="w-3.5 h-3.5" /></button>
      </div>
      <datalist id="asset-meta-keys">
        {['frameWidth', 'frameHeight', 'frames', 'fps', 'tileable', 'resolution', 'bpm', 'loop', 'key', 'pivot', 'margin', 'spacing', 'notes'].map(x => <option key={x} value={x} />)}
      </datalist>
    </div>
  );
}

// ── asset drawer ────────────────────────────────────────────────────────────

function AssetDrawer({ a, tagSuggestions, onChanged, onDeleted, onClose, onUse }: {
  a: Asset; tagSuggestions: string[]; onChanged: (a: Asset) => void; onDeleted: () => void; onClose: () => void; onUse: () => void;
}) {
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const replaceInput = useRef<HTMLInputElement>(null);
  const save = async (p: AssetPatch) => {
    setErr('');
    try { onChanged(await assetsApi.patch(a.id, p)); } catch (e) { setErr(String((e as Error).message)); }
  };
  const copy = (text: string, what: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1500); }); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input,textarea') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const codePath = `/library/assets/${a.libId}/${a.path}`;
  return (
    <aside className="w-full sm:w-[400px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex flex-col min-h-0 absolute sm:static inset-0 z-20">
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)]">
        <span className="text-sm font-medium truncate flex-1">{a.title || a.path}</span>
        <button className={btn.icon} onClick={onClose} title="Close (Esc)"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <BigPreview a={a} />
        <div className="flex flex-wrap gap-1.5">
          <a className={btn.subtle} href={assetFileUrl(a, true)}><Download className="w-3.5 h-3.5" />Download</a>
          <button className={btn.subtle} onClick={onUse}><FolderInput className="w-3.5 h-3.5" />Use in project</button>
          <button className={btn.subtle} onClick={() => replaceInput.current?.click()}><Upload className="w-3.5 h-3.5" />Replace file</button>
          <input ref={replaceInput} type="file" className="hidden" onChange={async e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (f) { try { onChanged(await assetsApi.replace(a.id, f)); } catch (x) { setErr(String((x as Error).message)); } }
          }} />
        </div>
        {err && <div className="text-xs text-red-400">{err}</div>}
        <Field label="Title"><SaveInput value={a.title} onSave={v => save({ title: v })} /></Field>
        <Field label="Path in the library" hint="Folders organize the library and carry over when you import into a project.">
          <SaveInput value={a.path} mono onSave={v => v && save({ path: v })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category">
            <select value={a.category} onChange={e => save({ category: e.target.value })} className={clsx(btn.input, 'text-[13px]')}>
              {[...new Set([...CATEGORIES, a.category])].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="License"><SaveInput value={a.license} list="asset-licenses" placeholder="e.g. CC0" onSave={v => save({ license: v })} /></Field>
        </div>
        <Field label="Tags"><TagEditor tags={a.tags} suggestions={tagSuggestions} onChange={t => save({ tags: t })} /></Field>
        <Field label="Description"><SaveInput value={a.description} multiline placeholder="What it is, how to use it…" onSave={v => save({ description: v })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Author"><SaveInput value={a.author} onSave={v => save({ author: v })} /></Field>
          <Field label="Source"><SaveInput value={a.sourceUrl} placeholder="https://…" onSave={v => save({ sourceUrl: v })} /></Field>
        </div>
        <Field label="Extra fields" hint="Sprite sheets: frameWidth, frameHeight, frames, fps, spacing, margin (animates the preview). Music: bpm, loop.">
          <MetaEditor meta={a.meta} onSave={m => save({ meta: m })} />
        </Field>
        <div className="rounded-lg bg-[var(--bg-tertiary)] p-2.5 text-[11.5px] text-[var(--text-secondary)] space-y-1">
          <div>{a.kind} · {a.mime} · {fmtBytes(a.size)}{a.width ? ` · ${a.width}×${a.height}` : ''}{a.duration ? ` · ${fmtDur(a.duration)}` : ''}</div>
          <div>Added by {a.addedBy || 'unknown'}{a.jobId ? ' (scout)' : ''} · {relTime(a.createdAt)}</div>
          {a.sourceUrl && <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-[var(--accent)] hover:underline">{a.sourceUrl}</a>}
          <button onClick={() => copy(codePath, 'path')} className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-left break-all" title="Where run_code sees this file">
            {copied === 'path' ? <Check className="w-3 h-3 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}{codePath}
          </button>
          <button onClick={() => copy(a.id, 'id')} className="flex items-center gap-1 font-mono text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="The id agents use">
            {copied === 'id' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{a.id}
          </button>
        </div>
        <button className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300"
          onClick={async () => { if (confirm(`Delete ${a.path} from this library?`)) { await assetsApi.remove(a.id); onDeleted(); } }}>
          <Trash2 className="w-3.5 h-3.5" />Delete asset
        </button>
      </div>
    </aside>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function UploadDialog({ files, lib, onClose, onDone }: { files: File[]; lib: AssetLibDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const [folder, setFolder] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [license, setLicense] = useState(lib.license);
  const [author, setAuthor] = useState('');
  const [source, setSource] = useState('');
  const [unzip, setUnzip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const zips = files.filter(f => /\.(zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2)$/i.test(f.name)).length;
  const total = files.reduce((n, f) => n + f.size, 0);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await assetsApi.upload(lib.id, files, { folder, category, tags: tags.join(','), license, author, source_url: source, unzip });
      onDone(`Added ${r.added.length}` + (r.duplicates ? `, ${r.duplicates} already in the library` : '') + (r.errors.length ? `. ${r.errors.join('; ')}` : '.'));
    } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Add ${files.length} file${files.length === 1 ? '' : 's'} to ${lib.name}`} icon={<Upload className="w-4 h-4" />}>
      <div className="p-4 space-y-3">
        <div className="text-xs text-[var(--text-secondary)] max-h-24 overflow-y-auto font-mono">
          {files.slice(0, 12).map(f => <div key={f.name + f.size} className="truncate">{f.name} · {fmtBytes(f.size)}</div>)}
          {files.length > 12 && <div>…and {files.length - 12} more</div>}
          <div className="mt-1 font-sans text-[var(--text-muted)]">{fmtBytes(total)} in all</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category" hint="Blank: picked from each file type">
            <select value={category} onChange={e => setCategory(e.target.value)} className={clsx(btn.input, 'text-[13px]')}>
              <option value="">automatic</option>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Folder" hint="Blank: the category"><input value={folder} onChange={e => setFolder(e.target.value)} placeholder="e.g. sfx/ui" className={clsx(btn.input, 'font-mono text-xs')} /></Field>
        </div>
        <Field label="Tags"><TagEditor tags={tags} onChange={setTags} suggestions={Object.keys(lib.tagCounts)} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="License"><input value={license} list="asset-licenses" onChange={e => setLicense(e.target.value)} className={btn.input} /></Field>
          <Field label="Author"><input value={author} onChange={e => setAuthor(e.target.value)} className={btn.input} /></Field>
          <Field label="Source URL"><input value={source} onChange={e => setSource(e.target.value)} className={btn.input} /></Field>
        </div>
        {zips > 0 && (
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={unzip} onChange={e => setUnzip(e.target.checked)} />Unpack {zips} archive{zips === 1 ? '' : 's'} into separate assets
          </label>
        )}
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className={btn.ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={btn.primary} onClick={go} disabled={busy}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{busy ? 'Uploading…' : 'Add to library'}</button>
        </div>
      </div>
    </Modal>
  );
}

export function DispatchDialog({ open, onClose, libs, libId, agents, onQueued }: {
  open: boolean; onClose: () => void; libs: { id: string; name: string; locked?: boolean }[]; libId?: string; agents: Agent[]; onQueued: (j: AssetJob) => void;
}) {
  const [target, setTarget] = useState(libId ?? '');
  const [newName, setNewName] = useState('');
  const [brief, setBrief] = useState('');
  const [sources, setSources] = useState('');
  const [max, setMax] = useState(40);
  const [license, setLicense] = useState<LicensePolicy>('open');
  const [agentId, setAgentId] = useState('magpie');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setTarget(libId ?? (libs.find(l => !l.locked)?.id ?? '')); setErr(''); } }, [open, libId, libs]);
  const pickable = scoutAgents(agents);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const j = await assetsApi.createJob({ libId: target || undefined, libName: target ? undefined : newName.trim() || 'Scouted assets', brief,
        sources: sources.split('\n').map(s => s.trim()).filter(Boolean), agentId, maxAssets: max, license });
      setBrief(''); setSources(''); setNewName('');
      onQueued(j);
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Send an asset scout" icon={<Shapes className="w-4 h-4" />}>
      <div className="p-4 space-y-3">
        <p className="text-xs text-[var(--text-secondary)]">A scout searches the web, opens pages (in a headless browser when a site needs it), downloads and unpacks
          packs, checks what it got, and files the keepers with tags, license and credits. It works on its own in a new chat, one job at a time.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Into library">
            <select value={target} onChange={e => setTarget(e.target.value)} className={clsx(btn.input, 'text-[13px]')}>
              <option value="">+ New library…</option>
              {libs.map(l => <option key={l.id} value={l.id} disabled={l.locked}>{l.name}{l.locked ? ' (locked)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Scout">
            <select value={agentId} onChange={e => setAgentId(e.target.value)} className={clsx(btn.input, 'text-[13px]')}>
              {pickable.map(a => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ''}</option>)}
            </select>
          </Field>
        </div>
        {!target && <Field label="New library name"><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Forest platformer kit" className={btn.input} /></Field>}
        <Field label="What should it collect?">
          <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={4} className={clsx(btn.input, 'resize-y')}
            placeholder="e.g. 16×16 pixel-art forest tiles and props (trees, rocks, grass), plus 10 short UI sound effects (click, coin, jump). Bright, cheerful palette." />
        </Field>
        <Field label="Start from (optional, one URL per line)">
          <textarea value={sources} onChange={e => setSources(e.target.value)} rows={2} className={clsx(btn.input, 'font-mono text-xs resize-y')}
            placeholder={'https://opengameart.org\nhttps://kenney.nl/assets'} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Licenses">
            <select value={license} onChange={e => setLicense(e.target.value as LicensePolicy)} className={clsx(btn.input, 'text-[13px]')}>
              <option value="cc0">CC0 / public domain only</option>
              <option value="open">Open, commercial use OK (CC0, CC-BY…)</option>
              <option value="any">Anything (license recorded)</option>
            </select>
          </Field>
          <Field label="At most"><input type="number" min={1} max={500} value={max} onChange={e => setMax(Number(e.target.value) || 1)} className={btn.input} /></Field>
        </div>
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className={btn.ghost} onClick={onClose}>Cancel</button>
          <button className={btn.primary} onClick={go} disabled={busy || !brief.trim()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shapes className="w-3.5 h-3.5" />}Send scout</button>
        </div>
      </div>
    </Modal>
  );
}

function UseInProjectDialog({ libId, ids, onClose }: { libId: string; ids: string[]; onClose: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pid, setPid] = useState('');
  const [dir, setDir] = useState('assets');
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.projects().then(ps => { setProjects(ps); setPid(ps[0]?.id ?? ''); }).catch(() => {}); }, []);
  const p = projects.find(x => x.id === pid);
  return (
    <Modal open onClose={onClose} title={`Use ${ids.length} asset${ids.length === 1 ? '' : 's'} in a project`} icon={<FolderInput className="w-4 h-4" />}>
      <div className="p-4 space-y-3">
        {done ? (
          <>
            <p className="text-sm">Copied {done.length} file{done.length === 1 ? '' : 's'} into <span className="font-medium">{p?.name}</span>, with a CREDITS.md where licenses ask for one.</p>
            <div className="text-xs font-mono text-[var(--text-secondary)] max-h-32 overflow-y-auto">{done.slice(0, 30).map(s => <div key={s}>{s}</div>)}</div>
            <div className="flex justify-end gap-2">
              <button className={btn.ghost} onClick={onClose}>Close</button>
              {p && <a className={btn.primary} href={`#/${p.kind === 'code' ? 'code' : 'studio'}/${p.id}`}>Open {p.kind === 'code' ? 'in Code' : 'in Studio'}</a>}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-[var(--text-secondary)]">Projects get their own copy, so they stay self-contained and exports keep working. Agents in any chat can also
              pull assets in themselves with the asset_library tool.</p>
            <Field label="Project">
              <select value={pid} onChange={e => setPid(e.target.value)} className={clsx(btn.input, 'text-[13px]')}>
                {projects.map(x => <option key={x.id} value={x.id}>{x.kind === 'code' ? 'Code' : 'Studio'} · {x.name}</option>)}
              </select>
            </Field>
            <Field label="Folder"><input value={dir} onChange={e => setDir(e.target.value)} className={clsx(btn.input, 'font-mono text-xs')} /></Field>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={flatten} onChange={e => setFlatten(e.target.checked)} />Put files directly in the folder (drop the library's sub-folders)</label>
            {err && <div className="text-xs text-red-400">{err}</div>}
            <div className="flex justify-end gap-2">
              <button className={btn.ghost} onClick={onClose}>Cancel</button>
              <button className={btn.primary} disabled={!pid || busy} onClick={async () => {
                setBusy(true); setErr('');
                try { setDone((await assetsApi.toProject(libId, pid, ids, dir, flatten)).saved); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
              }}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderInput className="w-3.5 h-3.5" />}Copy into project</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── jobs ────────────────────────────────────────────────────────────────────

const JOB_STYLE: Record<string, string> = {
  queued: 'text-[var(--text-secondary)] bg-[var(--bg-hover)]', running: 'text-sky-500 bg-sky-500/10', done: 'text-emerald-500 bg-emerald-500/10',
  failed: 'text-red-400 bg-red-500/10', stopped: 'text-amber-500 bg-amber-500/10',
};

function JobsList({ jobs, agents, onChanged, onOpenChat, onOpenLib }: {
  jobs: AssetJob[]; agents: Agent[]; onChanged: () => void; onOpenChat: (id: string) => void; onOpenLib?: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!jobs.length) return null;
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      {jobs.map(j => {
        const agent = agents.find(a => a.id === j.agentId);
        return (
          <div key={j.id} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <AgentAvatar agent={agent} size={18} />
              <span className={clsx('px-1.5 py-px rounded text-[10px] font-medium inline-flex items-center gap-1', JOB_STYLE[j.status])}>
                {j.status === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}{j.status}
              </span>
              {onOpenLib && <button className="font-medium hover:text-[var(--accent)] truncate max-w-[30%]" onClick={() => onOpenLib(j.libId)}>{j.libName}</button>}
              <button className="flex-1 min-w-0 text-left truncate text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => setOpen(o => (o === j.id ? null : j.id))} title={j.brief}>{j.brief}</button>
              <span className="text-[var(--text-muted)] shrink-0">{j.added} added · {relTime(j.finishedAt ?? j.startedAt ?? j.createdAt)}</span>
              {j.convId && <button className={btn.icon} title="Open the scout's chat" onClick={() => onOpenChat(j.convId!)}><MessageSquare className="w-3.5 h-3.5" /></button>}
              {(j.status === 'queued' || j.status === 'running')
                ? <button className={btn.icon} title={j.status === 'running' ? 'Stop' : 'Cancel'} onClick={async () => { await assetsApi.stopJob(j.id); onChanged(); }}><X className="w-3.5 h-3.5" /></button>
                : <>
                  <button className={btn.icon} title="Run again" onClick={async () => { await assetsApi.retryJob(j.id); onChanged(); }}><RotateCw className="w-3.5 h-3.5" /></button>
                  <button className={btn.icon} title="Remove from the list" onClick={async () => { await assetsApi.deleteJob(j.id); onChanged(); }}><Trash2 className="w-3.5 h-3.5" /></button>
                </>}
            </div>
            {open === j.id && (
              <div className="mt-2 ml-7 space-y-1.5 text-[var(--text-secondary)]">
                <div className="whitespace-pre-wrap">{j.brief}</div>
                {j.sources.length > 0 && <div className="font-mono text-[11px]">{j.sources.join(' · ')}</div>}
                <div className="text-[var(--text-muted)]">Up to {j.maxAssets} · licenses: {j.license}</div>
                {j.error && <div className="text-red-400">{j.error}</div>}
                {j.result && <div className="whitespace-pre-wrap p-2 rounded-lg bg-[var(--bg-tertiary)] max-h-48 overflow-y-auto">{j.result}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── index ───────────────────────────────────────────────────────────────────

function LibCard({ l, onOpen }: { l: AssetLib; onOpen: () => void }) {
  const cats = Object.entries(l.categories);
  return (
    <button onClick={onOpen} className="group text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition overflow-hidden">
      <div className="aspect-[16/9] grid grid-cols-2 grid-rows-2 gap-px bg-[var(--border-subtle)]">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="relative bg-[var(--bg-tertiary)] overflow-hidden flex items-center justify-center" style={l.covers[i] ? CHECKER : undefined}>
            {l.covers[i] ? <img src={`/api/assets/thumb/${l.covers[i]}`} alt="" loading="lazy" className="max-w-full max-h-full object-contain p-1.5 [image-rendering:auto]" />
              : i === 0 && !l.covers.length ? <Shapes className="w-6 h-6 text-[var(--text-muted)]" /> : null}
          </div>
        ))}
      </div>
      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate flex-1 group-hover:text-[var(--accent-soft)]">{l.name}</span>
          {l.locked && <Lock className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-label="Locked" />}
          {l.forkedFrom && <GitFork className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-label="Fork" />}
        </div>
        <div className="text-[11px] text-[var(--text-muted)]">{l.count} asset{l.count === 1 ? '' : 's'} · {fmtBytes(l.bytes)} · {relTime(l.updatedAt)}</div>
        {cats.length > 0 && <div className="flex flex-wrap gap-1">{cats.slice(0, 5).map(([c, n]) => <CategoryChip key={c} c={`${c} ${n}`} className="!text-[10px]" />)}</div>}
        {l.description && <div className="text-[11.5px] text-[var(--text-secondary)] line-clamp-2">{l.description}</div>}
      </div>
    </button>
  );
}

export function AssetsIndex({ agents, live, onOpen, onOpenChat }: {
  agents: Agent[]; live?: { job: string } | null; onOpen: (id: string) => void; onOpenChat: (id: string) => void;
}) {
  const [libs, setLibs] = useState<AssetLib[] | null>(null);
  const [jobs, setJobs] = useState<AssetJob[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dispatch, setDispatch] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ total: number; assets: Asset[] } | null>(null);
  const load = useCallback(() => {
    assetsApi.libs().then(setLibs).catch(() => setLibs([]));
    assetsApi.jobs().then(setJobs).catch(() => {});
  }, []);
  useEffect(load, [load, live?.job]);
  useEffect(() => {
    if (!jobs.some(j => j.status === 'running' || j.status === 'queued')) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [jobs, load]);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => assetsApi.search(q.trim(), { limit: 120 }).then(setHits).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2"><Shapes className="w-5 h-5 text-lime-500" />Asset libraries</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">Reusable sounds, music, textures, sprites, pictures, models and fonts. Every chat, Studio design and
              Code workspace can use them, and agents can add to them, fork them or go and find more.</p>
          </div>
          <button className={btn.subtle} onClick={() => setDispatch(true)}><Shapes className="w-3.5 h-3.5" />Send a scout</button>
          <button className={btn.primary} onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" />New library</button>
        </div>
        {creating && (
          <form className="flex gap-2" onSubmit={async e => {
            e.preventDefault();
            if (!name.trim()) return;
            const l = await assetsApi.createLib({ name: name.trim() });
            setCreating(false); setName(''); onOpen(l.id);
          }}>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Library name, e.g. UI sounds" className={btn.input} />
            <button className={btn.primary} disabled={!name.trim()}>Create</button>
            <button type="button" className={btn.ghost} onClick={() => setCreating(false)}>Cancel</button>
          </form>
        )}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search every library: names, tags, categories, authors…"
            className={clsx(btn.input, 'pl-9 py-2')} />
        </div>
        {hits ? (
          <div className="space-y-2">
            <div className="text-xs text-[var(--text-muted)]">{hits.total} match{hits.total === 1 ? '' : 'es'}{hits.total > hits.assets.length ? ` (showing ${hits.assets.length})` : ''}</div>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${SIZES.m}px, 1fr))` }}>
              {hits.assets.map(a => (
                <button key={a.id} onClick={() => { location.hash = `#/assets/${a.libId}?a=${a.id}`; }}
                  className="text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] overflow-hidden">
                  <div className="relative aspect-square"><Thumb a={a} /></div>
                  <div className="p-2"><div className="text-xs font-medium truncate">{a.title || a.path}</div><div className="text-[10.5px] text-[var(--text-muted)] truncate">{a.libName}</div></div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {jobs.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Scouts</h2>
                <JobsList jobs={jobs.slice(0, 8)} agents={agents} onChanged={load} onOpenChat={onOpenChat} onOpenLib={onOpen} />
              </section>
            )}
            {libs === null ? <div className="text-sm text-[var(--text-muted)]">Loading…</div> : libs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-strong)] p-8 text-center space-y-2">
                <Shapes className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
                <div className="text-sm font-medium">No asset libraries yet</div>
                <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">Create one and drop files or .zip packs in, or send a scout to collect assets from the web for you.</p>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
                {libs.map(l => <LibCard key={l.id} l={l} onOpen={() => onOpen(l.id)} />)}
              </div>
            )}
          </>
        )}
      </div>
      <DispatchDialog open={dispatch} onClose={() => setDispatch(false)} libs={libs ?? []} agents={agents}
        onQueued={() => { setDispatch(false); load(); }} />
      <datalist id="asset-licenses">{LICENSES.map(l => <option key={l} value={l} />)}</datalist>
    </div>
  );
}

// ── one library ─────────────────────────────────────────────────────────────

export function AssetLibraryView({ libId, agents, live, onBack, onOpen, onOpenChat }: {
  libId: string; agents: Agent[]; live?: { job: string; lib: string } | null; onBack: () => void; onOpen: (id: string) => void; onOpenChat: (id: string) => void;
}) {
  const [lib, setLib] = useState<AssetLibDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [kind, setKind] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [size, setSize] = useState<Size>(() => { try { return (localStorage.getItem('shellb-asset-size') as Size) || 'm'; } catch { return 'm'; } });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('a'));
  const [pending, setPending] = useState<File[] | null>(null);
  const [drag, setDrag] = useState(false);
  const [dispatch, setDispatch] = useState(false);
  const [useIds, setUseIds] = useState<string[] | null>(null);
  const [allLibs, setAllLibs] = useState<AssetLib[]>([]);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<'name' | 'desc' | null>(null);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    assetsApi.lib(libId).then(l => { setLib(l); setMissing(false); }).catch(() => setMissing(true));
  }, [libId]);
  useEffect(() => { load(); assetsApi.libs().then(setAllLibs).catch(() => {}); }, [load]);
  const scouting = lib?.jobs.some(j => j.status === 'running') || live?.lib === libId;
  useEffect(() => {
    if (!scouting) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [scouting, load]);
  useEffect(() => { if (note) { const t = setTimeout(() => setNote(''), 6000); return () => clearTimeout(t); } }, [note]);
  useEffect(() => { try { localStorage.setItem('shellb-asset-size', size); } catch { /* storage blocked */ } }, [size]);

  const assets = lib?.assets ?? [];
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return assets.filter(a => (!cat || a.category === cat) && (!kind || a.kind === kind) && tagFilter.every(t => a.tags.includes(t))
      && words.every(w => `${a.title} ${a.path} ${a.description} ${a.tags.join(' ')} ${a.author} ${a.license} ${a.category}`.toLowerCase().includes(w)));
  }, [assets, q, cat, kind, tagFilter]);
  const cats = useMemo(() => { const m: Record<string, number> = {}; assets.forEach(a => { m[a.category] = (m[a.category] ?? 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [assets]);
  const kinds = useMemo(() => [...new Set(assets.map(a => a.kind))], [assets]);
  const topTags = useMemo(() => Object.entries(lib?.tagCounts ?? {}).sort((a, b) => b[1] - a[1]), [lib]);
  const openAsset = assets.find(a => a.id === open) ?? null;
  const selIds = [...sel].filter(id => assets.some(a => a.id === id));

  if (missing) return <div className="p-8 text-sm text-[var(--text-muted)]">This library no longer exists. <button className="text-[var(--accent)]" onClick={onBack}>Back to all libraries</button></div>;
  if (!lib) return <div className="p-8 text-sm text-[var(--text-muted)]">Loading…</div>;

  const patchLib = async (p: Parameters<typeof assetsApi.patchLib>[1]) => { await assetsApi.patchLib(lib.id, p); load(); };
  const bulk = async (b: Parameters<typeof assetsApi.bulk>[2], msg: string) => {
    const r = await assetsApi.bulk(lib.id, selIds, b);
    setNote(msg.replace('{n}', String(r.updated?.length ?? r.deleted ?? r.copied ?? selIds.length)));
    if (b.delete) setSel(new Set());
    load();
  };
  const toggle = (id: string, range: boolean) => setSel(s => {
    const x = new Set(s);
    if (range && s.size) {
      const ids = shown.map(a => a.id);
      const last = ids.findIndex(i => s.has(i));
      const at = ids.indexOf(id);
      ids.slice(Math.min(last, at), Math.max(last, at) + 1).forEach(i => x.add(i));
    } else if (x.has(id)) x.delete(id); else x.add(id);
    return x;
  });

  return (
    <div className={clsx('h-full flex min-h-0 relative', drag && 'ring-2 ring-inset ring-[var(--accent)]')}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={e => { e.preventDefault(); setDrag(false); const f = Array.from(e.dataTransfer.files); if (f.length) setPending(f); }}>
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 py-5 space-y-4">
          {/* header */}
          <div className="flex flex-wrap items-start gap-3">
            <button className={clsx(btn.icon, 'mt-0.5')} onClick={onBack} title="All libraries"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1 min-w-[220px] space-y-1">
              {editing === 'name' ? (
                <input autoFocus defaultValue={lib.name} className={clsx(btn.input, 'text-lg font-semibold')}
                  onBlur={e => { setEditing(null); if (e.target.value.trim() && e.target.value.trim() !== lib.name) patchLib({ name: e.target.value.trim() }); }}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
              ) : (
                <h1 className="text-xl font-semibold tracking-tight cursor-text flex items-center gap-2" onClick={() => setEditing('name')} title="Click to rename">
                  {lib.name}{lib.locked && <Lock className="w-4 h-4 text-[var(--text-muted)]" />}
                </h1>
              )}
              {editing === 'desc' ? (
                <textarea autoFocus defaultValue={lib.description} rows={2} className={clsx(btn.input, 'text-sm')}
                  onBlur={e => { setEditing(null); if (e.target.value.trim() !== lib.description) patchLib({ description: e.target.value.trim() }); }} />
              ) : (
                <p onClick={() => setEditing('desc')} className={clsx('text-sm cursor-text', lib.description ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)] italic')}>
                  {lib.description || 'Add a description: what this library is for, its style…'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-muted)]">
                <span>{assets.length} assets · {fmtBytes(assets.reduce((n, a) => n + a.size, 0))}</span>
                {lib.forkedFromName && <button className="inline-flex items-center gap-1 hover:text-[var(--accent)]" onClick={() => onOpen(lib.forkedFrom!)}><GitFork className="w-3 h-3" />fork of {lib.forkedFromName}</button>}
                {lib.forks.length > 0 && <span className="inline-flex items-center gap-1"><GitFork className="w-3 h-3" />{lib.forks.length} fork{lib.forks.length === 1 ? '' : 's'}:
                  {lib.forks.slice(0, 3).map(f => <button key={f.id} className="hover:text-[var(--accent)] underline-offset-2 hover:underline" onClick={() => onOpen(f.id)}>{f.name}</button>)}</span>}
                <button className="inline-flex items-center gap-1 font-mono hover:text-[var(--text-primary)]" title="Where run_code sees these files (read-only); library.json lists their metadata"
                  onClick={() => { navigator.clipboard?.writeText(lib.mount); setNote(`Copied ${lib.mount}`); }}><Copy className="w-3 h-3" />{lib.mount}</button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button className={btn.primary} onClick={() => fileInput.current?.click()}><Upload className="w-3.5 h-3.5" />Add files</button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) setPending(f); }} />
              <button className={btn.subtle} onClick={() => setDispatch(true)} disabled={lib.locked} title={lib.locked ? 'Unlock it first, or fork it' : 'Send an agent to find more assets for this library'}>
                {scouting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shapes className="w-3.5 h-3.5" />}Scout
              </button>
              <button className={btn.subtle} title="Make a copy you can change freely" onClick={async () => {
                const name = prompt('Name for the fork:', `${lib.name} (fork)`);
                if (name !== null) onOpen((await assetsApi.forkLib(lib.id, name || undefined)).id);
              }}><GitFork className="w-3.5 h-3.5" />Fork</button>
              <a className={btn.subtle} href={assetsApi.zipUrl(lib.id)} title="Everything, with library.json and CREDITS.md"><Download className="w-3.5 h-3.5" />.zip</a>
              <button className={btn.icon} onClick={() => patchLib({ locked: !lib.locked })}
                title={lib.locked ? 'Locked: agents can read and fork it but not change it. Click to unlock.' : 'Unlocked: agents may add, tag and remove assets. Click to lock.'}>
                {lib.locked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
              </button>
              <button className={clsx(btn.icon, 'hover:!text-red-400')} title="Delete library" onClick={async () => {
                if (confirm(`Delete "${lib.name}" and its ${assets.length} assets? This can't be undone.`)) { await assetsApi.deleteLib(lib.id); onBack(); }
              }}><Trash2 className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[var(--text-muted)]">Library tags</span>
            <div className="flex-1 min-w-[200px] max-w-md"><TagEditor tags={lib.tags} onChange={t => patchLib({ tags: t })} placeholder="e.g. pixel art, fantasy" /></div>
            <span className="text-[11px] text-[var(--text-muted)]">Default license</span>
            <input defaultValue={lib.license} key={lib.license} list="asset-licenses" placeholder="e.g. CC0" className={clsx(btn.input, '!w-32 py-1 text-xs')}
              onBlur={e => e.target.value.trim() !== lib.license && patchLib({ license: e.target.value.trim() })} />
          </div>

          {lib.jobs.length > 0 && <JobsList jobs={lib.jobs.slice(0, 4)} agents={agents} onChanged={load} onOpenChat={onOpenChat} />}

          {/* filters */}
          <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-[var(--bg-primary)]/90 backdrop-blur space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name, tag, author…" className={clsx(btn.input, 'pl-8 py-1.5 text-[13px]')} />
              </div>
              <select value={cat} onChange={e => setCat(e.target.value)} className={clsx(btn.input, '!w-auto py-1.5 text-xs')}>
                <option value="">All categories</option>{cats.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
              </select>
              {kinds.length > 1 && (
                <select value={kind} onChange={e => setKind(e.target.value)} className={clsx(btn.input, '!w-auto py-1.5 text-xs')}>
                  <option value="">All types</option>{kinds.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              )}
              <div className="flex rounded-lg border border-[var(--border-subtle)] overflow-hidden text-[11px]">
                {(Object.keys(SIZES) as Size[]).map(s => <button key={s} onClick={() => setSize(s)} className={clsx('px-2 py-1 uppercase', size === s ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}>{s}</button>)}
              </div>
              <button className={btn.ghost} onClick={() => setSel(s => (s.size === shown.length ? new Set() : new Set(shown.map(a => a.id))))}>
                {sel.size && sel.size === shown.length ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}Select all
              </button>
            </div>
            {topTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {topTags.slice(0, 24).map(([t, n]) => (
                  <button key={t} onClick={() => setTagFilter(f => (f.includes(t) ? f.filter(x => x !== t) : [...f, t]))}
                    className={clsx('px-2 py-0.5 rounded-full text-[11px] border transition', tagFilter.includes(t)
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] border-transparent' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
                    {t} <span className="opacity-60">{n}</span>
                  </button>
                ))}
              </div>
            )}
            {selIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 p-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--accent)]/40 text-xs">
                <span className="font-medium mr-1">{selIds.length} selected</span>
                <div className="w-48"><TagEditor tags={bulkTags} onChange={setBulkTags} suggestions={topTags.map(t => t[0])} placeholder="tags…" /></div>
                <button className={btn.subtle} disabled={!bulkTags.length} onClick={() => bulk({ patch: { addTags: bulkTags } }, 'Tagged {n} assets.').then(() => setBulkTags([]))}>Add tags</button>
                <button className={btn.subtle} disabled={!bulkTags.length} onClick={() => bulk({ patch: { removeTags: bulkTags } }, 'Untagged {n} assets.').then(() => setBulkTags([]))}>Remove tags</button>
                <select defaultValue="" onChange={e => { if (e.target.value) bulk({ patch: { category: e.target.value } }, `Set {n} to ${e.target.value}.`); e.target.value = ''; }} className={clsx(btn.input, '!w-auto py-1 text-xs')}>
                  <option value="">Category…</option>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select defaultValue="" onChange={e => { if (e.target.value) bulk({ patch: { license: e.target.value } }, `Set {n} licenses to ${e.target.value}.`); e.target.value = ''; }} className={clsx(btn.input, '!w-auto py-1 text-xs')}>
                  <option value="">License…</option>{LICENSES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select defaultValue="" onChange={e => { if (e.target.value) bulk({ copyTo: e.target.value }, 'Copied {n} into the other library.'); e.target.value = ''; }} className={clsx(btn.input, '!w-auto py-1 text-xs')}>
                  <option value="">Copy to library…</option>{allLibs.filter(l => l.id !== lib.id).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <button className={btn.subtle} onClick={() => setUseIds(selIds)}><FolderInput className="w-3.5 h-3.5" />Use in project</button>
                <a className={btn.subtle} href={assetsApi.zipUrl(lib.id, selIds)}><Download className="w-3.5 h-3.5" />.zip</a>
                <button className={clsx(btn.subtle, '!text-red-400')} onClick={() => confirm(`Delete ${selIds.length} assets?`) && bulk({ delete: true }, 'Deleted {n} assets.')}><Trash2 className="w-3.5 h-3.5" /></button>
                <button className={btn.icon} onClick={() => setSel(new Set())} title="Clear selection"><X className="w-3.5 h-3.5" /></button>
              </div>
            )}
            {note && <div className="text-xs text-emerald-500">{note}</div>}
          </div>

          {/* grid */}
          {assets.length === 0 ? (
            <button onClick={() => fileInput.current?.click()} className="w-full rounded-xl border-2 border-dashed border-[var(--border-strong)] p-10 text-center space-y-2 hover:bg-[var(--bg-secondary)]">
              <Upload className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
              <div className="text-sm font-medium">Drop files or .zip packs here</div>
              <div className="text-xs text-[var(--text-secondary)]">Images, sprite sheets, sounds, music, models, fonts… or send a scout to find some.</div>
            </button>
          ) : shown.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)] py-6 text-center">Nothing matches these filters.</div>
          ) : (
            <div className="grid gap-2.5 pb-10" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${SIZES[size]}px, 1fr))` }}>
              {shown.slice(0, 1500).map(a => {
                const on = sel.has(a.id);
                return (
                  <div key={a.id} onClick={e => (e.shiftKey || e.metaKey || e.ctrlKey || sel.size ? toggle(a.id, e.shiftKey) : setOpen(a.id))}
                    className={clsx('group relative text-left rounded-xl border bg-[var(--bg-secondary)] overflow-hidden cursor-pointer transition',
                      on ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : open === a.id ? 'border-[var(--border-strong)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]')}>
                    <div className="relative aspect-square"><Thumb a={a} /></div>
                    <button onClick={e => { e.stopPropagation(); toggle(a.id, e.shiftKey); }} aria-label="Select"
                      className={clsx('absolute top-1.5 left-1.5 p-0.5 rounded bg-[var(--bg-primary)]/80 transition', on ? 'opacity-100 text-[var(--accent)]' : 'opacity-0 group-hover:opacity-100 text-[var(--text-secondary)]')}>
                      {on ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                    <div className="p-2 space-y-1">
                      <div className="text-xs font-medium truncate" title={a.path}>{a.title || a.path}</div>
                      <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] min-w-0">
                        <CategoryChip c={a.category} />
                        <span className="truncate">{a.width ? `${a.width}×${a.height}` : a.duration ? fmtDur(a.duration) : fmtBytes(a.size)}</span>
                        {a.license && size !== 's' && <span className="ml-auto shrink-0 truncate max-w-[45%]" title={a.license}>{a.license}</span>}
                      </div>
                      {size === 'l' && a.tags.length > 0 && <div className="text-[10px] text-[var(--text-secondary)] truncate">{a.tags.join(' · ')}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {shown.length > 1500 && <div className="text-xs text-[var(--text-muted)] text-center pb-6">Showing 1,500 of {shown.length}; filter to see the rest.</div>}
        </div>
      </div>
      {openAsset && (
        <AssetDrawer key={openAsset.id} a={openAsset} tagSuggestions={topTags.map(t => t[0])} onClose={() => setOpen(null)}
          onChanged={a => setLib(l => (l ? { ...l, assets: l.assets.map(x => (x.id === a.id ? a : x)) } : l))}
          onDeleted={() => { setOpen(null); load(); }} onUse={() => setUseIds([openAsset.id])} />
      )}
      {pending && <UploadDialog files={pending} lib={lib} onClose={() => setPending(null)} onDone={msg => { setPending(null); setNote(msg); load(); }} />}
      {useIds && <UseInProjectDialog libId={lib.id} ids={useIds} onClose={() => setUseIds(null)} />}
      <DispatchDialog open={dispatch} onClose={() => setDispatch(false)} libs={allLibs.length ? allLibs : [lib]} libId={lib.id} agents={agents}
        onQueued={() => { setDispatch(false); load(); }} />
      <datalist id="asset-licenses">{LICENSES.map(l => <option key={l} value={l} />)}</datalist>
    </div>
  );
}

// ── picker for Studio / Code ────────────────────────────────────────────────

/** Browse every asset library and copy the chosen assets into a Studio or Code project. */
export function AssetPicker({ projectId, dir = 'assets', onClose, onAdded }: {
  projectId: string; dir?: string; onClose: () => void; onAdded: (paths: string[]) => void;
}) {
  const [libs, setLibs] = useState<AssetLib[]>([]);
  const [libId, setLibId] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState(dir);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { assetsApi.libs().then(ls => { setLibs(ls); setLibId(ls[0]?.id ?? ''); }).catch(() => {}); }, []);
  useEffect(() => { if (libId) { setSel(new Set()); assetsApi.lib(libId).then(l => setAssets(l.assets)).catch(() => setAssets([])); } }, [libId]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return assets.filter(a => words.every(w => `${a.title} ${a.path} ${a.tags.join(' ')} ${a.category}`.toLowerCase().includes(w)));
  }, [assets, q]);
  return (
    <Modal open onClose={onClose} title="Add from asset library" icon={<Shapes className="w-4 h-4" />} wide>
      <div className="flex h-[70vh] min-h-0">
        <div className="w-48 shrink-0 border-r border-[var(--border-subtle)] overflow-y-auto p-2 space-y-0.5 hidden sm:block">
          {libs.map(l => (
            <button key={l.id} onClick={() => setLibId(l.id)} className={clsx('w-full text-left px-2 py-1.5 rounded-lg text-xs', libId === l.id ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
              <div className="truncate font-medium">{l.name}</div><div className="text-[10px] text-[var(--text-muted)]">{l.count} assets</div>
            </button>
          ))}
          {!libs.length && <div className="text-xs text-[var(--text-muted)] p-2">No libraries yet. Make one on the <a href="#/assets" className="text-[var(--accent)]">Assets</a> page.</div>}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-2 flex gap-2 border-b border-[var(--border-subtle)]">
            <select value={libId} onChange={e => setLibId(e.target.value)} className={clsx(btn.input, 'sm:hidden !w-auto text-xs')}>{libs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…" className={clsx(btn.input, 'py-1 text-xs')} />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
              {shown.map(a => {
                const on = sel.has(a.id);
                return (
                  <button key={a.id} onClick={() => setSel(s => { const x = new Set(s); if (x.has(a.id)) x.delete(a.id); else x.add(a.id); return x; })}
                    className={clsx('text-left rounded-lg border overflow-hidden', on ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]')}>
                    <div className="relative aspect-square"><Thumb a={a} />{on && <Check className="absolute top-1 right-1 w-4 h-4 p-0.5 rounded bg-[var(--accent)] text-[var(--accent-fg)]" />}</div>
                    <div className="px-1.5 py-1 text-[11px] truncate">{a.title || a.path}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="p-2 border-t border-[var(--border-subtle)] flex items-center gap-2">
            <span className="text-xs text-[var(--text-muted)] shrink-0">Into</span>
            <input value={folder} onChange={e => setFolder(e.target.value)} className={clsx(btn.input, 'py-1 text-xs font-mono !w-40')} />
            {err && <span className="text-xs text-red-400 truncate">{err}</span>}
            <span className="flex-1" />
            <button className={btn.ghost} onClick={onClose}>Cancel</button>
            <button className={btn.primary} disabled={!sel.size || busy} onClick={async () => {
              setBusy(true); setErr('');
              try { onAdded((await assetsApi.toProject(libId, projectId, [...sel], folder || 'assets')).saved); } catch (e) { setErr(String((e as Error).message)); setBusy(false); }
            }}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Add {sel.size || ''}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
