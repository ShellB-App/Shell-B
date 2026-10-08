import type { Message } from './types';

/** The chat as shown: messages a summary stands for are tucked under it (Show originals), not dropped. Nothing is
 *  deleted on the server either (server/compaction.py); only the agent's prompt leaves them out. */
export function foldSummarized(messages: Message[]): Message[] {
  const summaries = new Map(messages.filter(m => m.role === 'summary').map(m => [m.id, m] as const));
  if (!summaries.size) return messages;
  const under = new Map<string, Message[]>();
  const out: Message[] = [];
  for (const m of messages) {
    const by = m.summarizedBy && summaries.get(m.summarizedBy);
    if (by) {
      under.set(by.id, [...(under.get(by.id) ?? []), m]);
      continue;
    }
    out.push(m);
  }
  // a summary that folded an earlier one shows that one's originals too
  const flatten = (id: string): Message[] =>
    (under.get(id) ?? []).flatMap(m => (m.role === 'summary' ? flatten(m.id) : [m]));
  return out.map(m => (m.role === 'summary' ? { ...m, originals: flatten(m.id) } : m));
}
