// ```diagram``` fence: Mermaid source (flowchart, sequence, class, state, ER, gantt, …), or {"title": "...", "mermaid": "graph TD; A-->B"}.
// Rendered in the page with securityLevel "strict" (labels sanitised, no click handlers). Mermaid loads on first use only.
import { useEffect, useId, useState } from 'react';
import { Copy, Network } from 'lucide-react';
import { useDarkTheme } from '../maps/MapCard';
import { CardButton, CardFrame, CardPending, parseJson, text } from './CardFrame';
import type { CardProps } from './registry';

export function DiagramCard({ source, streaming }: CardProps) {
  const dark = useDarkTheme();
  const id = 'sbd' + useId().replace(/\W/g, '');
  const json = source.trimStart().startsWith('{') ? parseJson(source) : null;
  const code = (json ? text(json.mermaid ?? json.code) : source).trim();
  const title = json ? text(json.title) : '';
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (streaming || !code) return;
    let stop = false;
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        const out = await mermaid.render(id, code);
        if (!stop) { setSvg(out.svg); setErr(false); }
      } catch { document.getElementById('d' + id)?.remove(); if (!stop) { setSvg(''); setErr(true); } }
    })();
    return () => { stop = true; };
  }, [code, dark, streaming, id]);
  if (streaming || (!svg && !err)) return <CardPending icon={Network} streaming waiting="Drawing the diagram…" broken="" />;
  if (err) return (
    <CardFrame icon={Network} title={title || 'Diagram'} meta="couldn't be drawn">
      <pre className="p-3.5 overflow-x-auto text-[12px] font-mono text-[var(--text-secondary)]">{code}</pre>
    </CardFrame>
  );
  return (
    <CardFrame icon={Network} title={title || 'Diagram'}
      actions={<CardButton onClick={() => navigator.clipboard.writeText(code)} title="Copy the Mermaid source"><Copy className="w-3 h-3" /> Source</CardButton>}>
      <div className="p-3 overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
    </CardFrame>
  );
}
