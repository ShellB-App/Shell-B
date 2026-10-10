import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Inbox, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { req } from '../api';
import { Toggle, btn, relTime } from './common';
import { toast } from './toast';
import { t } from '../i18n';

/** Settings → Notifications → Email → Inbox (server/inbox.py): the IMAP account the agents may read, how often it is
 * checked, and the rules that start a turn when a matching email arrives. The password is written, never read back. */
interface Rule { id: string; name: string; match_from: string; match_subject: string; agent: string; template: string; enabled: number; hits: number }
interface InboxStatus {
  config: { host: string; port: number; user: string; folder: string; everyMinutes: number; enabled: boolean; days: number };
  hasPassword: boolean; ready: boolean; messages: number; unread: number;
  last: { at: number; new: number; error: string } | null; rules: Rule[];
}
interface AgentLite { id: string; name: string; adult?: boolean }
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '').replace(/^\d+: /, '');

export function InboxSection() {
  const [st, setSt] = useState<InboxStatus | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [form, setForm] = useState<Partial<InboxStatus['config']> & { password?: string }>({});
  const [busy, setBusy] = useState('');
  const [newRule, setNewRule] = useState<{ name: string; matchFrom: string; matchSubject: string; agent: string; template: string } | null>(null);
  const load = () => req<InboxStatus>('/api/email/inbox').then(s => { setSt(s); setForm({}); }).catch(() => setSt(null));
  useEffect(() => { load(); req<AgentLite[]>('/api/agents').then(a => setAgents(a.filter(x => !x.adult))).catch(() => {}); }, []);
  const act = async (what: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    try { await f(); await load(); if (done) toast(done); } catch (e) { toast(errText(e), { kind: 'error' }); } finally { setBusy(''); }
  };
  if (!st) return null;
  const c = { ...st.config, ...form };
  const dirty = Object.keys(form).length > 0;
  return (
    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Inbox className="w-5 h-5 mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">{t('Inbox (IMAP)')}</h3>
              <span className={clsx('text-[11px]', st.ready ? 'text-emerald-400' : 'text-[var(--text-muted)]')}>
                {st.ready ? t('On · {unread} unread of {messages} known', { unread: st.unread, messages: st.messages }) : st.config.enabled ? t('Not ready') : t('Off')}
                {st.last?.error ? <span className="text-amber-400"> · {st.last.error}</span> : st.last ? t(' · checked {v0}', { v0: relTime(st.last.at * 1000) }) : ''}
              </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-[65ch]">
              {t('Agents can read your mail (read_email) and new mail shows in Activity. Rules start an agent turn when a matching message arrives. Use an app password; Shell:B never sends from this account (sending is the provider above).')}
            </p>
          </div>
          <Toggle on={c.enabled} label={t('Inbox')} onChange={v => act('toggle', () => req('/api/email/inbox', { method: 'PUT', body: JSON.stringify({ enabled: v }) }))} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <label className="block text-[var(--text-muted)]">{t('IMAP host')}<input className={btn.input} placeholder="imap.fastmail.com" value={c.host} onChange={e => setForm({ ...form, host: e.target.value })} /></label>
          <label className="block text-[var(--text-muted)]">{t('Port')}<input type="number" className={btn.input} value={c.port} onChange={e => setForm({ ...form, port: Number(e.target.value) || 993 })} /></label>
          <label className="block text-[var(--text-muted)]">{t('User')}<input className={btn.input} placeholder="you@example.org" autoComplete="off" value={c.user} onChange={e => setForm({ ...form, user: e.target.value })} /></label>
          <label className="block text-[var(--text-muted)]">{t('Password / app password')}<input type="password" className={btn.input} placeholder={st.hasPassword ? t('•••••••• (saved)') : t('not set')} autoComplete="new-password" value={form.password ?? ''} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
          <label className="block text-[var(--text-muted)]">{t('Folder')}<input className={btn.input} value={c.folder} onChange={e => setForm({ ...form, folder: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[var(--text-muted)]">{t('Check every (min)')}<input type="number" min={1} className={btn.input} value={c.everyMinutes} onChange={e => setForm({ ...form, everyMinutes: Number(e.target.value) || 5 })} /></label>
            <label className="block text-[var(--text-muted)]">{t('First sync (days)')}<input type="number" min={1} className={btn.input} value={c.days} onChange={e => setForm({ ...form, days: Number(e.target.value) || 7 })} /></label>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btn.primary} disabled={!dirty || busy === 'save'} onClick={() => act('save', () => req('/api/email/inbox', { method: 'PUT', body: JSON.stringify(form) }), 'Inbox settings saved')}>{busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{t('Save')}</button>
          <button className={btn.subtle} disabled={!st.hasPassword || !!busy} onClick={() => act('test', async () => { const r = await req<{ unseen: number }>('/api/email/inbox/test', { method: 'POST' }); toast(t('Connected: {unseen} unseen on the server', { unseen: r.unseen })); })}>{busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}{t('Test connection')}</button>
          <button className={btn.subtle} disabled={!st.ready || !!busy} onClick={() => act('sync', async () => { const r = await req<{ new: number; error: string }>('/api/email/inbox/sync', { method: 'POST' }); toast(r.error ? `Check failed: ${r.error}` : `${r.new} new message${r.new === 1 ? '' : 's'}`, { kind: r.error ? 'error' : 'info' }); })}>{busy === 'sync' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}{t('Check now')}</button>
          {st.hasPassword && <button className={btn.ghost} onClick={() => act('clear', () => req('/api/email/inbox', { method: 'PUT', body: JSON.stringify({ clearPassword: true, enabled: false }) }), 'Password forgotten')}>{t('Forget password')}</button>}
        </div>
      </div>

      <div className="border-t border-[var(--border-subtle)] p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium">{t('Rules: an email starts a turn')}</h4>
          {!newRule && <button className={btn.subtle} onClick={() => setNewRule({ name: '', matchFrom: '', matchSubject: '', agent: agents[0]?.id ?? 'shellb', template: '' })}><Plus className="w-3.5 h-3.5" />{t('New rule')}</button>}
        </div>
        {newRule && (
          <form className="space-y-2 text-xs p-3 rounded-lg border border-[var(--border-subtle)]" onSubmit={e => { e.preventDefault(); act('rule', () => req('/api/email/inbox/rules', { method: 'POST', body: JSON.stringify(newRule) })).then(() => setNewRule(null)); }}>
            <div className="grid sm:grid-cols-2 gap-2">
              <input className={btn.input} placeholder={t('Name (e.g. Invoices)')} value={newRule.name} onChange={e => setNewRule({ ...newRule, name: e.target.value })} required />
              <select className={btn.input} value={newRule.agent} onChange={e => setNewRule({ ...newRule, agent: e.target.value })}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              <input className={btn.input} placeholder={t('From contains (or /regex/), empty = any')} value={newRule.matchFrom} onChange={e => setNewRule({ ...newRule, matchFrom: e.target.value })} />
              <input className={btn.input} placeholder={t('Subject contains (or /regex/), empty = any')} value={newRule.matchSubject} onChange={e => setNewRule({ ...newRule, matchSubject: e.target.value })} />
            </div>
            <textarea className={clsx(btn.input, 'font-mono min-h-[64px]')} placeholder={t('What to do. Fields: {{from}} {{subject}} {{date}} {{body}} {{snippet}}. Empty = pass the email through. e.g. File this invoice: extract vendor, amount and due date from {{body}} and add a follow-up.')} value={newRule.template} onChange={e => setNewRule({ ...newRule, template: e.target.value })} />
            <p className="text-[11px] text-[var(--text-muted)]">{t('A rule with neither pattern matches every new email. The turn runs unattended; the email is handed over as untrusted data.')}</p>
            <div className="flex gap-2"><button className={btn.primary} type="submit">{t('Create')}</button><button className={btn.ghost} type="button" onClick={() => setNewRule(null)}>{t('Cancel')}</button></div>
          </form>
        )}
        {st.rules.length === 0 && !newRule && <p className="text-[11px] text-[var(--text-muted)]">{t('No rules. New mail still shows in Activity.')}</p>}
        {st.rules.map(r => (
          <div key={r.id} className="flex items-center gap-2 text-xs p-2 rounded-lg border border-[var(--border-subtle)]">
            <span className={clsx('w-2 h-2 rounded-full shrink-0', r.enabled ? 'bg-emerald-400' : 'bg-[var(--text-muted)]')} />
            <span className="font-medium">{r.name}</span>
            <span className="text-[var(--text-muted)] truncate">→ {agents.find(a => a.id === r.agent)?.name ?? r.agent}{r.match_from ? t(' · from “{match_from}”', { match_from: r.match_from }) : ''}{r.match_subject ? t(' · subject “{match_subject}”', { match_subject: r.match_subject }) : ''}{r.hits ? t(' · {hits} hit{v0}', { hits: r.hits, v0: r.hits === 1 ? '' : 's' }) : ''}</span>
            <span className="flex-1" />
            <button className={btn.icon} onClick={() => act(r.id, () => req(`/api/email/inbox/rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) }))}>{r.enabled ? t('On') : t('Off')}</button>
            <button className={btn.icon} title={t('Delete')} onClick={() => { if (confirm(t('Delete the rule “{name}”?', { name: r.name }))) act(r.id, () => req(`/api/email/inbox/rules/${r.id}`, { method: 'DELETE' })); }}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
