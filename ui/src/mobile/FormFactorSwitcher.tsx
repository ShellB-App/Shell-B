import { Monitor, Smartphone, Tv, Check, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { getFormFactor, setFormFactor, isFormFactorExplicit, type FormFactor } from '../formFactor';
import { Modal } from '../components/common';

interface Props {
  open: boolean;
  onClose: () => void;
}

const OPTIONS: {
  id: FormFactor;
  label: string;
  badge?: string;
  hint: string;
  icon: typeof Smartphone;
}[] = [
  {
    id: 'mobile',
    label: 'Mobile Interface',
    hint: 'Compact, thumb-friendly layout tailored for smartphones, handhelds, and portrait touchscreens.',
    icon: Smartphone,
  },
  {
    id: 'standard',
    label: 'Desktop Workspace',
    hint: 'Multi-column environment with left AppRail, collapsible conversation sidebar, and wide workspace panels.',
    icon: Monitor,
  },
  {
    id: 'kiosk',
    label: 'Kiosk / OS Environment',
    badge: 'Preview',
    hint: 'Full-screen OS desktop interface designed for ambient displays, interactive kiosks, and touch terminals.',
    icon: Tv,
  },
];

export function FormFactorSwitcher({ open, onClose }: Props) {
  const current = getFormFactor();
  const explicit = isFormFactorExplicit();

  return (
    <Modal open={open} onClose={onClose} title="Display Form Factor" icon={<Monitor className="w-4 h-4 text-[var(--accent)]" />}>
      <div className="p-4 sm:p-6 space-y-4">
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          Shell:B supports multiple tailored front-end form factors sharing the exact same agent core, local intelligence, and style. Choose your active presentation mode:
        </p>

        <div className="space-y-2.5">
          {OPTIONS.map(opt => {
            const Icon = opt.icon;
            const active = current === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => {
                  setFormFactor(opt.id);
                  onClose();
                }}
                className={clsx(
                  'w-full flex items-start gap-3.5 p-3.5 rounded-xl border text-left transition',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/40'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                <div
                  className={clsx(
                    'p-2.5 rounded-lg shrink-0 mt-0.5',
                    active ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                  )}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{opt.label}</span>
                    {opt.badge && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-500 border border-amber-500/30">
                        {opt.badge}
                      </span>
                    )}
                    {active && <Check className="w-4 h-4 text-[var(--accent)] ml-auto" />}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 leading-normal">{opt.hint}</p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between">
          <div className="text-[11px] text-[var(--text-muted)]">
            {explicit ? 'Pinned preference stored in browser' : 'Auto-detecting based on screen viewport'}
          </div>
          <button
            onClick={() => {
              setFormFactor('auto');
              onClose();
            }}
            className="px-2.5 py-1 text-xs rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
          >
            Reset to Auto-detect
          </button>
        </div>
      </div>
    </Modal>
  );
}
