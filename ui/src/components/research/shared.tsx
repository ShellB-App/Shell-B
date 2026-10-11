import { createContext, memo, useContext, useEffect, useState } from 'react';
import clsx from 'clsx';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  AudioLines, BookOpen, CircleQuestionMark, FileSpreadsheet, FileText, FileType, Globe, GraduationCap, Image as ImageIcon, Layers,
  ListChecks, Network, Newspaper, Presentation, ScrollText, Type, Video, type LucideIcon,
} from 'lucide-react';
import type { Agent, Level, NotebookCitation, ResearchBoardDetail, ResearchItem, StudioType } from '../../types';
import { t as tx } from '../../i18n';

export const LEVEL_STYLE: Record<Level, { bar: string; text: string; label: string }> = {
  high: { bar: 'bg-emerald-500', text: 'text-emerald-500', label: 'High' },
  medium: { bar: 'bg-amber-500', text: 'text-amber-500', label: 'Medium' },
  low: { bar: 'bg-rose-500', text: 'text-rose-500', label: 'Low' },
};

export const STUDIO_META: Record<StudioType, { label: string; icon: LucideIcon; tint: string; blurb: string }> = {
  audio: { label: 'Audio Overview', icon: AudioLines, tint: '#0d9488', blurb: 'Two hosts talk through your sources' },
  briefing: { label: 'Briefing doc', icon: Newspaper, tint: '#2563eb', blurb: 'Key points for a decision-maker' },
  study_guide: { label: 'Study guide', icon: GraduationCap, tint: '#7c3aed', blurb: 'Concepts, quiz and glossary' },
  faq: { label: 'FAQ', icon: CircleQuestionMark, tint: '#db2777', blurb: 'Questions a newcomer would ask' },
  timeline: { label: 'Timeline', icon: ScrollText, tint: '#ea580c', blurb: 'Events and who’s who' },
  report: { label: 'Report', icon: BookOpen, tint: '#0891b2', blurb: 'A full write-up of the question' },
  mindmap: { label: 'Mind map', icon: Network, tint: '#16a34a', blurb: 'The ideas and how they connect' },
  flashcards: { label: 'Flashcards', icon: Layers, tint: '#ca8a04', blurb: 'Learn the key facts' },
  quiz: { label: 'Quiz', icon: ListChecks, tint: '#dc2626', blurb: 'Test what you know' },
};

/** "en.wikipedia.org" → "wikipedia": the part of a host people recognise. */
export function siteName(domain: string) {
  const parts = (domain || '').replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  const sld = parts[parts.length - 2];
  return parts.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(sld) ? parts[parts.length - 3] : sld;
}

function hue(s: string) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }

/** The icon for a source: its file type, YouTube, a web page, or pasted text. */
export function SourceIcon({ s, size = 16 }: { s: ResearchItem; size?: number }) {
  const ext = (s.meta.fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
  let Icon: LucideIcon = Globe;
  let color = `hsl(${hue(siteName(s.meta.domain ?? ''))} 65% 48%)`;
  if (s.meta.origin === 'text') { Icon = Type; color = '#64748b'; }
  else if (s.meta.origin === 'file') {
    color = '#64748b';
    if (ext === 'pdf') { Icon = FileType; color = '#dc2626'; }
    else if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) { Icon = FileSpreadsheet; color = '#16a34a'; }
    else if (['pptx', 'ppt', 'odp'].includes(ext)) { Icon = Presentation; color = '#ea580c'; }
    else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp'].includes(ext)) { Icon = ImageIcon; color = '#7c3aed'; }
    else { Icon = FileText; color = '#2563eb'; }
  } else if (/youtube\.com|youtu\.be/.test(s.url)) { Icon = Video; color = '#dc2626'; }
  return <Icon style={{ width: size, height: size, color }} className="shrink-0" aria-hidden />;
}

export function addedLabel(by: string, agents: Agent[]) {
  if (by === 'user') return 'you';
  if (by === 'auto') return 'read by Minerva';
  const id = by.replace(/^agent:/, '');
  return agents.find(a => a.id === id)?.name ?? id;
}

export function useConfirmDelete() {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 2500); return () => clearTimeout(t); }, [armed]);
  return [armed, setArmed] as const;
}

export function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Everything the notebook's panes share: the data, and the actions that cross panes. */
export interface NotebookApi {
  d: ResearchBoardDetail;
  agents: Agent[];
  sourceByRef: Map<number, ResearchItem>;
  reload: () => void;
  openSource: (id: string, highlight?: string) => void;
  ask: (text: string) => void;
  saveNote: (title: string, body: string) => Promise<void>;
}
export const NotebookCtx = createContext<NotebookApi | null>(null);
export const useNotebook = () => useContext(NotebookCtx)!;

