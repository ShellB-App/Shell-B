import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import '../index.css';
import '../themes';
import { Ambient } from '../themes/Ambient';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Toaster } from '../components/toast';
import { ContextMenuHost } from '../components/ContextMenu';
import { GuestGate } from './GuestGate';
import { linkRoute } from '../links';

// shellb:// links opened from other apps (manifest protocol_handlers) arrive as /?link=<url>: go to their route
const launchRoute = (u: URL) => { const l = u.searchParams.get('link'); return l === null ? null : linkRoute(l) ?? '#/'; };
const startRoute = launchRoute(new URL(location.href));
if (startRoute) history.replaceState(null, '', '/' + startRoute);
(window as unknown as { launchQueue?: { setConsumer: (cb: (p: { targetURL?: string }) => void) => void } }).launchQueue
  ?.setConsumer(p => { const r = p.targetURL ? launchRoute(new URL(p.targetURL)) : null; if (r && r !== location.hash) location.hash = r; });

// Shell:B Guest (guest.html, served by server/guest_app.py on the guest address). None of the owner's shell
// (App.tsx, rail, settings) is loaded here.
const GuestApp = lazy(() => import('./GuestApp').then(m => ({ default: m.GuestApp })));
// the radio's station engine and mini player (it keeps playing while the guest chats)
const SynthDJ = lazy(() => import('../dj/SynthDJ').then(m => ({ default: m.SynthDJ })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <GuestGate>
        {(me, refresh) => (
          <Suspense fallback={null}>
            <GuestApp key={me.id} me={me} refresh={refresh} />
            <SynthDJ />
          </Suspense>
        )}
      </GuestGate>
      <Ambient />
      <Toaster />
      <ContextMenuHost />
    </ErrorBoundary>
  </StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/guest-sw.js').catch(err => console.error('Service worker registration failed:', err));
  });
}
