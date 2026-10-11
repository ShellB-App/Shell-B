import { useEffect, useRef, useState } from 'react';
import { AudioLines, Download, Plug, RadioTower, Send, Unplug, Upload } from 'lucide-react';
import { api } from '../api';
import { btn } from './common';
import { t } from '../i18n';

interface Message {
  from_agent: string;
  to_agent: string;
  payload: unknown;
  timestamp: number;
  msg_type: string;
}

interface Entry {
  id: number;
  direction: 'sent' | 'received' | 'file';
  message: Message;
}

function newAgentId() {
  return `web-${Math.random().toString(36).slice(2, 9)}`;
}

export function Gibberlink() {
  const [health, setHealth] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(newAgentId);
  const [recipient, setRecipient] = useState('');
  const [payloadText, setPayloadText] = useState('{"text":"Hello."}');
  const [ultrasound, setUltrasound] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [wav, setWav] = useState<{ url: string; name: string } | null>(null);
  const socket = useRef<WebSocket | null>(null);
  let byteSize: number | null = null;
  try {
    const payload = JSON.parse(payloadText);
    byteSize = new TextEncoder().encode(JSON.stringify({
      from_agent: agentId.trim(), to_agent: recipient.trim(), payload,
      timestamp: 1_000_000_000.1234567, msg_type: 'message',
    })).length;
  } catch { /* invalid JSON is reported when sending */ }

  const refresh = () => {
    api.gibberlinkHealth().then(value => setHealth(value.gibberlink)).catch(() => setHealth(false));
    api.gibberlinkAgents().then(value => setAgents(value.agents)).catch(() => setAgents([]));
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.clearInterval(timer);
      socket.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!wav) return;
    return () => URL.revokeObjectURL(wav.url);
  }, [wav]);

  const disconnect = () => {
    socket.current?.close(1000, 'User disconnected');
    socket.current = null;
    setConnected(false);
    setConnecting(false);
  };

  const connect = () => {
    const id = agentId.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      setError('Use 1–64 letters, numbers, underscores, or hyphens for the agent ID.');
      return;
    }
    disconnect();
    setError('');
    setConnecting(true);
    const url = new URL(`/api/gibberlink/ws/${encodeURIComponent(id)}`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocket(url);
    next.binaryType = 'arraybuffer';
    next.onopen = () => { setConnecting(false); setConnected(true); refresh(); };
    next.onmessage = event => {
      const audio = new Blob([event.data as ArrayBuffer], { type: 'audio/wav' });
      api.gibberlinkDecode(audio).then(message => {
        setEntries(items => [{ id: Date.now() + Math.random(), direction: 'received', message }, ...items]);
        refresh();
      }).catch(reason => setError(String(reason)));
    };
    next.onerror = () => { setConnecting(false); setError('Could not connect to the HERMES relay.'); };
    next.onclose = () => {
      if (socket.current === next) {
        socket.current = null;
        setConnected(false);
        setConnecting(false);
      }
      refresh();
    };
    socket.current = next;
  };

  const send = async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) return;
    let payload: unknown;
    try { payload = JSON.parse(payloadText); }
    catch { setError('Payload must be valid JSON.'); return; }
    if (!recipient.trim()) { setError('Enter a connected recipient ID.'); return; }
    if (recipient.trim() !== '*' && !agents.includes(recipient.trim())) {
      setError('Recipient is not connected. Choose an online ID or use * to broadcast.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const message = { from_agent: agentId.trim(), to_agent: recipient.trim(), payload, ultrasound };
      const audio = await api.gibberlinkEncode(message);
      if (!socket.current || socket.current.readyState !== WebSocket.OPEN) throw new Error('Relay disconnected before sending.');
      socket.current.send(audio);
      const url = URL.createObjectURL(audio);
      setWav(previous => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { url, name: `gibberlink-${message.to_agent}.wav` };
      });
      setEntries(items => [{
        id: Date.now() + Math.random(), direction: 'sent',
        message: { ...message, timestamp: Date.now() / 1000, msg_type: 'message' },
      }, ...items]);
      refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const decodeFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const message = await api.gibberlinkDecode(file);
      setEntries(items => [{ id: Date.now() + Math.random(), direction: 'file', message }, ...items]);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-5 sm:px-6 sm:py-7 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <RadioTower className="w-6 h-6 text-pink-400" />
            <div>
              <h1 className="text-lg font-semibold">{t('Gibberlink')}</h1>
              <p className="text-xs text-[var(--text-muted)]">{t('Short messages over sound')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${health ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            <span className="text-[var(--text-secondary)]">{health === null ? t('Checking HERMES') : health ? t('HERMES ready') : t('HERMES unavailable')}</span>
          </div>
        </header>

        <section className="border-y border-[var(--border-subtle)] py-3">
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-3 sm:items-end">
            <label className="block text-xs text-[var(--text-secondary)]">
              {t('Your agent ID')}
              <input className={`${btn.input} mt-1`} value={agentId} disabled={connected}
                onChange={event => setAgentId(event.target.value)} maxLength={64} />
            </label>
            <button className={connected ? btn.subtle : btn.primary} onClick={connected ? disconnect : connect}
              disabled={!health || connecting}>
              {connected ? <><Unplug className="w-3.5 h-3.5" />{t('Disconnect')}</> : <><Plug className="w-3.5 h-3.5" />{connecting ? t('Connecting…') : t('Connect')}</>}
            </button>
            <div className="text-xs text-[var(--text-muted)] sm:text-right">
              {connected ? t('Connected') : connecting ? t('Connecting') : t('Disconnected')} · {agents.length} online
            </div>
          </div>
          {agents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <span>{t('Online:')}</span>{agents.map(id => <button key={id} disabled={!connected} onClick={() => setRecipient(id)}
              className="font-mono hover:text-[var(--accent-soft)] disabled:cursor-default">{id}</button>)}
          </div>}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-10">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('Transmit')}</h2>
            <label className="block text-xs text-[var(--text-secondary)]">
              {t('Recipient ID')}
              <input className={`${btn.input} mt-1`} value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={t('Connected agent ID')} />
            </label>
            <label className="block text-xs text-[var(--text-secondary)]">
              {t('JSON payload')}
              <textarea className={`${btn.input} mt-1 min-h-28 font-mono text-xs resize-y`} value={payloadText}
                onChange={event => setPayloadText(event.target.value)} spellCheck={false} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input type="checkbox" checked={ultrasound} onChange={event => setUltrasound(event.target.checked)} />{t('Ultrasound')}
              </label>
              <span className={`text-[11px] ${byteSize !== null && byteSize > 140 ? 'text-rose-400' : 'text-[var(--text-muted)]'}`}>
                {byteSize === null ? t('Enter valid JSON') : t('{byteSize} / 140 bytes', { byteSize: byteSize })}
              </span>
              <button className={`${btn.primary} ml-auto`} onClick={send} disabled={!connected || busy || !health || byteSize === null || byteSize > 140}>
                <Send className="w-3.5 h-3.5" />{busy ? t('Sending…') : t('Send audio message')}
              </button>
            </div>
            {wav && <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
              <audio controls src={wav.url} className="h-9 max-w-full" />
              <a className={btn.ghost} href={wav.url} download={wav.name}><Download className="w-3.5 h-3.5" />WAV</a>
            </div>}
            <label className={`${btn.ghost} cursor-pointer`}>
              <Upload className="w-3.5 h-3.5" />{t('Decode WAV file')}
              <input className="sr-only" type="file" accept="audio/wav,.wav" disabled={busy || !health}
                onChange={event => { void decodeFile(event.target.files?.[0]); event.target.value = ''; }} />
            </label>
          </section>

          <section className="min-h-48 border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] pt-4 lg:pt-0 lg:pl-6">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold">{t('Messages')}</h2>
              <button className={btn.ghost} onClick={() => setEntries([])} disabled={!entries.length}>{t('Clear')}</button>
            </div>
            {error && <div role="alert" className="mb-3 text-xs text-rose-400 break-words">{error}</div>}
            {!entries.length ? (
              <div className="flex items-center gap-2 py-8 text-xs text-[var(--text-muted)]"><AudioLines className="w-4 h-4" />{t('No messages yet')}</div>
            ) : (
              <ol className="divide-y divide-[var(--border-subtle)] max-h-[60vh] overflow-y-auto">
                {entries.map(entry => <li key={entry.id} className="py-3 first:pt-0">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className={entry.direction === 'received' ? 'text-emerald-400' : 'text-pink-400'}>
                      {entry.direction === 'received' ? t('Received') : entry.direction === 'file' ? t('Decoded') : t('Sent')}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)]">{entry.message.from_agent} → {entry.message.to_agent}</span>
                    <time className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">
                      {new Date(entry.message.timestamp * 1000).toLocaleTimeString()}
                    </time>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-[var(--text-primary)]">
                    {JSON.stringify(entry.message.payload, null, 2)}
                  </pre>
                </li>)}
              </ol>
            )}
          </section>
        </div>

        <footer className="border-t border-[var(--border-subtle)] pt-3 text-[11px] text-[var(--text-muted)]">
          {t('Audio is not encrypted. Use only trusted networks; don’t transmit secrets.')}
        </footer>
      </div>
    </div>
  );
}