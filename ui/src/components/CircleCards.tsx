import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, BadgeCheck, ChevronDown, ChevronRight, Loader2, Sparkles, UsersRound } from 'lucide-react';
import { btn } from './common';
import { toast } from './toast';
import { circlesApi, errText, KIND_LABEL, type Circle, type CircleNote, type NoteKind, type ShareKind } from '../circlesApi';
import type { Message } from '../types';
import type { MenuAction } from './ContextMenu';

/** The small Circles pieces chats show (the page itself, Circles.tsx, loads lazily). */

const MAX = 300;
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const KINDS: NoteKind[] = ['fact', 'tip', 'recommendation', 'event', 'place'];

/** An agent's proposal (or any draft): nothing is shared until its author presses Publish. Used in chats and on the page. */
export function CircleDraftCard({ note, circles, onDone }: { note: CircleNote; circles?: Circle[]; onDone?: (n: CircleNote | null) => void }) {
  const [n, setN] = useState(note);
  const [text, setText] = useState(note.text);
  const [circle, setCircle] = useState(note.circle);
  const [mine, setMine] = useState<Circle[] | null>(circles ?? null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const [gone, setGone] = useState(false);
  useEffect(() => {
    // the chat card shows what the note is now: published, edited or discarded since the reply
    circlesApi.note(note.id).then(x => { setN(x); setText(x.text); setCircle(x.circle); }).catch(() => setGone(true));
    if (!circles) circlesApi.index().then(i => setMine(i.circles)).catch(() => {});
  }, [note.id, circles]);
  const chosen = mine?.find(c => c.id === circle);
  const run = (p: Promise<CircleNote | null>, done: string) => {
    setBusy(true); setWhy('');
    p.then(x => { if (x) setN(x); else setGone(true); toast(done); onDone?.(x); })
      .catch(e => setWhy(errText(e))).finally(() => setBusy(false));
  };
  if (gone) return <div className="my-2 rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-2.5 text-xs text-[var(--text-muted)]">Circle note draft discarded.</div>;
  const live = n.status !== 'draft';
  return (
    <div className="my-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3 max-w-xl">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {live ? <BadgeCheck className="w-3.5 h-3.5 text-emerald-400" /> : <Sparkles className="w-3.5 h-3.5" />}
        {live ? <>Shared with {n.circleEmoji} {n.circleName}</> : 'Draft circle note · not shared yet'}
        <span aria-hidden>·</span>{KIND_LABEL[n.kind]}
      </div>
      {live ? (
        <p className="mt-1.5 text-sm leading-relaxed">
          {n.text} <a href={`#/circles/${n.circle}/${n.id}`} className="text-[var(--accent)] hover:underline whitespace-nowrap">Open in Circles</a>
        </p>
      ) : (
        <>
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, MAX))} rows={2} disabled={busy}
            className={clsx(btn.input, 'mt-2 resize-none')} aria-label="Note text" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
              Circle
              <select value={circle} onChange={e => setCircle(e.target.value)} className={clsx(btn.input, '!w-auto !py-1 text-xs')} disabled={busy}>
                {(mine ?? [{ id: n.circle, name: n.circleName } as Circle]).map(c => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
              </select>
            </label>
            <div className="flex-1" />
            <button className={btn.ghost} disabled={busy} onClick={() => run(circlesApi.remove(n.id).then(() => null), 'Draft discarded')}>Discard</button>
            <button className={btn.primary} disabled={busy || !text.trim()}
              onClick={() => run(circlesApi.publish(n.id, { text, circle }), `Shared with ${chosen?.name ?? n.circleName}`)}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UsersRound className="w-3.5 h-3.5" />} Publish to {chosen?.name ?? n.circleName}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">
            Everyone in {chosen?.name ?? n.circleName} ({chosen ? people(chosen.members) : 'its members'}) and their local agents will see it.
          </p>
        </>
      )}
      {why && <p className="mt-2 text-xs text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{why}</p>}
    </div>
  );
}

