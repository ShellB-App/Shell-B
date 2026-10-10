import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Check, Moon, Sparkles, Sun, Trash2, WandSparkles } from 'lucide-react';
import type { Settings } from '../types';
import { api, req } from '../api';
import { startChatWith } from '../desktop';
import {
  THEMES, customThemes, loadCustomThemes, setCustomThemes, setTheme, useCustomThemes, useTheme, DEFAULT_THEME,
  type Mode, type Swatch, type ThemeId, type ThemeInfo,
} from '../themes';
import { btn } from './common';
import { t as tx } from '../i18n';

/** A tiny drawing of the app in a theme's colours: rail, sidebar, a title, the stripe, a primary button. */
export function Thumb({ t, mode }: { t: ThemeInfo; mode: Mode }) {
  const s: Swatch = t.swatch[mode] ?? t.swatch.dark ?? t.swatch.light!;
  const r = t.hard ? 1 : t.round ? 9 : 5;
  const stripe = s.inks.length > 1
    ? `linear-gradient(90deg, ${s.inks.map((c, i) => `${c} ${(i / s.inks.length) * 100}% ${((i + 1) / s.inks.length) * 100}%`).join(', ')})`
    : s.inks[0];
  const button = s.inks.length > 1 ? `linear-gradient(100deg, ${s.inks.slice(t.id === 'synthfield' ? 1 : 0).join(', ')})` : s.inks[0];
  return (
    <div className="relative h-[84px] w-full overflow-hidden" style={{ background: s.bg, borderRadius: r }} aria-hidden>
      <div className="absolute inset-y-0 left-0 w-[14%]" style={{ background: s.panel, borderRight: `1px solid ${s.text}1a` }} />
      <div className="absolute inset-y-0 left-[14%] w-[26%]" style={{ background: s.panel, opacity: 0.6 }}>
        {[0, 1, 2, 3].map(i => <div key={i} className="mx-[10%] mt-[9px] h-[3px]" style={{ background: s.text, opacity: i ? 0.25 : 0.5, borderRadius: r }} />)}
      </div>
      <div className="absolute left-[48%] right-[4%] top-[18px] text-[11px] font-semibold leading-none whitespace-nowrap overflow-hidden"
        style={{ color: s.text, fontFamily: t.font, letterSpacing: t.hard || t.round ? '0.14em' : 0, textTransform: t.hard || t.round ? 'uppercase' : undefined }}>
        {tx('Good evening')}
      </div>
      <div className="absolute left-[48%] top-[34px] h-[3px] w-[22%]" style={{ background: stripe, borderRadius: t.round ? 3 : 0 }} />
      <div className="absolute left-[48%] right-[8%] top-[46px] h-[10px]" style={{ background: s.panel, border: `1px solid ${s.text}22`, borderRadius: r }} />
      <div className="absolute right-[8%] bottom-[9px] h-[11px] w-[22%]"
        style={{ background: button, borderRadius: t.hard ? 0 : 999, clipPath: t.hard ? 'polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 0 100%)' : undefined }} />
    </div>
  );
}

function Tile({ t, mode, on, onPick, extra }: { t: ThemeInfo; mode: Mode; on: boolean; onPick: () => void; extra?: ReactNode }) {
  const only = t.modes.length === 1 ? t.modes[0] : null;
  return (
    <div className="relative group/tile">
      <button role="radio" aria-checked={on} onClick={onPick}
        className={clsx('w-full h-full text-left p-2 rounded-lg border transition bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,var(--accent))]',
          on ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]/40' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]')}>
        <Thumb t={t} mode={only ?? mode} />
        <div className="mt-2 flex items-center gap-1.5 text-[13px] font-medium pr-5">
          <span className="truncate">{tx(t.label)}</span>
          {on && <Check className="w-3.5 h-3.5 shrink-0 text-[var(--accent-soft)]" />}
          {only && <span className="ml-auto shrink-0 text-[10px] font-normal text-[var(--text-muted)]">{only} only</span>}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)] line-clamp-3">{tx(t.blurb)}</div>
      </button>
      {extra}
    </div>
  );
}

const IDEAS = ['Deep-sea bioluminescence', 'Autumn library by lamplight', 'Tron grid at midnight', 'Ghibli meadow in summer'];

