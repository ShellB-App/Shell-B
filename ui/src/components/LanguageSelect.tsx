import { useEffect, useRef, useState, type FC } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { LOCALES, t, type LocalePref } from '../i18n';
import { LanguageFlag } from './LanguageFlag';

interface LanguageSelectProps {
  value: LocalePref;
  onChange: (value: LocalePref) => void;
  autoLabel?: string;
  className?: string;
}

export const LanguageSelect: FC<LanguageSelectProps> = ({
  value,
  onChange,
  autoLabel = t('Automatic'),
  className,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeLocale = LOCALES.find(l => l.id.toLowerCase() === (value || '').toLowerCase());

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const select = (code: LocalePref) => {
    onChange(code);
    setOpen(false);
  };

  const living = LOCALES.filter(l => l.category === 'living');
  const dead = LOCALES.filter(l => l.category === 'dead');
  const fictional = LOCALES.filter(l => l.category === 'fictional');

  return (
    <div ref={containerRef} className={clsx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent)]/50 focus:outline-none focus:border-[var(--accent)] transition"
      >
        <span className="flex items-center gap-2 truncate">
          {activeLocale ? (
            <>
              <LanguageFlag code={activeLocale.id} size="md" />
              <span className="font-medium truncate">{activeLocale.name}</span>
            </>
          ) : (
            <>
              <Globe className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="font-medium text-[var(--text-secondary)] truncate">{autoLabel}</span>
            </>
          )}
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-full min-w-[260px] max-h-[380px] overflow-y-auto z-50 p-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-2xl space-y-2 animate-slide-up">
          {/* Automatic option */}
          <button
            type="button"
            onClick={() => select('' as LocalePref)}
            className={clsx(
              'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition',
              !value
                ? 'bg-sky-500/15 text-sky-300 font-medium'
                : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            )}
          >
            <span className="flex items-center gap-2 truncate">
              <Globe className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="truncate">{autoLabel}</span>
            </span>
            {!value && <Check className="w-3.5 h-3.5 text-sky-400 shrink-0 ml-2" />}
          </button>

          {/* Living & Celtic */}
          <div className="space-y-0.5">
            <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t('Living & Celtic')}
            </div>
            {living.map(loc => {
              const selected = value === loc.id;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => select(loc.id)}
                  className={clsx(
                    'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition',
                    selected
                      ? 'bg-sky-500/15 text-sky-300 font-medium'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                  )}
                >
                  <span className="flex items-center gap-2 truncate">
                    <LanguageFlag code={loc.id} size="md" />
                    <span className="truncate">{loc.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono ml-0.5">({loc.id})</span>
                  </span>
                  {selected && <Check className="w-3.5 h-3.5 text-sky-400 shrink-0 ml-2" />}
                </button>
              );
            })}
          </div>

          {/* Classical & Dead */}
          <div className="space-y-0.5 pt-1 border-t border-[var(--border-subtle)]">
            <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1">
              <span>🏛️</span>
              <span>{t('Classical & Dead')}</span>
            </div>
            {dead.map(loc => {
              const selected = value === loc.id;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => select(loc.id)}
                  className={clsx(
                    'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition',
                    selected
                      ? 'bg-purple-500/15 text-purple-300 font-medium'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                  )}
                >
                  <span className="flex items-center gap-2 truncate">
                    <LanguageFlag code={loc.id} size="md" />
                    <span className="truncate">{loc.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono ml-0.5">({loc.id})</span>
                  </span>
                  {selected && <Check className="w-3.5 h-3.5 text-purple-400 shrink-0 ml-2" />}
                </button>
              );
            })}
          </div>

          {/* Fictional & Conlangs */}
          <div className="space-y-0.5 pt-1 border-t border-[var(--border-subtle)]">
            <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1">
              <span>⚔️</span>
              <span>{t('Fictional & Conlangs')}</span>
            </div>
            {fictional.map(loc => {
              const selected = value === loc.id;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => select(loc.id)}
                  className={clsx(
                    'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition',
                    selected
                      ? 'bg-pink-500/15 text-pink-300 font-medium'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                  )}
                >
                  <span className="flex items-center gap-2 truncate">
                    <LanguageFlag code={loc.id} size="md" />
                    <span className="truncate">{loc.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono ml-0.5">({loc.id})</span>
                  </span>
                  {selected && <Check className="w-3.5 h-3.5 text-pink-400 shrink-0 ml-2" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
