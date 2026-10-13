import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { api, req } from '../api';
import { Modal, btn } from './common';
import { toast } from './toast';
import { getLocalePref, setLocalePref, t, useLocale, type LocalePref } from '../i18n';
import type { SettingsTabId } from '../types';
import { LanguageFlag } from './LanguageFlag';

interface OnlineSource {
  name: string;
  url: string;
  search?: string;
}

interface ReviewItem {
  key: string;
  translation: string;
  confidence: number;
  reason: string;
  lookupSource: string;
  lookupUrl: string;
}

interface ReviewResponse {
  code: string;
  name?: string;
  total: number;
  verified: number;
  verifiedPct: number;
  sources: OnlineSource[];
  needsReviewCount: number;
  needsReview: ReviewItem[];
}

interface LocaleItem {
  code: string;
  name: string;
  flag?: string;
  category?: 'living' | 'dead' | 'fictional';
  entries: number;
  covered: number;
  coverage: number;
  author: string;
  authorUrl?: string;
  license: string;
  version: string;
  verified?: number;
  verifiedPct?: number;
  needsReviewCount?: number;
  sources?: OnlineSource[];
}

interface CoverageResponse {
  ok: boolean;
  strings: number;
  items: LocaleItem[];
  batchRunning: boolean;
  schedule?: {
    id: string;
    name: string;
    cron: string;
    tz: string;
    enabled: boolean;
    nextRun?: number;
    lastRun?: number;
    lastStatus?: string;
  } | null;
}

