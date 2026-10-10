import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { BellOff, BellRing, ExternalLink, Loader2, Lock, MonitorSmartphone, Send, ShieldAlert, Smartphone, Trash2 } from 'lucide-react';
import { SECURE_URL } from '../secureUrl';
import {
  currentSubscription, disablePush, enablePush, endpointHash, notifyApi, pushBlocker, startTabFallback, tabFallback,
  type NotifyLevel, type NotifyPrefs, type PushDevice,
} from '../notify';
import { Toggle, btn, relTime } from './common';
import { EmailSection } from './EmailSettings';
import { InboxSection } from './InboxSettings';

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '').replace(/^\d+: /, '');

const SERVICE: [RegExp, string][] = [
  [/googleapis\.com$/, 'Google FCM'], [/mozilla\.com$/, 'Mozilla Push'], [/push\.apple\.com$/, 'Apple Push'], [/notify\.windows\.com$/, 'Windows Push'],
];
const serviceName = (host: string) => SERVICE.find(([rx]) => rx.test(host))?.[1] ?? host;

const LEVELS: { id: NotifyLevel; label: string; title: string }[] = [
  { id: 'off', label: 'Off', title: 'Never notify' },
  { id: 'attention', label: 'Needs me', title: 'Only failures, blocks and things waiting for review' },
  { id: 'all', label: 'All', title: 'Every finished, failed or waiting item' },
];

type DeviceState = 'checking' | 'push' | 'tab' | 'off';

