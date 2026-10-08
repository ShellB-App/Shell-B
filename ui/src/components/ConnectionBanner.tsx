import { useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { probe, useServerDown } from '../net';

/** A pill over the app while the Spark doesn't answer (net.ts). Drafts and the open chat stay put; it clears itself. */
export function ConnectionBanner() {
  const down = useServerDown();
  const [checking, setChecking] = useState(false);
  if (!down) return null;
  const retry = async () => { setChecking(true); await probe(); setChecking(false); };
  return (
    <div role="status" className="fixed left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full border border-amber-500/40 shadow-lg text-xs text-[var(--text-primary)]"
      style={{ top: 'calc(var(--titlebar-h, 0px) + 10px)', background: 'color-mix(in srgb, var(--bg-secondary) 92%, transparent)', backdropFilter: 'blur(10px)' }}>
      <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span>Can’t reach Shell:B. Reconnecting…</span>
      <button onClick={retry} disabled={checking} aria-label="Try again now"
        className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50">
        <RefreshCw className={'w-3.5 h-3.5' + (checking ? ' animate-spin' : '')} />
      </button>
    </div>
  );
}
