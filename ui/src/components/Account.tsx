import { useEffect, useState } from 'react';
import { Loader2, LogOut, ShieldCheck, ShieldAlert, KeyRound } from 'lucide-react';
import { api, type AuditEntry, type AuthInfo, type AuthSession, type TwoStepStatus } from '../api';
import { qrMatrix } from '../qr';
import { btn, relTime } from './common';
import {
  getKioskPin,
  setKioskPin,
  isStationPasswordAuthenticated,
  setStationPasswordAuthenticated,
} from '../kiosk/KioskLockScreen';

const errText = (e: unknown) => String(e).replace(/^Error: \d+: /, '');

function device(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function AccountTab() {
  const [me, setMe] = useState<AuthInfo | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.authMe().then(setMe).catch(() => {});
    api.authSessions().then(setSessions).catch(() => setSessions([]));
  };
  useEffect(load, []);

  if (!me) return null;

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext('');
      setMsg({ ok: true, text: 'Password changed. Every other session was signed out.' });
      load();
    } catch (err) { setMsg({ ok: false, text: errText(err) }); } finally { setBusy(false); }
  };
  const signOut = async () => { await api.logout().catch(() => {}); location.reload(); };
  const others = sessions.filter(s => !s.current).length;

  return (
    <div className="space-y-6">
      {/* Kiosk Screen Lock & PIN Management (available on all devices & localhost) */}
      <KioskPinSection />

      {me.via === 'session' ? (
        <>
          <section>
            <h3 className="text-sm font-medium mb-2">This session</h3>
            <button className={btn.subtle} onClick={signOut}><LogOut className="w-3.5 h-3.5" />Sign out</button>
          </section>

          <TwoStepSection />
          <section>
            <h3 className="text-sm font-medium mb-2">Change password</h3>
            <form onSubmit={change} className="space-y-2 max-w-sm">
              <input type="text" name="username" value="owner" autoComplete="username" readOnly hidden />
              <input className={btn.input} type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
              <input className={btn.input} type="password" placeholder="New password (8+ characters)" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
              {msg && <p className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
              <button type="submit" className={btn.primary} disabled={busy || !current || next.length < 8}>
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Change password
              </button>
            </form>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Signed-in devices</h3>
              {others > 0 && <button className={btn.ghost} onClick={() => api.logoutOthers().then(load)}>Sign out the other {others}</button>}
            </div>
            <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg">
              {sessions.map((s, i) => (
                <li key={i} className="px-3 py-2 flex items-center justify-between gap-3 text-[13px]">
                  <span className="truncate">{device(s.userAgent)} <span className="text-[var(--text-muted)]">· {s.ip}</span></span>
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{s.current ? 'this device' : relTime(s.lastSeen * 1000)}</span>
                </li>
              ))}
            </ul>
          </section>
          <AuditLog />
        </>
      ) : (
        <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Local Host Access</h3>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            You are on this machine (localhost), which is trusted for direct system requests. Open Shell:B from a network device or sign in below to establish full owner session permissions.
          </p>
        </section>
      )}
    </div>
  );
}

