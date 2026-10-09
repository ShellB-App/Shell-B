import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { AUTH_LOST, api, setFrameKey } from '../api';
import { btn } from '../components/common';
import { guestApi, type GuestMe } from './guestApi';

/** The invite in an invite link: https://…/#invite=<code> */
const inviteInHash = () => /[#&]invite=([\w-]+)/.exec(location.hash)?.[1] ?? '';

/** Signed in (an invite or device code redeemed on this device) or the welcome screen. */
export function GuestGate({ children }: { children: (me: GuestMe, refresh: () => void) => ReactNode }) {
  const [me, setMe] = useState<GuestMe | null>(null);
  const [state, setState] = useState<'checking' | 'out' | 'in' | 'offline'>('checking');

  const check = useCallback(async () => {
    try {
      const info = await api.authMe();
      if (!info.authenticated) { setFrameKey(null); setMe(null); setState('out'); return; }
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
  return <Welcome offline={state === 'offline'} onIn={check} />;
}

function Welcome({ offline, onIn }: { offline: boolean; onIn: () => void }) {
  const [code, setCode] = useState(inviteInHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(offline ? "Can't reach Shell:B right now. The machine may be asleep: try again in a bit." : '');
  const fromLink = !!inviteInHash();

  const join = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try {
      await guestApi.redeem(value.trim());
      history.replaceState(null, '', location.pathname);
      onIn();
    } catch (e) {
      setError(String(e).replace(/^Error: \d+: /, ''));
      setBusy(false);
    }
  }, [onIn]);

  // an invite link signs in on its own
  useEffect(() => { if (fromLink && !offline) join(inviteInHash()); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-full flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">Private AI on a friend's machine</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight leading-[1.1] text-[var(--text-primary)]">Shell:B</h1>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[40ch]">
          Chat, draw, compose music and run code on Evie's DGX Spark. Your space here is your own: your chats, files and
          memories are kept apart from Evie's and from other guests'.
        </p>

        <form className="mt-8 space-y-3" onSubmit={e => { e.preventDefault(); join(code); }}>
          <label htmlFor="code" className="block text-xs font-medium text-[var(--text-secondary)]">
            Invite or device code
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
              <input id="code" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder="ABCD-EFGH or the code from your link" className={`${btn.input} pl-8 font-mono`} autoFocus={!fromLink} />
            </div>
            <button type="submit" className={`${btn.primary} px-4`} disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              Join
            </button>
          </div>
          {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}
        </form>

        <div className="mt-10 flex gap-3 text-xs leading-relaxed text-[var(--text-muted)] border-t border-[var(--border-subtle)] pt-4">
          <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent-soft)]" aria-hidden />
          <p>
            No account or password: an invite from Evie signs in this device. To add your phone or laptop later, make a
            device code from a device that's already signed in.
          </p>
        </div>
      </div>
    </main>
  );
}
