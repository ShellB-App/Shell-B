import { LOCALES } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, Flag, KeyRound, Link2, Loader2, LockOpen, LogOut, Mail, Pause, Play, Plus, ShieldOff, Trash2, Users } from 'lucide-react';
import { fmtBytes, req } from '../api';
import { btn, relTime } from './common';
import { toast } from './toast';
import { circlesApi, type Circle } from '../circlesApi';

/** Settings → Tools & Connectors → Guests: friends' own Shell:B on this machine (server/guests.py, guest_app.py).
 *  A one-time invite link lets a guest make an account (username and password, optional two-step codes;
 *  guest_accounts.py). They get their own chats, files and memory, local agents only, and daily limits. Nothing of
 *  yours is reachable from the guest address. Reports from "Report to Evie" land here, and so do lockouts. */

const LIMIT_FIELDS = [
  ['turnsPerDay', 'Messages a day'], ['tokensPerDay', 'Tokens a day'], ['imagesPerDay', 'Pictures a day'],
  ['audioPerDay', 'Audio clips a day'], ['storageMB', 'Space (MB)'],
] as const;
type LimitKey = typeof LIMIT_FIELDS[number][0];
type Config = Record<LimitKey, number> & { agents: string[]; tools: string[]; cell: boolean; language?: '' | 'en' | 'fr' };
interface Usage { turns: number; tokens: number; images: number; audio: number; reports: number }
interface Guest {
  id: string; name: string; created: number; disabled: boolean; config: Config; lastSeen: number | null; today: Usage;
  devices: number; chats: number; memories: number; storageBytes: number; busy: boolean; inviteExpires: number | null;
  username: string | null; email: string | null; passwordSet: boolean; twoStep: boolean; lockedUntil: number | null;
  lastSignIn: number | null; tokensTotal?: number; resetExpires: number | null;
  cellStatus: { state: 'starting' | 'running' | 'stopping' | 'stopped'; started: number | null; lastActive: number | null; error: string };
}
interface AuthEvent { ts: number; event: string; label: string; ip: string; userAgent: string; detail: string }
interface GuestSettings { models: string[]; slots: number; ownerWait: number; url: string; cellsMax: number }
interface Listing {
  guests: Guest[]; settings: GuestSettings; allowedModels: string[]; tools: string[]; newReports: number;
  agents: { id: string; name: string; title: string; model: string }[];
}
interface Report {
  id: string; guestId: string; guestName: string; created: number; text: string; convId: string | null; msgId: string | null;
  transcript: string | null; userAgent: string; status: 'new' | 'seen' | 'fixed' | 'wontfix';
}

const json = (b: unknown) => JSON.stringify(b);
const errText = (e: unknown) => String(e).replace(/^Error: \d+: /, '');
const linkFor = (url: string, code: string) => (url ? `${url}/#invite=${code}` : `#invite=${code}`);

function CopyLink({ link }: { link: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]">
      <code className="flex-1 min-w-0 truncate text-xs">{link}</code>
      <button className={btn.subtle} onClick={() => { navigator.clipboard.writeText(link); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}Copy link
      </button>
    </div>
  );
}

