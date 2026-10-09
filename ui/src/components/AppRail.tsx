import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import { LayoutGrid, Pin, PinOff, Search, Settings } from 'lucide-react';
import type { Status } from '../types';
import { APPS, DEFAULT_PINS, DOCKED, GROUP_LABEL, PINNABLE, setPins, setRailOrder, shortcutLabel, togglePin, usePins, type AppDef, type AppGroup, type AppId, type AppLive } from './apps';
import { djLive } from '../dj/live';

interface Props {
  active: AppId;
  status?: Status;
  onOpen: (app: AppId) => void;
}

const ICON = 'w-[18px] h-[18px]';
// Rail geometry for the overflow maths, matching the classes below: tiles are h-10 with gap-2, dividers h-px my-0.5, nav py-3.
const ROW = 48;                                       // one pinned tile plus its gap
const BASE = 24 + 40 + 5 + 40 + 0 + 40 + 5 + 40 + 6 * 8;   // padding, Chat, divider, All apps, spacer, Activity, divider, gear, and the gaps between them
const VISIT = 1 + 40 + 2 * 8;                         // the short divider and tile for an app on screen that has no pinned tile

const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="text-[10px] font-mono text-[var(--text-muted)] px-1 py-px rounded border border-[var(--border-subtle)] whitespace-nowrap">{children}</kbd>
);

function Badges({ live }: { live?: AppLive }) {
  const badge = live?.badge ?? 0;
  return (
    <>
      {badge > 0 && <span className={clsx('absolute -top-2 -right-2.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold leading-4 text-center text-white border-2 border-[var(--bg-tertiary)] box-content',
        live?.urgent ? 'bg-amber-500' : 'bg-[var(--accent)]')}>{badge > 99 ? '99+' : badge}</span>}
      {live?.dot && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 border border-[var(--bg-tertiary)]" />}
      {live?.busy && <span className="absolute -bottom-1 -right-1.5 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-tertiary)] box-content animate-pulse" style={{ background: 'var(--tint)' }} />}
    </>
  );
}

/** An app icon. `quiet` keeps it grey until its tile is hovered or current, which is how the rail shows it. */
function AppIcon({ app, live, quiet, on }: { app: AppDef; live?: AppLive; quiet?: boolean; on?: boolean }) {
  const Icon = app.icon;
  return (
    <span className="relative flex" style={{ '--tint': app.tint } as CSSProperties}>
      <Icon className={clsx(ICON, 'transition-colors duration-150', !quiet || on || live?.busy ? 'text-[var(--tint)]' : 'text-[var(--text-muted)] group-hover:text-[var(--tint)]')} />
      <Badges live={live} />
    </span>
  );
}

type Anchor = { left: number; top?: number; bottom?: number; maxHeight: number };

/** Where a popup goes next to a rail tile: `top` lines up with the tile, sliding up as far as needed to give it `want` px;
 *  `bottom` grows upward from the tile's bottom edge. */
function anchorFor(el: HTMLElement, align: 'top' | 'bottom', want = 0): Anchor {
  const r = el.getBoundingClientRect();
  const left = r.right + 8;
  if (align === 'top') {
    const top = Math.max(8, Math.min(r.top, innerHeight - want - 8));
    return { left, top, maxHeight: innerHeight - top - 8 };
  }
  const bottom = Math.max(8, innerHeight - r.bottom);
  return { left, bottom, maxHeight: innerHeight - bottom - 8 };
}

/** A floating panel beside the rail. Fixed so it escapes the rail's overflow clipping on narrow screens; closes on outside
 *  click, Esc or resize; up/down arrows move between its `[data-nav]` elements. */
function Popover({ anchor, owner, label, className, onClose, children }: {
  anchor: Anchor; owner: HTMLElement | null; label: string; className?: string; onClose: (refocus: boolean) => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The rail re-renders on every status poll; reading these through a ref keeps the listeners (and focus) from resetting each time.
  const props = useRef({ owner, onClose });
  props.current = { owner, onClose };
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !props.current.owner?.contains(e.target as Node)) props.current.onClose(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); props.current.onClose(true); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };
    const resize = () => props.current.onClose(false);
    addEventListener('mousedown', down);
    addEventListener('keydown', key);
    addEventListener('resize', resize);
    ref.current?.querySelector<HTMLElement>('[data-nav]')?.focus();
    return () => { removeEventListener('mousedown', down); removeEventListener('keydown', key); removeEventListener('resize', resize); };
  }, []);
  return (
    <div ref={ref} role="dialog" aria-label={label} style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, maxHeight: anchor.maxHeight }}
      className={clsx('fixed z-[70] flex flex-col rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-strong)] shadow-2xl animate-slide-up', className)}>
      {children}
    </div>
  );
}