/** Settings → Appearance: pick a theme (applies at once) and light or dark, or have Shell:B design one. */
export function ThemePicker({ settings, mode, onMode, onDone }: { settings?: Settings; mode: Mode; onMode: (m: Mode) => void; onDone?: () => void }) {
  const current = useTheme();
  const customs = useCustomThemes();
  const [idea, setIdea] = useState('');
  useEffect(() => { loadCustomThemes(); }, []);
  const pick = (id: ThemeId) => {
    setTheme(id);
    // the server only keeps keys it knows; until it has `theme`, the choice stays in this browser
    if (settings && 'theme' in settings) api.saveSettings({ theme: id }).catch(() => {});
  };
  const remove = async (id: string) => {
    const raw = id.slice('custom:'.length);
    try {
      await req(`/api/themes/${encodeURIComponent(raw)}`, { method: 'DELETE' });
      if (current === id) pick(DEFAULT_THEME);
      await loadCustomThemes();
    } catch { setCustomThemes([]); await loadCustomThemes(); }
  };
  const design = (text: string) => {
    const want = text.trim();
    startChatWith(want
      ? `Design a custom Shell:B theme: ${want}`
      : 'Design a custom Shell:B theme for me. Ask me what mood or reference I have in mind first.');
    onDone?.();
  };
  const info = [...THEMES, ...customThemes()].find(t => t.id === current);
  const fallsBack = info && !info.modes.includes(mode);
  return (
    <div className="pb-4 border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-3 mb-2.5">
        <div className="flex-1 min-w-0">
          <div className="text-sm">{tx('Theme')}</div>
          <div className="text-[11px] text-[var(--text-muted)]">
            {settings && 'theme' in settings ? tx('Saved to Shell:B, so it follows you to other devices') : tx('Saved in this browser')}
          </div>
        </div>
        <div className="flex gap-1.5" role="radiogroup" aria-label={tx('Mode')}>
          {(['dark', 'light'] as const).map(m => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => onMode(m)}
              className={clsx(btn.subtle, mode === m && '!border-[var(--accent)] !text-[var(--accent-soft)] !bg-[var(--bg-hover)]')}>
              {m === 'dark' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}<span className="capitalize">{m}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5" role="radiogroup" aria-label={tx('Theme')}>
        {THEMES.map(t => <Tile key={t.id} t={t} mode={mode} on={t.id === current} onPick={() => pick(t.id)} />)}
      </div>
      {fallsBack && <div className="mt-2 text-[11px] text-[var(--text-muted)]">{tx('{label} has no {mode} design, so {mode} mode shows Classic {mode}.', { label: info!.label, mode: mode })}</div>}

      <div className="mt-5 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent-soft)]" />
        <div className="text-sm">{tx('Designed by Shell:B')}</div>
        <div className="text-[11px] text-[var(--text-muted)]">{customs.length ? tx('{length} saved', { length: customs.length }) : ''}</div>
      </div>
      {customs.length > 0 && (
        <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-3 gap-2.5" role="radiogroup" aria-label={tx('Custom themes')}>
          {customs.map(t => (
            <Tile key={t.id} t={t} mode={mode} on={t.id === current} onPick={() => pick(t.id)}
              extra={
                <button onClick={() => { if (confirm(tx('Delete the theme "{label}"?', { label: t.label }))) remove(t.id); }} title={tx('Delete {label}', { label: t.label })}
                  className="absolute right-3.5 top-3.5 p-1 rounded bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 transition">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              } />
          ))}
        </div>
      )}
      <form className="mt-2.5 rounded-lg border border-dashed border-[var(--border-strong)] p-3 bg-[var(--bg-secondary)]"
        onSubmit={e => { e.preventDefault(); design(idea); }}>
        <div className="text-[12px] text-[var(--text-secondary)] max-w-[65ch]">
          {tx('Describe a look and Shell:B designs it in a new chat: palette, type, backdrop and the particles drifting behind the app. You can refine it there, then apply it from the card it shows you.')}
        </div>
        <div className="mt-2.5 flex gap-2">
          <input value={idea} onChange={e => setIdea(e.target.value)} maxLength={300}
            placeholder={tx('e.g. a rainy Tokyo street at night, neon in puddles')}
            className="flex-1 min-w-0 px-3 py-1.5 rounded-md text-sm bg-[var(--bg-primary)] border border-[var(--border-subtle)] focus:border-[var(--accent)] outline-none" />
          <button type="submit" className={clsx(btn.primary, 'shrink-0')}>
            <WandSparkles className="w-3.5 h-3.5" />{tx('Design theme')}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {IDEAS.map(i => (
            <button key={i} type="button" onClick={() => design(i)}
              className="px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] transition">
              {i}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
