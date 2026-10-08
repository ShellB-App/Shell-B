import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import clsx from 'clsx';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';

/**
 * Right-click menus, desktop style. Call `openContextMenu(e, items)` from an onContextMenu handler; the one
 * <ContextMenuHost /> (main.tsx) draws it. Shift+right-click, and right-clicks on links, images, media and text
 * fields, keep the browser's own menu, which has the copy-link, save-image and spelling entries people expect there.
 * Keyboard: the Menu key or Shift+F10 opens it at the element; arrows, Home/End, a letter to jump, → and ← for
 * submenus, Enter to choose, Esc to close.
 */
export interface MenuAction {
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** a submenu instead of an action */
  items?: MenuEntry[];
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}
/** `'sep'` draws a divider; falsy entries are skipped, so items can be written as `cond && {…}`. */
export type MenuEntry = MenuAction | 'sep' | false | null | undefined | '' | 0;

interface MenuState { x: number; y: number; items: MenuEntry[]; key: number; keyboard: boolean; restore: HTMLElement | null }

let state: MenuState | null = null;
const listeners = new Set<() => void>();
const set = (s: MenuState | null) => { state = s; listeners.forEach(l => l()); };

const NATIVE = 'a[href], img, video, audio, input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, canvas, .cm-editor, .monaco-editor';

/** Normalised entries: no falsy items, no leading/trailing/doubled separators. */
function clean(entries: MenuEntry[]): (MenuAction | 'sep')[] {
  const out: (MenuAction | 'sep')[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === 'sep') { if (out.length && out[out.length - 1] !== 'sep') out.push('sep'); continue; }
    out.push(e);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** Opens a menu for this contextmenu event. Returns false (and leaves the browser's menu) when it shouldn't take over. */
export function openContextMenu(e: ReactMouseEvent | MouseEvent, entries: MenuEntry[]) {
  if (e.shiftKey) return false;
  const target = e.target as Element | null;
  if (target?.closest?.(NATIVE)) return false;
  const items = clean(entries);
  if (!items.some(i => i !== 'sep')) return false;
  e.preventDefault();
  e.stopPropagation();
  // the Menu key / Shift+F10 fire with no pointer position: open at the element instead
  const keyboard = e.clientX === 0 && e.clientY === 0;
  const box = (e.currentTarget as Element | null)?.getBoundingClientRect?.();
  const x = keyboard && box ? box.left + 12 : e.clientX;
  const y = keyboard && box ? box.top + Math.min(box.height, 28) : e.clientY;
  set({ x, y, items, key: Date.now(), keyboard, restore: document.activeElement as HTMLElement | null });
  return true;
}

export function closeContextMenu() {
  const s = state;
  set(null);
  s?.restore?.focus?.({ preventScroll: true });
}

export function ContextMenuHost() {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state, () => null);
  useEffect(() => {
    if (!s) return;
    const away = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('[data-context-menu]'))) set(null); };
    const gone = () => set(null);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', away, true);
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    window.addEventListener('hashchange', gone);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
      window.removeEventListener('hashchange', gone);
    };
  }, [s]);
  if (!s) return null;
  return <MenuList key={s.key} entries={s.items} at={{ x: s.x, y: s.y }} focusFirst={s.keyboard} onDone={closeContextMenu} />;
}

const selectable = (e: MenuAction | 'sep'): e is MenuAction => e !== 'sep' && !e.disabled;

