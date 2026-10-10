import { api } from './api';
import { copyText } from './quote';
import { toast } from './components/toast';

/** Make a public read-only share (server/shares.py) and put its link on the clipboard. The link is absolute when
 * Settings → Network → Share host names a host without a login wall; otherwise it is this origin's. */
export async function shareLink(b: { kind: 'chat' | 'artifact'; conversation: string; artifact?: string; version?: number }) {
  try {
    const s = await api.createShare(b);
    const url = s.url.startsWith('#') ? `${location.origin}/${s.url}` : s.url;
    copyText(url, 'Share link copied (read-only, 30 days)');
    if (s.url.startsWith('#')) toast('No share host is set (Settings → Network), so this link opens only for people who can log in here.');
  } catch (e) {
    const msg = String(e).replace(/^Error: \d+: /, '');
    toast(/login-required|admin-key-required/.test(msg)
      ? 'Share links need the owner login: sign in from the HTTPS address (plain localhost access is not enough).'
      : `Couldn't share: ${msg}`, { kind: 'error' });
  }
}
