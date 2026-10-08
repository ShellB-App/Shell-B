// ```status``` fence: {"title": "Pipeline", "items": [{"name": "Ollama", "state": "ok|warn|down|unknown", "detail": "…", "service": "ollama"}]}
// Items with a "service" key (ollama, searxng, nyx, orpheus, hermes, embeddings, sandbox, studio) are overlaid with live
// state from /api/status and refresh while the card is on screen. State is always spelled out, never colour alone.
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleHelp, CircleX, Activity, TriangleAlert, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { CardFrame, CardPending, list, obj, parseJson, text } from './CardFrame';
import type { CardProps } from './registry';

type State = 'ok' | 'warn' | 'down' | 'unknown';
const STATES: Record<State, { label: string; icon: LucideIcon; tone: string }> = {
  ok: { label: 'OK', icon: CheckCircle2, tone: 'text-emerald-400' },
  warn: { label: 'Degraded', icon: TriangleAlert, tone: 'text-amber-400' },
  down: { label: 'Down', icon: CircleX, tone: 'text-red-400' },
  unknown: { label: 'Unknown', icon: CircleHelp, tone: 'text-[var(--text-muted)]' },
};
const ALIAS: Record<string, State> = { up: 'ok', pass: 'ok', passed: 'ok', success: 'ok', healthy: 'ok', running: 'ok', degraded: 'warn', warning: 'warn', slow: 'warn', fail: 'down', failed: 'down', error: 'down', offline: 'down', stopped: 'down' };
const norm = (v: unknown): State => { const s = text(v).toLowerCase(); return s in STATES ? s as State : ALIAS[s] ?? 'unknown'; };

function parse(source: string) {
  const r = parseJson(source);
  const items = list(r?.items ?? r?.services).flatMap(i => {
    const o = obj(i), name = text(o?.name ?? o?.label);
    return o && name ? [{ name, state: norm(o.state ?? o.status), detail: text(o.detail ?? o.note) || undefined, service: text(o.service) || undefined }] : [];
  });
  return items.length ? { title: text(r?.title) || 'Status', items } : null;
}

export function StatusCard({ source, streaming }: CardProps) {
  const d = parse(source);
  const live = !!d?.items.some(i => i.service);
  const [svc, setSvc] = useState<Record<string, { ok: boolean }> | null>(null);
  useEffect(() => {
    if (!live || streaming) return;
    let stop = false;
    const tick = () => fetch('/api/status').then(r => r.json()).then(j => { if (!stop) setSvc(j.services ?? null); }).catch(() => { if (!stop) setSvc(null); });
    tick();
    const t = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(t); };
  }, [live, streaming]);
  if (!d) return <CardPending icon={Activity} streaming={streaming} waiting="Checking status…" broken="This status board couldn't be read." />;
  const items = d.items.map(i => (i.service && svc?.[i.service] ? { ...i, state: svc[i.service].ok ? 'ok' as State : 'down' as State } : i));
  const bad = items.filter(i => i.state === 'down').length, warn = items.filter(i => i.state === 'warn').length;
  const summary = bad ? `${bad} down` : warn ? `${warn} degraded` : items.every(i => i.state === 'ok') ? 'all OK' : '';
  return (
    <CardFrame icon={Activity} title={d.title} meta={[summary, live && svc ? 'live' : ''].filter(Boolean).join(' · ')}>
      <ul className="grid sm:grid-cols-2 divide-y sm:divide-y-0 divide-[var(--border-subtle)]">
        {items.map((it, i) => {
          const s = STATES[it.state], Icon = s.icon;
          return (
            <li key={i} className={clsx('flex items-center gap-2.5 px-3.5 py-2 text-[12.5px] sm:border-t sm:border-[var(--border-subtle)]', i < 2 && 'sm:border-t-0')}>
              <Icon className={clsx('w-4 h-4 shrink-0', s.tone)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-[var(--text-primary)] truncate">{it.name}</div>
                {it.detail && <div className="text-[11px] text-[var(--text-muted)] truncate">{it.detail}</div>}
              </div>
              <span className={clsx('text-[11px] font-semibold', s.tone)}>{s.label}</span>
            </li>
          );
        })}
      </ul>
    </CardFrame>
  );
}
