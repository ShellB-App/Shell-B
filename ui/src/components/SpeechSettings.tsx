import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AudioLines, Check, ChevronDown, ChevronRight, Copy, FileAudio, Loader2, Play, RotateCcw, Sparkles, Square, Trash2,
  Lock, Plus, Upload, Volume2, Wand2, Waypoints,
} from 'lucide-react';
import { api } from '../api';
import { lexicon, readAloud, voiceLib, type FxParam, type LexiconEntry, type LibraryVoice, type ReadState, type RvcModel, type RvcSettings } from '../speech';
import type { Settings, TtsVoice } from '../types';
import { btn } from './common';

// Settings → Speech: the reading voice (voice, speed, tone) and the voice library — Qwen3-TTS voices designed from a
// description or cloned from audio clips, each with its own delivery and effects chain (hermes/qwen/server.py, fx.py).
// Clips uploaded to a voice are kept with it, as training data for fine-tuning later.

const SAMPLE = "Hi, I'm Shell:B. Here's how I'll sound when I read replies aloud, or talk with you in voice mode.";
const TEST_LINE = 'Hello. This is how I sound now. Did that come out the way you wanted?';
const IDEAS = [
  'A warm, bright young woman with a light Scottish accent, cheerful and quick-witted.',
  'An elegant older Englishwoman, precise and dry, like a museum curator who has seen everything.',
  'A hyperactive little robot with a high, squeaky, overexcited voice that never stops talking.',
];

type Save = (patch: Partial<Settings>) => void;

let player: HTMLAudioElement | null = null;
/** plays a URL or blob, stopping whatever this tab played before */
function play(src: string | Blob) {
  player?.pause();
  player = new Audio(typeof src === 'string' ? src : URL.createObjectURL(src));
  player.play().catch(() => {});
}

function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-end justify-between gap-2 mb-2">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block mb-2.5">
      <span className="text-xs font-medium">{label}</span>
      {hint && <span className="text-[11px] text-[var(--text-muted)] ml-2">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 240);

export function SpeechTab({ settings, onSaved }: { settings?: Settings; onSaved: () => void }) {
  const [reload, setReload] = useState(0);
  if (!settings) return null;
  const save: Save = async patch => { await api.saveSettings(patch); onSaved(); };
  return (
    <div>
      <ReadingVoice settings={settings} save={save} reload={reload} />
      <Pronunciation />
      <VoiceLibrary settings={settings} save={save} onChanged={() => setReload(n => n + 1)} />
    </div>
  );
}

// ── reading voice ───────────────────────────────────────────────────────────

