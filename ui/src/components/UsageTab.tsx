import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { BarChart3, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { ModelInfo, UsageReport, UsageRow } from '../types';
import { btn } from './common';
import { toastError } from './toast';

/** Settings → Usage (server/tokens.py `report`): tokens per day split owner / guests / API, per agent and per model,
 * lifetime totals, and optional prices for cloud models. One hue in three lightness steps carries the split; the
 * legend, the hover line and the tables carry it too, so nothing is color-alone. */
const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString();
const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const SPLIT: { key: 'owner' | 'guests' | 'api'; label: string; opacity: number }[] = [
  { key: 'owner', label: 'You', opacity: 1 }, { key: 'guests', label: 'Guests', opacity: 0.55 }, { key: 'api', label: 'API keys', opacity: 0.3 },
];

export function UsageTab({ models }: { models: ModelInfo[] }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState<UsageReport | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { setR(null); api.usage(days).then(setR).catch(toastError('Usage')); }, [days]);
  if (!r) return <div className="text-xs text-[var(--text-muted)] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Adding up the ledger…</div>;
  const max = Math.max(1, ...r.series.map(d => d.prompt + d.completion));
  const W = 600, H = 160, pad = 2;
  const bw = (W - pad * (r.series.length - 1)) / r.series.length;
  const sel = hover !== null ? r.series[hover] : null;
  const total = r.window.prompt + r.window.completion;
  return (
    <div className="space-y-6 max-w-[80ch]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2"><BarChart3 className="w-4 h-4 text-[var(--accent)]" />Token usage</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-[60ch]">Every agent turn's prompt and completion tokens, from the ledger (chat deletion doesn't shrink it). Background work like titles and memory distilling isn't counted.</p>
        </div>
        <div className="flex items-center p-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} className={clsx('px-2.5 py-1 rounded-md transition', days === d ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>{d} days</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: `Tokens · ${days} days`, value: fmt(total), sub: `${fmt(r.window.prompt)} in · ${fmt(r.window.completion)} out` },
          { label: 'Replies', value: r.window.turns.toLocaleString(), sub: total && r.window.turns ? `${fmt(Math.round(total / r.window.turns))} per reply` : '' },
          { label: 'Lifetime', value: fmt(r.lifetime.total), sub: `${r.lifetime.turns.toLocaleString()} replies` },
          { label: 'Cost (priced models)', value: r.cost === null ? '—' : money(r.cost), sub: r.cost === null ? 'set prices below' : `${days} days` },
        ].map(t => (
          <div key={t.label} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t.label}</div>
            <div className="text-lg font-semibold tabular-nums tracking-tight">{t.value}</div>
            {t.sub && <div className="text-[11px] text-[var(--text-muted)]">{t.sub}</div>}
          </div>
        ))}
      </div>

      <section>
        <div className="flex items-center justify-between mb-1 text-[11px] text-[var(--text-muted)] h-5">
          <span>{sel ? `${sel.day} · ${fmt(sel.prompt + sel.completion)} tokens · ${sel.turns} replies` : 'Tokens per day'}</span>
          <span className="flex items-center gap-3">
            {SPLIT.map(s => <span key={s.key} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--accent)', opacity: s.opacity }} />{s.label}{sel ? ` ${fmt(sel[s.key])}` : ''}</span>)}
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-auto" role="img" aria-label={`Tokens per day over the last ${days} days`} onMouseLeave={() => setHover(null)}>
          {[0.5, 1].map(f => <line key={f} x1={0} x2={W} y1={H - H * f} y2={H - H * f} stroke="var(--border-subtle)" strokeWidth={1} />)}
          {r.series.map((d, i) => {
            const x = i * (bw + pad);
            let y = H;
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)}>
                <rect x={x} y={0} width={bw} height={H} fill="transparent" />
                {SPLIT.map(s => {
                  const h = (d[s.key] / max) * H;
                  y -= h;
                  const gap = h > 2 ? 2 : 0;
                  return h > 0 ? <rect key={s.key} x={x} y={y + gap / 2} width={Math.max(1, bw)} height={Math.max(0.5, h - gap)} fill="var(--accent)" opacity={s.opacity} rx={s.key === 'api' || (s.key === 'guests' && !d.api) || (s.key === 'owner' && !d.api && !d.guests) ? 2 : 0} /> : null;
                })}
                {hover === i && <rect x={x} y={0} width={bw} height={H} fill="var(--text-primary)" opacity={0.06} />}
              </g>
            );
          })}
          <text x={0} y={H + 13} fontSize={9} fill="var(--text-muted)">{r.series[0]?.day}</text>
          <text x={W} y={H + 13} fontSize={9} fill="var(--text-muted)" textAnchor="end">{r.series[r.series.length - 1]?.day}</text>
          <text x={W} y={10} fontSize={9} fill="var(--text-muted)" textAnchor="end">{fmt(max)}</text>
        </svg>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Table title="By agent" rows={r.agents} total={total} />
        <Table title="By model" rows={r.models} total={total} priced={r.cost !== null} />
      </div>

      <Costs models={models} used={r.models.map(m => m.name)} costs={r.costs} onSaved={() => api.usage(days).then(setR).catch(() => {})} />
    </div>
  );
}

