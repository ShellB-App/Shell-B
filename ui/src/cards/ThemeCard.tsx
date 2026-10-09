// ```theme``` fence: {"id": "t1a2b3c4"}, from the design_theme tool (server/themes.py). Previews a custom theme Shell:B
// designed and applies it in one click, with an undo back to whatever was on before. Revisions keep the id, so an
// older card in the chat shows the latest version.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Palette, Undo2 } from 'lucide-react';
import { api, req } from '../api';
import { customTheme, currentTheme, loadCustomThemes, setTheme, themeInfo, useCustomThemes, useTheme, type CustomTheme, type ThemeId } from '../themes';
import { FONT_STACKS } from '../themes/custom';
import { Thumb } from '../components/ThemePicker';
import { CardFrame, CardPending, parseJson } from './CardFrame';
import type { CardProps } from './registry';

const save = (id: ThemeId) => api.saveSettings({ theme: id }).catch(() => {});

export function ThemeCard({ source, streaming }: CardProps) {
  const spec = parseJson(source);
  const raw = typeof spec?.id === 'string' ? spec.id : '';
  const id = `custom:${raw}` as ThemeId;
  useCustomThemes();  // re-render when the list changes (a revision, a delete)
  const active = useTheme();
  const [gone, setGone] = useState(false);
  const [before, setBefore] = useState<ThemeId | null>(null);

  useEffect(() => {
    if (!raw) return;
    // the list may predate this design: refresh, then check it's there
    loadCustomThemes().then(() => req<CustomTheme>(`/api/themes/${encodeURIComponent(raw)}`)).then(() => setGone(false), () => setGone(true));
  }, [raw]);

  const t = raw ? customTheme(id) : undefined;
  const info = t ? themeInfo(id) : undefined;
  if (!raw || !t || !info) {
    return <CardPending icon={Palette} streaming={streaming || (!!raw && !gone)} waiting="Loading the theme…"
      broken={gone ? 'This theme was deleted.' : 'This theme card is missing its id.'} />;
  }
  const on = active === id;
  const p = t.palette;
  const chips: [string, string][] = [['Page', p.bg], ['Panel', p.panel], ['Text', p.text], ['Accent', p.accent], ['Brand', p.brand]];
  const apply = () => { setBefore(currentTheme()); setTheme(id); save(id); };
  const undo = () => { if (before) { setTheme(before); save(before); } setBefore(null); };

  return (
    <CardFrame icon={Palette} title={t.name} meta={`${t.mode} theme · designed by Shell:B`}
      actions={on && before ? (
        <button onClick={undo} className="flex items-center gap-1 hover:text-[var(--text-primary)] transition"><Undo2 className="w-3.5 h-3.5" />Undo</button>
      ) : null}>
      <div className="p-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start">
        <Thumb t={info} mode={t.mode} />
        <div className="min-w-0">
          {t.blurb && <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{t.blurb}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map(([label, c]) => (
              <span key={label} className="inline-flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full border border-[var(--border-subtle)] text-[10.5px] text-[var(--text-muted)]">
                <span className="w-3 h-3 rounded-full border border-black/20" style={{ background: c }} />{label}
                <code className="text-[10px]">{c}</code>
              </span>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-[var(--text-muted)]">
            <span style={{ fontFamily: FONT_STACKS[t.fonts.display] }} className="text-[var(--text-secondary)] text-[13px]">{t.fonts.display.replace(/-/g, ' ')}</span>
            {' '}headings · {t.shape} corners
            {t.backdrop.horizon !== 'none' && <> · {t.backdrop.horizon} horizon</>}
            {t.particles.kind !== 'none' && <> · {t.particles.kind}</>}
          </div>
          <button onClick={on ? undefined : apply} disabled={on}
            className={clsx('mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition',
              on ? 'border border-[var(--border-strong)] text-[var(--text-secondary)] cursor-default' : 'bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110')}>
            {on ? <><Check className="w-3.5 h-3.5" />Applied</> : <><Palette className="w-3.5 h-3.5" />Apply theme</>}
          </button>
        </div>
      </div>
    </CardFrame>
  );
}
