import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { HeartPulse } from 'lucide-react';
import { req } from '../api';
import { relTime } from './common';
import { t as tx } from '../i18n';

/** GET /api/watchdog (server/watchdog.py). */
interface WatchdogStatus {
  lastRun: number | null;
  graceUntil: number;
  incidents: { key: string; title: string; status: string; since: number }[];
}

/** Settings → System: what the health watchdog currently considers wrong. Alerts themselves go to Activity. */
export function HealthCard() {
  const [data, setData] = useState<WatchdogStatus | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => req<WatchdogStatus>('/api/watchdog').then(d => { if (!stop) setData(d); }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  if (!data) return null;
  const n = data.incidents.length;
  const note = !data.lastRun ? 'First check runs shortly after startup'
    : tx('Checked {when} · services, crash loops, disk and memory every minute', { when: relTime(data.lastRun) });

  return (
    <div className={clsx('p-3 rounded-lg border bg-[var(--bg-secondary)]', n ? 'border-red-500/40' : 'border-[var(--border-subtle)]')}>
      <div className="flex items-center gap-2">
        <HeartPulse className={clsx('w-4 h-4 shrink-0', n ? 'text-red-400' : 'text-emerald-400')} />
        <span className="text-sm font-medium">{n ? tx('{n} open health {v0}', { n: n, v0: n === 1 ? 'problem' : 'problems' }) : tx('Everything looks healthy')}</span>
        <a href="#/activity" className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:underline">{tx('Alerts in Activity →')}</a>
      </div>
      {n > 0 && (
        <ul className="mt-2 space-y-1">
          {data.incidents.map(i => (
            <li key={i.key} className="flex items-baseline gap-2 text-xs">
              <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px]', i.status === 'warning' ? 'bg-amber-400' : 'bg-red-400')} />
              <span className="flex-1">{tx(i.title)}</span>
              <span className="font-mono text-[11px] text-[var(--text-muted)]">{relTime(i.since)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{note}</div>
    </div>
  );
}
