import { req } from '../api';
import type { Agent } from '../types';

// Shell:B Guest's own endpoints (server/guest_app.py). Chats, uploads, files and speech use the same paths as the
// owner's app, so those calls go through ../api unchanged; the guest server scopes them to the signed-in guest.

export interface GuestDevice { id: string; created: number; lastUsed: number; userAgent: string; via: string; current: boolean }
export interface GuestUsage { turns: number; tokens: number; images: number; audio: number; reports: number }
export interface GuestLimits { turnsPerDay: number; tokensPerDay: number; imagesPerDay: number; audioPerDay: number; storageMB: number }
export interface GuestMe {
  id: string;
  name: string;
  today: GuestUsage;
  /** lifetime tokens of this guest's turns (server/tokens.py) */
  tokensTotal: number;
  limits: GuestLimits;
  storageBytes: number;
  agents: Agent[];
  defaultAgent: string;
  devices: GuestDevice[];
  username: string | null;
  twoStep: boolean;
  /** this device signed in with the password, so it may make device codes */
  deviceCodes: boolean;
}
export interface GuestAuthEvent { ts: number; event: string; label: string; ip: string; userAgent: string; detail: string }
export interface GuestAccount {
  username: string | null; email: string | null; name: string; passwordSet: boolean; twoStep: boolean;
  recoveryLeft: number; deviceCodes: boolean; log: GuestAuthEvent[];
}
export interface GuestAuthMe {
  authenticated: boolean; needsAccount?: boolean; frameKey: string | null;
  /** this guest has their own Shell:B in a container (server/cells.py): the gateway serves the full UI instead */
  cell?: { guest: string };
  guest?: { id: string; name: string; username: string | null };
}
/** A sign-in step's answer: signed in, or a ticket for the two-step code. */
export type SignInResult = { ok: true; name: string } | { twoStep: true; ticket: string };
/** What an invite or reset link is for. `signin`: an invite whose account already exists. */
export interface CodeInfo { kind: 'invite' | 'reset' | 'signin'; name: string; username: string | null }
export interface GuestMemory { id: string; text: string; category: string; createdAt: number; origin: string }
/** The guest's container (server/cells.py): `none` when they are on the guest app instead. */
export interface CellState { state: 'none' | 'starting' | 'running' | 'stopping' | 'stopped'; error?: string }

const json = (b: unknown) => JSON.stringify(b);
/** The server leaves out system prompts; the chat components only need the type's shape. */
const agent = (a: Agent): Agent => ({ ...a, systemPrompt: '', color: a.color ?? ['#7c3aed', '#a78bfa'], avatar: a.avatar ?? '✦' });

export const guestApi = {
  authMe: () => req<GuestAuthMe>('/api/auth/me'),
  me: () => req<GuestMe>('/api/guest/me').then(m => ({ ...m, agents: m.agents.map(agent) })),
  forgot: (who: string) => req<{ ok: boolean; message: string }>('/api/guest/forgot', { method: 'POST', body: json({ who }) }),
  redeem: (code: string) => req<{ ok: boolean; name: string }>('/api/guest/redeem', { method: 'POST', body: json({ code }) }),
  login: (username: string, password: string, remember: boolean) =>
    req<SignInResult>('/api/guest/login', { method: 'POST', body: json({ username, password, remember }) }),
  twoStep: (ticket: string, code: string) =>
    req<SignInResult>('/api/guest/login/two-step', { method: 'POST', body: json({ ticket, code }) }),
  codeInfo: (code: string) => req<CodeInfo>('/api/guest/code', { method: 'POST', body: json({ code }) }),
  signup: (b: { code: string; username: string; password: string; email?: string; remember: boolean }) =>
    req<SignInResult>('/api/guest/signup', { method: 'POST', body: json(b) }),
  reset: (code: string, password: string, remember: boolean) =>
    req<SignInResult>('/api/guest/reset', { method: 'POST', body: json({ code, password, remember }) }),
  account: () => req<GuestAccount>('/api/guest/account'),
  updateAccount: (b: { name?: string; email?: string }) => req<GuestAccount>('/api/guest/account', { method: 'PATCH', body: json(b) }),
  createAccount: (b: { username: string; password: string; email?: string }) =>
    req('/api/guest/account/create', { method: 'POST', body: json(b) }),
  changePassword: (current: string, password: string) =>
    req('/api/guest/account/password', { method: 'POST', body: json({ current, password }) }),
  twoStepSetup: (password: string) =>
    req<{ secret: string; uri: string }>('/api/guest/account/two-step/setup', { method: 'POST', body: json({ password }) }),
  twoStepEnable: (code: string) =>
    req<{ recoveryCodes: string[] }>('/api/guest/account/two-step', { method: 'POST', body: json({ code }) }),
  twoStepDisable: (password: string) => req('/api/guest/account/two-step/off', { method: 'POST', body: json({ password }) }),
  recoveryCodes: (password: string) =>
    req<{ recoveryCodes: string[] }>('/api/guest/account/recovery-codes', { method: 'POST', body: json({ password }) }),
  logout: () => req('/api/guest/logout', { method: 'POST' }),
  deviceCode: () => req<{ code: string; expiresIn: number }>('/api/guest/device-code', { method: 'POST' }),
  dropDevice: (id: string) => req(`/api/guest/devices/${id}`, { method: 'DELETE' }),
  memories: () => req<GuestMemory[]>('/api/guest/memories'),
  forget: (id: string) => req(`/api/guest/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  forgetAll: () => req('/api/guest/memories', { method: 'DELETE' }),
  report: (b: { text: string; convId?: string; msgId?: string; includeChat: boolean }) =>
    req<{ id: string }>('/api/guest/report', { method: 'POST', body: json(b) }),
  cell: () => req<CellState>('/api/guest/cell'),
  startCell: () => req<CellState>('/api/guest/cell', { method: 'POST' }),
};

/** An error's message without the "Error: 401: " the request helper puts in front. */
export const errText = (e: unknown) => String(e).replace(/^Error: \d+: /, '');
