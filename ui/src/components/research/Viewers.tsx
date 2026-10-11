import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  BookmarkPlus, Check, ChevronLeft, ChevronRight, Copy, Download, Maximize2, Minimize2, Pause, Play, RotateCcw, Shuffle,
  SkipBack, SkipForward,
} from 'lucide-react';
import type { MindNode, ResearchItem, StudioType } from '../../types';
import { btn } from '../common';
import { NbMarkdown, SourceCite, fmtDuration, useNotebook } from './shared';
import { t as tx } from '../../i18n';

const srcNum = (s?: string) => { const m = /\d+/.exec(s ?? ''); return m ? Number(m[0]) : null; };

// ── reports (briefing, study guide, FAQ, timeline, report) ─────────────────

function ReportView({ it }: { it: ResearchItem }) {
  const { saveNote } = useNotebook();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`# ${it.title}\n\n${it.body}`], { type: 'text/markdown' }));
    a.download = `${it.title.replace(/[^\w-]+/g, '-').toLowerCase()}.md`;
    a.click();
  };
  return (
    <div className="max-w-3xl mx-auto px-5 sm:px-8 py-6">
      <div className="flex flex-wrap gap-1.5 mb-5">
        <button className={btn.subtle} onClick={() => { navigator.clipboard.writeText(it.body); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}{tx('Copy')}
        </button>
        <button className={btn.subtle} onClick={download}><Download className="w-3.5 h-3.5" />{tx('Markdown')}</button>
        <button className={btn.subtle} disabled={saved} onClick={async () => { await saveNote(it.title, it.body); setSaved(true); }}>
          {saved ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <BookmarkPlus className="w-3.5 h-3.5" />}{saved ? tx('Saved to notes') : tx('Save to note')}
        </button>
      </div>
      <NbMarkdown text={it.body} />
    </div>
  );
}

// ── mind map ───────────────────────────────────────────────────────────────

const BRANCH = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#0891b2'];

