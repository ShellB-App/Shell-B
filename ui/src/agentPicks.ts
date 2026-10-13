import { useEffect, useState } from 'react';
import type { Agent } from './types';

// Which agents the composer's agent dropdown lists (components/composer/ComposerMenus.tsx). Per browser, like the
// ambience prefs: `pinned` is the person's own choice from "More agents" (null = not chosen yet, so the dropdown
// shows the most-used ones), `uses` counts picks from the dropdown and the phone's agent sheet.
export interface AgentPicks {
  pinned: string[] | null;
  uses: Record<string, number>;
}

const KEY = 'shellb.agentPicks';
const EVENT = 'shellb-agent-picks';
/** How many agents the dropdown shows before the person pins their own. */
export const QUICK_COUNT = 6;

export function loadAgentPicks(): AgentPicks {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { pinned: Array.isArray(p.pinned) ? p.pinned : null, uses: p.uses && typeof p.uses === 'object' ? p.uses : {} };
  } catch {
    return { pinned: null, uses: {} };
  }
}

function save(next: AgentPicks) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function recordAgentPick(id: string) {
  const p = loadAgentPicks();
  save({ ...p, uses: { ...p.uses, [id]: (p.uses[id] ?? 0) + 1 } });
}

/** Pin or unpin one agent. The first pin starts from what the dropdown showed, so nothing disappears unasked. */
export function toggleAgentPin(id: string, shown: string[]) {
  const p = loadAgentPicks();
  const pinned = p.pinned ?? shown;
  save({ ...p, pinned: pinned.includes(id) ? pinned.filter(x => x !== id) : [...pinned, id] });
}

/** Back to the most-used agents. */
export function resetAgentPins() {
  save({ ...loadAgentPicks(), pinned: null });
}

export function useAgentPicks(): AgentPicks {
  const [picks, setPicks] = useState(loadAgentPicks);
  useEffect(() => {
    const on = (e: Event) => setPicks((e as CustomEvent<AgentPicks>).detail);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setPicks(loadAgentPicks()); };
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', onStorage); };
  }, []);
  return picks;
}

/** The dropdown's agents: the pinned ones in pin order, or else the most-used local agents (roster order breaks ties).
 * Cloud agents only appear here when pinned; otherwise they stay in the Cloud submenu. */
export function quickAgents(agents: Agent[], picks: AgentPicks): Agent[] {
  if (picks.pinned) {
    const byId = new Map(agents.map(a => [a.id, a]));
    return picks.pinned.map(id => byId.get(id)).filter((a): a is Agent => !!a);
  }
  return agents
    .filter(a => !a.cloud)
    .map((a, i) => ({ a, i, n: picks.uses[a.id] ?? 0 }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .slice(0, QUICK_COUNT)
    .sort((x, y) => x.i - y.i)
    .map(x => x.a);
}

/** Case-insensitive match on name, title and description. */
export const matchesAgent = (a: Agent, q: string) =>
  !q || `${a.name} ${a.title} ${a.description}`.toLowerCase().includes(q.trim().toLowerCase());
