// ```steps``` fence: {"title": "Set up SSH keys", "steps": [{"title": "Generate a key", "detail": "…", "code": "ssh-keygen -t ed25519"}, "or a plain string"]}
// Ticks are remembered in this browser, per card content, so a half-finished checklist survives a reload.
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ListChecks, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { CardButton, CardFrame, CardPending, list, obj, parseJson, text } from './CardFrame';
import type { CardProps } from './registry';

interface Step { title: string; detail?: string; code?: string }

function parse(source: string) {
  const r = parseJson(source);
  if (!r) return null;
  const steps: Step[] = list(r.steps ?? r.items).flatMap((s): Step[] => {
    if (typeof s === 'string') return s.trim() ? [{ title: s.trim() }] : [];
    const o = obj(s), title = text(o?.title ?? o?.label ?? o?.step);
    return o && title ? [{ title, detail: text(o.detail ?? o.note ?? o.description) || undefined, code: text(o.code ?? o.command) || undefined }] : [];
  });
  return steps.length ? { title: text(r.title) || 'Steps', steps } : null;
}

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const load = (key: string): boolean[] => { try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(v) ? v.map(Boolean) : []; } catch { return []; } };

export function StepsCard({ source, streaming }: CardProps) {
  const d = useMemo(() => parse(source), [source]);
  const key = useMemo(() => `sb-steps:${hash(d ? d.title + d.steps.map(s => s.title).join('|') : '')}`, [d]);
  const [done, setDone] = useState<boolean[]>(() => load(key));
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => { setDone(load(key)); }, [key]);
  if (!d) return <CardPending icon={ListChecks} streaming={streaming} waiting="Listing the steps…" broken="This checklist couldn't be read." />;
  const set = (next: boolean[]) => { setDone(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode: ticks last for this view only */ } };
  const count = d.steps.filter((_, i) => done[i]).length;
  return (
    <CardFrame icon={ListChecks} title={d.title} meta={`${count} of ${d.steps.length} done`}
      actions={count > 0 && !streaming ? <CardButton onClick={() => set([])} title="Clear all ticks"><RotateCcw className="w-3 h-3" /> Reset</CardButton> : undefined}>
      <div className="h-0.5 bg-[var(--bg-secondary)]" role="progressbar" aria-valuemin={0} aria-valuemax={d.steps.length} aria-valuenow={count}>
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(count / d.steps.length) * 100}%` }} />
      </div>
      <ol className="divide-y divide-[var(--border-subtle)]">
        {d.steps.map((s, i) => (
          <li key={i} className="flex gap-3 px-3.5 py-2.5">
            <button role="checkbox" aria-checked={!!done[i]} aria-label={`Step ${i + 1}: ${s.title}`} onClick={() => set(d.steps.map((_, j) => (j === i ? !done[j] : !!done[j])))}
              className={clsx('mt-0.5 w-5 h-5 shrink-0 grid place-items-center rounded-md border text-[10px] font-semibold transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]',
                done[i] ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--text-muted)]')}>
              {done[i] ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </button>
            <div className="min-w-0 flex-1">
              <div className={clsx('text-[13px] font-medium', done[i] ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]')}>{s.title}</div>
              {s.detail && <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{s.detail}</div>}
              {s.code && (
                <div className="mt-1.5 flex items-start gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5">
                  <pre className="flex-1 min-w-0 overflow-x-auto text-[12px] font-mono">{s.code}</pre>
                  <button aria-label="Copy command" className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    onClick={() => { navigator.clipboard.writeText(s.code!); setCopied(i); setTimeout(() => setCopied(null), 1400); }}>
                    {copied === i ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </CardFrame>
  );
}
