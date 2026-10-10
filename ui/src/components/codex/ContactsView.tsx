import { useMemo, useState, useRef } from 'react';
import clsx from 'clsx';
import {
  Briefcase, Building, Cake, ExternalLink, LayoutGrid, List,
  Loader2, Mail, MapPin, Phone, Pin, Plus, Search, Sparkles, User, X, Upload, Download, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { toastError } from '../toast';
import type { CodexEntry } from '../../types';
import { btn, relTime } from '../common';
import { ContactAvatar } from './ContactAvatar';
import { CodexRow } from './CodexRow';
import { t as tx } from '../../i18n';

function calculateDaysUntilBirthday(bdayStr?: string): number | null {
  if (!bdayStr) return null;
  const parts = bdayStr.split('-');
  let month = 0;
  let day = 0;
  if (parts.length === 3) {
    month = parseInt(parts[1], 10) - 1;
    day = parseInt(parts[2], 10);
  } else if (parts.length === 2) {
    month = parseInt(parts[0], 10) - 1;
    day = parseInt(parts[1], 10);
  } else return null;

  if (isNaN(month) || isNaN(day)) return null;
  const now = new Date();
  const currentYear = now.getFullYear();
  let nextBday = new Date(currentYear, month, day);
  const today = new Date(currentYear, now.getMonth(), now.getDate());
  if (nextBday < today) {
    nextBday = new Date(currentYear + 1, month, day);
  }
  const diffMs = nextBday.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function ContactsView({
  contacts,
  agentNames,
  onOpenContact,
  onCreateContact,
  onAutoPopulate,
  populating,
  onAccept,
  onDiscard,
  onPin,
  onImported,
  onSync,
}: {
  contacts: CodexEntry[];
  agentNames: Record<string, string>;
  onOpenContact: (e: CodexEntry) => void;
  onCreateContact: () => void;
  onAutoPopulate: () => void;
  populating: boolean;
  onAccept: (e: CodexEntry) => void;
  onDiscard: (e: CodexEntry) => void;
  onPin: (e: CodexEntry) => void;
  /** after a .vcf import: reload the entries */
  onImported?: (r: { added: number; updated: number; total: number }) => void;
  /** open the CardDAV sync accounts dialog */
  onSync?: () => void;
}) {
  const vcfInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const importVcf = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    try { onImported?.(await api.importCodexVcf(files)); } catch (e) { toastError(tx('Import failed'))(e); } finally { setImporting(false); }
  };
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return (localStorage.getItem('codex_contacts_view') as 'grid' | 'list') || 'grid';
    } catch {
      return 'grid';
    }
  });
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const setMode = (m: 'grid' | 'list') => {
    setViewMode(m);
    try {
      localStorage.setItem('codex_contacts_view', m);
    } catch {}
  };

  // Collect all unique tags
  const allTags = useMemo(() => {
    const s = new Set<string>();
    contacts.forEach(c => c.tags.forEach(t => s.add(t)));
    return Array.from(s).sort();
  }, [contacts]);

  // Filtered contacts
  const filtered = useMemo(() => {
    let list = contacts;
    if (selectedTag) {
      list = list.filter(c => c.tags.includes(selectedTag));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(c => {
        const title = (c.title || '').toLowerCase();
        const role = (c.meta?.role || '').toLowerCase();
        const comp = (c.meta?.company || '').toLowerCase();
        const email = (c.meta?.email || '').toLowerCase();
        const phone = (c.meta?.phone || '').toLowerCase();
        const loc = (c.meta?.location || '').toLowerCase();
        const body = (c.body || '').toLowerCase();
        const tags = c.tags.join(' ').toLowerCase();
        return (
          title.includes(q) ||
          role.includes(q) ||
          comp.includes(q) ||
          email.includes(q) ||
          phone.includes(q) ||
          loc.includes(q) ||
          body.includes(q) ||
          tags.includes(q)
        );
      });
    }
    return list;
  }, [contacts, search, selectedTag]);

  return (
    <div className="space-y-4">
      {/* Action / Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            className={clsx(btn.input, 'pl-9 w-full')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tx('Search people by name, role, company, email, location...')}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* View Switcher (Grid vs List) */}
        <div className="flex items-center p-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <button
            onClick={() => setMode('grid')}
            className={clsx(
              'p-1.5 rounded-md transition',
              viewMode === 'grid'
                ? 'bg-[var(--bg-hover)] text-teal-400 font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            )}
            title={tx('Card Grid view')}
            aria-label={tx('Grid view')}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setMode('list')}
            className={clsx(
              'p-1.5 rounded-md transition',
              viewMode === 'list'
                ? 'bg-[var(--bg-hover)] text-teal-400 font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            )}
            title={tx('Compact List view')}
            aria-label={tx('List view')}
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        {/* Action Buttons */}
        <button
          className={clsx(btn.primary, 'bg-teal-600 hover:bg-teal-500 text-white border-transparent')}
          onClick={onCreateContact}
        >
          <Plus className="w-3.5 h-3.5" />{tx('New Contact')}
        </button>

        <button
          className={clsx(btn.subtle, 'text-amber-400 border-amber-500/30 hover:bg-amber-500/10')}
          onClick={onAutoPopulate}
          disabled={populating}
          title={tx('Extract people and contact details from memories')}
        >
          {populating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {tx('Auto-populate')}
        </button>
        <button className={btn.subtle} onClick={() => vcfInput.current?.click()} disabled={importing} title={tx('Import people from a .vcf file (phone, Google or Outlook contacts export)')}>
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{tx('Import .vcf')}
        </button>
        <input ref={vcfInput} type="file" accept=".vcf,text/vcard,text/x-vcard" multiple hidden onChange={e => { importVcf([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <a className={btn.subtle} href="/api/codex/contacts.vcf" download="shellb-contacts.vcf" title={tx('Every contact as a vCard file for your phone or another address book')}>
          <Download className="w-3.5 h-3.5" />{tx('Export .vcf')}
        </a>
        {onSync && <button className={btn.subtle} onClick={onSync} title={tx('Keep a CardDAV address book in step with these contacts')}><RefreshCw className="w-3.5 h-3.5" />{tx('Sync…')}</button>}
      </div>

      {/* Tag Filters */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            onClick={() => setSelectedTag(null)}
            className={clsx(
              'px-2.5 py-1 rounded-lg border transition',
              selectedTag === null
                ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-[var(--accent)]/60 font-medium'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            {tx('All contacts ({length})', { length: contacts.length })}
          </button>
          {allTags.map(t => (
            <button
              key={t}
              onClick={() => setSelectedTag(selectedTag === t ? null : t)}
              className={clsx(
                'px-2.5 py-1 rounded-lg border transition flex items-center gap-1',
                selectedTag === t
                  ? 'bg-teal-500/15 text-teal-400 border-teal-500/40 font-medium'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              #{t}
              {selectedTag === t && <X className="w-3 h-3" />}
            </button>
          ))}
        </div>
      )}

      {/* Content Render */}
      {contacts.length === 0 ? (
        <div className="p-10 text-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-teal-500/10 border border-teal-500/25 text-teal-400 flex items-center justify-center mx-auto">
            <User className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-base font-semibold">{tx('No contacts saved yet')}</h3>
            <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto mt-1">
              {tx('Store friends, colleagues, family, and team members with photos, contact details, and notes. Agents refer to contacts when you mention people.')}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <button className={btn.primary} onClick={onAutoPopulate} disabled={populating}>
              {populating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {tx('Auto-populate from Memories')}
            </button>
            <button className={btn.subtle} onClick={onCreateContact}>
              <Plus className="w-3.5 h-3.5" />{tx('New Contact')}
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-sm text-[var(--text-muted)]">
          <User className="w-8 h-8 mx-auto mb-2 text-teal-400/50" />
          {tx('No contacts match “')}{search || selectedTag}”.
        </div>
      ) : viewMode === 'grid' ? (
        /* Cards Directory Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filtered.map(c => {
            const m = c.meta || {};
            const daysUntilBday = calculateDaysUntilBirthday(m.birthday);
            const isUpcomingBday = daysUntilBday !== null && daysUntilBday <= 30;

            return (
              <div
                key={c.id}
                onClick={() => onOpenContact(c)}
                role="button"
                tabIndex={0}
                onKeyDown={ev => { if (ev.key === 'Enter') onOpenContact(c); }}
                className={clsx(
                  'group text-left p-4 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between space-y-3',
                  'border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-teal-500/40 hover:bg-[var(--bg-hover)] hover:shadow-sm'
                )}
              >
                {/* Card Top: Avatar, Name, Role, Pin */}
                <div>
                  <div className="flex items-start gap-3">
                    <ContactAvatar
                      name={c.title}
                      avatar={m.avatar}
                      size="lg"
                      shape="square"
                      className="group-hover:scale-105 transition-transform"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-semibold truncate group-hover:text-teal-400 transition-colors">
                          {tx(c.title)}
                        </span>
                        <div className="flex items-center gap-1 shrink-0" onClick={ev => ev.stopPropagation()}>
                          {c.draft ? (
                            <span className="px-1.5 py-px rounded border text-[10px] font-medium bg-amber-500/10 text-amber-500 border-amber-500/30">
                              {tx('Draft')}
                            </span>
                          ) : (
                            <button
                              className={clsx(
                                btn.icon,
                                'opacity-0 group-hover:opacity-100 transition-opacity',
                                c.pinned && 'opacity-100'
                              )}
                              title={c.pinned ? tx('Unpin') : 'Pin'}
                              onClick={() => onPin(c)}
                            >
                              <Pin className={clsx('w-3.5 h-3.5', c.pinned && 'fill-current text-[var(--accent)]')} />
                            </button>
                          )}
                        </div>
                      </div>

                      {m.pronouns && (
                        <div className="text-[11px] text-[var(--text-muted)] truncate">{m.pronouns}</div>
                      )}

                      {(m.role || m.company) && (
                        <div className="text-xs text-[var(--text-secondary)] font-medium truncate mt-0.5 flex items-center gap-1">
                          {m.role && <span>{m.role}</span>}
                          {m.role && m.company && <span>·</span>}
                          {m.company && <span className="text-[var(--text-muted)]">{m.company}</span>}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Contact details */}
                  <div className="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
                    {m.email && (
                      <div className="flex items-center gap-1.5 truncate">
                        <Mail className="w-3 h-3 text-teal-400 shrink-0" />
                        <a
                          href={`mailto:${m.email}`}
                          onClick={ev => ev.stopPropagation()}
                          className="hover:text-[var(--text-primary)] hover:underline truncate"
                        >
                          {m.email}
                        </a>
                      </div>
                    )}
                    {m.phone && (
                      <div className="flex items-center gap-1.5 truncate">
                        <Phone className="w-3 h-3 text-teal-400 shrink-0" />
                        <a
                          href={`tel:${m.phone}`}
                          onClick={ev => ev.stopPropagation()}
                          className="hover:text-[var(--text-primary)] hover:underline truncate"
                        >
                          {m.phone}
                        </a>
                      </div>
                    )}
                    {m.location && (
                      <div className="flex items-center gap-1.5 truncate">
                        <MapPin className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        <span className="truncate">{m.location}</span>
                      </div>
                    )}
                    {c.url && (
                      <div className="flex items-center gap-1.5 truncate">
                        <ExternalLink className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={ev => ev.stopPropagation()}
                          className="hover:text-[var(--text-primary)] hover:underline truncate"
                        >
                          {c.url.replace(/^https?:\/\//, '')}
                        </a>
                      </div>
                    )}
                  </div>

                  {/* Birthday badge if set */}
                  {m.birthday && (
                    <div className="mt-2.5">
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border',
                          isUpcomingBday
                            ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                            : 'bg-teal-500/10 text-teal-400 border-teal-500/20'
                        )}
                      >
                        <Cake className="w-3 h-3" />
                        <span>{m.birthday}</span>
                        {daysUntilBday !== null && (
                          <span className="opacity-75">
                            {daysUntilBday === 0 ? '(Today!)' : tx('(in {daysUntilBday}d)', { daysUntilBday: daysUntilBday })}
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Notes snippet */}
                  {c.body && (
                    <p className="mt-2.5 text-xs text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                      {c.body}
                    </p>
                  )}
                </div>

                {/* Card Footer: Tags & Meta */}
                <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {c.tags.slice(0, 3).map(t => (
                      <span key={t} className="px-1.5 py-px rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[10px]">
                        #{t}
                      </span>
                    ))}
                  </div>
                  <span className="shrink-0">{relTime(c.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Compact List View */
        <div className="space-y-1.5">
          {filtered.map(c => (
            <CodexRow
              key={c.id}
              e={c}
              agentNames={agentNames}
              active={false}
              onOpen={() => onOpenContact(c)}
              onAccept={() => onAccept(c)}
              onDiscard={() => onDiscard(c)}
              onPin={() => onPin(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
