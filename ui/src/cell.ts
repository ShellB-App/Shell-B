import { setCellMode } from './components/apps';

/**
 * Cell mode: this UI is a guest's own Shell:B running in a container (server/cell_boot.py, server/cells.py), reached
 * through the guest gateway (server/guest_app.py) at the guest address. The gateway's /api/auth/me says so, and
 * AuthGate records it here before the app mounts. Everything that needs the host itself (Models, Offline data, the
 * owner's account, MCP connectors, cloud AI…) checks `isCell()` and steps aside; the gateway's own routes under
 * /api/guest/* (account, devices, limits, Report to Evie, sign-out) stand in for the owner's.
 */
export interface CellGuest { id?: string; name: string; username?: string | null }

let guest: CellGuest | null = null;

export function setCell(g: CellGuest | null) {
  guest = g;
  setCellMode(!!g);
}

export const isCell = () => guest !== null;
export const cellGuest = () => guest;

/** What the gateway's own panels open to (ui/src/guest/panels.tsx, reused inside the full UI). */
export type GuestPanel = 'account' | 'devices' | 'about' | { report: { convId?: string; msgId?: string } };