function AppRow({ app, live, current, pinned, note, onOpen, onPin }: {
  app: AppDef; live?: AppLive; current: boolean; pinned?: boolean; note?: ReactNode; onOpen: () => void; onPin?: () => void;
}) {
  return (
    <div className={clsx('group/row flex items-center rounded-lg hover:bg-[var(--bg-hover)] focus-within:bg-[var(--bg-hover)]', current && 'bg-[var(--bg-hover)]')}>
      <button data-nav onClick={onOpen} aria-current={current ? 'page' : undefined}
        className="flex-1 min-w-0 flex items-start gap-2.5 px-2.5 py-2 text-left focus:outline-none">
        <span className="mt-0.5 shrink-0"><AppIcon app={app} live={live} /></span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--text-primary)]">{live?.label ?? app.label}</span>
          <span className="block text-[11px] text-[var(--text-secondary)] leading-snug">{app.hint}</span>
        </span>
      </button>
      {note && <span className="shrink-0 mr-1 text-[10px] text-[var(--text-muted)]">{note}</span>}
      {onPin && (
        <button data-nav onClick={onPin} aria-label={pinned ? `Unpin ${app.label} from the rail` : `Pin ${app.label} to the rail`} aria-pressed={pinned}
          title={pinned ? 'Unpin from the rail' : 'Pin to the rail'}
          className={clsx('shrink-0 mr-1.5 w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]',
            pinned ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus:opacity-100')}>
          <Pin className={clsx('w-3.5 h-3.5', pinned && 'fill-current')} />
        </button>
      )}
    </div>
  );
}

/** The always-visible app switcher down the far left edge, Discord-style: one icon per app, a pill marks the current one.
 *  Only pinned apps get a tile; the rest are one click away in All apps, and the `system` ones share the gear menu. */
