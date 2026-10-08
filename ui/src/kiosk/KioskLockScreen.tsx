import { useState, useEffect, useRef, useCallback } from 'react';
import { Lock, Unlock, KeyRound, Terminal, Eye, EyeOff, ShieldCheck, ShieldAlert, AlertCircle, Delete, X } from 'lucide-react';
import { api, adminKey } from '../api';
import type { Status } from '../types';

interface Props {
  open: boolean;
  onUnlock: () => void;
  status?: Status;
}

const DEFAULT_PIN = '1234';
const PIN_KEY = 'shellb.kiosk.pin';
export const KIOSK_AUTH_FLAG = 'shellb.kiosk.password_authenticated';

export function getKioskPin(): string {
  try {
    return localStorage.getItem(PIN_KEY) || DEFAULT_PIN;
  } catch {
    return DEFAULT_PIN;
  }
}

export function setKioskPin(pin: string) {
  try {
    localStorage.setItem(PIN_KEY, pin);
  } catch {}
}

export function isStationPasswordAuthenticated(): boolean {
  try {
    if (typeof window !== 'undefined' && /[?&]authed=1/.test(window.location.search)) return true;
    if (typeof window !== 'undefined' && /[?&]authed=0/.test(window.location.search)) return false;
    return localStorage.getItem(KIOSK_AUTH_FLAG) === 'true';
  } catch {
    return false;
  }
}

export function setStationPasswordAuthenticated(authed: boolean) {
  try {
    if (authed) {
      localStorage.setItem(KIOSK_AUTH_FLAG, 'true');
    } else {
      localStorage.removeItem(KIOSK_AUTH_FLAG);
    }
  } catch {}
}

