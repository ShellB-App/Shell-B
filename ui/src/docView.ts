/** Split view for documents and spreadsheets (server/docview.py, components/DocPanel.tsx): a chat's /work file opened
 *  beside the conversation. Any file chip can call `openDocView(url)`; App and MobileApp listen and show the panel. */
import { req } from './api';

export const DOC_EXT = ['docx', 'doc', 'odt', 'rtf', 'pdf', 'pptx', 'ppt', 'odp', 'md', 'markdown', 'txt', 'log'];
export const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'];

export interface DocTarget { convId: string; path: string }

export interface Sheet {
  name: string;
  rows: string[][];
  formulas: Record<string, string>;
  bold: [number, number][];
  merges: [number, number, number, number][];
  widths: Record<string, number>;
  nrows: number;
  ncols: number;
  truncated: boolean;
  hidden: boolean;
}

export type DocView = { name: string; path: string; size: number; mtime: number; truncated?: boolean; note?: string } & (
  | { kind: 'doc'; html: string }
  | { kind: 'sheet'; sheets: Sheet[]; active: number }
  | { kind: 'pdf'; url: string }
  | { kind: 'markdown' | 'text'; text: string }
);

const ext = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
export const isSheet = (path: string) => SHEET_EXT.includes(ext(path));
export const viewable = (path: string) => DOC_EXT.includes(ext(path)) || SHEET_EXT.includes(ext(path));

/** The chat and path behind a /api/workspace/<conv>/<path> URL, or null for any other URL. */
export function docTarget(url: string): DocTarget | null {
  const m = /\/api\/workspace\/([\w-]+)\/([^?#]+)/.exec(url);
  if (!m) return null;
  const path = decodeURIComponent(m[2]);
  return viewable(path) ? { convId: m[1], path } : null;
}

const EVENT = 'shellb:docview';
export function openDocView(url: string): boolean {
  const target = docTarget(url);
  if (target) window.dispatchEvent(new CustomEvent<DocTarget>(EVENT, { detail: target }));
  return !!target;
}
export function onDocView(fn: (t: DocTarget) => void) {
  const h = (e: Event) => fn((e as CustomEvent<DocTarget>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** A plain click on a chip opens split view; modified clicks (new tab, download) keep the link's own behaviour. */
export function chipClick(e: React.MouseEvent, url: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (openDocView(url)) e.preventDefault();
}

export const fileUrl = (t: DocTarget) => `/api/workspace/${t.convId}/${t.path.split('/').map(encodeURIComponent).join('/')}`;
export const fetchDocView = (t: DocTarget) =>
  req<DocView>(`/api/docview/${t.convId}/${t.path.split('/').map(encodeURIComponent).join('/')}`);

/** Column letters as a spreadsheet shows them: 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