function KioskPinSection() {
  const [pin, setPin] = useState(getKioskPin);
  const [authed, setAuthed] = useState(isStationPasswordAuthenticated);
  const [pinSuccess, setPinSuccess] = useState(false);
  const [passCandidate, setPassCandidate] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState('');

  const handleSavePin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) return;
    setKioskPin(pin);
    setPinSuccess(true);
    setTimeout(() => setPinSuccess(false), 2000);
  };

  const handleDeauth = () => {
    setStationPasswordAuthenticated(false);
    setAuthed(false);
  };

  const handleAuthStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passCandidate) return;
    setAuthBusy(true);
    setAuthErr('');
    try {
      await api.login(passCandidate);
      setStationPasswordAuthenticated(true);
      setAuthed(true);
      setPassCandidate('');
    } catch {
      setAuthErr('Incorrect system password');
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2 text-[var(--text-primary)]">
          <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
          Kiosk Screen Lock & PIN
        </h3>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          When in Kiosk mode, leaving the screensaver requires typing in the password or PIN. A PIN can only be used if this station was authenticated prior with the system password.
        </p>
      </div>

      {/* Station status pill */}
      <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${authed ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-amber-400'}`} />
          <div>
            <div className="text-xs font-semibold text-[var(--text-primary)]">
              {authed ? 'Station Password-Authenticated' : 'Station Authentication Required'}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {authed ? 'PIN unlock enabled for kiosk standby' : 'Must sign in with password before PIN unlock is allowed'}
            </div>
          </div>
        </div>
        {authed ? (
          <button
            type="button"
            onClick={handleDeauth}
            className="px-2.5 py-1 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition"
          >
            De-authenticate Station
          </button>
        ) : (
          <span className="text-[11px] text-amber-400 font-mono font-medium">Password Required</span>
        )}
      </div>

      {/* If not authed, provide inline password auth option */}
      {!authed && (
        <form onSubmit={handleAuthStation} className="space-y-2 max-w-sm p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
          <div className="text-xs text-[var(--text-secondary)]">
            Authenticate this station now with your system password to enable PIN unlock:
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="System password"
              value={passCandidate}
              onChange={e => { setPassCandidate(e.target.value); setAuthErr(''); }}
              className={`${btn.input} flex-1`}
            />
            <button
              type="submit"
              disabled={authBusy || !passCandidate}
              className={`${btn.primary} shrink-0`}
            >
              {authBusy ? 'Verifying…' : 'Authenticate'}
            </button>
          </div>
          {authErr && <p className="text-xs text-red-400">{authErr}</p>}
        </form>
      )}

      {/* PIN configuration */}
      <form onSubmit={handleSavePin} className="space-y-2 max-w-sm">
        <label className="text-xs text-[var(--text-secondary)] block">
          Kiosk Screen Unlock PIN (4-8 digits):
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            pattern="[0-9]{4,8}"
            maxLength={8}
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 1234"
            className={`${btn.input} font-mono tracking-widest text-center w-32`}
          />
          <button
            type="submit"
            disabled={!/^\d{4,8}$/.test(pin) || pin === getKioskPin()}
            className={`${btn.subtle} shrink-0`}
          >
            Save PIN
          </button>
        </div>
        {pinSuccess && <p className="text-xs text-emerald-400">PIN updated successfully.</p>}
      </form>
    </section>
  );
}


/** The server's audit log (db.audit_log): settings changes, admin actions, approvals, backups. Owner only. */
function AuditLog() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState('');
  const [more, setMore] = useState(true);
  const PAGE = 50;
  const load = (offset = 0) => api.auditLog(PAGE, offset, action)
    .then(r => { setRows(prev => offset && prev ? [...prev, ...r] : r); setMore(r.length === PAGE); })
    .catch(() => { setRows([]); setMore(false); });
  useEffect(() => { if (open) load(0); }, [open, action]);  // eslint-disable-line react-hooks/exhaustive-deps
  const actions = Array.from(new Set((rows ?? []).map(r => r.action))).sort();
  const summary = (d: AuditEntry['details']) => {
    if (!d) return '';
    if (typeof d === 'string') return d;
    return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
  };
  return (
    <section>
      <button className="flex items-center justify-between w-full mb-2" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <h3 className="text-sm font-medium">Audit log</h3>
        <span className="text-[11px] text-[var(--text-muted)]">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select className={btn.input} value={action} onChange={e => setAction(e.target.value)} aria-label="Filter by action">
              <option value="">All actions</option>
              {actions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <span className="text-[11px] text-[var(--text-muted)]">Settings changes, admin actions, approvals and backups, newest first.</span>
          </div>
          <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg max-h-80 overflow-y-auto">
            {rows === null && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Loading…</li>}
            {rows?.length === 0 && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Nothing logged yet.</li>}
            {rows?.map(r => (
              <li key={r.id} className="px-3 py-1.5 text-[12px] flex items-start gap-3">
                <span className="shrink-0 w-24 text-[var(--text-muted)]" title={new Date(r.timestamp * 1000).toLocaleString()}>{relTime(r.timestamp * 1000)}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--accent-soft)]">{r.action}</span>
                <span className="min-w-0 truncate text-[var(--text-secondary)]" title={summary(r.details)}>{summary(r.details)}</span>
              </li>
            ))}
          </ul>
          {more && rows && rows.length > 0 && <button className={btn.ghost} onClick={() => load(rows.length)}>Load more</button>}
        </div>
      )}
    </section>
  );
}


/** Settings → Account → Two-step verification (server/auth.py `/api/auth/2fa`): an authenticator app's code after the
 * password. Setup: password → scan the QR → one code → recovery codes shown once. */
