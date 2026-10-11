/**
 * A guest's own Shell:B (cell.ts): the gateway's panels inside the full UI. Account and security, devices, limits and
 * "Report to Evie" are answered by the guest gateway (server/guest_app.py, /api/guest/*), not by the cell, so they
 * reuse the guest app's panels (ui/src/guest/panels.tsx) as they are. Sign-out drops the gateway session and reloads:
 * the gateway then serves its sign-in page.
 */
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Flag, Info, Laptop, LogOut, UserRound, type LucideIcon } from 'lucide-react';
import { btn } from './common';
import { cellGuest, type GuestPanel } from '../cell';
import { guestApi, type GuestMe } from '../guest/guestApi';
import { t } from '../i18n';

const AccountPanel = lazy(() => import('../guest/panels').then(m => ({ default: m.AccountPanel })));
const DevicesPanel = lazy(() => import('../guest/panels').then(m => ({ default: m.DevicesPanel })));
const AboutPanel = lazy(() => import('../guest/panels').then(m => ({ default: m.AboutPanel })));
const ReportPanel = lazy(() => import('../guest/panels').then(m => ({ default: m.ReportPanel })));

export const GUEST_ENTRIES: { id: 'account' | 'devices' | 'about' | 'report'; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'account', label: 'Account and security', hint: 'Your password, two-step codes and sign-in history', icon: UserRound },
  { id: 'devices', label: 'Your devices', hint: 'Where you are signed in; sign one in with a code', icon: Laptop },
  { id: 'about', label: 'About and limits', hint: 'What this Shell:B is, and what you have used today', icon: Info },
  { id: 'report', label: 'Report to Evie', hint: 'Something broken, slow or strange? Tell her', icon: Flag },
];

export const toPanel = (id: (typeof GUEST_ENTRIES)[number]['id'], convId?: string): GuestPanel =>
  id === 'report' ? { report: { convId } } : id;

export function signOutGuest() {
  guestApi.logout().catch(() => {}).finally(() => location.replace('/'));
}

/** Renders whichever gateway panel is open (App.tsx and MobileApp.tsx keep the state). */
export function GuestPanelHost({ panel, onClose }: { panel: GuestPanel | null; onClose: () => void }) {
  const [me, setMe] = useState<GuestMe | null>(null);
  const refresh = useCallback(() => guestApi.me().then(setMe).catch(() => {}), []);
  const needsMe = panel === 'devices' || panel === 'about';
  useEffect(() => { if (needsMe) refresh(); }, [needsMe, refresh]);
  if (!panel) return null;
  return (
    <Suspense fallback={null}>
      {panel === 'account' && <AccountPanel onClose={onClose} onChanged={refresh} />}
      {panel === 'devices' && me && <DevicesPanel me={me} onClose={onClose} onChanged={refresh} />}
      {panel === 'about' && me && <AboutPanel me={me} onClose={onClose} />}
      {typeof panel === 'object' && <ReportPanel {...panel.report} onClose={onClose} />}
    </Suspense>
  );
}

/** Settings → Account in a cell: the gateway's panels and sign-out, in place of the owner's password and sessions. */
export function CellAccountTab({ onGuest, convId }: { onGuest?: (p: GuestPanel) => void; convId?: string }) {
  const g = cellGuest();
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm">{g?.name}{g?.username && <span className="text-[var(--text-muted)] font-mono text-xs"> · @{g.username}</span>}</p>
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)] max-w-[65ch] mt-1">
          {t('This is your own Shell:B, running in its own container on Evie\'s machine. Your account is kept by the gateway you signed in to; the settings, memory, chats and projects here are yours alone.')}
        </p>
      </div>
      <div className="rounded-xl border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
        {GUEST_ENTRIES.map(e => (
          <Entry key={e.id} icon={<e.icon className="w-4 h-4 text-[var(--accent)]" />} label={t(e.label)} hint={t(e.hint)}
            onClick={() => onGuest?.(toPanel(e.id, convId))} />
        ))}
      </div>
      <button className={btn.subtle} onClick={signOutGuest}><LogOut className="w-3.5 h-3.5" />{t('Sign out of this device')}</button>
    </div>
  );
}

function Entry({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] first:rounded-t-xl last:rounded-b-xl transition">
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">{hint}</span>
      </span>
      <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
    </button>
  );
}
