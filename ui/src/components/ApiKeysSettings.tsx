import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { CodexEntry, Provider, Settings } from '../types';
import { Modal, Toggle, btn, relTime } from './common';
import { AdminGate } from './Integrations';
import { HostInput } from './codex/Inputs';
import { t, tn } from '../i18n';

interface Props {
  settings?: Settings;
  onSaved: () => void;
}

interface SecretModalState {
  id?: string;
  name: string;
  value: string;
  description: string;
  hosts: string[];
  approval: 'ask' | 'auto';
}

export function ApiKeysSettings({ settings, onSaved }: Props) {
  const [activeSection, setActiveSection] = useState<'all' | 'external' | 'cloud'>('all');
  const [secrets, setSecrets] = useState<CodexEntry[]>([]);
  const [loadingSecrets, setLoadingSecrets] = useState(true);
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Secret editor modal
  const [secretModal, setSecretModal] = useState<SecretModalState | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [showModalValue, setShowModalValue] = useState(false);

  // Revealed secrets: id -> value
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    try {
      setLoadingSecrets(true);
      const list = await api.codexEntries({ kind: 'secret' });
      setSecrets(list);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingSecrets(false);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const p = await api.providers();
      setProviders(p);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadSecrets();
    loadProviders();
    api.adminCheck().then(r => setAdmin(r.ok)).catch(() => setAdmin(false));
  }, [loadSecrets, loadProviders]);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  const handleReveal = async (id: string) => {
    if (revealed[id]) {
      setRevealed(prev => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      return;
    }
    setRevealingId(id);
    setError('');
    try {
      const res = await api.revealCodexSecret(id);
      setRevealed(prev => ({ ...prev, [id]: res.value }));
      setTimeout(() => {
        setRevealed(prev => {
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
      }, 30000);
    } catch (e) {
      setError(String(e).replace(/^Error: \d+: /, ''));
    } finally {
      setRevealingId(null);
    }
  };

  const handleDeleteSecret = async (id: string) => {
    try {
      await api.deleteCodexEntry(id);
      setSecrets(prev => prev.filter(s => s.id !== id));
      setConfirmDeleteId(null);
    } catch (e) {
      setError(String(e).replace(/^Error: \d+: /, ''));
    }
  };

  const handleOpenEdit = async (entry: CodexEntry) => {
    try {
      const full = await api.codexSecret(entry.id);
      setSecretModal({
        id: full.id,
        name: full.title,
        value: '',
        description: full.body ?? '',
        hosts: full.secret?.hosts ?? (full.meta?.hosts as string[]) ?? [],
        approval: (full.secret?.approval ?? full.meta?.approval ?? 'ask') as 'ask' | 'auto',
      });
      setShowModalValue(false);
      setModalError('');
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSaveSecretModal = async () => {
    if (!secretModal) return;
    const name = secretModal.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!name || name.length < 2) {
      setModalError('Secret name must have at least 2 characters (e.g. GITHUB_TOKEN).');
      return;
    }
    if (!secretModal.id && !secretModal.value) {
      setModalError('Secret value cannot be empty.');
      return;
    }

    setModalBusy(true);
    setModalError('');
    try {
      if (secretModal.id) {
        const payload: { name?: string; value?: string; hosts?: string[]; approval?: 'ask' | 'auto' } = {
          hosts: secretModal.hosts,
          approval: secretModal.approval,
        };
        const orig = secrets.find(s => s.id === secretModal.id);
        if (orig && orig.title !== name) payload.name = name;
        if (secretModal.value) payload.value = secretModal.value;

        await api.patchCodexSecret(secretModal.id, payload);
        await api.patchCodexEntry(secretModal.id, { body: secretModal.description } as Partial<CodexEntry>);
      } else {
        await api.createCodexSecret({
          name,
          value: secretModal.value,
          description: secretModal.description,
          hosts: secretModal.hosts,
          approval: secretModal.approval,
        });
      }
      setSecretModal(null);
      await loadSecrets();
    } catch (e) {
      setModalError(String(e).replace(/^Error: \d+: /, ''));
    } finally {
      setModalBusy(false);
    }
  };

  const filteredSecrets = secrets.filter(s => {
    const q = searchQuery.toLowerCase();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      (s.body && s.body.toLowerCase().includes(q)) ||
      (s.secret?.hosts && s.secret.hosts.some(h => h.toLowerCase().includes(q)))
    );
  });

  const configuredProvidersCount = Object.values(providers).filter(p => p.configured).length;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Overview header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-400 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{t('API Keys & External Services')}</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-2xl leading-relaxed">
              {t('Store credentials for third-party REST APIs, webhooks, and cloud AI models. External tokens are AES-256-GCM encrypted and injected on-demand into authorized HTTPS requests using placeholder syntax.')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
          <button
            className={btn.primary}
            onClick={() => {
              setSecretModal({
                name: '',
                value: '',
                description: '',
                hosts: [],
                approval: 'ask',
              });
              setShowModalValue(false);
              setModalError('');
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            {t('Add API Key')}
          </button>
        </div>
      </div>

      {admin === false && <AdminGate onUnlocked={() => setAdmin(true)} />}

      {error && (
        <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Navigation tabs */}
      <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] pb-2 text-xs">
        <button
          onClick={() => setActiveSection('all')}
          className={clsx(
            'px-3 py-1.5 rounded-lg transition font-medium',
            activeSection === 'all'
              ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          {t('All Credentials ({v0})', { v0: secrets.length + configuredProvidersCount })}
        </button>
        <button
          onClick={() => setActiveSection('external')}
          className={clsx(
            'px-3 py-1.5 rounded-lg transition font-medium flex items-center gap-1.5',
            activeSection === 'external'
              ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <KeyRound className="w-3.5 h-3.5 text-rose-400" />
          {t('External Services (')}{secrets.length})
        </button>
        <button
          onClick={() => setActiveSection('cloud')}
          className={clsx(
            'px-3 py-1.5 rounded-lg transition font-medium flex items-center gap-1.5',
            activeSection === 'cloud'
              ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          <Cloud className="w-3.5 h-3.5 text-sky-400" />
          {t('Cloud AI Providers (')}{configuredProvidersCount})
        </button>
        <a
          href="#/codex/secrets"
          className="ml-auto inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs transition"
          title={t('Open secrets collection in Codex')}
        >
          {t('Open in Codex')}
          <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </div>

      {/* External Service Keys (Codex Secrets) */}
      {(activeSection === 'all' || activeSection === 'external') && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t('External Service Keys (Codex Secrets)')}
              </h3>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {t('Agents use these via placeholder')} <code className="font-mono text-[var(--text-primary)]">{'{{secret:NAME}}'}</code>. Values are never exposed to LLM prompts.
              </p>
            </div>
            {secrets.length > 3 && (
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  placeholder={t('Filter keys…')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className={clsx(btn.input, 'pl-8 text-xs h-8')}
                />
              </div>
            )}
          </div>

          {loadingSecrets ? (
            <div className="flex items-center justify-center p-8 text-[var(--text-muted)]">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : filteredSecrets.length === 0 ? (
            <div className="p-6 rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-secondary)]/50 text-center space-y-2">
              <KeyRound className="w-6 h-6 text-rose-400/80 mx-auto" />
              <div className="text-sm font-medium">{t('No external service keys configured')}</div>
              <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">
                {t('Need Shell:B to query GitHub, push webhooks, fetch weather data, or access external APIs? Save your API keys here so agents can interact securely.')}
              </p>
              <button
                className={clsx(btn.subtle, 'mt-2')}
                onClick={() => {
                  setSecretModal({
                    name: '',
                    value: '',
                    description: '',
                    hosts: [],
                    approval: 'ask',
                  });
                  setShowModalValue(false);
                  setModalError('');
                }}
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Create your first API key')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {filteredSecrets.map(s => {
                const hosts = s.secret?.hosts ?? (s.meta?.hosts as string[]) ?? [];
                const approval = s.secret?.approval ?? s.meta?.approval ?? 'ask';
                const uses = s.secret?.uses ?? (s.meta?.uses as number) ?? 0;
                const isRevealed = Boolean(revealed[s.id]);
                const secretValue = revealed[s.id];

                return (
                  <div
                    key={s.id}
                    className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--border-strong)] transition space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center justify-center shrink-0 mt-0.5">
                          <KeyRound className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">
                              {t(s.title)}
                            </span>
                            <button
                              className="text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 transition"
                              title={t('Copy placeholder tag')}
                              onClick={() => copyToClipboard(`{{secret:${s.title}}}`, s.id)}
                            >
                              {copiedKey === s.id ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  <span className="text-emerald-400">copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>{`{{secret:${s.title}}}`}</span>
                                </>
                              )}
                            </button>
                            <span
                              className={clsx(
                                'px-1.5 py-0.5 rounded text-[10px] font-medium border',
                                approval === 'auto'
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                  : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
                              )}
                            >
                              {approval === 'auto' ? t('Auto-approved') : t('Approval required')}
                            </span>
                          </div>
                          {s.body && (
                            <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2">
                              {s.body}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          className={btn.subtle}
                          onClick={() => handleReveal(s.id)}
                          disabled={revealingId === s.id}
                          title={isRevealed ? t('Hide secret value') : t('Temporarily reveal secret (30s)')}
                        >
                          {revealingId === s.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : isRevealed ? (
                            <EyeOff className="w-3.5 h-3.5 text-amber-400" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                          {isRevealed ? t('Hide') : t('Reveal')}
                        </button>
                        <button
                          className={btn.subtle}
                          onClick={() => handleOpenEdit(s)}
                          title={t('Edit API key settings and hosts')}
                        >
                          {t('Edit')}
                        </button>
                        {confirmDeleteId === s.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              className="px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-400 hover:bg-red-500/30 transition"
                              onClick={() => handleDeleteSecret(s.id)}
                            >
                              {t('Confirm')}
                            </button>
                            <button
                              className={btn.ghost}
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              {t('Cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            className={clsx(btn.icon, 'hover:text-red-400')}
                            title={t('Delete secret')}
                            onClick={() => setConfirmDeleteId(s.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Revealed value box */}
                    {isRevealed && (
                      <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs font-mono">
                        <code className="text-[var(--text-primary)] truncate flex-1 select-all">
                          {secretValue}
                        </code>
                        <button
                          className={clsx(btn.ghost, 'text-[11px] shrink-0')}
                          onClick={() => copyToClipboard(secretValue, `raw-${s.id}`)}
                        >
                          {copiedKey === `raw-${s.id}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          {copiedKey === `raw-${s.id}` ? t('Copied') : t('Copy')}
                        </button>
                      </div>
                    )}

                    {/* Metadata line: hosts, uses, last used */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
                      {hosts.length > 0 ? (
                        <span className="flex items-center gap-1 font-mono text-[var(--text-secondary)]">
                          <Globe className="w-3 h-3 text-rose-400" />
                          {hosts.slice(0, 3).join(', ')}
                          {hosts.length > 3 ? ` +${hosts.length - 3}` : ''}
                        </span>
                      ) : (
                        <span className="text-amber-400 font-medium">{t('No hosts permitted (cannot be used)')}</span>
                      )}
                      <span>
                        {uses > 0 ? tn(uses, 'Used {n} time', 'Used {n} times') : t('Unused')}
                      </span>
                      {s.secret?.lastUsed && (
                        <span>{t('Last used {v0}', { v0: relTime(s.secret.lastUsed) })}</span>
                      )}
                      <span className="ml-auto">{t('Updated {v0}', { v0: relTime(s.updatedAt) })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Cloud AI Providers */}
      {(activeSection === 'all' || activeSection === 'cloud') && (
        <section className="space-y-4 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t('Cloud AI Provider Keys')}
              </h3>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {t('API keys for external LLMs (Claude, Gemini, OpenAI). Handled opt-in via cloud models.')}
              </p>
            </div>
            {settings && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--text-secondary)]">{t('Cloud AI:')}</span>
                <Toggle
                  on={settings.cloudEnabled}
                  label={t('Enable cloud AI')}
                  onChange={async v => {
                    await api.saveSettings({ cloudEnabled: v });
                    onSaved();
                  }}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(providers).map(([id, p]) => (
              <ProviderCardItem
                key={id}
                id={id}
                p={p}
                locked={!admin}
                onSaved={() => {
                  loadProviders();
                  onSaved();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Security Architecture Reference */}
      <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-muted)] space-y-1.5">
        <div className="flex items-center gap-2 font-medium text-[var(--text-secondary)]">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>{t('Security & Encryption Boundary')}</span>
        </div>
        <p className="leading-relaxed">
          {t('External service API keys are encrypted at rest with AES-256-GCM. The key resides at')} <code className="font-mono">~/shellb/web/data/codex/.key</code>.
          Outbound requests verify destination hosts strictly against whitelist rules, bypass redirects, redact confidential values from response buffers,
          and append an entry to the audit log.
        </p>
      </div>

      {/* Add / Edit Secret Modal */}
      {secretModal && (
        <Modal
          open={Boolean(secretModal)}
          onClose={() => setSecretModal(null)}
          title={secretModal.id ? t('Edit Secret: {name}', { name: secretModal.name }) : t('Add External Service API Key')}
          icon={<KeyRound className="w-4 h-4 text-rose-400" />}
        >
          <div className="p-5 space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">{t('Secret Name')}</label>
              <input
                type="text"
                autoFocus={!secretModal.id}
                value={secretModal.name}
                placeholder={t('GITHUB_TOKEN, WEATHER_API_KEY...')}
                onChange={e =>
                  setSecretModal({
                    ...secretModal,
                    name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
                  })
                }
                className={clsx(btn.input, 'font-mono uppercase')}
              />
              <p className="text-[11px] text-[var(--text-muted)]">
                {t('Capital letters, digits and underscores. Referenced by agents as')} <code className="font-mono text-[var(--text-primary)]">{`{{secret:${secretModal.name || 'NAME'}}}`}</code>.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                {secretModal.id ? t('Replace Secret Value (leave blank to keep current)') : t('Secret Value')}
              </label>
              <div className="relative">
                <input
                  type={showModalValue ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={secretModal.value}
                  placeholder={secretModal.id ? t('Paste new value to replace existing…') : t('sk-..., ghp_..., token...')}
                  onChange={e => setSecretModal({ ...secretModal, value: e.target.value })}
                  className={clsx(btn.input, 'font-mono pr-9')}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  onClick={() => setShowModalValue(!showModalValue)}
                  title={showModalValue ? t('Hide') : t('Show')}
                >
                  {showModalValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                {t('Description (agents and tools read this to understand usage)')}
              </label>
              <textarea
                value={secretModal.description}
                rows={2}
                placeholder={t('Personal access token for GitHub API with repository and issues scope')}
                onChange={e => setSecretModal({ ...secretModal, description: e.target.value })}
                className={clsx(btn.input, 'resize-y min-h-[60px]')}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                {t('Allowed Hosts (https only; e.g. api.github.com, *.github.com)')}
              </label>
              <HostInput
                value={secretModal.hosts}
                onChange={hosts => setSecretModal({ ...secretModal, hosts })}
              />
              <p className="text-[11px] text-[var(--text-muted)]">
                {t('The key will ONLY be decrypted and sent to requests matching these hosts. Subdomains supported via')} <code className="font-mono">*.domain.com</code>.
              </p>
            </div>

            <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
              <div>
                <span className="text-xs font-medium text-[var(--text-primary)] block">{t('Ask approval before each use')}</span>
                <span className="text-[11px] text-[var(--text-muted)] block">
                  {t('Wait for confirmation in the chat inbox whenever an agent attempts to send this secret.')}
                </span>
              </div>
              <Toggle
                on={secretModal.approval === 'ask'}
                onChange={v => setSecretModal({ ...secretModal, approval: v ? 'ask' : 'auto' })}
                label={t('Ask before use')}
              />
            </label>

            {modalError && (
              <div className="text-xs text-red-400 p-2 rounded bg-red-500/10 border border-red-500/20">
                {modalError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
              <button
                className={btn.ghost}
                onClick={() => setSecretModal(null)}
                disabled={modalBusy}
              >
                {t('Cancel')}
              </button>
              <button
                className={btn.primary}
                onClick={handleSaveSecretModal}
                disabled={modalBusy || (!secretModal.id && !secretModal.value)}
              >
                {modalBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {secretModal.id ? t('Save changes') : t('Add API key')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ProviderCardItem({
  id,
  p,
  locked,
  onSaved,
}: {
  id: string;
  p: Provider;
  locked: boolean;
  onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState(p.baseUrl ?? '');
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});
  const [error, setError] = useState('');

  useEffect(() => {
    setBase(p.baseUrl ?? '');
  }, [p.baseUrl]);

  const runTest = async () => {
    setTest({ busy: true });
    const r = await api.providerModels(id).catch(e => ({ ok: false, error: String(e), models: [] }));
    setTest({ ok: r.ok, text: r.ok ? `Connected · ${r.models.length} models verified` : r.error });
  };

  const save = async () => {
    setError('');
    try {
      await api.saveProvider(id, { apiKey: key, ...(id === 'openai' ? { baseUrl: base } : {}) });
      setKey('');
      onSaved();
      runTest();
    } catch (e) {
      setError(String(e).includes('admin-key-required') ? 'Unlock with the admin key first.' : String(e));
    }
  };

  return (
    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">{p.product}</span>
          <span className="text-[11px] text-[var(--text-muted)] ml-2">{p.name}</span>
        </div>
        <span
          className={clsx(
            'text-[11px] font-medium px-2 py-0.5 rounded-full border',
            p.configured
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
          )}
        >
          {p.configured
            ? t('Active · …{keyTail}{v0}', { keyTail: p.keyTail, v0: p.fromEnv ? ` (${p.env})` : '' })
            : t('Not configured')}
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            className={clsx(btn.input, 'font-mono text-xs')}
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={p.configured ? t('Replace API key…') : t('Enter API key…')}
            disabled={locked}
          />
          <button
            className={btn.primary}
            disabled={locked || (!key.trim() && (id !== 'openai' || base === (p.baseUrl ?? '')))}
            onClick={save}
          >
            {t('Save')}
          </button>
          {p.configured && (
            <button className={btn.subtle} onClick={runTest} disabled={test.busy} title={t('Test provider connection')}>
              {test.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('Test')}
            </button>
          )}
        </div>

        {id === 'openai' && (
          <label className="block text-[11px] text-[var(--text-muted)] mt-1.5">
            {t('Base URL (OpenAI or custom endpoint)')}
            <input
              className={clsx(btn.input, 'font-mono text-xs mt-1')}
              value={base}
              onChange={e => setBase(e.target.value)}
              disabled={locked}
            />
          </label>
        )}
      </div>

      <div className="text-[11px] text-[var(--text-muted)] flex items-center justify-between">
        <span>{p.keyHint}</span>
      </div>

      {test.text && (
        <div className={clsx('text-[11px] px-2 py-1 rounded border', test.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400')}>
          {t(test.text)}
        </div>
      )}
      {error && <div className="text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
