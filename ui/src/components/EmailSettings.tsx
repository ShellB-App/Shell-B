// Email from Shell:B (server/mailer.py): Cloudflare Email Sending setup, a test, and the recent send log.
// Shown under Settings → Notifications; which kinds email you is chosen in "What notifies" next to push.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, KeyRound, Loader2, Mail, Send, Trash2 } from 'lucide-react';
import { req } from '../api';
import { btn, relTime } from './common';

export interface EmailStatus {
  accountId: string; from: string; fromName: string; to: string; appUrl: string;
  tokenSet: boolean; ready: boolean; cap: number;
  log: { ts: number; kind: string; to: string; subject: string; ok: boolean; error: string }[];
}
type EmailConfig = Pick<EmailStatus, 'accountId' | 'from' | 'fromName' | 'to' | 'appUrl'>;

export const emailApi = {
  status: () => req<EmailStatus>('/api/email'),
  save: (c: Partial<EmailConfig>) => req<EmailStatus>('/api/email', { method: 'PUT', body: JSON.stringify(c) }),
  setToken: (token: string) => req<EmailStatus>('/api/email/token', { method: 'PUT', body: JSON.stringify({ token }) }),
  dropToken: () => req<EmailStatus>('/api/email/token', { method: 'DELETE' }),
  test: () => req<{ ok: boolean }>('/api/email/test', { method: 'POST' }),
};

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '').replace(/^\d+: /, '');
const KIND: Record<string, string> = { notify: 'Notification', guest: 'Guest', agent: 'Agent', test: 'Test' };

const FIELDS: { key: keyof EmailConfig; label: string; hint: string; placeholder: string; mono?: boolean }[] = [
  { key: 'to', label: 'Your address', hint: 'Notifications go here, and replies to agent emails come here.', placeholder: 'you@example.com' },
  { key: 'from', label: 'Send from', hint: 'An address on a domain onboarded to Cloudflare Email Sending.', placeholder: 'notify@shellb.app' },
  { key: 'fromName', label: 'Sender name', hint: '', placeholder: 'Shell:B' },
  { key: 'appUrl', label: 'Link to', hint: 'The address emails link back to.', placeholder: 'https://ai.shellb.app' },
  { key: 'accountId', label: 'Cloudflare account ID', hint: 'The 32-character ID in your Cloudflare dashboard URL.', placeholder: '0123456789abcdef…', mono: true },
];

export function EmailSection({ onChange }: { onChange?: (s: EmailStatus) => void }) {
  const [s, setS] = useState<EmailStatus | null>(null);
  const [draft, setDraft] = useState<EmailConfig | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (st: EmailStatus) => {
    setS(st); onChange?.(st);
    setDraft({ accountId: st.accountId, from: st.from, fromName: st.fromName, to: st.to, appUrl: st.appUrl });
  };
  useEffect(() => { emailApi.status().then(apply).catch(e => setMsg({ ok: false, text: errText(e) })); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(''); }
  };
  const dirty = !!(s && draft && (Object.keys(draft) as (keyof EmailConfig)[]).some(k => draft[k] !== s[k]));
  const save = () => run('save', async () => { apply(await emailApi.save(draft!)); setMsg({ ok: true, text: 'Saved.' }); });
  const saveToken = () => run('token', async () => { apply(await emailApi.setToken(token.trim())); setToken(''); setMsg({ ok: true, text: 'Token saved. It stays on this machine.' }); });
  const dropToken = () => run('drop', async () => { if (confirm('Remove the Cloudflare token? Shell:B stops sending email until you add one again.')) apply(await emailApi.dropToken()); });
  const test = () => run('test', async () => {
    await emailApi.test();
    setMsg({ ok: true, text: `Sent a test to ${s!.to}. Check your inbox (and spam, the first time).` });
    apply(await emailApi.status());
  });

  if (!s || !draft) {
    return msg ? <p className="text-xs text-amber-400">{msg.text}</p> : <div className="h-24 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" aria-hidden />;
  }
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <div className="p-4 flex flex-wrap items-start gap-3">
        <span className={clsx('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
          s.ready ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>
          <Mail className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-[12rem]">
          <div className="text-sm font-medium">Email</div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-[60ch]">
            {s.ready
              ? `Ready. Shell:B sends from ${s.from} through Cloudflare, at most ${s.cap} emails an hour.`
              : 'Sent through Cloudflare Email Sending. Add your Cloudflare account ID and an API token that can send email.'}
            {' '}Notifications, guest invites and resets, and agent emails (each one approved by you) all use it.
          </p>
        </div>
        <button className={btn.subtle} onClick={test} disabled={!s.ready || !s.to || !!busy || dirty}
          title={dirty ? 'Save first' : !s.to ? 'Add your address first' : 'Send a test to your address'}>
          {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}Send test
        </button>
      </div>

      <div className="px-4 pb-4 grid gap-3 sm:grid-cols-2">
        {FIELDS.map(f => (
          <label key={f.key} className="block space-y-1">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{f.label}</span>
            <input className={clsx(btn.input, f.mono && 'font-mono text-xs')} value={draft[f.key]} placeholder={f.placeholder}
              spellCheck={false} autoComplete="off" onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} />
            {f.hint && <span className="block text-[11px] text-[var(--text-muted)] leading-snug">{f.hint}</span>}
          </label>
        ))}
        <div className="block space-y-1">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Cloudflare API token</span>
          {s.tokenSet ? (
            <div className="flex items-center gap-2 text-xs text-emerald-400 py-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />Saved on this machine
              <button className={clsx(btn.icon, 'ml-auto')} onClick={dropToken} disabled={!!busy} aria-label="Remove the token" title="Remove the token">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input className={clsx(btn.input, 'font-mono text-xs')} type="password" value={token} placeholder="Paste the token"
                autoComplete="off" onChange={e => setToken(e.target.value)} />
              <button className={btn.subtle} onClick={saveToken} disabled={!token.trim() || !!busy}>
                {busy === 'token' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}Save
              </button>
            </div>
          )}
          <span className="block text-[11px] text-[var(--text-muted)] leading-snug">Never shown again or sent anywhere but Cloudflare.</span>
        </div>
      </div>

      {dirty && (
        <div className="px-4 pb-4 flex gap-2">
          <button className={btn.primary} onClick={save} disabled={!!busy}>{busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Save</button>
          <button className={btn.ghost} onClick={() => apply(s)} disabled={!!busy}>Cancel</button>
        </div>
      )}
      {msg && <p role="status" className={clsx('px-4 py-2.5 border-t border-[var(--border-subtle)] text-xs leading-relaxed', msg.ok ? 'text-emerald-400' : 'text-amber-400')}>{msg.text}</p>}

      {s.log.length > 0 && (
        <details className="border-t border-[var(--border-subtle)]">
          <summary className="px-4 py-2.5 text-xs text-[var(--text-secondary)] cursor-pointer select-none">Recently sent ({s.log.length})</summary>
          <ul className="px-4 pb-3 space-y-1.5">
            {s.log.map((l, i) => (
              <li key={i} className="text-[11px] leading-snug">
                <span className={l.ok ? 'text-emerald-400' : 'text-amber-400'}>{l.ok ? 'Sent' : 'Failed'}</span>
                <span className="text-[var(--text-muted)]"> · {KIND[l.kind] ?? l.kind} · {relTime(l.ts)} · to {l.to}</span>
                <div className="truncate" title={l.subject}>{l.subject}</div>
                {l.error && <div className="text-amber-400 truncate" title={l.error}>{l.error}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
