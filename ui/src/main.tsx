import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './index.css';
import './themes';
import { App } from './App';
import { MobileApp } from './mobile/MobileApp';
import { KioskApp } from './kiosk/KioskApp';
import { useFormFactor } from './formFactor';
import { AuthGate } from './components/AuthGate';
import { SynthDJ } from './dj/SynthDJ';
import { Splash } from './components/Splash';
import { Screensaver } from './components/Screensaver';
import './notify';  // notification clicks route the app; hidden-tab notifications on devices without push

function ShellRoot() {
  const formFactor = useFormFactor();

  return (
    <AuthGate>
      {formFactor === 'mobile' ? (
        <MobileApp />
      ) : formFactor === 'kiosk' ? (
        <KioskApp />
      ) : (
        <App />
      )}
      <SynthDJ />
      {formFactor === 'standard' && <Screensaver />}
    </AuthGate>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShellRoot />
    <Splash />
  </StrictMode>
);
