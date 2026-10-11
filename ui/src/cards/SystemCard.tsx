// ```system``` fence ({} is enough): the Spark's live vitals. Polls /api/system/live every 3 s while on screen and keeps
// two minutes of history per meter; services come from /api/status. Status colours are reserved for state and always
// ship with an icon and a word, never colour alone.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Cpu, HardDrive, MemoryStick, Microchip, XCircle } from 'lucide-react';
import { CardFrame } from './CardFrame';
import type { CardProps } from './registry';
import { t as tx } from '../i18n';

interface Live {
  cpu: { usage: number; temp: number | null; load: number[]; cores: number };
  gpu: { name: string; util: number | null; temp: number | null; power: number | null; clockMHz: number | null } | null;
  memory: { total: number; available: number; swapTotal: number; swapFree: number };
  disk: { total: number; used: number };
  models: { name: string; size: number | null; until: string | null }[];
  host: string;
  at: number;
}
type Services = Record<string, { ok: boolean; detail?: string }>;

const HISTORY = 40;  // 40 × 3 s = 2 min
const GB = 1e9;  // decimal, like the disk meter's TB
const STATUS = { good: '#1baf7a', warn: '#c98500', bad: '#e66767' };

function level(pct: number, warn = 80, bad = 92): keyof typeof STATUS { return pct >= bad ? 'bad' : pct >= warn ? 'warn' : 'good'; }

