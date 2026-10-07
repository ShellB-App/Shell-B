import { useEffect, useState } from 'react';
import { req } from './api';

export interface Suggestion { title: string; prompt: string }

/** The empty-chat cards: the server's freshly generated set for this agent (server/suggestions.py), else `fallback`. */
export function useSuggestions(agentId: string, fallback: Suggestion[]): Suggestion[] {
  const [items, setItems] = useState<Suggestion[]>([]);
  useEffect(() => {
    let live = true;
    setItems([]);
    req<{ items: Suggestion[] }>(`/api/suggestions?agent=${encodeURIComponent(agentId)}`)
      .then(r => { if (live) setItems(r.items); })
      .catch(() => { /* keep the static cards */ });
    return () => { live = false; };
  }, [agentId]);
  return items.length ? items : fallback;
}
