import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle, AudioLines, BookMarked, Calendar, Check, CheckCircle2, ChevronRight,
  Clock, Copy, Download, Edit2, ExternalLink, FileAudio, FileText, HelpCircle, Laptop,
  ListOrdered, ListTodo, Loader2, Mic, MicOff, Monitor, Pause, Play, Plus,
  RefreshCw, Search, Send, ShieldAlert, Sliders, Sparkles, Split, Trash2, Upload, Users, Volume2, X
} from 'lucide-react';
import { api, req } from '../api';
import { SECURE_URL, secureHere } from '../secureUrl';
import type { Meeting, MeetingSpeaker, MeetingSummaryItem, MeetingUtterance } from '../types';
import { Markdown } from './Markdown';
import { toast } from './toast';

type RecordingState = 'idle' | 'listening' | 'hearing' | 'paused' | 'summarizing';

function formatDuration(sec: number): string {
  const s = Math.floor(sec);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function Secretary({ onBack }: { onBack?: () => void }) {
  const [meetings, setMeetings] = useState<MeetingSummaryItem[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recState, setRecState] = useState<RecordingState>('idle');
  const [audioSource, setAudioSource] = useState<'both' | 'system' | 'mic'>('both');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [liveDuration, setLiveDuration] = useState(0);
  const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'actions' | 'ask'>('summary');
  const [audioLevel, setAudioLevel] = useState(0);
  const [copied, setCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [editingSpeaker, setEditingSpeaker] = useState<MeetingSpeaker | null>(null);
  const [speakerNameInput, setSpeakerNameInput] = useState('');
  const [speakerColorInput, setSpeakerColorInput] = useState('');
  const [filterSpeaker, setFilterSpeaker] = useState<string | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [codexSaving, setCodexSaving] = useState(false);
  const [codexSavedId, setCodexSavedId] = useState<string | null>(null);
  const [suggestingNames, setSuggestingNames] = useState(false);
  const [voiceSensitivity, setVoiceSensitivity] = useState<'strict' | 'balanced' | 'relaxed'>('balanced');
  const [rediarizing, setRediarizing] = useState(false);
  const [rediarizeModalOpen, setRediarizeModalOpen] = useState(false);
  const [targetSpeakerCount, setTargetSpeakerCount] = useState<number | ''>('');
  const liveDurationRef = useRef<number>(0);
  const voiceSensitivityRef = useRef(voiceSensitivity);
  voiceSensitivityRef.current = voiceSensitivity;

  // Q&A State
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [asking, setAsking] = useState(false);

  // Web Audio Refs
  const audioCtx = useRef<AudioContext | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const systemStream = useRef<MediaStream | null>(null);
  const scriptNode = useRef<ScriptProcessorNode | null>(null);
  const analyserNode = useRef<AnalyserNode | null>(null);
  const recordedSamples = useRef<Float32Array[]>([]);
  const utterStartSec = useRef<number>(0);
  const isSpeaking = useRef<boolean>(false);
  const quietMs = useRef<number>(0);
  const loudMs = useRef<number>(0);
  const timerInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const meetingRef = useRef<Meeting | null>(null);
  meetingRef.current = meeting;

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Load meeting history on mount
  const loadMeetings = useCallback(async () => {
    try {
      const list = await api.secretaryMeetings();
      setMeetings(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then(devs => {
      const inputs = devs.filter(d => d.kind === 'audioinput');
      setAudioDevices(inputs);
      if (inputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(inputs[0].deviceId);
      }
    }).catch(() => {});

    loadMeetings().then(list => {
      if (list.length > 0) {
        api.secretaryMeeting(list[0].id).then(m => {
          setMeeting(m);
          setLiveDuration(m.duration);
          setActiveTab(m.summary ? 'summary' : 'transcript');
        });
      }
    });
  }, [loadMeetings, selectedDeviceId]);

  const openMeeting = async (id: string) => {
    if (recState === 'listening' || recState === 'hearing') {
      stopRecording();
    }
    setLoading(true);
    try {
      const m = await api.secretaryMeeting(id);
      setMeeting(m);
      setLiveDuration(m.duration);
      setActiveTab(m.summary ? 'summary' : 'transcript');
      setCodexSavedId(m.codexEntryId ?? null);
      setAskAnswer('');
    } finally {
      setLoading(false);
      setHistoryOpen(false);
    }
  };

  const createNewMeeting = async () => {
    if (recState === 'listening' || recState === 'hearing') {
      stopRecording();
    }
    setLoading(true);
    try {
      const newM = await api.createSecretaryMeeting({
        title: `Meeting ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      });
      setMeeting(newM);
      setLiveDuration(0);
      setActiveTab('transcript');
      setCodexSavedId(null);
      setAskAnswer('');
      await loadMeetings();
    } finally {
      setLoading(false);
    }
  };

  const deleteMeeting = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this meeting?')) return;
    await api.deleteSecretaryMeeting(id);
    const updated = await loadMeetings();
    if (meeting?.id === id) {
      if (updated.length > 0) {
        openMeeting(updated[0].id);
      } else {
        setMeeting(null);
      }
    }
  };

  // ── Recording Engine ────────────────────────────────────────────────────────
  const flushUtterance = useCallback(async () => {
    const curMeeting = meetingRef.current;
    if (!curMeeting || recordedSamples.current.length === 0) return;

    // Concat samples
    let totalLen = 0;
    for (const c of recordedSamples.current) totalLen += c.length;
    if (totalLen < 16000 * 0.4) {
      // too short (< 400ms)
      recordedSamples.current = [];
      return;
    }

    const flat = new Float32Array(totalLen);
    let offset = 0;
    for (const c of recordedSamples.current) {
      flat.set(c, offset);
      offset += c.length;
    }
    recordedSamples.current = [];

    const wavBlob = encodeWav(flat, 16000);
    const sStart = utterStartSec.current;
    const sEnd = sStart + totalLen / 16000;

    try {
      const res = await api.secretaryUtterance(curMeeting.id, wavBlob, sStart, sEnd, undefined, voiceSensitivityRef.current);
      if (res.utterance) {
        setMeeting(prev => {
          if (!prev || prev.id !== curMeeting.id) return prev;
          const updatedUtterances = [...prev.utterances, res.utterance];
          return {
            ...prev,
            utterances: updatedUtterances,
            speakers: res.speakers,
            duration: res.duration,
          };
        });
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    } catch {
      // transient STT issue, keep going
    }
  }, []);

  const startRecording = async () => {
    if (!meeting) {
      await createNewMeeting();
    }
    const currentM = meetingRef.current;
    if (!navigator?.mediaDevices) {
      const sec = secureHere();
      if (sec) {
        if (confirm("Browser audio recording requires a secure connection (HTTPS or localhost).\n\nWould you like to reopen Secretary Mode on the secure HTTPS address now?")) {
          location.href = sec;
        }
      } else {
        toast("Audio recording APIs (navigator.mediaDevices) are unavailable in this browser environment. Please connect via HTTPS or localhost (e.g. " + SECURE_URL + "/#/secretary).", { kind: 'error' });
      }
      setRecState('idle');
      return;
    }

    try {
      let sysTrack: MediaStreamTrack | null = null;

      // 1. Get computer / system / tab audio if requested
      if (audioSource === 'system' || audioSource === 'both') {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            systemAudio: 'include',
          } as DisplayMediaStreamOptions);

          const aTracks = displayStream.getAudioTracks();
          if (aTracks.length === 0) {
            displayStream.getTracks().forEach(t => t.stop());
            toast("No computer audio was shared. In the browser prompt, please ensure 'Share audio' or 'Also share tab audio' is enabled.", { kind: 'error' });
            setRecState('idle');
            return;
          }

          // Stop video track immediately since we only process audio
          displayStream.getVideoTracks().forEach(t => t.stop());
          systemStream.current = displayStream;
          sysTrack = aTracks[0];

          sysTrack.onended = () => {
            if (recState === 'listening' || recState === 'hearing') {
              stopRecording();
            }
          };
        } catch (err) {
          if (String(err).includes('Permission') || String(err).includes('NotAllowed')) {
            setRecState('idle');
            return;
          }
          throw err;
        }
      }

      // 2. Get microphone audio if requested
      let micStream: MediaStream | null = null;
      if (audioSource === 'mic' || audioSource === 'both') {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          mediaStream.current = micStream;
        } catch (err) {
          if (audioSource === 'both' && sysTrack) {
            console.warn('Microphone permission failed, continuing with computer audio only:', err);
          } else {
            throw err;
          }
        }
      }

      const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
        sampleRate: 16000,
      });
      audioCtx.current = ac;
      await ac.resume();

      // Mixer gain node to blend computer audio and microphone
      const mixer = ac.createGain();

      if (micStream) {
        const micSource = ac.createMediaStreamSource(micStream);
        micSource.connect(mixer);
      }

      if (sysTrack) {
        const sysStream = new MediaStream([sysTrack]);
        const sysSource = ac.createMediaStreamSource(sysStream);
        sysSource.connect(mixer);
      }

      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      analyserNode.current = analyser;

      // 4096 buffer size at 16kHz is ~256ms per buffer
      const sp = ac.createScriptProcessor(4096, 1, 1);
      scriptNode.current = sp;

      mixer.connect(analyser);
      analyser.connect(sp);
      sp.connect(ac.destination);

      recordedSamples.current = [];
      isSpeaking.current = false;
      quietMs.current = 0;
      loudMs.current = 0;
      liveDurationRef.current = currentM?.duration || 0;
      setLiveDuration(liveDurationRef.current);
      utterStartSec.current = liveDurationRef.current;

      const pcmBuf = new Float32Array(analyser.fftSize);

      sp.onaudioprocess = e => {
        const inputData = e.inputBuffer.getChannelData(0);
        analyser.getFloatTimeDomainData(pcmBuf);

        // Calculate RMS
        let sum = 0;
        for (let i = 0; i < pcmBuf.length; i++) sum += pcmBuf[i] * pcmBuf[i];
        const rms = Math.sqrt(sum / pcmBuf.length);
        setAudioLevel(l => l * 0.7 + Math.min(1, rms * 10) * 0.3);

        const threshold = 0.015;
        const bufDurationMs = (inputData.length / 16000) * 1000;

        if (rms >= threshold) {
          loudMs.current += bufDurationMs;
          quietMs.current = 0;
          if (loudMs.current >= 120 && !isSpeaking.current) {
            isSpeaking.current = true;
            utterStartSec.current = liveDurationRef.current;
            setRecState('hearing');
          }
        } else {
          if (isSpeaking.current) {
            quietMs.current += bufDurationMs;
          } else {
            loudMs.current = 0;
          }
        }

        if (isSpeaking.current) {
          recordedSamples.current.push(new Float32Array(inputData));

          // Pause after speech (> 750ms quiet) or utterance too long (> 16s)
          const totalUtterMs = (recordedSamples.current.length * 4096 / 16000) * 1000;
          if (quietMs.current >= 750 || totalUtterMs >= 16000) {
            isSpeaking.current = false;
            quietMs.current = 0;
            loudMs.current = 0;
            setRecState('listening');
            flushUtterance();
          }
        }
      };

      setRecState('listening');

      // Live timer increment
      timerInterval.current = setInterval(() => {
        liveDurationRef.current += 0.5;
        setLiveDuration(liveDurationRef.current);
      }, 500);
    } catch (err) {
      toast(`Could not access microphone: ${err}`, { kind: 'error' });
      setRecState('idle');
    }
  };

  const pauseRecording = () => {
    if (audioCtx.current && audioCtx.current.state === 'running') {
      audioCtx.current.suspend();
    }
    if (timerInterval.current) clearInterval(timerInterval.current);
    if (isSpeaking.current) {
      flushUtterance();
      isSpeaking.current = false;
    }
    setRecState('paused');
  };

  const resumeRecording = async () => {
    if (audioCtx.current && audioCtx.current.state === 'suspended') {
      await audioCtx.current.resume();
    }
    timerInterval.current = setInterval(() => {
      liveDurationRef.current += 0.5;
      setLiveDuration(liveDurationRef.current);
    }, 500);
    setRecState('listening');
  };

  const stopRecording = () => {
    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }
    if (isSpeaking.current) {
      flushUtterance();
      isSpeaking.current = false;
    }
    if (scriptNode.current) {
      scriptNode.current.disconnect();
      scriptNode.current.onaudioprocess = null;
      scriptNode.current = null;
    }
    if (mediaStream.current) {
      mediaStream.current.getTracks().forEach(t => t.stop());
      mediaStream.current = null;
    }
    if (systemStream.current) {
      systemStream.current.getTracks().forEach(t => t.stop());
      systemStream.current = null;
    }
    if (audioCtx.current) {
      audioCtx.current.close().catch(() => {});
      audioCtx.current = null;
    }
    setRecState('idle');
    setAudioLevel(0);

    // Save final duration
    if (meetingRef.current) {
      api.patchSecretaryMeeting(meetingRef.current.id, { duration: liveDuration });
    }
  };

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  // ── Actions & Summarization ────────────────────────────────────────────────
  const handleSummarize = async () => {
    if (!meeting) return;
    if (recState === 'listening' || recState === 'hearing') {
      stopRecording();
    }
    setRecState('summarizing');
    try {
      const res = await api.secretarySummarize(meeting.id);
      setMeeting(prev => prev ? { ...prev, summary: res.summary, summaryData: res.summaryData, title: res.title } : null);
      setActiveTab('summary');
      await loadMeetings();
    } catch (err) {
      toast(`Summary generation failed: ${err}`, { kind: 'error' });
    } finally {
      setRecState('idle');
    }
  };

  const handleSaveToCodex = async () => {
    if (!meeting) return;
    setCodexSaving(true);
    try {
      const res = await api.secretarySaveToCodex(meeting.id);
      setCodexSavedId(res.codexEntry.id);
      setMeeting(prev => prev ? { ...prev, codexEntryId: res.codexEntry.id } : null);
      await loadMeetings();
    } catch (err) {
      toast(`Failed to save to Codex: ${err}`, { kind: 'info' });
    } finally {
      setCodexSaving(false);
    }
  };

  const handleSuggestNames = async () => {
    if (!meeting) return;
    setSuggestingNames(true);
    try {
      const res = await api.secretarySuggestNames(meeting.id);
      const suggestions = res.suggestions || {};
      if (Object.keys(suggestions).length === 0) {
        toast('No obvious names or introductions were detected in the transcript.', { kind: 'info' });
        return;
      }
      const updatedSpeakers = meeting.speakers.map(spk => {
        if (suggestions[spk.id]) {
          return { ...spk, name: suggestions[spk.id] };
        }
        return spk;
      });
      const updatedUtterances = meeting.utterances.map(u => {
        if (suggestions[u.speakerId]) {
          return { ...u, speakerName: suggestions[u.speakerId] };
        }
        return u;
      });
      const updated = await api.patchSecretaryMeeting(meeting.id, {
        speakers: updatedSpeakers,
        utterances: updatedUtterances,
      });
      setMeeting(updated);
    } catch (err) {
      toast(`Name suggestion failed: ${err}`, { kind: 'error' });
    } finally {
      setSuggestingNames(false);
    }
  };

  const handleRediarize = async (numSpeakers?: number) => {
    if (!meeting) return;
    setRediarizing(true);
    try {
      // neural voice prints from the saved audio when there is some; the stored features otherwise (409)
      let updated: Meeting;
      try {
        updated = await req<Meeting>(`/api/secretary/meetings/${meeting.id}/reembed`,
          { method: 'POST', body: JSON.stringify({ numSpeakers, sensitivity: voiceSensitivity }) });
      } catch (e) {
        if (!String(e).startsWith('Error: 409')) throw e;
        updated = await api.secretaryRediarize(meeting.id, numSpeakers, voiceSensitivity);
      }
      setMeeting(updated);
      setRediarizeModalOpen(false);
      await loadMeetings();
    } catch (err) {
      toast(`Could not re-cluster speakers: ${err}`, { kind: 'error' });
    } finally {
      setRediarizing(false);
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !meeting) return;
    setUploadingAudio(true);
    try {
      const updated = await api.secretaryUploadAudio(meeting.id, file);
      setMeeting(updated);
      setLiveDuration(updated.duration);
      setActiveTab('transcript');
      await loadMeetings();
    } catch (err) {
      toast(`File upload failed: ${err}`, { kind: 'error' });
    } finally {
      setUploadingAudio(false);
      e.target.value = '';
    }
  };

  const handleAskMeeting = async () => {
    if (!meeting || !askQuestion.trim()) return;
    setAsking(true);
    setAskAnswer('');
    try {
      const res = await api.secretaryAsk(meeting.id, askQuestion.trim());
      setAskAnswer(res.answer);
    } catch (err) {
      setAskAnswer(`Failed to query meeting: ${err}`);
    } finally {
      setAsking(false);
    }
  };

  const copySummaryMarkdown = () => {
    if (!meeting?.summary) return;
    navigator.clipboard.writeText(meeting.summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportMarkdownFile = () => {
    if (!meeting) return;
    const content = meeting.summary || `# ${meeting.title}\n\nNo summary compiled yet.`;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-summary.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filtered utterances
  const visibleUtterances = (meeting?.utterances || []).filter(u => {
    if (filterSpeaker && u.speakerId !== filterSpeaker) return false;
    if (transcriptSearch && !u.text.toLowerCase().includes(transcriptSearch.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex h-full w-full bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden font-sans">
      {/* ── Left Sidebar (History & Meetings) ─────────────────────────────── */}
      <div className={clsx(
        'border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex flex-col transition-all duration-200 z-20',
        historyOpen ? 'w-80' : 'w-0 md:w-72'
      )}>
        <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] grid place-items-center">
              <AudioLines className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">Secretary</h2>
              <p className="text-[11px] text-[var(--text-muted)]">Meeting Records</p>
            </div>
          </div>
          <button
            onClick={createNewMeeting}
            className="p-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition"
            title="Start New Meeting"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {meetings.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--text-muted)]">
              No recorded meetings yet.
            </div>
          ) : (
            meetings.map(m => {
              const active = meeting?.id === m.id;
              return (
                <div
                  key={m.id}
                  onClick={() => openMeeting(m.id)}
                  className={clsx(
                    'group relative p-2.5 rounded-xl border cursor-pointer transition text-left',
                    active
                      ? 'bg-[var(--bg-primary)] border-[var(--accent)]/50 shadow-sm'
                      : 'border-transparent hover:bg-[var(--bg-primary)]/60 hover:border-[var(--border-subtle)]'
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="text-xs font-medium text-[var(--text-primary)] line-clamp-1">
                      {m.title}
                    </div>
                    <button
                      onClick={e => deleteMeeting(m.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-muted)] hover:text-red-400 transition"
                      title="Delete meeting"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <span>{new Date(m.created * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    <span>•</span>
                    <span>{formatDuration(m.duration)}</span>
                    <span>•</span>
                    <span className="flex items-center gap-0.5">
                      <Users className="w-3 h-3" /> {m.speakerCount}
                    </span>
                    {m.hasSummary && (
                      <span className="ml-auto px-1.5 py-0.5 text-[9px] rounded-md bg-emerald-500/10 text-emerald-400 font-mono">
                        Summary
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Main Workspace ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-full min-w-0 bg-[var(--bg-primary)]">
        {typeof window !== 'undefined' && !window.isSecureContext && !navigator?.mediaDevices && (
          <div className="px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>Secure Context Required:</strong> Browsers restrict live microphone and computer audio capture to HTTPS or localhost. You are currently connected over unencrypted HTTP.
              </span>
            </div>
            <button
              onClick={() => {
                const sec = secureHere();
                if (sec) location.href = sec;
                else location.href = `${SECURE_URL}/#/secretary`;
              }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-500 text-zinc-950 font-semibold text-xs hover:bg-amber-400 transition shadow-sm"
            >
              <span>Switch to Secure HTTPS</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Top Control Bar */}
        <header className="px-6 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {onBack && (
              <button
                onClick={onBack}
                className="p-1.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                title="Back to Shell:B"
              >
                <ChevronRight className="w-4 h-4 rotate-180" />
              </button>
            )}

            <div>
              {editingTitle ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={titleInput}
                    onChange={e => setTitleInput(e.target.value)}
                    onKeyDown={async e => {
                      if (e.key === 'Enter') {
                        if (meeting && titleInput.trim()) {
                          const updated = await api.patchSecretaryMeeting(meeting.id, { title: titleInput.trim() });
                          setMeeting(updated);
                          await loadMeetings();
                        }
                        setEditingTitle(false);
                      } else if (e.key === 'Escape') {
                        setEditingTitle(false);
                      }
                    }}
                    autoFocus
                    className="px-2 py-1 text-sm bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-md text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={async () => {
                      if (meeting && titleInput.trim()) {
                        const updated = await api.patchSecretaryMeeting(meeting.id, { title: titleInput.trim() });
                        setMeeting(updated);
                        await loadMeetings();
                      }
                      setEditingTitle(false);
                    }}
                    className="p-1 text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold tracking-tight text-[var(--text-primary)] truncate max-w-md">
                    {meeting?.title || 'No Meeting Selected'}
                  </h1>
                  {meeting && (
                    <button
                      onClick={() => {
                        setTitleInput(meeting.title);
                        setEditingTitle(true);
                      }}
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-0.5"
                      title="Edit meeting title"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3 mt-0.5 text-xs text-[var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  <span className="font-mono">{formatDuration(liveDuration)}</span>
                </span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {meeting?.speakers.length || 0} Speakers
                </span>
                <span>•</span>
                <span>{meeting?.utterances.length || 0} Turns</span>
              </div>
            </div>
          </div>

          {/* Audio Action Buttons & Live Recording Status */}
          <div className="flex items-center gap-3">
            {/* Live Indicator */}
            {(recState === 'listening' || recState === 'hearing') && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                <span>{recState === 'hearing' ? 'Hearing speech…' : 'Listening…'}</span>
                <span className="font-mono text-[11px] opacity-80">{formatDuration(liveDuration)}</span>
              </div>
            )}

            {recState === 'paused' && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs font-medium">
                <Pause className="w-3 h-3" />
                <span>Paused</span>
              </div>
            )}

            {/* Audio Source Selector (Computer Audio vs Mic vs Both) */}
            {recState === 'idle' && (
              <div className="flex items-center p-0.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-xs">
                <button
                  type="button"
                  onClick={() => setAudioSource('both')}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-medium transition',
                    audioSource === 'both'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                  title="Capture both computer/call audio (Google Meet, Zoom, Teams) and your microphone"
                >
                  <Laptop className="w-3.5 h-3.5" />
                  <span className="text-[10px]">+</span>
                  <Mic className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline text-[11px]">Computer + Mic</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAudioSource('system')}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-medium transition',
                    audioSource === 'system'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                  title="Capture computer / meeting audio only (tab audio or system audio)"
                >
                  <Monitor className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline text-[11px]">Computer Only</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAudioSource('mic')}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-medium transition',
                    audioSource === 'mic'
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                  title="Capture microphone only (in-person meeting)"
                >
                  <Mic className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline text-[11px]">Mic Only</span>
                </button>
              </div>
            )}

            {/* Voice Separation Sensitivity */}
            {recState === 'idle' && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-xs">
                <Sliders className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <span className="hidden xl:inline text-[11px] text-[var(--text-muted)]">Voice Diarization:</span>
                <select
                  value={voiceSensitivity}
                  onChange={e => setVoiceSensitivity(e.target.value as 'strict' | 'balanced' | 'relaxed')}
                  className="bg-transparent text-xs text-[var(--text-primary)] focus:outline-none cursor-pointer"
                  title="Voice identification threshold. Strict splits close voices into different speakers, Relaxed is more forgiving of natural pitch variation."
                >
                  <option value="strict" className="bg-[var(--bg-secondary)]">Strict (Splits Close Voices)</option>
                  <option value="balanced" className="bg-[var(--bg-secondary)]">Balanced (Recommended)</option>
                  <option value="relaxed" className="bg-[var(--bg-secondary)]">Relaxed (Same Voice Variation)</option>
                </select>
              </div>
            )}

            {recState === 'idle' ? (
              <button
                onClick={startRecording}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-500 text-zinc-950 font-medium text-xs hover:bg-sky-400 shadow-sm transition active:scale-95"
                title={
                  audioSource === 'both' ? 'Start capturing computer call audio and your microphone' :
                  audioSource === 'system' ? 'Start capturing computer tab/system audio' :
                  'Start listening with microphone'
                }
              >
                {audioSource === 'system' ? <Monitor className="w-4 h-4" /> : audioSource === 'both' ? <Volume2 className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                <span>
                  {audioSource === 'both' ? 'Start Listening (Both)' : audioSource === 'system' ? 'Listen to Computer' : 'Start Listening'}
                </span>
              </button>
            ) : recState === 'paused' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={resumeRecording}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500 text-zinc-950 font-medium text-xs hover:bg-emerald-400 transition"
                >
                  <Play className="w-4 h-4" />
                  <span>Resume</span>
                </button>
                <button
                  onClick={stopRecording}
                  className="px-3 py-2 rounded-xl border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
                >
                  Stop
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={pauseRecording}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-xs font-medium transition"
                  title="Pause Listening"
                >
                  <Pause className="w-4 h-4" />
                  <span>Pause</span>
                </button>
                <button
                  onClick={stopRecording}
                  className="px-3 py-2 rounded-xl border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs font-medium transition"
                  title="Stop Listening"
                >
                  Stop
                </button>
              </div>
            )}

            {/* Summarize Action */}
            <button
              onClick={handleSummarize}
              disabled={recState === 'summarizing' || !meeting || meeting.utterances.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--accent)] text-xs font-medium text-[var(--text-primary)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {recState === 'summarizing' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                  <span>Compiling Summary…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>{meeting?.summary ? 'Regenerate Summary' : 'Compile Summary'}</span>
                </>
              )}
            </button>

            {/* Upload File */}
            <label
              className={clsx(
                'flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-xs font-medium cursor-pointer transition',
                uploadingAudio && 'opacity-50 pointer-events-none'
              )}
              title="Upload recorded audio (WAV, MP3, M4A, WebM)"
            >
              {uploadingAudio ? (
                <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">Upload Audio</span>
              <input
                type="file"
                accept="audio/*,video/*,.mkv,.mov,.m4v"
                onChange={handleAudioUpload}
                disabled={uploadingAudio}
                className="hidden"
              />
            </label>
          </div>
        </header>

        {/* Live Audio Visualizer Bar */}
        {(recState === 'listening' || recState === 'hearing') && (
          <div className="px-6 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[10px] font-mono uppercase tracking-wider text-[var(--text-secondary)]">
                {audioSource === 'both' ? (
                  <>
                    <Laptop className="w-3 h-3 text-sky-400" />
                    <span>+</span>
                    <Mic className="w-3 h-3 text-emerald-400" />
                    <span>Computer &amp; Mic</span>
                  </>
                ) : audioSource === 'system' ? (
                  <>
                    <Monitor className="w-3 h-3 text-sky-400" />
                    <span>Computer Audio</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-3 h-3 text-emerald-400" />
                    <span>Microphone</span>
                  </>
                )}
              </div>
              <div className="w-40 h-2 bg-zinc-800 rounded-full overflow-hidden flex items-center">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-75"
                  style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
                />
              </div>
            </div>
            <span className="text-[11px] text-[var(--text-muted)]">
              {recState === 'hearing' ? 'Processing speech utterance…' : 'Listening for speakers…'}
            </span>
          </div>
        )}

        {/* Speaker Roster Bar */}
        {meeting && meeting.speakers.length > 0 && (
          <div className="px-6 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/20 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-[var(--text-muted)] font-medium mr-1 flex items-center gap-1">
                <Users className="w-3.5 h-3.5" /> Attendees:
              </span>
              {meeting.speakers.map(spk => {
                const isSelected = filterSpeaker === spk.id;
                return (
                  <div
                    key={spk.id}
                    onClick={() => {
                      setFilterSpeaker(isSelected ? null : spk.id);
                    }}
                    className={clsx(
                      'group flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition',
                      isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: spk.color }} />
                    <span>{spk.name}</span>
                    <span className="text-[10px] text-[var(--text-muted)] opacity-75">
                      ({formatDuration(spk.totalDuration || 0)}{spk.pitch ? ` • ${Math.round(spk.pitch)}Hz` : ''})
                    </span>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        setEditingSpeaker(spk);
                        setSpeakerNameInput(spk.name);
                        setSpeakerColorInput(spk.color);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-[var(--text-primary)]"
                      title="Rename Speaker"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setRediarizeModalOpen(true)}
                disabled={rediarizing || !meeting || meeting.utterances.length < 2}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50"
                title="Re-separate or group speakers based on voice pitch and timbre"
              >
                {rediarizing ? <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" /> : <Split className="w-3 h-3 text-[var(--accent)]" />}
                <span>Separate Voices</span>
              </button>
              <span className="px-2 py-0.5 rounded-md border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]"
                title={meeting.diarizer === 'wespeaker-r34-lm'
                  ? 'Voices told apart by neural voice prints (WeSpeaker, on this machine)'
                  : 'Voices told apart by pitch and timbre only; meetings recorded from now on use neural voice prints'}>
                Voice ID: {meeting.diarizer === 'wespeaker-r34-lm' ? 'neural' : 'basic'}
              </span>

              <button
                onClick={handleSuggestNames}
                disabled={suggestingNames || meeting.utterances.length === 0}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50"
                title="Detect real names mentioned in introductions"
              >
                {suggestingNames ? <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" /> : <Sparkles className="w-3 h-3 text-[var(--accent)]" />}
                <span>Detect Names</span>
              </button>
            </div>
          </div>
        )}

        {/* View Tabs */}
        <div className="px-6 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-secondary)]/10">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab('summary')}
              className={clsx(
                'flex items-center gap-2 px-4 py-3 border-b-2 text-xs font-medium transition',
                activeTab === 'summary'
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Executive Summary</span>
              {meeting?.summary && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              )}
            </button>

            <button
              onClick={() => setActiveTab('actions')}
              className={clsx(
                'flex items-center gap-2 px-4 py-3 border-b-2 text-xs font-medium transition',
                activeTab === 'actions'
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <ListTodo className="w-3.5 h-3.5" />
              <span>Action Items</span>
              {meeting?.summaryData?.actionItems && (
                <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-[var(--bg-tertiary)] font-mono">
                  {meeting.summaryData.actionItems.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('transcript')}
              className={clsx(
                'flex items-center gap-2 px-4 py-3 border-b-2 text-xs font-medium transition',
                activeTab === 'transcript'
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <ListOrdered className="w-3.5 h-3.5" />
              <span>Diarized Transcript</span>
              <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-[var(--bg-tertiary)] font-mono">
                {meeting?.utterances.length || 0}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('ask')}
              className={clsx(
                'flex items-center gap-2 px-4 py-3 border-b-2 text-xs font-medium transition',
                activeTab === 'ask'
                  ? 'border-[var(--accent)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              )}
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Ask Meeting</span>
            </button>
          </div>

          {/* Quick Actions (Copy, Codex, Download) */}
          <div className="flex items-center gap-2">
            {meeting?.summary && (
              <>
                <button
                  onClick={copySummaryMarkdown}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
                  title="Copy full summary to clipboard"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>

                <button
                  onClick={handleSaveToCodex}
                  disabled={codexSaving || !!codexSavedId}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition',
                    codexSavedId
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  )}
                  title="Save meeting summary and transcript into Codex Notes"
                >
                  {codexSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : codexSavedId ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <BookMarked className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span>{codexSavedId ? 'Saved to Codex' : 'Save to Codex'}</span>
                </button>

                <button
                  onClick={exportMarkdownFile}
                  className="p-1.5 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition"
                  title="Export Markdown file"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {/* TAB 1: EXECUTIVE SUMMARY */}
          {activeTab === 'summary' && (
            <div className="max-w-4xl mx-auto space-y-6">
              {!meeting?.summary ? (
                <div className="p-12 text-center border border-dashed border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-secondary)]/30">
                  <AudioLines className="w-10 h-10 mx-auto text-[var(--text-muted)] mb-3 opacity-60" />
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">No Summary Compiled Yet</h3>
                  <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto mt-1 mb-4">
                    {meeting?.utterances.length
                      ? 'Click "Compile Summary" above to generate a structured executive summary with key decisions and action items.'
                      : 'Start listening to record meeting turns or upload an audio file to transcribe.'}
                  </p>
                  {meeting && meeting.utterances.length > 0 && (
                    <button
                      onClick={handleSummarize}
                      className="px-4 py-2 rounded-xl bg-sky-500 text-zinc-950 font-medium text-xs hover:bg-sky-400 transition"
                    >
                      Compile Summary with AI
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Executive Header Card */}
                  <div className="p-6 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-sm">
                    <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-3">
                      <span className="font-mono uppercase tracking-wider text-[10px] text-sky-400 font-semibold">Executive Record</span>
                      <span>{new Date(meeting.created * 1000).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
                    </div>
                    <Markdown text={meeting.summary} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: ACTION ITEMS */}
          {activeTab === 'actions' && (
            <div className="max-w-3xl mx-auto space-y-4">
              {!meeting?.summaryData?.actionItems || meeting.summaryData.actionItems.length === 0 ? (
                <div className="p-12 text-center border border-dashed border-[var(--border-subtle)] rounded-2xl bg-[var(--bg-secondary)]/30 text-xs text-[var(--text-muted)]">
                  No action items identified. Compile the meeting summary to extract tasks and commitments automatically.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      Deliverables & Commitments ({meeting.summaryData.actionItems.length})
                    </h3>
                  </div>

                  <div className="space-y-2">
                    {meeting.summaryData.actionItems.map((item, idx) => {
                      const prioColor = item.priority === 'high' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        item.priority === 'medium' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-zinc-500/10 text-zinc-400 border-zinc-500/20';

                      return (
                        <div
                          key={item.id || idx}
                          className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-start gap-3 transition hover:border-[var(--accent)]/40"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 rounded border-zinc-700 bg-zinc-800 text-[var(--accent)] focus:ring-0"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[var(--text-primary)] leading-relaxed">
                              {item.task}
                            </p>
                            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                              <span className="font-semibold text-[var(--text-secondary)]">
                                Owner: {item.owner}
                              </span>
                              <span>•</span>
                              <span className={clsx('px-1.5 py-0.2 rounded border text-[9px] font-mono uppercase', prioColor)}>
                                {item.priority}
                              </span>
                              {item.deadline && (
                                <>
                                  <span>•</span>
                                  <span className="flex items-center gap-1">
                                    <Calendar className="w-3 h-3" /> {item.deadline}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: DIARIZED TRANSCRIPT */}
          {activeTab === 'transcript' && (
            <div className="max-w-3xl mx-auto space-y-4">
              {/* Search & Filter Header */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    placeholder="Search transcript..."
                    value={transcriptSearch}
                    onChange={e => setTranscriptSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 text-xs bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  {transcriptSearch && (
                    <button
                      onClick={() => setTranscriptSearch('')}
                      className="absolute right-3 top-2.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {filterSpeaker && (
                  <button
                    onClick={() => setFilterSpeaker(null)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-xs text-[var(--text-primary)]"
                  >
                    <span>Filtered</span>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Transcript Speech Turns */}
              {visibleUtterances.length === 0 ? (
                <div className="p-12 text-center text-xs text-[var(--text-muted)] border border-dashed border-[var(--border-subtle)] rounded-2xl">
                  {meeting?.utterances.length
                    ? 'No utterances match your filter criteria.'
                    : 'Transcript is empty. Click "Start Listening" to begin live meeting transcription.'}
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleUtterances.map((u, i) => {
                    const spk = meeting?.speakers.find(s => s.id === u.speakerId);
                    const spkColor = spk?.color || '#38bdf8';

                    return (
                      <div
                        key={u.id || i}
                        className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 hover:bg-[var(--bg-secondary)] transition group"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: spkColor }} />
                            <select
                              value={u.speakerId}
                              onChange={async e => {
                                const newSid = e.target.value;
                                if (!meeting) return;
                                try {
                                  const updated = await api.secretaryReassignUtterance(meeting.id, u.id, newSid);
                                  setMeeting(updated);
                                } catch (err) {
                                  console.error('Failed to reassign speaker:', err);
                                }
                              }}
                              className="text-xs font-semibold text-[var(--text-primary)] bg-transparent hover:bg-[var(--bg-tertiary)] py-0.5 px-1 rounded cursor-pointer border-0 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                              title="Click to reassign this speech turn to another speaker"
                            >
                              {meeting?.speakers.map(s => (
                                <option key={s.id} value={s.id} className="bg-[var(--bg-secondary)] text-[var(--text-primary)]">
                                  {s.name}
                                </option>
                              ))}
                            </select>
                            {u.pitch ? (
                              <span className="text-[10px] font-mono text-[var(--text-muted)] opacity-60">
                                ~{Math.round(u.pitch)}Hz
                              </span>
                            ) : null}
                          </div>
                          <span className="text-[11px] font-mono text-[var(--text-muted)]">
                            {formatDuration(u.start)} – {formatDuration(u.end)}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] leading-relaxed pl-4 border-l-2" style={{ borderColor: `${spkColor}40` }}>
                          {u.text}
                        </p>
                      </div>
                    );
                  })}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
          )}

          {/* TAB 4: ASK MEETING (Q&A) */}
          {activeTab === 'ask' && (
            <div className="max-w-3xl mx-auto space-y-4">
              <div className="p-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  Ask Secretary about this meeting
                </h3>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                  Query key decisions, who agreed to what, technical context, or unresolved blockers grounded directly in the transcript.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={askQuestion}
                    onChange={e => setAskQuestion(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAskMeeting()}
                    placeholder="e.g. What did Speaker 1 say regarding deployment blockers?"
                    className="flex-1 px-3 py-2 text-xs bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={handleAskMeeting}
                    disabled={asking || !askQuestion.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium text-xs hover:opacity-90 transition disabled:opacity-50"
                  >
                    {asking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Ask</span>
                  </button>
                </div>
              </div>

              {askAnswer && (
                <div className="p-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                  <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-[var(--text-primary)]">
                    <Sparkles className="w-4 h-4 text-[var(--accent)]" />
                    <span>Answer</span>
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    <Markdown text={askAnswer} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Edit Speaker Modal ────────────────────────────────────────────── */}
      {editingSpeaker && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 grid place-items-center p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Rename Speaker</h3>
              <button
                onClick={() => setEditingSpeaker(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="text-xs text-[var(--text-muted)] font-medium mb-1 block">Speaker Name</label>
              <input
                type="text"
                value={speakerNameInput}
                onChange={e => setSpeakerNameInput(e.target.value)}
                autoFocus
                className="w-full px-3 py-2 text-xs bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-xl text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div>
              <label className="text-xs text-[var(--text-muted)] font-medium mb-1.5 block">Color</label>
              <div className="flex items-center gap-2 flex-wrap">
                {['#38bdf8', '#fb7185', '#34d399', '#f59e0b', '#a78bfa', '#f472b6', '#2dd4bf', '#fbbf24', '#818cf8', '#4ade80'].map(c => (
                  <button
                    key={c}
                    onClick={() => setSpeakerColorInput(c)}
                    className={clsx(
                      'w-6 h-6 rounded-full transition border-2',
                      speakerColorInput === c ? 'border-white scale-110' : 'border-transparent'
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditingSpeaker(null)}
                className="px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!meeting || !speakerNameInput.trim()) return;
                  const updatedSpeakers = meeting.speakers.map(s =>
                    s.id === editingSpeaker.id
                      ? { ...s, name: speakerNameInput.trim(), color: speakerColorInput }
                      : s
                  );
                  const updatedUtterances = meeting.utterances.map(u =>
                    u.speakerId === editingSpeaker.id
                      ? { ...u, speakerName: speakerNameInput.trim() }
                      : u
                  );
                  const updated = await api.patchSecretaryMeeting(meeting.id, {
                    speakers: updatedSpeakers,
                    utterances: updatedUtterances,
                  });
                  setMeeting(updated);
                  setEditingSpeaker(null);
                }}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium text-xs hover:opacity-90 transition"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Re-separate / Diarize Speakers by Voice */}
      {rediarizeModalOpen && meeting && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Split className="w-5 h-5 text-sky-400" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Separate Speakers by Voice</h3>
              </div>
              <button onClick={() => setRediarizeModalOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Shell:B analyzes acoustic pitch (fundamental frequency F₀), spectral centroid, and 13-band vocal tract timbre (MFCCs) across every speech turn to separate distinct speakers.
            </p>

            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Target Speaker Count (Optional)
                </label>
                <div className="flex items-center gap-2">
                  {[2, 3, 4].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setTargetSpeakerCount(targetSpeakerCount === n ? '' : n)}
                      className={clsx(
                        'flex-1 py-1.5 rounded-xl border text-xs font-medium transition',
                        targetSpeakerCount === n
                          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      )}
                    >
                      {n} Speakers
                    </button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    max={12}
                    placeholder="Auto"
                    value={targetSpeakerCount}
                    onChange={e => setTargetSpeakerCount(e.target.value ? parseInt(e.target.value, 10) : '')}
                    className="w-16 px-2 py-1.5 text-xs text-center border border-[var(--border-subtle)] bg-[var(--bg-primary)] rounded-xl text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <span className="text-[10px] text-[var(--text-muted)] mt-1 block">
                  {targetSpeakerCount
                    ? `Will cluster into exactly ${targetSpeakerCount} distinct participants.`
                    : 'Auto-detect will partition voices dynamically based on acoustic separation threshold.'}
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Voice Sensitivity
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'strict', label: 'Strict', desc: 'Splits close voices' },
                    { id: 'balanced', label: 'Balanced', desc: 'Recommended' },
                    { id: 'relaxed', label: 'Relaxed', desc: 'Allows pitch shift' },
                  ].map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setVoiceSensitivity(t.id as 'strict' | 'balanced' | 'relaxed')}
                      className={clsx(
                        'p-2 rounded-xl border text-left transition',
                        voiceSensitivity === t.id
                          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      )}
                    >
                      <div className="text-xs font-medium">{t.label}</div>
                      <div className="text-[10px] text-[var(--text-muted)]">{t.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-subtle)]">
              <button
                onClick={() => setRediarizeModalOpen(false)}
                className="px-3 py-1.5 rounded-xl border border-[var(--border-subtle)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRediarize(targetSpeakerCount ? Number(targetSpeakerCount) : undefined)}
                disabled={rediarizing}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-sky-500 text-zinc-950 font-medium text-xs hover:bg-sky-400 transition disabled:opacity-50"
              >
                {rediarizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Split className="w-3.5 h-3.5" />}
                <span>Re-cluster Voices</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
