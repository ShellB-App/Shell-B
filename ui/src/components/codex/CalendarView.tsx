import { useState, useRef } from 'react';
import clsx from 'clsx';
import {
  Cake,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  MapPin,
  Plus,
  Sparkles,
  Users, Upload, Download } from 'lucide-react';
import { api } from '../../api';
import { toastError } from '../toast';
import type { CodexEntry } from '../../types';
import { btn } from '../common';
import { ContactAvatar } from './ContactAvatar';

/** Does the event fall on this day? Daily, weekly, monthly and yearly repeats are expanded here (from the first
 * date on); a custom RRULE is only expanded by the server (codex_sync.occurrences), so it shows on its first date. */
function eventMatchesDate(e: CodexEntry, targetDateStr: string): boolean {
  const m = e.meta || {};
  const d = m.date || (m as any).startDate;
  if (!d) return false;
  if (d === targetDateStr) return true;
  if (m.recurrence === 'yearly') {
    const targetMMDD = targetDateStr.slice(5);
    const eventMMDD = d.length === 5 ? d : d.slice(5);
    if (targetMMDD === eventMMDD) return true;
  }
  if (d.length !== 10 || targetDateStr < d) return false;
  if (m.recurrence === 'daily') return true;
  if (m.recurrence === 'weekly') {
    const days = Math.round((Date.UTC(+targetDateStr.slice(0, 4), +targetDateStr.slice(5, 7) - 1, +targetDateStr.slice(8)) - Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8))) / 86400000);
    return days % 7 === 0;
  }
  if (m.recurrence === 'monthly') return targetDateStr.slice(8) === d.slice(8);
  return false;
}
const repeats = (e: CodexEntry) => !!e.meta?.recurrence && e.meta.recurrence !== 'none';

