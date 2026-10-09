import { createContext, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { hasCard, LiveCard } from '../cards/registry';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Loader2, Play, X } from 'lucide-react';
import clsx from 'clsx';
import { RichLink, rewriteLinks } from './RichLinks';
import { linkRoute, remarkShellbLinks } from '../links';

/** Models write math in several dialects; remark-math wants $…$ inline and $$ on their own lines for display.
 *  Rich links (tip:, artifact:, …) are made parser-safe here too, since both must skip code. */
export function normalizeMath(src: string): string {
  return src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => {
    if (i % 2 === 1) return part; // code: leave untouched
    return rewriteLinks(part)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body.trim()}$`)
      .replace(/^([ \t]*)\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, indent, body) => `${indent}$$\n${indent}${body.trim()}\n${indent}$$`);
  }).map((part, i) => (i % 2 === 1 ? part : escapeCurrency(part))).join('');
}

/** Escapes dollar signs that aren't math, so "$50 bill, total=$57.50" stays prose. Pandoc's rule: `$` opens inline math
 *  only when a non-space follows it and the next `$` on the line closes it (non-space before, no digit after).
 *  `$$` pairs and display blocks are left alone. */
export function escapeCurrency(text: string): string {
  let display = false;
  return text.split('\n').map(line => {
    if (/^\s*\$\$\s*$/.test(line)) { display = !display; return line; }
    if (display || !line.includes('$')) return line;
    let out = '';
    for (let i = 0; i < line.length;) {
      const ch = line[i];
      if (ch === '\\') { out += line.slice(i, i + 2); i += 2; continue; }
      if (ch !== '$') { out += ch; i++; continue; }
      if (line[i + 1] === '$') { // inline $$…$$
        const end = line.indexOf('$$', i + 2);
        const stop = end < 0 ? line.length : end + 2;
        out += line.slice(i, stop); i = stop; continue;
      }
      let j = i + 1;
      while (j < line.length && line[j] !== '$') j += line[j] === '\\' ? 2 : 1;
      const opens = /\S/.test(line[i + 1] ?? '');
      const closes = j < line.length && line[j + 1] !== '$' && /\S/.test(line[j - 1]) && !/\d/.test(line[j + 1] ?? '');
      if (opens && closes) { out += line.slice(i, j + 1); i = j + 1; continue; }
      out += '\\$'; i++;
    }
    return out;
  }).join('\n');
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/** Code workspaces provide this so chat code blocks get a Run button (the snippet runs in the workspace sandbox). */
export const RunCodeContext = createContext<((command: string) => Promise<{ output: string; error: boolean }>) | null>(null);

const SNIPPET: Record<string, [string, string]> = {
  python: ['py', 'python'], py: ['py', 'python'], python3: ['py', 'python'],
  bash: ['sh', 'bash'], sh: ['sh', 'bash'], shell: ['sh', 'bash'], zsh: ['sh', 'bash'],
  javascript: ['js', 'node'], js: ['js', 'node'], node: ['js', 'node'], typescript: ['ts', 'tsx'], ts: ['ts', 'tsx'],
};

/** Writes the snippet to /tmp in the sandbox and runs it there; the workspace is the working directory. */
function snippetCommand(lang: string, code: string) {
  const [ext, tool] = SNIPPET[lang.toLowerCase()] ?? [];
  if (!tool) return null;
  const eof = `SHELLB_SNIPPET_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  return `# Run a ${lang} snippet from chat\ncat > /tmp/snippet.${ext} <<'${eof}'\n${code}\n${eof}\n${tool} /tmp/snippet.${ext}`;
}

function CodeBlock({ children, lang }: { children: ReactNode; lang: string }) {
  const [copied, setCopied] = useState(false);
  const runner = useContext(RunCodeContext);
  const [result, setResult] = useState<{ output: string; error: boolean } | 'running' | null>(null);
  const runnable = !!runner && !!SNIPPET[lang.toLowerCase()];
  const run = async () => {
    const command = runner && snippetCommand(lang, textOf(children).replace(/\n$/, ''));
    if (!command) return;
    setResult('running');
    try { setResult(await runner(command)); } catch (e) { setResult({ output: String(e), error: true }); }
  };
  return (
    <div className="not-prose my-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        <span className="font-mono uppercase tracking-wide text-[10px]">{lang || 'text'}</span>
        <div className="flex-1" />
        {runnable && (
          <button className="flex items-center gap-1 mr-3 hover:text-[var(--text-primary)] transition disabled:opacity-50" disabled={result === 'running'}
            onClick={run} title="Run this snippet in the workspace sandbox (no network, 180 s limit)">
            {result === 'running' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run
          </button>
        )}
        <button
          className="flex items-center gap-1 hover:text-[var(--text-primary)] transition"
          onClick={() => { navigator.clipboard.writeText(textOf(children).replace(/\n$/, '')); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
        >
          {copied ? <><Check className="w-3 h-3 text-emerald-400" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[12.5px] leading-relaxed font-mono"><code className="hljs">{children}</code></pre>
      {result && result !== 'running' && (
        <div className="border-t border-[var(--border-subtle)]">
          <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            <span>Output</span>
            <button className="hover:text-[var(--text-primary)]" onClick={() => setResult(null)} aria-label="Clear output"><X className="w-3 h-3" /></button>
          </div>
          <pre className={clsx('px-3.5 pb-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[12px] font-mono', result.error ? 'text-red-300' : 'text-[var(--text-secondary)]')}>{result.output}</pre>
        </div>
      )}
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={clsx('prose-shellb', streaming && 'caret-last', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkShellbLinks]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={url => (url.startsWith('sb:') ? url : linkRoute(url) ?? defaultUrlTransform(url))}
        components={{
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const cls = (child as { props?: { className?: string } })?.props?.className ?? '';
            const lang = /language-([\w+-]+)/.exec(cls)?.[1] ?? '';
            if (hasCard(lang)) return <LiveCard lang={lang} source={textOf((child as { props?: { children?: ReactNode } })?.props?.children)} streaming={streaming} />;
            return <CodeBlock lang={lang}>{(child as { props?: { children?: ReactNode } })?.props?.children ?? children}</CodeBlock>;
          },
          a: ({ href, children }) => (href?.startsWith('sb:')
            ? <RichLink href={href}>{children}</RichLink>
            : href?.startsWith('#/') ? <a href={href}>{children}</a>  // in-app routes (#/wiki/…) stay in this tab
            : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>),
          // models trained on other UIs invent paths like sandbox:/mnt/data/x.png — only render images that can load
          img: ({ src, alt }) => (typeof src === 'string' && /^(https?:\/\/|\/api\/)/.test(src) ? <img src={src} alt={alt ?? ''} loading="lazy" /> : null),
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
