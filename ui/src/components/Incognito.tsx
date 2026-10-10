import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { EyeOff } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';

// Incognito chats (server/privacy.py): not remembered, learned from or searchable, and deleted
// `incognitoHours` (a setting, 24 by default) after the last message by the server's sweep.

export const INCOGNITO_HOURS = 24;
const CHOICES = [1, 6, 24, 72, 168];

/** "6 h", "3 days", "a week" */
export function keepFor(hours: number) {
  if (hours === 168) return 'a week';
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} h`;
}

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The quiet band under the chat header that says this chat leaves no trace. */
export function IncognitoStrip({ updatedAt, hours = INCOGNITO_HOURS }: { updatedAt?: number; hours?: number }) {
  return (
    <div role="status"
      className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 border-b border-dashed border-slate-500/30 bg-slate-500/[0.06] text-[11px] text-[var(--text-secondary)]">
      <EyeOff className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">{t('Incognito')}</span>
      <span className="text-[var(--text-muted)]" aria-hidden>·</span>
      <span className="truncate">
        {t('Not remembered or searchable')}{updatedAt ? t('; deleted {v0} unless you continue', { v0: when(updatedAt + hours * 3600_000) }) : ''}
      </span>
    </div>
  );
}

/** The line under the composer. */
export function IncognitoNote({ hours = INCOGNITO_HOURS }: { hours?: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-[var(--text-secondary)] mt-1.5">
      <EyeOff className="w-3 h-3 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
      <span>{t('Incognito: Shell:B won’t remember or learn from this chat; it is deleted {v0} after the last message.', { v0: keepFor(hours) })}</span>
    </div>
  );
}

/** A small marker beside an incognito chat's title (header, sidebar, palette). */
export function IncognitoMark({ className }: { className?: string }) {
  return (
    <span title={t('Incognito chat: not remembered, deleted automatically')} className="inline-flex shrink-0">
      <EyeOff className={clsx('w-3.5 h-3.5 text-slate-500 dark:text-slate-400', className)} aria-label={t('Incognito')} />
    </span>
  );
}

/** Settings → Memory: how long incognito chats are kept. */
export function IncognitoSettingsRow() {
  const [hours, setHours] = useState<number | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.settings().then(s => setHours(s.incognitoHours ?? INCOGNITO_HOURS)).catch(() => {}); }, []);
  if (hours === null) return null;
  const choices = CHOICES.includes(hours) ? CHOICES : [...CHOICES, hours].sort((a, b) => a - b);
  const save = async (h: number) => {
    const prev = hours;
    setHours(h);
    try { await api.saveSettings({ incognitoHours: h }); setErr(''); }
    catch (e) { setHours(prev); setErr(String(e)); }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-secondary)]">
      <EyeOff className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
      <label htmlFor="incognito-hours">{t('Delete incognito chats')}</label>
      <select id="incognito-hours" value={hours} onChange={e => save(Number(e.target.value))}
        className="bg-transparent border border-[var(--border-subtle)] rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]">
        {choices.map(h => <option key={h} value={h}>{keepFor(h)}</option>)}
      </select>
      <span className="text-[var(--text-muted)]">{t('after their last message. Chats already open follow the new setting.')}</span>
      {err && <span className="text-red-400">{err}</span>}
    </div>
  );
}
