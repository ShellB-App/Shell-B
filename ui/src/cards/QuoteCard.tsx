// ```quote``` fence: {"text": "The passage", "source": "Apollo 11 Flight Journal", "author": "…", "date": "1969", "page": "12", "url": "#/wiki/Apollo_11"}
// Use it for verbatim passages from a document, page or the offline wiki so the reader can check the source.
import { ExternalLink, Quote } from 'lucide-react';
import { CardFrame, CardPending, linkProps, parseJson, safeUrl, text } from './CardFrame';
import type { CardProps } from './registry';

export function QuoteCard({ source, streaming }: CardProps) {
  const r = parseJson(source);
  const body = r ? text(r.text ?? r.quote) : '';
  if (!r || !body) return <CardPending icon={Quote} streaming={streaming} waiting="Pulling a quote…" broken="This quote couldn't be read." />;
  const src = text(r.source ?? r.title), url = safeUrl(r.url ?? r.href);
  const by = [text(r.author), src, text(r.date), text(r.page) && `p. ${text(r.page)}`].filter(Boolean);
  return (
    <CardFrame icon={Quote} title="Quote">
      <blockquote className="px-4 py-3 text-[14px] leading-relaxed italic text-[var(--text-primary)] whitespace-pre-wrap">“{body}”</blockquote>
      {by.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2.5 text-[12px] text-[var(--text-muted)]">
          <span className="truncate">— {by.join(' · ')}</span>
          {url && <a href={url} {...linkProps(url)} className="ml-auto shrink-0 inline-flex items-center gap-1 underline hover:text-[var(--text-primary)]">Open source<ExternalLink className="w-3 h-3" /></a>}
        </div>
      )}
    </CardFrame>
  );
}
