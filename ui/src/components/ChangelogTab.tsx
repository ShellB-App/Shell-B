import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api } from '../api';
import type { ChangelogEntry } from '../types';

const fmtDay = (d: string) => {
  const t = new Date(`${d}T12:00:00`);
  return isNaN(+t) ? d : t.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

export function ChangelogTab() {
  const [entries, setEntries] = useState<ChangelogEntry[]>();
  const [error, setError] = useState('');
  const [area, setArea] = useState('');

  useEffect(() => {
    api.changelog().then(r => { setEntries(r.entries); setError(r.error); }).catch(e => { setEntries([]); setError(String(e)); });
  }, []);

  const areas = useMemo(() => [...new Set((entries ?? []).map(e => e.area).filter(Boolean))].sort(), [entries]);
  const days = useMemo(() => {
    const out: [string, ChangelogEntry[]][] = [];
    for (const e of entries ?? []) {
      if (area && e.area !== area) continue;
      const last = out[out.length - 1];
      if (last && last[0] === e.date) last[1].push(e); else out.push([e.date, [e]]);
    }
    return out;
  }, [entries, area]);

  return (
    <div className="max-w-[65ch] space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">Changelog</h2>
        <p className="text-[12.5px] text-[var(--text-secondary)] mt-0.5">
          Features as they shipped, newest first. Kept in <code>docs/changelog.json</code>; add an entry when you ship something.
        </p>
      </div>
      {areas.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {['', ...areas].map(a => (
            <button key={a || 'all'} onClick={() => setArea(a)}
              className={clsx('px-2 py-0.5 rounded-full text-[11.5px] border transition',
                area === a ? 'bg-[var(--bg-hover)] border-[var(--border-subtle)] text-[var(--text-primary)] font-medium' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]')}>
              {a || 'All'}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-[12.5px] text-rose-400">Couldn't read the changelog: {error}</p>}
      {!entries && <p className="text-[12.5px] text-[var(--text-secondary)]">Loading…</p>}
      {entries && !error && !days.length && <p className="text-[12.5px] text-[var(--text-secondary)]">No entries yet.</p>}
      {days.map(([day, list]) => (
        <section key={day}>
          <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">{fmtDay(day)}</h3>
          <ul className="border-l border-[var(--border-subtle)] ml-1 space-y-2.5">
            {list.map((e, i) => (
              <li key={i} className="pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{e.title}</span>
                  {e.area && <span className="text-[10.5px] tracking-wider uppercase text-[var(--text-secondary)]">{e.area}</span>}
                </div>
                {e.summary && <p className="text-[12.5px] text-[var(--text-secondary)] leading-relaxed">{e.summary}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
