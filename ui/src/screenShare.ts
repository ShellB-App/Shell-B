import { useSyncExternalStore } from 'react';
import { req } from './api';
import { toast } from './components/toast';

/**
 * Screen sharing with Shell:B (server/screen.py).
 * - snapshot(): one picture of a screen, window or tab, to attach to a message.
 * - startLive(): keep sharing. While it's on, this tab is a screen source: it long-polls /api/screen/next and answers
 *   an agent's look_at_screen with the current frame. The share lives here, not in a component, so it survives
 *   switching chats; it ends with stopLive(), the browser's own "Stop sharing" bar, or closing the tab.
 */

export interface LiveShare { label: string; since: number; looks: number }

let live: LiveShare | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let sourceId = '';
let epoch = 0;  // bumps on every start/stop, so an old poll loop knows to quit
const subs = new Set<() => void>();
const publish = () => { live = live && { ...live }; subs.forEach(f => f()); };

export const screenSupported = () => !!navigator.mediaDevices?.getDisplayMedia;

export function useLiveShare(): LiveShare | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => live);
}

async function pick(): Promise<MediaStream> {
  if (!screenSupported()) throw new Error('Screen sharing needs HTTPS and a desktop browser.');
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
}

function describe(s: MediaStream): string {
  const t = s.getVideoTracks()[0];
  const surface = (t?.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  // Chromium labels are ids (screen:0:0, window:123:0, web-contents-media-stream://…); keep only human ones
  const name = t?.label && !/^(screen|window|web-contents-media-stream):|^[\w+/=-]{20,}$/.test(t.label) ? t.label : '';
  if (surface === 'monitor') return name ? `Screen: ${name}` : 'Entire screen';
  if (surface === 'window') return name ? `Window: ${name}` : 'A window';
  if (surface === 'browser') return name ? `Tab: ${name}` : 'A browser tab';
  return name || 'Screen';
}

async function videoFor(s: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = s;
  await v.play();
  if (!v.videoWidth) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
  return v;
}

/** The current frame as a JPEG, longest side at most maxEdge. */
async function frame(s: MediaStream, v: HTMLVideoElement | null, maxEdge: number): Promise<Blob> {
  let src: CanvasImageSource | null = null;
  let w = 0, h = 0;
  const track = s.getVideoTracks()[0];
  // ImageCapture (Chromium) reads the newest frame even while this tab is in the background
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
  if (IC && track) {
    try { const bmp = await new IC(track).grabFrame(); src = bmp; w = bmp.width; h = bmp.height; } catch { /* fall back to the video */ }
  }
  if (!src) {
    const vid = v ?? await videoFor(s);
    src = vid; w = vid.videoWidth; h = vid.videoHeight;
  }
  if (!w || !h) throw new Error('The shared screen has no picture yet.');
  const k = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  if ('close' in src) (src as ImageBitmap).close();
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not encode the frame.'))), 'image/jpeg', 0.85));
}

/** One screenshot, as a file to attach. Uses the live share when there is one, otherwise asks the browser for a screen. */
export async function snapshot(): Promise<File> {
  const name = `screen-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
  if (stream) return new File([await frame(stream, video, 2560)], name, { type: 'image/jpeg' });
  const s = await pick();
  try {
    const v = await videoFor(s);
    await new Promise(r => setTimeout(r, 250));  // the first frames can be blank while capture starts
    return new File([await frame(s, v, 2560)], name, { type: 'image/jpeg' });
  } finally {
    s.getTracks().forEach(t => t.stop());
  }
}

export async function startLive(): Promise<void> {
  if (stream) return;
  const s = await pick();
  const label = describe(s);
  let id: string;
  try {
    ({ id } = await req<{ id: string }>('/api/screen/connect', { method: 'POST', body: JSON.stringify({ name: browserName(), label }) }));
  } catch (e) {
    s.getTracks().forEach(t => t.stop());
    throw e;
  }
  stream = s;
  video = await videoFor(s).catch(() => null);
  sourceId = id;
  live = { label, since: Date.now(), looks: 0 };
  s.getVideoTracks()[0]?.addEventListener('ended', () => { void stopLive(); });
  publish();
  void poll(++epoch, label);
}

export async function stopLive(): Promise<void> {
  if (!stream) return;
  epoch++;
  stream.getTracks().forEach(t => t.stop());
  const id = sourceId;
  stream = null; video = null; sourceId = ''; live = null;
  publish();
  if (id) await req(`/api/screen/disconnect?id=${id}`, { method: 'POST' }).catch(() => {});
}

window.addEventListener('pagehide', () => {
  if (sourceId) navigator.sendBeacon?.(`/api/screen/disconnect?id=${sourceId}`);
});

async function poll(my: number, label: string) {
  let backoff = 1000;
  while (my === epoch && stream) {
    try {
      const { request } = await req<{ request: { rid: string; maxEdge?: number } | null }>(`/api/screen/next?id=${sourceId}`);
      backoff = 1000;
      if (!request || my !== epoch || !stream) continue;
      const path = `/api/screen/frame/${request.rid}?id=${sourceId}`;
      try {
        const jpg = await frame(stream, video, request.maxEdge ?? 2560);
        await req(path, { method: 'POST', body: jpg, headers: { 'Content-Type': 'image/jpeg' } });
        if (live) { live.looks += 1; publish(); }
        toast('Shell:B looked at your screen', { ms: 2500 });
      } catch (e) {
        await req(path, { method: 'POST', headers: { 'X-Screen-Error': String(e).slice(0, 200) } }).catch(() => {});
      }
    } catch (e) {
      if (my !== epoch) return;
      if (/^Error: 404/.test(String(e))) {  // Shell:B restarted and forgot this share: register it again
        try {
          ({ id: sourceId } = await req<{ id: string }>('/api/screen/connect', { method: 'POST', body: JSON.stringify({ name: browserName(), label }) }));
          continue;
        } catch { /* retry below */ }
      }
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

function browserName(): string {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
