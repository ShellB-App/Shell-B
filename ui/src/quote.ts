/**
 * "Quote in reply" (the message context menu): puts text into the chat page's composer as a Markdown quote, ready
 * for the question that goes with it. Composer.tsx (the `inbox` one) listens.
 */
import { toast } from './components/toast';

const EVENT = 'shellb-quote';

export function quoteInComposer(text: string) {
  const body = text.trim();
  if (body) window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: body }));
}

/** The composer's side: `cb` gets the text already formatted as a quote block. Returns the unsubscribe. */
export function onQuote(cb: (quoted: string) => void) {
  const h = (e: Event) => cb((e as CustomEvent<string>).detail.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n') + '\n\n');
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Clipboard copy for menu actions, with a toast either way. */
export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, { kind: 'success', ms: 1500 });
  } catch {
    toast('Couldn’t copy: the browser blocked the clipboard', { kind: 'error' });
  }
}
