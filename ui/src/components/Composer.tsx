import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { secureHere } from '../secureUrl';
import clsx from 'clsx';
import { ArrowUp, AudioLines, Camera, Loader2, Mic, Paperclip, PictureInPicture2, ScreenShare, ScreenShareOff, Square, Users } from 'lucide-react';
import type { Agent, Attachment, Effort, ModelInfo } from '../types';
import { api } from '../api';
import { onIncoming, takeIncoming } from '../desktop';
import { onQuote } from '../quote';
import { screenSupported, snapshot, startLive, stopLive, useLiveShare } from '../screenShare';
import { overlaySupported, toggleOverlay, useOverlayWindow } from '../overlay';
import { openMenuAt } from './ContextMenu';
import { toast } from './toast';
import { composerApi } from '../composerApi';
import { expandVariables, findMention, ShortcutMenu, useShortcuts, type ComposerCommand } from './ComposerShortcuts';
import { AttachmentsList } from './composer/AttachmentsList';
import { ComposerMenus, EFFORTS } from './composer/ComposerMenus';

export { EFFORTS };

interface Props {
  agent: Agent;
  agents: Agent[];
  model?: ModelInfo;
  effort: Effort;
  onEffort: (e: Effort) => void;
  onAgent: (a: Agent) => void;
  busy: boolean;
  /** `agentId` is set when the message @mentions another agent: answer this turn as that agent. */
  onSend: (text: string, attachments: Attachment[], opts?: { agentId?: string; mode?: 'plan' }) => void;
  /** starts hands-free voice mode (the chat page passes it; Studio and Code don't) */
  onVoiceMode?: () => void;
  onStop: () => void;
  ensureConversation: () => Promise<string>;
  voiceOk: boolean;
  focusKey?: string;
  /** Overrides where attachments go (Studio sends them to the project's assets/). */
  uploader?: (f: File) => Promise<Attachment>;
  placeholder?: string;
  /** Orders this chat's artifacts first in the # menu. */
  convId?: string;
  /** Runs /new (start a new chat). */
  onCommand?: (c: ComposerCommand) => void;
  /** Plan mode (server/planmode.py): research read-only, then reply with a plan to approve. Shift+Tab or /plan toggles it. */
  planMode?: boolean;
  onPlanMode?: (on: boolean) => void;
  /** Cloud agents: the other models their provider offers, picked per agent next to the effort menu. */
  modelChoices?: ModelInfo[];
  onModel?: (name: string) => void;
  /** Takes files and text opened with or shared to the installed app (desktop.ts); only the main chat page's composer. */
  inbox?: boolean;
  /** Shell:B Guest (ui/src/guest/): no screen sight and no Secretary, which are the owner's */
  guest?: boolean;
}

