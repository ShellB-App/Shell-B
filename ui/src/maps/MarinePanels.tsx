// Marine biology controls for the Worlds app: the sea-surface chip (variable, date, legend), the marine-life chip
// (find a species, see where OBIS has records of it) and the "sea here" card for a dropped pin.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Fish, Loader2, Search, Waves, X } from 'lucide-react';
import { fmtNumber, t } from '../i18n';
import {
  SEA_VARS, compassOf, fetchNearby, fetchOcean, searchTaxa,
  type GridStats, type NearbySpecies, type Ocean, type SeaVar, type Taxon,
} from './marine';

const chip = 'pointer-events-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass px-2.5 py-1.5 text-[11px]';

export function SeaChip({ v, onChange, day }: { v: SeaVar; onChange: (v: SeaVar) => void; day: string }) {
  const spec = SEA_VARS[v];
  return (
    <div className={clsx(chip, 'w-64')}>
      <div className="flex items-center gap-2">
        <Waves className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <div role="radiogroup" aria-label={t('Sea layer')} className="flex flex-1 rounded-md bg-[var(--bg-tertiary)] p-0.5">
          {(Object.keys(SEA_VARS) as SeaVar[]).map(k => (
            <button key={k} role="radio" aria-checked={k === v} onClick={() => onChange(k)}
              className={clsx('flex-1 px-1.5 py-0.5 rounded text-[10.5px] transition', k === v ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              {t(SEA_VARS[k].label)}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1.5 h-2 rounded-sm" style={{ background: `linear-gradient(90deg, ${spec.colors.join(', ')})` }} />
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-[var(--text-muted)]">
        {spec.ticks.map(tk => <span key={tk}>{t(tk)}</span>)}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>{v === 'chl' ? t('mg/m³, log scale') : spec.unit}{v === 'sstanom' && ` · ${t('vs 2003–2014')}`}</span>
        <span className="font-mono tabular-nums text-[var(--text-secondary)]" title={t('Follows the map clock; use the time bar to pick a day')}>{day}</span>
      </div>
    </div>
  );
}

export function LifeChip({ taxon, stats, loading, onPick, onClear }: {
  taxon: Taxon | null; stats: GridStats | null; loading: boolean; onPick: (t: Taxon) => void; onClear: () => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Taxon[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!taxon);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 3) { setHits([]); return; }
    let alive = true;
    setBusy(true);
    const tm = setTimeout(() => searchTaxa(s).then(r => { if (alive) setHits(r); }).catch(() => {}).finally(() => { if (alive) setBusy(false); }), 300);
    return () => { alive = false; clearTimeout(tm); };
  }, [q]);

  const pick = (x: Taxon) => { onPick(x); setQ(''); setHits([]); setOpen(false); };

  return (
    <div className={clsx(chip, 'w-64')}>
      <div className="flex items-center gap-2">
        <Fish className="w-3.5 h-3.5 text-teal-400 shrink-0" />
        {taxon && !open ? (
          <button className="min-w-0 flex-1 text-left" onClick={() => { setOpen(true); setTimeout(() => box.current?.focus(), 0); }} title={t('Show another species')}>
            <span className="block truncate italic text-[var(--text-primary)]">{taxon.name}</span>
            <span className="block text-[10px] text-[var(--text-muted)] tabular-nums">
              {loading ? t('Loading records…') : stats?.records
                ? `${t('{n} OBIS records', { n: fmtNumber(stats.records) })}${stats.yearrange ? ` · ${stats.yearrange[0]}–${stats.yearrange[1]}` : ''}`
                : t('No records in OBIS')}
            </span>
          </button>
        ) : (
          <div className="relative min-w-0 flex-1">
            <Search className="w-3 h-3 absolute left-1.5 top-1.5 text-[var(--text-muted)] pointer-events-none" />
            <input ref={box} value={q} onChange={e => setQ(e.target.value)} placeholder={t('Species, scientific or common name')}
              onKeyDown={e => { if (e.key === 'Enter' && hits[0]) pick(hits[0]); if (e.key === 'Escape' && taxon) setOpen(false); }}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-md pl-6 pr-5 py-1 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              aria-label={t('Find a marine species')} />
            {busy && <Loader2 className="w-3 h-3 absolute right-1.5 top-1.5 animate-spin text-[var(--text-muted)]" />}
            {hits.length > 0 && (
              <div className="absolute left-0 right-0 top-8 z-40 rounded-lg border border-[var(--border-subtle)] sb-map-glass py-1 shadow-2xl max-h-56 overflow-y-auto">
                {hits.map(h => (
                  <button key={h.aphia} onClick={() => pick(h)} className="w-full px-2 py-1 text-left hover:bg-[var(--bg-tertiary)]">
                    <span className="block italic text-[11px] text-[var(--text-primary)] truncate">{h.name}</span>
                    <span className="block text-[10px] text-[var(--text-muted)] truncate">{[h.rank, h.authority].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {taxon && (
          <button onClick={() => { onClear(); setOpen(true); }} className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title={t('Clear species')}>
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {taxon && !open && (
        <p className="mt-1 text-[10px] leading-snug text-[var(--text-muted)]">{t('Brighter cells hold more records. Records show where people looked, not the whole range.')}</p>
      )}
    </div>
  );
}

const fmt = (v: number | null, unit: string, nd = 1) => (v == null ? '—' : `${v.toFixed(nd)} ${unit}`);

export function SeaCard({ lat, lon, onClose, onShowSpecies }: {
  lat: number; lon: number; onClose: () => void; onShowSpecies: (t: Taxon) => void;
}) {
  const [o, setO] = useState<Ocean | null | undefined>(undefined);
  const [near, setNear] = useState<{ total: number; species: NearbySpecies[] } | null | undefined>(undefined);
  useEffect(() => {
    setO(undefined); setNear(undefined);
    let alive = true;
    fetchOcean(lat, lon).then(r => { if (alive) setO(r); });
    fetchNearby(lat, lon).then(r => { if (alive) setNear(r); });
    return () => { alive = false; };
  }, [lat, lon]);

  const c = o?.current;
  return (
    <div className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[60vh] overflow-y-auto rounded-xl border border-[var(--border-subtle)] sb-map-glass p-3 text-[12px] shadow-2xl">
      <div className="flex items-start gap-2">
        <Waves className="w-4 h-4 mt-0.5 text-cyan-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-tight text-[var(--text-primary)]">{t('The sea here')}</div>
          <div className="text-[10.5px] text-[var(--text-muted)] font-mono tabular-nums">{lat.toFixed(3)}, {lon.toFixed(3)}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title={t('Close')}><X className="w-3.5 h-3.5" /></button>
      </div>

      {o === undefined && <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Loader2 className="w-3 h-3 animate-spin" />{t('Asking the ocean models…')}</div>}
      {o === null && <div className="mt-3 text-[11px] text-[var(--text-muted)]">{t('Sea conditions are unavailable right now.')}</div>}
      {o && o.land && <div className="mt-3 text-[11px] text-[var(--text-muted)]">{t('No sea data here: on land or too close to the shore for the model. Drop the pin a little offshore.')}</div>}
      {o && !o.land && c && (
        <>
          <dl className="mt-2.5 grid grid-cols-2 gap-2 p-2 rounded-lg bg-[var(--bg-primary)]/50 border border-[var(--border-subtle)]">
            <Stat label={t('Temperature')} value={fmt(c.sea_surface_temperature, '°C')}
              sub={o.sst_range ? `${o.sst_range[0].toFixed(1)}–${o.sst_range[1].toFixed(1)} °C ${t('this week')}` : undefined} />
            <Stat label={t('Waves')} value={fmt(c.wave_height, 'm')} sub={`${t('from {dir}', { dir: compassOf(c.wave_direction) })} · ${fmt(c.wave_period, 's')}`} />
            <Stat label={t('Swell')} value={fmt(c.swell_wave_height, 'm')} />
            <Stat label={t('Surface current')} value={fmt(c.ocean_current_velocity, 'km/h')} sub={t('towards {dir}', { dir: compassOf(c.ocean_current_direction) })} />
          </dl>
          {o.daily.length > 1 && (
            <div className="mt-2 flex gap-1.5">
              {o.daily.map(d => (
                <div key={d.date} className="flex-1 rounded-md border border-[var(--border-subtle)] px-1.5 py-1 text-center">
                  <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-muted)]">{new Date(d.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })}</div>
                  <div className="text-[11px] tabular-nums text-[var(--text-primary)]">{fmt(d.wave_height_max, 'm')}</div>
                  <div className="text-[9.5px] text-[var(--text-muted)]">{compassOf(d.wave_direction_dominant)}</div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">{t('Open-Meteo marine models; not for navigation.')}</p>
        </>
      )}

      <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)]">
        <div className="text-[9.5px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">{t('Recorded within 25 km (OBIS)')}</div>
        {near === undefined && <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Loader2 className="w-3 h-3 animate-spin" />{t('Looking up species…')}</div>}
        {near === null && <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{t('OBIS is unavailable right now.')}</div>}
        {near && near.species.length === 0 && <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{t('No species records here yet.')}</div>}
        {near && near.species.length > 0 && (
          <>
            <ul className="mt-1.5 space-y-0.5">
              {near.species.map(s => (
                <li key={s.aphia}>
                  <button onClick={() => onShowSpecies({ aphia: s.aphia, name: s.name })} title={t('Map where else it has been recorded')}
                    className="w-full flex items-baseline gap-2 px-1 py-0.5 rounded text-left hover:bg-[var(--bg-tertiary)]">
                    <span className="min-w-0 flex-1 truncate italic text-[11.5px] text-[var(--text-primary)]">{s.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[6rem]">{s.group}</span>
                    <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{fmtNumber(s.records)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t('{n} taxa recorded in all; the most recorded are listed.', { n: fmtNumber(near.total) })}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold truncate">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums text-[var(--text-primary)] mt-0.5">{value}</dd>
      {sub && <dd className="text-[10px] text-[var(--text-muted)] truncate">{sub}</dd>}
    </div>
  );
}