export function GuestsTab({ locked }: { locked: boolean }) {
  const [data, setData] = useState<Listing | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [name, setName] = useState('');
  const [circles, setCircles] = useState<Circle[]>([]);
  const [inviteCircles, setInviteCircles] = useState<string[]>([]);
  const [memberOf, setMemberOf] = useState<Record<string, string[]>>({});
  const [fresh, setFresh] = useState<{ id: string; link: string; kind: 'invite' | 'reset' } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    req<Listing>('/api/guests').then(setData).catch(() => {});
    req<Report[]>('/api/guests/reports').then(setReports).catch(() => {});
    circlesApi.index().then(i => setCircles(i.circles)).catch(() => {});
    circlesApi.people().then(r => setMemberOf(Object.fromEntries(r.people.map(p => [p.person, p.circles])))).catch(() => {});
  }, []);
  useEffect(() => { if (!locked) load(); }, [locked, load]);
  if (locked) return null;
  if (!data) return <div className="py-10 grid place-items-center"><Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" /></div>;

  const url = data.settings.url;
  const act = (p: Promise<unknown>, ok?: string) => p.then(() => { if (ok) toast(ok); load(); }, e => toast(errText(e), { kind: 'error' }));

  async function invite() {
    setBusy(true);
    try {
      const r = await req<{ guest: Guest; code: string; link: string }>('/api/guests', { method: 'POST', body: json({ name: name.trim() || 'Guest' }) });
      if (inviteCircles.length) await circlesApi.setPerson(r.guest.id, { circles: inviteCircles });
      setFresh({ id: r.guest.id, link: linkFor(url, r.code), kind: 'invite' });
      setName('');
      setInviteCircles([]);
      load();
    } catch (e) { toast(errText(e), { kind: 'error' }); }
    setBusy(false);
  }
  async function reinvite(g: Guest) {
    const r = await req<{ code: string }>(`/api/guests/${g.id}/invite`, { method: 'POST' }).catch(e => { toast(errText(e), { kind: 'error' }); return null; });
    if (r) { setFresh({ id: g.id, link: linkFor(url, r.code), kind: 'invite' }); load(); }
  }
  async function resetLink(g: Guest) {
    if (!confirm(`Make a reset link for ${g.name}? It signs them out on every device until they use it.`)) return;
    const r = await req<{ link: string }>(`/api/guests/${g.id}/reset`, { method: 'POST' }).catch(e => { toast(errText(e), { kind: 'error' }); return null; });
    if (r) { setFresh({ id: g.id, link: r.link, kind: 'reset' }); setOpen(g.id); load(); }
  }
  // server/guest_accounts.py → mailer.py: the same one-time links, sent from Shell:B's address
  async function emailLink(g: Guest) {
    if (g.passwordSet) {
      if (!g.email) { toast(`${g.name} has no email address on their account. Make a reset link and pass it on instead.`, { kind: 'error' }); return; }
      if (!confirm(`Email ${g.name} a password reset link at ${g.email}? It signs them out on every device until they use it.`)) return;
      act(req(`/api/guests/${g.id}/email-reset`, { method: 'POST' }), `Reset link sent to ${g.email}`);
    } else {
      const to = prompt(`Email an invite to ${g.name} at:`, g.email ?? '')?.trim();
      if (!to) return;
      act(req(`/api/guests/${g.id}/email-invite`, { method: 'POST', body: json({ email: to }) }), `Invite sent to ${to}`);
    }
  }
  const saveSettings = (patch: Partial<GuestSettings>) => act(req('/api/guests/settings', { method: 'PUT', body: json(patch) }));
  const models = Array.from(new Set([...data.allowedModels, ...data.agents.map(a => a.model)]));
  const unread = reports.filter(r => r.status === 'new').length;

  return (
    <div className="space-y-8 max-w-3xl">
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Users className="w-4 h-4 text-[var(--accent)]" />Shell:B Guest</h3>
        <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[70ch]">
          Friends get their own Shell:B at the guest address: their own chats, files and memory, the local agents below,
          and daily limits. Your invite link lets them choose a username and password; there's no other way to sign up. They can't reach anything of yours: the guest address only serves guest routes, cloud agents
          and Aphrodite are off, and their sandbox mounts none of your files. Their chats are stored here, on this machine.
        </p>
      </section>

      <section className="space-y-3">
        <h4 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Setup</h4>
        <label className="block text-xs text-[var(--text-secondary)]">
          Guest address <span className="text-[var(--text-muted)]">(the public URL that reaches port 8220, used in invite links)</span>
          <input className={btn.input + ' mt-1'} placeholder="https://guest.example.net" defaultValue={url}
            onBlur={e => e.target.value.trim() !== url && saveSettings({ url: e.target.value.trim() })} />
        </label>
        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-1.5">
            Models guests may use <span className="text-[var(--text-muted)]">(keep to what's usually loaded, so guests never swap out yours)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {models.map(m => {
              const on = data.allowedModels.includes(m);
              return (
                <button key={m} type="button" aria-pressed={on}
                  onClick={() => saveSettings({ models: on ? data.allowedModels.filter(x => x !== m) : [...data.allowedModels, m] })}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono border transition ${on ? 'border-[var(--accent)] bg-[var(--accent)]/15' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
                  {m}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            Agents guests see: {data.agents.filter(a => data.allowedModels.includes(a.model) && !['daedalus', 'magpie'].includes(a.id)).map(a => a.name).join(', ') || 'none'}.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs text-[var(--text-secondary)]">
            Guest replies at once
            <select className={btn.input + ' mt-1'} value={data.settings.slots} onChange={e => saveSettings({ slots: Number(e.target.value) })}>
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="block text-xs text-[var(--text-secondary)]">
            Guest containers running at once
            <select className={btn.input + ' mt-1'} value={data.settings.cellsMax ?? 3} onChange={e => saveSettings({ cellsMax: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="block text-xs text-[var(--text-secondary)]">
            Wait for your replies first, up to (seconds)
            <input type="number" min={0} max={3600} className={btn.input + ' mt-1'} defaultValue={data.settings.ownerWait}
              onBlur={e => Number(e.target.value) !== data.settings.ownerWait && saveSettings({ ownerWait: Number(e.target.value) })} />
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Invite a friend</h4>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); invite(); }}>
          <input className={btn.input} placeholder="Their name, e.g. Robin" value={name} maxLength={60} onChange={e => setName(e.target.value)} />
          <button className={btn.primary} disabled={busy}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Make invite</button>
        </form>
        <CircleChips circles={circles} picked={inviteCircles} label="Joins"
          onToggle={id => setInviteCircles(c => c.includes(id) ? c.filter(x => x !== id) : [...c, id])} />
        {fresh?.kind === 'invite' && (
          <div className="space-y-1.5">
            <CopyLink link={fresh.link} />
            <p className="text-[11px] text-[var(--text-muted)]">Shown once. It works one time, within 7 days: they choose a username and password with it.{!url && ' Set the guest address above to get a full link.'}</p>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Guests · {data.guests.length}</h4>
        {data.guests.length === 0 && <p className="text-xs text-[var(--text-muted)]">No guests yet.</p>}
        <ul className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {data.guests.map(g => (
            <li key={g.id} className="py-2.5">
              <div className="flex items-center gap-3">
                <button className="flex-1 min-w-0 text-left" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={g.disabled ? 'line-through text-[var(--text-muted)]' : ''}>{g.name}</span>
                    {g.busy && <span className="text-[10px] uppercase tracking-wider text-[var(--accent-soft)]">replying</span>}
                    {g.disabled && <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">paused</span>}
                    {g.lockedUntil && <span className="text-[10px] uppercase tracking-wider text-red-400">locked</span>}
                    {g.twoStep && <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">two-step</span>}
                    {g.config.cell ? <span className="text-[10px] uppercase tracking-wider text-[var(--accent-soft)]">own Shell:B · {g.cellStatus.state}</span>
                      : <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">guest app</span>}
                    <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-muted)] transition-transform ${open === g.id ? 'rotate-180' : ''}`} />
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    {g.username ? `@${g.username} · ` : g.lastSeen ? 'no password yet · ' : ''}
                    {g.lastSeen ? `seen ${relTime(g.lastSeen * 1000)}` : g.inviteExpires ? 'invited, not joined yet' : 'never joined'}
                    {' · '}today {g.today.turns}{g.config.turnsPerDay ? `/${g.config.turnsPerDay}` : ''} messages, {g.today.images} pictures, {g.today.audio} audio
                    {' · '}{(g.tokensTotal ?? 0).toLocaleString()} tokens in all
                    {' · '}{g.chats} chats · {fmtBytes(g.storageBytes)} · {g.devices} device{g.devices === 1 ? '' : 's'}
                  </div>
                </button>
                {g.lockedUntil && (
                  <button className={btn.icon} title="Unlock (locked after too many wrong passwords)"
                    onClick={() => act(req(`/api/guests/${g.id}/unlock`, { method: 'POST' }), `${g.name} is unlocked`)}>
                    <LockOpen className="w-3.5 h-3.5 text-red-400" />
                  </button>
                )}
                {g.passwordSet
                  ? <button className={btn.icon} title="Make a password reset link" onClick={() => resetLink(g)}><KeyRound className="w-3.5 h-3.5" /></button>
                  : <button className={btn.icon} title="New invite link" onClick={() => reinvite(g)}><Link2 className="w-3.5 h-3.5" /></button>}
                <button className={btn.icon} title={g.passwordSet ? (g.email ? `Email a reset link to ${g.email}` : 'No email address on their account') : 'Email an invite'}
                  disabled={g.passwordSet && !g.email} onClick={() => emailLink(g)}>
                  <Mail className="w-3.5 h-3.5" />
                </button>
                <button className={btn.icon} title={g.disabled ? 'Resume' : 'Pause (signs out every device)'}
                  onClick={() => act(req(`/api/guests/${g.id}`, { method: 'PATCH', body: json({ disabled: !g.disabled }) }))}>
                  {g.disabled ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                </button>
                <button className={btn.icon} title="Sign out all their devices" onClick={() => act(req(`/api/guests/${g.id}/signout`, { method: 'POST' }), `${g.name} is signed out`)}>
                  <LogOut className="w-3.5 h-3.5" />
                </button>
                <button className={btn.icon} title="Delete guest and all their data" onClick={() => {
                  if (confirm(`Delete ${g.name}? Their chats, files and memories are deleted too. This can't be undone.`))
                    act(req(`/api/guests/${g.id}`, { method: 'DELETE' }), `${g.name} deleted`);
                }}><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              {open === g.id && (
                <>
                  {fresh?.kind === 'reset' && fresh.id === g.id && (
                    <div className="mt-3 space-y-1.5">
                      <CopyLink link={fresh.link} />
                      <p className="text-[11px] text-[var(--text-muted)]">Shown once. It works one time, within 24 hours, and sets a new password. Pass it on yourself, or use the envelope to email it from Shell:B.</p>
                    </div>
                  )}
                  <div className="mt-3">
                    <CircleChips circles={circles} picked={memberOf[g.id] ?? []} label="Circles"
                      onToggle={id => {
                        const now = memberOf[g.id] ?? [];
                        const next = now.includes(id) ? now.filter(x => x !== id) : [...now, id];
                        circlesApi.setPerson(g.id, { circles: next }).then(p => setMemberOf(m => ({ ...m, [g.id]: p.circles })))
                          .catch(e => toast(errText(e), { kind: 'error' }));
                      }} />
                  </div>
                  <Account guest={g} onTwoStepOff={() => act(req(`/api/guests/${g.id}/two-step/off`, { method: 'POST' }), `Two-step sign-in is off for ${g.name}`)} />
                  <CellSwitch guest={g} onChange={cell => act(req(`/api/guests/${g.id}`, { method: 'PATCH', body: json({ config: { cell } }) }),
                    cell ? `${g.name} gets their own Shell:B on their next visit` : `${g.name} is back on the lighter guest app`)} />
                  <Limits guest={g} onSave={config => act(req(`/api/guests/${g.id}`, { method: 'PATCH', body: json({ config }) }), 'Saved')} />
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h4 className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          <Flag className="w-3.5 h-3.5" />Reports{unread ? ` · ${unread} new` : ''}
        </h4>
        {reports.length === 0 && <p className="text-xs text-[var(--text-muted)]">Nothing reported. When a guest uses Report to Evie, it shows up here and in Activity.</p>}
        <ul className="space-y-2">
          {reports.map(r => <ReportRow key={r.id} r={r} onStatus={s => act(req(`/api/guests/reports/${r.id}`, { method: 'PATCH', body: json({ status: s }) }))}
            onDelete={() => act(req(`/api/guests/reports/${r.id}`, { method: 'DELETE' }))} />)}
        </ul>
      </section>
    </div>
  );
}

function Account({ guest: g, onTwoStepOff }: { guest: Guest; onTwoStepOff: () => void }) {
  const [log, setLog] = useState<AuthEvent[] | null>(null);
  useEffect(() => { req<AuthEvent[]>(`/api/guests/${g.id}/log`).then(setLog, () => setLog([])); }, [g.id, g.lastSignIn, g.lockedUntil, g.twoStep]);
  return (
    <div className="mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] space-y-3 text-xs">
      <dl className="grid gap-x-6 gap-y-1.5 grid-cols-[auto_1fr] text-[var(--text-secondary)]">
        <dt className="text-[var(--text-muted)]">Username</dt><dd className="font-mono">{g.username ?? 'none yet: they sign in with an invite only'}</dd>
        <dt className="text-[var(--text-muted)]">Email</dt><dd>{g.email ?? '—'}</dd>
        <dt className="text-[var(--text-muted)]">Last sign-in</dt><dd>{g.lastSignIn ? relTime(g.lastSignIn * 1000) : '—'}</dd>
        <dt className="text-[var(--text-muted)]">Two-step</dt>
        <dd className="flex items-center gap-2">{g.twoStep ? 'on' : 'off'}
          {g.twoStep && (
            <button className={`${btn.ghost} -my-1`} onClick={() => confirm(`Turn off two-step sign-in for ${g.name}? Do this if they lost their phone and their recovery codes.`) && onTwoStepOff()}>
              <ShieldOff className="w-3.5 h-3.5" />Turn off
            </button>
          )}
        </dd>
        {g.lockedUntil && <><dt className="text-[var(--text-muted)]">Locked</dt><dd className="text-red-400">until {new Date(g.lockedUntil * 1000).toLocaleTimeString()}</dd></>}
        {g.resetExpires && <><dt className="text-[var(--text-muted)]">Reset link</dt><dd>unused, expires {new Date(g.resetExpires * 1000).toLocaleString()}</dd></>}
      </dl>
      <div>
        <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Sign-in log · 90 days</div>
        {!log ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" /> : log.length === 0 ? <p className="text-[var(--text-muted)]">Nothing yet.</p> : (
          <ul className="max-h-48 overflow-y-auto divide-y divide-[var(--border-subtle)]">
            {log.map((e, i) => (
              <li key={i} className="flex items-baseline gap-3 py-1">
                <span className={`flex-1 ${/failed|locked/.test(e.event) ? 'text-red-400' : ''}`}>{e.label}</span>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">{e.ip}</span>
                <span className="shrink-0 tabular-nums text-[var(--text-muted)]" title={new Date(e.ts * 1000).toLocaleString()}>{relTime(e.ts * 1000)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** docs/plans/guest-cells.md: a guest's own full Shell:B in a container (server/cells.py), the default since 2026-10-10. */
function CellSwitch({ guest: g, onChange }: { guest: Guest; onChange: (cell: boolean) => void }) {
  const s = g.cellStatus;
  return (
    <div className="mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] text-xs space-y-1.5">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={g.config.cell} onChange={e => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
        <span className="leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">
          <span className="text-[var(--text-primary)]">Their own Shell:B.</span> The full app, running as their own instance in
          a sealed container that reaches the models only through the broker: chat, Studio, Code, Codex, Library, Research,
          Shopping, Circles, pictures, voice, search, the code sandbox, live dev servers and screenshots (the broker runs
          those on this machine for them), with their own agents, memory and themes. Untick for the lighter guest app
          (chat, Notes, Circles, Wiki, Worlds, Radio); chats made in one don't show in the other.
        </span>
      </label>
      {g.config.cell && (
        <p className="pl-6 text-[var(--text-muted)]">
          {s.state === 'running' ? `Running since ${relTime((s.started ?? 0) * 1000)}, last used ${relTime((s.lastActive ?? 0) * 1000)}.`
            : s.state === 'stopped' ? 'Stopped. It starts on their next visit and stops after 30 idle minutes.' : `${s.state[0].toUpperCase()}${s.state.slice(1)}…`}
          {s.error && <span className="block text-red-400">Last start failed: {s.error}</span>}
        </p>
      )}
    </div>
  );
}

function Limits({ guest, onSave }: { guest: Guest; onSave: (c: Partial<Config>) => void }) {
  const [cfg, setCfg] = useState<Config>(guest.config);
  return (
    <div className="mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] space-y-3">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
        {LIMIT_FIELDS.map(([k, label]) => (
          <label key={k} className="block text-[11px] text-[var(--text-secondary)]">
            {label}
            <input type="number" min={0} className={btn.input + ' mt-1'} value={cfg[k]}
              onChange={e => setCfg(c => ({ ...c, [k]: Math.max(0, Number(e.target.value) || 0) }))} />
          </label>
        ))}
      </div>
      <label className="block text-[11px] text-[var(--text-secondary)] max-w-xs">
        Language
        <select className={btn.input + ' mt-1'} value={cfg.language ?? ''} onChange={e => setCfg(c => ({ ...c, language: e.target.value as Config['language'] }))}>
          <option value="">Their browser's</option>
          {LOCALES.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="block mt-1 text-[var(--text-muted)]">Their interface and their agents' replies. In their own Shell:B it is the starting choice; they can change it in Settings.</span>
      </label>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-muted)]">0 = no limit. {guest.memories} memories, {guest.today.tokens.toLocaleString()} tokens today.</span>
        <button className={btn.subtle} onClick={() => onSave(cfg)}>Save limits</button>
      </div>
    </div>
  );
}

function ReportRow({ r, onStatus, onDelete }: { r: Report; onStatus: (s: Report['status']) => void; onDelete: () => void }) {
  const [chat, setChat] = useState(false);
  return (
    <li className={`p-3 rounded-lg border ${r.status === 'new' ? 'border-[var(--accent)]/50' : 'border-[var(--border-subtle)]'}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold">{r.guestName}</span>
        <span className="text-[var(--text-muted)]">{relTime(r.created * 1000)}</span>
        <span className="ml-auto flex items-center gap-1">
          {(['seen', 'fixed', 'wontfix'] as const).map(s => (
            <button key={s} onClick={() => onStatus(r.status === s ? 'new' : s)} aria-pressed={r.status === s}
              className={`px-2 py-0.5 rounded text-[11px] border transition ${r.status === s ? 'border-[var(--accent)] bg-[var(--accent)]/15' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>
              {s === 'wontfix' ? "won't fix" : s}
            </button>
          ))}
          <button className={btn.icon} title="Delete report" onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /></button>
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap max-w-[70ch]">{r.text}</p>
      {r.transcript && (
        <>
          <button className={`${btn.ghost} mt-1 -ml-2`} onClick={() => setChat(v => !v)} aria-expanded={chat}>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${chat ? 'rotate-180' : ''}`} />{chat ? 'Hide the chat' : 'Show the chat they shared'}
          </button>
          {chat && <pre className="mt-1 max-h-80 overflow-auto p-3 rounded-lg bg-[var(--bg-tertiary)] text-[11px] leading-relaxed whitespace-pre-wrap">{r.transcript}</pre>}
        </>
      )}
      {!r.transcript && r.convId && <p className="mt-1 text-[11px] text-[var(--text-muted)]">They chose not to share the chat.</p>}
    </li>
  );
}

/** Which circles a guest is in (circles.py): they see only these circles' notes and members. */
function CircleChips({ circles, picked, label, onToggle }: { circles: Circle[]; picked: string[]; label: string; onToggle: (id: string) => void }) {
  if (!circles.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-[11px] text-[var(--text-muted)] mr-1">{label}</span>
      {circles.map(c => {
        const on = picked.includes(c.id);
        return (
          <button key={c.id} type="button" aria-pressed={on} onClick={() => onToggle(c.id)}
            className={`px-2 py-0.5 rounded-full text-[11px] border transition ${on
              ? 'border-[color:var(--accent)] text-[var(--text-primary)] bg-[var(--bg-tertiary)]'
              : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
            {on && <Check className="inline w-3 h-3 mr-0.5 -mt-px" />}{c.emoji} {c.name}
          </button>
        );
      })}
      <span className="text-[11px] text-[var(--text-muted)] ml-1">{picked.length ? '' : 'none: they won’t see any circle'}</span>
    </div>
  );
}
