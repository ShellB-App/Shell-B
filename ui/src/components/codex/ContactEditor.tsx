import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Briefcase, Building, Cake, Camera, Check, ExternalLink, Image as ImageIcon,
  Link2, Loader2, Mail, MapPin, Phone, Pin, Sparkles, Trash2, User, X
} from 'lucide-react';
import { api } from '../../api';
import type { CodexEntry, CodexIndex, ContactMeta } from '../../types';
import { Markdown } from '../Markdown';
import { btn, relTime } from '../common';
import { Draft, busyIndex, who } from './types';
import { IndexState, TagInput } from './Inputs';
import { ContactAvatar } from './ContactAvatar';

interface Backlink {
  id: string;
  title: string;
  kind?: string;
}

function calculateBirthdayInfo(birthdayStr?: string): string | null {
  if (!birthdayStr) return null;
  const parts = birthdayStr.split('-');
  let month = 0;
  let day = 0;
  let birthYear: number | null = null;

  if (parts.length === 3) {
    birthYear = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1;
    day = parseInt(parts[2], 10);
  } else if (parts.length === 2) {
    month = parseInt(parts[0], 10) - 1;
    day = parseInt(parts[1], 10);
  } else {
    return null;
  }

  if (isNaN(month) || isNaN(day) || month < 0 || month > 11 || day < 1 || day > 31) return null;

  const now = new Date();
  const currentYear = now.getFullYear();
  let nextBday = new Date(currentYear, month, day);

  // If birthday already passed this year (by midnight today), use next year
  const today = new Date(currentYear, now.getMonth(), now.getDate());
  if (nextBday < today) {
    nextBday = new Date(currentYear + 1, month, day);
  }

  const diffMs = nextBday.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formattedDate = `${monthNames[month]} ${day}`;

  if (diffDays === 0) {
    const ageStr = birthYear ? ` (turning ${currentYear - birthYear})` : '';
    return `🎉 Birthday today!${ageStr}`;
  }

  const ageStr = birthYear ? ` · turning ${nextBday.getFullYear() - birthYear}` : '';
  const daysStr = diffDays === 1 ? 'tomorrow' : `in ${diffDays} days`;
  return `${formattedDate} (${daysStr}${ageStr})`;
}