function Table({ title, rows, total, priced }: { title: string; rows: UsageRow[]; total: number; priced?: boolean }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{title}</h4>
      <table className="w-full text-[12px]">
        <thead className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          <tr><th className="text-left font-medium py-1">Name</th><th className="text-right font-medium py-1">Tokens</th><th className="text-right font-medium py-1">Replies</th>{priced && <th className="text-right font-medium py-1">Cost</th>}</tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {rows.length === 0 && <tr><td colSpan={4} className="py-2 text-[var(--text-muted)]">Nothing in this window.</td></tr>}
          {rows.slice(0, 12).map(x => {
            const n = x.prompt + x.completion;
            return (
              <tr key={x.name}>
                <td className="py-1 pr-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{x.name}</span>
                    <span className="h-1 rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, Math.round((n / Math.max(1, total)) * 80))}px`, opacity: 0.6 }} aria-hidden />
                  </div>
                </td>
                <td className="py-1 text-right tabular-nums">{fmt(n)}</td>
                <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">{x.turns.toLocaleString()}</td>
                {priced && <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">{x.cost !== undefined ? money(x.cost) : ''}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Prices per million tokens for cloud models (local ones cost electricity, not dollars). Saved in `modelCosts`. */
function Costs({ models, used, costs, onSaved }: { models: ModelInfo[]; used: string[]; costs: UsageReport['costs']; onSaved: () => void }) {
  const cloud = useMemo(() => models.filter(m => m.cloud).map(m => m.name), [models]);
  // the catalog lists every cloud model a provider offers (dozens); by default price only the ones this period used
  // or that already have a price, and let the full list be opened
  const [all, setAll] = useState(false);
  const names = useMemo(() => {
    const pick = all ? cloud : cloud.filter(n => used.includes(n));
    return Array.from(new Set([...pick, ...Object.keys(costs)])).sort();
  }, [all, cloud, used, costs]);
  const [draft, setDraft] = useState<Record<string, { in?: number; out?: number }>>(costs);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(costs), [costs]);
  if (!cloud.length && !Object.keys(costs).length) return <p className="text-[11px] text-[var(--text-muted)]">Prices apply to cloud models; none are configured (Tools & Connectors → Cloud AI).</p>;
  const hidden = cloud.length - names.filter(n => cloud.includes(n)).length;
  const set = (name: string, k: 'in' | 'out', v: string) => setDraft(d => ({ ...d, [name]: { ...d[name], [k]: v === '' ? undefined : Math.max(0, Number(v)) } }));
  const save = async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => v && (v.in !== undefined || v.out !== undefined)));
      await api.saveSettings({ modelCosts: clean });
      onSaved();
    } catch (e) { toastError('Prices')(e); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Prices for cloud models ($ per million tokens)</h4>
      {!names.length && <p className="text-[11px] text-[var(--text-muted)]">No cloud model was used in this period.</p>}
      <div className="space-y-1.5">
        {names.map(n => (
          <div key={n} className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="font-mono text-[11px] w-56 truncate" title={n}>{n}</span>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">in <input type="number" min={0} step={0.01} className={clsx(btn.input, 'w-20')} value={draft[n]?.in ?? ''} onChange={e => set(n, 'in', e.target.value)} /></label>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">out <input type="number" min={0} step={0.01} className={clsx(btn.input, 'w-20')} value={draft[n]?.out ?? ''} onChange={e => set(n, 'out', e.target.value)} /></label>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {names.length > 0 && <button className={btn.subtle} onClick={save} disabled={busy}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}Save prices</button>}
        {hidden > 0 && !all && <button className={btn.ghost} onClick={() => setAll(true)}>Show all cloud models ({hidden} more)</button>}
        {all && <button className={btn.ghost} onClick={() => setAll(false)}>Only models used in this period</button>}
      </div>
    </section>
  );
}
