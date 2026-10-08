import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Archive,
  Download,
  RotateCcw,
  Trash2,
  Plus,
  Upload,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Database,
  Loader2,
  Clock,
  Layers,
} from 'lucide-react';
import { api } from '../api';
import type { BackupInfo } from '../types';
import { btn, relTime } from './common';
import { AdminGate } from './Integrations';

export function BackupsTab() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // backups hold admin.key and the SSH key, so the server asks for admin (the owner's login or the admin key)
  const [admin, setAdmin] = useState<boolean | null>(null);

  // Create modal state
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<'full' | 'core'>('full');
  const [note, setNote] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // Restore modal state
  const [targetRestore, setTargetRestore] = useState<BackupInfo | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  // Delete modal state
  const [targetDelete, setTargetDelete] = useState<BackupInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Upload state
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    api.backups()
      .then(bks => {
        setBackups(bks);
        setError('');
      })
      .catch(err => setError(String(err).replace(/^Error: \d+: /, '')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api.adminCheck()
      .then(r => { setAdmin(r.ok); if (r.ok) load(); else setLoading(false); })
      .catch(() => { setAdmin(false); setLoading(false); });
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    setError('');
    try {
      await api.createBackup({ scope, note: note.trim() });
      setCreating(false);
      setNote('');
      setSuccess(`Backup created successfully.`);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!targetRestore) return;
    setRestoreBusy(true);
    setError('');
    try {
      const res = await api.restoreBackup(targetRestore.filename || targetRestore.id);
      setTargetRestore(null);
      setSuccess(`${res.message}${res.safetyBackup ? ` (Safety snapshot ${res.safetyBackup.filename} created)` : ''}`);
      setTimeout(() => setSuccess(''), 5000);
      load();
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!targetDelete) return;
    setDeleteBusy(true);
    setError('');
    try {
      await api.deleteBackup(targetDelete.filename || targetDelete.id);
      setTargetDelete(null);
      load();
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadBusy(true);
    setError('');
    try {
      await api.uploadBackup(file);
      setSuccess(`Backup "${file.name}" uploaded successfully.`);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (err) {
      setError(String(err).replace(/^Error: \d+: /, ''));
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (admin === false) return <AdminGate onUnlocked={() => { setAdmin(true); load(); }} />;

  return (
    <div className="space-y-6">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[var(--border-subtle)]">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2 text-[var(--text-primary)]">
            <Archive className="w-4 h-4 text-[var(--brand-soft)]" />
            Backups & Disaster Recovery
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Atomic SQLite snapshots with filesystem storage. Pre-restore safety snapshots protect against data loss.
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1 max-w-[65ch]">
            Archives stay on this machine and only you can read them. The key that unlocks Codex secrets is never put
            in an archive; a restore keeps this machine's key, so copy <code>data/codex/.key</code> somewhere safe if
            you move backups to another machine.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleUpload}
            accept=".tar.gz"
            className="hidden"
          />
          <button
            type="button"
            className={btn.subtle}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadBusy || loading}
          >
            {uploadBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload Archive
          </button>
          <button
            type="button"
            className={btn.primary}
            onClick={() => setCreating(true)}
            disabled={createBusy || loading}
          >
            <Plus className="w-3.5 h-3.5" />
            Create Backup
          </button>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="flex items-center gap-2 p-3 text-xs rounded-lg border border-red-500/20 bg-red-500/10 text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-300 font-bold px-1">✕</button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 text-xs rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess('')} className="text-emerald-400 hover:text-emerald-300 font-bold px-1">✕</button>
        </div>
      )}

      {/* Backup list */}
      {loading ? (
        <div className="flex items-center justify-center p-12 text-[var(--text-muted)] text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading backups...
        </div>
      ) : backups.length === 0 ? (
        <div className="text-center p-8 rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-3">
          <div className="w-10 h-10 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mx-auto text-[var(--text-muted)]">
            <Database className="w-5 h-5" />
          </div>
          <div className="text-sm font-medium">No backups created yet</div>
          <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto">
            Create a backup to protect your conversations, memories, artifacts, and projects against hardware failure or corruption.
          </p>
          <button type="button" className={btn.primary} onClick={() => setCreating(true)}>
            <Plus className="w-3.5 h-3.5" />
            Create First Backup
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {backups.map(bk => {
            const isSafety = bk.source === 'pre-restore';
            const isAuto = bk.source === 'auto';
            const isFull = bk.scope === 'full';

            return (
              <div
                key={bk.filename || bk.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-hover)] transition"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={clsx(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                      isSafety ? 'bg-amber-500/10 text-amber-400' : isAuto ? 'bg-blue-500/10 text-blue-400' : 'bg-[var(--brand-soft)]/10 text-[var(--brand-soft)]'
                    )}
                  >
                    {isSafety ? <ShieldCheck className="w-4 h-4" /> : isFull ? <HardDrive className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium font-mono text-[var(--text-primary)]">
                        {bk.filename}
                      </span>
                      <span
                        className={clsx(
                          'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded',
                          isFull ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                        )}
                      >
                        {isFull ? 'Full' : 'Core'}
                      </span>
                      <span
                        className={clsx(
                          'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded',
                          isSafety ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            : isAuto ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                            : 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20'
                        )}
                      >
                        {isSafety ? 'Safety Snapshot' : isAuto ? 'Daily Auto' : 'Manual'}
                      </span>
                    </div>

                    {bk.note && <p className="text-xs text-[var(--text-secondary)] italic">{bk.note}</p>}

                    <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)] flex-wrap">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {relTime(bk.createdAt * 1000)}
                      </span>
                      <span>·</span>
                      <span className="font-mono font-medium text-[var(--text-secondary)]">
                        {bk.sizeFormatted}
                      </span>
                      {bk.dbStats && Object.keys(bk.dbStats).length > 0 && (
                        <>
                          <span>·</span>
                          <span>
                            {bk.dbStats.conversations ?? 0} chats, {bk.dbStats.messages ?? 0} msgs, {bk.dbStats.memories ?? 0} memories
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                  <a
                    href={`/api/backup/${encodeURIComponent(bk.filename || bk.id)}/download`}
                    download={bk.filename}
                    className={btn.subtle}
                    title="Download archive to local disk"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                  <button
                    type="button"
                    className={btn.subtle}
                    onClick={() => setTargetRestore(bk)}
                    title="Restore this backup"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                    Restore
                  </button>
                  <button
                    type="button"
                    className={btn.ghost}
                    onClick={() => setTargetDelete(bk)}
                    title="Delete backup"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Backup Modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Archive className="w-4 h-4 text-[var(--brand-soft)]" />
                Create New Backup
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Creates an atomic snapshot archive of the database and selected filesystem components.
              </p>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Backup Scope</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setScope('full')}
                    className={clsx(
                      'p-3 rounded-lg border text-left transition',
                      scope === 'full'
                        ? 'border-[var(--brand-soft)] bg-[var(--brand-soft)]/10 text-[var(--text-primary)]'
                        : 'border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                    )}
                  >
                    <div className="text-xs font-semibold">Full Backup</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Database + workspaces + assets</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScope('core')}
                    className={clsx(
                      'p-3 rounded-lg border text-left transition',
                      scope === 'core'
                        ? 'border-[var(--brand-soft)] bg-[var(--brand-soft)]/10 text-[var(--text-primary)]'
                        : 'border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                    )}
                  >
                    <div className="text-xs font-semibold">Core Backup</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Database + configs (fast, light)</div>
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Optional Label / Note</label>
                <input
                  type="text"
                  placeholder="e.g. Prior to system upgrade"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  className={btn.input}
                  maxLength={120}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  className={btn.subtle}
                  onClick={() => setCreating(false)}
                  disabled={createBusy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={btn.primary}
                  disabled={createBusy}
                >
                  {createBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {createBusy ? 'Creating Archive...' : 'Start Backup'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Restore Confirmation Modal */}
      {targetRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-[var(--bg-secondary)] shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 text-amber-400">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">Restore from Backup?</h3>
                <p className="text-xs text-[var(--text-muted)]">This operation will overwrite current active data.</p>
              </div>
            </div>

            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-xs space-y-1.5">
              <div className="font-mono font-medium text-[var(--text-primary)]">{targetRestore.filename}</div>
              <div className="text-[var(--text-muted)]">
                Created {new Date(targetRestore.createdAt * 1000).toLocaleString()} · {targetRestore.sizeFormatted} ({targetRestore.scope} scope)
              </div>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Before applying this backup, Shell:B will automatically generate a <strong className="text-[var(--text-primary)]">pre-restore safety snapshot</strong> of the current system, ensuring no work is permanently lost.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className={btn.subtle}
                onClick={() => setTargetRestore(null)}
                disabled={restoreBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRestore}
                disabled={restoreBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black flex items-center gap-1.5 transition"
              >
                {restoreBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-black" />}
                {restoreBusy ? 'Restoring System...' : 'Proceed with Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {targetDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-2xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Delete Backup File?</h3>
            <p className="text-xs text-[var(--text-muted)]">
              Are you sure you want to permanently delete <code className="font-mono text-[var(--text-primary)]">{targetDelete.filename}</code>? This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className={btn.subtle}
                onClick={() => setTargetDelete(null)}
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-500 text-white flex items-center gap-1.5 transition"
              >
                {deleteBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
