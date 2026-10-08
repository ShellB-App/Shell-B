import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, Laptop, Loader2, MonitorUp, Plus, ScreenShare, ScreenShareOff, Trash2 } from 'lucide-react';
import { req } from '../api';
import { screenSupported, startLive, stopLive, useLiveShare } from '../screenShare';
import { btn } from './common';
import { toast } from './toast';

/** Settings → Tools & Connectors → Screen: what's shared right now, and the computers paired with the Screen helper
 *  (server/screen.py, clients/shellb_screen.py). */

interface Source { id: string; kind: 'browser' | 'helper'; name: string; label: string; monitors: { w: number; h: number }[]; since: number; looks: number; screen?: boolean; browser?: boolean }
interface Device { id: string; name: string; created: number; lastSeen?: number; connected: boolean }
interface Paired { id: string; name: string; token: string; url: string; script: string }

const ago = (t?: number) => {
  if (!t) return 'never';
  const s = Date.now() / 1000 - t;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

export function ScreenTab({ locked, cloudScreen }: { locked: boolean; cloudScreen: boolean }) {
  const share = useLiveShare();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<Paired | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    if (locked) return;
    req<Source[]>('/api/screen/sources').then(setSources).catch(() => setSources([]));
    req<Device[]>('/api/screen/devices').then(setDevices).catch(() => setDevices([]));
  }, [locked]);
  useEffect(() => { load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t); }, [load, share]);

  async function pair() {
    setBusy(true);
    try {
      const p = await req<Paired>('/api/screen/devices', { method: 'POST', body: JSON.stringify({ name: name.trim() || 'My computer', url: location.origin }) });
      setPaired(p);
      setName('');
      download(p);
      load();
    } catch (e) { toast(`Couldn't pair: ${String(e).replace(/^Error: \d+: /, '')}`, { kind: 'error' }); }
    finally { setBusy(false); }
  }

  function download(p: Paired) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([p.script], { type: 'text/x-python' }));
    a.download = 'shellb_screen.py';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function unpair(d: Device) {
    if (!confirm(`Unpair ${d.name}? Its helper stops working at once and would need pairing again.`)) return;
    await req(`/api/screen/devices/${d.id}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  async function endSource(s: Source) {
    await req(`/api/screen/sources/${s.id}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  if (locked) return null;
  const helperOk = location.protocol === 'https:';
  return (
    <div className="space-y-6 max-w-3xl">
      <section className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="flex items-start gap-3">
          <MonitorUp className="w-5 h-5 mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Let agents see your screen</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed max-w-[65ch]">
              While a screen is shared, agents whose model can see images get a <code>look_at_screen</code> tool and take a
              screenshot when it helps, only in chats you're in. Each look appears in the chat and is saved in its <code>/work/screen</code>.
              Share from the screen button by the message box (one screenshot, or live), or pair a computer below to share without a browser tab.
              {cloudScreen ? ' Cloud agents may look too (Cloud AI tab).' : ' Only local models look; cloud agents can be allowed in the Cloud AI tab.'}
            </p>
          </div>
          {screenSupported() && (share
            ? <button className={btn.subtle} onClick={() => { void stopLive(); }}><ScreenShareOff className="w-3.5 h-3.5" /> Stop sharing</button>
            : <button className={btn.subtle} onClick={() => { startLive().catch(e => { if (!/NotAllowed|Permission/i.test(String(e))) toast(String(e), { kind: 'error' }); }); }}>
                <ScreenShare className="w-3.5 h-3.5" /> Share this screen</button>)}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Shared now</h3>
        {sources === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
          : sources.length === 0 ? <p className="text-sm text-[var(--text-muted)]">Nothing is shared. Agents can't see any screen.</p>
          : sources.map(s => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--border-subtle)]">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{s.name} <span className="text-[var(--text-muted)]">· {s.label}{s.monitors.length > 1 ? ` · ${s.monitors.length} monitors` : ''}</span></div>
                <div className="text-[11px] text-[var(--text-muted)]">{s.kind === 'helper' ? `Screen helper${s.browser ? (s.screen ? ' · screen + browser' : ' · browser only') : ''}` : 'Browser tab'} · since {new Date(s.since * 1000).toLocaleTimeString()} · {s.looks} look{s.looks === 1 ? '' : 's'}</div>
              </div>
              <button className={btn.ghost} onClick={() => endSource(s)}>End</button>
            </div>
          ))}
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Paired computers</h3>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-[65ch]">
          The Screen helper is a small Python script for Windows, macOS or Linux. While it runs, agents can look at that computer's
          screen without a browser prompt, and use their own Chrome window there to read pages and fill in forms. Anything that
          submits, sends, pays or deletes waits for your approval in the chat. The helper prints a line for every action; stop
          it with Ctrl+C. Unpairing revokes it.
        </p>
        {devices?.map(d => (
          <div key={d.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--border-subtle)]">
            <Laptop className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{d.name}</div>
              <div className="text-[11px] text-[var(--text-muted)]">{d.connected ? 'Running now' : `Last connected ${ago(d.lastSeen)}`}</div>
            </div>
            <button className={btn.icon} title={`Unpair ${d.name}`} aria-label={`Unpair ${d.name}`} onClick={() => unpair(d)}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <input className={btn.input} placeholder="Computer name, e.g. Work laptop" value={name} maxLength={60}
            onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void pair(); }} />
          <button className={btn.primary} onClick={pair} disabled={busy || !helperOk}
            title={helperOk ? '' : 'Open Shell:B on its HTTPS address to pair a computer'}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Pair a computer
          </button>
        </div>
        {paired && (
          <div className="p-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-2 text-xs leading-relaxed">
            <div className="text-sm font-medium">Paired {paired.name}. On that computer:</div>
            <ol className="list-decimal pl-4 space-y-1 text-[var(--text-secondary)]">
              <li>Install Python 3, then run <code>pip install mss pillow playwright</code></li>
              <li>If Chrome or Edge isn't installed: <code>python -m playwright install chromium</code></li>
              <li>Run the downloaded script: <code>python shellb_screen.py</code> (add <code>--no-browser</code> or <code>--no-screen</code> to share less)</li>
            </ol>
            <p className="text-[var(--text-muted)]">Shell:B's browser window has its own profile, separate from your normal browser:
              sign in to sites there yourself when she needs an account. It connects to <code>{paired.url}</code>, so that computer must be on your tailnet.
              The script holds the device token; keep it like a password. It's shown only now.</p>
            <div className="flex gap-2">
              <button className={btn.subtle} onClick={() => download(paired)}><Download className="w-3.5 h-3.5" /> Download again</button>
              <button className={btn.ghost} onClick={() => { void navigator.clipboard?.writeText(`python shellb_screen.py --url ${paired.url} --token ${paired.token}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy command with token
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
