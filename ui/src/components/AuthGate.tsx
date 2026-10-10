/** Login screen in front of the app (server/auth.py). First run sets the password with the admin key. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { KeyRound, Loader2, LockKeyhole, RefreshCw, WifiOff } from 'lucide-react';
import { AUTH_LOST, api, setFrameKey, type AuthInfo } from '../api';
import { loginWithPasskey, passkeysSupported } from '../webauthn';
import { btn } from './common';
import { reducedMotion } from '../ambience';
import '../ambience.css';

const errText = (e: unknown) => String(e).replace(/^Error: \d+: /, '');

export function AuthGate({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [failed, setFailed] = useState('');
  const [lost, setLost] = useState(false);
  const [mounted, setMounted] = useState(false);

  const accept = useCallback((i: AuthInfo) => {
    setInfo(i);
    if (i.authenticated) {
      setFrameKey(i.frameKey);
      setLost(false);
      setMounted(true);
      if (i.via === 'session') {
        try { localStorage.setItem('shellb.kiosk.password_authenticated', 'true'); } catch {}
      }
    }
  }, []);

  useEffect(() => {
    api.authMe().then(accept).catch(e => {
      // a server from before login (UI rebuilt ahead of the restart) answers /api/auth/me with the SPA page, not JSON
      if (e instanceof SyntaxError) accept({ authenticated: true, via: null, passwordSet: false, frameKey: null });
      else setFailed(errText(e));
    });
    // a 401 from any call: confirm, then show the login over the app (so an unsent draft survives)
    const onLost = () => api.authMe().then(i => {
      if (!i.authenticated) {
        setInfo(i);
        setLost(true);
        try { localStorage.removeItem('shellb.kiosk.password_authenticated'); } catch {}
      }
    }).catch(() => {});
    window.addEventListener(AUTH_LOST, onLost);
    return () => window.removeEventListener(AUTH_LOST, onLost);
  }, [accept]);

  // the Spark is asleep, rebooting or off this network: keep trying, and come in on our own once it answers
  const retry = useCallback(() => api.authMe().then(i => { setFailed(''); accept(i); }).catch(() => {}), [accept]);
  useEffect(() => {
    if (!failed) return;
    const t = window.setInterval(retry, 5000);
    window.addEventListener('online', retry);
    return () => { window.clearInterval(t); window.removeEventListener('online', retry); };
  }, [failed, retry]);

  if (failed) return (
    <Screen>
      <div className="flex items-start gap-3">
        <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-[var(--text-primary)]">Can’t reach Shell:B</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            {navigator.onLine ? 'The Spark may be asleep, restarting or on another network.' : 'This device is offline.'} Shell:B
            will connect by itself as soon as it answers.
          </p>
          <p className="text-[11px] text-[var(--text-muted)] break-words">{failed}</p>
        </div>
      </div>
      <button className={clsx(btn.subtle, 'mt-4 w-full justify-center')} onClick={retry}><RefreshCw className="w-3.5 h-3.5" />Try again</button>
    </Screen>
  );
  if (!info) return <div className="h-dvh flex items-center justify-center"><LoginBackdrop /><Loader2 className="relative w-5 h-5 animate-spin text-white/60" /></div>;
  const form = (!info.authenticated || lost) && <Screen overlay={mounted}><LoginForm setup={!info.passwordSet} onDone={accept} /></Screen>;
  return <>{mounted && children}{form}</>;
}

// The startup animation's scene, kept running behind the sign-in card: stars, the risen sun, the scrolling grid.
function LoginBackdrop() {
  return (
    <div className={'sb-splash sb-backdrop' + (reducedMotion() ? ' sb-calm' : '')} aria-hidden>
      <div className="sb-splash-stars" />
      <div className="sb-splash-sun" />
      <div className="sb-splash-floor"><div className="sb-splash-grid" /></div>
    </div>
  );
}

function Screen({ children, overlay }: { children: ReactNode; overlay?: boolean }) {
  return (
    <div className={overlay ? 'fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm'
      : 'h-dvh overflow-y-auto flex items-center justify-center p-4'}>
      {!overlay && <LoginBackdrop />}
      <div className={clsx('relative w-full max-w-sm rounded-2xl border border-[var(--border-subtle)] shadow-2xl p-6', !overlay && 'mt-[34vh]')}
        style={overlay ? { background: 'var(--bg-secondary)' }  // on the backdrop: sits on the horizon, the sun rising behind it
          : { background: 'color-mix(in srgb, var(--bg-secondary) 90%, transparent)', backdropFilter: 'blur(14px)' }}>
        <div className="flex items-center gap-2 mb-5">
          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ background: 'var(--sunset-brand, linear-gradient(135deg,#7c3aed,#a78bfa))' }}>B</span>
          <span className="font-semibold tracking-tight text-[var(--brand-soft)]">Shell:B</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function LoginForm({ setup, onDone }: { setup: boolean; onDone: (i: AuthInfo) => void }) {
  const [adminKey, setAdminKey] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');  // two-step: the login ticket waiting for a code
  const [code, setCode] = useState('');
  const [passkey, setPasskey] = useState(false);  // a passkey exists for this address (server/auth.py)
  useEffect(() => { if (!setup && passkeysSupported()) api.passkeysAvailable().then(r => setPasskey(r.available)).catch(() => {}); }, [setup]);
  const usePasskey = async () => {
    setBusy(true); setError('');
    try { onDone(await loginWithPasskey()); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setup && password !== again) { setError("The passwords don't match."); return; }
    setBusy(true); setError('');
    try {
      const r = setup ? await api.authSetup(adminKey.trim(), password) : await api.login(password);
      if (r.needsCode && r.pending) { setPending(r.pending); setPassword(''); return; }
      onDone(r);
    } catch (err) {
      setError(errText(err));
      setPassword(''); setAgain('');
    } finally { setBusy(false); }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      onDone(await api.loginCode(pending, code.trim()));
    } catch (err) {
      setError(errText(err));
      setCode('');
      if (/Start the login again/.test(String(err))) setPending('');
    } finally { setBusy(false); }
  };

  if (pending) return (
    <form onSubmit={submitCode} className="space-y-3">
      <div>
        <h1 className="text-base font-semibold flex items-center gap-2"><LockKeyhole className="w-4 h-4" />Two-step verification</h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
      </div>
      <input className={btn.input} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" value={code} onChange={e => setCode(e.target.value)} autoFocus />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" className={`${btn.primary} w-full py-2`} disabled={busy || code.trim().length < 6}>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Continue
      </button>
      <button type="button" className={`${btn.ghost} w-full justify-center`} onClick={() => { setPending(''); setCode(''); setError(''); }}>Back</button>
    </form>
  );

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <h1 className="text-base font-semibold flex items-center gap-2"><LockKeyhole className="w-4 h-4" />{setup ? 'Choose a password' : 'Log in'}</h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          {setup ? <>Prove you own this machine with the admin key. Get it with <code className="font-mono">cat ~/shellb/web/data/admin.key</code>.</>
            : 'Sessions last 30 days from your last visit.'}
        </p>
      </div>
      {setup && <input className={btn.input} placeholder="Admin key" autoComplete="off" value={adminKey} onChange={e => setAdminKey(e.target.value)} autoFocus />}
      {/* a hidden username lets password managers save the login */}
      <input type="text" name="username" value="owner" autoComplete="username" readOnly hidden />
      <input className={btn.input} type="password" placeholder={setup ? 'New password (8+ characters)' : 'Password'}
        autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} autoFocus={!setup} />
      {setup && <input className={btn.input} type="password" placeholder="New password again" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" className={`${btn.primary} w-full py-2`} disabled={busy || !password || (setup && (!adminKey || !again))}>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{setup ? 'Set password and log in' : 'Log in'}
      </button>
      {!setup && passkey && (
        <button type="button" className={`${btn.subtle} w-full py-2 justify-center`} disabled={busy} onClick={usePasskey}>
          <KeyRound className="w-3.5 h-3.5" />Use a passkey instead
        </button>
      )}
    </form>
  );
}