function Hover({ card, children }: { card: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-baseline" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {children}
      {open && (
        <span className="absolute z-40 left-1/2 -translate-x-1/2 bottom-full mb-1.5 w-80 max-w-[80vw] p-3 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-primary)] shadow-2xl text-left not-prose pointer-events-none">
          {card}
        </span>
      )}
    </span>
  );
}

const chip = 'mx-[1px] px-1 min-w-[1.25rem] h-[1.1rem] inline-flex items-center justify-center rounded-full text-[10px] font-semibold leading-none align-[0.12em] transition';

/** [S3]: a source of the notebook, by its stable number. */
export function SourceCite({ n }: { n: number }) {
  const nb = useContext(NotebookCtx);
  const s = nb?.sourceByRef.get(n);
  return (
    <Hover card={s ? (
      <>
        <span className="flex items-center gap-2 mb-1"><SourceIcon s={s} size={14} /><span className="text-[11px] text-[var(--text-muted)] truncate">{s.meta.domain || s.meta.fileName || 'source'}</span></span>
        <span className="block text-[13px] font-medium leading-snug text-[var(--text-primary)]">{s.title || s.url}</span>
        {(s.meta.guide || s.body) && <span className="block mt-1 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-4">{(s.meta.guide || s.body).replace(/\*\*/g, '')}</span>}
      </>
    ) : <span className="text-[12px] text-rose-500">{tx('S{n} isn’t in this notebook.', { n: n })}</span>}>
      <button onClick={() => s && nb?.openSource(s.id)} aria-label={s ? tx('Source: {title}', { title: s.title }) : tx('Missing source {n}', { n: n })}
        className={clsx(chip, s ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 hover:bg-teal-500/30' : 'bg-rose-500/15 text-rose-500')}>
        {n}
      </button>
    </Hover>
  );
}

/** [2] in a chat answer: one passage of a source. Hover shows the passage; click opens the source at it. */
export function PassageCite({ n, c }: { n: string; c?: NotebookCitation }) {
  const nb = useContext(NotebookCtx);
  if (!c) return <span className={clsx(chip, 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')}>{n}</span>;
  const s = nb?.d.items.find(i => i.id === c.itemId);
  return (
    <Hover card={
      <>
        <span className="flex items-center gap-2 mb-1.5">{s && <SourceIcon s={s} size={14} />}<span className="text-[11px] font-medium text-[var(--text-secondary)] truncate">{tx(c.title)}</span></span>
        <span className="block text-[12px] leading-relaxed text-[var(--text-primary)] line-clamp-[9] whitespace-pre-line">{c.text.slice(0, 700)}</span>
      </>
    }>
      <button onClick={() => nb?.openSource(c.itemId, c.text)} aria-label={tx('Citation {n}: {title}', { n: n, title: c.title })}
        className={clsx(chip, 'bg-teal-500/15 text-teal-700 dark:text-teal-300 hover:bg-teal-500/30')}>{n}</button>
    </Hover>
  );
}

/** "[S1]", "[S1, S3]", "[S2–S4]" → source chips; with `passages`, "[2]" → passage chips. */
function linkCitations(text: string, passages: boolean) {
  let out = text.replace(/\[(S\d+(?:\s*[,;]\s*S?\d+|\s*[–-]\s*S?\d+)*)\]/g, (_m, body: string) => {
    const nums: number[] = [];
    for (const part of body.split(/\s*[,;]\s*/)) {
      const r = /S?(\d+)\s*[–-]\s*S?(\d+)/.exec(part);
      if (r) { for (let i = +r[1]; i <= +r[2] && i - +r[1] < 20; i++) nums.push(i); } else { const d = /\d+/.exec(part); if (d) nums.push(+d[0]); }
    }
    return nums.map(n => `[S${n}](cite:${n})`).join('');
  });
  if (passages) out = out.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_m, body: string) => body.split(/\s*,\s*/).map(n => `[${n}](pass:${n})`).join(''));
  return out;
}

// research text is full of prices ("$56/kWh … $100"), so only $$…$$ counts as math here
export const NbMarkdown = memo(function NbMarkdown({ text, className, citations }: {
  text: string; className?: string; citations?: Record<string, NotebookCitation>;
}) {
  return (
    <div className={clsx('prose-shellb', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]}
        urlTransform={url => (/^(cite|pass):/.test(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => href?.startsWith('cite:') ? <SourceCite n={Number(href.slice(5))} />
            : href?.startsWith('pass:') ? <PassageCite n={href.slice(5)} c={citations?.[href.slice(5)]} />
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}>
        {linkCitations(text, !!citations)}
      </ReactMarkdown>
    </div>
  );
});
