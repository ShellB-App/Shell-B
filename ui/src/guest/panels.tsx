import { useEffect, useState } from 'react';
import { Brain, Flag, Info, Laptop, Loader2, Plus, Trash2 } from 'lucide-react';
import { fmtBytes } from '../api';
import { Modal, btn, relTime } from '../components/common';
import { toast } from '../components/toast';
import { guestApi, type GuestMe, type GuestMemory } from './guestApi';

const CATEGORY: Record<string, string> = {
  identity: 'About you', work: 'Work', preference: 'Preference', person: 'Person', project: 'Project',
  interest: 'Interest', routine: 'Routine', other: 'Other',
};

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<GuestMemory[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { guestApi.memories().then(setItems, e => setError(String(e))); }, []);

  const forget = async (id: string) => {
    setItems(xs => xs?.filter(x => x.id !== id) ?? null);
    await guestApi.forget(id).catch(e => toast(`Couldn't forget that: ${e}`, { kind: 'error' }));
  };
  const forgetAll = async () => {
    if (!confirm('Forget everything Shell:B remembers about you? This can\'t be undone.')) return;
    await guestApi.forgetAll();
    setItems([]);
  };

  return (
    <Modal open onClose={onClose} title="What Shell:B remembers about you" icon={<Brain className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">
          Shell:B picks up lasting facts you mention (your name, your work, how you like answers) so later chats start
          off knowing you. This memory is yours alone. Ask it to remember or forget something, or remove items here.
        </p>
        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
        {!items && !error && <div className="mt-6 space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-10 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />)}</div>}
        {items && items.length === 0 && (
          <p className="mt-6 text-sm text-[var(--text-muted)]">Nothing yet. Tell it something about yourself in a chat.</p>
        )}
        {items && items.length > 0 && (
          <ul className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
            {items.map(m => (
              <li key={m.id} className="group flex items-start gap-3 py-2.5">
                <span className="mt-0.5 shrink-0 w-20 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{CATEGORY[m.category] ?? m.category}</span>
                <span className="flex-1 text-sm leading-relaxed">{m.text}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)] mt-1">{relTime(m.createdAt)}</span>
                <button className={btn.icon} title="Forget this" aria-label={`Forget: ${m.text}`} onClick={() => forget(m.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {items && items.length > 0 && (
        <footer className="shrink-0 px-5 py-3 border-t border-[var(--border-subtle)] flex justify-end">
          <button className={`${btn.ghost} text-red-400 hover:text-red-300`} onClick={forgetAll}>Forget everything</button>
        </footer>
      )}
    </Modal>
  );
}

function deviceName(ua: string) {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return app ? `${app} on ${os}` : os;
}

export function DevicesPanel({ me, onClose, onChanged }: { me: GuestMe; onClose: () => void; onChanged: () => void }) {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [making, setMaking] = useState(false);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;

  const make = async () => {
    setMaking(true);
    try {
      const r = await guestApi.deviceCode();
      setCode({ code: r.code, until: Date.now() + r.expiresIn * 1000 });
      setNow(Date.now());
    } catch (e) { toast(String(e), { kind: 'error' }); }
    setMaking(false);
  };
  const drop = async (id: string) => {
    await guestApi.dropDevice(id).catch(e => toast(String(e), { kind: 'error' }));
    onChanged();
  };

  return (
    <Modal open onClose={onClose} title="Your devices" icon={<Laptop className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        <ul className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
          {me.devices.map(d => (
            <li key={d.id} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm">{deviceName(d.userAgent)}{d.current && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--accent-soft)]">this device</span>}</div>
                <div className="text-[11px] text-[var(--text-muted)]">Signed in {relTime(d.created * 1000)} · last used {relTime(d.lastUsed * 1000)}</div>
              </div>
              {!d.current && <button className={btn.ghost} onClick={() => drop(d.id)}>Sign out</button>}
            </li>
          ))}
        </ul>

        <section>
          <h3 className="text-sm font-semibold tracking-tight">Add a device</h3>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)] max-w-[60ch]">
            Make a code here, then open <span className="font-mono">{location.host}</span> on the other device and enter
            it. A code works once and expires after 10 minutes.
          </p>
          {code && left > 0 ? (
            <div className="mt-4 flex items-baseline gap-4">
              <span className="font-mono text-3xl tracking-[0.15em] select-all">{code.code}</span>
              <span className="text-xs text-[var(--text-muted)] tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</span>
            </div>
          ) : (
            <button className={`${btn.subtle} mt-4`} onClick={make} disabled={making}>
              {making ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {code ? 'Make a new code' : 'Make a device code'}
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function ReportPanel({ convId, msgId, onClose }: { convId?: string; msgId?: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [include, setInclude] = useState(!!convId);
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await guestApi.report({ text, convId, msgId, includeChat: include });
      toast('Sent to Evie. Thanks for telling her.');
      onClose();
    } catch (e) {
      toast(String(e).replace(/^Error: \d+: /, ''), { kind: 'error' });
      setSending(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Report to Evie" icon={<Flag className="w-4 h-4 text-[var(--accent)]" />}>
      <form className="flex-1 overflow-y-auto p-5 space-y-4" onSubmit={e => { e.preventDefault(); send(); }}>
        <p className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">
          Something broken, slow or strange? Say what you did and what happened. It goes straight to Evie.
        </p>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={6} autoFocus maxLength={8000}
          placeholder={msgId ? 'What was wrong with this reply?' : 'What happened?'}
          className={`${btn.input} resize-y leading-relaxed`} />
        {convId && (
          <label className="flex items-start gap-2.5 text-xs leading-relaxed text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>Include this chat so Evie can see what happened. Leave it unticked to send only your note.</span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btn.ghost} onClick={onClose}>Cancel</button>
          <button type="submit" className={btn.primary} disabled={sending || !text.trim()}>
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flag className="w-3.5 h-3.5" />}Send report
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Meter({ label, used, cap, unit = '' }: { label: string; used: number; cap: number; unit?: string }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums text-[var(--text-muted)]">{cap ? `${used.toLocaleString()}${unit} of ${cap.toLocaleString()}${unit}` : `${used.toLocaleString()}${unit} · no limit`}</span></div>
      <div className="mt-1 h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
        <div className={pct > 90 ? 'h-full bg-red-400' : 'h-full bg-[var(--accent)]'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AboutPanel({ me, onClose }: { me: GuestMe; onClose: () => void }) {
  const l = me.limits;
  return (
    <Modal open onClose={onClose} title="About Shell:B Guest" icon={<Info className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="flex-1 overflow-y-auto p-5 space-y-6 text-sm leading-relaxed">
        <section className="space-y-2 max-w-[65ch]">
          <p>
            Shell:B runs on Evie's NVIDIA DGX Spark, not in a cloud. The models, image generator, music and voice all
            run on that one machine, and nothing you type is sent to an AI company.
          </p>
          <p className="text-[var(--text-secondary)]">
            Your chats, files and memories are kept apart from Evie's and from other guests', and the AI here can't see
            anything of hers. They are stored on her machine, though, so treat it like borrowing a friend's computer:
            don't put anything here you wouldn't want kept there. Web searches go out to the internet like any search.
          </p>
          <p className="text-[var(--text-secondary)]">
            The machine is shared. When Evie or another guest is using it, your reply may wait a moment for its turn.
          </p>
        </section>
        <section className="space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)]">Today</h3>
          <Meter label="Messages" used={me.today.turns} cap={l.turnsPerDay} />
          <Meter label="Pictures and 3D" used={me.today.images} cap={l.imagesPerDay} />
          <Meter label="Music, sound and voice" used={me.today.audio} cap={l.audioPerDay} />
          <Meter label="Space used (MB)" used={Math.round(me.storageBytes / 2 ** 20)} cap={l.storageMB} />
          <p className="text-[11px] text-[var(--text-muted)]">Daily limits reset at midnight, Evie's time. Space used: {fmtBytes(me.storageBytes)}.</p>
        </section>
      </div>
    </Modal>
  );
}
