import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, SquareTerminal, Trash2, Wand2, X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';

type Entry = { id: number; command: string; output?: string; error?: boolean; running: boolean };

/** The Code workspace terminal: each command runs in a fresh, network-less sandbox with the repo at /work. */
export function Terminal({ projectId, busy, pending, onClose, onRan, onAsk }: {
  projectId: string; busy: boolean; pending?: { command: string; n: number }; onClose: () => void; onRan: () => void; onAsk: (text: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cmd, setCmd] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = entries.some(e => e.running);
  const past = entries.map(e => e.command);
  const handled = useRef(0);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [entries]);

  // the editor's Run button: run its command once the terminal is free
  useEffect(() => {
    if (pending && pending.n !== handled.current && !running) { handled.current = pending.n; run(pending.command); }
  }, [pending, running]);

  const run = async (typed = cmd) => {
    const command = typed.trim();
    if (!command || running) return;
    if (command === 'clear') { setEntries([]); setCmd(''); return; }
    const id = Date.now();
    setEntries(es => [...es, { id, command, running: true }]);
    if (typed === cmd) { setCmd(''); setCursor(null); }
    try {
      const r = await api.exec(projectId, command);
      setEntries(es => es.map(e => (e.id === id ? { ...e, output: r.output, error: r.error, running: false } : e)));
      onRan();
    } catch (err) {
      setEntries(es => es.map(e => (e.id === id ? { ...e, output: String(err), error: true, running: false } : e)));
    }
    input.current?.focus();
  };

  return (
    <div className="h-64 shrink-0 flex flex-col border-t border-[var(--border-subtle)] bg-[var(--bg-code)]">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2.5 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        <SquareTerminal className="w-3.5 h-3.5" />
        <span className="font-medium text-[var(--text-secondary)]">{t('Terminal')}</span>
        <span className="hidden sm:inline">{t('bash in the sandbox · repo at /work · no network · 180 s limit')}</span>
        <div className="flex-1" />
        <button className="p-1 rounded hover:text-[var(--text-primary)]" title={t('Clear')} onClick={() => setEntries([])}><Trash2 className="w-3.5 h-3.5" /></button>
        <button className="p-1 rounded hover:text-[var(--text-primary)]" title={t('Close terminal')} onClick={onClose}><X className="w-3.5 h-3.5" /></button>
      </div>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed" onClick={() => input.current?.focus()}>
        {entries.length === 0 && (
          <div className="text-[var(--text-muted)]">{t('Try')} <span className="text-[var(--text-secondary)]">{t('pytest -q')}</span>, <span className="text-[var(--text-secondary)]">{t('npm test')}</span>, <span className="text-[var(--text-secondary)]">make</span> or <span className="text-[var(--text-secondary)]">{t('git log --oneline')}</span>. Files you change are committed as a version.</div>
        )}
        {entries.map(e => (
          <div key={e.id} className="mb-2">
            <div className="text-[var(--accent-soft)]"><span className="text-[var(--text-muted)] select-none">$ </span>{e.command}</div>
            {e.running ? (
              <div className="text-[var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />running…</div>
            ) : (
              <>
                <pre className={clsx('whitespace-pre-wrap break-words', e.error ? 'text-red-300' : 'text-[var(--text-secondary)]')}>{e.output}</pre>
                {e.error && (
                  <button disabled={busy} className="mt-1 flex items-center gap-1 text-[10.5px] font-sans text-[var(--accent-soft)] hover:underline disabled:opacity-40"
                    onClick={() => onAsk(`I ran \`${e.command}\` in the terminal and it failed:\n\n\`\`\`\n${(e.output ?? '').slice(-6000)}\n\`\`\`\n\nFind the root cause and fix it, then run it again to confirm.`)}>
                    <Wand2 className="w-3 h-3" />{t('Ask to fix')}
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--text-muted)] select-none">$</span>
          <input ref={input} value={cmd} onChange={e => setCmd(e.target.value)} disabled={running} autoFocus spellCheck={false}
            aria-label={t('Command')}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); run(); }
              if (e.key === 'ArrowUp' && past.length) {
                e.preventDefault();
                const i = cursor === null ? past.length - 1 : Math.max(0, cursor - 1);
                setCursor(i); setCmd(past[i]);
              }
              if (e.key === 'ArrowDown' && cursor !== null) {
                e.preventDefault();
                const i = cursor + 1;
                if (i >= past.length) { setCursor(null); setCmd(''); } else { setCursor(i); setCmd(past[i]); }
              }
              if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); setEntries([]); }
            }}
            className="flex-1 min-w-0 bg-transparent focus:outline-none text-[var(--text-primary)] disabled:opacity-50" />
        </div>
      </div>
    </div>
  );
}
