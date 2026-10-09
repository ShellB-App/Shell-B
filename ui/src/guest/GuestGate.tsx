import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { AUTH_LOST, setFrameKey } from '../api';
import { btn } from '../components/common';
import { errText, guestApi, type CodeInfo, type GuestMe, type SignInResult } from './guestApi';

// Signing in to Shell:B Guest (server/guest_accounts.py). An invite link (#invite=) makes the account, a reset link
// (#reset=) sets a new password, and a device code signs in one more device. Accounts made before passwords existed
// land on "Choose a username and password" until they do.

/** The code in an invite or reset link: https://…/#invite=<code> or #reset=<code> */
const linkInHash = (): { kind: 'invite' | 'reset'; code: string } | null => {
  const m = /[#&](invite|reset)=([\w-]+)/.exec(location.hash);
  return m ? { kind: m[1] as 'invite' | 'reset', code: m[2] } : null;
};
const clearHash = () => history.replaceState(null, '', location.pathname);
const PASSWORD_HINT = 'At least 10 characters. A few unrelated words make a strong one that is easy to remember.';

/** Signed in, or the screens that get there. */
export function GuestGate({ children }: { children: (me: GuestMe, refresh: () => void) => ReactNode }) {
  const [me, setMe] = useState<GuestMe | null>(null);
  const [state, setState] = useState<'checking' | 'out' | 'setup' | 'in' | 'offline'>('checking');
  const [name, setName] = useState('');

  const check = useCallback(async () => {
    try {
      const info = await guestApi.authMe();
      if (!info.authenticated) { setFrameKey(null); setMe(null); setState('out'); return; }
      if (info.needsAccount) { setFrameKey(null); setName(info.guest?.name ?? ''); setState('setup'); return; }
      if (info.cell) { location.replace('/'); return; }  // their own Shell:B: the gateway now serves its full UI
      setFrameKey(info.frameKey);
      setMe(await guestApi.me());
      setState('in');
    } catch {
      setState(s => (s === 'in' ? s : 'offline'));
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    const lost = () => { check(); };
    window.addEventListener(AUTH_LOST, lost);
    return () => window.removeEventListener(AUTH_LOST, lost);
  }, [check]);

  if (state === 'checking') {
    return <div className="h-full grid place-items-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
  }
  if (state === 'in' && me) return <>{children(me, check)}</>;
  if (state === 'setup') return <ChooseAccount name={name} onDone={check} />;
  return <Welcome offline={state === 'offline'} onIn={check} />;
}

function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="min-h-full flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Private AI on a friend's machine</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight leading-[1.1] text-[var(--text-primary)]">Shell:B</h1>
        {children}
        {footer && (
          <div className="mt-10 flex gap-3 text-xs leading-relaxed text-[var(--text-muted)] border-t border-[var(--border-subtle)] pt-4">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent-soft)]" aria-hidden />
            <p>{footer}</p>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-[var(--text-secondary)]">{label}</label>
      <div className="mt-1">{children(id)}</div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

function PasswordInput({ id, value, onChange, fresh, autoFocus }: {
  id: string; value: string; onChange: (v: string) => void; fresh?: boolean; autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} required
        autoComplete={fresh ? 'new-password' : 'current-password'} minLength={fresh ? 10 : undefined} maxLength={256}
        className={`${btn.input} pr-9`} autoFocus={autoFocus} spellCheck={false} />
      <button type="button" onClick={() => setShow(v => !v)} className={`${btn.icon} absolute right-1 top-1/2 -translate-y-1/2`}
        aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function Remember({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2.5 text-xs leading-relaxed text-[var(--text-secondary)] cursor-pointer">
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
      <span>Remember me on this device for 30 days. Leave it off on a shared computer: you'll be signed out after 12 hours.</span>
    </label>
  );
}

function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" className={`${btn.primary} w-full py-2`} disabled={busy || disabled}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}{children}
    </button>
  );
}

const Alert = ({ text }: { text: string }) =>
  text ? <p role="alert" className="text-xs leading-relaxed text-red-400">{text}</p> : null;

type Screen =
  | { at: 'signin'; username?: string; note?: string }
  | { at: 'device' }
  | { at: 'link' }
  | { at: 'invite'; code: string; name: string }
  | { at: 'reset'; code: string; name: string; username: string | null }
  | { at: 'twostep'; ticket: string };

function Welcome({ offline, onIn }: { offline: boolean; onIn: () => void }) {
  const [screen, setScreen] = useState<Screen>(() => (linkInHash() ? { at: 'link' } : { at: 'signin' }));
  const [error, setError] = useState(offline ? "Can't reach Shell:B right now. The machine may be asleep: try again in a bit." : '');
  const [busy, setBusy] = useState(false);

  // a link opens the form it's for, greeting the guest by name; nothing is spent until they submit
  useEffect(() => {
    const link = linkInHash();
    if (!link || offline) return;
    guestApi.codeInfo(link.code).then((info: CodeInfo) => {
      if (info.kind === 'invite') setScreen({ at: 'invite', code: link.code, name: info.name });
      else if (info.kind === 'reset') setScreen({ at: 'reset', code: link.code, name: info.name, username: info.username });
      else { clearHash(); setScreen({ at: 'signin', username: info.username ?? '', note: `Welcome back, ${info.name}. Your account is already set up: sign in with it.` }); }
    }, e => { clearHash(); setError(errText(e)); setScreen({ at: 'signin' }); });
  }, [offline]);

  /** Run one sign-in step: signed in, or on to the two-step code. */
  const step = async (run: () => Promise<SignInResult>) => {
    setBusy(true);
    setError('');
    try {
      const r = await run();
      if ('ticket' in r) { setScreen({ at: 'twostep', ticket: r.ticket }); setBusy(false); return; }
      clearHash();
      onIn();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const go = (s: Screen) => { setError(''); setScreen(s); };

  if (screen.at === 'link') {
    return <Shell><div className="mt-10"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div></Shell>;
  }
  if (screen.at === 'invite') return <CreateAccount {...screen} busy={busy} error={error} step={step} />;
  if (screen.at === 'reset') return <ResetPassword {...screen} busy={busy} error={error} step={step} />;
  if (screen.at === 'twostep') return <TwoStep ticket={screen.ticket} busy={busy} error={error} step={step} back={() => go({ at: 'signin' })} />;
  if (screen.at === 'device') return <DeviceCode error={error} back={() => go({ at: 'signin' })} onIn={onIn} />;
  return <SignIn initial={screen.username} note={screen.note} busy={busy} error={error} step={step} toDevice={() => go({ at: 'device' })} />;
}

type Step = (run: () => Promise<SignInResult>) => Promise<void>;

function SignIn({ initial, note, busy, error, step, toDevice }: {
  initial?: string; note?: string; busy: boolean; error: string; step: Step; toDevice: () => void;
}) {
  const [username, setUsername] = useState(initial ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const submit = (e: FormEvent) => { e.preventDefault(); step(() => guestApi.login(username.trim(), password, remember)); };
  return (
    <Shell footer="Forgot your password? Ask Evie for a reset link. New here? You need an invite from her.">
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        {note ?? "Chat, draw, compose music and run code on Evie's DGX Spark. Your space here is your own."}
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <Field label="Username">
          {id => <input id={id} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required
            autoCapitalize="none" spellCheck={false} className={btn.input} autoFocus={!initial} />}
        </Field>
        <Field label="Password">{id => <PasswordInput id={id} value={password} onChange={setPassword} autoFocus={!!initial} />}</Field>
        <Remember value={remember} onChange={setRemember} />
        <Alert text={error} />
        <Submit busy={busy} disabled={!username.trim() || !password}>Sign in</Submit>
      </form>
      <button type="button" onClick={toDevice} className={`${btn.ghost} mt-3 -ml-2.5`}>
        <KeyRound className="w-3.5 h-3.5" />Use a device code from your other device
      </button>
    </Shell>
  );
}

function TwoStep({ ticket, busy, error, step, back }: { ticket: string; busy: boolean; error: string; step: Step; back: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); step(() => guestApi.twoStep(ticket, code)); };
  return (
    <Shell>
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        {recovery ? 'Enter one of the recovery codes you saved when you turned on two-step sign-in. Each works once.'
          : 'Open your authenticator app and enter the 6-digit code for Shell:B Guest.'}
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <Field label={recovery ? 'Recovery code' : 'Code'}>
          {id => <input id={id} key={String(recovery)} value={code} onChange={e => setCode(e.target.value)} required autoFocus
            autoComplete={recovery ? 'off' : 'one-time-code'} inputMode={recovery ? 'text' : 'numeric'} spellCheck={false}
            placeholder={recovery ? 'abcde-fghjk' : '123456'} maxLength={recovery ? 16 : 7}
            className={`${btn.input} font-mono tracking-[0.2em]`} />}
        </Field>
        <Alert text={error} />
        <Submit busy={busy} disabled={!code.trim()}>Continue</Submit>
      </form>
      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={back} className={`${btn.ghost} -ml-2.5`}><ArrowLeft className="w-3.5 h-3.5" />Back</button>
        <button type="button" onClick={() => { setRecovery(v => !v); setCode(''); }} className={btn.ghost}>
          {recovery ? 'Use the app instead' : 'Use a recovery code'}
        </button>
      </div>
    </Shell>
  );
}

function CreateAccount({ code, name, busy, error, step }: { code: string; name: string; busy: boolean; error: string; step: Step }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [remember, setRemember] = useState(true);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    step(() => guestApi.signup({ code, username: username.trim(), password, email: email.trim() || undefined, remember }));
  };
  return (
    <Shell footer="Your chats, files and memories are kept apart from Evie's and from other guests'. The invite works once; it's spent when you create the account.">
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        Welcome, {name}. Evie invited you to your own space on her Shell:B. Choose how you'll sign in.
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <Field label="Username" hint="3 to 32 letters, digits, dots, dashes or underscores. Not case-sensitive.">
          {id => <input id={id} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required
            autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" className={btn.input} autoFocus />}
        </Field>
        <Field label="Password" hint={PASSWORD_HINT}>{id => <PasswordInput id={id} value={password} onChange={setPassword} fresh />}</Field>
        <Field label="Email (optional)" hint="Only Evie sees it, so she can reach you. Shell:B never sends email.">
          {id => <input id={id} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" className={btn.input} />}
        </Field>
        <Remember value={remember} onChange={setRemember} />
        <Alert text={error} />
        <Submit busy={busy} disabled={!username.trim() || password.length < 10}>Create account</Submit>
      </form>
    </Shell>
  );
}

function ResetPassword({ code, name, username, busy, error, step }: {
  code: string; name: string; username: string | null; busy: boolean; error: string; step: Step;
}) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const submit = (e: FormEvent) => { e.preventDefault(); step(() => guestApi.reset(code, password, remember)); };
  return (
    <Shell footer="Setting a new password signs you out on every other device. If you use two-step sign-in, you'll need a code next.">
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        Choose a new password, {name}.{username && <> Your username is <span className="font-mono text-[var(--text-primary)]">{username}</span>.</>}
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <input type="text" name="username" autoComplete="username" value={username ?? ''} readOnly hidden />
        <Field label="New password" hint={PASSWORD_HINT}>{id => <PasswordInput id={id} value={password} onChange={setPassword} fresh autoFocus />}</Field>
        <Remember value={remember} onChange={setRemember} />
        <Alert text={error} />
        <Submit busy={busy} disabled={password.length < 10}>Set password and sign in</Submit>
      </form>
    </Shell>
  );
}

function DeviceCode({ error: initialError, back, onIn }: { error: string; back: () => void; onIn: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await guestApi.redeem(code.trim());
      onIn();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <Shell footer="Make a device code on a device where you signed in with your password: account menu → Your devices. Codes work once, for 10 minutes.">
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        Sign in this device with a code from one that's already signed in, without typing your password here.
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <Field label="Device code">
          {id => (
            <div className="relative">
              <KeyRound className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
              <input id={id} value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false} required
                placeholder="ABCD-EFGH" maxLength={12} className={`${btn.input} pl-8 font-mono tracking-wider`} autoFocus />
            </div>
          )}
        </Field>
        <Alert text={error} />
        <Submit busy={busy} disabled={!code.trim()}>Sign in</Submit>
      </form>
      <button type="button" onClick={back} className={`${btn.ghost} mt-3 -ml-2.5`}><ArrowLeft className="w-3.5 h-3.5" />Sign in with a password</button>
    </Shell>
  );
}

/** A guest who joined by invite before accounts existed: still signed in here, but needs a username and password. */
function ChooseAccount({ name, onDone }: { name: string; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await guestApi.createAccount({ username: username.trim(), password, email: email.trim() || undefined });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return (
    <Shell footer="Your chats, notes and memories are all still here. This only adds a way to sign in on new devices without an invite.">
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
        {name ? `Hi ${name}. ` : ''}Shell:B Guest has proper accounts now. Choose a username and password to keep going.
      </p>
      <form className="mt-8 space-y-4" onSubmit={submit}>
        <Field label="Username" hint="3 to 32 letters, digits, dots, dashes or underscores. Not case-sensitive.">
          {id => <input id={id} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required
            autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" className={btn.input} autoFocus />}
        </Field>
        <Field label="Password" hint={PASSWORD_HINT}>{id => <PasswordInput id={id} value={password} onChange={setPassword} fresh />}</Field>
        <Field label="Email (optional)" hint="Only Evie sees it. Shell:B never sends email.">
          {id => <input id={id} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" className={btn.input} />}
        </Field>
        <Alert text={error} />
        <Submit busy={busy} disabled={!username.trim() || password.length < 10}>Save and continue</Submit>
      </form>
      <button type="button" onClick={() => { guestApi.logout().finally(onDone); }} className={`${btn.ghost} mt-3 -ml-2.5`}>
        <LogOut className="w-3.5 h-3.5" />Sign out
      </button>
    </Shell>
  );
}