function ReadingVoice({ settings, save, reload }: { settings: Settings; save: Save; reload: number }) {
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [groups, setGroups] = useState<{ id: string; label: string }[]>([]);
  const [state, setState] = useState<ReadState>('idle');
  const stop = useRef<(() => void) | null>(null);
  const [speed, setSpeed] = useState(settings.ttsSpeed ?? 1);
  const [style, setStyle] = useState(settings.ttsStyle ?? '');
  useEffect(() => setSpeed(settings.ttsSpeed ?? 1), [settings.ttsSpeed]);
  useEffect(() => setStyle(settings.ttsStyle ?? ''), [settings.ttsStyle]);
  useEffect(() => {
    api.voices().then(v => {
      setVoices(v.details ?? v.voices.map(id => ({ id, label: id, engine: 'kokoro' })));
      setGroups(v.engines ?? [{ id: 'kokoro', label: 'Kokoro' }]);
    }).catch(() => setVoices([]));
  }, [reload]);
  useEffect(() => () => stop.current?.(), []);

  /** toggles the sample; `restart` plays it again with new settings instead of stopping */
  const preview = (voice = settings.ttsVoice, s = speed, st = style, restart = false) => {
    if (state !== 'idle' && !restart) { stop.current?.(); return; }
    stop.current = readAloud(SAMPLE, setState, { voice, speed: s, style: st });
  };
  const known = voices.some(v => v.id === settings.ttsVoice);
  const expressive = settings.ttsVoice.startsWith('qwen:');

  return (
    <Section title="Reading voice" hint="Used for read-aloud and voice mode">
      <Field label="Voice">
        <div className="flex items-center gap-2">
          <select className={btn.input} value={settings.ttsVoice} disabled={!voices.length}
            onChange={e => { save({ ttsVoice: e.target.value }); preview(e.target.value, speed, style, true); }}>
            {!known && <option value={settings.ttsVoice}>{settings.ttsVoice}</option>}
            {groups.map(g => {
              const vs = voices.filter(v => v.engine === g.id);
              return vs.length ? <optgroup key={g.id} label={g.label}>{vs.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</optgroup> : null;
            })}
          </select>
          <button className={btn.icon} title={state === 'idle' ? 'Preview' : 'Stop'} onClick={() => preview()}>
            {state === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : state === 'playing' ? <Square className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </Field>
      {expressive && (
        <Field label="Tone" hint="in your words; a library voice with its own delivery ignores this">
          <input className={btn.input} value={style} placeholder="Warm, natural and conversational."
            onChange={e => setStyle(e.target.value)}
            onBlur={() => style !== (settings.ttsStyle ?? '') && save({ ttsStyle: style })}
            onKeyDown={e => { if (e.key === 'Enter') { save({ ttsStyle: style }); preview(settings.ttsVoice, speed, style, true); } }} />
        </Field>
      )}
      <Field label="Speed" hint={expressive ? 'expressive voices only roughly follow this' : undefined}>
        <div className="flex items-center gap-2">
          <input type="range" min={0.7} max={1.5} step={0.05} value={speed} className="w-48 accent-[var(--accent)]"
            onChange={e => setSpeed(Number(e.target.value))}
            onPointerUp={() => { save({ ttsSpeed: speed }); preview(settings.ttsVoice, speed, style, true); }}
            onKeyUp={() => save({ ttsSpeed: speed })} />
          <span className="text-xs tabular-nums">{speed.toFixed(2)}×</span>
        </div>
      </Field>
      {expressive && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Expressive voices take about 5 s per sentence; the first one after 20 idle minutes loads the model (about 30 s).
        </p>
      )}
    </Section>
  );
}

// ── pronunciation ───────────────────────────────────────────────────────────

function Pronunciation() {
  const [builtin, setBuiltin] = useState<LexiconEntry[]>([]);
  const [rows, setRows] = useState<LexiconEntry[]>([]);
  const [saved, setSaved] = useState('[]');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState("Hi, I'm Shell:B. Shell:B's memory is in Settings.");
  const [heard, setHeard] = useState('');
  const [state, setState] = useState<ReadState>('idle');
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    lexicon.get().then(r => { setBuiltin(r.builtin); setRows(r.entries); setSaved(JSON.stringify(r.entries)); }).catch(e => setError(errText(e)));
    return () => stop.current?.();
  }, []);
  const dirty = JSON.stringify(rows) !== saved;
  const setRow = (i: number, patch: Partial<LexiconEntry>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await lexicon.save(rows.filter(r => r.from.trim()));
      setRows(r.entries); setSaved(JSON.stringify(r.entries));
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const say = (text: string) => {
    if (state !== 'idle') { stop.current?.(); return; }
    stop.current = readAloud(text, setState);
  };
  const check = async () => { try { setHeard((await lexicon.apply(trial)).text); } catch (e) { setError(errText(e)); } };

  return (
    <Section title="Pronunciation" hint="Words every voice says your way. Applied before speaking, for every voice and engine.">
      <div className="space-y-1">
        {builtin.map(b => (
          <div key={b.from} className="flex items-center gap-2 text-xs">
            <span className="w-44 shrink-0 truncate px-2.5 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-muted)]" title={b.from}>{b.note ?? b.from}</span>
            <span className="text-[var(--text-muted)]">→</span>
            <span className="flex-1 px-2.5 py-1.5 rounded-lg bg-[var(--bg-tertiary)]">{b.to}</span>
            <span title="Built in"><Lock className="w-3.5 h-3.5 text-[var(--text-muted)]" /></span>
          </div>
        ))}
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className={clsx(btn.input, 'w-44 shrink-0')} value={r.from} placeholder="Word or name" onChange={e => setRow(i, { from: e.target.value })} />
            <span className="text-[var(--text-muted)] text-xs">→</span>
            <input className={btn.input} value={r.to} placeholder="How to say it (spell it out)" onChange={e => setRow(i, { to: e.target.value })} />
            <button className={btn.icon} title="Hear it" disabled={!r.to.trim()} onClick={() => say(r.to)}><Volume2 className="w-3.5 h-3.5" /></button>
            <button className={btn.icon} title="Remove" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button className={btn.ghost} onClick={() => setRows(rs => [...rs, { from: '', to: '' }])}><Plus className="w-3.5 h-3.5" />Add word</button>
        <button className={btn.primary} disabled={!dirty || busy} onClick={save}>{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Save</button>
        {dirty && <button className={btn.ghost} onClick={() => setRows(JSON.parse(saved))}><RotateCcw className="w-3.5 h-3.5" />Revert</button>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <Field label="Try it" hint="what the voices will actually read">
        <div className="flex items-center gap-2">
          <input className={btn.input} value={trial} onChange={e => { setTrial(e.target.value); setHeard(''); }} onKeyDown={e => e.key === 'Enter' && check()} />
          <button className={btn.subtle} onClick={check}>Show</button>
          <button className={btn.icon} title="Hear it in the reading voice" onClick={() => say(trial)}>
            {state === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : state === 'playing' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </Field>
      {heard && <p className="text-xs -mt-1"><span className="text-[var(--text-muted)]">Reads: </span>{heard}</p>}
      {dirty && <p className="text-[11px] text-amber-400">Unsaved: “Try it” and “Hear it” use the saved list.</p>}
    </Section>
  );
}

// ── library ─────────────────────────────────────────────────────────────────

function VoiceLibrary({ settings, save, onChanged }: { settings: Settings; save: Save; onChanged: () => void }) {
  const [voices, setVoices] = useState<LibraryVoice[] | null>(null);
  const [fxInfo, setFxInfo] = useState<{ params: FxParam[]; presets: Record<string, Record<string, number>> }>();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<'' | 'design' | 'samples' | 'rvc'>('');
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [rvcModels, setRvcModels] = useState<RvcModel[]>([]);
  const load = () => {
    voiceLib.list().then(setVoices).catch(e => { setVoices([]); setError(errText(e)); });
    voiceLib.rvcModels().then(r => setRvcModels(r.models)).catch(() => setRvcModels([]));
  };
  useEffect(() => { load(); voiceLib.fx().then(setFxInfo).catch(() => {}); voiceLib.presets().then(setPresets).catch(() => {}); }, []);
  // voices an RVC voice can speak through: your own non-RVC voices, then Qwen's presets
  const bases = [...(voices ?? []).filter(v => v.source !== 'rvc').map(v => ({ id: v.id, label: v.label })), ...presets];
  const changed = (id?: string) => { load(); onChanged(); if (id) setOpen(id); };

  const remove = async (v: LibraryVoice) => {
    if (!confirm(`Delete "${v.label}"? Its reference clip and ${v.samples.length} sample(s) are deleted too.`)) return;
    await voiceLib.remove(v.id);
    if (settings.ttsVoice === `qwen:${v.id}`) save({ ttsVoice: 'bf_isabella' });
    changed();
  };

  return (
    <Section title="Voice library"
      hint="Expressive voices you've designed, cloned from clips, or built on an RVC model. Clips you upload stay with the voice, for training it further later."
      right={
        <div className="flex gap-1.5 shrink-0">
          <button className={btn.subtle} onClick={() => setCreating(c => (c === 'design' ? '' : 'design'))}><Wand2 className="w-3.5 h-3.5" />Describe</button>
          <button className={btn.subtle} onClick={() => setCreating(c => (c === 'samples' ? '' : 'samples'))}><Upload className="w-3.5 h-3.5" />From clips</button>
          <button className={btn.subtle} onClick={() => setCreating(c => (c === 'rvc' ? '' : 'rvc'))}><Waypoints className="w-3.5 h-3.5" />RVC model</button>
        </div>
      }>
      {creating === 'design' && <DesignNew fxInfo={fxInfo} onDone={id => { setCreating(''); if (id) changed(id); }} />}
      {creating === 'samples' && <SamplesNew onDone={id => { setCreating(''); if (id) changed(id); }} />}
      {creating === 'rvc' && <RvcNew models={rvcModels} bases={bases} onModels={load} onDone={id => { setCreating(''); if (id) changed(id); }} />}
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
      {voices === null ? <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" /> : !voices.length ? (
        <p className="text-xs text-[var(--text-muted)]">No voices yet. Describe one, or clone one from a few clean clips.</p>
      ) : (
        <div className="space-y-1.5">
          {voices.map(v => (
            <VoiceCard key={v.id} v={v} fxInfo={fxInfo} bases={bases} models={rvcModels} active={settings.ttsVoice === `qwen:${v.id}`} expanded={open === v.id}
              onToggle={() => setOpen(o => (o === v.id ? null : v.id))}
              onUse={() => save({ ttsVoice: `qwen:${v.id}` })}
              onDuplicate={async () => changed((await voiceLib.duplicate(v.id)).id)}
              onDelete={() => remove(v)} onChanged={() => changed()} />
          ))}
        </div>
      )}
    </Section>
  );
}

type Base = { id: string; label: string };

function VoiceCard({ v, fxInfo, bases, models, active, expanded, onToggle, onUse, onDuplicate, onDelete, onChanged }: {
  v: LibraryVoice; fxInfo?: { params: FxParam[]; presets: Record<string, Record<string, number>> }; bases: Base[]; models: RvcModel[];
  active: boolean; expanded: boolean; onToggle: () => void; onUse: () => void; onDuplicate: () => void; onDelete: () => void; onChanged: () => void;
}) {
  const hasFx = Object.keys(v.fx).length > 0;
  return (
    <div className={clsx('rounded-lg border', active ? 'border-[var(--accent)]/60' : 'border-[var(--border-subtle)]', 'bg-[var(--bg-secondary)]')}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button className="flex items-center gap-1.5 flex-1 min-w-0 text-left" onClick={onToggle}>
          {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
          {v.source === 'samples' ? <FileAudio className="w-4 h-4 shrink-0 text-sky-400" />
            : v.source === 'rvc' ? <Waypoints className="w-4 h-4 shrink-0 text-amber-400" /> : <Sparkles className="w-4 h-4 shrink-0 text-violet-400" />}
          <span className="text-sm font-medium truncate">{v.label}</span>
          {v.source !== 'rvc' && v.rvc?.model && <span className="text-[10px] px-1.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">rvc</span>}
          {hasFx && <span className="text-[10px] px-1.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">fx</span>}
          {active && <span className="text-[10px] px-1.5 rounded bg-[var(--accent)]/20 text-[var(--accent)]">in use</span>}
        </button>
        <button className={btn.icon} title="Play the reference clip" onClick={() => play(voiceLib.referenceUrl(v))}><Play className="w-3.5 h-3.5" /></button>
        {!active && <button className={btn.ghost} onClick={onUse}><Check className="w-3.5 h-3.5" />Use</button>}
        <button className={btn.icon} title="Duplicate (to try changes on a copy)" onClick={onDuplicate}><Copy className="w-3.5 h-3.5" /></button>
        <button className={btn.icon} title="Delete" onClick={onDelete}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      {expanded && <VoiceEditor v={v} fxInfo={fxInfo} bases={bases} models={models} onChanged={onChanged} />}
    </div>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

const editable = (v: LibraryVoice) => ({
  label: v.label, description: v.description, style: v.style, fx: v.fx, refText: v.refText, rvc: v.rvc ?? null, base: v.base ?? null,
});

function VoiceEditor({ v, fxInfo, bases, models, onChanged }: {
  v: LibraryVoice; fxInfo?: { params: FxParam[]; presets: Record<string, Record<string, number>> }; bases: Base[]; models: RvcModel[];
  onChanged: () => void;
}) {
  const initial = editable(v);
  const [draft, setDraft] = useState(initial);
  const [test, setTest] = useState(TEST_LINE);
  const [state, setState] = useState<ReadState>('idle');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [take, setTake] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { setDraft(editable(v)); }, [v]);
  useEffect(() => () => { stop.current?.(); previewAudio.current?.pause(); }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (patch: Partial<typeof draft>) => setDraft(d => ({ ...d, ...patch }));
  const setFx = (k: string, val: number) => set({ fx: { ...draft.fx, [k]: val } });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(errText(e)); }
    setBusy('');
  };
  /** the test line with every unsaved setting (effects, delivery, RVC, base) */
  const preview = async () => {
    if (state !== 'idle') { previewAudio.current?.pause(); setState('idle'); return; }
    setState('loading'); setError('');
    try {
      const blob = await voiceLib.preview(v.id, test, { fx: draft.fx, style: draft.style, rvc: draft.rvc, base: draft.base });
      previewAudio.current?.pause();
      const el = previewAudio.current = new Audio(URL.createObjectURL(blob));
      el.onended = () => setState('idle');
      await el.play();
      setState('playing');
    } catch (e) { setError(errText(e)); setState('idle'); }
  };
  const saveAll = () => run('save', async () => {
    const { rvc, base, ...rest } = draft;
    await voiceLib.patch(v.id, {
      ...rest,
      ...(JSON.stringify(rvc) !== JSON.stringify(initial.rvc) ? { rvc: rvc ?? {} } : {}),
      ...(base !== initial.base && base ? { base } : {}),
    });
    onChanged();
  });
  const newTake = () => run('take', async () => {
    const r = await voiceLib.design(draft.description, draft.fx);
    setTake(r.draft);
    play(r.audio);
  });
  const keepTake = () => run('keep', async () => {
    await voiceLib.replaceReference(v.id, take);
    setTake('');
    onChanged();
  });
  const addClips = (list: FileList | null) => list?.length && run('clips', async () => {
    await voiceLib.addSamples(v.id, Array.from(list), true);
    onChanged();
  });
  const preset = fxInfo && Object.entries(fxInfo.presets).find(([, p]) => JSON.stringify(normFx(p)) === JSON.stringify(normFx(draft.fx)))?.[0];

  return (
    <div className="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)] space-y-3">
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Name"><input className={btn.input} value={draft.label} onChange={e => set({ label: e.target.value })} /></Field>
        <Field label="Delivery" hint="overrides the global tone">
          <input className={btn.input} value={draft.style} placeholder="(use the global tone)" onChange={e => set({ style: e.target.value })} />
        </Field>
      </div>
      <Field label="Description" hint={v.source === 'design' ? 'what “New take” designs from' : 'notes'}>
        <textarea className={clsx(btn.input, 'h-16 resize-y')} value={draft.description} onChange={e => set({ description: e.target.value })} />
      </Field>

      {/* effects */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <span className="text-xs font-medium mr-1">Effects</span>
          {fxInfo && Object.keys(fxInfo.presets).map(name => (
            <button key={name} onClick={() => set({ fx: { ...fxInfo.presets[name] } })}
              className={clsx('text-[11px] px-2 py-0.5 rounded-full capitalize', preset === name ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)]')}>
              {name === 'glados' ? 'GLaDOS' : name}
            </button>
          ))}
        </div>
        {fxInfo && (
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
            {fxInfo.params.map(p => <FxSlider key={p.key} p={p} value={draft.fx[p.key] ?? p.off} onChange={val => setFx(p.key, val)} />)}
          </div>
        )}
      </div>

      <RvcSection v={v} rvc={draft.rvc} base={draft.base} bases={bases} models={models}
        onRvc={rvc => set({ rvc })} onBase={base => set({ base })} />

      {/* test */}
      <div className="flex items-center gap-2">
        <input className={btn.input} value={test} onChange={e => setTest(e.target.value)} onKeyDown={e => e.key === 'Enter' && preview()} />
        <button className={btn.subtle} onClick={preview}>
          {state === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : state === 'playing' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          {dirty ? 'Preview changes' : 'Preview'}
        </button>
      </div>

      {/* reference */}
      {v.source === 'rvc' ? null : v.source === 'design' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button className={btn.ghost} disabled={!!busy || !draft.description.trim()} onClick={newTake}
            title="Design a new reference clip from the description; the settings above stay">
            {busy === 'take' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}{take ? 'Another take' : 'New take'}
          </button>
          {take && (
            <>
              <button className={btn.ghost} onClick={newTake} disabled={!!busy}><RotateCcw className="w-3.5 h-3.5" />Retry</button>
              <button className={btn.primary} onClick={keepTake} disabled={!!busy}>Use this take</button>
            </>
          )}
          {busy === 'take' && <span className="text-[11px] text-[var(--text-muted)]">the designer model takes about 30 s to load the first time</span>}
        </div>
      ) : (
        <Samples v={v} busy={busy} onAdd={() => files.current?.click()} run={run} onChanged={onChanged} />
      )}
      <input ref={files} type="file" accept="audio/*,video/*" multiple hidden onChange={e => { addClips(e.target.files); e.target.value = ''; }} />
      {v.source !== 'rvc' && <details className="text-xs">
        <summary className="cursor-pointer text-[var(--text-muted)]">Reference transcript</summary>
        <p className="text-[11px] text-[var(--text-muted)] my-1">
          What the reference clip says, word for word. Cloning works best when this matches exactly; fix any Whisper mistakes.
        </p>
        <textarea className={clsx(btn.input, 'h-16 resize-y')} value={draft.refText} onChange={e => set({ refText: e.target.value })} />
      </details>}

      <div className="flex items-center gap-2">
        <button className={btn.primary} disabled={!dirty || !!busy} onClick={saveAll}>
          {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Save
        </button>
        <button className={btn.ghost} disabled={!dirty} onClick={() => setDraft(initial)}><RotateCcw className="w-3.5 h-3.5" />Revert</button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

const RVC_DEFAULTS = { pitch: 0, index_rate: 0.75, protect: 0.5 };
const RVC_PARAMS: FxParam[] = [
  { key: 'pitch', label: 'Pitch (semitones)', min: -12, max: 12, step: 1, off: 0 },
  { key: 'index_rate', label: 'Character accent (index)', min: 0, max: 1, step: 0.05, off: 0.75 },
  { key: 'protect', label: 'Protect consonants', min: 0, max: 0.5, step: 0.05, off: 0.5 },
];

/** RVC voices: base voice + model + settings. Other voices: an optional RVC step on top of their own sound. */
function RvcSection({ v, rvc, base, bases, models, onRvc, onBase }: {
  v: LibraryVoice; rvc: RvcSettings | null; base: string | null; bases: Base[]; models: RvcModel[];
  onRvc: (r: RvcSettings | null) => void; onBase: (b: string) => void;
}) {
  const isRvc = v.source === 'rvc';
  if (!isRvc && !models.length) return null;
  return (
    <div>
      <div className="text-xs font-medium mb-1">{isRvc ? 'RVC voice' : 'RVC conversion'}</div>
      <p className="text-[11px] text-[var(--text-muted)] mb-1.5">
        {isRvc
          ? 'The base voice speaks the text, then the RVC model turns it into this character. The base sets accent and delivery; the model sets the sound.'
          : 'Optionally run this voice through an RVC model after synthesis.'}
      </p>
      <div className="grid sm:grid-cols-2 gap-x-4">
        {isRvc && (
          <Field label="Base voice">
            <select className={btn.input} value={base ?? 'nova'} onChange={e => onBase(e.target.value)}>
              {bases.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Model">
          <select className={btn.input} value={rvc?.model ?? ''}
            onChange={e => onRvc(e.target.value ? { ...RVC_DEFAULTS, ...rvc, model: e.target.value } : null)}>
            {!isRvc && <option value="">None</option>}
            {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        </Field>
      </div>
      {rvc && (
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
          {RVC_PARAMS.map(p => (
            <FxSlider key={p.key} p={p} value={(rvc as unknown as Record<string, number>)[p.key] ?? p.off}
              onChange={val => onRvc({ ...rvc, [p.key]: val })} />
          ))}
        </div>
      )}
    </div>
  );
}

const normFx = (fx: Record<string, number>) => Object.fromEntries(Object.entries(fx).filter(([, v]) => v).sort());

function FxSlider({ p, value, onChange }: { p: FxParam; value: number; onChange: (v: number) => void }) {
  if (p.max === 1 && p.step === 1) {
    return (
      <label className="flex items-center gap-2 text-[11px] py-0.5">
        <input type="checkbox" checked={value >= 1} onChange={e => onChange(e.target.checked ? 1 : 0)} />{p.label}
      </label>
    );
  }
  return (
    <label className="flex items-center gap-2 text-[11px]">
      <span className={clsx('w-40 shrink-0 truncate', value === p.off && 'text-[var(--text-muted)]')} title={p.label}>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={value} className="flex-1 accent-[var(--accent)]"
        onChange={e => onChange(Number(e.target.value))} onDoubleClick={() => onChange(p.off)} />
      <span className="w-10 text-right tabular-nums">{Number.isInteger(p.step) ? value : value.toFixed(2)}</span>
    </label>
  );
}

function Samples({ v, busy, onAdd, run, onChanged }: {
  v: LibraryVoice; busy: string; onAdd: () => void; run: (label: string, fn: () => Promise<unknown>) => void; onChanged: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium">Clips ({v.samples.length})</span>
        <button className={btn.ghost} disabled={!!busy} onClick={onAdd}>
          {busy === 'clips' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Add clips
        </button>
        <button className={btn.ghost} disabled={!!busy || !v.samples.length} title="Rebuild the reference from the first 10–18 s of clips"
          onClick={() => run('rebuild', async () => { await voiceLib.rebuild(v.id); onChanged(); })}>
          {busy === 'rebuild' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AudioLines className="w-3.5 h-3.5" />}Rebuild reference
        </button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-1">
        The first 10–18 s of clips (in name order) become the reference. Clean speech without music or effects clones best.
      </p>
      <div className="flex flex-wrap gap-1">
        {v.samples.map(s => (
          <span key={s} className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full bg-[var(--bg-tertiary)]">
            <button className="hover:text-[var(--accent)]" onClick={() => play(voiceLib.sampleUrl(v, s))}>{s.replace(/\.wav$/, '')}</button>
            <button className="opacity-60 hover:opacity-100" title="Remove this clip (then rebuild the reference)"
              onClick={() => run('del', async () => { await voiceLib.deleteSample(v.id, s); onChanged(); })}>
              <Trash2 className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── new voices ──────────────────────────────────────────────────────────────

function DesignNew({ fxInfo, onDone }: { fxInfo?: { presets: Record<string, Record<string, number>> }; onDone: (id?: string) => void }) {
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState('none');
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'' | 'design' | 'save'>('');
  const [error, setError] = useState('');
  const audio = useRef<Blob | null>(null);
  const fx = fxInfo?.presets[preset] ?? {};

  const audition = async () => {
    setBusy('design'); setError(''); setDraft('');
    try {
      const r = await voiceLib.design(description, fx);
      audio.current = r.audio;
      play(r.audio);
      setDraft(r.draft);
    } catch (e) { setError(errText(e)); }
    setBusy('');
  };
  const keep = async () => {
    setBusy('save'); setError('');
    try { onDone((await voiceLib.save(draft, name || 'My voice', fx)).id); } catch (e) { setError(errText(e)); setBusy(''); }
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
      <div className="text-sm font-medium">Describe a voice</div>
      <p className="text-xs text-[var(--text-muted)]">Age, accent, pitch, personality. Each audition is a new take; keep the one you like.</p>
      <textarea className={clsx(btn.input, 'h-20 resize-y')} value={description} placeholder={IDEAS[0]}
        onChange={e => { setDescription(e.target.value); setDraft(''); }} />
      <div className="flex flex-wrap gap-1">
        {IDEAS.map(i => (
          <button key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)]"
            onClick={() => { setDescription(i); setDraft(''); }}>{i.split(',')[0]}</button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs">
        Effects
        <select className={clsx(btn.input, 'w-auto')} value={preset} onChange={e => { setPreset(e.target.value); setDraft(''); }}>
          {Object.keys(fxInfo?.presets ?? { none: {} }).map(p => <option key={p} value={p}>{p === 'glados' ? 'GLaDOS' : p}</option>)}
        </select>
        <span className="text-[var(--text-muted)]">fine-tune them after saving</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className={btn.subtle} disabled={!description.trim() || !!busy} onClick={audition}>
          {busy === 'design' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}{draft ? 'Another take' : 'Audition'}
        </button>
        {draft && (
          <>
            <button className={btn.icon} title="Play again" onClick={() => audio.current && play(audio.current)}><Play className="w-3.5 h-3.5" /></button>
            <input className={clsx(btn.input, 'w-40')} value={name} placeholder="Name" onChange={e => setName(e.target.value)} />
            <button className={btn.primary} disabled={!!busy} onClick={keep}>Keep this voice</button>
          </>
        )}
        <button className={btn.ghost} onClick={() => onDone()}>Cancel</button>
      </div>
      {busy === 'design' && <p className="text-xs text-[var(--text-muted)]">Making a take… the first one loads the designer model (about 30 s).</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function SamplesNew({ onDone }: { onDone: (id?: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true); setError('');
    try { onDone((await voiceLib.fromSamples(name || 'Sampled voice', files, description)).id); } catch (e) { setError(errText(e)); setBusy(false); }
  };
  return (
    <div className="mb-3 rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
      <div className="text-sm font-medium">Clone a voice from clips</div>
      <p className="text-xs text-[var(--text-muted)]">
        A few clips of one speaker, 10–20 s in total, any audio or video format. Clean lines without music or sound effects work best.
        Whisper writes the transcript; check it afterwards. All clips are kept with the voice for later training.
      </p>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Name"><input className={btn.input} value={name} placeholder="Claptrap" onChange={e => setName(e.target.value)} /></Field>
        <Field label="Notes"><input className={btn.input} value={description} placeholder="where the clips came from" onChange={e => setDescription(e.target.value)} /></Field>
      </div>
      <input type="file" accept="audio/*,video/*" multiple className="text-xs" onChange={e => setFiles(Array.from(e.target.files ?? []))} />
      {files.length > 0 && <p className="text-[11px] text-[var(--text-muted)]">{files.length} file(s), {(files.reduce((n, f) => n + f.size, 0) / 1e6).toFixed(1)} MB</p>}
      <div className="flex items-center gap-2">
        <button className={btn.primary} disabled={!files.length || busy} onClick={create}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Create voice
        </button>
        <button className={btn.ghost} onClick={() => onDone()}>Cancel</button>
        {busy && <span className="text-[11px] text-[var(--text-muted)]">Cleaning the clips and transcribing…</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function RvcNew({ models, bases, onModels, onDone }: {
  models: RvcModel[]; bases: Base[]; onModels: () => void; onDone: (id?: string) => void;
}) {
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [base, setBase] = useState('nova');
  const [style, setStyle] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const zip = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!model && models.length) setModel(models.find(m => !m.usedBy.length)?.name ?? models[0].name); }, [models, model]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(errText(e)); }
    setBusy('');
  };
  const create = () => run('create', async () => {
    onDone((await voiceLib.createRvcVoice({ name: name || model, model, base, pitch: 0, style })).id);
  });
  const importZip = (f?: File) => f && run('import', async () => {
    const r = await voiceLib.importRvcModel(f.name.replace(/\.zip$/i, ''), f);
    setModel(r.name);
    onModels();
  });
  const removeModel = (m: RvcModel) => {
    if (confirm(`Delete the RVC model "${m.name}"?`)) run('del', async () => { await voiceLib.deleteRvcModel(m.name); setModel(''); onModels(); });
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
      <div className="text-sm font-medium">Voice from an RVC model</div>
      <p className="text-xs text-[var(--text-muted)]">
        An RVC model is a trained character voice (a .pth and usually an .index, shared as a zip on voice-model sites).
        A base voice speaks the text and the model converts it, adding under a second per sentence. The base's accent and
        delivery carry through, so pick an American base for an American character.
      </p>
      <div className="flex flex-wrap gap-1">
        {models.map(m => (
          <span key={m.name} className={clsx('inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full',
            model === m.name ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'bg-[var(--bg-tertiary)]')}>
            <button onClick={() => setModel(m.name)} title={m.usedBy.length ? `used by ${m.usedBy.join(', ')}` : 'not used yet'}>
              {m.name}{m.usedBy.length ? ' ✓' : ''}
            </button>
            {!m.usedBy.length && (
              <button className="opacity-60 hover:opacity-100" title="Delete this model" onClick={() => removeModel(m)}><Trash2 className="w-3 h-3" /></button>
            )}
          </span>
        ))}
        <button className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1"
          disabled={!!busy} onClick={() => zip.current?.click()}>
          {busy === 'import' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}Import model (.zip)
        </button>
        <input ref={zip} type="file" accept=".zip,application/zip" hidden onChange={e => { importZip(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {models.length > 0 && (
        <>
          <div className="grid sm:grid-cols-2 gap-x-4">
            <Field label="Name"><input className={btn.input} value={name} placeholder={model} onChange={e => setName(e.target.value)} /></Field>
            <Field label="Base voice">
              <select className={btn.input} value={base} onChange={e => setBase(e.target.value)}>
                {bases.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Delivery" hint="how the character talks; optional">
            <input className={btn.input} value={style} placeholder="Playful, upbeat and curious." onChange={e => setStyle(e.target.value)} />
          </Field>
        </>
      )}
      <div className="flex items-center gap-2">
        <button className={btn.primary} disabled={!model || !!busy} onClick={create}>
          {busy === 'create' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Create voice
        </button>
        <button className={btn.ghost} onClick={() => onDone()}>Cancel</button>
        {busy === 'create' && <span className="text-[11px] text-[var(--text-muted)]">Rendering a sample through the model…</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