export function AppRail({ active, status, onOpen }: Props) {
  const pins = usePins();
  const [navH, setNavH] = useState<number | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const [popup, setPopup] = useState<{ kind: 'all' | 'system'; anchor: Anchor } | { kind: 'pin'; app: AppId; anchor: Anchor; owner: HTMLElement } | null>(null);
  const [q, setQ] = useState('');
  const [djState, setDjState] = useState(() => djLive.state);
  const allBtn = useRef<HTMLButtonElement>(null);
  const gearBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => djLive.subscribe(setDjState), []);

  const live = (a: AppDef) => a.live?.(status);
  const pinned = new Set(pins);
  const [chat, ...others] = APPS.filter(a => a.group !== 'system');
  const docked = others.find(a => a.id === DOCKED)!;
  const rest = others.filter(a => a !== docked);
  const pinnedApps = rest.filter(a => pinned.has(a.id));
  // Apps doing something in the background (Radio on air, a mega plan or scout running) keep a tile while they run, pinned or not.
  const running = new Set(rest.filter(a => live(a)?.busy).map(a => a.id));

  // Pinned tiles that don't fit the window's height drop into All apps instead of being clipped, last pins first.
  // Running apps and the one on screen still get a visiting tile, so make room for those first.
  const fit = (extra: number) => navH === null ? Infinity : Math.max(0, Math.floor((navH - BASE - extra) / ROW));
  const visitsFor = (cap: number) => {
    const shown = new Set(pinnedApps.slice(0, cap).map(a => a.id));
    return rest.filter(a => !shown.has(a.id) && (a.id === active || running.has(a.id))).length;
  };
  let cap = fit(0);
  for (let i = 0; i < 3; i++) {
    const next = fit(VISIT * visitsFor(cap));
    if (next === cap) break;
    cap = next;
  }
  const onRail = pinnedApps.slice(0, cap);
  const overflow = new Set(pinnedApps.slice(cap).map(a => a.id));
  const offRail = rest.filter(a => !onRail.includes(a));

  // Opened from All apps or the palette without a tile, or running in the background.
  const visitingApps = offRail.filter(a => a.id === active || running.has(a.id));
  const railIds = [...onRail.map(a => a.id), ...visitingApps.map(a => a.id), docked.id];

  useLayoutEffect(() => {
    const el = navRef.current!;
    const ro = new ResizeObserver(() => setNavH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Alt+Shift+1…9 open the pinned tiles in rail order (see shortcutLabel for why not plain Alt).
  const keys = useRef({ railIds, onOpen });
  keys.current = { railIds, onOpen };
  useEffect(() => { setRailOrder(railIds); });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      const id = m && keys.current.railIds[+m[1] - 1];
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      setPopup(null);
      setQ('');
      keys.current.onOpen(id);
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, []);
  const system = APPS.filter(a => a.group === 'system');
  const systemActive = system.some(a => a.id === active);
  const systemDot = system.some(a => live(a)?.dot);
  // Badges and running jobs of apps with no tile roll up onto All apps, so nothing that needs you goes unseen.
  const hidden = offRail.filter(a => !visitingApps.includes(a)).map(live);
  const allLive: AppLive = {
    badge: hidden.reduce((n, l) => n + (l?.badge ?? 0), 0),
    urgent: hidden.some(l => l?.urgent && l.badge),
    busy: hidden.some(l => l?.busy),
  };

  const close = (refocus = false) => {
    const owner = popup?.kind === 'all' ? allBtn.current : popup?.kind === 'system' ? gearBtn.current : popup?.kind === 'pin' ? popup.owner : null;
    setPopup(null);
    setQ('');
    if (refocus) owner?.focus();
  };
  const open = (id: AppId) => { close(); onOpen(id); };
  const toggle = (kind: 'all' | 'system') => {
    if (popup?.kind === kind) { close(); return; }
    setQ('');
    setPopup({ kind, anchor: kind === 'all' ? anchorFor(allBtn.current!, 'top', 560) : anchorFor(gearBtn.current!, 'bottom') });
  };

  const tile = (key: string, label: string, hint: string, icon: ReactNode, on: boolean, onClick: () => void,
    extra?: { button?: RefObject<HTMLButtonElement | null>; expanded?: boolean; onContextMenu?: (e: ReactMouseEvent<HTMLButtonElement>) => void; visiting?: boolean; keys?: string }) => (
    <div key={key} className="relative group flex justify-center">
      <span className={clsx('absolute -left-1.5 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-[var(--text-primary)] transition-all duration-150',
        on ? 'h-8' : 'h-0 group-hover:h-4')} />
      <button ref={extra?.button} onClick={onClick} onContextMenu={extra?.onContextMenu} aria-label={label} aria-current={on ? 'page' : undefined}
        aria-haspopup={extra?.expanded !== undefined ? 'dialog' : undefined} aria-expanded={extra?.expanded}
        className={clsx('w-10 h-10 flex items-center justify-center border transition-all duration-150',
          extra?.visiting && 'border-dashed',
          on || extra?.expanded ? 'rounded-xl bg-[var(--bg-hover)] border-[var(--accent)]/50 text-[var(--text-primary)]'
            : 'rounded-[20px] hover:rounded-xl bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
        {icon}
      </button>
      {!extra?.expanded && (
        <div role="tooltip" className="pointer-events-none hidden md:block absolute left-full top-1/2 -translate-y-1/2 ml-3 z-[60] w-max max-w-[260px] px-2.5 py-1.5 rounded-lg
          bg-[var(--bg-secondary)] border border-[var(--border-strong)] shadow-xl opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 transition-opacity duration-100 delay-150">
          <div className="flex items-center justify-between gap-3 text-xs font-semibold text-[var(--text-primary)]">{label}{extra?.keys && <Kbd>{extra.keys}</Kbd>}</div>
          <div className="text-[11px] text-[var(--text-secondary)] leading-snug">{hint}</div>
        </div>
      )}
    </div>
  );

  const appTile = (a: AppDef, isVisiting = false) => {
    const l = live(a);
    const i = railIds.indexOf(a.id);
    const why = overflow.has(a.id)
      ? 'pinned, but the window is too short for its tile'
      : running.has(a.id) && active !== a.id
        ? `${a.id === 'radio' && djState.playing ? 'playing on air' : 'running'}, right-click to pin`
        : 'not pinned, right-click to pin';
    return tile(a.id, l?.label ?? a.label, isVisiting ? `${a.hint} · ${why}` : a.hint,
      <AppIcon app={a} live={l} quiet on={active === a.id} />, active === a.id, () => onOpen(a.id), {
        visiting: isVisiting, keys: i >= 0 && i < 9 ? shortcutLabel(i) : undefined,
        onContextMenu: e => { e.preventDefault(); setPopup({ kind: 'pin', app: a.id, anchor: anchorFor(e.currentTarget, 'top', 96), owner: e.currentTarget }); },
      });
  };

  const ql = q.trim().toLowerCase();
  const matches = (a: AppDef) => !ql || `${a.label} ${a.hint} ${a.keywords ?? ''}`.toLowerCase().includes(ql);
  const groups: AppGroup[] = ['make', 'know', 'run', 'system'];
  const found = APPS.filter(a => a.group !== 'chat' && matches(a));

  return (
    <nav ref={navRef} aria-label="Apps" className="shrink-0 w-12 md:w-14 h-full flex flex-col items-center gap-2 py-3 bg-[var(--bg-tertiary)] border-r border-[var(--border-subtle)] overflow-y-auto md:overflow-visible relative z-50">
      {tile(chat.id, chat.label, chat.hint, (
        <span className="w-full h-full rounded-[inherit] flex items-center justify-center text-white text-sm font-bold" style={{ background: 'var(--sunset-brand, linear-gradient(135deg,#7c3aed,#a78bfa))' }}>B</span>
      ), active === chat.id, () => onOpen(chat.id))}
      <div className="w-8 h-px bg-[var(--border-subtle)] my-0.5" />
      {onRail.map(a => appTile(a))}
      {visitingApps.length > 0 && (
        <>
          {onRail.length > 0 && <div className="w-5 h-px bg-[var(--border-subtle)]" />}
          {visitingApps.map(a => appTile(a, true))}
        </>
      )}
      {tile('all', 'All apps', offRail.length ? `Everything else: ${offRail.map(a => a.label).join(', ')}` : 'Find any app and choose what is pinned here',
        <span className="relative flex" style={{ '--tint': 'var(--accent)' } as CSSProperties}><LayoutGrid className={ICON} /><Badges live={allLive} /></span>,
        false, () => toggle('all'), { button: allBtn, expanded: popup?.kind === 'all' })}
      <div className="flex-1" />
      {tile(docked.id, live(docked)?.label ?? docked.label, docked.hint, <AppIcon app={docked} live={live(docked)} quiet on={active === docked.id} />,
        active === docked.id, () => onOpen(docked.id), { keys: railIds.length <= 9 ? shortcutLabel(railIds.length - 1) : undefined })}
      <div className="w-8 h-px bg-[var(--border-subtle)] my-0.5" />
      {tile('system', systemDot ? 'System · needs a look' : 'System', system.map(a => a.label).join(', '),
        <span className="relative flex"><Settings className={ICON} />
          {systemDot && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 border border-[var(--bg-tertiary)]" />}</span>,
        systemActive, () => toggle('system'), { button: gearBtn, expanded: popup?.kind === 'system' })}

      {popup?.kind === 'system' && (
        <Popover anchor={popup.anchor} owner={gearBtn.current} label="System" className="w-64 p-1.5 overflow-y-auto" onClose={close}>
          {system.map(a => <AppRow key={a.id} app={a} live={live(a)} current={active === a.id} onOpen={() => open(a.id)} />)}
        </Popover>
      )}

      {popup?.kind === 'all' && (
        <Popover anchor={popup.anchor} owner={allBtn.current} label="All apps" className="w-[340px] max-w-[calc(100vw-4rem)]" onClose={close}>
          <div className="flex items-center gap-2 px-3 border-b border-[var(--border-subtle)] shrink-0">
            <Search className="w-4 h-4 text-[var(--text-muted)]" />
            <input data-nav value={q} onChange={e => setQ(e.target.value)} placeholder="Find an app…" aria-label="Find an app"
              onKeyDown={e => { if (e.key === 'Enter' && found[0]) open(found[0].id); }}
              className="flex-1 bg-transparent py-2.5 text-sm focus:outline-none" />
          </div>
          <div className="overflow-y-auto p-1.5">
            {groups.map(g => {
              const apps = found.filter(a => a.group === g);
              if (!apps.length) return null;
              return (
                <section key={g} aria-label={GROUP_LABEL[g]} className="mb-1 last:mb-0">
                  <h3 className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {GROUP_LABEL[g]}{g === 'system' && <span className="normal-case tracking-normal font-normal"> · in the gear menu</span>}
                  </h3>
                  {apps.map(a => (
                    <AppRow key={a.id} app={a} live={live(a)} current={active === a.id} pinned={pinned.has(a.id)}
                      note={railIds.indexOf(a.id) >= 0 && railIds.indexOf(a.id) < 9 ? <Kbd>{shortcutLabel(railIds.indexOf(a.id))}</Kbd>
                        : overflow.has(a.id) ? 'no room' : undefined}
                      onOpen={() => open(a.id)} onPin={PINNABLE.has(a.id) ? () => togglePin(a.id) : undefined} />
                  ))}
                </section>
              );
            })}
            {found.length === 0 && <div className="text-xs text-[var(--text-muted)] text-center py-6">No app matches “{q}”</div>}
          </div>
          <div className="shrink-0 px-3 py-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
            <span>{overflow.size ? `${overflow.size} pinned ${overflow.size === 1 ? 'app doesn’t' : 'apps don’t'} fit this window` : 'Pin apps to keep them on the rail'}</span>
            {pins.join() !== DEFAULT_PINS.join() && (
              <button onClick={() => setPins(null)}
                className="hover:text-[var(--text-primary)] underline-offset-2 hover:underline">Reset</button>
            )}
          </div>
        </Popover>
      )}

      {popup?.kind === 'pin' && (() => {
        const a = APPS.find(x => x.id === popup.app)!;
        const isPinned = pinned.has(a.id);
        return (
          <Popover anchor={popup.anchor} owner={popup.owner} label={a.label} className="w-52 p-1.5" onClose={close}>
            <button data-nav onClick={() => open(a.id)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] focus:outline-none">
              <AppIcon app={a} /> Open {a.label}
            </button>
            <button data-nav onClick={() => { togglePin(a.id); close(); }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-sm hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] focus:outline-none">
              {isPinned ? <PinOff className={clsx(ICON, 'text-[var(--text-muted)]')} /> : <Pin className={clsx(ICON, 'text-[var(--text-muted)]')} />}
              {isPinned ? 'Unpin from the rail' : 'Pin to the rail'}
            </button>
          </Popover>
        );
      })()}
    </nav>
  );
}
