// ```profile``` fence: {"name": "Ada Lovelace", "role": "Mathematician", "org": "…", "image": "https://…", "bio": "…",
//  "tags": ["computing"], "facts": {"Born": "1815"}, "links": [{"label": "Wikipedia", "url": "https://…"}]}
import { useState } from 'react';
import { ExternalLink, UserRound } from 'lucide-react';
import { CardFrame, CardPending, linkProps, list, obj, parseJson, safeUrl, text } from './CardFrame';
import type { CardProps } from './registry';

function parse(source: string) {
  const r = parseJson(source);
  const name = r && text(r.name ?? r.title);
  if (!r || !name) return null;
  const facts = obj(r.facts)
    ? Object.entries(obj(r.facts)!).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, text(v)] as const)
    : list(r.facts).flatMap(f => (Array.isArray(f) && f.length >= 2 ? [[text(f[0]), text(f.slice(1))] as const] : []));
  const links = list(r.links).flatMap(l => {
    const o = obj(l), url = safeUrl(o?.url ?? o?.href);
    return o && url ? [{ label: text(o.label ?? o.name) || url, url }] : [];
  });
  return {
    name, role: [text(r.role ?? r.title_role), text(r.org ?? r.organization)].filter(Boolean).join(' · '),
    image: safeUrl(r.image), bio: text(r.bio ?? r.summary), tags: list(r.tags).map(text).filter(Boolean), facts, links,
  };
}

export function ProfileCard({ source, streaming }: CardProps) {
  const [imgOk, setImgOk] = useState(true);
  const d = parse(source);
  if (!d) return <CardPending icon={UserRound} streaming={streaming} waiting="Drawing up a profile…" broken="This profile couldn't be read." />;
  const initials = d.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join('');
  return (
    <CardFrame icon={UserRound} title="Profile">
      <div className="flex gap-3.5 p-3.5">
        {d.image && imgOk
          ? <img src={d.image} alt={d.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} className="w-20 h-20 shrink-0 rounded-lg object-cover" />
          : <div aria-hidden className="w-20 h-20 shrink-0 rounded-lg grid place-items-center text-xl font-semibold bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{initials}</div>}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-[var(--text-primary)] leading-snug">{d.name}</div>
          {d.role && <div className="text-[12px] text-[var(--text-muted)]">{d.role}</div>}
          {d.bio && <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{d.bio}</p>}
          {d.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {d.tags.map((t, i) => <span key={i} className="px-1.5 py-0.5 rounded text-[10.5px] bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">{t}</span>)}
            </div>
          )}
        </div>
      </div>
      {d.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-3.5 py-2.5 text-[12.5px] border-t border-[var(--border-subtle)]">
          {d.facts.map(([k, v], i) => (<><dt key={`k${i}`} className="font-medium text-[var(--text-secondary)]">{k}</dt><dd key={`v${i}`} className="text-[var(--text-primary)] break-words">{v}</dd></>))}
        </dl>
      )}
      {d.links.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-3.5 py-2 text-[12px] border-t border-[var(--border-subtle)]">
          {d.links.map((l, i) => <a key={i} href={l.url} {...linkProps(l.url)} className="inline-flex items-center gap-1 underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]">{l.label}<ExternalLink className="w-3 h-3" /></a>)}
        </div>
      )}
    </CardFrame>
  );
}
