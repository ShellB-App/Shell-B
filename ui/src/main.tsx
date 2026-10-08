import { StrictMode, Suspense, lazy } from 'react';
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

import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/toast';

// Each device loads only its own shell, and the radio (2.6k-line audio engine) comes after the first paint.
const App = lazy(() => import('./App').then(m => ({ default: m.App })));
const MobileApp = lazy(() => import('./mobile/MobileApp').then(m => ({ default: m.MobileApp })));
const KioskApp = lazy(() => import('./kiosk/KioskApp').then(m => ({ default: m.KioskApp })));
const SynthDJ = lazy(() => import('./dj/SynthDJ').then(m => ({ default: m.SynthDJ })));
import './notify';  // notification clicks route the app; hidden-tab notifications on devices without push
import './desktop';  // the installed app: launches, opened and shared files, install prompt, icon badge
import { ConnectionBanner } from './components/ConnectionBanner';

function ShellRoot() {
  const formFactor = useFormFactor();

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
      <Toaster />
      <ConnectionBanner />
      {formFactor === 'standard' && <Screensaver />}
    </AuthGate>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ShellRoot />
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