/** Interactive Month Calendar & Agenda Timeline View. */
export function CalendarView({
  events,
  contacts = [],
  selectedDate,
  onSelectDate,
  onOpenEvent,
  onOpenContact,
  onCreateEvent,
  onAutoPopulate,
  populating,
  onImported,
}: {
  events: CodexEntry[];
  contacts?: CodexEntry[];
  selectedDate: string;
  onSelectDate: (d: string) => void;
  onOpenEvent: (e: CodexEntry) => void;
  onOpenContact?: (c: CodexEntry) => void;
  onCreateEvent: (d?: string) => void;
  onAutoPopulate?: () => void;
  populating?: boolean;
  /** after an .ics import: reload the entries */
  onImported?: (r: { added: number; updated: number; total: number }) => void;
}) {
  const icsInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const importIcs = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    try { onImported?.(await api.importCodexIcs(files)); } catch (e) { toastError('Import failed')(e); } finally { setImporting(false); }
  };
  const [viewMonth, setViewMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [mode, setMode] = useState<'grid' | 'agenda'>('grid');

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const prevMonth = () => setViewMonth(new Date(year, month - 1, 1));
  const nextMonth = () => setViewMonth(new Date(year, month + 1, 1));
  const goToday = () => {
    const now = new Date();
    setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    const pad = (n: number) => String(n).padStart(2, '0');
    onSelectDate(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  };

  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Grid days
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 is Sunday
  const startOffset = (firstDayOfWeek + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  interface DayCell {
    dateStr: string;
    dayNum: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
    events: CodexEntry[];
    birthdays: CodexEntry[];
  }

  const findBirthdays = (dateStr: string) => {
    return contacts.filter(c => {
      const b = c.meta?.birthday;
      if (!b) return false;
      const targetMMDD = dateStr.slice(5);
      const bdayMMDD = b.length === 5 ? b : b.slice(5);
      return targetMMDD === bdayMMDD;
    });
  };

  const cells: DayCell[] = [];
  // Prev month padding
  for (let i = startOffset - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const prevM = month === 0 ? 12 : month;
    const prevY = month === 0 ? year - 1 : year;
    const dateStr = `${prevY}-${pad(prevM)}-${pad(dayNum)}`;
    const dayEvents = events.filter(e => eventMatchesDate(e, dateStr));
    const dayBirthdays = findBirthdays(dateStr);
    cells.push({ dateStr, dayNum, isCurrentMonth: false, isToday: dateStr === todayStr, isSelected: dateStr === selectedDate, events: dayEvents, birthdays: dayBirthdays });
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
    const dayEvents = events.filter(e => eventMatchesDate(e, dateStr));
    const dayBirthdays = findBirthdays(dateStr);
    cells.push({ dateStr, dayNum: d, isCurrentMonth: true, isToday: dateStr === todayStr, isSelected: dateStr === selectedDate, events: dayEvents, birthdays: dayBirthdays });
  }
  // Next month padding to reach 35 or 42
  const targetTotal = cells.length > 35 ? 42 : 35;
  const remaining = targetTotal - cells.length;
  for (let d = 1; d <= remaining; d++) {
    const nextM = month === 11 ? 1 : month + 2;
    const nextY = month === 11 ? year + 1 : year;
    const dateStr = `${nextY}-${pad(nextM)}-${pad(d)}`;
    const dayEvents = events.filter(e => eventMatchesDate(e, dateStr));
    const dayBirthdays = findBirthdays(dateStr);
    cells.push({ dateStr, dayNum: d, isCurrentMonth: false, isToday: dateStr === todayStr, isSelected: dateStr === selectedDate, events: dayEvents, birthdays: dayBirthdays });
  }

  const selectedEvents = events.filter(e => eventMatchesDate(e, selectedDate));
  const selectedBirthdays = findBirthdays(selectedDate);

  // Agenda groups
  const sortedEvents = [...events].sort((a, b) => {
    const da = a.meta?.date || (a.meta as any)?.startDate || '9999-99-99';
    const db = b.meta?.date || (b.meta as any)?.startDate || '9999-99-99';
    if (da !== db) return da.localeCompare(db);
    return (a.meta?.time || '00:00').localeCompare(b.meta?.time || '00:00');
  });

  const upcomingEvents = sortedEvents.filter(e => {
    const d = e.meta?.date || (e.meta as any)?.startDate;
    if (!d) return true;
    if (repeats(e)) return true;
    return d >= todayStr;
  });
  const pastEvents = sortedEvents.filter(e => {
    const d = e.meta?.date || (e.meta as any)?.startDate;
    return d && d < todayStr && !repeats(e);
  });

  return (
    <div className="space-y-4">
      {events.length === 0 && contacts.length === 0 && onAutoPopulate && (
        <div className="p-4 rounded-xl border border-orange-500/30 bg-orange-500/5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-orange-400 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />No events or calendar items yet
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              Extract birthdays, anniversaries, and scheduled milestones from your memories automatically.
            </div>
          </div>
          <button className={btn.primary} onClick={onAutoPopulate} disabled={populating}>
            {populating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Auto-populate from Memories
          </button>
        </div>
      )}

      {/* Calendar Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-bold tracking-tight min-w-[180px]">{monthLabel}</h2>
          <button className={btn.icon} onClick={prevMonth} aria-label="Previous month"><ChevronLeft className="w-4 h-4" /></button>
          <button className={btn.icon} onClick={nextMonth} aria-label="Next month"><ChevronRight className="w-4 h-4" /></button>
          <button className={clsx(btn.subtle, 'text-xs px-2 py-1')} onClick={goToday}>Today</button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center p-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-xs">
            <button onClick={() => setMode('grid')}
              className={clsx('px-2.5 py-1 rounded-md transition', mode === 'grid' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              Month Grid
            </button>
            <button onClick={() => setMode('agenda')}
              className={clsx('px-2.5 py-1 rounded-md transition', mode === 'agenda' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
              Agenda
            </button>
          </div>
          <button className={clsx(btn.primary, 'bg-orange-600 hover:bg-orange-500 text-white border-transparent')} onClick={() => onCreateEvent(selectedDate)}>
            <Plus className="w-3.5 h-3.5" />New Event
          </button>
          <button className={btn.subtle} onClick={() => icsInput.current?.click()} disabled={importing} title="Import events from an .ics file (Google, Apple, Outlook exports; repeats and reminders come along)">
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Import .ics
          </button>
          <input ref={icsInput} type="file" accept=".ics,text/calendar" multiple hidden onChange={e => { importIcs([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <a className={btn.subtle} href="/api/codex/calendar.ics" download="shellb-calendar.ics" title="Every event as one .ics file; open it in another calendar app">
            <Download className="w-3.5 h-3.5" />Export .ics
          </a>
        </div>
      </div>

      {mode === 'grid' ? (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden shadow-sm">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-center text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] py-2">
            <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
          </div>
          {/* Days grid */}
          <div className="grid grid-cols-7 divide-x divide-y divide-[var(--border-subtle)]">
            {cells.map(c => (
              <div key={c.dateStr} onClick={() => onSelectDate(c.dateStr)}
                className={clsx('min-h-[84px] sm:min-h-[100px] p-1.5 flex flex-col transition cursor-pointer',
                  c.isCurrentMonth ? 'bg-[var(--bg-secondary)]' : 'bg-[var(--bg-primary)]/40 opacity-40',
                  c.isSelected && 'ring-2 ring-inset ring-[var(--accent)] bg-[var(--bg-hover)]',
                  'hover:bg-[var(--bg-hover)]')}>
                <div className="flex items-center justify-between">
                  <span className={clsx('text-xs font-medium w-6 h-6 rounded-full flex items-center justify-center',
                    c.isToday ? 'bg-[var(--accent)] text-[var(--accent-fg)] font-bold' : 'text-[var(--text-secondary)]')}>
                    {c.dayNum}
                  </span>
                  {(c.events.length > 0 || c.birthdays.length > 0) && (
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">
                      {c.events.length + c.birthdays.length}
                    </span>
                  )}
                </div>
                <div className="flex-1 space-y-1 mt-1 overflow-hidden">
                  {/* Birthdays on this day */}
                  {c.birthdays.map(b => (
                    <div key={b.id} onClick={e => { e.stopPropagation(); onOpenContact ? onOpenContact(b) : onSelectDate(c.dateStr); }}
                      className="px-1.5 py-0.5 rounded text-[11px] font-medium truncate bg-teal-500/15 text-teal-400 border border-teal-500/25 hover:bg-teal-500/25 transition flex items-center gap-1"
                      title={`${b.title}'s Birthday`}>
                      <Cake className="w-3 h-3 shrink-0" />
                      <span className="truncate">{b.title}</span>
                    </div>
                  ))}

                  {/* Events on this day */}
                  {c.events.slice(0, Math.max(1, 3 - c.birthdays.length)).map(ev => (
                    <div key={ev.id} onClick={e => { e.stopPropagation(); onOpenEvent(ev); }}
                      className="px-1.5 py-0.5 rounded text-[11px] font-medium truncate bg-orange-500/15 text-orange-400 border border-orange-500/25 hover:bg-orange-500/25 transition">
                      {ev.meta?.time && <span className="font-mono text-[10px] mr-1">{ev.meta.time}</span>}
                      {ev.title}
                    </div>
                  ))}
                  {c.events.length + c.birthdays.length > 3 && (
                    <span className="text-[10px] text-[var(--text-muted)] block pl-1">
                      +{c.events.length + c.birthdays.length - 3} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Selected date panel */}
          {selectedDate && (
            <div className="p-4 border-t border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/50">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  Schedule for {new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                </span>
                <button className={btn.subtle} onClick={() => onCreateEvent(selectedDate)}>
                  <Plus className="w-3.5 h-3.5 text-orange-400" />Add event on this date
                </button>
              </div>

              {selectedEvents.length === 0 && selectedBirthdays.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">No events scheduled for this day.</p>
              ) : (
                <div className="space-y-2">
                  {/* Birthdays on selected date */}
                  {selectedBirthdays.map(b => (
                    <div key={b.id} onClick={() => onOpenContact?.(b)}
                      className="flex items-center justify-between p-2.5 rounded-xl border border-teal-500/30 bg-teal-500/10 hover:bg-teal-500/20 cursor-pointer transition">
                      <div className="flex items-center gap-3">
                        <ContactAvatar name={b.title} avatar={b.meta?.avatar} size="sm" shape="circle" />
                        <div>
                          <div className="text-sm font-medium text-teal-400 flex items-center gap-1.5">
                            <Cake className="w-3.5 h-3.5" />{b.title}’s Birthday
                          </div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {[b.meta?.role, b.meta?.company].filter(Boolean).join(' · ') || 'Contact in Codex'}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-teal-400/60" />
                    </div>
                  ))}

                  {/* Scheduled events on selected date */}
                  {selectedEvents.map(ev => (
                    <div key={ev.id} onClick={() => onOpenEvent(ev)}
                      className="flex items-center justify-between p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer transition">
                      <div className="flex items-center gap-3">
                        <span className="w-2 h-2 rounded-full bg-orange-400" />
                        <div>
                          <div className="text-sm font-medium">{ev.title}</div>
                          <div className="text-xs text-[var(--text-muted)] flex flex-wrap items-center gap-2 mt-0.5">
                            {ev.meta?.allDay ? 'All day' : ev.meta?.time ? `${ev.meta.time}${ev.meta.endTime ? ` – ${ev.meta.endTime}` : ''}` : ''}
                            {ev.meta?.location && <span>· {ev.meta.location}</span>}
                            {ev.meta?.attendees && ev.meta.attendees.length > 0 && (
                              <span className="flex items-center gap-1.5 flex-wrap">
                                <Users className="w-3 h-3 text-[var(--text-muted)]" />
                                {ev.meta.attendees.map(a => {
                                  const mc = contacts.find(c => c.title.toLowerCase() === a.toLowerCase());
                                  return (
                                    <span key={a} className="inline-flex items-center gap-1 bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[11px]">
                                      {mc && <ContactAvatar name={mc.title} avatar={mc.meta?.avatar} size="xs" shape="circle" />}
                                      <span>{a}</span>
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Agenda view */
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] px-1">Upcoming Events & Milestones ({upcomingEvents.length})</h3>
            {upcomingEvents.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                No upcoming events found.
              </div>
            ) : (
              upcomingEvents.map(ev => {
                const d = ev.meta?.date || (ev.meta as any)?.startDate || '';
                const parts = d.split('-');
                const mo = parts.length >= 2 ? parts[parts.length - 2] : '';
                const dy = parts.length >= 1 ? parts[parts.length - 1] : '';
                const monthName = mo ? ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][parseInt(mo, 10) - 1] : '';

                return (
                  <div key={ev.id} onClick={() => onOpenEvent(ev)}
                    className="flex items-start gap-3 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer transition">
                    <div className="w-12 h-12 rounded-xl flex flex-col items-center justify-center bg-orange-500/10 border border-orange-500/25 text-orange-400 shrink-0 font-mono">
                      <span className="text-[9px] font-bold uppercase">{monthName}</span>
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{dy || '--'}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate">{ev.title}</span>
                        {ev.meta?.recurrence === 'yearly' && (
                          <span className="px-1.5 py-px rounded text-[10px] uppercase font-mono bg-orange-500/10 text-orange-400 border border-orange-500/25">Yearly</span>
                        )}
                        {ev.meta?.status && ev.meta.status !== 'confirmed' && (
                          <span className="px-1.5 py-px rounded text-[10px] uppercase font-mono bg-zinc-500/15 text-zinc-400 border border-zinc-500/30">{ev.meta.status}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)] mt-1">
                        {ev.meta?.allDay ? 'All day' : ev.meta?.time ? <span className="flex items-center gap-1 font-mono"><Clock className="w-3 h-3 text-orange-400" />{ev.meta.time}{ev.meta.endTime ? ` – ${ev.meta.endTime}` : ''}</span> : null}
                        {ev.meta?.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-orange-400" />{ev.meta.location}</span>}
                        {ev.meta?.attendees && ev.meta.attendees.length > 0 && (
                          <span className="flex items-center gap-1.5 flex-wrap">
                            <Users className="w-3 h-3 text-[var(--text-muted)]" />
                            {ev.meta.attendees.map(a => {
                              const mc = contacts.find(c => c.title.toLowerCase() === a.toLowerCase());
                              return (
                                <span key={a} className="inline-flex items-center gap-1 bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[11px]">
                                  {mc && <ContactAvatar name={mc.title} avatar={mc.meta?.avatar} size="xs" shape="circle" />}
                                  <span>{a}</span>
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </div>
                      {ev.body && <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">{ev.body}</p>}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {pastEvents.length > 0 && (
            <div className="space-y-2 pt-4 border-t border-[var(--border-subtle)]">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] px-1">Past Events ({pastEvents.length})</h3>
              {pastEvents.map(ev => (
                <div key={ev.id} onClick={() => onOpenEvent(ev)}
                  className="flex items-center justify-between p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 hover:bg-[var(--bg-hover)] cursor-pointer transition opacity-70 hover:opacity-100">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-[var(--text-muted)]">{ev.meta?.date || (ev.meta as any)?.startDate}</span>
                    <span className="text-sm font-medium text-[var(--text-secondary)]">{ev.title}</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
