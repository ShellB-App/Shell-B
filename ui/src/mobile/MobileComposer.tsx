import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import clsx from 'clsx';
import {
  ArrowUp,
  AudioLines,
  Brain,
  Cpu,
  Loader2,
  Mic,
  Paperclip,
  Square,
  Workflow,
  X,
} from 'lucide-react';
import type { Agent, Attachment, Effort, ModelInfo } from '../types';
import { api, fmtBytes } from '../api';
import { AgentAvatar } from '../components/common';

const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'off', label: 'Instant' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Think' },
  { id: 'high', label: 'Deep' },
];

interface Props {
  agent: Agent;
  agents: Agent[];
  model?: ModelInfo;
  effort: Effort;
  onEffort: (e: Effort) => void;
  onAgentSelect: () => void;
  busy: boolean;
  onSend: (text: string, attachments: Attachment[], opts?: { agentId?: string; mode?: 'plan' }) => void;
  onStop: () => void;
  ensureConversation: () => Promise<string>;
  voiceOk: boolean;
  onVoiceMode?: () => void;
  planMode?: boolean;
  onPlanMode?: (on: boolean) => void;
  modelChoices?: ModelInfo[];
  onModel?: (name: string) => void;
  focusKey?: string;
}

export function MobileComposer({
  agent,
  model,
  effort,
  onEffort,
  onAgentSelect,
  busy,
  onSend,
  onStop,
  ensureConversation,
  voiceOk,
  onVoiceMode,
  planMode,
  onPlanMode,
  modelChoices = [],
  onModel,
  focusKey,
}: Props) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState<'idle' | 'rec' | 'transcribing'>('idle');
  const [showModels, setShowModels] = useState(false);

  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rec = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (ta.current && window.innerWidth >= 768) {
      ta.current.focus();
    }
  }, [focusKey]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const uploading = atts.some(a => a.uploading);

  async function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    const convId = await ensureConversation();
    for (const f of Array.from(files)) {
      const tmp: Attachment = {
        id: `tmp-${Math.random().toString(36).slice(2)}`,
        name: f.name,
        size: f.size,
        type: f.type,
        kind: f.type.startsWith('image/') ? 'image' : 'file',
        url: '',
        uploading: true,
        localPreview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      };
      setAtts(prev => [...prev, tmp]);
      api
        .upload(convId, f)
        .then(att =>
          setAtts(prev =>
            prev.map(a => (a.id === tmp.id ? { ...att, localPreview: tmp.localPreview } : a))
          )
        )
        .catch(() => setAtts(prev => prev.filter(a => a.id !== tmp.id)));
    }
  }

  async function submit() {
    if (busy || uploading || (!text.trim() && atts.length === 0)) return;
    const sent = atts.map(({ localPreview: _p, uploading: _u, ...a }) => a);
    const content = text.trim();
    setText('');
    setAtts([]);
    onSend(content, sent, {
      ...(planMode ? { mode: 'plan' as const } : {}),
    });
  }

  const cycleEffort = () => {
    const idx = EFFORTS.findIndex(e => e.id === effort);
    const next = EFFORTS[(idx + 1) % EFFORTS.length];
    onEffort(next.id);
  };

  async function toggleMic() {
    if (recording === 'rec') {
      rec.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = e => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setRecording('transcribing');
        try {
          const { text: heard } = await api.stt(new Blob(chunks, { type: mr.mimeType }));
          if (heard) setText(t => (t ? `${t} ${heard}` : heard));
        } finally {
          setRecording('idle');
          ta.current?.focus();
        }
      };
      rec.current = mr;
      mr.start();
      setRecording('rec');
    } catch {
      setRecording('idle');
    }
  }

  const canThink = model ? model.capabilities.includes('thinking') : true;

  return (
    <div className="shrink-0 px-3 pt-1 pb-2 bg-[var(--bg-primary)] border-t border-[var(--border-subtle)] select-none">
      <div
        className={clsx(
          'rounded-2xl border bg-[var(--bg-secondary)] shadow-md transition-all p-2',
          planMode
            ? 'border-violet-500/60 ring-1 ring-violet-500/30'
            : 'border-[var(--border-subtle)] focus-within:border-[var(--border-strong)]'
        )}
      >
        {/* Top Chips Row */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-none text-[11px]">
          {/* Agent Picker Chip */}
          <button
            onClick={onAgentSelect}
            className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] shrink-0 transition"
          >
            <AgentAvatar agent={agent} size={13} />
            <span className="font-medium truncate max-w-[80px]">{agent.name}</span>
          </button>

          {/* Effort Chip */}
          {canThink && (
            <button
              onClick={cycleEffort}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-full border shrink-0 transition',
                effort !== 'off'
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-500 font-medium'
                  : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-muted)]'
              )}
              title="Reasoning effort"
            >
              <Brain className="w-3 h-3" />
              <span>{EFFORTS.find(e => e.id === effort)?.label ?? 'Think'}</span>
            </button>
          )}

          {/* Plan Mode Chip */}
          {onPlanMode && (
            <button
              onClick={() => onPlanMode(!planMode)}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded-full border shrink-0 transition',
                planMode
                  ? 'bg-violet-500/20 border-violet-500/40 text-violet-400 font-medium'
                  : 'bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-muted)]'
              )}
              title="Plan Mode"
            >
              <Workflow className="w-3 h-3" />
              <span>Plan</span>
            </button>
          )}

          {/* Cloud Model Selector if available */}
          {agent.cloud && modelChoices.length > 0 && onModel && (
            <div className="relative shrink-0">
              <button
                onClick={() => setShowModels(s => !s)}
                className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
              >
                <Cpu className="w-3 h-3 text-sky-400" />
                <span className="truncate max-w-[90px]">{model?.name?.split('/')?.[1] ?? 'Model'}</span>
              </button>

              {showModels && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowModels(false)} />
                  <div className="absolute left-0 bottom-full mb-1.5 w-52 max-h-48 overflow-y-auto rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shadow-xl p-1 z-50 text-xs">
                    {modelChoices.map(m => (
                      <button
                        key={m.name}
                        onClick={() => {
                          onModel(m.name);
                          setShowModels(false);
                        }}
                        className={clsx(
                          'w-full text-left px-2.5 py-1.5 rounded-lg truncate transition',
                          m.name === model?.name
                            ? 'bg-[var(--accent)]/15 text-[var(--accent-soft)] font-medium'
                            : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'
                        )}
                      >
                        {m.name.split('/')[1] || m.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Attachments Preview */}
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 pb-1.5 border-b border-[var(--border-subtle)]">
            {atts.map(a => (
              <div
                key={a.id}
                className="relative flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[11px]"
              >
                {a.uploading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
                ) : (
                  <Paperclip className="w-3 h-3 text-[var(--text-muted)]" />
                )}
                <span className="truncate max-w-[120px] text-[var(--text-primary)]">{a.name}</span>
                <span className="text-[10px] text-[var(--text-muted)] font-mono">
                  {fmtBytes(a.size)}
                </span>
                <button
                  onClick={() => setAtts(prev => prev.filter(x => x.id !== a.id))}
                  className="p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-rose-400"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text Area */}
        <div className="relative">
          <textarea
            ref={ta}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                // If on mobile soft keyboard, return key is typically newline; on hardware keyboard or tablet Enter sends
                if (window.innerWidth >= 768 || e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  submit();
                }
              }
            }}
            placeholder={`Message ${agent.name}…`}
            rows={1}
            className="w-full bg-transparent border-0 resize-none text-[15px] sm:text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none py-1.5 px-1 leading-relaxed"
          />
        </div>

        {/* Bottom Actions Row */}
        <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-1">
            {/* Attachment Button */}
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => fileInput.current?.click()}
              className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
              title="Attach files or photos"
              aria-label="Attach files or photos"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            {/* Whisper Speech to Text Mic Button */}
            {voiceOk && (
              <button
                onClick={toggleMic}
                className={clsx(
                  'p-2 rounded-xl transition',
                  recording === 'rec'
                    ? 'bg-rose-500 text-white animate-pulse'
                    : recording === 'transcribing'
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                )}
                title={recording === 'rec' ? 'Recording… Tap to finish' : 'Dictate with Whisper'}
                aria-label={recording === 'rec' ? 'Recording… Tap to finish' : 'Dictate with Whisper'}
              >
                {recording === 'transcribing' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>
            )}

            {/* Hands-free Voice Mode Button */}
            {onVoiceMode && voiceOk && (
              <button
                onClick={onVoiceMode}
                className="p-2 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
                title="Conversational Voice Mode"
                aria-label="Conversational Voice Mode"
              >
                <AudioLines className="w-4 h-4 text-[var(--accent)]" />
              </button>
            )}
          </div>

          {/* Send / Stop Button */}
          <div>
            {busy ? (
              <button
                onClick={onStop}
                className="p-2 rounded-xl bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 transition flex items-center justify-center"
                title="Stop generating"
                aria-label="Stop generating"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim() && atts.length === 0}
                className={clsx(
                  'p-2 rounded-xl transition flex items-center justify-center',
                  text.trim() || atts.length > 0
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110 shadow-sm'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] opacity-50 cursor-not-allowed'
                )}
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
