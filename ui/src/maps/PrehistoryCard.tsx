// Card for a prehistoric site in the Worlds app: painted caves, shelters, first villages, temples and megaliths.
import { useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Check, Copy, Hourglass, Navigation, Sunrise, Sunset, X } from 'lucide-react';
import { t } from '../i18n';
import { fmtCoord } from './core';
import { FeatureNotes } from './FeatureNotes';
import { SOLAR_COLOR } from './deeptime';
import {
  formatWhen, isCaveSite, prehistorySolar, siteDesc, siteHighlight, siteName, yearsAgo,
  type PrehistoryKind, type PrehistorySite, type SolarEvent, type Visit,
} from './prehistory';

export const KIND_LABEL: Record<PrehistoryKind, string> = {
  cave: 'Painted cave', rockart: 'Rock art', shelter: 'Rock shelter', settlement: 'Early village',
  temple: 'Sanctuary', megalith: 'Megaliths', tomb: 'Megalithic tomb', find: 'Archaeological find',
};
export const KIND_COLOR: Record<PrehistoryKind, string> = {
  cave: '#e2725b', rockart: '#f4a259', shelter: '#d4a373',
  settlement: '#84cc16', temple: '#a3e635', megalith: '#cbd5e1', tomb: '#c4b5fd', find: '#67e8f9',
};
const VISIT_LABEL: Record<Visit, string> = {
  open: 'Original open to visitors', replica: 'Closed; visit the replica', closed: 'Closed to the public', site: 'Site to see, little to visit',
};
export const SOLAR_LABEL: Record<SolarEvent, string> = {
  'ws-rise': 'Winter solstice sunrise', 'ws-set': 'Winter solstice sunset',
  'ss-rise': 'Summer solstice sunrise', 'ss-set': 'Summer solstice sunset',
  'eq-rise': 'Equinox sunrise', 'eq-set': 'Equinox sunset',
};

export function PrehistoryCard({ site, onClose, onFlyTo, onDeepTime }: {
  site: PrehistorySite;
  onClose: () => void;
  onFlyTo: (lat: number, lon: number) => void;
  /** Turn on the Ice Age coast at this many years ago. */
  onDeepTime: (yearsAgo: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const color = KIND_COLOR[site.kind];
  const solar = prehistorySolar(site);
  const ago = yearsAgo(site);
  const highlight = siteHighlight(site);

  const copy = () => {
    navigator.clipboard.writeText(`${site.lat.toFixed(5)}, ${site.lon.toFixed(5)}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  const meta: { label: string; value: string }[] = [
    { label: t('Age'), value: formatWhen(site) },
    { label: t('Period'), value: t(site.period) },
  ];
  if (site.discovered) meta.push({ label: t('Discovered'), value: site.discovered });
  if (site.unesco) meta.push({ label: 'UNESCO', value: t('Inscribed {year}', { year: site.unesco }) });

  return (
    <div className="w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-subtle)] sb-map-glass p-3.5 text-[12px] shadow-2xl backdrop-blur-xl">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border"
            style={{ color, borderColor: `${color}55`, background: `${color}1f` }}>
            <Hourglass className="w-3 h-3" />
            {t(KIND_LABEL[site.kind])}
          </span>
          <h3 className="mt-1 text-[15px] font-bold tracking-tight text-[var(--text-primary)] leading-snug">{siteName(site)}</h3>
          <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">{site.place} · {t(site.country)}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition" title={t('Close card')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-2 text-[11px] p-2 rounded-lg bg-[var(--bg-primary)]/50 border border-[var(--border-subtle)]">
        {meta.map(m => (
          <div key={m.label} className="min-w-0">
            <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold truncate">{m.label}</dt>
            <dd className="text-[10.5px] text-[var(--text-primary)] mt-0.5 leading-snug">{m.value}</dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('Coordinates')}</dt>
          <dd className="font-mono text-[10.5px] tabular-nums text-[var(--text-primary)] mt-0.5">
            {fmtCoord(site.lat, site.lon)}{site.approx && <span className="font-sans text-[var(--text-muted)]"> · {t('approx.')}</span>}
          </dd>
        </div>
      </dl>

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)] max-w-[65ch]">{siteDesc(site)}</p>
      {highlight && (
        <div className="mt-2 p-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-[11px] italic text-[var(--text-secondary)] leading-snug">{highlight}</div>
      )}

      {site.visit && (
        <div className="mt-2 text-[11px] text-[var(--text-muted)]">
          {t(VISIT_LABEL[site.visit])}{site.replica && <>: <span className="text-[var(--text-secondary)]">{site.replica}</span></>}
        </div>
      )}

      {solar.length > 0 && (
        <div className="mt-2.5 p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]/50 space-y-1.5">
          <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('Facing the Sun')}</div>
          {solar.map(l => {
            const Icon = l.event.endsWith('rise') ? Sunrise : Sunset;
            return (
              <div key={l.event} className="flex items-start gap-2">
                <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: SOLAR_COLOR[l.event] }} />
                <div className="min-w-0 text-[11px] leading-snug">
                  <div className="text-[var(--text-primary)]">{t(SOLAR_LABEL[l.event])}</div>
                  {l.then != null && l.now != null && (
                    <div className="text-[10.5px] text-[var(--text-muted)] tabular-nums">
                      {t('{then}° when built · {now}° today', { then: l.then.toFixed(1), now: l.now.toFixed(1) })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-[var(--text-muted)] leading-snug">
            {t('Bearings from north over a flat horizon. Solid line: when built; dashed: today. Earth’s tilt was larger then, so the solstice Sun rose a little further out.')}
          </p>
        </div>
      )}

      <div className="mt-3 pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-2">
        <button onClick={() => onFlyTo(site.lat, site.lon)}
          className="flex-1 min-w-[7rem] py-1.5 px-2.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:opacity-90 transition">
          <Navigation className="w-3.5 h-3.5" />{t('Fly to')}
        </button>
        {(isCaveSite(site) || ago > 7000) && (
          <button onClick={() => onDeepTime(Math.min(ago, 80000))}
            className="py-1.5 px-2.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[11px] flex items-center gap-1 transition"
            title={t('Show the coastline and sea level of that time')}>
            <Hourglass className="w-3.5 h-3.5" />{t('Coast then')}
          </button>
        )}
        <a href={`#/wiki/search/${encodeURIComponent(site.name)}`}
          className="py-1.5 px-2.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[11px] flex items-center gap-1 transition"
          title={t('Look it up in the offline Wikipedia')}>
          <BookOpen className="w-3.5 h-3.5" />Wiki
        </a>
        <button onClick={copy} title={t('Copy coordinates')}
          className={clsx('py-1.5 px-2 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[11px] flex items-center transition')}>
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>

      <FeatureNotes body="earth" feature={site.name} />
    </div>
  );
}