function MenuList({ entries, at, parent, focusFirst, onDone, onBack }: {
  entries: MenuEntry[];
  at: { x: number; y: number };
  /** a submenu opens beside this item (and flips to the left when there's no room) */
  parent?: DOMRect;
  focusFirst?: boolean;
  onDone: () => void;
  onBack?: () => void;
}) {
  const items = clean(entries);
  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(focusFirst ? items.findIndex(selectable) : -1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; keyboard: boolean } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 6;
    let left = parent ? parent.right - 4 : at.x;
    let top = parent ? parent.top - 5 : at.y;
    if (left + w > vw - m) left = parent ? Math.max(m, parent.left - w + 4) : Math.max(m, at.x - w);
    if (top + h > vh - m) top = Math.max(m, parent ? vh - h - m : at.y - h);
    setPos({ left, top });
  }, [at.x, at.y, parent]);

  useEffect(() => {
    if (!pos) return;
    if (active >= 0) rows.current[active]?.focus({ preventScroll: true });
    else ref.current?.focus({ preventScroll: true });
  }, [pos, active]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const choose = (i: number, keyboard: boolean) => {
    const it = items[i];
    if (!it || it === 'sep' || it.disabled) return;
    if (it.items) {
      const rect = rows.current[i]?.getBoundingClientRect();
      if (rect) setSub({ index: i, rect, keyboard });
      return;
    }
    onDone();
    it.onSelect?.();
  };

  const move = (from: number, step: number) => {
    const n = items.length;
    for (let k = 1; k <= n; k++) {
      const i = ((from + step * k) % n + n) % n;
      if (selectable(items[i])) return i;
    }
    return from;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (sub) return;  // the submenu has the keyboard
    const k = e.key;
    if (k === 'ArrowDown') setActive(a => move(a < 0 ? -1 : a, 1));
    else if (k === 'ArrowUp') setActive(a => move(a < 0 ? items.length : a, -1));
    else if (k === 'Home') setActive(move(-1, 1));
    else if (k === 'End') setActive(move(items.length, -1));
    else if (k === 'Enter' || k === ' ') { if (active >= 0) choose(active, true); }
    else if (k === 'ArrowRight') { const it = items[active]; if (it && it !== 'sep' && it.items) choose(active, true); else return; }
    else if (k === 'ArrowLeft' && onBack) onBack();
    else if (k === 'Escape') { if (onBack) onBack(); else onDone(); }
    else if (k === 'Tab') onDone();
    else if (k.length === 1 && /\S/.test(k)) {
      const l = k.toLowerCase();
      const start = active < 0 ? -1 : active;
      for (let s = 1; s <= items.length; s++) {
        const i = (start + s) % items.length, it = items[i];
        if (selectable(it) && it.label.toLowerCase().startsWith(l)) { setActive(i); break; }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <div ref={ref} data-context-menu role="menu" tabIndex={-1} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}
        className="fixed z-[2147483001] min-w-[13rem] max-w-[20rem] max-h-[80vh] overflow-y-auto p-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl text-[13px] focus:outline-none animate-fade-in"
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
        {items.map((it, i) => it === 'sep'
          ? <div key={`s${i}`} role="separator" className="my-1 h-px bg-[var(--border-subtle)]" />
          : (
            <button key={`${i}:${it.label}`} ref={el => { rows.current[i] = el; }} type="button" role="menuitem" tabIndex={-1}
              disabled={it.disabled} aria-disabled={it.disabled || undefined} aria-haspopup={it.items ? 'menu' : undefined}
              aria-expanded={it.items ? sub?.index === i : undefined}
              onMouseEnter={() => {
                setActive(it.disabled ? -1 : i);
                window.clearTimeout(hoverTimer.current);
                if (sub && sub.index !== i) setSub(null);
                if (it.items && !it.disabled) hoverTimer.current = window.setTimeout(() => choose(i, false), 150);
              }}
              onClick={() => choose(i, false)}
              className={clsx('w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left outline-none transition-colors',
                it.disabled ? 'opacity-45 cursor-default' : it.danger ? 'text-red-400' : 'text-[var(--text-primary)]',
                !it.disabled && (active === i || sub?.index === i) && (it.danger ? 'bg-red-500/15' : 'bg-[var(--bg-hover)]'))}>
              <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                {it.checked ? <Check className="w-3.5 h-3.5 text-[var(--accent)]" /> : it.icon ? <it.icon className={clsx('w-3.5 h-3.5', !it.danger && 'text-[var(--text-secondary)]')} /> : null}
              </span>
              <span className="flex-1 min-w-0 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 pl-3 text-[11px] font-mono text-[var(--text-muted)]">{it.hint}</span>}
              {it.items && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />}
            </button>
          ))}
      </div>
      {sub && items[sub.index] !== 'sep' && (
        <MenuList key={sub.index} entries={(items[sub.index] as MenuAction).items!} at={at} parent={sub.rect} focusFirst={sub.keyboard}
          onDone={onDone} onBack={() => { const i = sub.index; setSub(null); setActive(i); rows.current[i]?.focus({ preventScroll: true }); }} />
      )}
    </>
  );
}
