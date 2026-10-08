import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

/** Small, non-blocking notices: "Couldn't delete the note", "Moved to Trash · Undo". Call toast() from anywhere;
 *  <Toaster/> (mounted once in main.tsx) shows them bottom-centre and lets screen readers hear them. */
export type ToastKind = 'info' | 'success' | 'error';
interface Toast { id: number; text: string; kind: ToastKind; action?: { label: string; run: () => void } }

let items: Toast[] = [];
let seq = 0;
const listeners = new Set<(t: Toast[]) => void>();
const publish = () => listeners.forEach(f => f(items));

export function toast(text: string, opts: { kind?: ToastKind; action?: Toast['action']; ms?: number } = {}) {
  const t: Toast = { id: ++seq, text, kind: opts.kind ?? 'info', action: opts.action };
  items = [...items.slice(-3), t];
  publish();
  window.setTimeout(() => dismiss(t.id), opts.ms ?? (t.kind === 'error' ? 8000 : 4500));
  return t.id;
}

/** A failed request, said plainly: `.catch(toastError("Couldn't delete the note"))`. */
export const toastError = (what: string) => (e: unknown) => {
  const why = String(e).replace(/^Error: \d+: /, '');
  toast(`${what}${why ? `: ${why}` : ''}`, { kind: 'error' });
};

export function dismiss(id: number) {
  items = items.filter(t => t.id !== id);
  publish();
}

const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle };

export function Toaster() {
  const [list, setList] = useState<Toast[]>(items);
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList); }; }, []);
  return createPortal(
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none w-[min(92vw,28rem)]"
      role="status" aria-live="polite">
      {list.map(t => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} className={clsx('pointer-events-auto w-full flex items-start gap-2 px-3 py-2.5 rounded-xl border shadow-lg text-sm animate-slide-up',
            'bg-[var(--bg-secondary)] text-[var(--text-primary)]',
            t.kind === 'error' ? 'border-red-500/40' : t.kind === 'success' ? 'border-emerald-500/40' : 'border-[var(--border-strong)]')}>
            <Icon className={clsx('w-4 h-4 mt-0.5 shrink-0', t.kind === 'error' ? 'text-red-500' : t.kind === 'success' ? 'text-emerald-500' : 'text-[var(--text-muted)]')} aria-hidden />
            <span className="flex-1 min-w-0 break-words">{t.text}</span>
            {t.action && (
              <button className="shrink-0 text-xs font-semibold text-[var(--accent-soft)] hover:underline" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                {t.action.label}
              </button>
            )}
            <button className="shrink-0 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
