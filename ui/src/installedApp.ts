import { useEffect, useRef } from 'react';
import type { Status } from './types';
import { APPS } from './components/apps';
import { onIncoming, setBadge } from './desktop';

/**
 * The app shells' side of desktop.ts. The dock/taskbar badge adds up the same counts the app rail shows (Activity
 * waiting and unread, memories to review). Files or text opened with or shared to Shell:B start a new chat, and the
 * composer picks them up there.
 */
export function useInstalledApp(status: Status | undefined, newChat: () => void) {
  useEffect(() => {
    if (status) setBadge(APPS.reduce((n, a) => n + (a.live?.(status)?.badge ?? 0), 0));
  }, [status]);

  const fresh = useRef(newChat);
  fresh.current = newChat;
  useEffect(() => onIncoming(() => fresh.current()), []);
}
