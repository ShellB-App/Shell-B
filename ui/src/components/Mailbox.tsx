import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Mail, Send } from 'lucide-react';
import { api, type MailboxNote } from '../api';
import { btn, relTime } from './common';
import { toastError } from './toast';

/** The chat's mailbox (server/chatmail.py): notes other conversations left for this one, and a way to leave one
 * yourself. An envelope in the chat header with the unread count; the agent sees unread notes on its next turn. */
export function Mailbox({ convId, tick }: { convId: string; tick?: number }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<MailboxNote[] | null>(null);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { api.mailbox(convId, true).then(r => setUnread(r.unread)).catch(() => {}); }, [convId, tick]);
  const load = useCallback(() => api.mailbox(convId).then(r => { setNotes(r.messages.slice().reverse()); setUnread(r.unread); }).catch(toastError('Mailbox')), [convId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!open && !unread) return (
    <button className={btn.icon} onClick={() => setOpen(true)} title="Notes other chats left here">
      <Mail className="w-3.5 h-3.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" />
    </button>
  );
  return (
    <div className="relative" ref={box}>
      <button className={clsx(btn.icon, 'relative')} onClick={() => setOpen(o => !o)} title={unread ? `${unread} unread note${unread === 1 ? '' : 's'} from other chats` : 'Notes other chats left here'}>
        <Mail className={clsx('w-3.5 h-3.5', unread ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg)] text-[9px] font-semibold flex items-center justify-center">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-80 max-w-[90vw] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Mailbox</span>
            {unread > 0 && <button className={btn.ghost} onClick={() => api.mailboxRead(convId).then(load).catch(toastError('Mailbox'))}>Mark all read</button>}
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {notes === null && <div className="text-[11px] text-[var(--text-muted)]">Loading…</div>}
            {notes?.length === 0 && <div className="text-[11px] text-[var(--text-muted)] max-w-[40ch]">No notes yet. Agents in other chats can leave one with leave_message; you can leave one below and the agent reads it on its next turn.</div>}
            {notes?.map(n => (
              <div key={n.id} className={clsx('rounded-lg border px-2.5 py-1.5 text-[12px]', n.read_at ? 'border-[var(--border-subtle)]' : 'border-[var(--accent)]/40 bg-[var(--accent)]/5')}>
                <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                  {n.from_conv ? <a className="truncate hover:underline" href={`#/c/${n.from_conv}`}>{n.fromTitle}</a> : <span>{n.fromTitle}</span>}
                  <span className="shrink-0">{relTime(n.created * 1000)}</span>
                </div>
                <div className="whitespace-pre-wrap leading-snug">{n.text}</div>
              </div>
            ))}
          </div>
          <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); const t = text.trim(); if (!t) return; api.mailboxSend(convId, t).then(() => { setText(''); load(); }).catch(toastError('Mailbox')); }}>
            <input className={clsx(btn.input, 'flex-1')} placeholder="Leave a note for this chat's next turn" value={text} onChange={e => setText(e.target.value)} maxLength={4000} />
            <button className={btn.icon} type="submit" title="Leave the note" disabled={!text.trim()}><Send className="w-3.5 h-3.5" /></button>
          </form>
        </div>
      )}
    </div>
  );
}