export function LanguagesSettings({ onOpenTab }: { onOpenTab?: (tab: SettingsTabId) => void }) {
  const currentLocale = useLocale();
  const currentPref = getLocalePref();
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningBatch, setRunningBatch] = useState(false);
  const [syncingLatn, setSyncingLatn] = useState(false);
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'living' | 'dead' | 'fictional'>('all');

  // Review modal state
  const [reviewLocale, setReviewLocale] = useState<string | null>(null);
  const [reviewName, setReviewName] = useState<string>('');
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await req<CoverageResponse>('/api/translate/coverage');
      setData(res);
      setRunningBatch(res.batchRunning);
    } catch (e) {
      toast(String(e), { kind: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const runBatch = async () => {
    setRunningBatch(true);
    try {
      await req('/api/translate/run-batch', { method: 'POST' });
      toast(t('Batch started in background.'));
      setTimeout(load, 1500);
    } catch (e) {
      toast(String(e), { kind: 'error' });
      setRunningBatch(false);
    }
  };

  const syncLatn = async () => {
    setSyncingLatn(true);
    try {
      const res = await req<CoverageResponse>('/api/translate/sync-sr-latn', { method: 'POST' });
      setData(res);
      toast(t('Serbian Latin synchronized.'));
    } catch (e) {
      toast(String(e), { kind: 'error' });
    } finally {
      setSyncingLatn(false);
    }
  };

  const runVerifyAll = async () => {
    setVerifyingAll(true);
    try {
      const res = await req<CoverageResponse>('/api/translate/verify', { method: 'POST' });
      setData(res);
      toast(t('Checks finished'));
    } catch (e) {
      toast(String(e), { kind: 'error' });
    } finally {
      setVerifyingAll(false);
    }
  };

  const openReview = async (code: string, name: string) => {
    setReviewLocale(code);
    setReviewName(name);
    setLoadingReview(true);
    setEditValues({});
    try {
      const res = await req<ReviewResponse>(`/api/translate/review/${encodeURIComponent(code)}`);
      setReviewItems(res.needsReview || []);
      const initialEdits: Record<string, string> = {};
      for (const item of res.needsReview || []) {
        initialEdits[item.key] = item.translation;
      }
      setEditValues(initialEdits);
    } catch (e) {
      toast(String(e), { kind: 'error' });
    } finally {
      setLoadingReview(false);
    }
  };

  const confirmItem = async (key: string) => {
    if (!reviewLocale) return;
    const translation = (editValues[key] ?? '').trim();
    if (!translation) return;

    setSavingKey(key);
    try {
      await req('/api/translate/confirm-string', {
        method: 'POST',
        body: JSON.stringify({
          code: reviewLocale,
          key,
          translation,
        }),
      });
      toast(t('String confirmed'));
      setReviewItems(prev => prev.filter(it => it.key !== key));
      load();
    } catch (e) {
      toast(String(e), { kind: 'error' });
    } finally {
      setSavingKey(null);
    }
  };

  const totalStrings = data?.strings || 3942;
  const items = data?.items || [];
  const schedule = data?.schedule;

  const filteredItems = items.filter(loc => {
    if (categoryFilter === 'all') return true;
    return loc.category === categoryFilter;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--border-subtle)]">
        <div>
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-sky-400" />
            <h2 className="text-base font-semibold">{t('Languages')}</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {t('Track progress across community catalogues and night shift runs.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runVerifyAll}
            disabled={verifyingAll}
            className={clsx(btn.subtle, 'text-xs flex items-center gap-1.5')}
            title={t('Run checks')}
          >
            <ShieldCheck className={clsx('w-3.5 h-3.5 text-emerald-400', verifyingAll && 'animate-spin')} />
            {verifyingAll ? t('Running…') : t('Run checks')}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className={clsx(btn.subtle, 'text-xs flex items-center gap-1.5')}
            title={t('Refresh')}
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="text-[11px] text-[var(--text-muted)]">{t('Total strings')}</div>
          <div className="text-lg font-semibold mt-0.5">{totalStrings.toLocaleString()}</div>
        </div>
        <div className="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="text-[11px] text-[var(--text-muted)]">{t('Catalogues')}</div>
          <div className="text-lg font-semibold mt-0.5">{items.length}</div>
        </div>
        <div className="col-span-2 sm:col-span-1 p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="text-[11px] text-[var(--text-muted)]">{t('Night Shift Automation')}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={clsx(
                'w-2 h-2 rounded-full',
                schedule?.enabled ? 'bg-emerald-400' : 'bg-neutral-500'
              )}
            />
            <span className="text-sm font-medium">
              {schedule?.enabled ? schedule.cron : t('Off')}
            </span>
          </div>
        </div>
      </div>

      {/* Night shift scheduled task banner */}
      <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0 mt-0.5">
              <CalendarClock className="w-4 h-4 text-sky-400" />
            </div>
            <div>
              <div className="text-sm font-medium flex items-center gap-2">
                {t('Night Shift Translation')}
                {schedule?.enabled && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                    {schedule.cron}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {t('Translates interface strings while the machine is idle at night')}
              </p>
              {schedule?.nextRun && (
                <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1 mt-1">
                  <Clock className="w-3 h-3 text-sky-400" />
                  <span>
                    {t('Next run')}: {new Date(schedule.nextRun).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={syncLatn}
              disabled={syncingLatn}
              className={clsx(btn.subtle, 'text-xs flex items-center gap-1.5')}
              title={t('Sync Serbian Latin')}
            >
              {syncingLatn ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              )}
              {t('Sync Serbian Latin')}
            </button>
            <button
              onClick={runBatch}
              disabled={runningBatch}
              className={clsx(btn.primary, 'text-xs flex items-center gap-1.5')}
            >
              {runningBatch ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {runningBatch ? t('Running…') : t('Run batch now')}
            </button>
          </div>
        </div>
      </div>

      {/* Language progress list */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t('Translation coverage & progress')}
          </h3>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition',
                categoryFilter === 'all'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                  : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
              )}
            >
              {t('All')} ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('living')}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition',
                categoryFilter === 'living'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                  : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
              )}
            >
              {t('Living & Celtic')} ({items.filter(it => it.category === 'living').length})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('dead')}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition',
                categoryFilter === 'dead'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                  : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
              )}
            >
              🏛️ {t('Classical & Dead')} ({items.filter(it => it.category === 'dead').length})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('fictional')}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition',
                categoryFilter === 'fictional'
                  ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                  : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
              )}
            >
              ⚔️ {t('Fictional & Conlangs')} ({items.filter(it => it.category === 'fictional').length})
            </button>
          </div>
        </div>
        <div className="space-y-2.5">
          {filteredItems.map(loc => {
            const isFull = loc.coverage >= 99.5;
            const hasReview = (loc.needsReviewCount ?? 0) > 0;
            return (
              <div
                key={loc.code}
                className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]/50 transition space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <LanguageFlag code={loc.code} size="md" />
                    <span className="px-2 py-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs font-mono font-medium">
                      {loc.code}
                    </span>
                    <span className="text-sm font-semibold truncate">{loc.name}</span>
                    {loc.category === 'dead' && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-300 border border-purple-500/20 font-medium">
                        {t('Classical & Dead')}
                      </span>
                    )}
                    {loc.category === 'fictional' && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-pink-500/10 text-pink-300 border border-pink-500/20 font-medium">
                        {t('Fictional & Conlangs')}
                      </span>
                    )}
                    {isFull ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <CheckCircle2 className="w-3 h-3" />
                        {t('Complete')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20">
                        <Sparkles className="w-3 h-3" />
                        {t('In progress')}
                      </span>
                    )}
                    {loc.verifiedPct !== undefined && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        <ShieldCheck className="w-3 h-3" />
                        {loc.verifiedPct}% {t('Passes checks')}
                      </span>
                    )}
                    {hasReview && (
                      <button
                        type="button"
                        onClick={() => openReview(loc.code, loc.name)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition font-medium"
                      >
                        <AlertTriangle className="w-3 h-3 text-amber-400" />
                        {loc.needsReviewCount} {t('Needs review')}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {currentLocale === loc.code || currentPref === loc.code ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        <CheckCircle2 className="w-3 h-3" />
                        {t('Active')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.saveSettings({ language: loc.code });
                          } catch {
                            /* ignore if not owner */
                          }
                          setLocalePref(loc.code as LocalePref);
                        }}
                        className={clsx(btn.subtle, 'text-[11px] py-0.5 px-2')}
                      >
                        {t('Use')}
                      </button>
                    )}
                    <span className="text-sm font-semibold font-mono">{loc.coverage}%</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-all duration-500',
                        isFull ? 'bg-emerald-400' : 'bg-sky-400'
                      )}
                      style={{ width: `${Math.max(2, loc.coverage)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[11px] text-[var(--text-muted)]">
                    <span>
                      {t('{covered} of {total} strings', {
                        covered: loc.covered.toLocaleString(),
                        total: totalStrings.toLocaleString(),
                      })}
                    </span>
                    {loc.author && (
                      <span className="truncate max-w-[200px]">
                        {loc.authorUrl ? (
                          <a
                            href={loc.authorUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline flex items-center gap-1 inline-flex"
                          >
                            {loc.author}
                            <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                          </a>
                        ) : (
                          loc.author
                        )}{' '}
                        · {loc.license}
                      </span>
                    )}
                  </div>
                </div>

                {/* Online sources citations */}
                {loc.sources && loc.sources.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-[var(--border-subtle)]/50 text-[11px]">
                    <span className="text-[var(--text-muted)] flex items-center gap-1 text-[10px]">
                      <BookOpen className="w-3 h-3 opacity-70" />
                      {t('Online sources')}:
                    </span>
                    {loc.sources.map(s => (
                      <a
                        key={s.name}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-0.5 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/80 text-[var(--text-secondary)] hover:text-sky-300 flex items-center gap-1 transition text-[10px]"
                      >
                        <span>{s.name}</span>
                        <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Review & verification modal */}
      {reviewLocale && (
        <Modal
          open={Boolean(reviewLocale)}
          onClose={() => setReviewLocale(null)}
          title={`${t('Needs review')} — ${reviewName || reviewLocale}`}
          icon={<ShieldCheck className="w-5 h-5 text-amber-400" />}
          wide
        >
          <div className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
            {loadingReview ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                <span className="text-xs">{t('Running…')}</span>
              </div>
            ) : reviewItems.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
                <div className="text-sm font-medium">{t('Every string passes the checks')}</div>
              </div>
            ) : (
              <div className="space-y-3">
                {reviewItems.map(item => {
                  const isSaving = savingKey === item.key;
                  return (
                    <div
                      key={item.key}
                      className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/40 space-y-2.5"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                        <span className="font-mono text-sky-300 font-medium">
                          {item.key}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                            {item.reason}
                          </span>
                          {item.lookupUrl && (
                            <a
                              href={item.lookupUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-sky-400 hover:underline flex items-center gap-1"
                            >
                              <span>{t('Online lookup')}: {item.lookupSource}</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editValues[item.key] ?? item.translation}
                          onChange={e =>
                            setEditValues(prev => ({
                              ...prev,
                              [item.key]: e.target.value,
                            }))
                          }
                          className={clsx(btn.input, 'flex-1 text-xs')}
                        />
                        <button
                          type="button"
                          onClick={() => confirmItem(item.key)}
                          disabled={isSaving}
                          className={clsx(btn.primary, 'text-xs flex items-center gap-1 shrink-0 py-1.5 px-3')}
                        >
                          {isSaving ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Check className="w-3 h-3" />
                          )}
                          {t('Confirm')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setReviewLocale(null)}
                className={clsx(btn.subtle, 'text-xs px-4')}
              >
                {t('Close')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
