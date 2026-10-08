import { AppWindow, Copy, Download, ExternalLink, Link2, Star, StarOff } from 'lucide-react';
import type { ArtifactType, ArtifactVersion } from '../types';
import { api } from '../api';
import { isFavorite, setFavorite } from '../favorites';
import { copyText } from '../quote';
import { toast } from './toast';
import type { MenuEntry } from './ContextMenu';

const EXT: Record<string, string> = { html: 'html', svg: 'svg', markdown: 'md', mermaid: 'mmd' };
const LANG_EXT: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', bash: 'sh', shell: 'sh', rust: 'rs', go: 'go', c: 'c', cpp: 'cpp', java: 'java', json: 'json', yaml: 'yml', sql: 'sql', css: 'css', tsx: 'tsx', jsx: 'jsx' };

/** Saves one artifact version as a file named after it (the side panel's Download button and the menus). */
export function downloadArtifact(v: Pick<ArtifactVersion, 'id' | 'type' | 'language' | 'content'>) {
  const ext = v.type === 'code' ? LANG_EXT[v.language] ?? 'txt' : EXT[v.type] ?? 'txt';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([v.content], { type: 'text/plain;charset=utf-8' }));
  a.download = `${v.id}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Full-page link for one artifact; opens in its own tab, still sandboxed (Library.tsx ArtifactViewer). */
export const artifactViewUrl = (convId: string, artId: string) => `${location.pathname}#/view/${convId}/${artId}`;

const COPY_LABEL: Partial<Record<ArtifactType, string>> = { code: 'Copy code', markdown: 'Copy text', html: 'Copy HTML', svg: 'Copy SVG', mermaid: 'Copy diagram source' };

/**
 * One artifact's context menu, the same in a chat, the Library and anywhere else it shows up. `version` reads the
 * content only when Copy or Download is chosen (a chat's artifact card doesn't carry it); without it, the newest.
 */
export function artifactMenu(a: {
  convId: string; id: string; title: string; type: ArtifactType;
  content?: ArtifactVersion; version?: number;
  onOpen?: () => void; openLabel?: string;
}): MenuEntry[] {
  const fav = isFavorite('artifact', a.convId, a.id);
  const load = async (): Promise<ArtifactVersion> => {
    if (a.content) return a.content;
    const g = (await api.conversation(a.convId)).artifacts.find(x => x.id === a.id);
    const v = g && (g.versions.find(x => x.version === a.version) ?? g.versions[g.versions.length - 1]);
    if (!v) throw new Error('This artifact no longer exists.');
    return v;
  };
  const fail = (e: unknown) => toast(`Couldn’t read the artifact: ${e instanceof Error ? e.message : e}`, { kind: 'error' });
  const page = artifactViewUrl(a.convId, a.id);
  return [
    a.onOpen && { label: a.openLabel ?? 'Open', icon: AppWindow, onSelect: a.onOpen },
    { label: 'Open full page in new tab', icon: ExternalLink, onSelect: () => window.open(page, '_blank', 'noopener') },
    'sep',
    { label: COPY_LABEL[a.type] ?? 'Copy content', icon: Copy, onSelect: () => { load().then(v => copyText(v.content)).catch(fail); } },
    { label: 'Download', icon: Download, onSelect: () => { load().then(downloadArtifact).catch(fail); } },
    { label: 'Copy link', icon: Link2, onSelect: () => copyText(`${location.origin}${page}`, 'Link copied') },
    { label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? StarOff : Star, onSelect: () => { setFavorite('artifact', a.convId, a.id, !fav, a.title); } },
  ];
}
