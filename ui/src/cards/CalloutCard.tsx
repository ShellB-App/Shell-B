// ```callout``` fence: {"type": "note|tip|warning|danger|success", "title": "Heads up", "body": "Plain text. Blank lines split paragraphs."}
// The type is spelled out in the label, so colour is never the only signal.
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Lightbulb, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { parseJson, text } from './CardFrame';
import type { CardProps } from './registry';
import { CardPending } from './CardFrame';

const KINDS: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  note: { label: 'Note', icon: Info, tone: 'border-sky-500/60 text-sky-400' },
  tip: { label: 'Tip', icon: Lightbulb, tone: 'border-violet-500/60 text-violet-400' },
  success: { label: 'Success', icon: CheckCircle2, tone: 'border-emerald-500/60 text-emerald-400' },
  warning: { label: 'Warning', icon: AlertTriangle, tone: 'border-amber-500/60 text-amber-400' },
  danger: { label: 'Danger', icon: AlertOctagon, tone: 'border-red-500/60 text-red-400' },
};
const ALIAS: Record<string, string> = { info: 'note', important: 'warning', caution: 'warning', warn: 'warning', error: 'danger', ok: 'success' };

export function CalloutCard({ source, streaming }: CardProps) {
  const r = parseJson(source);
  const body = r ? text(r.body ?? r.text ?? r.message) : '';
  if (!r || !body) return <CardPending icon={Info} streaming={streaming} waiting="Writing a note…" broken="This callout couldn't be read." />;
  const t = text(r.type ?? r.kind).toLowerCase();
  const k = KINDS[ALIAS[t] ?? t] ?? KINDS.note;
  const Icon = k.icon;
  return (
    <aside role={k === KINDS.danger || k === KINDS.warning ? 'alert' : 'note'} className={clsx('not-prose my-3 rounded-xl border-l-4 border border-[var(--border-subtle)] bg-[var(--bg-code)] px-3.5 py-2.5', k.tone.split(' ')[0])}>
      <div className={clsx('flex items-center gap-1.5 text-[12px] font-semibold', k.tone.split(' ')[1])}>
        <Icon className="w-4 h-4 shrink-0" />{text(r.title) || k.label}{text(r.title) && <span className="font-normal uppercase tracking-wider text-[10px] opacity-80">· {k.label}</span>}
      </div>
      <div className="mt-1 space-y-1.5 text-[13px] leading-relaxed text-[var(--text-primary)]">
        {body.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
      </div>
    </aside>
  );
}
