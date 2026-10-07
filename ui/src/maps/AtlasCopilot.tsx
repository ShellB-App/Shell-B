// In-App Atlas Copilot Drawer for Shell:B Worlds.
// An AI planetary navigator and cartographer specialized in solar system exploration,
// IAU craters, terrain traverses, orbital telemetry, and real-time space weather.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Activity,
  Compass,
  CornerDownLeft,
  ExternalLink,
  Flame,
  Globe2,
  Loader2,
  MapPin,
  Maximize2,
  Navigation,
  Orbit,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  StopCircle,
  Trash2,
  X
} from 'lucide-react';
import { api, streamChat } from '../api';
import { earthLink, fmtKm, fmtLight } from './sky';
import { NOTES_CHANGED } from './notes';
import { clockNow, clockState, fmtClock } from './clock';
import { fmtCoord, parseSpec, type MapSpec } from './core';
import { Markdown } from '../components/Markdown';
import type { Landmark } from './landmarks';

interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  mapSpec?: MapSpec | null;
  toolCalls?: string[];
}

interface AtlasCopilotProps {
  isOpen: boolean;
  onClose: () => void;
  bodyId: string;
  bodyName: string;
  viewport: { lat: number; lon: number; zoom: number };
  selectedLandmark: Landmark | null;
  onFlyTo: (target: { lat: number; lon: number; zoom?: number; body?: string }) => void;
  onApplyOverlay: (spec: MapSpec) => void;
  /** A question handed over from elsewhere (e.g. a card's "Ask Atlas"); sent once per new `n`. */
  request?: { text: string; n: number } | null;
}

const STORAGE_KEY = 'shellb.atlas.conv';

