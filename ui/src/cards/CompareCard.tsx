// ```compare``` fence: {"title": "Laptops", "items": [{"name": "A", "subtitle": "$999", "image": "https://…"}],
//  "rows": [{"label": "Battery", "values": ["12 h", "9 h"], "best": 0}], "verdict": "A for travel."}
// "best" is the index of the winning column (or an array of indexes for ties). Winners carry a check mark, not just colour.
import { Check, Scale } from 'lucide-react';
import { CardFrame, CardPending, list, obj, parseJson, safeUrl, text } from './CardFrame';
import type { CardProps } from './registry';

function parse(source: string) {
  const r = parseJson(source);
  if (!r) return null;
  const items = list(r.items ?? r.options).flatMap(i => {
    const o = obj(i);
    if (o) return [{ name: text(o.name ?? o.title), subtitle: text(o.subtitle) || undefined, image: safeUrl(o.image) }];
    return typeof i === 'string' ? [{ name: i, subtitle: undefined, image: undefined }] : [];
  }).filter(i => i.name);
  const rows = list(r.rows ?? r.criteria).flatMap(x => {
    const o = obj(x);
    if (!o) return [];
    const best = (Array.isArray(o.best) ? o.best : o.best == null ? [] : [o.best]).map(Number).filter(Number.isInteger);
    return [{ label: text(o.label ?? o.name), values: list(o.values).map(text), best }];
  }).filter(x => x.label);
  if (items.length < 2 || !rows.length) return null;
  return { title: text(r.title) || 'Comparison', items, rows, verdict: text(r.verdict ?? r.summary) || undefined };
}

export function CompareCard({ source, streaming }: CardProps) {
  const d = parse(source);
  if (!d) return <CardPending icon={Scale} streaming={streaming} waiting="Weighing the options…" broken="This comparison couldn't be read." />;
  const wins = d.items.map((_, c) => d.rows.filter(r => r.best.includes(c)).length);
  const top = Math.max(...wins);
  return (
    <CardFrame icon={Scale} title={d.title} meta={`${d.items.length} options · ${d.rows.length} criteria`}>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="bg-[var(--bg-secondary)]">
              <th className="w-[22%] min-w-24" />
              {d.items.map((it, c) => (
                <th key={c} scope="col" className="px-3 py-2 text-left align-bottom font-semibold text-[var(--text-primary)] min-w-28">
                  {it.image && <img src={it.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-12 mb-1.5 rounded object-contain" onError={e => { e.currentTarget.style.display = 'none'; }} />}
                  <div>{it.name}</div>
                  {it.subtitle && <div className="text-[11px] font-normal text-[var(--text-muted)]">{it.subtitle}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i} className="border-t border-[var(--border-subtle)]">
                <th scope="row" className="px-3 py-1.5 text-left font-medium text-[var(--text-secondary)]">{r.label}</th>
                {d.items.map((_, c) => {
                  const win = r.best.includes(c);
                  return (
                    <td key={c} className={win ? 'px-3 py-1.5 font-semibold text-emerald-400' : 'px-3 py-1.5 text-[var(--text-primary)]'}>
                      {win && <Check className="inline w-3.5 h-3.5 mr-1 -mt-0.5" aria-label="best" />}{r.values[c] ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {top > 0 && (
              <tr className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-muted)]">
                <th scope="row" className="px-3 py-1.5 text-left font-medium">Criteria won</th>
                {wins.map((w, c) => <td key={c} className={w === top ? 'px-3 py-1.5 font-semibold text-[var(--text-primary)]' : 'px-3 py-1.5'}>{w} of {d.rows.length}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {d.verdict && <div className="px-3 py-2 text-[12.5px] border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">{d.verdict}</div>}
    </CardFrame>
  );
}
