import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './index.css';
import './themes';
import { useFormFactor } from './formFactor';
import { AuthGate } from './components/AuthGate';
import { Splash } from './components/Splash';
import { Screensaver } from './components/Screensaver';
import { Ambient } from './themes/Ambient';

import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/toast';
import { useWindowControlsOverlay } from './wco';

// Each device loads only its own shell, and the radio (2.6k-line audio engine) comes after the first paint.
const App = lazy(() => import('./App').then(m => ({ default: m.App })));
const MobileApp = lazy(() => import('./mobile/MobileApp').then(m => ({ default: m.MobileApp })));
const KioskApp = lazy(() => import('./kiosk/KioskApp').then(m => ({ default: m.KioskApp })));
const SynthDJ = lazy(() => import('./dj/SynthDJ').then(m => ({ default: m.SynthDJ })));
// only the installed desktop app with its title bar hidden loads this (wco.ts)
const TitleBar = lazy(() => import('./components/TitleBar').then(m => ({ default: m.TitleBar })));
// a read-only share link (#/s/<token>, server/shares.py): rendered outside the login wall, nothing else of the app loads
const SharedView = lazy(() => import('./components/SharedView').then(m => ({ default: m.SharedView })));
const sharedToken = () => /^#\/s\/([0-9a-f]{32})$/.exec(location.hash)?.[1] ?? null;
import './notify';  // notification clicks route the app; hidden-tab notifications on devices without push
import './desktop';  // the installed app: launches, opened and shared files, install prompt, icon badge
import { ConnectionBanner } from './components/ConnectionBanner';
import { ContextMenuHost } from './components/ContextMenu';

function ShellRoot() {
  const formFactor = useFormFactor();
  // re-read on hashchange too: a share link opened from inside the app (same tab) must still show the read-only view
  const [shared, setShared] = useState(sharedToken);
  useEffect(() => {
    const onHash = () => setShared(sharedToken());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (shared) return <Suspense fallback={null}><SharedView token={shared} /></Suspense>;

  return (
    <AuthGate>
      <ErrorBoundary>
        <Suspense fallback={null}>
          {formFactor === 'mobile' ? (
            <MobileApp />
          ) : formFactor === 'kiosk' ? (
            <KioskApp />
          ) : (
            <App />
          )}
        </Suspense>
      </ErrorBoundary>
      <Suspense fallback={null}><SynthDJ /></Suspense>
      <Ambient />
      <Toaster />
      <ConnectionBanner />
      <ContextMenuHost />
      {formFactor === 'standard' && <Screensaver />}
    </AuthGate>
  );
}

function WindowTitleBar() {
  return useWindowControlsOverlay() ? <Suspense fallback={null}><TitleBar /></Suspense> : null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ShellRoot />
      <WindowTitleBar />
      <Splash />
    </ErrorBoundary>
  </StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.error('Service worker registration failed:', err);
    });
  });
}