export function NotificationsTab() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [denied, setDenied] = useState('');
  const [state, setState] = useState<DeviceState>('checking');
  const [mine, setMine] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [emailReady, setEmailReady] = useState(false);
  const blocker = pushBlocker();
  const permission = 'Notification' in window ? Notification.permission : 'default';

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([notifyApi.prefs(), notifyApi.devices()]);
      setPrefs(p); setDevices(d); setDenied('');
    } catch (e) { setDenied(errText(e)); }
    const sub = await currentSubscription().catch(() => null);
    setMine(sub ? await endpointHash(sub.endpoint) : '');
    setState(sub ? 'push' : tabFallback.get() && permission === 'granted' ? 'tab' : 'off');
  }, [permission]);
  useEffect(() => { load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(''); }
  };

  const enable = () => run('enable', async () => {
    try {
      await enablePush();
      tabFallback.set(false);
      setMsg({ ok: true, text: 'This device will get Shell:B notifications. Send a test to check.' });
    } catch (e) {
      const t = errText(e);
      if (t === 'permission-denied') throw new Error('The browser blocked notifications for this site. Allow them in the site settings, then try again.');
      if (/admin-key-required/.test(t)) throw new Error('Only the signed-in owner can turn notifications on. Sign in with the owner password on this device.');
      // the push service is unreachable (offline workstation, blocked network): fall back to the open tab
      if (Notification.permission === 'granted') {
        tabFallback.set(true);
        setMsg({ ok: false, text: `Push isn't available here (${t}). This device will notify only while a Shell:B tab is open in the background.` });
      } else throw e;
    }
    await load();
  });

  const enableTab = () => run('enable', async () => {
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
      throw new Error('The browser blocked notifications for this site.');
    }
    tabFallback.set(true);
    setMsg({ ok: true, text: 'This tab will notify while it is open in the background.' });
    await load();
  });

  const disable = () => run('disable', async () => {
    await disablePush();
    tabFallback.set(false);
    await startTabFallback();
    setMsg({ ok: true, text: 'Notifications are off on this device.' });
    await load();
  });

  const test = (id?: string) => run(id ? `test-${id}` : 'test', async () => {
    const r = await notifyApi.test(id);
    const failed = r.results.filter(x => !x.ok);
    setMsg(r.results.length === 0
      ? { ok: false, text: 'No device is subscribed yet.' }
      : failed.length === 0
        ? { ok: true, text: `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}. It should arrive within a few seconds.` }
        : { ok: false, text: `Sent to ${r.sent}, failed for ${failed.length}: ${failed[0].error || 'push service unreachable'}${failed.some(f => f.removed) ? ' (expired devices were removed)' : ''}` });
    await load();
  });

  const remove = (d: PushDevice) => run(`rm-${d.id}`, async () => {
    if (d.hash === mine) await disablePush();
    else await notifyApi.removeDevice(d.id);
    await load();
  });

  const setLevel = async (kind: string, level: NotifyLevel, channel: 'levels' | 'email' = 'levels') => {
    if (!prefs) return;
    setPrefs({ ...prefs, [channel]: { ...prefs[channel], [kind]: level } });
    try { setPrefs(await notifyApi.setPrefs({ [channel]: { [kind]: level } })); } catch (e) { setMsg({ ok: false, text: errText(e) }); load(); }
  };
  const picker = (k: { id: string; label: string }, channel: 'levels' | 'email') => (
    <div className="flex items-center gap-1.5">
      {emailReady && <span className="w-9 text-right text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{channel === 'email' ? 'Email' : 'Push'}</span>}
      <div role="radiogroup" aria-label={`${k.label} ${channel === 'email' ? 'emails' : 'notifications'}`} className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-0.5">
        {LEVELS.filter(l => !(l.id === 'attention' && (k.id === 'approval' || k.id === 'question'))).map(l => (
          <button key={l.id} role="radio" aria-checked={prefs![channel][k.id] === l.id} title={l.title}
            onClick={() => setLevel(k.id, l.id, channel)}
            className={clsx('px-2.5 py-1 rounded-md text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
              prefs![channel][k.id] === l.id ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] font-medium shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
  const setDetails = async (details: boolean) => {
    if (!prefs) return;
    setPrefs({ ...prefs, details });
    try { setPrefs(await notifyApi.setPrefs({ details })); } catch (e) { setMsg({ ok: false, text: errText(e) }); load(); }
  };

  const secureLink = SECURE_URL ? `${SECURE_URL.replace(/\/+$/, '')}/?modal=notifications` : '';

  return (
    <div className="space-y-6 max-w-[42rem]">
      <header className="space-y-1.5">
        <h3 className="text-base font-semibold tracking-tight leading-tight">Notifications</h3>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-[65ch]">
          Shell:B can tap you on the shoulder when it needs an approval, a scheduled run or Mega Plan finishes, a to-do gets stuck,
          or anything else lands in Activity. Each device opts in on its own.
        </p>
      </header>

      {/* ── this device ── */}
      <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="p-4 flex flex-wrap items-start gap-3">
          <span className={clsx('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
            state === 'push' || state === 'tab' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>
            {state === 'push' || state === 'tab' ? <BellRing className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
          </span>
          <div className="flex-1 min-w-[12rem]">
            <div className="text-sm font-medium">This device</div>
            <div className="text-xs text-[var(--text-muted)] leading-relaxed">
              {state === 'checking' ? 'Checking…'
                : state === 'push' ? 'On. Alerts arrive even when Shell:B is closed.'
                  : state === 'tab' ? 'On while a Shell:B tab is open in the background (no push on this device).'
                    : permission === 'denied' ? 'Blocked in this browser’s site settings.'
                      : 'Off.'}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {state === 'push' || state === 'tab' ? (
              <>
                <button className={btn.subtle} onClick={() => test()} disabled={!!busy || state === 'tab'} title={state === 'tab' ? 'Tests go through push; this device has none' : 'Send a test to every subscribed device'}>
                  {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Send test
                </button>
                <button className={btn.ghost} onClick={disable} disabled={!!busy}>
                  {busy === 'disable' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Turn off here
                </button>
              </>
            ) : !blocker && !denied ? (
              <button className={btn.primary} onClick={enable} disabled={!!busy || state === 'checking' || permission === 'denied'}>
                {busy === 'enable' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}Enable on this device
              </button>
            ) : blocker !== 'insecure' && 'Notification' in window ? (
              // no push here (not the owner session, or no Web Push): the open tab can still notify while hidden
              <button className={btn.subtle} onClick={enableTab} disabled={!!busy || permission === 'denied'}
                title="Shows alerts only while a Shell:B tab stays open in the background">
                {busy === 'enable' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}Notify from this tab
              </button>
            ) : null}
          </div>
        </div>

        {blocker === 'insecure' && (
          <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-3 bg-amber-500/5">
            <Lock className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="flex-1 min-w-[14rem] text-xs text-[var(--text-secondary)] leading-relaxed max-w-[65ch]">
              Push notifications need HTTPS, and this page is plain http. Open Shell:B on its Tailscale HTTPS address,
              sign in, and enable notifications there.
            </p>
            {secureLink
              ? <a className={btn.subtle} href={secureLink}>Open on HTTPS<ExternalLink className="w-3.5 h-3.5" /></a>
              : <span className="text-[11px] text-[var(--text-muted)]">Set VITE_SECURE_URL to link the HTTPS address here.</span>}
          </div>
        )}
        {blocker === 'ios-install' && (
          <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex items-start gap-3">
            <Smartphone className="w-4 h-4 text-[var(--text-muted)] shrink-0 mt-0.5" />
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-[65ch]">
              On iPhone and iPad, Web Push only works from the Home Screen app: tap Share → Add to Home Screen, open Shell:B from
              that icon, then enable notifications in Settings there.
            </p>
          </div>
        )}
        {blocker === 'unsupported' && (
          <p className="px-4 py-3 border-t border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">This browser doesn’t support Web Push.</p>
        )}
        {msg && (
          <p role="status" className={clsx('px-4 py-2.5 border-t border-[var(--border-subtle)] text-xs leading-relaxed', msg.ok ? 'text-emerald-400' : 'text-amber-400')}>{msg.text}</p>
        )}
      </section>

      {denied ? (
        <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-start gap-3">
          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-[65ch]">
            {/admin-key-required|login-required/.test(denied)
              ? 'Notification settings belong to the owner. Sign in with the owner password (Settings → Account); localhost access alone isn’t enough.'
              : `Couldn’t load notification settings: ${denied}`}
          </p>
        </section>
      ) : !prefs ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2, 3].map(i => <div key={i} className="h-11 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />)}
        </div>
      ) : (
        <>
          {/* ── what notifies ── */}
          <section>
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">What notifies</h4>
              <span className="text-[11px] text-[var(--text-muted)]">applies to every device</span>
            </div>
            <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg">
              {prefs.kinds.map(k => (
                <li key={k.id} className="px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="text-[13px] font-medium">{k.label}</div>
                    <div className="text-[11px] text-[var(--text-muted)] leading-snug">{k.hint}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {picker(k, 'levels')}
                    {emailReady && picker(k, 'email')}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* ── privacy ── */}
          <section className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-[13px] font-medium">Show item titles</div>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed max-w-[65ch]">
                Off: alerts say only what happened (“Mega Plan finished”). On: they add the item’s title, which then shows on your
                lock screen. Push travels through Google, Mozilla or Apple; the payload is end-to-end encrypted, but they see when
                and to which device. Emails follow the same choice and pass through Cloudflare and your mail provider unencrypted.
                Message contents are never sent.
              </p>
            </div>
            <Toggle on={prefs.details} label="Show item titles" onChange={setDetails} />
          </section>

          {/* ── email ── */}
          <EmailSection onChange={st => setEmailReady(st.ready && !!st.to)} />
          <InboxSection />

          {/* ── devices ── */}
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Subscribed devices</h4>
            {devices.length === 0 ? (
              <div className="px-3 py-4 rounded-lg border border-dashed border-[var(--border-subtle)] text-xs text-[var(--text-muted)] flex items-center gap-2">
                <MonitorSmartphone className="w-4 h-4 shrink-0" />
                No devices yet. Open Shell:B on your phone or laptop over HTTPS and choose Enable on this device.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg">
                {devices.map(d => (
                  <li key={d.id} className="px-3 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate">
                        {d.label || 'Unnamed device'}
                        {d.hash === mine && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">this device</span>}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate">
                        {serviceName(d.service)} · added {relTime(d.created)}
                        {d.lastShown > 0 && ` · last shown ${relTime(d.lastShown)}`}
                      </div>
                      {d.lastError && <div className="text-[11px] text-amber-400 truncate" title={d.lastError}>The push service refused the last one: {d.lastError}</div>}
                      {!d.lastError && d.shownError && (
                        <div className="text-[11px] text-amber-400 truncate" title={d.shownError}>The device didn’t show the last one: {d.shownError}</div>
                      )}
                      {!d.lastError && !d.shownError && d.lastOk > d.lastShown + 60_000 && (
                        <div className="text-[11px] text-amber-400" title="The push service accepted it, but this device never reported back. Common causes: notifications blocked for the browser in the OS settings, the browser fully closed (desktop), or battery saving.">
                          Sent {relTime(d.lastOk)}, but the device hasn’t confirmed showing it
                        </div>
                      )}
                    </div>
                    <button className={btn.ghost} onClick={() => test(d.id)} disabled={!!busy} aria-label={`Send a test to ${d.label}`}>
                      {busy === `test-${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Test
                    </button>
                    <button className={btn.icon} onClick={() => remove(d)} disabled={!!busy} aria-label={`Remove ${d.label}`} title="Remove this device">
                      {busy === `rm-${d.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
