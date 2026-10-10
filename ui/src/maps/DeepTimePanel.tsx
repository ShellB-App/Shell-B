// The Ice Age coast control: how many years back, the sea level that goes with it, and stops at telling moments.
import { Hourglass, X } from 'lucide-react';
import { fmtNumber, t } from '../i18n';
import { DEEP_MAX, seaLevelAt } from './deeptime';

// a square-root scale gives the last 20,000 years most of the slider
const toSlider = (y: number) => Math.round(Math.sqrt(y / DEEP_MAX) * 1000);
const fromSlider = (v: number) => {
  const y = DEEP_MAX * (v / 1000) ** 2;
  return y < 2000 ? Math.round(y / 100) * 100 : Math.round(y / 500) * 500;
};

const STOPS: { years: number; label: string }[] = [
  { years: 6000, label: 'Carnac' },
  { years: 9000, label: 'Doggerland' },
  { years: 12000, label: 'Göbekli Tepe' },
  { years: 21000, label: 'Glacial maximum' },
  { years: 36000, label: 'Chauvet' },
];

export function DeepTimePanel({ years, onChange, shown, onClose }: {
  years: number;
  onChange: (years: number) => void;
  /** Prehistoric sites on the map at this date, or null when neither prehistory layer is on. */
  shown: number | null;
  onClose: () => void;
}) {
  const sea = Math.round(seaLevelAt(years));
  return (
    <div className="pointer-events-auto w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--border-subtle)] sb-map-glass px-3 py-2.5 text-[12px] shadow-2xl">
      <div className="flex items-center gap-2">
        <Hourglass className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
            {years === 0 ? t('Today') : t('{n} years ago', { n: fmtNumber(years) })}
          </div>
          <div className="text-[10.5px] text-[var(--text-muted)] tabular-nums">
            {t('Sea level {m} m', { m: sea === 0 ? '0' : `−${Math.abs(sea)}` })}
            {shown != null && <> · {t('{n} sites already there', { n: shown })}</>}
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition" title={t('Hide the Ice Age coast')}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <input type="range" min={0} max={1000} value={toSlider(years)} onChange={e => onChange(fromSlider(Number(e.target.value)))}
        className="mt-2 w-full accent-amber-500" aria-label={t('Years ago')} />
      <div className="mt-1 flex flex-wrap gap-1">
        {STOPS.map(s => (
          <button key={s.years} onClick={() => onChange(s.years)}
            className={'px-1.5 py-0.5 rounded-md text-[10.5px] border transition ' + (years === s.years
              ? 'border-amber-500/60 text-amber-300 bg-amber-500/10'
              : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
            {t(s.label)}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-[var(--text-muted)]">
        {t('Tinted land was dry then. Global mean sea level; ice sheets and local uplift are not drawn.')}
      </p>
    </div>
  );
}