export function Composer({
  agent,
  agents,
  model,
  effort,
  onEffort,
  onAgent,
  busy,
  onSend,
  onStop,
  ensureConversation,
  voiceOk,
  focusKey,
  uploader,
  placeholder,
  convId,
  onCommand,
  planMode,
  onPlanMode,
  modelChoices = [],
  onModel,
  onVoiceMode,
  inbox,
  guest,
}: Props) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState<'idle' | 'rec' | 'transcribing'>('idle');
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const sc = useShortcuts({
    text,
    setText,
    ta,
    agent,
    agents,
    convId,
    onEffort,
    onAgent,
    onCommand,
    planMode,
    onPlanMode,
    onError: setNotice,
    addRef: att => setAtts(prev => (prev.some(a => a.kind === 'ref' && a.ref === att.ref) ? prev : [...prev, att])),
  });

  // predicted next message (server/composer.py suggest): ghost text while what's typed is a prefix of it; Tab or → accepts
  const [suggestion, setSuggestion] = useState('');
  const ghostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSuggestion('');
    if (!convId || busy) return;
    let live = true;
    composerApi.suggest(convId).then(r => { if (live) setSuggestion(r.suggestion); }).catch(() => {});
    return () => { live = false; };
  }, [convId, busy]);

  const ghost = suggestion && !atts.length && recording === 'idle' && !sc.open && suggestion.toLowerCase().startsWith(text.toLowerCase())
    && suggestion.length > text.length ? suggestion.slice(text.length) : '';

  function acceptSuggestion() {
    setText(text + ghost);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (el) { el.selectionStart = el.selectionEnd = el.value.length; }
    });
  }

  useEffect(() => { ta.current?.focus(); }, [focusKey]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, ghostRef.current?.scrollHeight ?? 0), 260)}px`;
  }, [text, ghost]);

  const canThink = model ? model.capabilities.includes('thinking') : true;
  const canSee = model ? model.capabilities.includes('vision') : true;
  const uploading = atts.some(a => a.uploading);
  const share = useLiveShare();
  const overlay = useOverlayWindow();

  function screenMenu(e: ReactMouseEvent<HTMLButtonElement>) {
    const sec = secureHere();
    if (!screenSupported()) {
      if (sec) location.href = sec;
      else toast('Screen sharing needs HTTPS and a desktop browser.', { kind: 'error' });
      return;
    }
    const failed = (what: string) => (err: unknown) => {
      if (!/NotAllowed|AbortError|Permission/i.test(String(err))) toast(`${what}: ${String(err).replace(/^Error: (\d+: )?/, '')}`, { kind: 'error' });
    };
    openMenuAt(e, [
      { label: share ? 'Attach a screenshot of the share' : 'Attach a screenshot…', icon: Camera,
        onSelect: () => { snapshot().then(f => addFiles([f]), failed("Couldn't take a screenshot")); } },
      share
        ? { label: 'Stop sharing', icon: ScreenShareOff, danger: true, onSelect: () => { void stopLive(); } }
        : { label: 'Share screen live…', icon: ScreenShare, hint: 'agents look when needed',
            onSelect: () => { startLive().then(() => toast(canSee ? `${agent.name} can now look at your screen when it helps.`
              : `Sharing. ${agent.name}'s model can't see images; pick a vision model or agent to use it.`), failed("Couldn't share the screen")); } },
      ...(inbox && overlaySupported() ? [{ label: overlay ? 'Close the overlay' : 'Overlay: keep Shell:B on top', icon: PictureInPicture2, hint: 'Ctrl+Shift+Y',
        onSelect: () => { toggleOverlay().catch(failed("Couldn't open the overlay")); } }] : []),
    ]);
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const convId = uploader ? '' : await ensureConversation();
    for (const f of files) {
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
      (uploader ? uploader(f) : api.upload(convId, f))
        .then(att => setAtts(prev => prev.map(a => (a.id === tmp.id ? { ...att, localPreview: tmp.localPreview } : a))))
        .catch(() => setAtts(prev => prev.filter(a => a.id !== tmp.id)));
    }
  }

  // files and text opened with or shared to the installed app: the shell has just started a new chat for them
  const [arrivals, setArrivals] = useState(0);
  useEffect(() => (inbox ? onIncoming(() => setArrivals(n => n + 1)) : undefined), [inbox]);
  useEffect(() => {
    const got = inbox ? takeIncoming() : null;
    if (!got) return;
    if (got.text) setText(t => (t ? `${t}\n\n${got.text}` : got.text));
    addFiles(got.files);
    ta.current?.focus();
  }, [inbox, arrivals]);  // eslint-disable-line react-hooks/exhaustive-deps -- addFiles reads the latest props

  // "Quote in reply" from a message's context menu (quote.ts): the quote goes after any draft, the cursor after it
  useEffect(() => (inbox ? onQuote(q => {
    setText(t => (t.trim() ? `${t.replace(/\s*$/, '')}\n\n${q}` : q));
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } });
  }) : undefined), [inbox]);

  async function submit() {
    if (busy || uploading || (!text.trim() && atts.length === 0)) return;
    if (/^\/(new|clear)\s*$/.test(text.trim()) && onCommand) { setText(''); onCommand('new'); return; }
    if (/^\/incognito\s*$/.test(text.trim()) && onCommand) { setText(''); onCommand('incognito'); return; }
    if (/^\/plan\s*$/.test(text.trim()) && onPlanMode) { setText(''); onPlanMode(!planMode); return; }
    // "/plan <request>" plans just this request
    const planOnce = !!onPlanMode && /^\/plan\s/.test(text.trim());
    const raw = planOnce ? text.trim().replace(/^\/plan\s+/, '') : text.trim();
    const sent = atts.map(({ localPreview: _p, uploading: _u, ...a }) => a);
    setText('');
    setSuggestion('');
    setAtts([]);
    const content = await expandVariables(raw, sc.catalog, agent);
    const routed = findMention(raw, agents);
    onSend(content, sent, {
      ...(routed && routed.id !== agent.id ? { agentId: routed.id } : {}),
      ...(planMode || planOnce ? { mode: 'plan' as const } : {}),
    });
  }

  async function toggleMic() {
    if (recording === 'rec') { rec.current?.stop(); return; }
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

  const secure = secureHere();  // plain http: the mic opens this chat on the HTTPS address instead
  const micDisabledReason = secure ? '' : !voiceOk ? 'HERMES (speech service) is offline' : '';

  return (
    <div
      className={clsx(
        'sf-composer rounded-2xl border bg-[var(--bg-secondary)] shadow-lg transition-all p-2.5',
        dragging
          ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30'
          : planMode
          ? 'border-[var(--accent)]/60 ring-1 ring-[var(--accent)]/20'
          : 'border-[var(--border-subtle)] focus-within:border-[var(--border-strong)]'
      )}
      onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
    >
      <div className="relative">
        {sc.open && <ShortcutMenu items={sc.items} active={sc.active} onHover={sc.setActive} onPick={sc.pick} trig={sc.trig} />}
      </div>

      <AttachmentsList
        attachments={atts}
        onRemove={id => setAtts(prev => prev.filter(x => x.id !== id))}
        canSee={canSee}
        agentName={agent.name}
      />

      <div className="relative">
        {ghost && (
          <div ref={ghostRef} aria-hidden className="absolute inset-x-0 top-0 pointer-events-none whitespace-pre-wrap break-words text-[0.9375rem] px-1.5 py-1">
            <span className="invisible">{text}</span>
            <span className="text-[var(--text-muted)]">{ghost}</span>
            <kbd className="ml-2 px-1 rounded border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] align-middle">Tab</kbd>
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={e => { setText(e.target.value); sc.syncCaret(); }}
          onSelect={sc.syncCaret}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || sc.onKeyDown(e)) return;
            if (e.key === 'Tab' && e.shiftKey && onPlanMode) { e.preventDefault(); onPlanMode(!planMode); return; }
            if (ghost && (e.key === 'Tab' || (e.key === 'ArrowRight' && e.currentTarget.selectionStart === text.length))) {
              e.preventDefault(); acceptSuggestion(); return;
            }
            if (ghost && e.key === 'Escape') { setSuggestion(''); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          onPaste={(e: ClipboardEvent) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) { e.preventDefault(); addFiles(files); }
          }}
          placeholder={ghost ? '' : recording === 'rec' ? 'Listening… click the mic to stop' : placeholder ?? (planMode ? `Plan with ${agent.name}: describe what you want; nothing changes until you approve` : `Message ${agent.name}…  (/ commands · @ agents · # context)`)}
          className="w-full bg-transparent text-[0.9375rem] placeholder-[var(--text-muted)] resize-none focus:outline-none px-1.5 py-1 min-h-[40px]"
          aria-label="Message"
        />
      </div>

      {notice && <div className="px-1.5 pb-1 text-[11px] text-amber-400">{notice}</div>}
      {share && (
        <div className="flex items-center gap-2 px-1.5 pb-1 text-[11px] text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-hidden />
          <span className="truncate">Sharing <span className="text-[var(--text-secondary)]">{share.label}</span>
            {share.looks ? ` · looked ${share.looks}×` : ' · agents look only when needed'}</span>
          <button onClick={() => { void stopLive(); }} className="ml-auto shrink-0 px-1.5 rounded text-red-400 hover:bg-red-500/10 focus-visible:outline focus-visible:outline-1">Stop</button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between pt-1.5 gap-x-2 gap-y-1">
        <ComposerMenus
          agent={agent}
          agents={agents}
          onAgent={onAgent}
          model={model}
          modelChoices={modelChoices}
          onModel={onModel}
          effort={effort}
          onEffort={onEffort}
          canThink={canThink}
          planMode={planMode}
          onPlanMode={onPlanMode}
        />

        <div className="flex items-center gap-1 shrink-0 ml-auto">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button onClick={() => fileRef.current?.click()} className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition" title="Attach files or images">
            <Paperclip className="w-4 h-4" />
          </button>
          {!guest && <button onClick={screenMenu} aria-haspopup="menu"
            className={clsx('p-2 rounded-lg transition', share ? 'text-red-400 hover:bg-red-500/10' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]')}
            title={share ? `Sharing ${share.label}: click to stop or attach a screenshot` : 'Screen: attach a screenshot or share live'}>
            <ScreenShare className="w-4 h-4" />
          </button>}
          <button
            onClick={secure ? () => { location.href = secure; } : toggleMic} disabled={!!micDisabledReason || recording === 'transcribing'}
            title={secure ? 'Voice input needs HTTPS: click to reopen this chat on the secure Tailscale address'
              : micDisabledReason || (recording === 'rec' ? 'Stop and transcribe' : 'Dictate (HERMES Whisper)')}
            className={clsx('p-2 rounded-lg transition disabled:opacity-35',
              recording === 'rec' ? 'bg-red-500/20 text-red-400 animate-pulse' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]')}
          >
            {recording === 'transcribing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
          </button>
          {onVoiceMode && (
            <button onClick={secure ? () => { location.href = secure; } : onVoiceMode} disabled={!!micDisabledReason}
              title={secure ? 'Voice mode needs HTTPS: click to reopen this chat on the secure Tailscale address'
                : micDisabledReason || 'Talk hands-free: speak, hear the reply, interrupt any time'}
              className="p-2 rounded-lg transition disabled:opacity-35 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <AudioLines className="w-4 h-4" />
            </button>
          )}
          {!guest && <button
            onClick={() => { location.hash = '#/secretary'; }}
            title="Secretary Mode: listen & transcribe meetings with speaker identification and compile summaries"
            className="p-2 rounded-lg transition text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Users className="w-4 h-4" />
          </button>}
          {busy ? (
            <button onClick={onStop} className="p-2 rounded-xl bg-[var(--text-primary)] text-[var(--bg-primary)] transition hover:opacity-80" title="Stop">
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : (
            <button onClick={submit} disabled={uploading || (!text.trim() && atts.length === 0)}
              className="p-2 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-30 text-[var(--accent-fg)] transition shadow-md" title="Send (Enter)">
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