function TwoStepSection() {
  const [st, setSt] = useState<TwoStepStatus | null>(null);
  const [mode, setMode] = useState<'idle' | 'password' | 'scan' | 'codes' | 'off' | 'recovery'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.twoStep().then(setSt).catch(() => setSt(null));
  useEffect(() => { load(); }, []);
  const run = async (f: () => Promise<void>) => { setBusy(true); setErr(''); try { await f(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  const reset = () => { setMode('idle'); setPassword(''); setCode(''); setSetup(null); setErr(''); };
  if (!st) return null;
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Two-step verification</h3>
        <span className={`text-[11px] ${st.on ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>{st.on ? `On · ${st.recoveryLeft} recovery codes left` : 'Off'}</span>
      </div>
      <p className="text-xs text-[var(--text-muted)] max-w-[65ch]">
        Logging in asks for a code from an authenticator app (any TOTP app) after the password. Localhost and the admin key are unaffected.
        Lost the phone? Use a recovery code, or run <code className="font-mono">auth.py disable-2fa</code> on the Spark.
      </p>
      {mode === 'idle' && (
        <div className="flex flex-wrap gap-2 mt-2">
          {!st.on && <button className={btn.primary} onClick={() => setMode('password')}>Turn on</button>}
          {st.on && <button className={btn.subtle} onClick={() => setMode('recovery')}>New recovery codes</button>}
          {st.on && <button className={btn.ghost} onClick={() => setMode('off')}>Turn off</button>}
        </div>
      )}
      {(mode === 'password' || mode === 'off' || mode === 'recovery') && (
        <form className="mt-2 flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); run(async () => {
          if (mode === 'password') { setSetup(await api.twoStepBegin(password)); setMode('scan'); }
          else if (mode === 'off') { await api.twoStepDisable(password); reset(); load(); }
          else { setCodes((await api.twoStepRecovery(password)).recovery); setMode('codes'); }
          setPassword('');
        }); }}>
          <input className={`${btn.input} flex-1`} type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
          <button className={mode === 'off' ? btn.subtle : btn.primary} type="submit" disabled={busy || !password}>{mode === 'password' ? 'Continue' : mode === 'off' ? 'Turn off' : 'Make new codes'}</button>
          <button className={btn.ghost} type="button" onClick={reset}>Cancel</button>
        </form>
      )}
      {mode === 'scan' && setup && (
        <form className="mt-2 flex flex-col sm:flex-row gap-4 items-start" onSubmit={e => { e.preventDefault(); run(async () => {
          const r = await api.twoStepConfirm(code); setCodes(r.recovery); setMode('codes'); setCode(''); load();
        }); }}>
          <QrCode text={setup.uri} />
          <div className="space-y-2 flex-1 min-w-0">
            <p className="text-xs text-[var(--text-secondary)]">Scan this with your authenticator app, or enter the key by hand:</p>
            <code className="block font-mono text-[11px] break-all select-all text-[var(--text-primary)]">{setup.secret}</code>
            <p className="text-xs text-[var(--text-secondary)]">Then type the code it shows:</p>
            <div className="flex gap-2">
              <input className={`${btn.input} w-32`} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" value={code} onChange={e => setCode(e.target.value)} />
              <button className={btn.primary} type="submit" disabled={busy || code.trim().length < 6}>Turn on</button>
              <button className={btn.ghost} type="button" onClick={reset}>Cancel</button>
            </div>
          </div>
        </form>
      )}
      {mode === 'codes' && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-[var(--text-secondary)] max-w-[65ch]">Recovery codes: each one opens the app once if the phone is gone. Keep them somewhere safe; they are shown only now.</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 font-mono text-[12px] select-all">
            {codes.map(c => <span key={c} className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-center">{c}</span>)}
          </div>
          <div className="flex gap-2">
            <button className={btn.subtle} onClick={() => navigator.clipboard?.writeText(codes.join('\n')).catch(() => {})}>Copy</button>
            <button className={btn.primary} onClick={reset}>Done</button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </section>
  );
}

function QrCode({ text }: { text: string }) {
  const m = qrMatrix(text);
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  const n = m.length + 8;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className="w-40 h-40 rounded-lg shrink-0" role="img" shapeRendering="crispEdges" aria-label="QR code to scan with your authenticator app">
      <rect width={n} height={n} fill="#fff" /><path d={d} fill="#000" />
    </svg>
  );
}
