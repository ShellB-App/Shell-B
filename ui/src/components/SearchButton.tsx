import { t } from '../i18n';
import { Search } from 'lucide-react';

/** The header's "Search · Ctrl K" button, for pages that live outside the chat shell (Studio, Code). It asks the shell
 *  to open the command palette with the `shellb:palette` window event, so those pages need no extra props. */
export function SearchButton() {
  const open = () => window.dispatchEvent(new Event('shellb:palette'));
  return (
    <>
      <button onClick={open} className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
        <Search className="w-3.5 h-3.5" aria-hidden /><span>{t('Search')}</span>
        <kbd className="text-[9px] font-mono px-1 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">Ctrl K</kbd>
      </button>
      <button onClick={open} className="sm:hidden p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]" aria-label="Search">
        <Search className="w-4 h-4" />
      </button>
    </>
  );
}
