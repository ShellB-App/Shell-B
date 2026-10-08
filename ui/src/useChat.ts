import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat, type ChatRequest } from './api';
import type { ArtifactGroup, ArtifactVersion, Block, Conversation, Message, StreamEvent } from './types';

export function applyEvent(m: Message, ev: StreamEvent): Message {
  const blocks = [...(m.blocks ?? [])];
  switch (ev.type) {
    case 'block_start': blocks[ev.index] = ev.block; return { ...m, blocks };
    case 'block_delta': {
      const b = blocks[ev.index] as Extract<Block, { text: string }>;
      if (b) blocks[ev.index] = { ...b, text: b.text + ev.text } as Block;
      return { ...m, blocks };
    }
    case 'block_update': blocks[ev.index] = ev.block; return { ...m, blocks };
    case 'model': return { ...m, model: ev.model, note: ev.note };
    case 'memories': return { ...m, recalled: ev.memories };
    default: return m;
  }
}

export function upsertArtifact(groups: ArtifactGroup[], a: ArtifactVersion): ArtifactGroup[] {
  const g = groups.find(x => x.id === a.id);
  if (!g) return [...groups, { id: a.id, title: a.title, type: a.type, language: a.language, versions: [a] }];
  return groups.map(x => (x.id === a.id ? { ...x, title: a.title, type: a.type, language: a.language, versions: [...x.versions.filter(v => v.version !== a.version), a] } : x));
}

/**
 * One conversation's state plus streaming. `onEvent` sees every server event (artifacts, files, commits, titles)
 * for side effects outside the transcript; `onSettled` runs when a turn ends.
 */
export function useChat(opts: { onEvent?: (ev: StreamEvent, convId: string) => void; onSettled?: (convId: string) => void } = {}) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const convRef = useRef<Conversation | null>(null);
  convRef.current = conv;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(async (id: string) => {
    const c = await api.conversation(id);
    convRef.current = c;
    setConv(c);
    return c;
  }, []);

  const send = useCallback(async (convId: string, body: ChatRequest) => {
    setBusy(true);
    if (body.fromMessageId) {
      setConv(c => {
        if (!c || c.id !== convId) return c;
        const i = c.messages.findIndex(m => m.id === body.fromMessageId);
        return i >= 0 ? { ...c, messages: c.messages.slice(0, i) } : c;
      });
    }
    const mine = (f: (c: Conversation) => Conversation) => setConv(c => (c && c.id === convId ? f(c) : c));
    let liveId = '';
    try {
      for await (const ev of streamChat(convId, body)) {
        optsRef.current.onEvent?.(ev, convId);
        switch (ev.type) {
          case 'start':
            liveId = ev.message.id;
            mine(c => ({ ...c, messages: [...c.messages, ev.userMessage, ev.message] }));
            break;
          case 'artifact':
            mine(c => ({ ...c, artifacts: upsertArtifact(c.artifacts, ev.artifact) }));
            break;
          case 'title':
            mine(c => ({ ...c, title: ev.title }));
            break;
          case 'summarized': {  // older messages now reach the agent as a summary: fold them under it
            const of = new Set(ev.summary.summaryOf ?? []);
            mine(c => {
              const msgs = c.messages.map(m => (of.has(m.id) || m.role === 'summary' && !m.summarizedBy && m.id !== ev.summary.id
                ? { ...m, summarizedBy: ev.summary.id } : m));
              const at = msgs.findIndex(m => m.timestamp > ev.summary.timestamp);
              return { ...c, messages: at < 0 ? [...msgs, ev.summary] : [...msgs.slice(0, at), ev.summary, ...msgs.slice(at)] };
            });
            break;
          }
          case 'done':
            mine(c => ({ ...c, messages: c.messages.map(m => (m.id === liveId ? ev.message : m)) }));
            break;
          case 'block_start': case 'block_delta': case 'block_update': case 'model': case 'memories':
            mine(c => ({ ...c, messages: c.messages.map(m => (m.id === liveId ? applyEvent(m, ev) : m)) }));
            break;
          default:
            break;
        }
      }
    } catch (e) {
      mine(c => ({
        ...c,
        messages: liveId
          ? c.messages.map(m => (m.id === liveId ? { ...m, status: 'error', error: String(e) } : m))
          : [...c.messages, { id: `err-${Date.now()}`, role: 'assistant', content: '', timestamp: Date.now(), status: 'error', error: String(e), agentId: body.agentId }],
      }));
    } finally {
      setBusy(false);
      optsRef.current.onSettled?.(convId);
    }
  }, []);

  const stop = useCallback(() => { if (convRef.current) api.stop(convRef.current.id); }, []);

  // a turn still running server-side (e.g. page reloaded mid-reply): poll until it lands
  useEffect(() => {
    if (!conv?.streaming || busy) return;
    const id = conv.id;
    const t = setInterval(async () => {
      const c = await api.conversation(id).catch(() => null);
      if (c && convRef.current?.id === id) setConv(c);
      if (!c?.streaming) { clearInterval(t); optsRef.current.onSettled?.(id); }
    }, 1500);
    return () => clearInterval(t);
  }, [conv?.id, conv?.streaming, busy]);

  return { conv, setConv, convRef, busy, load, send, stop };
}