export function KioskLockScreen({ open, onUnlock, status }: Props) {
  const [time, setTime] = useState(new Date());
  // 'ambient' = screensaver clock view; 'unlock' = PIN/password entry prompt
  const [stage, setStage] = useState<'ambient' | 'unlock'>(() =>
    typeof window !== 'undefined' && /[?&]unlock=1/.test(window.location.search) ? 'unlock' : 'ambient'
  );
  const [isPasswordAuthed, setIsPasswordAuthed] = useState(isStationPasswordAuthenticated);
  const [mode, setMode] = useState<'pin' | 'password'>(() =>
    isStationPasswordAuthenticated() ? 'pin' : 'password'
  );

  // Input states
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [success, setSuccess] = useState(false);

  // Inactivity timeout in unlock stage
  const lastActive = useRef(Date.now());
  const passInputRef = useRef<HTMLInputElement>(null);

  // Clock ticker
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Reset stage and credential state when lockscreen opens
  useEffect(() => {
    if (open) {
      const authed = isStationPasswordAuthenticated();
      setIsPasswordAuthed(authed);
      setMode(authed ? 'pin' : 'password');
      if (typeof window === 'undefined' || !/[?&]unlock=1/.test(window.location.search)) {
        setStage('ambient');
      }
      setPin('');
      setPassword('');
      setError('');
      setSuccess(false);
      setVerifying(false);
    }
  }, [open]);

  // Autofocus password input when in password mode on unlock stage
  useEffect(() => {
    if (open && stage === 'unlock' && mode === 'password') {
      const t = setTimeout(() => passInputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open, stage, mode]);

  // Unlock stage inactivity timer: return to ambient after 25s
  useEffect(() => {
    if (!open || stage !== 'unlock') return;
    const t = setInterval(() => {
      if (Date.now() - lastActive.current > 25_000) {
        setStage('ambient');
        setPin('');
        setPassword('');
        setError('');
      }
    }, 2000);
    return () => clearInterval(t);
  }, [open, stage]);

  const wakeToUnlock = () => {
    lastActive.current = Date.now();
    const authed = isStationPasswordAuthenticated();
    setIsPasswordAuthed(authed);
    setMode(authed ? 'pin' : 'password');
    setStage('unlock');
    setError('');
  };

  const finishUnlock = () => {
    setSuccess(true);
    setVerifying(false);
    setTimeout(() => {
      onUnlock();
      setStage('ambient');
      setPin('');
      setPassword('');
      setSuccess(false);
    }, 450);
  };

  const verifyCredential = useCallback(
    async (candidate: string) => {
      if (!candidate.trim()) return;
      setVerifying(true);
      setError('');

      const clean = candidate.trim();
      const authed = isStationPasswordAuthenticated();

      // Rule: PIN can ONLY be used if the station is authenticated prior with the password.
      // First-time access on this device/station requires entering the system password first.
      if (!authed) {
        try {
          await api.login(clean);
          setStationPasswordAuthenticated(true);
          setIsPasswordAuthed(true);
          finishUnlock();
        } catch {
          setError('Incorrect password. First-time access requires system password.');
          setVerifying(false);
          setPassword('');
          if (typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate([60, 40, 60]);
          }
        }
        return;
      }

      // Station IS authenticated prior with password:
      // PIN is allowed to unlock the screen on the Kiosk.
      const storedPin = getKioskPin();
      const currentAdminKey = adminKey.get();

      // Check 1: Custom or default Kiosk PIN
      if (clean === storedPin) {
        finishUnlock();
        return;
      }

      // Check 2: Admin key match
      if (currentAdminKey && clean === currentAdminKey) {
        finishUnlock();
        return;
      }

      // Check 3: Shell:B system account password via API
      try {
        await api.login(clean);
        finishUnlock();
      } catch {
        setError(mode === 'pin' ? 'Incorrect PIN' : 'Incorrect password');
        setVerifying(false);
        setPin('');
        setPassword('');
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate([60, 40, 60]);
        }
      }
    },
    [onUnlock, mode]
  );

  // Keyboard listener for PIN & password entry
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      lastActive.current = Date.now();

      if (stage === 'ambient') {
        wakeToUnlock();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setStage('ambient');
        setPin('');
        setPassword('');
        setError('');
        return;
      }

      // PIN entry is only accepted if the station is authenticated prior with password
      if (mode === 'pin' && isPasswordAuthed) {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          setPin(prev => {
            if (prev.length >= 8) return prev;
            const next = prev + e.key;
            if (next.length === getKioskPin().length) {
              setTimeout(() => verifyCredential(next), 50);
            }
            return next;
          });
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          setPin(prev => prev.slice(0, -1));
          setError('');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          verifyCredential(pin);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, stage, mode, pin, isPasswordAuthed, verifyCredential]);

  if (!open) return null;

  const hours = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = time.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const handleDigitPress = (digit: string) => {
    lastActive.current = Date.now();
    setError('');
    const targetLength = getKioskPin().length;
    const next = pin + digit;
    setPin(next);

    if (next.length === targetLength) {
      setTimeout(() => verifyCredential(next), 60);
    }
  };

  const handleBackspace = () => {
    lastActive.current = Date.now();
    setPin(p => p.slice(0, -1));
    setError('');
  };

  const handleClear = () => {
    lastActive.current = Date.now();
    setPin('');
    setError('');
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    verifyCredential(password);
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-between p-8 sm:p-12 bg-black/90 backdrop-blur-2xl text-white select-none animate-fade-in font-sans">
      {/* Background Ambient Glow */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
        <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full bg-blue-600/20 blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/3 w-96 h-96 rounded-full bg-purple-600/20 blur-3xl animate-pulse" style={{ animationDelay: '2s' }} />
      </div>

      {/* Top Header */}
      <div className="relative z-10 flex items-center justify-between w-full max-w-4xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent-soft)] font-mono font-bold text-lg shadow-lg">
            S:B
          </div>
          <div>
            <div className="text-sm sm:text-base font-bold tracking-tight">SHELL:B WORKSTATION</div>
            <div className="text-[11px] text-white/50 font-mono">NVIDIA DGX Spark Platform · Terminal Standby</div>
          </div>
        </div>

        {stage === 'unlock' && (
          <button
            onClick={() => setStage('ambient')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-3.5 h-3.5" />
            <span>Cancel</span>
          </button>
        )}
      </div>

      {/* Center Main Stage */}
      {stage === 'ambient' ? (
        /* AMBIENT SCREENSAVER CLOCK */
        <div
          onClick={wakeToUnlock}
          className="relative z-10 flex-1 flex flex-col items-center justify-center text-center cursor-pointer w-full max-w-2xl py-8 space-y-6"
        >
          <div className="text-7xl sm:text-9xl font-mono font-bold tracking-tighter text-white drop-shadow-[0_0_35px_rgba(255,255,255,0.2)]">
            {hours}
          </div>
          <div className="text-lg sm:text-xl font-medium text-white/80">
            {dateStr}
          </div>

          <div className="w-48 h-1 rounded-full bg-gradient-to-r from-blue-500 via-pink-500 to-amber-500 my-2" />

          {/* Telemetry pill */}
          <div className="flex items-center gap-4 text-xs font-mono text-white/60 bg-white/5 border border-white/10 px-4 py-2 rounded-full">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              Unified VRAM: 48 GB OK
            </span>
            <span>·</span>
            <span>Neural Runtimes: Online</span>
          </div>
        </div>
      ) : (
        /* UNLOCK PROMPT (PIN / PASSWORD) */
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center w-full max-w-sm py-4 animate-fade-in">
          <div className="w-full rounded-3xl border border-white/15 bg-white/10 p-6 sm:p-8 backdrop-blur-xl shadow-2xl flex flex-col items-center text-center">
            {/* Status icon */}
            <div
              className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-4 transition-all duration-300 ${
                success
                  ? 'bg-emerald-500/20 border border-emerald-500 text-emerald-400 scale-110'
                  : error
                  ? 'bg-red-500/20 border border-red-500 text-red-400'
                  : !isPasswordAuthed
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
                  : 'bg-white/10 border border-white/20 text-white'
              }`}
            >
              {success ? (
                <Unlock className="w-7 h-7 animate-bounce" />
              ) : !isPasswordAuthed ? (
                <ShieldAlert className="w-7 h-7 text-amber-400" />
              ) : (
                <Lock className="w-7 h-7" />
              )}
            </div>

            <h2 className="text-lg font-bold tracking-tight text-white mb-1">
              {success
                ? isPasswordAuthed ? 'Unlocked' : 'Station Authenticated'
                : !isPasswordAuthed
                ? 'Station Authentication Required'
                : 'Terminal Locked'}
            </h2>
            <p className="text-xs text-white/60 mb-5 max-w-xs leading-relaxed">
              {!isPasswordAuthed
                ? 'Sign in with your system password to authenticate this station. PIN unlock will be enabled for this station once authenticated.'
                : mode === 'pin'
                ? 'Enter PIN to unlock station or switch to password'
                : 'Enter your Shell:B system password'}
            </p>

            {/* First-time requirement banner */}
            {!isPasswordAuthed && !error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs mb-4 text-left w-full">
                <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
                <span>First sign-in on this device must use the system password. PIN cannot be used yet.</span>
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-400 font-semibold mb-4 animate-shake text-left w-full">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* PIN INPUT MODE (Only rendered if station is authenticated prior with password) */}
            {isPasswordAuthed && mode === 'pin' ? (
              <div className="w-full flex flex-col items-center space-y-6">
                {/* PIN Dots Display */}
                <div className="flex items-center justify-center gap-3 py-2">
                  {Array.from({ length: Math.max(4, getKioskPin().length) }).map((_, idx) => (
                    <div
                      key={idx}
                      className={`w-3.5 h-3.5 rounded-full border transition-all duration-200 ${
                        idx < pin.length
                          ? 'bg-[var(--accent)] border-[var(--accent)] scale-125 shadow-[0_0_12px_var(--accent)]'
                          : 'border-white/30 bg-white/5'
                      }`}
                    />
                  ))}
                </div>

                {/* Tactile Keypad (3x4) */}
                <div className="grid grid-cols-3 gap-3 w-full max-w-[260px]">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
                    <button
                      key={d}
                      onClick={() => handleDigitPress(d)}
                      disabled={verifying || success}
                      className="h-14 rounded-2xl bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-xl font-bold font-mono text-[var(--accent-fg)] transition flex items-center justify-center shadow-md active:bg-[var(--accent)]/40"
                    >
                      {d}
                    </button>
                  ))}
                  <button
                    onClick={handleClear}
                    disabled={verifying || success || !pin}
                    className="h-14 rounded-2xl bg-white/5 hover:bg-white/10 active:scale-95 text-xs font-mono font-semibold uppercase text-white/60 transition flex items-center justify-center disabled:opacity-30"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => handleDigitPress('0')}
                    disabled={verifying || success}
                    className="h-14 rounded-2xl bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-xl font-bold font-mono text-[var(--accent-fg)] transition flex items-center justify-center shadow-md active:bg-[var(--accent)]/40"
                  >
                    0
                  </button>
                  <button
                    onClick={handleBackspace}
                    disabled={verifying || success || !pin}
                    className="h-14 rounded-2xl bg-white/5 hover:bg-white/10 active:scale-95 text-white/70 hover:text-white transition flex items-center justify-center disabled:opacity-30"
                  >
                    <Delete className="w-5 h-5" />
                  </button>
                </div>

                {/* Toggle to password mode */}
                <button
                  onClick={() => {
                    setMode('password');
                    setError('');
                    setTimeout(() => passInputRef.current?.focus(), 50);
                  }}
                  className="text-xs text-[var(--accent-soft)] hover:underline pt-2 flex items-center gap-1.5"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Use System Password instead</span>
                </button>
              </div>
            ) : (
              /* PASSWORD INPUT MODE */
              <form onSubmit={handlePasswordSubmit} className="w-full space-y-4">
                <div className="relative">
                  <input
                    ref={passInputRef}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="System password"
                    value={password}
                    onChange={e => {
                      setPassword(e.target.value);
                      setError('');
                    }}
                    autoFocus
                    className="w-full px-4 py-3 rounded-xl border border-white/20 bg-white/10 text-white placeholder-white/40 focus:outline-none focus:border-[var(--accent)] text-sm font-sans"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3.5 text-white/60 hover:text-white"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={verifying || !password}
                  className="w-full py-3 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-semibold text-sm hover:opacity-90 active:scale-98 transition shadow-lg disabled:opacity-40"
                >
                  {verifying
                    ? 'Verifying…'
                    : !isPasswordAuthed
                    ? 'Authenticate Station'
                    : 'Unlock Terminal'}
                </button>

                {isPasswordAuthed && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('pin');
                      setError('');
                    }}
                    className="text-xs text-white/60 hover:text-white hover:underline pt-2"
                  >
                    Back to PIN keypad
                  </button>
                )}
              </form>
            )}
          </div>
        </div>
      )}

      {/* Bottom Footer Wake/Hint */}
      <div className="relative z-10 flex flex-col items-center gap-2">
        {stage === 'ambient' ? (
          <div
            onClick={wakeToUnlock}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-xs font-semibold tracking-wider uppercase text-white shadow-2xl backdrop-blur-md cursor-pointer transition active:scale-95 animate-bounce"
          >
            <Terminal className="w-4 h-4 text-[var(--accent)]" />
            <span>Touch or click to unlock terminal</span>
          </div>
        ) : !isPasswordAuthed ? (
          <p className="text-[11px] text-amber-300/80 font-mono">
            First-time station access · System password required · PIN unlocks subsequent sessions
          </p>
        ) : (
          <p className="text-[11px] text-white/40 font-mono">
            Station authenticated · PIN unlock active (Default: {DEFAULT_PIN}) · Or use password
          </p>
        )}
      </div>
    </div>
  );
}
