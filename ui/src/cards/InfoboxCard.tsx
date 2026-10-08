// ```infobox``` fence, Wikipedia-style fact card:
// {"title": "Voyager 1", "subtitle": "Space probe", "image": "https://…", "caption": "Artist's concept",
//  "rows": {"Launched": "1977-09-05", "Operator": "NASA / JPL"},
//  "sections": [{"heading": "Mission", "rows": [["Status", "Active"], {"label": "Site", "value": "nasa.gov", "url": "https://nasa.gov"}]}]}
// Rows may be an object, [label, value] pairs or {label, value, url} entries. Floats right on wide screens, like the original.
import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { CardFrame, CardPending, parseJson, safeUrl, text } from './CardFrame';
import type { CardProps } from './registry';

interface Row { label: string; value: string; url?: string }
interface Section { heading?: string; rows: Row[] }

function rowsOf(v: unknown): Row[] {
  if (Array.isArray(v)) {
    return v.flatMap((r): Row[] => {
      if (Array.isArray(r) && r.length >= 2) return [{ label: text(r[0]), value: text(r.slice(1)) }];
      if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        const label = text(o.label ?? o.key ?? o.name), value = text(o.value ?? o.val);
        return label && value ? [{ label, value, url: safeUrl(o.url ?? o.href) }] : [];
      }
      return [];
    });
  }
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).filter(([, x]) => x != null && x !== '').map(([label, x]) => ({ label, value: text(x) }));
  return [];
}

function parse(source: string) {
  const r = parseJson(source);
  if (!r) return null;
  const title = text(r.title ?? r.name);
  const sections: Section[] = [];
  const top = rowsOf(r.rows ?? r.fields ?? r.facts);
  if (top.length) sections.push({ rows: top });
  if (Array.isArray(r.sections)) {
    for (const s of r.sections) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const rows = rowsOf(o.rows ?? o.fields ?? o.facts);
      if (rows.length) sections.push({ heading: text(o.heading ?? o.title) || undefined, rows });
    }
  }
  if (!title && !sections.length) return null;
  return { title, subtitle: text(r.subtitle) || undefined, image: safeUrl(r.image), caption: text(r.caption) || undefined, source: text(r.source) || undefined, sections };
}

export function InfoboxCard({ source, streaming }: CardProps) {
  const [imgOk, setImgOk] = useState(true);
  const d = parse(source);
  if (!d) return <CardPending icon={BookOpen} streaming={streaming} waiting="Building infobox…" broken="This infobox couldn't be read." />;
  return (
    <CardFrame icon={BookOpen} title="Infobox" className="sb-infobox sm:float-right sm:clear-right sm:ml-4 sm:w-72 max-w-full sm:max-w-[45%]">
      <div className="px-3 pt-2.5 pb-2 text-center bg-[var(--bg-secondary)]">
        {d.title && <div className="text-[14px] font-semibold text-[var(--text-primary)] leading-snug">{d.title}</div>}
        {d.subtitle && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{d.subtitle}</div>}
      </div>
      {d.image && imgOk && (
        <figure className="px-3 pt-2 text-center">
          <img src={d.image} alt={d.caption ?? d.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)}
            className="mx-auto max-h-56 rounded object-contain" />
          {d.caption && <figcaption className="mt-1 text-[11px] text-[var(--text-muted)]">{d.caption}</figcaption>}
        </figure>
      )}
      {d.sections.map((s, i) => (
        <div key={i} className="mt-2">
          {s.heading && <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-center text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-y border-[var(--border-subtle)]">{s.heading}</div>}
          <dl>
            {s.rows.map((r, j) => (
              <div key={j} className="flex gap-3 px-3 py-1 text-[12.5px] border-t first:border-t-0 border-[var(--border-subtle)]">
                <dt className="w-[38%] shrink-0 font-medium text-[var(--text-secondary)]">{r.label}</dt>
                <dd className="min-w-0 break-words text-[var(--text-primary)]">
                  {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener" className="underline">{r.value}</a> : r.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {d.source && <div className="px-3 py-1.5 mt-1 text-[10.5px] text-[var(--text-muted)] border-t border-[var(--border-subtle)]">Source: {d.source}</div>}
    </CardFrame>
  );
}
