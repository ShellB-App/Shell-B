import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, Cpu, HardDrive, Server, Zap } from 'lucide-react';
import { req, fmtBytes } from '../api';
import { HealthCard } from './HealthCard';
import { t as tx } from '../i18n';

/** GET /api/system (server/sysinfo.py). */
interface SystemInfo {
  host: { hostname: string; os: string; kernel: string; arch: string; uptime: number; python: string; lan: string[]; tailscale: string | null; appUptime: number; dbSize: number | null };
  cpu: { model: string; cores: number; usage: number; load: number[]; temp: number | null };
  gpus: { name: string; driver: string; cuda: string | null; temp: number | null; util: number | null; power: number | null; clockMHz: number | null; memUsed: number | null; memTotal: number | null }[];
  memory: { total: number; available: number; swapTotal: number; swapFree: number };
  disks: { mount: string; device: string; fs: string; total: number; used: number; free: number }[];
  storage: { label: string; path: string; size: number | null; children?: { label: string; path: string; size: number | null }[] }[];
  docker: { rows: { type: string; size: string; reclaimable: string }[] } | null;
  at: number;
}

const H = 'text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2';
const card = 'p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';

function duration(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** A usage bar that turns amber past 80% and red past 92%. */
function Bar({ pct, className }: { pct: number; className?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={clsx('h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden', className)}>
      <div className={clsx('h-full rounded-full transition-all', p > 92 ? 'bg-red-400' : p > 80 ? 'bg-amber-400' : 'bg-[var(--accent)]')} style={{ width: `${p}%` }} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs py-0.5">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono text-right truncate">{value}</span>
    </div>
  );
}

/** Settings → System: the machine itself — storage, CPU, GPU, memory and host. Polls while it's on screen. */
export function SystemInfoPanel() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [err, setErr] = useState('');
  const [openData, setOpenData] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () => req<SystemInfo>('/api/system').then(d => { if (!stop) { setInfo(d); setErr(''); } }).catch(e => !stop && setErr(String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (!info) return <div className="text-xs text-[var(--text-muted)]">{err || tx('Reading system info…')}</div>;
  const { host, cpu, gpus, memory, disks, storage, docker } = info;
  const root = disks[0];
  const biggest = Math.max(1, ...storage.map(s => s.size ?? 0));
  const swapUsed = memory.swapTotal - memory.swapFree;

  return (
    <div className="space-y-5">
      <HealthCard />
      <div>
        <h3 className={clsx(H, 'flex items-center gap-1.5')}><HardDrive className="w-3.5 h-3.5" />{tx('Storage')}</h3>
        <div className="space-y-2">
          {disks.map(d => {
            const pct = (d.used / d.total) * 100;
            return (
              <div key={d.mount} className={card}>
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-sm font-medium">{d.mount === '/' ? tx('System disk') : d.mount}
                    <span className="ml-1.5 text-[11px] font-normal font-mono text-[var(--text-muted)]">{d.mount} · {d.device.replace('/dev/', '')} · {d.fs}</span></span>
                  <span className={clsx('text-sm font-semibold font-mono', pct > 92 ? 'text-red-400' : pct > 80 ? 'text-amber-400' : '')}>{tx('{free} free', { free: fmtBytes(d.free) })}</span>
                </div>
                <Bar pct={pct} />
                <div className="mt-1 text-[11px] font-mono text-[var(--text-muted)]">{tx('{v0} used of {v1} · {v2}%', { v0: fmtBytes(d.used), v1: fmtBytes(d.total), v2: pct.toFixed(0) })}</div>
              </div>
            );
          })}
        </div>

        <div className={clsx(card, 'mt-2')}>
          <div className="text-xs font-medium mb-2">{tx('What\'s using it')}{root ? <span className="font-normal text-[var(--text-muted)]"> {tx('· share of the {v0} used on {mount}', { v0: fmtBytes(root.used), mount: root.mount })}</span> : null}</div>
          <div className="space-y-1.5">
            {storage.map(s => (
              <div key={s.path}>
                <button className={clsx('w-full text-left', !s.children && 'cursor-default')} onClick={() => s.children && setOpenData(o => !o)} title={s.path}>
                  <div className="flex items-center gap-2 text-xs">
                    {s.children ? <ChevronRight className={clsx('w-3 h-3 transition', openData && 'rotate-90')} /> : <span className="w-3" />}
                    <span className="flex-1 truncate">{tx(s.label)}</span>
                    <span className="font-mono text-[var(--text-muted)]">{s.size == null ? '—' : fmtBytes(s.size)}</span>
                  </div>
                  <div className="ml-5 mt-0.5 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${((s.size ?? 0) / biggest) * 100}%` }} />
                  </div>
                </button>
                {s.children && openData && (
                  <div className="ml-5 mt-1.5 pl-2 border-l border-[var(--border-subtle)] space-y-0.5">
                    {s.children.map(c => (
                      <div key={c.path} className="flex items-center gap-2 text-[11px]" title={c.path}>
                        <span className="flex-1 truncate font-mono text-[var(--text-secondary)]">{tx(c.label)}</span>
                        <span className="font-mono text-[var(--text-muted)]">{c.size == null ? '—' : fmtBytes(c.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {docker && (
            <div className="mt-3 pt-2 border-t border-[var(--border-subtle)]">
              <div className="text-xs font-medium mb-1">{tx('Docker')}</div>
              {docker.rows.map(r => (
                <div key={r.type} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 text-[var(--text-secondary)]">{r.type}</span>
                  <span className="font-mono">{r.size}</span>
                  <span className="w-44 text-right font-mono text-[var(--text-muted)] whitespace-nowrap">{r.reclaimable} reclaimable</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className={card}>
          <h3 className={clsx(H, 'flex items-center gap-1.5')}><Cpu className="w-3.5 h-3.5" />CPU</h3>
          <div className="text-xs font-medium mb-1.5 truncate" title={cpu.model}>{cpu.model} · {cpu.cores} cores</div>
          <Bar pct={cpu.usage} />
          <div className="mt-1.5">
            <Stat label={tx('Usage')} value={`${cpu.usage.toFixed(0)}%`} />
            <Stat label={tx('Load (1 / 5 / 15 min)')} value={cpu.load.map(l => l.toFixed(2)).join(' / ')} />
            {cpu.temp != null && <Stat label={tx('Temperature')} value={`${cpu.temp.toFixed(0)} °C`} />}
          </div>
        </div>
        {gpus.map((g, i) => (
          <div key={i} className={card}>
            <h3 className={clsx(H, 'flex items-center gap-1.5')}><Zap className="w-3.5 h-3.5" />GPU</h3>
            <div className="text-xs font-medium mb-1.5">{g.name}</div>
            <Bar pct={g.util ?? 0} />
            <div className="mt-1.5">
              <Stat label={tx('Utilization')} value={g.util == null ? '—' : `${g.util.toFixed(0)}%`} />
              {g.temp != null && <Stat label={tx('Temperature')} value={`${g.temp.toFixed(0)} °C`} />}
              {g.power != null && <Stat label={tx('Power')} value={`${g.power.toFixed(1)} W`} />}
              {g.clockMHz != null && <Stat label={tx('Clock')} value={`${g.clockMHz.toFixed(0)} MHz`} />}
              <Stat label={tx('Memory')} value={g.memTotal ? `${fmtBytes(g.memUsed ?? 0)} / ${fmtBytes(g.memTotal)}` : 'Unified with system memory'} />
              <Stat label={tx('Driver · CUDA')} value={`${g.driver}${g.cuda ? ` · ${g.cuda}` : ''}`} />
            </div>
          </div>
        ))}
        <div className={card}>
          <h3 className={H}>{tx('Memory')}</h3>
          <Bar pct={((memory.total - memory.available) / memory.total) * 100} />
          <div className="mt-1.5">
            <Stat label={tx('Used')} value={`${fmtBytes(memory.total - memory.available)} of ${fmtBytes(memory.total)}`} />
            <Stat label={tx('Available')} value={fmtBytes(memory.available)} />
            {memory.swapTotal > 0 && <Stat label={tx('Swap')} value={`${fmtBytes(swapUsed)} of ${fmtBytes(memory.swapTotal)}`} />}
          </div>
        </div>
        <div className={card}>
          <h3 className={clsx(H, 'flex items-center gap-1.5')}><Server className="w-3.5 h-3.5" />{tx('Host')}</h3>
          <Stat label={tx('Name')} value={host.hostname} />
          <Stat label={tx('System')} value={host.os} />
          <Stat label={tx('Kernel')} value={`${host.kernel} · ${host.arch}`} />
          <Stat label={tx('Up')} value={duration(host.uptime)} />
          {host.lan.length > 0 && <Stat label="LAN" value={host.lan.join(', ')} />}
          {host.tailscale && <Stat label={tx('Tailscale')} value={host.tailscale} />}
          <Stat label={tx('Shell:B Web up')} value={duration(host.appUptime)} />
          {host.dbSize != null && <Stat label={tx('Database')} value={fmtBytes(host.dbSize)} />}
          <Stat label={tx('Python')} value={host.python} />
        </div>
      </div>
    </div>
  );
}
