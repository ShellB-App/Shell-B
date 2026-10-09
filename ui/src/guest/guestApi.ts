import { req } from '../api';
import type { Agent } from '../types';

// Shell:B Guest's own endpoints (server/guest_app.py). Chats, uploads, files and speech use the same paths as the
// owner's app, so those calls go through ../api unchanged; the guest server scopes them to the signed-in guest.

export interface GuestDevice { id: string; created: number; lastUsed: number; userAgent: string; current: boolean }
export interface GuestUsage { turns: number; tokens: number; images: number; audio: number; reports: number }
export interface GuestLimits { turnsPerDay: number; tokensPerDay: number; imagesPerDay: number; audioPerDay: number; storageMB: number }
export interface GuestMe {
  id: string;
  name: string;
  today: GuestUsage;
  limits: GuestLimits;
  storageBytes: number;
  agents: Agent[];
  defaultAgent: string;
  devices: GuestDevice[];
}
export interface GuestMemory { id: string; text: string; category: string; createdAt: number; origin: string }

const json = (b: unknown) => JSON.stringify(b);
/** The server leaves out system prompts; the chat components only need the type's shape. */
const agent = (a: Agent): Agent => ({ ...a, systemPrompt: '', color: a.color ?? ['#7c3aed', '#a78bfa'], avatar: a.avatar ?? '✦' });

export const guestApi = {
  me: () => req<GuestMe>('/api/guest/me').then(m => ({ ...m, agents: m.agents.map(agent) })),
  redeem: (code: string) => req<{ ok: boolean; name: string }>('/api/guest/redeem', { method: 'POST', body: json({ code }) }),
  logout: () => req('/api/guest/logout', { method: 'POST' }),
  deviceCode: () => req<{ code: string; expiresIn: number }>('/api/guest/device-code', { method: 'POST' }),
  dropDevice: (id: string) => req(`/api/guest/devices/${id}`, { method: 'DELETE' }),
  memories: () => req<GuestMemory[]>('/api/guest/memories'),
  forget: (id: string) => req(`/api/guest/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  forgetAll: () => req('/api/guest/memories', { method: 'DELETE' }),
  report: (b: { text: string; convId?: string; msgId?: string; includeChat: boolean }) =>
    req<{ id: string }>('/api/guest/report', { method: 'POST', body: json(b) }),
};