/** Opens, edits and creates a Contact entry. */
export function ContactEditor({ start, index, agentNames, onClose, onSaved, onDeleted }: {
  start: Draft; index: CodexIndex | null; agentNames: Record<string, string>;
  onClose: () => void; onSaved: (e: CodexEntry) => void; onDeleted: (id: string) => void;
}) {
  const [e, setE] = useState<Draft>(start);
  const [full, setFull] = useState<CodexEntry | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'notes' | 'preview'>('notes');
  const [confirmDel, setConfirmDel] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  // typed as text so a trailing comma survives; meta.aka holds the parsed list
  const [akaText, setAkaText] = useState((start.meta?.aka ?? []).join(', '));

  // Photo management state
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [photoUrlInput, setPhotoUrlInput] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [dragOverAvatar, setDragOverAvatar] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [generatingAi, setGeneratingAi] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (id: string) => {
    const f = await api.codexEntry(id);
    setFull(f);
    setE(prev => (dirty ? prev : { ...f }));
    if (!dirty) setAkaText((f.meta?.aka ?? []).join(', '));
    return f;
  }, [dirty]);

  useEffect(() => {
    if (start.id) {
      load(start.id).catch(err => setError(String(err)));
      api.codexBacklinks(start.id).then(setBacklinks).catch(() => {});
    }
  }, [start.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!full || !busyIndex(full)) return;
    const t = setTimeout(() => {
      api.codexEntry(full.id).then(f => {
        setFull(f);
        if (!dirty) setE(p => ({ ...p, title: f.title, meta: f.meta }));
        onSaved(f);
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [full, dirty, onSaved]);

  const setMeta = (patch: Partial<ContactMeta>) => {
    setE(p => ({ ...p, meta: { ...(p.meta || {}), ...patch } }));
    setDirty(true);
  };
  const set = (patch: Partial<Draft>) => { setE(p => ({ ...p, ...patch })); setDirty(true); };

  const handleFileUpload = async (file: File) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Please choose a valid image file (PNG, JPG, WebP, GIF).');
      return;
    }
    setUploadingPhoto(true);
    setError('');
    try {
      if (e.id) {
        const res = await api.uploadEntryAvatar(e.id, file);
        setMeta({ avatar: res.avatar });
        setDirty(false);
        onSaved(res.entry);
        setFull(res.entry);
      } else {
        const res = await api.uploadCodexAvatar(file);
        setMeta({ avatar: res.url });
      }
      setShowPhotoModal(false);
    } catch (err) {
      setError(`Failed to upload photo: ${String(err)}`);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleApplyUrl = async () => {
    const trimmed = photoUrlInput.trim();
    if (!trimmed) return;
    setUploadingPhoto(true);
    setError('');
    try {
      if (e.id) {
        const res = await api.setEntryAvatarUrl(e.id, trimmed);
        setMeta({ avatar: res.avatar });
        setDirty(false);
        onSaved(res.entry);
        setFull(res.entry);
      } else {
        setMeta({ avatar: trimmed });
      }
      setShowPhotoModal(false);
      setPhotoUrlInput('');
    } catch (err) {
      setError(`Failed to set avatar URL: ${String(err)}`);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleRemovePhoto = async () => {
    setUploadingPhoto(true);
    setError('');
    try {
      if (e.id) {
        const res = await api.deleteEntryAvatar(e.id);
        setMeta({ avatar: '' });
        setDirty(false);
        onSaved(res.entry);
        setFull(res.entry);
      } else {
        setMeta({ avatar: '' });
      }
      setShowPhotoModal(false);
    } catch (err) {
      setError(`Failed to remove photo: ${String(err)}`);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleGenerateAiPortrait = async () => {
    setGeneratingAi(true);
    setError('');
    try {
      const prompt = aiPrompt.trim() || `Professional studio headshot portrait photography of ${e.title || 'a person'}, ${e.meta?.role || ''}, natural cinematic lighting, sharp focus, 8k uhd`;
      const res = await api.generatePortrait({
        prompt,
        name: e.title,
        role: e.meta?.role,
        entryId: e.id,
      });
      setMeta({ avatar: res.url });
      if (res.entry) {
        setDirty(false);
        onSaved(res.entry);
        setFull(res.entry);
      }
      setShowPhotoModal(false);
    } catch (err) {
      setError(`AI Portrait generation failed: ${String(err)}`);
    } finally {
      setGeneratingAi(false);
    }
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      const payload = {
        title: e.title?.trim() || 'Untitled Contact',
        body: e.body ?? '',
        tags: e.tags ?? [],
        url: e.url ?? '',
        collectionId: e.collectionId ?? '',
        pinned: e.pinned,
        meta: e.meta || {},
      };
      const saved = e.id ? await api.patchCodexEntry(e.id, payload) : await api.createCodexEntry({ ...payload, kind: 'contact' });
      setDirty(false);
      onSaved(saved);
      await load(saved.id).catch(() => {});
      setE(saved.id === e.id ? (p => ({ ...p, ...saved })) : { ...saved, body: payload.body });
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    }
    setBusy(false);
  };

  const accept = async () => {
    if (!e.id) return;
    const s = await api.patchCodexEntry(e.id, { draft: false });
    setE(p => ({ ...p, draft: false }));
    onSaved(s);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        if (dirty && !busy) save();
      } else if (ev.key === 'Escape' && !dirty && !showPhotoModal) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const allTags = (index?.tags ?? []).map(([t]) => t);
  const m = e.meta || {};
  const area = 'w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--accent)]/70 resize-y';
  const bdayInfo = calculateBirthdayInfo(m.birthday);

  return (
    <div className="fixed inset-0 z-40 md:static md:z-auto md:w-[min(48vw,660px)] md:shrink-0 md:border-l border-[var(--border-subtle)] bg-[var(--bg-primary)] flex flex-col min-h-0 animate-fade-in">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)] shrink-0">
        <User className="w-4 h-4 text-teal-400" />
        <span className="text-xs text-[var(--text-secondary)] flex-1">{e.id ? 'Contact' : 'New Contact'}{dirty && ' · unsaved'}</span>
        {e.id && (
          <button className={btn.icon} title={e.pinned ? 'Unpin' : 'Pin'} onClick={() => set({ pinned: !e.pinned })}>
            <Pin className={clsx('w-4 h-4', e.pinned && 'fill-current text-[var(--accent)]')} />
          </button>
        )}
        <button className={btn.icon} onClick={() => { if (!dirty || confirm('Discard your changes?')) onClose(); }} aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {e.draft && (
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-amber-500/35 bg-amber-500/5 text-xs">
            <span className="flex-1 min-w-[180px]">Draft added by {who(e as CodexEntry, agentNames)}. Agents can see it, but it stays a draft until you accept it.</span>
            <button className={btn.primary} onClick={accept}><Check className="w-3.5 h-3.5" />Accept</button>
          </div>
        )}

        {/* Profile Header with Avatar & Name */}
        <div className="flex items-start gap-3.5">
          {/* Interactive Profile Photo */}
          <div className="relative group shrink-0">
            <div
              onClick={() => {
                setPhotoUrlInput(m.avatar || '');
                setAiPrompt(`Professional studio portrait headshot of ${e.title || 'person'}, ${m.role || ''}, natural lighting`);
                setShowPhotoModal(true);
              }}
              onDragOver={ev => { ev.preventDefault(); setDragOverAvatar(true); }}
              onDragLeave={() => setDragOverAvatar(false)}
              onDrop={ev => {
                ev.preventDefault();
                setDragOverAvatar(false);
                const file = ev.dataTransfer.files[0];
                if (file) handleFileUpload(file);
              }}
              className={clsx(
                'cursor-pointer relative overflow-hidden rounded-2xl transition ring-offset-2 ring-offset-[var(--bg-primary)]',
                dragOverAvatar && 'ring-2 ring-teal-400 scale-105',
                'group-hover:opacity-95'
              )}
              title="Click or drag an image here to change profile photo"
            >
              <ContactAvatar
                name={e.title}
                avatar={m.avatar}
                size="2xl"
                shape="square"
                className="w-20 h-20 shadow-sm"
              />

              {/* Hover / Camera action badge */}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white p-1 text-center">
                <Camera className="w-5 h-5 mb-0.5" />
                <span className="text-[10px] font-medium leading-tight">{m.avatar ? 'Change' : 'Add photo'}</span>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={ev => {
                const f = ev.target.files?.[0];
                if (f) handleFileUpload(f);
                ev.target.value = '';
              }}
            />
          </div>

          <div className="flex-1 min-w-0">
            <input
              className="w-full bg-transparent text-xl font-semibold focus:outline-none placeholder-[var(--text-muted)]"
              value={e.title ?? ''}
              placeholder="Full Name"
              onChange={ev => set({ title: ev.target.value })}
              autoFocus={!e.id}
            />
            <input
              className="w-full bg-transparent text-xs text-[var(--text-muted)] focus:outline-none placeholder-[var(--text-muted)] mt-1"
              value={m.pronouns ?? ''}
              placeholder="Pronouns (they/them, she/her, he/him)"
              onChange={ev => setMeta({ pronouns: ev.target.value })}
            />
            <label className="flex items-baseline gap-1.5 mt-1 text-xs text-[var(--text-muted)]">
              <span className="shrink-0 text-[10px] uppercase tracking-wider">aka</span>
            <input
              className="w-full bg-transparent text-xs text-[var(--text-secondary)] focus:outline-none placeholder-[var(--text-muted)]"
              value={akaText}
              placeholder="Nicknames, comma-separated (what you call them)"
              title="Shell:B treats these names as this person in chats and memories"
              onChange={ev => {
                setAkaText(ev.target.value);
                setMeta({ aka: ev.target.value.split(',').map(s => s.trim()).filter(Boolean) });
              }}
            />
            </label>

            {/* Quick Actions (Email, Call, Web) if values present */}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {m.email && (
                <a
                  href={`mailto:${m.email}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 transition border border-teal-500/25"
                  title="Send email"
                >
                  <Mail className="w-3 h-3" />Email
                </a>
              )}
              {m.phone && (
                <a
                  href={`tel:${m.phone}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 transition border border-teal-500/25"
                  title="Call phone"
                >
                  <Phone className="w-3 h-3" />Call
                </a>
              )}
              {e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition border border-[var(--border-subtle)]"
                  title="Open site"
                >
                  <ExternalLink className="w-3 h-3" />Website
                </a>
              )}
              <button
                type="button"
                onClick={() => {
                  setPhotoUrlInput(m.avatar || '');
                  setShowPhotoModal(true);
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition"
              >
                <Camera className="w-3 h-3 text-teal-400" />
                {m.avatar ? 'Edit photo' : 'Add photo'}
              </button>
            </div>
          </div>
        </div>

        {/* Fields grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Briefcase className="w-3.5 h-3.5 text-teal-400" />Role / Job Title</span>
            <input className={btn.input} value={m.role ?? ''} placeholder="Lead Architect, Designer..." onChange={ev => setMeta({ role: ev.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Building className="w-3.5 h-3.5 text-teal-400" />Company / Organization</span>
            <input className={btn.input} value={m.company ?? ''} placeholder="Acme Inc, Studio..." onChange={ev => setMeta({ company: ev.target.value })} />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-teal-400" />Email Address</span>
            <input className={btn.input} type="email" value={m.email ?? ''} placeholder="name@example.com" onChange={ev => setMeta({ email: ev.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-teal-400" />Phone Number</span>
            <input className={btn.input} type="tel" value={m.phone ?? ''} placeholder="+1 555-0199" onChange={ev => setMeta({ phone: ev.target.value })} />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-teal-400" />Location / City</span>
            <input className={btn.input} value={m.location ?? ''} placeholder="London, UK" onChange={ev => setMeta({ location: ev.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)] flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Cake className="w-3.5 h-3.5 text-teal-400" />Birthday</span>
              {bdayInfo && <span className="text-[11px] font-medium text-teal-400 truncate max-w-[160px]">{bdayInfo}</span>}
            </span>
            <input className={btn.input} type="date" value={m.birthday ?? ''} onChange={ev => setMeta({ birthday: ev.target.value })} />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5 text-teal-400" />Website / Profile Link</span>
          <div className="flex gap-2">
            <input className={btn.input} value={e.url ?? ''} placeholder="https://github.com/... or personal site" onChange={ev => set({ url: ev.target.value })} />
            {e.url && <a className={btn.subtle} href={e.url} target="_blank" rel="noreferrer noopener"><ExternalLink className="w-3.5 h-3.5" />Open</a>}
          </div>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_1fr] gap-2">
          <select className={btn.input} value={e.collectionId ?? ''} onChange={ev => set({ collectionId: ev.target.value || null })} aria-label="Collection">
            <option value="">Unfiled</option>
            {index?.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <TagInput value={e.tags ?? []} onChange={tags => set({ tags })} all={allTags} />
        </div>

        {/* Backlinks (references in Codex Notes) */}
        {backlinks && backlinks.length > 0 && (
          <div className="p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-1.5 text-xs">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1">
              <Link2 className="w-3 h-3 text-teal-400" />Mentioned in {backlinks.length} note{backlinks.length === 1 ? '' : 's'}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {backlinks.map(b => (
                <a
                  key={b.id}
                  href={`#/codex/e/${b.id}`}
                  className="px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-teal-400 transition"
                >
                  {b.title}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Notes & Context */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--text-secondary)] flex-1">Notes & Context</span>
            {(['notes', 'preview'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  'px-2 py-0.5 rounded text-[11px]',
                  tab === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                )}
              >
                {t === 'notes' ? 'Edit' : 'Preview'}
              </button>
            ))}
          </div>
          {tab === 'notes' ? (
            <textarea
              className={clsx(area, 'min-h-[140px]')}
              value={e.body ?? ''}
              placeholder="Background, relationship context, preferences, shared projects, [[Wiki]] links to notes..."
              onChange={ev => set({ body: ev.target.value })}
            />
          ) : (
            <div
              className="min-h-[80px] px-3 py-2 rounded-lg border border-[var(--border-subtle)] cursor-text"
              onDoubleClick={() => setTab('notes')}
              title="Double-click to edit"
            >
              {e.body ? <Markdown text={e.body} /> : <span className="text-sm text-[var(--text-muted)]">No notes written yet. Double-click to edit.</span>}
            </div>
          )}
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>

      {/* Footer bar */}
      <div className="flex flex-wrap items-center gap-2 pl-4 pr-4 md:pr-16 py-2.5 border-t border-[var(--border-subtle)] shrink-0 text-[11px] text-[var(--text-muted)]">
        <span className="flex-1 min-w-[160px]">
          {e.id && full ? (
            <>
              <IndexState e={full} />
              <span className="block">Added by {who(full, agentNames)} {relTime(full.createdAt)} · edited {relTime(full.updatedAt)}</span>
            </>
          ) : 'Ctrl+S saves'}
        </span>
        {e.id && (
          confirmDel ? (
            <>
              <button className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-600 dark:text-red-300 hover:bg-red-500/30" onClick={async () => { await api.deleteCodexEntry(e.id!); onDeleted(e.id!); }}>Delete</button>
              <button className="px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => setConfirmDel(false)}>Keep</button>
            </>
          ) : (
            <button className={clsx(btn.icon, 'hover:text-red-400')} title="Delete" onClick={() => setConfirmDel(true)}>
              <Trash2 className="w-4 h-4" />
            </button>
          )
        )}
        <button className={btn.primary} disabled={busy || !dirty || !e.title?.trim()} onClick={save}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {e.id ? 'Save' : 'Add Contact'}
        </button>
      </div>

      {/* Profile Photo Modal / Dialog */}
      {showPhotoModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowPhotoModal(false)}>
          <div
            className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl p-5 space-y-4"
            onClick={ev => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-teal-400" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Contact Profile Photo</h3>
              </div>
              <button className={btn.icon} onClick={() => setShowPhotoModal(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Preview */}
            <div className="flex items-center gap-4 p-3 rounded-xl bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
              <ContactAvatar name={e.title} avatar={photoUrlInput || m.avatar} size="xl" shape="square" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{e.title || 'Untitled Contact'}</div>
                <div className="text-xs text-[var(--text-muted)] truncate">{m.role || m.company || 'Contact photo preview'}</div>
                <div className="text-[11px] text-teal-400 mt-1">
                  {m.avatar ? 'Photo is set' : 'Showing initials monogram'}
                </div>
              </div>
            </div>

            {/* Option 1: Upload from Device */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Upload image from device</span>
              <button
                type="button"
                className={clsx(btn.subtle, 'w-full justify-center gap-2 py-2')}
                disabled={uploadingPhoto}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4 text-teal-400" />}
                Choose image file (PNG, JPG, WebP)
              </button>
            </div>

            {/* Option 2: Image URL */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">Or link web image URL</span>
              <div className="flex gap-2">
                <input
                  className={clsx(btn.input, 'flex-1')}
                  placeholder="https://... photo link"
                  value={photoUrlInput}
                  onChange={ev => setPhotoUrlInput(ev.target.value)}
                />
                <button
                  type="button"
                  className={btn.primary}
                  disabled={uploadingPhoto || !photoUrlInput.trim()}
                  onClick={handleApplyUrl}
                >
                  {uploadingPhoto ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set'}
                </button>
              </div>
            </div>

            {/* Option 3: Generate AI Portrait with NYX */}
            <div className="space-y-1.5 p-3 rounded-xl border border-teal-500/25 bg-teal-500/5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-teal-400">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Generate Portrait with Local AI (NYX / FLUX)</span>
              </div>
              <input
                className={clsx(btn.input, 'w-full text-xs')}
                placeholder="Portrait prompt..."
                value={aiPrompt}
                onChange={ev => setAiPrompt(ev.target.value)}
              />
              <button
                type="button"
                className={clsx(btn.subtle, 'w-full justify-center gap-1.5 text-xs text-teal-400 border-teal-500/30 hover:bg-teal-500/10')}
                disabled={generatingAi}
                onClick={handleGenerateAiPortrait}
              >
                {generatingAi ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Generating with FLUX…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    Generate AI Portrait
                  </>
                )}
              </button>
            </div>

            {/* Option 4: Remove photo */}
            {m.avatar && (
              <div className="pt-1 border-t border-[var(--border-subtle)] flex justify-between items-center">
                <span className="text-xs text-[var(--text-muted)]">Revert to initials monogram</span>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-1.5 transition"
                  onClick={handleRemovePhoto}
                >
                  <Trash2 className="w-3.5 h-3.5" />Remove photo
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
