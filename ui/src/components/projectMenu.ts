import { AppWindow, Copy, Download, FolderOpen, Link2, Pencil, Pin, PinOff, Rocket, Smile, Star, StarOff, Trash2 } from 'lucide-react';
import type { ChatProject, ProjectSummary } from '../types';
import { api, rawUrl } from '../api';
import { isFavorite, setFavorite } from '../favorites';
import { copyText } from '../quote';
import { toast } from './toast';
import type { MenuEntry } from './ContextMenu';

/** Icons offered for a chat project (here and the project page's ⋯ menu). */
export const PROJECT_EMOJIS = ['📁', '🧪', '📐', '🛠️', '📊', '🧾', '🚀', '🎯', '🧠', '📦', '🔌', '🏭'];

const failed = (what: string) => (e: unknown) => toast(`Couldn’t ${what}: ${e instanceof Error ? e.message.replace(/^\d+: /, '') : e}`, { kind: 'error' });

/**
 * A Studio project or Code workspace: the cards in Studio, Code and the Library, by right-click or their ⋯ button.
 * Rename, duplicate and delete ask first, as these cards always have.
 */
export function workspaceMenu(pr: ProjectSummary, { onOpen, reload }: { onOpen: () => void; reload: () => void }): MenuEntry[] {
  const code = pr.kind === 'code';
  const route = `#/${code ? 'code' : 'studio'}/${pr.id}`;
  const fav = isFavorite('project', pr.id);
  const noun = code ? 'workspace' : 'project';
  return [
    { label: `Open in ${code ? 'Code' : 'Studio'}`, icon: FolderOpen, onSelect: onOpen },
    { label: 'Open in new window', icon: AppWindow, onSelect: () => window.open(`/${route}`, '_blank', 'noopener') },
    !pr.remote && pr.entry && { label: 'Launch app in new tab', icon: Rocket, onSelect: () => window.open(rawUrl(pr.id, pr.entry), '_blank', 'noopener') },
    'sep',
    { label: 'Rename…', icon: Pencil, onSelect: async () => {
      const n = prompt(`Rename ${noun}`, pr.name);
      if (n?.trim() && n.trim() !== pr.name) await api.patchProject(pr.id, { name: n.trim() }).then(reload, failed('rename it'));
    } },
    !pr.remote && { label: 'Duplicate…', icon: Copy, onSelect: async () => {
      const n = prompt('Name for the copy', `${pr.name} (copy)`);
      if (n !== null) await api.duplicateProject(pr.id, n.trim()).then(reload, failed('duplicate it'));
    } },
    { label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? StarOff : Star, onSelect: () => { setFavorite('project', pr.id, '', !fav, pr.name); } },
    { label: 'Download .zip', icon: Download, onSelect: () => {
      const a = document.createElement('a');
      a.href = `/api/projects/${pr.id}/export.zip`;
      a.download = '';
      a.click();
    } },
    { label: 'Copy link', icon: Link2, onSelect: () => copyText(`${location.origin}/${route}`, 'Link copied') },
    'sep',
    { label: pr.remote ? 'Remove…' : 'Delete…', icon: Trash2, danger: true, onSelect: async () => {
      const ask = pr.remote ? `Remove "${pr.name}" and its chats? The files on ${pr.remote.host} stay where they are.`
        : code ? `Delete "${pr.name}" with all its files, history and chats? This cannot be undone.`
        : `Delete "${pr.name}" and all its files and history? This cannot be undone.`;
      if (confirm(ask)) await api.deleteProject(pr.id).then(reload, failed('delete it'));
    } },
  ];
}

/** A chat project (a folder of chats, files and instructions): the Projects page cards and the sidebar's list. */
export function chatProjectMenu(p: ChatProject, { onOpen, onChanged }: { onOpen: () => void; onChanged: () => void }): MenuEntry[] {
  const fav = isFavorite('group', p.id);
  const patch = (x: Parameters<typeof api.patchChatProject>[1], what: string) => api.patchChatProject(p.id, x).then(onChanged, failed(what));
  const chats = p.chatCount ?? 0;
  return [
    { label: 'Open', icon: FolderOpen, onSelect: onOpen },
    { label: 'Open in new window', icon: AppWindow, onSelect: () => window.open(`/#/p/${p.id}`, '_blank', 'noopener') },
    'sep',
    { label: 'Rename…', icon: Pencil, onSelect: () => {
      const n = prompt('Rename project', p.name);
      if (n?.trim() && n.trim() !== p.name) patch({ name: n.trim() }, 'rename it');
    } },
    { label: 'Icon', icon: Smile, items: PROJECT_EMOJIS.map(e => ({ label: e, checked: p.emoji === e, onSelect: () => patch({ emoji: e }, 'change the icon') })) },
    { label: p.pinned ? 'Unpin' : 'Pin to top', icon: p.pinned ? PinOff : Pin, onSelect: () => patch({ pinned: !p.pinned }, p.pinned ? 'unpin it' : 'pin it') },
    { label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? StarOff : Star, onSelect: () => { setFavorite('group', p.id, '', !fav, p.name); } },
    { label: 'Copy link', icon: Link2, onSelect: () => copyText(`${location.origin}/#/p/${p.id}`, 'Link copied') },
    'sep',
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: async () => {
      if (!confirm(`Delete the project "${p.name}"? Its files are deleted; its ${chats} chat${chats === 1 ? '' : 's'} are kept and move back to your chat list.`)) return;
      try {
        await api.deleteChatProject(p.id, false);
        if (location.hash.startsWith(`#/p/${p.id}`)) location.hash = '#/projects';
        onChanged();
      } catch (e) { failed('delete it')(e); }
    } },
  ];
}
