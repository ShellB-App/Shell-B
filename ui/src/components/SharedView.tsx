import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Markdown } from './Markdown';

/** `#/s/<token>`: a read-only share (server/shares.py), outside the login wall (main.tsx renders it instead of the
 * app). It fetches the snapshot once and nothing else; HTML/SVG artifacts run in the same sandbox as the owner's view,
 * without the app-state shim (there is no session to store into). */
interface Snap {
  kind: 'chat' | 'artifact'; title: string; created: number; agent?: string;
  messages?: { id: string; role: string; content: string; timestamp?: number; agent?: string; attachments?: { name: string; kind: string }[] }[];
  artifacts?: { id: string; title: string; type: string; content: string; language?: string }[];
  artifact?: { id: string; type: string; content: string; language?: string; version: number };
}
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

function doc(type: string, content: string, dark: boolean): string {
  if (type === 'html') return /<html[\s>]/i.test(content) ? content : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`;
  if (type === 'svg') return `<!doctype html><html><head><style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:${dark ? '#141416' : '#fff'}}svg{max-width:96vw;max-height:96vh;width:auto;height:auto}</style></head><body>${content}</body></html>`;
  if (type === 'mermaid') return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:${dark ? '#191919' : '#faf8f5'}}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}.mermaid{width:100%}</style><script src="/vendor/mermaid.js"></script></head><body><pre class="mermaid">${esc(content)}</pre><script>mermaid.initialize({startOnLoad:true,theme:${dark ? "'dark'" : "'default'"},securityLevel:'strict'});</script></body></html>`;
  return '';
}

function Artifact({ a, dark }: { a: { title?: string; type: string; content: string; language?: string }; dark: boolean }) {
  if (a.type === 'markdown') return <div className="prose-shell max-w-[70ch]"><Markdown text={a.content} /></div>;
  if (a.type === 'code') return <pre className="overflow-auto p-4 rounded-xl text-[12.5px] leading-relaxed font-mono bg-[var(--bg-code)]">{a.content}</pre>;
  const d = doc(a.type, a.content, dark);
  if (!d) return <pre className="overflow-auto p-4 rounded-xl text-[12.5px] font-mono bg-[var(--bg-code)]">{a.content}</pre>;
  return <iframe title={a.title ?? 'Artifact'} srcDoc={d} sandbox={SANDBOX} className="w-full h-[70vh] rounded-xl border border-[var(--border-subtle)] bg-white" />;
}

export function SharedView({ token }: { token: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [error, setError] = useState('');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  useEffect(() => {
    fetch(`/api/share/${token}`).then(async r => {
      if (!r.ok) throw new Error(r.status === 404 ? "This link doesn't open anything: it may have expired or been taken back." : `Couldn't load (${r.status})`);
      return r.json() as Promise<Snap>;
    }).then(s => { setSnap(s); document.title = `${s.title} · shared from Shell:B`; }).catch(e => setError(e.message));
  }, [token]);
  if (error) return <Frame><p className="text-sm text-[var(--text-muted)] text-center py-16">{error}</p></Frame>;
  if (!snap) return <Frame><div className="py-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div></Frame>;
  return (
    <Frame>
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Shared from Shell:B · {new Date(snap.created * 1000).toLocaleDateString()} · read-only</div>
        <h1 className="text-2xl font-semibold tracking-tight leading-tight mt-1">{snap.title}</h1>
      </header>
      {snap.kind === 'artifact' && snap.artifact && <Artifact a={{ ...snap.artifact, title: snap.title }} dark={dark} />}
      {snap.kind === 'chat' && (
        <div className="space-y-5">
          {snap.messages?.map(m => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={m.role === 'user' ? 'max-w-[85%] rounded-2xl rounded-br-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] px-4 py-2.5 text-[14px] whitespace-pre-wrap' : 'max-w-[72ch]'}>
                {m.role !== 'user' && <div className="text-[11px] font-semibold text-[var(--text-muted)] mb-1">{m.agent || 'Shell:B'}</div>}
                {m.role === 'user' ? m.content : <Markdown text={m.content} />}
                {m.attachments && m.attachments.length > 0 && <div className="mt-1 text-[11px] text-[var(--text-muted)]">Attached: {m.attachments.map(a => a.name).join(', ')}</div>}
              </div>
            </div>
          ))}
          {snap.artifacts && snap.artifacts.length > 0 && (
            <section className="pt-4 border-t border-[var(--border-subtle)] space-y-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Artifacts</h2>
              {snap.artifacts.map(a => <div key={a.id}><h3 className="text-sm font-medium mb-2">{a.title}</h3><Artifact a={a} dark={dark} /></div>)}
            </section>
          )}
        </div>
      )}
      <footer className="mt-12 pt-4 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">A snapshot shared from someone's Shell:B, a private local AI workstation. Later changes to the original don't show here.</footer>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">{children}</div>
    </div>
  );
}
