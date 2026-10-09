import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Check, Cloud, EyeOff, Flag, Loader2, Pencil, Plus, Settings2, Shield, ThumbsUp,
  Trash2, UserMinus, UsersRound, VolumeX, X } from 'lucide-react';
import { btn } from './common';
import { toast } from './toast';
import { ago, circlesApi, errText, KIND_LABEL, type Circle, type CircleDetail, type CircleNote, type CirclesIndex, type Member,
  type NoteKind, type Person, type PersonRow } from '../circlesApi';
import { copyText } from '../quote';
import { CircleDraftCard, KindPicker } from './CircleCards';

/**
 * Circles (#/circles/<circle>/<note>): the people Shell:B is shared with, and the notes they choose to tell each other.
 * Everything belongs to one circle, and each person sees only their own circles (server/circles.py). Notes reach other
 * members' agents as labelled information, so the composer says who will read a note before it's shared.
 */

const MAX = 300;

const readRoute = () => {
  const m = /^#\/circles(?:\/(circle-[0-9a-f]{12}))?(?:\/(cn-[0-9a-f]{12}))?/.exec(location.hash);
  return { circle: m?.[1], note: m?.[2] };
};

export function Avatar({ p, size = 28 }: { p: Pick<Person, 'name' | 'emoji'>; size?: number }) {
  return (
    <span aria-hidden className="inline-grid place-items-center shrink-0 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] font-medium text-[var(--text-secondary)] select-none"
      style={{ width: size, height: size, fontSize: p.emoji ? size * 0.52 : size * 0.42 }}>
      {p.emoji || (p.name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function Circles() {
  const [route, setRoute] = useState(readRoute);
  const [index, setIndex] = useState<CirclesIndex | null>(null);
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [error, setError] = useState('');
  const [manage, setManage] = useState(false);

  const loadIndex = useCallback(() => circlesApi.index().then(d => { setIndex(d); setError(''); return d; })
    .catch(e => { setError(errText(e)); return null; }), []);
  useEffect(() => { loadIndex(); }, [loadIndex]);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const current = route.circle ?? index?.circles[0]?.id;
  const loadDetail = useCallback(() => {
    if (!current) { setDetail(null); return; }
    circlesApi.circle(current).then(setDetail).catch(e => { setDetail(null); setError(errText(e)); });
  }, [current]);
  useEffect(() => { loadDetail(); }, [loadDetail]);
  const reload = useCallback(() => { loadIndex(); loadDetail(); }, [loadIndex, loadDetail]);

  // shellb://circles/<circle>/<note>: scroll to the note once it's on screen
  useEffect(() => {
    if (!route.note || !detail) return;
    document.getElementById(`note-${route.note}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [route.note, detail]);

  const open = (id: string) => { location.hash = `#/circles/${id}`; setManage(false); };

  if (!index) {
    return <div className="h-full grid place-items-center text-sm text-[var(--text-muted)]">
      {error ? <p className="flex items-center gap-2 text-red-500"><AlertTriangle className="w-4 h-4" />{error}</p> : <Loader2 className="w-5 h-5 animate-spin" />}
    </div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <header className="flex flex-wrap items-end gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight leading-tight">Circles</h1>
            <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-[65ch]">
              Short notes for the people in each circle. Their agents can use them as background, labelled with who wrote them.
              Nothing crosses from one circle to another, and nobody sees a circle they aren't in.
            </p>
          </div>
          <div className="flex-1" />
          <ProfileChip me={index.me} onSaved={me => setIndex(i => i && { ...i, me })} />
        </header>
        {error && <p className="mb-4 text-sm text-red-500 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</p>}

        {index.drafts.length > 0 && (
          <section className="mb-6" aria-label="Drafts">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] mb-2">Drafts from your agents</h2>
            <div className="space-y-2">
              {index.drafts.map(d => <CircleDraftCard key={d.id} note={d} circles={index.circles} onDone={reload} />)}
            </div>
          </section>
        )}

        {index.circles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center text-sm text-[var(--text-secondary)]">
            <UsersRound className="w-6 h-6 mx-auto mb-2 text-[var(--text-muted)]" />
            You aren't in any circles yet. Whoever runs this Shell:B adds people to them.
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
            <nav aria-label="Your circles" className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-1 px-1">
              {index.circles.map(c => (
                <button key={c.id} onClick={() => open(c.id)} aria-current={c.id === current ? 'page' : undefined}
                  className={clsx('shrink-0 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
                    c.id === current ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
                  <span className="text-base leading-none w-5 text-center" aria-hidden>{c.emoji || '◯'}</span>
                  <span className="flex-1 min-w-0 truncate font-medium">{c.name}</span>
                  <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{c.notes || ''}</span>
                </button>
              ))}
              {index.isOwner && <NewCircle onMade={c => { loadIndex(); open(c.id); }} />}
            </nav>

            <main className="min-w-0">
              {!detail ? <div className="h-40 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] animate-pulse" /> : (
                <>
                  <CircleHeader c={detail} isOwner={index.isOwner} manage={manage} onManage={() => setManage(m => !m)}
                    onRecall={on => circlesApi.setRecall(detail.id, on).then(reload).catch(e => toast(errText(e), { kind: 'error' }))} />
                  {manage && index.isOwner
                    ? <ManageCircle c={detail} onChanged={reload} onDeleted={() => { setManage(false); location.hash = '#/circles'; loadIndex(); }} />
                    : (
                      <>
                        <Composer circle={detail} onShared={reload} />
                        <div className="mt-6 space-y-2">
                          {detail.notes.length === 0 && (
                            <p className="text-sm text-[var(--text-muted)] py-6 text-center">No notes in {detail.name} yet.</p>
                          )}
                          {detail.notes.map(n => <NoteCard key={n.id} n={n} isOwner={index.isOwner} highlight={n.id === route.note} onChange={reload} />)}
                        </div>
                      </>
                    )}
                </>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

function CircleHeader({ c, isOwner, manage, onManage, onRecall }: {
  c: CircleDetail; isOwner: boolean; manage: boolean; onManage: () => void; onRecall: (on: boolean) => void;
}) {
  const shown = c.members.slice(0, 8);
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2"><span aria-hidden>{c.emoji}</span>{c.name}</h2>
      <div className="flex -space-x-1.5" title={c.members.map(m => m.name).join(', ')}>
        {shown.map(m => <Avatar key={m.handle} p={m} size={24} />)}
        {c.members.length > shown.length && <span className="text-[11px] text-[var(--text-muted)] pl-3 self-center">+{c.members.length - shown.length}</span>}
      </div>
      <span className="text-xs text-[var(--text-muted)]">{c.members.length} {c.members.length === 1 ? 'person' : 'people'}</span>
      <div className="flex-1" />
      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none"
        title="Let your agents use this circle's notes as background in your chats">
        <input type="checkbox" checked={c.recall} onChange={e => onRecall(e.target.checked)} className="accent-[var(--accent)]" />
        Use in my chats
      </label>
      {isOwner && (
        <button className={clsx(btn.ghost, manage && 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]')} onClick={onManage} aria-pressed={manage}>
          <Settings2 className="w-3.5 h-3.5" /> Manage
        </button>
      )}
    </div>
  );
}

function Composer({ circle, onShared }: { circle: CircleDetail; onShared: () => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<NoteKind>('fact');
  const [until, setUntil] = useState('');
  const [cloudOk, setCloudOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const others = circle.members.filter(m => !m.me);
  const share = () => {
    setBusy(true); setWhy('');
    circlesApi.write({ circle: circle.id, text, kind, cloudOk, until: kind === 'event' && until ? until : undefined })
      .then(() => { setText(''); setUntil(''); onShared(); toast(`Shared with ${circle.name}`); })
      .catch(e => setWhy(errText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
      <textarea value={text} onChange={e => setText(e.target.value.slice(0, MAX))} rows={2}
        placeholder={`Something ${circle.name} should know: a plan, a tip, a place worth going…`}
        className="w-full resize-none bg-transparent text-sm leading-relaxed placeholder-[var(--text-muted)] focus:outline-none"
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy) share(); }} />
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <KindPicker value={kind} onChange={setKind} />
        {kind === 'event' && (
          <input type="date" value={until} onChange={e => setUntil(e.target.value)} aria-label="Event date"
            className={clsx(btn.input, '!w-auto !py-1 text-xs')} />
        )}
        {circle.settings.cloud && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer" title="Cloud agents (like Claude) may see this note">
            <input type="checkbox" checked={cloudOk} onChange={e => setCloudOk(e.target.checked)} className="accent-[var(--accent)]" />
            <Cloud className="w-3.5 h-3.5" /> Cloud OK
          </label>
        )}
        <div className="flex-1" />
        <span className={clsx('text-[11px] tabular-nums', text.length > MAX - 30 ? 'text-amber-400' : 'text-[var(--text-muted)]')}>{text.length}/{MAX}</span>
        <button className={btn.primary} disabled={!text.trim() || busy} onClick={share}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UsersRound className="w-3.5 h-3.5" />} Share with {circle.name}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">
        {others.length ? <>Seen by {listNames(others)}{circle.settings.cloud ? '' : ', and only by local agents'}.</> : 'Nobody else is in this circle yet.'}
      </p>
      {why && <p className="mt-2 text-xs text-amber-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{why}</p>}
    </div>
  );
}

function listNames(ms: Pick<Person, 'name'>[]) {
  const names = ms.map(m => m.name);
  return names.length <= 4 ? names.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function NoteCard({ n, isOwner, highlight, onChange }: { n: CircleNote; isOwner: boolean; highlight?: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.text);
  const [busy, setBusy] = useState(false);
  const act = (p: Promise<unknown>, done?: string) => {
    setBusy(true);
    p.then(() => { if (done) toast(done); onChange(); setEditing(false); })
      .catch(e => toast(errText(e), { kind: 'error' })).finally(() => setBusy(false));
  };
  const expired = n.expires && n.expires * 1000 < Date.now();
  return (
    <article id={`note-${n.id}`} className={clsx('group rounded-xl border bg-[var(--bg-secondary)] px-4 py-3 transition',
      highlight ? 'border-[color:var(--accent)]' : 'border-[var(--border-subtle)]', n.status === 'hidden' && 'opacity-70')}>
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Avatar p={n.author} size={22} />
        <span className="font-medium text-[var(--text-primary)]">{n.author.name}</span>
        <span>@{n.author.handle}</span>
        <span aria-hidden>·</span>
        <span className="uppercase tracking-wider text-[10px]">{KIND_LABEL[n.kind]}</span>
        <span aria-hidden>·</span>
        <time dateTime={new Date((n.published ?? n.created) * 1000).toISOString()}>{ago(n.published ?? n.created)}</time>
        {n.cloudOk && <span title="Cloud agents may see this note"><Cloud className="w-3 h-3" /></span>}
        {n.status === 'hidden' && <span className="flex items-center gap-1 text-amber-400"><EyeOff className="w-3 h-3" /> Hidden{n.mine ? ': edit it to share it again' : ''}</span>}
        {expired && <span className="text-amber-400">Expired</span>}
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, MAX))} rows={2} className={clsx(btn.input, 'resize-none')} />
          <div className="flex gap-2 mt-2 justify-end">
            <button className={btn.ghost} onClick={() => { setEditing(false); setText(n.text); }}>Cancel</button>
            <button className={btn.primary} disabled={busy || !text.trim()} onClick={() => act(circlesApi.edit(n.id, { text }), 'Note updated')}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 text-sm leading-relaxed max-w-[65ch] break-words">{n.text}</p>
      )}
      {!editing && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          {!n.mine && n.status === 'live' && (
            <button className={clsx(btn.ghost, n.endorsed && 'text-[var(--accent)]')} aria-pressed={n.endorsed}
              onClick={() => act(circlesApi.endorse(n.id, !n.endorsed))} title="True for me too">
              <ThumbsUp className="w-3.5 h-3.5" /> {n.endorsements || ''}
            </button>
          )}
          {n.mine && n.endorsements > 0 && <span className="px-2.5 text-[var(--text-muted)] flex items-center gap-1"><ThumbsUp className="w-3.5 h-3.5" />{n.endorsements}</span>}
          {!n.mine && !n.flagged && <FlagButton onFlag={reason => act(circlesApi.flag(n.id, reason), 'Flagged. The note’s author and moderators can see it.')} />}
          {n.flagged && <span className="px-2.5 text-[var(--text-muted)] flex items-center gap-1"><Flag className="w-3.5 h-3.5" /> Flagged</span>}
          {n.canModerate && typeof n.flags === 'number' && n.flags > 0 && <span className="px-2 text-amber-400">{n.flags} flag{n.flags > 1 ? 's' : ''}</span>}
          <div className="flex-1" />
          <button className={clsx(btn.ghost, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')} onClick={() => copyText(n.link, 'Shell:B link copied')}>Copy link</button>
          {n.mine && <button className={btn.icon} aria-label="Edit" title="Edit" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /></button>}
          {n.canModerate && !n.mine && (
            <button className={btn.ghost} onClick={() => act(circlesApi.moderate(n.id, n.status === 'hidden' ? 'live' : 'hidden'))}>
              <Shield className="w-3.5 h-3.5" /> {n.status === 'hidden' ? 'Show again' : 'Hide'}
            </button>
          )}
          {(n.mine || isOwner) && (
            <button className={btn.icon} aria-label={n.mine ? 'Retract' : 'Delete'} title={n.mine ? 'Retract: removes it for everyone' : 'Delete'}
              onClick={() => { if (confirm(n.mine ? 'Retract this note? It disappears for everyone, including their agents.' : 'Delete this note for everyone?')) act(circlesApi.remove(n.id), n.mine ? 'Retracted' : 'Deleted'); }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function FlagButton({ onFlag }: { onFlag: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <button className={btn.ghost} onClick={() => setOpen(true)}><Flag className="w-3.5 h-3.5" /> Flag</button>;
  return (
    <span className="flex items-center gap-1">
      {['Outdated', 'Wrong', 'Shouldn’t be here'].map(r => (
        <button key={r} className={clsx(btn.ghost, reason === r && 'text-[var(--text-primary)] bg-[var(--bg-tertiary)]')} onClick={() => setReason(r)}>{r}</button>
      ))}
      <button className={btn.subtle} disabled={!reason} onClick={() => { onFlag(reason); setOpen(false); }}>Flag</button>
      <button className={btn.icon} aria-label="Cancel" onClick={() => setOpen(false)}><X className="w-3.5 h-3.5" /></button>
    </span>
  );
}

function ProfileChip({ me, onSaved }: { me: Person; onSaved: (p: Person) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(me);
  const [why, setWhy] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(me), [me]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const save = () => circlesApi.me(draft).then(p => { onSaved(p); setOpen(false); setWhy(''); }).catch(e => setWhy(errText(e)));
  return (
    <div className="relative" ref={box}>
      <button className={clsx(btn.subtle, '!py-1 !pl-1')} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Avatar p={me} size={24} /><span>{me.name}</span><span className="text-[var(--text-muted)]">@{me.handle}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-20 w-72 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-2xl p-4 space-y-3">
          <p className="text-xs text-[var(--text-secondary)]">How you appear to people in your circles.</p>
          <div className="flex gap-2">
            <input value={draft.emoji} onChange={e => setDraft({ ...draft, emoji: e.target.value.slice(0, 8) })} placeholder="🙂"
              aria-label="Emoji" className={clsx(btn.input, '!w-12 text-center')} />
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} aria-label="Display name" className={btn.input} />
          </div>
          <label className="block text-xs text-[var(--text-secondary)]">Handle
            <div className="mt-1 flex items-center gap-1"><span className="text-[var(--text-muted)]">@</span>
              <input value={draft.handle} onChange={e => setDraft({ ...draft, handle: e.target.value.toLowerCase() })} className={btn.input} />
            </div>
          </label>
          <label className="block text-xs text-[var(--text-secondary)]">About you
            <textarea value={draft.bio} onChange={e => setDraft({ ...draft, bio: e.target.value.slice(0, 200) })} rows={2}
              className={clsx(btn.input, 'mt-1 resize-none')} />
          </label>
          {why && <p className="text-xs text-amber-400">{why}</p>}
          <div className="flex justify-end gap-2">
            <button className={btn.ghost} onClick={() => setOpen(false)}>Cancel</button>
            <button className={btn.primary} onClick={save}>Save profile</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewCircle({ onMade }: { onMade: (c: Circle) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  if (!open) return <button className={clsx(btn.ghost, 'shrink-0 mt-1')} onClick={() => setOpen(true)}><Plus className="w-3.5 h-3.5" /> New circle</button>;
  const make = () => circlesApi.create(name, emoji).then(c => { setOpen(false); setName(''); setEmoji(''); onMade(c); })
    .catch(e => toast(errText(e), { kind: 'error' }));
  return (
    <div className="shrink-0 mt-1 flex gap-1 items-center">
      <input value={emoji} onChange={e => setEmoji(e.target.value.slice(0, 8))} placeholder="🎲" aria-label="Emoji" className={clsx(btn.input, '!w-10 text-center !px-1')} />
      <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Name" aria-label="Circle name" className={clsx(btn.input, 'min-w-0')}
        onKeyDown={e => { if (e.key === 'Enter' && name.trim()) make(); if (e.key === 'Escape') setOpen(false); }} />
      <button className={btn.icon} aria-label="Create circle" disabled={!name.trim()} onClick={make}><Check className="w-3.5 h-3.5" /></button>
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
      <span><span className="block text-sm">{label}</span><span className="block text-xs text-[var(--text-muted)] max-w-[60ch]">{hint}</span></span>
    </label>
  );
}

/** Owner only: the circle's name and rules, and who is in it. */
function ManageCircle({ c, onChanged, onDeleted }: { c: CircleDetail; onChanged: () => void; onDeleted: () => void }) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [name, setName] = useState(c.name);
  const [emoji, setEmoji] = useState(c.emoji);
  const [peopleErr, setPeopleErr] = useState('');
  const loadPeople = useCallback(() => circlesApi.people().then(r => { setPeople(r.people); setPeopleErr(''); })
    .catch(e => setPeopleErr(/admin-key/.test(errText(e)) ? 'Sign in as the owner to add people.' : errText(e))), []);
  useEffect(() => { loadPeople(); }, [loadPeople]);
  useEffect(() => { setName(c.name); setEmoji(c.emoji); }, [c.name, c.emoji]);
  const fail = (e: unknown) => toast(errText(e), { kind: 'error' });
  const update = (b: Parameters<typeof circlesApi.update>[1]) => circlesApi.update(c.id, b).then(onChanged).catch(fail);
  const members = c.members.filter(m => m.role !== 'owner');
  const outside = useMemo(() => (people ?? []).filter(p => !p.circles.includes(c.id) && !p.disabled), [people, c.id]);
  const setRole = (person: string, role: 'member' | 'moderator' | null) =>
    circlesApi.setRole(c.id, person, role).then(() => { onChanged(); loadPeople(); }).catch(fail);

  return (
    <div className="space-y-6">
      <Section title="Circle">
        <div className="flex gap-2 max-w-md">
          <input value={emoji} onChange={e => setEmoji(e.target.value.slice(0, 8))} aria-label="Emoji" className={clsx(btn.input, '!w-12 text-center')} />
          <input value={name} onChange={e => setName(e.target.value)} aria-label="Circle name" className={btn.input} />
          <button className={btn.subtle} disabled={name === c.name && emoji === c.emoji} onClick={() => update({ name, emoji })}>Save</button>
        </div>
        <div className="mt-2 divide-y divide-[var(--border-subtle)]">
          <Toggle label="Agents may propose notes" on={c.settings.proposals} onChange={v => update({ settings: { proposals: v } })}
            hint="An agent can draft a note for this circle; the person it's chatting with publishes it or not." />
          <Toggle label="Cloud agents may read notes" on={c.settings.cloud} onChange={v => update({ settings: { cloud: v } })}
            hint="Even then, only notes whose author ticked Cloud OK. Off: notes stay with local models on this machine." />
          <label className="flex items-center gap-3 py-2 text-sm">
            Notes expire after
            <select value={c.settings.expiryDays} onChange={e => update({ settings: { expiryDays: Number(e.target.value) } })}
              className={clsx(btn.input, '!w-auto !py-1 text-xs')}>
              {[30, 90, 180, 365, 730].map(d => <option key={d} value={d}>{d < 365 ? `${d} days` : `${d / 365} year${d > 365 ? 's' : ''}`}</option>)}
            </select>
            <span className="text-xs text-[var(--text-muted)]">unless someone endorses them. Events expire after their date.</span>
          </label>
        </div>
      </Section>

      <Section title={`People in ${c.name}`}>
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          <li className="flex items-center gap-3 px-3 py-2 text-sm text-[var(--text-secondary)]">
            <Avatar p={c.members.find(m => m.role === 'owner') ?? { name: 'You', emoji: '' }} size={24} />
            <span className="flex-1">{c.members.find(m => m.role === 'owner')?.name ?? 'You'}</span>
            <span className="text-xs text-[var(--text-muted)]">Owner · in every circle</span>
          </li>
          {members.map(m => (
            <li key={m.handle} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Avatar p={m} size={24} />
              <span className="flex-1 min-w-0 truncate">{m.name} <span className="text-[var(--text-muted)]">@{m.handle}</span>
                {m.muted && <span className="ml-2 text-amber-400 text-xs">muted</span>}</span>
              <select value={m.role} onChange={e => setRole(m.person!, e.target.value as 'member' | 'moderator')} aria-label={`${m.name}'s role`}
                className={clsx(btn.input, '!w-auto !py-1 text-xs')}>
                <option value="member">Member</option>
                <option value="moderator">Moderator</option>
              </select>
              <button className={btn.icon} title={m.muted ? 'Unmute: their notes are shared again' : 'Mute: their notes are hidden and they can’t share new ones'}
                aria-label={m.muted ? 'Unmute' : 'Mute'}
                onClick={() => circlesApi.setPerson(m.person!, { muted: !m.muted }).then(() => { onChanged(); loadPeople(); }).catch(fail)}>
                <VolumeX className={clsx('w-3.5 h-3.5', m.muted && 'text-amber-400')} />
              </button>
              <button className={btn.icon} title={`Remove from ${c.name}`} aria-label={`Remove ${m.name}`} onClick={() => setRole(m.person!, null)}>
                <UserMinus className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
          {members.length === 0 && <li className="px-3 py-3 text-sm text-[var(--text-muted)]">Nobody else yet.</li>}
        </ul>
        {peopleErr && <p className="mt-3 text-xs text-[var(--text-muted)]">{peopleErr}</p>}
        {people && (outside.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">Add:</span>
            {outside.map(p => (
              <button key={p.person} className={btn.subtle} onClick={() => setRole(p.person, 'member')}>
                <Plus className="w-3 h-3" />{p.name}{p.name !== p.account ? <span className="text-[var(--text-muted)]">({p.account})</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-[var(--text-muted)]">Everyone with an account is already here. Invite more people in Settings → Tools &amp; Connectors → Guests.</p>
        ))}
      </Section>

      <Section title="Delete">
        <button className={clsx(btn.ghost, 'text-red-400 hover:text-red-300')}
          onClick={() => { if (confirm(`Delete ${c.name} and all its notes? Members stay in their other circles.`)) circlesApi.destroy(c.id).then(onDeleted).catch(fail); }}>
          <Trash2 className="w-3.5 h-3.5" /> Delete {c.name}
        </button>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] mb-2">{title}</h3>
      {children}
    </section>
  );
}