export function SystemCard(_props: CardProps) {
  const root = useRef<HTMLElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hist = useRef<{ cpu: number[]; gpu: number[]; mem: number[] }>({ cpu: [], gpu: [], mem: [] });

  useEffect(() => {
    let seen = true, gone = false, t: ReturnType<typeof setTimeout> | undefined, n = 0;
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; });
    if (root.current) io.observe(root.current);
    const tick = async () => {
      if (seen && !document.hidden) {
        try {
          const [l, s] = await Promise.all([
            fetch('/api/system/live').then(r => (r.ok ? r.json() as Promise<Live> : Promise.reject(new Error(`HTTP ${r.status}`)))),
            n++ % 5 === 0 ? fetch('/api/status').then(r => r.json()).then(d => d.services as Services).catch(() => null) : Promise.resolve(undefined),
          ]);
          if (gone) return;
          const h = hist.current, push = (a: number[], v: number) => { a.push(v); if (a.length > HISTORY) a.shift(); };
          push(h.cpu, l.cpu.usage); push(h.gpu, l.gpu?.util ?? 0); push(h.mem, 100 * (1 - l.memory.available / l.memory.total));
          setLive(l); setError(null);
          if (s !== undefined && s) setServices(s);
        } catch (e) { if (!gone) setError((e as Error).message); }
      }
      if (!gone) t = setTimeout(tick, 3000);
    };
    tick();
    return () => { gone = true; clearTimeout(t); io.disconnect(); };
  }, []);

  const memPct = live ? 100 * (1 - live.memory.available / live.memory.total) : 0;
  const diskPct = live ? 100 * live.disk.used / live.disk.total : 0;
  const down = services ? Object.entries(services).filter(([, v]) => !v.ok) : [];

  return (
    <CardFrame icon={Microchip} title={live?.host ?? tx('System')} meta={live?.gpu ? `· ${live.gpu.name} · ${live.cpu.cores} cores` : undefined}
      actions={error ? <span className="text-amber-300">{tx('Couldn’t refresh')}</span> : live ? <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{tx('Live')}</span> : null}>
      <section ref={root}>
        {!live ? (
          <div className="px-4 py-8 text-[12px] text-[var(--text-muted)]">{error ?? <span className="animate-pulse">{tx('Reading the Spark’s vitals…')}</span>}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--border-subtle)]">
              <Meter icon={Cpu} label="CPU" pct={live.cpu.usage} value={`${Math.round(live.cpu.usage)}%`}
                sub={`load ${live.cpu.load[0].toFixed(2)}${live.cpu.temp != null ? ` · ${Math.round(live.cpu.temp)}°C` : ''}`} history={hist.current.cpu} />
              <Meter icon={Microchip} label="GPU" pct={live.gpu?.util ?? 0} value={live.gpu?.util != null ? `${Math.round(live.gpu.util)}%` : '—'}
                sub={[live.gpu?.temp != null && `${Math.round(live.gpu.temp)}°C`, live.gpu?.power != null && `${live.gpu.power.toFixed(0)} W`].filter(Boolean).join(' · ') || '—'}
                history={hist.current.gpu} />
              <Meter icon={MemoryStick} label={tx('Unified memory')} pct={memPct} value={`${((live.memory.total - live.memory.available) / GB).toFixed(0)} GB`}
                sub={`of ${(live.memory.total / GB).toFixed(0)} GB · ${Math.round(memPct)}%`} history={hist.current.mem} warn={85} bad={95} />
              <Meter icon={HardDrive} label={tx('Disk')} pct={diskPct} value={`${(live.disk.used / 1e12).toFixed(2)} TB`}
                sub={`of ${(live.disk.total / 1e12).toFixed(1)} TB · ${((live.disk.total - live.disk.used) / 1e12).toFixed(2)} TB free`} warn={85} bad={95} />
            </div>

            <div className="grid sm:grid-cols-2 gap-4 px-4 py-3 border-t border-[var(--border-subtle)] text-[12px]">
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  {tx('Services')} {services && <span className="normal-case tracking-normal">· {down.length ? tx('{length} down', { length: down.length }) : tx('all up')}</span>}
                </h4>
                <ul className="flex flex-wrap gap-1.5">
                  {services ? Object.entries(services).map(([k, v]) => (
                    <li key={k} title={v.detail} className="flex items-center gap-1 h-6 px-2 rounded-md border border-[var(--border-subtle)] text-[11px]">
                      {v.ok ? <CheckCircle2 className="w-3 h-3" style={{ color: STATUS.good }} aria-label="up" /> : <XCircle className="w-3 h-3" style={{ color: STATUS.bad }} aria-label="down" />}
                      <span className={v.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}>{k}</span>
                      {!v.ok && <span className="text-[var(--text-muted)]">down</span>}
                    </li>
                  )) : <li className="text-[var(--text-muted)]">…</li>}
                </ul>
              </div>
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{tx('Models in memory')}</h4>
                {live.models.length ? (
                  <ul className="space-y-1">
                    {live.models.map(m => (
                      <li key={m.name} className="flex items-baseline gap-2">
                        <span className="font-mono text-[11.5px] truncate">{m.name}</span>
                        <span className="ml-auto tabular-nums text-[11px] text-[var(--text-muted)]">{m.size ? tx('{v0} GB', { v0: (m.size / GB).toFixed(1) }) : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[var(--text-muted)]">{tx('None loaded right now.')}</p>}
              </div>
            </div>
          </>
        )}
      </section>
    </CardFrame>
  );
}

function Meter({ icon: Icon, label, pct, value, sub, history, warn = 80, bad = 92 }: {
  icon: typeof Cpu; label: string; pct: number; value: string; sub: string; history?: number[]; warn?: number; bad?: number;
}) {
  const lv = level(pct, warn, bad);
  const W = 120, H = 24;
  const path = history && history.length > 1
    ? history.map((v, i) => `${i ? 'L' : 'M'}${(i / (HISTORY - 1)) * W},${H - (Math.min(100, v) / 100) * (H - 2) - 1}`).join('') : null;
  return (
    <div className="bg-[var(--bg-code)] px-4 py-3 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        <Icon className="w-3 h-3" />{label}
        {lv !== 'good' && <AlertTriangle className="w-3 h-3 ml-auto" style={{ color: STATUS[lv] }} aria-label={lv === 'bad' ? 'critical' : 'high'} />}
      </div>
      <div className="mt-1 text-[20px] leading-tight font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="text-[11px] text-[var(--text-muted)] tabular-nums truncate">{sub}</div>
      <div className="mt-2 h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={clsx('h-full rounded-full transition-[width] duration-500')} style={{ width: `${Math.min(100, pct)}%`, background: lv === 'good' ? 'var(--accent)' : STATUS[lv] }} />
      </div>
      {path && (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full h-6" preserveAspectRatio="none" aria-hidden>
          <path d={path} fill="none" stroke="var(--text-muted)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}