export function AtlasCopilot({
  isOpen,
  onClose,
  bodyId,
  bodyName,
  viewport,
  selectedLandmark,
  onFlyTo,
  onApplyOverlay,
  request,
}: AtlasCopilotProps) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // The conversation lives as long as the panel's messages do, so the model never carries context the panel doesn't show.
  const [convId, setConvId] = useState<string | null>(null);

  // Orbital / Space Weather Telemetry Pill
  const [telemetry, setTelemetry] = useState<{ label: string; value: string; detail?: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch telemetry for context header
  useEffect(() => {
    let alive = true;
    if (bodyId === 'earth') {
      fetch('/api/planetary/telemetry?kind=space_weather')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!alive || !d) return;
          setTelemetry({
            label: 'Space Weather',
            value: `Kp ${d.kp_index}`,
            detail: d.geomagnetic_condition
          });
        })
        .catch(() => {});
    } else if (bodyId !== 'sol') {
      const l = earthLink(bodyId);
      setTelemetry(l ? { label: 'From Earth', value: fmtKm(l.km), detail: `Light delay ${fmtLight(l.lightSeconds)}` } : null);
    } else {
      setTelemetry(null);
    }
    return () => {
      alive = false;
    };
  }, [bodyId]);

  // Scroll to bottom when messages update
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;

    setInput('');
    setBusy(true);

    const userMsg: CopilotMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: q
    };

    const assistantId = `a-${Date.now()}`;
    const initialAssistantMsg: CopilotMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
      toolCalls: []
    };

    setMessages(prev => [...prev, userMsg, initialAssistantMsg]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      let activeConv = convId;
      if (!activeConv) {
        const c = await api.createConversation('atlas');
        activeConv = c.id;
        setConvId(activeConv);
      }

      // Build context brief for Atlas
      const contextBrief =
        `[World: ${bodyName} (${bodyId}), Viewport: ${fmtCoord(viewport.lat, viewport.lon)} at zoom ${viewport.zoom.toFixed(1)}` +
        (selectedLandmark ? `, Open card: "${selectedLandmark.name}" (a ${selectedLandmark.kind})` : '') +
        (clockState().live ? '' : `, Map clock set to ${fmtClock(clockNow())} (not now)`) +
        ']';

      const enrichedPrompt = `${contextBrief}\n\n${q}`;

      let fullContent = '';
      const toolsUsed: string[] = [];
      const kinds = new Map<number, string>();  // block index → type; only text blocks belong in the answer
      const texts = new Map<number, string>();
      const answer = () => [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.trim()).filter(Boolean).join('\n\n');

      for await (const ev of streamChat(activeConv, { content: enrichedPrompt, agentId: 'atlas' }, ctrl.signal)) {
        if (ev.type === 'block_delta') {
          if (kinds.get(ev.index) !== 'text') continue;
          texts.set(ev.index, (texts.get(ev.index) ?? '') + ev.text);
          fullContent = answer();
          setMessages(prev =>
            prev.map(m => (m.id === assistantId ? { ...m, content: fullContent } : m))
          );
        } else if (ev.type === 'block_start' && ev.block.type !== 'tool') {
          kinds.set(ev.index, ev.block.type);
          if (ev.block.type === 'text' && ev.block.text) { texts.set(ev.index, ev.block.text); fullContent = answer(); }
        } else if (ev.type === 'error') {
          fullContent = `${fullContent}\n\n*(Atlas hit an error: ${ev.error})*`.trim();
          setMessages(prev => prev.map(m => (m.id === assistantId ? { ...m, content: fullContent } : m)));
        } else if (ev.type === 'block_update' && ev.block.type === 'tool' && ev.block.name === 'annotate_map_feature' && ev.block.status !== 'running') {
          window.dispatchEvent(new Event(NOTES_CHANGED));  // the open card shows what was just added
        } else if (ev.type === 'block_start' && ev.block.type === 'tool') {
          kinds.set(ev.index, 'tool');
          const tname = ev.block.name;
          if (tname && !toolsUsed.includes(tname)) {
            toolsUsed.push(tname);
            setMessages(prev =>
              prev.map(m => (m.id === assistantId ? { ...m, toolCalls: [...toolsUsed] } : m))
            );
          }
        } else if (ev.type === 'done') {
          const final = (ev.message.blocks ?? []).filter(b => b.type === 'text').map(b => (b as { text: string }).text.trim()).filter(Boolean).join('\n\n');
          if (final) fullContent = final;
          const specMatch = /```(?:map|route)\n([\s\S]*?)\n```/.exec(fullContent);
          const parsed = specMatch ? parseSpec(specMatch[1]) : null;

          setMessages(prev =>
            prev.map(m =>
              m.id === assistantId
                ? { ...m, content: fullContent, streaming: false, mapSpec: parsed }
                : m
            )
          );
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        const errorText = `\n\n*(Error communicating with Atlas: ${(err as Error)?.message || 'connection failed'})*`;
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: m.content + errorText, streaming: false }
              : m
          )
        );
      }
    } finally {
      setMessages(prev => prev.map(m => (m.id === assistantId && m.streaming ? { ...m, streaming: false } : m)));
      setBusy(false);
      abortRef.current = null;
    }
  };

  const lastRequest = useRef(0);
  useEffect(() => {
    if (!request || request.n === lastRequest.current || busy) return;
    lastRequest.current = request.n;
    send(request.text);
  }, [request, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const clearChat = () => {
    setMessages([]);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
    setConvId(null);
  };

  if (!isOpen) return null;

  return (
    <div className="w-96 max-w-[calc(100vw-2.5rem)] h-full bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)] flex flex-col min-h-0 text-[12px] shadow-2xl z-20 transition-all">
      {/* Drawer Header */}
      <div className="p-3.5 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/70 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500/20 to-amber-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
            <Compass className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Atlas Copilot</h2>
              <span className="px-1.5 py-px rounded text-[9px] font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
                Cartographer
              </span>
            </div>
            <p className="text-[10px] text-[var(--text-muted)] truncate">
              {bodyName} · {fmtCoord(viewport.lat, viewport.lon)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
              title="Reset conversation"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            title="Close Atlas"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Telemetry Context Bar */}
      <div className="px-3.5 py-2 bg-[var(--bg-tertiary)]/50 border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
          <Globe2 className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-medium text-[var(--text-primary)]">{bodyName}</span>
          <span className="text-[var(--text-muted)]">z{viewport.zoom.toFixed(1)}</span>
        </div>
        {telemetry && (
          <div className="flex items-center gap-1.5 text-[10px]" title={telemetry.detail}>
            <Radio className="w-3 h-3 text-amber-400 animate-pulse" />
            <span className="text-[var(--text-muted)]">{telemetry.label}:</span>
            <span className="font-mono font-medium text-[var(--text-primary)]">{telemetry.value}</span>
          </div>
        )}
      </div>

      {/* Quick Context Action Chips */}
      <div className="p-2 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)]/20 flex gap-1.5 overflow-x-auto no-scrollbar">
        <button
          onClick={() =>
            send(
              `What prominent IAU craters, mountains or geographical features are near my current view (${fmtCoord(viewport.lat, viewport.lon)}) on ${bodyName}? Search the planetary gazetteer.`
            )
          }
          disabled={busy}
          className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] whitespace-nowrap transition flex items-center gap-1"
        >
          <Sparkles className="w-3 h-3 text-amber-400" /> Nearby Features
        </button>

        <button
          onClick={() =>
            send(
              `What historic space exploration missions or robotic landers have touched down on ${bodyName}? Show their landing coordinates and what they found.`
            )
          }
          disabled={busy}
          className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] whitespace-nowrap transition flex items-center gap-1"
        >
          <MapPin className="w-3 h-3 text-red-400" /> Landing Missions
        </button>

        {bodyId === 'earth' ? (
          <button
            onClick={() =>
              send(
                `Check live space weather (NOAA Kp index & aurora) and recent global earthquakes from the telemetry feed.`
              )
            }
            disabled={busy}
            className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] whitespace-nowrap transition flex items-center gap-1"
          >
            <Activity className="w-3 h-3 text-emerald-400" /> Space Weather & Quakes
          </button>
        ) : (
          <button
            onClick={() =>
              send(
                `Calculate the current distance from Earth to ${bodyName}, light-speed radio communication delay, and Hohmann transfer window delta-v.`
              )
            }
            disabled={busy}
            className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] whitespace-nowrap transition flex items-center gap-1"
          >
            <Orbit className="w-3 h-3 text-purple-400" /> Orbital Telemetry
          </button>
        )}

        <button
          onClick={() =>
            send(
              `Propose an exploratory rover traverse starting near my current coordinates (${fmtCoord(viewport.lat, viewport.lon)}) on ${bodyName}. Include scientific waypoints in a map block.`
            )
          }
          disabled={busy}
          className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] whitespace-nowrap transition flex items-center gap-1"
        >
          <Navigation className="w-3 h-3 text-sky-400" /> Plan Traverse
        </button>
      </div>

      {/* Messages Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[var(--text-muted)] space-y-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-sky-500/10 to-amber-500/10 border border-[var(--border-subtle)] flex items-center justify-center text-sky-400">
              <Compass className="w-6 h-6" />
            </div>
            <div>
              <p className="font-medium text-[var(--text-primary)] text-[13px]">Atlas Navigator</p>
              <p className="text-[11px] mt-1 max-w-[240px]">
                I can locate craters, inspect physical terrain, calculate orbital transfer windows, and plot expedition
                traverses across {bodyName}.
              </p>
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] space-y-1.5 w-full">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block text-left px-1">
                Suggested Missions:
              </span>
              {(bodyId === 'mars' ? [
                'Where is Olympus Mons and how big is its caldera?',
                'Plan a 15 km rover traverse from Jezero crater to Jezero Mons',
                'What does the local sky look like right now from Gale crater?'
              ] : bodyId === 'moon' ? [
                'Show Apollo 11 landing site and nearby features',
                'Plan an expedition from Shackleton crater along the lunar South Pole',
                'What can an observer see in the sky from Tranquility Base?'
              ] : [
                `What are the most prominent geological landmarks on ${bodyName}?`,
                `Calculate orbital transfer duration and delta-v from Earth to ${bodyName}`,
                'Check real-time solar space weather and geomagnetic conditions'
              ]).map((sug, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => send(sug)}
                  className="w-full text-left p-2 rounded-lg bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-sky-500/40 text-[11px] text-[var(--text-secondary)] hover:text-sky-300 transition flex items-center justify-between group"
                >
                  <span className="truncate pr-2">💡 {sug}</span>
                  <CornerDownLeft className="w-3 h-3 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className={clsx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-sky-600 text-white px-3 py-2 text-[12px] shadow-sm">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[95%] space-y-2">
                {/* Tool calls indicators */}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {m.toolCalls.map(tc => (
                      <span
                        key={tc}
                        className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-sky-400 flex items-center gap-1"
                      >
                        <Compass className="w-2.5 h-2.5" /> {tc}
                      </span>
                    ))}
                  </div>
                )}

                {/* Assistant Markdown Body */}
                <div className="p-3 rounded-2xl rounded-tl-sm bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[12px] leading-relaxed shadow-sm">
                  <Markdown text={m.content} streaming={m.streaming} />
                </div>

                {/* Interactive Fly-To Action Card */}
                {m.mapSpec && (
                  <div className="p-2.5 rounded-xl border border-sky-500/30 bg-sky-950/20 text-[11px] flex items-center justify-between gap-2 shadow-sm">
                    <div className="min-w-0">
                      <div className="font-semibold text-sky-300 truncate">
                        🗺️ {m.mapSpec.title ?? 'Suggested Exploration Site'}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">
                        {m.mapSpec.markers?.length ?? 0} markers · {m.mapSpec.lines?.length ?? 0} path segments
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (m.mapSpec) {
                          onApplyOverlay(m.mapSpec);
                          if (m.mapSpec.center) {
                            onFlyTo({
                              lat: m.mapSpec.center.lat,
                              lon: m.mapSpec.center.lon,
                              zoom: m.mapSpec.zoom ?? 7,
                              body: m.mapSpec.body
                            });
                          } else if (m.mapSpec.markers?.[0]) {
                            onFlyTo({
                              lat: m.mapSpec.markers[0].lat,
                              lon: m.mapSpec.markers[0].lon,
                              zoom: m.mapSpec.zoom ?? 7,
                              body: m.mapSpec.body
                            });
                          }
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-white font-medium text-[11px] transition shrink-0 flex items-center gap-1 shadow"
                    >
                      <Navigation className="w-3 h-3" /> Fly Camera
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick Capability Chips */}
      <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] flex items-center gap-1.5 overflow-x-auto text-[11px] scrollbar-none bg-[var(--bg-primary)]/40">
        <button
          type="button"
          disabled={busy}
          onClick={() => send(`Plan an exploration traverse across ${bodyName} from current coordinates (${viewport.lat.toFixed(2)}, ${viewport.lon.toFixed(2)})`)}
          className="px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-amber-300 border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 transition"
        >
          <Navigation className="w-3 h-3 text-amber-400" />
          <span>Plan Traverse</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send(`Simulate the local sky and visible celestial targets from ${viewport.lat.toFixed(2)}, ${viewport.lon.toFixed(2)} on ${bodyName}`)}
          className="px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-sky-300 border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 transition"
        >
          <Sparkles className="w-3 h-3 text-sky-400" />
          <span>Local Sky</span>
        </button>
        {bodyId !== 'earth' && bodyId !== 'sol' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send(`Calculate orbital ephemeris, distance, and Hohmann transfer window to ${bodyName}`)}
            className="px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-emerald-300 border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 transition"
          >
            <Orbit className="w-3 h-3 text-emerald-400" />
            <span>Transfer Δv</span>
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => send('Check live planetary space weather and NOAA geomagnetic Kp index')}
          className="px-2 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-rose-300 border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 transition"
        >
          <Activity className="w-3 h-3 text-rose-400" />
          <span>Space Weather</span>
        </button>
      </div>

      {/* Composer Input Bar */}
      <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)]/60">
        <form
          onSubmit={e => {
            e.preventDefault();
            send(input);
          }}
          className="relative flex items-center"
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={`Ask Atlas about ${bodyName}, coordinates, routes…`}
            disabled={busy}
            className="w-full pl-3 pr-16 py-2 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] focus:border-sky-500 focus:outline-none text-[12px] text-[var(--text-primary)] placeholder-[var(--text-muted)] transition"
          />
          <div className="absolute right-1.5 flex items-center gap-1">
            {busy ? (
              <button
                type="button"
                onClick={handleStop}
                className="p-1 rounded-lg text-rose-400 hover:bg-rose-500/10 transition"
                title="Stop generation"
              >
                <StopCircle className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-1 rounded-lg text-sky-400 hover:bg-sky-500/10 disabled:opacity-30 disabled:hover:bg-transparent transition"
                title="Send message"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