/** Under a reply: the circle notes its agent was given, so it's clear whose words shaped the answer. */
export function CircleNotesUsed({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const notes = message.circleNotes ?? [];
  if (!notes.length) return null;
  return (
    <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
      <button className="inline-flex items-center gap-1 hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded"
        onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <UsersRound className="w-3 h-3 text-sky-400/80" />
        Used {notes.length} circle {notes.length === 1 ? 'note' : 'notes'}
        <span className="opacity-70">· {[...new Set(notes.map(n => n.circleName))].join(', ')}</span>
      </button>
      {open && (
        <ul className="mt-1 ml-4 max-w-[65ch] space-y-0.5">
          {notes.map(n => (
            <li key={n.id} className="flex items-start gap-1.5">
              <span className="mt-[5px] w-1 h-1 rounded-full bg-current opacity-50 shrink-0" />
              <span className="min-w-0">
                <a href={`#/circles/${n.circle}/${n.id}`} className="hover:text-[var(--text-primary)]">{n.author.name} in {n.circleName}</a>: {n.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── pins: a chat or project tied to one circle, so only that circle's notes are recalled there ──────────────

let pinCache: { circles: Circle[]; pins: Record<string, string> } | null = null;

/** Load circles and pins once, for menus that are built synchronously on right-click. */
export function primeCirclePins() {
  Promise.all([circlesApi.index(), circlesApi.pins()])
    .then(([i, pins]) => { pinCache = { circles: i.circles, pins }; })
    .catch(() => { pinCache = null; });
}

/** "Circle notes from" submenu entry for a chat ('c') or project ('p', 'g'); false when there are no circles. */
export function circlePinEntry(kind: 'c' | 'p' | 'g', ref: string, icon: MenuAction['icon']): MenuAction | false {
  if (!pinCache?.circles.length) return false;
  const current = pinCache.pins[`${kind}:${ref}`];
  const pin = (circle: string | null, name: string) => circlesApi.pin(kind, ref, circle)
    .then(pins => { if (pinCache) pinCache.pins = pins; toast(circle ? `Only ${name} notes here now` : 'Notes from all your circles here'); })
    .catch(e => toast(errText(e), { kind: 'error' }));
  return {
    label: 'Circle notes from', icon, items: [
      { label: 'All my circles', checked: !current, onSelect: () => pin(null, '') },
      'sep',
      ...pinCache.circles.map(c => ({ label: `${c.emoji ? `${c.emoji} ` : ''}${c.name} only`, checked: current === c.id,
        onSelect: () => pin(c.id, c.name) })),
    ],
  };
}

export function KindPicker({ value, onChange }: { value: NoteKind; onChange: (k: NoteKind) => void }) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label="Kind of note">
      {KINDS.map(k => (
        <button key={k} role="radio" aria-checked={value === k} onClick={() => onChange(k)}
          className={clsx('px-2 py-0.5 rounded-md text-[11px] font-medium transition',
            value === k ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

/** "Share to a circle…" for a personal memory (Settings → Memory): pick the circle, see who will read it, then share. */
export function ShareToCircle({ text, onClose }: { text: string; onClose: () => void }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [circle, setCircle] = useState('');
  const [body, setBody] = useState(text.slice(0, MAX));
  const [kind, setKind] = useState<NoteKind>('fact');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  useEffect(() => { circlesApi.index().then(i => setCircles(i.circles)).catch(e => setWhy(errText(e))); }, []);
  const chosen = circles?.find(c => c.id === circle);
  const share = () => {
    setBusy(true); setWhy('');
    circlesApi.write({ circle, text: body, kind, fromMemory: true })
      .then(() => { toast(`Shared with ${chosen?.name}`); onClose(); }).catch(e => setWhy(errText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-label="Share to a circle" onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-5 space-y-3">
        <h2 className="text-base font-semibold tracking-tight">Share to a circle</h2>
        <p className="text-xs text-[var(--text-secondary)]">Your memory stays private. This shares a copy of the text, as a note from you, with one circle.</p>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Circle">
          {(circles ?? []).map(c => (
            <button key={c.id} role="radio" aria-checked={circle === c.id} onClick={() => setCircle(c.id)}
              className={clsx(btn.subtle, circle === c.id && '!border-[color:var(--accent)] !text-[var(--text-primary)]')}>{c.emoji} {c.name}</button>
          ))}
          {circles?.length === 0 && <p className="text-sm text-[var(--text-muted)]">You aren't in any circles.</p>}
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value.slice(0, MAX))} rows={3} className={clsx(btn.input, 'resize-none')} aria-label="Note text" />
        <KindPicker value={kind} onChange={setKind} />
        {chosen && <p className="text-[11px] text-[var(--text-muted)]">{people(chosen.members)} in {chosen.name} and their local agents will see it.</p>}
        {why && <p className="text-xs text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{why}</p>}
        <div className="flex justify-end gap-2">
          <button className={btn.ghost} onClick={onClose}>Cancel</button>
          <button className={btn.primary} disabled={!circle || !body.trim() || busy} onClick={share}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UsersRound className="w-3.5 h-3.5" />} {chosen ? `Share with ${chosen.name}` : 'Pick a circle'}
          </button>
        </div>
      </div>
    </div>
  );
}



// ── sharing content (phase 2): a chat, an artifact or an entry, copied into one circle ────────────────────────

export interface SharePayload { kind: ShareKind; conv?: string; artifact?: string; version?: number; codex?: string; text?: string; title: string }
const SHARE_EVENT = 'shellb:share-to-circle';

/** Menus are built synchronously, so they ask for the dialog by event; CircleShareHost (App.tsx, MobileApp.tsx) shows it. */
export function openShareToCircle(p: SharePayload) {
  window.dispatchEvent(new CustomEvent<SharePayload>(SHARE_EVENT, { detail: p }));
}

export function CircleShareHost() {
  const [p, setP] = useState<SharePayload | null>(null);
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<SharePayload>).detail);
    window.addEventListener(SHARE_EVENT, on);
    return () => window.removeEventListener(SHARE_EVENT, on);
  }, []);
  return p ? <ShareContentToCircle payload={p} onClose={() => setP(null)} /> : null;
}

const WHAT: Record<ShareKind, string> = { chat: 'this chat (its messages as text)', artifact: 'this artifact', codex: 'this Codex entry', text: 'this text' };

function ShareContentToCircle({ payload, onClose }: { payload: SharePayload; onClose: () => void }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [circle, setCircle] = useState('');
  const [title, setTitle] = useState(payload.title.slice(0, 200));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  useEffect(() => { circlesApi.index().then(i => setCircles(i.circles)).catch(e => setWhy(errText(e))); }, []);
  const chosen = circles?.find(c => c.id === circle);
  const share = () => {
    setBusy(true); setWhy('');
    circlesApi.shareContent({ ...payload, circle, title, note })
      .then(s => { toast(`Shared “${s.title}” with ${chosen?.name}`); onClose(); }).catch(e => setWhy(errText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-label="Share to a circle" onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-5 space-y-3">
        <h2 className="text-base font-semibold tracking-tight">Share to a circle</h2>
        <p className="text-xs text-[var(--text-secondary)] max-w-[50ch]">A copy of {WHAT[payload.kind]} as it is now goes to one circle; later edits stay yours. Members (and their local agents, labelled as your words) can read it, and keep their own copy. You can retract it any time.</p>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Circle">
          {(circles ?? []).map(c => (
            <button key={c.id} role="radio" aria-checked={circle === c.id} onClick={() => setCircle(c.id)}
              className={clsx(btn.subtle, circle === c.id && '!border-[color:var(--accent)] !text-[var(--text-primary)]')}>{c.emoji} {c.name}</button>
          ))}
          {circles?.length === 0 && <p className="text-sm text-[var(--text-muted)]">You aren't in any circles.</p>}
        </div>
        <input value={title} onChange={e => setTitle(e.target.value.slice(0, 200))} className={btn.input} aria-label="Title" placeholder="Title" />
        <textarea value={note} onChange={e => setNote(e.target.value.slice(0, 300))} rows={2} className={clsx(btn.input, 'resize-none')} aria-label="A note for the circle" placeholder="A line about it, for the circle (optional)" />
        {chosen && <p className="text-[11px] text-[var(--text-muted)]">{chosen.members} people in {chosen.name} will see it.</p>}
        {why && <p className="text-xs text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{why}</p>}
        <div className="flex justify-end gap-2">
          <button className={btn.ghost} onClick={onClose}>Cancel</button>
          <button className={btn.primary} disabled={!circle || !title.trim() || busy} onClick={share}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UsersRound className="w-3.5 h-3.5" />} {chosen ? `Share with ${chosen.name}` : 'Pick a circle'}
          </button>
        </div>
      </div>
    </div>
  );
}
