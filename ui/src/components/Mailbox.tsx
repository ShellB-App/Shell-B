import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Mail, Send, Zap } from 'lucide-react';
import { api, type MailboxNote } from '../api';
import { btn, relTime } from './common';
import { toastError } from './toast';
import { t as tx } from '../i18n';

const WAKE_KEY = 'shellb.mailbox.wake';
const readWake = () => { try { return localStorage.getItem(WAKE_KEY) === '1'; } catch { return false; } };

/** The chat's mailbox (server/chatmail.py): notes other conversations left for this one, and a way to leave one
 * yourself. An envelope in the chat header with the unread count; the agent sees unread notes on its next turn, or
 * at once with the wake toggle on (`onWoke` then reloads the chat so its reply streams in). */
export function Mailbox({ convId, tick, onWoke }: { convId: string; tick?: number; onWoke?: () => void }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<MailboxNote[] | null>(null);
  const [text, setText] = useState('');
  const [wake, setWake] = useState(readWake);
  const [sent, setSent] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { api.mailbox(convId, true).then(r => setUnread(r.unread)).catch(() => {}); }, [convId, tick]);
  const load = useCallback(() => api.mailbox(convId).then(r => { setNotes(r.messages.slice().reverse()); setUnread(r.unread); }).catch(toastError(tx('Mailbox'))), [convId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => setSent(''), [convId, open]);
  const toggleWake = () => setWake(w => { try { localStorage.setItem(WAKE_KEY, w ? '0' : '1'); } catch { /* private window */ } return !w; });
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    api.mailboxSend(convId, t, wake).then(r => {
      setText('');
      load();
      setSent(r.delivery === 'started' ? tx('Sent. The chat is answering now.')
        : r.delivery === 'queued' ? tx('Sent. The chat will answer when its current reply ends.')
        : wake ? tx('Left in the mailbox: the chat can\'t be woken right now.') : '');
      if (r.delivery !== 'mailbox') onWoke?.();
    }).catch(toastError(tx('Mailbox')));
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!open && !unread) return (
    <button className={btn.icon} onClick={() => setOpen(true)} title={tx('Notes other chats left here')}>
      <Mail className="w-3.5 h-3.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" />
    </button>
  );
  return (
    <div className="relative" ref={box}>
      <button className={clsx(btn.icon, 'relative')} onClick={() => setOpen(o => !o)} title={unread ? tx('{unread} unread note{v0} from other chats', { unread: unread, v0: unread === 1 ? '' : 's' }) : tx('Notes other chats left here')}>
        <Mail className={clsx('w-3.5 h-3.5', unread ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[9px] font-semibold flex items-center justify-center">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-80 max-w-[90vw] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">{tx('Mailbox')}</span>
            {unread > 0 && <button className={btn.ghost} onClick={() => api.mailboxRead(convId).then(load).catch(toastError(tx('Mailbox')))}>{tx('Mark all read')}</button>}
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {notes === null && <div className="text-[11px] text-[var(--text-muted)]">{tx('Loading…')}</div>}
            {notes?.length === 0 && <div className="text-[11px] text-[var(--text-muted)] max-w-[40ch]">{tx('No notes yet. Agents in other chats can leave one with leave_message; you can leave one below and the agent reads it on its next turn.')}</div>}
            {notes?.map(n => (
              <div key={n.id} className={clsx('rounded-lg border px-2.5 py-1.5 text-[12px]', n.read_at ? 'border-[var(--border-subtle)]' : 'border-[var(--accent)]/40 bg-[var(--accent)]/5')}>
                <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                  {n.from_conv ? <a className="truncate hover:underline" href={`#/c/${n.from_conv}`}>{n.fromTitle}</a> : <span>{n.fromTitle}</span>}
                  <span className="shrink-0">{relTime(n.created * 1000)}</span>
                </div>
                <div className="whitespace-pre-wrap leading-snug">{tx(n.text)}</div>
              </div>
            ))}
          </div>
          <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); submit(); }}>
            <input className={clsx(btn.input, 'flex-1')} placeholder={wake ? tx('Message this chat; it answers right away') : tx('Leave a note for this chat\'s next turn')} value={text} onChange={e => setText(e.target.value)} maxLength={4000} />
            <button type="button" className={clsx(btn.icon, 'focus-visible:ring-2 focus-visible:ring-[var(--accent)]')} onClick={toggleWake} aria-pressed={wake}
              title={wake ? tx('Wake on: the chat starts a turn on your note (click to just leave it)') : tx('Wake off: the note waits for the chat\'s next turn (click to wake it)')}>
              <Zap className={clsx('w-3.5 h-3.5', wake ? 'text-[var(--accent)] fill-current' : 'text-[var(--text-muted)]')} />
            </button>
            <button className={btn.icon} type="submit" title={wake ? tx('Send and wake the chat') : tx('Leave the note')} disabled={!text.trim()}><Send className="w-3.5 h-3.5" /></button>
          </form>
          {sent && <div className="text-[11px] text-[var(--text-muted)]" role="status">{sent}</div>}
        </div>
      )}
    </div>
  );
}
