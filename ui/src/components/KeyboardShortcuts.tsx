import { Keyboard } from 'lucide-react';
import { APPS, useRailOrder, shortcutLabel } from './apps';

/** Every key the app binds (App.tsx and AppRail.tsx), in one place, so Settings → Shortcuts can list them. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: `${MOD} K`, what: 'Command palette: search everything, open any app or setting' },
  { keys: `${MOD} Shift O`, what: 'New chat' },
  { keys: `${MOD} B`, what: 'Show or hide the sidebar' },
  { keys: `${MOD} Shift Y`, what: 'Overlay: a small Shell:B window that stays on top (Chromium only)' },
  { keys: '?', what: 'This list' },
  { keys: 'Esc', what: 'Close the side panel or dialog' },
  { keys: 'Shift Tab', what: 'In the message box: toggle Plan mode' },
  { keys: 'Tab', what: 'In the message box: accept the suggested reply, or jump between {{blanks}} in a prompt template' },
  { keys: '/', what: 'At the start of the message box: commands, tools, skills and prompt templates' },
  { keys: '@', what: 'In the message box: answer this one message as another agent' },
  { keys: '#', what: 'In the message box: variables and references (artifacts, library items, URLs)' },
  { keys: 'Enter / Shift Enter', what: 'Send / new line' },
];

export function KeyboardShortcutsSection() {
  const rail = useRailOrder();
  const tiles = rail.slice(0, 9).map((id, i) => ({ keys: shortcutLabel(i), what: `Open ${APPS.find(a => a.id === id)?.label ?? id}` }));
  const Key = ({ k }: { k: string }) => (
    <kbd className="px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[11px] font-mono text-[var(--text-secondary)] whitespace-nowrap">{k}</kbd>
  );
  return (
    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2"><Keyboard className="w-3.5 h-3.5" />Keyboard</h3>
      <div className="rounded-lg border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
        {[...SHORTCUTS, ...tiles].map(s => (
          <div key={s.keys + s.what} className="flex items-start gap-3 px-3 py-2 text-sm">
            <span className="w-36 shrink-0 pt-px"><Key k={s.keys} /></span>
            <span className="text-[var(--text-secondary)] leading-snug">{s.what}</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-2 max-w-[65ch]">The number keys follow the order of the tiles in the app rail; drag tiles to change it.</p>
    </section>
  );
}
