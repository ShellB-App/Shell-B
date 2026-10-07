// Layers popover for the Worlds app, driven by the OVERLAYS table: only what the current world offers is listed.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Layers } from 'lucide-react';
import { OVERLAYS, type LayerPrefs, type OverlayId, type WorldCtx } from './overlays';

export function LayersPanel({ bodyId, bodyName, globe, ctx, prefs, onToggle, counts }: {
  bodyId: string; bodyName: string; globe: boolean; ctx: WorldCtx; prefs: LayerPrefs;
  onToggle: (id: OverlayId, on: boolean) => void;
  counts: Partial<Record<OverlayId, number | string>>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = OVERLAYS.filter(o => o.on(bodyId, globe, ctx));
  const active = list.filter(o => prefs[o.id]).length;

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div ref={ref} className="relative pointer-events-auto">
      <button
        className={clsx('h-9 px-3 flex items-center gap-2 rounded-xl border sb-map-glass text-[12px] font-medium transition',
          open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}
        onClick={() => setOpen(o => !o)} aria-expanded={open} title="Map layers"
      >
        <Layers className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Layers</span>
        {active > 0 && <span className="min-w-[18px] h-[18px] px-1 grid place-items-center rounded-full bg-[var(--accent)] text-white text-[10px] font-bold tabular-nums">{active}</span>}
        <ChevronDown className={clsx('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 w-72 max-w-[calc(100vw-1.5rem)] max-h-[min(70vh,560px)] overflow-y-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass shadow-2xl p-1.5 z-40">
          {list.length === 0 && <div className="px-3 py-4 text-[12px] text-[var(--text-muted)]">No layers for {bodyName}.</div>}
          {(['Live', 'Places', 'Reference'] as const).map(g => {
            const items = list.filter(o => o.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="py-1">
                <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{g}</div>
                {items.map(o => {
                  const on = prefs[o.id];
                  const Icon = o.icon;
                  const c = counts[o.id];
                  return (
                    <button key={o.id} role="switch" aria-checked={on} onClick={() => onToggle(o.id, !on)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-tertiary)] transition">
                      <span className="w-7 h-7 shrink-0 grid place-items-center rounded-lg" style={{ background: on ? `${o.color}26` : 'var(--bg-tertiary)' }}>
                        <Icon className="w-3.5 h-3.5" style={{ color: on ? o.color : 'var(--text-muted)' }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">
                          {o.label}{on && c != null && <span className="ml-1.5 text-[11px] font-normal tabular-nums text-[var(--text-muted)]">{c}</span>}
                        </span>
                        <span className="block text-[11px] text-[var(--text-muted)] truncate">{o.hint}</span>
                      </span>
                      <span className={clsx('w-8 h-[18px] shrink-0 rounded-full p-[2px] transition', on ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] ring-1 ring-inset ring-[var(--border-subtle)]')}>
                        <span className={clsx('block w-[14px] h-[14px] rounded-full bg-white shadow transition-transform', on && 'translate-x-[14px]')} />
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
