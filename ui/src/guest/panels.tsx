import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Brain, Check, Copy, Download, Flag, Info, Laptop, Loader2, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { fmtBytes } from '../api';
import { Modal, btn, relTime } from '../components/common';
import { toast } from '../components/toast';
import { errText, guestApi, type GuestAccount, type GuestAuthEvent, type GuestMe, type GuestMemory } from './guestApi';
import { qrMatrix } from './qr';

const CATEGORY: Record<string, string> = {
  identity: 'About you', work: 'Work', preference: 'Preference', person: 'Person', project: 'Project',
  interest: 'Interest', routine: 'Routine', other: 'Other',
};

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<GuestMemory[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { guestApi.memories().then(setItems, e => setError(String(e))); }, []);

  const forget = async (id: string) => {
    setItems(xs => xs?.filter(x => x.id !== id) ?? null);
    await guestApi.forget(id).catch(e => toast(`Couldn't forget that: ${e}`, { kind: 'error' }));
  };
  const forgetAll = async () => {
    if (!confirm('Forget everything Shell:B remembers about you? This can\'t be undone.')) return;
    await guestApi.forgetAll();
    setItems([]);
  };

  return (
    <Modal open onClose={onClose} title="What Shell:B remembers about you" icon={<Brain className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">
          Shell:B picks up lasting facts you mention (your name, your work, how you like answers) so later chats start
          off knowing you. This memory is yours alone. Ask it to remember or forget something, or remove items here.
        </p>
        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
        {!items && !error && <div className="mt-6 space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-10 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />)}</div>}
        {items && items.length === 0 && (
          <p className="mt-6 text-sm text-[var(--text-muted)]">Nothing yet. Tell it something about yourself in a chat.</p>
        )}
        {items && items.length > 0 && (
          <ul className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
            {items.map(m => (
              <li key={m.id} className="group flex items-start gap-3 py-2.5">
                <span className="mt-0.5 shrink-0 w-20 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{CATEGORY[m.category] ?? m.category}</span>
                <span className="flex-1 text-sm leading-relaxed">{m.text}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)] mt-1">{relTime(m.createdAt)}</span>
                <button className={btn.icon} title="Forget this" aria-label={`Forget: ${m.text}`} onClick={() => forget(m.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {items && items.length > 0 && (
        <footer className="shrink-0 px-5 py-3 border-t border-[var(--border-subtle)] flex justify-end">
          <button className={`${btn.ghost} text-red-400 hover:text-red-300`} onClick={forgetAll}>Forget everything</button>
        </footer>
      )}
    </Modal>
  );
}

function deviceName(ua: string) {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return app ? `${app} on ${os}` : os;
}

const VIA: Record<string, string> = {
  password: 'with your password', signup: 'when you made the account', reset: 'with a reset link',
  device: 'with a device code', invite: 'with an invite',
};

export function DevicesPanel({ me, onClose, onChanged }: { me: GuestMe; onClose: () => void; onChanged: () => void }) {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [making, setMaking] = useState(false);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;

  const make = async () => {
    setMaking(true);
    try {
      const r = await guestApi.deviceCode();
      setCode({ code: r.code, until: Date.now() + r.expiresIn * 1000 });
      setNow(Date.now());
    } catch (e) { toast(String(e), { kind: 'error' }); }
    setMaking(false);
  };
  const drop = async (id: string) => {
    await guestApi.dropDevice(id).catch(e => toast(String(e), { kind: 'error' }));
    onChanged();
  };

  return (
    <Modal open onClose={onClose} title="Your devices" icon={<Laptop className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        <ul className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {me.devices.map(d => (
            <li key={d.id} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm">{deviceName(d.userAgent)}{d.current && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--accent-soft)]">this device</span>}</div>
                <div className="text-[11px] text-[var(--text-muted)]">Signed in {relTime(d.created * 1000)} {VIA[d.via] ?? ''} · last used {relTime(d.lastUsed * 1000)}</div>
              </div>
              {!d.current && <button className={btn.ghost} onClick={() => drop(d.id)}>Sign out</button>}
            </li>
          ))}
        </ul>

        <section>
          <h3 className="text-sm font-semibold tracking-tight">Add a device</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)] max-w-[60ch]">
            Make a code here, then open <span className="font-mono">{location.host}</span> on the other device and enter
            it. A code works once and expires after 10 minutes.
          </p>
          {!me.deviceCodes ? (
            <p className="mt-4 text-xs leading-relaxed text-[var(--text-muted)] max-w-[60ch]">
              Device codes can only be made on a device where you signed in with your password. Sign in on the other
              device with your username and password instead.
            </p>
          ) : code && left > 0 ? (
            <div className="mt-4 flex items-baseline gap-4">
              <span className="font-mono text-3xl tracking-[0.15em] select-all">{code.code}</span>
              <span className="text-xs text-[var(--text-muted)] tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</span>
            </div>
          ) : (
            <button className={`${btn.subtle} mt-4`} onClick={make} disabled={making}>
              {making ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {code ? 'Make a new code' : 'Make a device code'}
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function ReportPanel({ convId, msgId, onClose }: { convId?: string; msgId?: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [include, setInclude] = useState(!!convId);
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await guestApi.report({ text, convId, msgId, includeChat: include });
      toast('Sent to Evie. Thanks for telling her.');
      onClose();
    } catch (e) {
      toast(String(e).replace(/^Error: \d+: /, ''), { kind: 'error' });
      setSending(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Report to Evie" icon={<Flag className="w-4 h-4 text-[var(--accent)]" />}>
      <form className="flex-1 overflow-y-auto p-5 space-y-4" onSubmit={e => { e.preventDefault(); send(); }}>
        <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">
          Something broken, slow or strange? Say what you did and what happened. It goes straight to Evie.
        </p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={6} autoFocus maxLength={8000}
          placeholder={msgId ? 'What was wrong with this reply?' : 'What happened?'}
          className={`${btn.input} resize-y leading-relaxed`} />
        {convId && (
          <label className="flex items-start gap-2.5 text-xs leading-relaxed text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>Include this chat so Evie can see what happened. Leave it unticked to send only your note.</span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button type="submit" className={btn.primary} disabled={sending || !text.trim()}>
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flag className="w-3.5 h-3.5" />}Send report
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Meter({ label, used, cap, unit = '' }: { label: string; used: number; cap: number; unit?: string }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums text-[var(--text-muted)]">{cap ? `${used.toLocaleString()}${unit} of ${cap.toLocaleString()}${unit}` : `${used.toLocaleString()}${unit} · no limit`}</span></div>
      <div className="mt-1 h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
        <div className={pct > 90 ? 'h-full bg-red-400' : 'h-full bg-[var(--accent)]'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AboutPanel({ me, onClose }: { me: GuestMe; onClose: () => void }) {
  const l = me.limits;
  return (
    <Modal open onClose={onClose} title="About Shell:B Guest" icon={<Info className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5 space-y-6 text-sm leading-relaxed">
        <section className="space-y-2 max-w-[65ch]">
          <p>
            Shell:B runs on Evie's NVIDIA DGX Spark, not in a cloud. The models, image generator, music and voice all
            run on that one machine, and nothing you type is sent to an AI company.
          </p>
          <p className="text-[var(--text-secondary)]">
            Your chats, files and memories are kept apart from Evie's and from other guests', and the AI here can't see
            anything of hers. They are stored on her machine, though, so treat it like borrowing a friend's computer:
            don't put anything here you wouldn't want kept there. Web searches go out to the internet like any search.
          </p>
          <p className="text-[var(--text-secondary)]">
            The machine is shared. When Evie or another guest is using it, your reply may wait a moment for its turn.
          </p>
        </section>
        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Today</h3>
          <Meter label="Messages" used={me.today.turns} cap={l.turnsPerDay} />
          <Meter label="Pictures and 3D" used={me.today.images} cap={l.imagesPerDay} />
          <Meter label="Music, sound and voice" used={me.today.audio} cap={l.audioPerDay} />
          <Meter label="Space used (MB)" used={Math.round(me.storageBytes / 2 ** 20)} cap={l.storageMB} />
          <p className="text-[11px] text-[var(--text-muted)]">Daily limits reset at midnight, Evie's time. Space used: {fmtBytes(me.storageBytes)}.
            {' '}Tokens: {me.today.tokens.toLocaleString()} today, {(me.tokensTotal ?? 0).toLocaleString()} in all.</p>
        </section>
      </div>
    </Modal>
  );
}

// ── account and security ────────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-[var(--text-secondary)]">{label}</label>
      <div className="mt-1">{children(id)}</div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-3">
    <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{title}</h3>
    {children}
  </section>
);

/** An otpauth:// link as a scannable code: black on white whatever the theme, with the 4-module quiet zone. */
function QrCode({ text }: { text: string }) {
  const { path, n } = useMemo(() => {
    const m = qrMatrix(text);
    let d = '';
    m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    return { path: d, n: m.length + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className="w-44 h-44 rounded-lg shrink-0" role="img" shapeRendering="crispEdges"
      aria-label="QR code to scan with your authenticator app">
      <rect width={n} height={n} fill="#fff" /><path d={path} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Shell:B Guest recovery codes (${location.host})\nEach code works once, in place of a two-step code.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'shellb-guest-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="p-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] space-y-3">
      <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[60ch]">
        Save these somewhere safe, like a password manager. If you lose your phone, each one signs you in once instead
        of a code. They're shown only now.
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm select-all">{codes.map(c => <li key={c}>{c}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn.subtle} onClick={() => { navigator.clipboard.writeText(text); setCopied(true); }}>
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}Copy
        </button>
        <button type="button" className={btn.subtle} onClick={download}><Download className="w-3.5 h-3.5" />Download</button>
        <button type="button" className={`${btn.primary} ml-auto`} onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

function PasswordField({ id, value, onChange, fresh }: { id: string; value: string; onChange: (v: string) => void; fresh?: boolean }) {
  return <input id={id} type="password" value={value} onChange={e => onChange(e.target.value)} required maxLength={256}
    autoComplete={fresh ? 'new-password' : 'current-password'} className={btn.input} />;
}

function TwoStepSection({ acc, reload }: { acc: GuestAccount; reload: () => void }) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'scan' | 'codes' | 'off' | 'renew'>('idle');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const reset = () => { setStage('idle'); setPassword(''); setCode(''); setSetup(null); setError(''); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stage === 'confirm') run(async () => { setSetup(await guestApi.twoStepSetup(password)); setPassword(''); setStage('scan'); });
    else if (stage === 'scan') run(async () => { setCodes((await guestApi.twoStepEnable(code)).recoveryCodes); setStage('codes'); });
    else if (stage === 'off') run(async () => { await guestApi.twoStepDisable(password); toast('Two-step sign-in is off'); reset(); reload(); });
    else if (stage === 'renew') run(async () => { setCodes((await guestApi.recoveryCodes(password)).recoveryCodes); setPassword(''); setStage('codes'); });
  };

  return (
    <Section title="Two-step sign-in">
      <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[60ch]">
        {acc.twoStep || stage === 'codes'
          ? <>On. Signing in asks for a code from your authenticator app after your password. {stage === 'codes' ? '' : `${acc.recoveryLeft} recovery code${acc.recoveryLeft === 1 ? '' : 's'} left.`}</>
          : 'Off. Turn it on to need a code from an authenticator app (like Google Authenticator, 1Password or Aegis) as well as your password.'}
      </p>
      {stage === 'codes' && <RecoveryCodes codes={codes} onDone={() => { reset(); reload(); }} />}
      {stage === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {!acc.twoStep && <button type="button" className={btn.subtle} onClick={() => setStage('confirm')}><ShieldCheck className="w-3.5 h-3.5" />Set up two-step sign-in</button>}
          {acc.twoStep && <button type="button" className={btn.subtle} onClick={() => setStage('renew')}>New recovery codes</button>}
          {acc.twoStep && <button type="button" className={`${btn.ghost} text-red-400 hover:text-red-300`} onClick={() => setStage('off')}>Turn off</button>}
        </div>
      )}
      {(stage === 'confirm' || stage === 'off' || stage === 'renew' || stage === 'scan') && (
        <form className="space-y-3" onSubmit={submit}>
          {stage === 'scan' && setup ? (
            <>
              <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
                <QrCode text={setup.uri} />
                <div className="space-y-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                  <p>Scan this with your authenticator app, or type in the key:</p>
                  <p className="font-mono text-sm text-[var(--text-primary)] break-all select-all">{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
                </div>
              </div>
              <Row label="The 6-digit code the app shows">
                {id => <input id={id} value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
                  maxLength={7} required autoFocus className={`${btn.input} font-mono tracking-[0.2em] max-w-[12rem]`} />}
              </Row>
            </>
          ) : (
            <Row label="Your password" hint={stage === 'off' ? 'Turning it off makes your password the only thing needed to sign in.'
              : stage === 'renew' ? 'New codes replace the old ones, which stop working.' : undefined}>
              {id => <PasswordField id={id} value={password} onChange={setPassword} />}
            </Row>
          )}
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className={btn.primary} disabled={busy}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {stage === 'confirm' ? 'Continue' : stage === 'scan' ? 'Turn on' : stage === 'off' ? 'Turn off two-step' : 'Make new codes'}
            </button>
            <button type="button" className={btn.ghost} onClick={reset}>Cancel</button>
          </div>
        </form>
      )}
    </Section>
  );
}

function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await guestApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      toast('Password changed. Your other devices are signed out.');
      onChanged();
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  return (
    <Section title="Password">
      <form className="space-y-3 max-w-sm" onSubmit={submit}>
        <Row label="Current password">{id => <PasswordField id={id} value={current} onChange={setCurrent} />}</Row>
        <Row label="New password" hint="At least 10 characters. Changing it signs you out everywhere except here.">
          {id => <PasswordField id={id} value={next} onChange={setNext} fresh />}
        </Row>
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        <button type="submit" className={btn.subtle} disabled={busy || !current || next.length < 10}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Change password
        </button>
      </form>
    </Section>
  );
}

function Profile({ acc, onSaved }: { acc: GuestAccount; onSaved: (a: GuestAccount) => void }) {
  const [name, setName] = useState(acc.name);
  const [email, setEmail] = useState(acc.email ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== acc.name || email.trim() !== (acc.email ?? '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onSaved(await guestApi.updateAccount({ name: name.trim(), email: email.trim() }));
      toast('Saved');
    } catch (err) { toast(errText(err), { kind: 'error' }); }
    setBusy(false);
  };
  return (
    <Section title="You">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="sm:col-span-2 text-xs text-[var(--text-secondary)]">
          Username <span className="ml-1 font-mono text-sm text-[var(--text-primary)]">{acc.username}</span>
        </div>
        <Row label="Name" hint="What Shell:B calls you.">
          {id => <input id={id} value={name} onChange={e => setName(e.target.value)} maxLength={60} required className={btn.input} />}
        </Row>
        <Row label="Email (optional)" hint="Only Evie sees it.">
          {id => <input id={id} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" className={btn.input} />}
        </Row>
        <div className="sm:col-span-2">
          <button type="submit" className={btn.subtle} disabled={busy || !dirty || !name.trim()}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Save
          </button>
        </div>
      </form>
    </Section>
  );
}

function SignInLog({ log }: { log: GuestAuthEvent[] }) {
  const bad = (e: string) => /failed|locked/.test(e);
  return (
    <Section title="Recent sign-in activity">
      {log.length === 0 ? <p className="text-xs text-[var(--text-muted)]">Nothing yet.</p> : (
        <ul className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {log.map((e, i) => (
            <li key={i} className="flex items-baseline gap-3 py-2 text-xs">
              <span className={`flex-1 ${bad(e.event) ? 'text-red-400' : ''}`}>{e.label}</span>
              <span className="text-[var(--text-muted)] truncate max-w-[45%]">{[e.userAgent && deviceName(e.userAgent), e.ip].filter(Boolean).join(' · ')}</span>
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{relTime(e.ts * 1000)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-[var(--text-muted)]">Kept 90 days. If something here wasn't you, change your password and tell Evie.</p>
    </Section>
  );
}

export function AccountPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [acc, setAcc] = useState<GuestAccount | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { guestApi.account().then(setAcc, e => setError(errText(e))); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Modal open onClose={onClose} title="Account and security" icon={<UserRound className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5 space-y-8">
        {error && <p className="text-xs text-red-400">{error}</p>}
        {!acc && !error && <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-10 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />)}</div>}
        {acc && (
          <>
            <Profile acc={acc} onSaved={a => { setAcc(a); onChanged(); }} />
            <ChangePassword onChanged={() => { load(); onChanged(); }} />
            <TwoStepSection acc={acc} reload={load} />
            <SignInLog log={acc.log} />
          </>
        )}
      </div>
    </Modal>
  );
}