function MindBranch({ node, path, depth, color, open, toggle, onAsk }: {
  node: MindNode; path: string; depth: number; color: string; open: Set<string>; toggle: (p: string) => void; onAsk: (trail: string) => void;
}) {
  const kids = node.children ?? [];
  const expanded = open.has(path);
  return (
    <div className="flex items-center">
      <div className="flex items-center shrink-0">
        <button onClick={() => onAsk(path)} title={tx('Ask about this in chat')}
          className={clsx('max-w-[15rem] text-left px-3 py-1.5 rounded-xl border text-[13px] leading-snug transition hover:shadow-md',
            depth === 0 ? 'font-semibold text-white border-transparent text-[14px] px-4 py-2' : 'bg-[var(--bg-primary)] hover:bg-[var(--bg-secondary)]')}
          style={depth === 0 ? { background: 'linear-gradient(135deg, #059669, #0f766e)' } : { borderColor: `${color}66`, boxShadow: `inset 3px 0 0 ${color}` }}>
          {tx(node.label)}
        </button>
        {kids.length > 0 && (
          <button onClick={() => toggle(path)} aria-label={expanded ? tx('Collapse') : tx('Expand')}
            className="ml-1 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0 hover:scale-110 transition"
            style={{ background: color }}>
            {expanded ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>
      {expanded && kids.length > 0 && (
        <div className="relative flex flex-col gap-2 py-1 pl-7 ml-0">
          {/* connectors: a spine and a tick to each child */}
          <span className="absolute left-3 top-4 bottom-4 border-l-2 rounded" style={{ borderColor: `${color}55` }} aria-hidden />
          {kids.map((k, i) => (
            <div key={i} className="relative">
              <span className="absolute -left-4 top-1/2 w-4 border-t-2" style={{ borderColor: `${color}55` }} aria-hidden />
              <MindBranch node={k} path={`${path}›${k.label}`} depth={depth + 1} color={depth === 0 ? BRANCH[i % BRANCH.length] : color}
                open={open} toggle={toggle} onAsk={onAsk} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MindMapView({ it }: { it: ResearchItem }) {
  const { ask } = useNotebook();
  const root: MindNode = { label: it.meta.data?.label || 'Mind map', children: it.meta.data?.children ?? [] };
  const allPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (n: MindNode, p: string) => { if (n.children?.length) { out.push(p); n.children.forEach(k => walk(k, `${p}›${k.label}`)); } };
    walk(root, root.label);
    return out;
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState(() => new Set([root.label]));
  const toggle = (p: string) => setOpen(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-1.5 px-4 py-2 border-b border-[var(--border-subtle)]">
        <button className={btn.subtle} onClick={() => setOpen(new Set(allPaths))}><Maximize2 className="w-3.5 h-3.5" />{tx('Expand all')}</button>
        <button className={btn.subtle} onClick={() => setOpen(new Set([root.label]))}><Minimize2 className="w-3.5 h-3.5" />{tx('Collapse')}</button>
        <span className="ml-auto text-[11px] text-[var(--text-muted)] hidden sm:inline">{tx('Click a topic to ask about it in chat')}</span>
      </div>
      <div className="flex-1 overflow-auto p-6 sm:p-10">
        <MindBranch node={root} path={root.label} depth={0} color="#0d9488" open={open} toggle={toggle}
          onAsk={trail => ask(`Discuss what these sources say about ${trail.split('›').slice(-1)[0]}${trail.includes('›') ? `, in the context of ${trail.split('›').slice(0, -1).join(' › ')}` : ''}.`)} />
      </div>
    </div>
  );
}

// ── flashcards ─────────────────────────────────────────────────────────────

function FlashcardsView({ it }: { it: ResearchItem }) {
  const base = it.meta.data?.cards ?? [];
  const [order, setOrder] = useState(() => base.map((_, i) => i));
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  const card = base[order[i]];
  const go = (n: number) => { setFlip(false); setI(x => Math.min(base.length - 1, Math.max(0, x + n))); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea')) return;
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ') { e.preventDefault(); setFlip(f => !f); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!card) return <p className="p-8 text-sm text-[var(--text-muted)]">{tx('No cards.')}</p>;
  const ref = srcNum(card.source);
  return (
    <div className="h-full flex flex-col items-center justify-center px-4 py-8 gap-6">
      <div className="text-[12px] text-[var(--text-muted)] tabular-nums">{i + 1} / {base.length}</div>
      <button onClick={() => setFlip(f => !f)} className="w-full max-w-xl aspect-[3/2] [perspective:1400px]" aria-label={tx('Flip card')}>
        <div className={clsx('relative w-full h-full transition-transform duration-500 [transform-style:preserve-3d]', flip && '[transform:rotateY(180deg)]')}>
          <div className="absolute inset-0 [backface-visibility:hidden] rounded-3xl p-8 flex items-center justify-center text-center text-white shadow-xl"
            style={{ background: 'linear-gradient(135deg, #0f766e, #134e4a)' }}>
            <span className="text-xl sm:text-2xl font-semibold leading-snug">{card.front}</span>
            <span className="absolute bottom-4 left-0 right-0 text-[11px] text-white/60">{tx('Click or press space to see the answer')}</span>
          </div>
          <div className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)] rounded-3xl p-8 flex flex-col items-center justify-center text-center border-2 border-teal-600/40 bg-[var(--bg-secondary)] shadow-xl">
            <span className="text-lg sm:text-xl leading-relaxed">{card.back}</span>
            {ref && <span className="mt-4 text-[11px] text-[var(--text-muted)]">{tx('Source')} <SourceCite n={ref} /></span>}
          </div>
        </div>
      </button>
      <div className="flex items-center gap-2">
        <button className={btn.subtle} onClick={() => go(-1)} disabled={i === 0}><ChevronLeft className="w-4 h-4" /></button>
        <button className={btn.subtle} onClick={() => { setOrder(o => [...o].sort(() => Math.random() - 0.5)); setI(0); setFlip(false); }}><Shuffle className="w-3.5 h-3.5" />{tx('Shuffle')}</button>
        <button className={btn.subtle} onClick={() => go(1)} disabled={i === base.length - 1}><ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

// ── quiz ───────────────────────────────────────────────────────────────────

function QuizView({ it }: { it: ResearchItem }) {
  const qs = (it.meta.data?.questions ?? []).filter(q => q.options?.length >= 2);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const done = Object.keys(answers).length;
  const score = qs.reduce((n, q, i) => n + (answers[i] === q.answer ? 1 : 0), 0);
  return (
    <div className="max-w-2xl mx-auto px-5 py-6 space-y-5">
      <div className="flex items-center gap-3 sticky top-0 py-2 bg-[var(--bg-primary)] z-10">
        <div className="flex-1 h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
          <div className="h-full bg-teal-500 transition-all" style={{ width: `${(done / Math.max(qs.length, 1)) * 100}%` }} />
        </div>
        <span className="text-[12px] tabular-nums text-[var(--text-secondary)]">{done === qs.length ? tx('Score {score}/{length}', { score: score, length: qs.length }) : `${done}/${qs.length}`}</span>
        {done > 0 && <button className={btn.ghost} onClick={() => setAnswers({})}><RotateCcw className="w-3.5 h-3.5" />{tx('Retake')}</button>}
      </div>
      {qs.map((q, i) => {
        const picked = answers[i];
        const ref = srcNum(q.source);
        return (
          <div key={i} className="p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <p className="text-[14.5px] font-medium leading-snug"><span className="text-[var(--text-muted)] mr-1.5">{i + 1}.</span>{q.question}</p>
            <div className="mt-3 space-y-1.5">
              {q.options.map((o, j) => {
                const show = picked !== undefined;
                const right = j === q.answer;
                return (
                  <button key={j} disabled={show} onClick={() => setAnswers(a => ({ ...a, [i]: j }))}
                    className={clsx('w-full text-left px-3 py-2 rounded-xl border text-[13.5px] transition flex items-center gap-2.5',
                      !show && 'border-[var(--border-subtle)] hover:border-teal-500/60 hover:bg-[var(--bg-primary)]',
                      show && right && 'border-emerald-500 bg-emerald-500/10',
                      show && !right && picked === j && 'border-rose-500 bg-rose-500/10',
                      show && !right && picked !== j && 'border-[var(--border-subtle)] opacity-60')}>
                    <span className={clsx('w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-semibold shrink-0',
                      show && right ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-[var(--border-strong)]')}>{String.fromCharCode(65 + j)}</span>
                    {o}
                  </button>
                );
              })}
            </div>
            {picked !== undefined && (
              <p className={clsx('mt-3 text-[13px] leading-relaxed', picked === q.answer ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-secondary)]')}>
                <strong>{picked === q.answer ? 'Correct. ' : tx('Not quite. ')}</strong>{q.explanation}{ref ? <> <SourceCite n={ref} /></> : null}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── audio overview ─────────────────────────────────────────────────────────

const HOSTS = { A: { name: 'Alex', color: '#0d9488' }, B: { name: 'Sam', color: '#7c3aed' } };

function AudioView({ it }: { it: ResearchItem }) {
  const { d } = useNotebook();
  const audio = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(it.meta.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const lines = it.meta.transcript ?? [];
  const marks = it.meta.marks ?? [];
  const cur = marks.length ? Math.max(0, marks.findIndex((m, i) => t >= m && (i + 1 >= marks.length || t < marks[i + 1]))) : -1;
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { if (playing) lineRefs.current[cur]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [cur, playing]);
  const src = `/api/research/${d.id}/outputs/${it.id}/audio`;
  const seek = (s: number) => { if (audio.current) { audio.current.currentTime = Math.max(0, s); audio.current.play(); } };
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 p-5 sm:p-6 border-b border-[var(--border-subtle)]" style={{ background: 'linear-gradient(135deg, rgba(13,148,136,0.12), rgba(124,58,237,0.08))' }}>
        <audio ref={audio} src={src} preload="metadata" onTimeUpdate={e => setT(e.currentTarget.currentTime)}
          onLoadedMetadata={e => setDur(e.currentTarget.duration || dur)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
        <div className="flex items-center gap-3">
          <button onClick={() => (playing ? audio.current?.pause() : audio.current?.play())} aria-label={playing ? tx('Pause') : tx('Play')}
            className="w-12 h-12 rounded-full bg-teal-600 text-white flex items-center justify-center shadow-lg hover:brightness-110 transition shrink-0">
            {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
          </button>
          <div className="flex-1 min-w-0">
            <input type="range" min={0} max={dur || 1} step={0.1} value={t} onChange={e => seek(Number(e.target.value))}
              className="w-full accent-teal-600" aria-label={tx('Position')} />
            <div className="flex items-center justify-between text-[11px] tabular-nums text-[var(--text-muted)]">
              <span>{fmtDuration(t)}</span>
              <span className="flex items-center gap-1">
                <button className={clsx(btn.icon, 'p-1')} onClick={() => seek(t - 10)} aria-label={tx('Back 10 seconds')}><SkipBack className="w-3.5 h-3.5" /></button>
                <button className="px-1.5 rounded hover:bg-[var(--bg-hover)] font-medium" onClick={() => {
                  const next = rate >= 2 ? 1 : rate + 0.25; setRate(next); if (audio.current) audio.current.playbackRate = next;
                }}>{rate}×</button>
                <button className={clsx(btn.icon, 'p-1')} onClick={() => seek(t + 10)} aria-label={tx('Forward 10 seconds')}><SkipForward className="w-3.5 h-3.5" /></button>
                <a className={clsx(btn.icon, 'p-1')} href={src} download aria-label={tx('Download')}><Download className="w-3.5 h-3.5" /></a>
              </span>
              <span>{fmtDuration(dur)}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-1">
        {lines.map((ln, i) => {
          const h = HOSTS[ln.speaker] ?? HOSTS.A;
          return (
            <button key={i} ref={el => { lineRefs.current[i] = el; }} onClick={() => marks[i] !== undefined && seek(marks[i])}
              className={clsx('w-full text-left flex gap-3 px-3 py-2 rounded-xl transition', i === cur && playing ? 'bg-teal-500/10' : 'hover:bg-[var(--bg-secondary)]')}>
              <span className="w-10 shrink-0 text-[11px] font-semibold pt-0.5" style={{ color: h.color }}>{h.name}</span>
              <span className={clsx('text-[13.5px] leading-relaxed', i === cur && playing ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>{tx(ln.text)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function OutputBody({ it }: { it: ResearchItem }) {
  const type = it.meta.type as unknown as StudioType;
  if (type === 'audio') return <AudioView it={it} />;
  if (type === 'mindmap') return <MindMapView it={it} />;
  if (type === 'flashcards') return <div className="h-full overflow-y-auto"><FlashcardsView it={it} /></div>;
  if (type === 'quiz') return <div className="h-full overflow-y-auto"><QuizView it={it} /></div>;
  return <div className="h-full overflow-y-auto"><ReportView it={it} /></div>;
}

