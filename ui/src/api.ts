import { scopedPrefix } from './frameKey';
import { reportNet } from './net';
import type {
  Agent, Attachment, Commit, Conversation, ConversationSummary, KindInfo, Memory, ModelInfo, Project, ProjectFile, ProjectKind,
  ProjectSummary, Settings, WorkspaceFile, Status, StreamEvent, ToolInfo, Connector, McpServer, Provider, Skill, SkillDetail, ClaudeSkill, ChatProject, ChatProjectDetail, Library,
  ScheduledTask, ScheduledRun, ScheduleDraft, ResearchBoard, ResearchBoardDetail, ResearchItem, NotebookMessage, NotebookCitation, DiscoverHit, StudioType, MegaPlan, MegaPlanDetail, ProjectTodo, ProjectTodoList, SshHost,
  ActivityItem, ActivitySummary, AskAnswer, PendingApproval, CodexCollection, CodexEntry, CodexIndex,
  CliAgent, TtsVoice, Meeting, MeetingSpeaker, MeetingUtterance, MeetingSummaryData, MeetingSummaryItem,
  BackupInfo, ChangelogEntry, BackupCreateRequest, BackupRestoreResult,
  ChatHit, UsageReport } from './types';

/** The admin key (data/admin.key on the server) unlocks MCP commands, API keys and cloud settings. */
export const adminKey = {
  get: () => { try { return localStorage.getItem('shellb-admin-key') ?? ''; } catch { return ''; } },
  set: (k: string) => { try { localStorage.setItem('shellb-admin-key', k); } catch { /* storage blocked */ } },
};

/** Login (server/auth.py). `frameKey` lets sandboxed frames, which get no cookie, reach their own content and saved state. */
export interface AuthInfo { authenticated: boolean; via: 'session' | 'local' | null; passwordSet: boolean; frameKey: string | null;
  /** two-step verification: the password was right, a code is still due for this login ticket */
  needsCode?: boolean; pending?: string;
  /** from the guest gateway (server/guest_app.py): this UI is a guest's own Shell:B in a container (cell.ts) */
  cell?: { guest: string; adult?: boolean }; guest?: { id: string; name: string; username: string | null };
  /** the guest gateway answered: a signed-out visitor gets its sign-in page, not the owner's login */
  gateway?: boolean;
  /** the interface language the server knows for this person ('' = browser), see ui/src/i18n */
  language?: string }
export interface TwoStepStatus { on: boolean; recoveryLeft: number; since: number | null }
export interface Passkey { id: string; label: string; rpId: string; created: number; lastUsed: number | null }
export interface AuthSession { created: number; lastSeen: number; ip: string; userAgent: string; current: boolean }
/** one row of the server's audit_log table (db.audit_log): admin actions, settings changes, approvals */
export interface AuditEntry { id: number; timestamp: number; action: string; details: Record<string, unknown> | string | null; ip?: string | null }
export interface ShareInfo { token: string; kind: 'chat' | 'artifact'; convId: string; artifactId: string | null; version: number | null; title: string; created: number; expires: number | null; views: number; revoked: boolean; url: string }
export interface MailboxNote { id: string; from_conv: string | null; fromTitle: string; sender: string; text: string; created: number; read_at: number | null }
let frameKey: string | null = null;
export const setFrameKey = (k: string | null) => { frameKey = k; };
/** Base for /api URLs that a sandboxed frame loads (boot.js, project pages, /work files). The key reaches `scope` only
 *  (`p-<pid>` a project, `w-<conv>` one chat's /work, `x` neither) plus shared asset/media files (server/auth.py). */
export const frameApi = (scope = 'x') => (frameKey ? scopedPrefix(frameKey, scope) : '/api');
/** Fired when the server says the session is gone; AuthGate shows the login screen. */
export const AUTH_LOST = 'shellb-auth-lost';

export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const key = adminKey.get();
  const r = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'X-Shellb-Admin': key } : {}),
      ...init?.headers,
    },
  }).then(x => { reportNet(true); return x; }, e => { reportNet(false, e); throw e; });  // net.ts: is the Spark there?
  if (r.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(AUTH_LOST));
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
    throw new Error(`${r.status}: ${detail}`);
  }
  return r.json();
}

export async function blobReq(path: string, init?: RequestInit): Promise<Blob> {
  const key = adminKey.get();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'X-Shellb-Admin': key } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(AUTH_LOST));
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(`${response.status}: ${detail}`);
  }
  return response.blob();
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  authMe: () => req<AuthInfo>('/api/auth/me'),
  authSetup: (adminKey: string, password: string) => req<AuthInfo>('/api/auth/setup', { method: 'POST', body: json({ adminKey, password }) }),
  login: (password: string) => req<AuthInfo>('/api/auth/login', { method: 'POST', body: json({ password }) }),
  loginCode: (pending: string, code: string) => req<AuthInfo>('/api/auth/login/code', { method: 'POST', body: json({ pending, code }) }),
  twoStep: () => req<TwoStepStatus>('/api/auth/2fa'),
  passkeys: () => req<{ passkeys: Passkey[] }>('/api/auth/passkeys'),
  passkeysAvailable: () => req<{ available: boolean }>('/api/auth/passkeys/available'),
  passkeyRegisterBegin: (password: string) => req<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/register/begin', { method: 'POST', body: json({ password }) }),
  passkeyRegisterFinish: (b: { challengeId: string; credential: unknown; label: string; transports: string[] }) => req<{ ok: boolean; id: string; label: string }>('/api/auth/passkeys/register/finish', { method: 'POST', body: json(b) }),
  passkeyDelete: (id: string) => req(`/api/auth/passkeys/${id}`, { method: 'DELETE' }),
  passkeyLoginBegin: () => req<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkeys/login/begin', { method: 'POST', body: json({}) }),
  passkeyLoginFinish: (b: { challengeId: string; credential: unknown }) => req<AuthInfo>('/api/auth/passkeys/login/finish', { method: 'POST', body: json(b) }),
  twoStepBegin: (password: string) => req<{ secret: string; uri: string }>('/api/auth/2fa/begin', { method: 'POST', body: json({ password }) }),
  twoStepConfirm: (code: string) => req<{ on: boolean; recovery: string[] }>('/api/auth/2fa/confirm', { method: 'POST', body: json({ code }) }),
  twoStepRecovery: (password: string) => req<{ recovery: string[] }>('/api/auth/2fa/recovery', { method: 'POST', body: json({ password }) }),
  twoStepDisable: (password: string) => req<{ on: boolean }>('/api/auth/2fa/disable', { method: 'POST', body: json({ password }) }),
  logout: () => {
    try { localStorage.removeItem('shellb.kiosk.password_authenticated'); } catch {}
    return req('/api/auth/logout', { method: 'POST' });
  },
  logoutOthers: () => req('/api/auth/logout-others', { method: 'POST' }),
  auditLog: (limit = 100, offset = 0, action = '') => req<AuditEntry[]>(`/api/audit-log?limit=${limit}&offset=${offset}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  feedbackStats: (days = 30) => req<Record<string, { up: number; down: number }>>(`/api/feedback/stats?days=${days}`),
  mailbox: (conv: string, unread = false) => req<{ messages: MailboxNote[]; unread: number }>(`/api/mailbox/${conv}${unread ? '?unread=true' : ''}`),
  mailboxSend: (conv: string, text: string) => req(`/api/mailbox/${conv}`, { method: 'POST', body: json({ text }) }),
  mailboxRead: (conv: string) => req(`/api/mailbox/${conv}/read`, { method: 'POST' }),
  authSessions: () => req<AuthSession[]>('/api/auth/sessions'),
  changePassword: (current: string, password: string) => req('/api/auth/password', { method: 'POST', body: json({ current, password }) }),
  authRateLimitStatus: () => req<{ ip: string; recentIpFailures: number; maxIpFailuresBeforeLock: number; recentGlobalFailures: number; globalLockActive: boolean }>('/api/auth/status'),
  changelog: () => req<{ entries: ChangelogEntry[]; error: string }>('/api/changelog'),
  backups: () => req<BackupInfo[]>('/api/backup'),
  createBackup: (b?: BackupCreateRequest) => req<BackupInfo>('/api/backup', { method: 'POST', body: json(b ?? {}) }),
  restoreBackup: (id: string) => req<BackupRestoreResult>(`/api/backup/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  deleteBackup: (id: string) => req<{ ok: boolean }>(`/api/backup/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploadBackup: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<BackupInfo>('/api/backup/upload', { method: 'POST', body: fd });
  },
  conversations: () => req<ConversationSummary[]>('/api/conversations'),
  conversation: (id: string) => req<Conversation>(`/api/conversations/${id}`),
  library: () => req<Library>('/api/library'),
  workspaceFiles: (convId: string) => req<WorkspaceFile[]>(`/api/workspace/${convId}`),
  createConversation: (agentId?: string, groupId?: string, incognito?: boolean) =>
    req<ConversationSummary>('/api/conversations', { method: 'POST', body: json({ agentId, groupId, incognito: incognito || undefined }) }),
  chatProjects: () => req<ChatProject[]>('/api/chat-projects'),
  chatProject: (id: string) => req<ChatProjectDetail>(`/api/chat-projects/${id}`),
  createChatProject: (p: Pick<ChatProject, 'name' | 'description' | 'instructions' | 'emoji'>) =>
    req<ChatProject>('/api/chat-projects', { method: 'POST', body: json(p) }),
  patchChatProject: (id: string, patch: Partial<Pick<ChatProject, 'name' | 'description' | 'instructions' | 'emoji' | 'pinned'>>) =>
    req<ChatProject>(`/api/chat-projects/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteChatProject: (id: string, deleteChats = false) => req(`/api/chat-projects/${id}?deleteChats=${deleteChats}`, { method: 'DELETE' }),
  uploadChatProjectFiles: (id: string, files: File[]) => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return req<{ saved: string[] }>(`/api/chat-projects/${id}/files`, { method: 'POST', body: fd });
  },
  todos: (gid: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos`),
  addTodos: (gid: string, items: { title: string; details?: string; agentId?: string; priority?: ProjectTodo['priority'] }[]) =>
    req<ProjectTodoList>(`/api/chat-projects/${gid}/todos`, { method: 'POST', body: json({ items }) }),
  patchTodo: (gid: string, id: string, patch: Partial<Pick<ProjectTodo, 'title' | 'details' | 'agentId' | 'status' | 'priority'>>) =>
    req<ProjectTodoList>(`/api/chat-projects/${gid}/todos/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteTodo: (gid: string, id: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos/${id}`, { method: 'DELETE' }),
  reorderTodos: (gid: string, ids: string[]) =>
    req<ProjectTodoList>(`/api/chat-projects/${gid}/todos-order`, { method: 'POST', body: json({ ids }) }),
  clearTodos: (gid: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos-clear`, { method: 'POST' }),
  runTodo: (gid: string, id: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos/${id}/run`, { method: 'POST' }),
  startTodos: (gid: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos-start`, { method: 'POST' }),
  stopTodos: (gid: string) => req<ProjectTodoList>(`/api/chat-projects/${gid}/todos-stop`, { method: 'POST' }),
  deleteChatProjectFile: (id: string, name: string) => req(`/api/chat-projects/${id}/files/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  patchConversation: (id: string, patch: Partial<ConversationSummary>) =>
    req<ConversationSummary>(`/api/conversations/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteConversation: (id: string) => req(`/api/conversations/${id}`, { method: 'DELETE' }),
  forkConversation: (id: string, body?: { messageId?: string; title?: string }) =>
    req<ConversationSummary>(`/api/conversations/${id}/fork`, { method: 'POST', body: json(body || {}) }),
  compactConversation: (id: string, body?: { keepRecent?: number }) =>
    req<{ ok: boolean; compacted: boolean; summary?: string; compactedCount?: number; remainingCount?: number; message?: string }>(
      `/api/conversations/${id}/compact`, { method: 'POST', body: json(body || {}) }
    ),
  searchChats: (q: string, limit = 20, convId?: string) =>
    req<{ results: ChatHit[] }>(`/api/chats/search?q=${encodeURIComponent(q)}&limit=${limit}${convId ? `&conv_id=${encodeURIComponent(convId)}` : ''}`),
  stop: (id: string) => req(`/api/conversations/${id}/stop`, { method: 'POST' }),
  upload: (convId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<Attachment>(`/api/conversations/${convId}/upload`, { method: 'POST', body: fd });
  },

  researchBoards: () => req<ResearchBoard[]>('/api/research'),
  researchBoard: (id: string) => req<ResearchBoardDetail>(`/api/research/${id}`),
  createResearchBoard: (b: { title: string; question: string }) => req<ResearchBoard>('/api/research', { method: 'POST', body: json(b) }),
  patchResearchBoard: (id: string, patch: Partial<Pick<ResearchBoard, 'title' | 'question' | 'summary' | 'status'>>) =>
    req<ResearchBoard>(`/api/research/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteResearchBoard: (id: string) => req(`/api/research/${id}`, { method: 'DELETE' }),
  addResearchItem: (id: string, item: Record<string, unknown>) =>
    req<ResearchItem>(`/api/research/${id}/items`, { method: 'POST', body: json(item) }),
  patchResearchItem: (id: string, itemId: string, patch: Record<string, unknown>) =>
    req<ResearchItem>(`/api/research/${id}/items/${itemId}`, { method: 'PATCH', body: json(patch) }),
  deleteResearchItem: (id: string, itemId: string) => req(`/api/research/${id}/items/${itemId}`, { method: 'DELETE' }),
  /** Attach an existing chat, or (no convId) start a new chat with the agent already attached to the board. */
  linkResearchChat: (id: string, body: { convId?: string; agentId?: string }) =>
    req<ConversationSummary>(`/api/research/${id}/link`, { method: 'POST', body: json(body) }),
  unlinkResearchChat: (convId: string) => req(`/api/research/links/${convId}`, { method: 'DELETE' }),
  // notebook (NotebookLM-style): sources, grounded chat, studio
  addNotebookUrls: (id: string, urls: string[]) => req<ResearchItem[]>(`/api/research/${id}/sources`, { method: 'POST', body: json({ type: 'url', urls }) }),
  addNotebookText: (id: string, title: string, text: string) =>
    req<ResearchItem[]>(`/api/research/${id}/sources`, { method: 'POST', body: json({ type: 'text', title, text }) }),
  uploadNotebookFiles: (id: string, files: File[]) => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return req<ResearchItem[]>(`/api/research/${id}/sources/upload`, { method: 'POST', body: fd });
  },
  sourceText: (id: string, itemId: string) => req<{ text: string }>(`/api/research/${id}/sources/${itemId}/text`),
  reindexSource: (id: string, itemId: string) => req(`/api/research/${id}/sources/${itemId}/reindex`, { method: 'POST' }),
  selectSources: (id: string, body: { ids?: string[]; all?: boolean; selected: boolean }) =>
    req(`/api/research/${id}/select`, { method: 'POST', body: json(body) }),
  discoverSources: (id: string, query: string) => req<DiscoverHit[]>(`/api/research/${id}/discover`, { method: 'POST', body: json({ query }) }),
  notebookChat: (id: string) => req<NotebookMessage[]>(`/api/research/${id}/chat`),
  clearNotebookChat: (id: string) => req(`/api/research/${id}/chat`, { method: 'DELETE' }),
  studio: (id: string, body: { type: StudioType; focus?: string; length?: string; sourceIds?: string[] }) =>
    req<ResearchItem>(`/api/research/${id}/studio`, { method: 'POST', body: json(body) }),
  retryOutput: (id: string, itemId: string) => req(`/api/research/${id}/outputs/${itemId}/retry`, { method: 'POST' }),
  refreshNotebookGuide: (id: string) => req<ResearchBoard>(`/api/research/${id}/guide`, { method: 'POST' }),
  plans: () => req<MegaPlan[]>('/api/plans'),
  plan: (id: string) => req<MegaPlanDetail>(`/api/plans/${id}`),
  createPlan: (b: { title?: string; goal: string; orchestrator: string; workspace: string; autoRun: boolean; maxAttempts: number; guidance?: string; plan?: boolean; quality?: string; check?: string; phaseReviews?: boolean }) =>
    req<MegaPlanDetail>('/api/plans', { method: 'POST', body: json(b) }),
  patchPlan: (id: string, patch: { title?: string; goal?: string; orchestrator?: string; summary?: string; options?: { maxAttempts?: number; autoRun?: boolean; quality?: string; check?: string; phaseReviews?: boolean } }) =>
    req<MegaPlanDetail>(`/api/plans/${id}`, { method: 'PATCH', body: json(patch) }),
  deletePlan: (id: string) => req(`/api/plans/${id}`, { method: 'DELETE' }),
  /** run · pause · plan (have the orchestrator write the steps) · steps (add steps) */
  planAction: (id: string, verb: 'run' | 'pause' | 'plan' | 'steps', body?: Record<string, unknown>) =>
    req<MegaPlanDetail>(`/api/plans/${id}/${verb}`, { method: 'POST', body: json(body ?? {}) }),
  patchStep: (id: string, stepId: string, patch: Record<string, unknown>) =>
    req<MegaPlanDetail>(`/api/plans/${id}/steps/${stepId}`, { method: 'PATCH', body: json(patch) }),
  deleteStep: (id: string, stepId: string) => req<MegaPlanDetail>(`/api/plans/${id}/steps/${stepId}`, { method: 'DELETE' }),
  schedules: () => req<{ tasks: ScheduledTask[]; runs: ScheduledRun[] }>('/api/schedules'),
  createSchedule: (d: ScheduleDraft) => req<ScheduledTask>('/api/schedules', { method: 'POST', body: json(d) }),
  patchSchedule: (id: string, patch: Partial<ScheduleDraft>) =>
    req<ScheduledTask>(`/api/schedules/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteSchedule: (id: string) => req(`/api/schedules/${id}`, { method: 'DELETE' }),
  runSchedule: (id: string) => req<{ queued: boolean }>(`/api/schedules/${id}/run`, { method: 'POST' }),
  previewSchedule: (d: Pick<ScheduleDraft, 'kind' | 'at' | 'cron' | 'tz'>) =>
    req<{ ok: boolean; error?: string; next: number[]; when?: string }>('/api/schedules/preview', { method: 'POST', body: json(d) }),

  agents: () => req<Agent[]>('/api/agents'),
  saveAgent: (originalId: string, agent: Agent) => req<Agent>(`/api/agents/${originalId}`, { method: 'PUT', body: json(agent) }),
  deleteAgent: (id: string) => req(`/api/agents/${id}`, { method: 'DELETE' }),
  resetAgent: (id: string) => req<Agent>(`/api/agents/${id}/reset`, { method: 'POST' }),

  tools: () => req<ToolInfo[]>('/api/tools'),
  setTool: (id: string, enabled: boolean) => req(`/api/tools/${id}`, { method: 'PUT', body: json({ enabled }) }),

  settings: () => req<Settings>('/api/settings'),
  usage: (days = 30) => req<UsageReport>(`/api/usage?days=${days}`),
  shares: () => req<{ shares: ShareInfo[]; host: string }>('/api/shares'),
  createShare: (b: { kind: 'chat' | 'artifact'; conversation: string; artifact?: string; version?: number; days?: number }) =>
    req<ShareInfo>('/api/shares', { method: 'POST', body: json(b) }),
  revokeShare: (token: string) => req(`/api/shares/${token}`, { method: 'DELETE' }),
  translate: (text: string, to: string, source = '') => req<{ translation: string; detected: string; to: string }>('/api/translate', { method: 'POST', body: json({ text, to, source }) }),
  translateLanguages: () => req<{ languages: string[] }>('/api/translate/languages'),
  saveSettings: (s: Partial<Settings>) => req<Settings>('/api/settings', { method: 'PUT', body: json(s) }),
  models: () => req<ModelInfo[]>('/api/models'),
  status: () => req<Status>('/api/status'),
  gibberlinkHealth: () => req<{ status: string; service: string; gibberlink: boolean }>('/api/gibberlink/health'),
  gibberlinkAgents: () => req<{ agents: string[] }>('/api/gibberlink/agents'),
  gibberlinkEncode: (body: { from_agent: string; to_agent: string; payload: unknown; ultrasound: boolean }) =>
    blobReq('/api/gibberlink/encode', { method: 'POST', body: json(body) }),
  gibberlinkDecode: (audio: Blob) => {
    const form = new FormData();
    form.append('file', audio, 'message.wav');
    return req<{ from_agent: string; to_agent: string; payload: unknown; timestamp: number; msg_type: string }>(
      '/api/gibberlink/decode', { method: 'POST', body: form });
  },
  activity: (q: { before?: number; source?: string; only?: 'unread' | 'attention' } = {}) =>
    req<ActivitySummary & { items: ActivityItem[]; pending: PendingApproval[] }>(
      `/api/activity?${new URLSearchParams(Object.entries(q).filter(([, v]) => v).map(([k, v]) => [k, String(v)]))}`),
  markActivity: (body: { ids?: string[]; all?: boolean; unread?: boolean }) =>
    req<ActivitySummary>('/api/activity/read', { method: 'POST', body: json(body) }),
  deleteActivity: (id: string) => req<ActivitySummary>(`/api/activity/${id}`, { method: 'DELETE' }),
  clearActivity: () => req<ActivitySummary>('/api/activity/clear', { method: 'POST' }),
  codex: () => req<CodexIndex>('/api/codex'),
  codexEntries: (q: { collection?: string; kind?: string; tag?: string; q?: string; view?: string }) =>
    req<CodexEntry[]>(`/api/codex/entries?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  codexEntry: (id: string) => req<CodexEntry>(`/api/codex/entries/${id}`),
  createCodexEntry: (e: Partial<CodexEntry> & { body?: string }) => req<CodexEntry>('/api/codex/entries', { method: 'POST', body: json(e) }),
  patchCodexEntry: (id: string, e: Partial<CodexEntry> & { body?: string }) =>
    req<CodexEntry>(`/api/codex/entries/${id}`, { method: 'PATCH', body: json(e) }),
  deleteCodexEntry: (id: string) => req(`/api/codex/entries/${id}`, { method: 'DELETE' }),
  resnapCodexEntry: (id: string) => req<CodexEntry>(`/api/codex/entries/${id}/snapshot`, { method: 'POST' }),
  uploadCodex: (files: File[], collectionId = '') => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    fd.append('collectionId', collectionId);
    return req<CodexEntry[]>('/api/codex/upload', { method: 'POST', body: fd });
  },
  importCodexIcs: (files: File[], collection = '') => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return req<{ added: number; updated: number; total: number }>(`/api/codex/import/ics${collection ? `?collection=${encodeURIComponent(collection)}` : ''}`, { method: 'POST', body: fd });
  },
  importCodexVcf: (files: File[], collection = '') => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return req<{ added: number; updated: number; total: number }>(`/api/codex/import/vcf${collection ? `?collection=${encodeURIComponent(collection)}` : ''}`, { method: 'POST', body: fd });
  },
  createCodexCollection: (name: string, description = '') =>
    req<CodexCollection>('/api/codex/collections', { method: 'POST', body: json({ name, description }) }),
  patchCodexCollection: (id: string, c: { name?: string; description?: string }) =>
    req(`/api/codex/collections/${id}`, { method: 'PATCH', body: json(c) }),
  deleteCodexCollection: (id: string, entries = false) => req(`/api/codex/collections/${id}?entries=${entries}`, { method: 'DELETE' }),
  codexSecret: (id: string) => req<CodexEntry>(`/api/codex/secrets/${id}`),
  createCodexSecret: (s: { name: string; value: string; description?: string; hosts?: string[]; approval?: 'ask' | 'auto'; tags?: string[]; collectionId?: string | null }) =>
    req<CodexEntry>('/api/codex/secrets', { method: 'POST', body: json(s) }),
  patchCodexSecret: (id: string, s: { name?: string; value?: string; hosts?: string[]; approval?: 'ask' | 'auto' }) =>
    req<CodexEntry>(`/api/codex/secrets/${id}`, { method: 'PATCH', body: json(s) }),
  revealCodexSecret: (id: string) => req<{ value: string }>(`/api/codex/secrets/${id}/reveal`, { method: 'POST' }),
  memoryToCodex: (memoryId: string, collectionId = '') =>
    req<CodexEntry>('/api/codex/from-memory', { method: 'POST', body: json({ memoryId, collectionId }) }),
  populateCodexFromMemories: (mode: 'auto' | 'review' = 'auto') =>
    req<{ created: { contacts: number; events: number }; updated: { contacts: number; events: number }; contacts: CodexEntry[]; events: CodexEntry[] }>(
      '/api/codex/populate-from-memories', { method: 'POST', body: json({ mode }) }
    ),
  uploadCodexAvatar: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ ok: boolean; url: string }>('/api/codex/avatar', { method: 'POST', body: fd });
  },
  uploadEntryAvatar: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ ok: boolean; avatar: string; entry: CodexEntry }>(`/api/codex/entries/${id}/avatar`, { method: 'POST', body: fd });
  },
  setEntryAvatarUrl: (id: string, url: string) =>
    req<{ ok: boolean; avatar: string; entry: CodexEntry }>(`/api/codex/entries/${id}/avatar`, { method: 'POST', body: json({ url }) }),
  deleteEntryAvatar: (id: string) =>
    req<{ ok: boolean; entry: CodexEntry }>(`/api/codex/entries/${id}/avatar`, { method: 'DELETE' }),
  generatePortrait: (params: { prompt?: string; name?: string; role?: string; entryId?: string }) =>
    req<{ ok: boolean; url: string; entry?: CodexEntry }>('/api/codex/generate-portrait', { method: 'POST', body: json(params) }),
  codexBacklinks: (id: string) =>
    req<{ id: string; title: string; kind: string }[]>(`/api/codex/entries/${id}/backlinks`),

  adminCheck: () => req<{ ok: boolean }>('/api/admin/check'),
  connectors: () => req<Connector[]>('/api/mcp/connectors'),
  mcpServers: () => req<McpServer[]>('/api/mcp/servers'),
  createMcpServer: (s: { connector: string; name: string; values: McpServer['values'] }) =>
    req<McpServer>('/api/mcp/servers', { method: 'POST', body: json(s) }),
  updateMcpServer: (id: string, s: { name: string; values: McpServer['values'] }) =>
    req<McpServer>(`/api/mcp/servers/${id}`, { method: 'PUT', body: json(s) }),
  patchMcpServer: (id: string, patch: Partial<Pick<McpServer, 'enabled' | 'disabledTools'>>) =>
    req<McpServer>(`/api/mcp/servers/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteMcpServer: (id: string) => req(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
  restartMcpServer: (id: string) => req<McpServer>(`/api/mcp/servers/${id}/restart`, { method: 'POST' }),
  skills: () => req<Skill[]>('/api/skills'),
  skill: (name: string) => req<SkillDetail>(`/api/skills/${name}`),
  createSkill: (content: string) => req<Skill>('/api/skills', { method: 'POST', body: json({ content }) }),
  saveSkill: (name: string, content: string) => req<Skill>(`/api/skills/${name}`, { method: 'PUT', body: json({ content }) }),
  setSkill: (name: string, enabled: boolean) => req<SkillDetail>(`/api/skills/${name}`, { method: 'PATCH', body: json({ enabled }) }),
  deleteSkill: (name: string) => req(`/api/skills/${name}`, { method: 'DELETE' }),
  uploadSkill: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ imported: string[] }>('/api/skills/upload', { method: 'POST', body: fd });
  },
  skillFile: (name: string, path: string) => req<{ path: string; content: string }>(`/api/skills/${name}/files/${encPath(path)}`),
  putSkillFile: (name: string, path: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<SkillDetail>(`/api/skills/${name}/files/${encPath(path)}`, { method: 'PUT', body: fd });
  },
  deleteSkillFile: (name: string, path: string) => req<SkillDetail>(`/api/skills/${name}/files/${encPath(path)}`, { method: 'DELETE' }),
  claudeSkills: () => req<ClaudeSkill[]>('/api/skill-import/claude'),
  importClaudeSkills: (names: string[]) => req<{ imported: string[] }>('/api/skill-import/claude', { method: 'POST', body: json({ names }) }),
  providers: () => req<Record<string, Provider>>('/api/providers'),
  adultMemories: () => req<{ id: string; text: string; created: number; updated: number }[]>('/api/adult/memories'),
  adultForget: (id?: string) => req(id ? `/api/adult/memories/${encodeURIComponent(id)}` : '/api/adult/memories', { method: 'DELETE' }),
  adultCheckpoints: () => req<{ checkpoints: { name: string; size: number }[]; fluxDev: boolean }>('/api/adult/checkpoints'),
  saveProvider: (id: string, p: { apiKey?: string; baseUrl?: string }) =>
    req<Provider>(`/api/providers/${id}`, { method: 'PUT', body: json(p) }),
  cliAgents: (fresh = false) => req<Record<string, CliAgent>>(`/api/cli-agents${fresh ? '?fresh=true' : ''}`),
  cliAgentModels: (id: string) =>
    req<{ ok: boolean; error?: string; models: { id: string; label: string; context: number }[] }>(`/api/cli-agents/${id}/models`),
  providerModels: (id: string) =>
    req<{ ok: boolean; error?: string; models: { id: string; label: string; context: number }[] }>(`/api/providers/${id}/models`),

  memories: () => req<Memory[]>('/api/memories'),
  addMemory: (text: string) => req<{ ok: boolean; message: string }>('/api/memories', { method: 'POST', body: json({ text }) }),
  deleteMemory: (id: string) => req(`/api/memories/${id}`, { method: 'DELETE' }),

  projects: () => req<ProjectSummary[]>('/api/projects'),
  sshKey: () => req<{ publicKey: string }>('/api/ssh/key'),
  sshHosts: () => req<SshHost[]>('/api/ssh/hosts'),
  addSshHost: (h: { name: string; host: string; port: number; user: string }) => req<SshHost>('/api/ssh/hosts', { method: 'POST', body: json(h) }),
  trustSshHost: (id: string, fingerprint: string) => req<SshHost>(`/api/ssh/hosts/${id}/trust`, { method: 'POST', body: json({ fingerprint }) }),
  patchSshHost: (id: string, patch: { name?: string; autoApprove?: boolean }) => req<SshHost>(`/api/ssh/hosts/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteSshHost: (id: string) => req(`/api/ssh/hosts/${id}`, { method: 'DELETE' }),
  installSshKey: (id: string, password: string) =>
    req<{ ok: boolean; result: 'added' | 'present' }>(`/api/ssh/hosts/${id}/install-key`, { method: 'POST', body: json({ password }) }),
  testSshHost: (id: string) => req<{ ok: boolean; system: string; home: string; tools: string[] }>(`/api/ssh/hosts/${id}/test`, { method: 'POST' }),
  createRemoteWorkspace: (hostId: string, path: string, name = '') =>
    req<ProjectSummary>('/api/ssh/workspaces', { method: 'POST', body: json({ hostId, path, name }) }),
  answerApproval: (id: string, decision: 'allow' | 'allow_turn' | 'deny') =>
    req<{ ok: boolean }>(`/api/ssh/approvals/${id}`, { method: 'POST', body: json({ decision }) }),
  answerQuestion: (id: string, answers: AskAnswer[]) =>
    req<{ ok: boolean }>(`/api/questions/${id}`, { method: 'POST', body: json({ answers }) }),
  kinds: () => req<Record<ProjectKind, KindInfo>>('/api/projects/kinds'),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  createProject: (p: { name: string; kind: ProjectKind; brief: string }) =>
    req<ProjectSummary>('/api/projects', { method: 'POST', body: json(p) }),
  patchProject: (id: string, patch: Partial<Pick<Project, 'name' | 'entry' | 'description' | 'kind'>>) =>
    req<ProjectSummary>(`/api/projects/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteProject: (id: string) => req(`/api/projects/${id}`, { method: 'DELETE' }),
  duplicateProject: (id: string, name = '') => req<ProjectSummary>(`/api/projects/${id}/duplicate`, { method: 'POST', body: json({ name }) }),
  projectFiles: (id: string) => req<ProjectFile[]>(`/api/projects/${id}/files`),
  createThread: (id: string, agentId?: string) =>
    req<ConversationSummary>(`/api/projects/${id}/threads`, { method: 'POST', body: json({ agentId }) }),
  saveFile: (id: string, path: string, content: string) =>
    req<{ ok: boolean; commit: string | null }>(`/api/projects/${id}/files/${encPath(path)}`, { method: 'PUT', body: json({ content }) }),
  deleteFile: (id: string, path: string) => req(`/api/projects/${id}/files/${encPath(path)}`, { method: 'DELETE' }),
  moveFile: (id: string, from: string, to: string) => req(`/api/projects/${id}/move`, { method: 'POST', body: json({ from, to }) }),
  uploadAssets: (id: string, files: File[], dir = 'assets') => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    fd.append('dir', dir);
    return req<{ saved: string[]; commit: string | null }>(`/api/projects/${id}/upload`, { method: 'POST', body: fd });
  },
  importProject: (file: File, name = '') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    return req<ProjectSummary & { imported: number }>('/api/projects/import', { method: 'POST', body: fd });
  },
  importCode: (file: File, name = '') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    return req<ProjectSummary>('/api/projects/import-code', { method: 'POST', body: fd });
  },
  cloneRepo: (url: string, name = '') => req<ProjectSummary>('/api/projects/clone', { method: 'POST', body: json({ url, name }) }),
  exec: (id: string, command: string) =>
    req<{ output: string; error: boolean; exitCode?: number; commit: string | null }>(`/api/projects/${id}/exec`, { method: 'POST', body: json({ command }) }),
  history: (id: string) => req<Commit[]>(`/api/projects/${id}/history`),
  diff: async (id: string, sha: string) => (await fetch(`/api/projects/${id}/history/${sha}/diff`)).text(),
  restore: (id: string, sha: string) => req<{ ok: boolean; commit: string | null }>(`/api/projects/${id}/history/${sha}/restore`, { method: 'POST' }),
  rawText: async (id: string, path: string) => {
    const r = await fetch(`${rawUrl(id, path)}?__src=1`);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.text();
  },

  voices: () => req<{ voices: string[]; details?: TtsVoice[]; engines?: { id: string; label: string }[]; default: string }>('/api/tts/voices'),
  /** voice and speed default to the ttsVoice / ttsSpeed settings */
  tts: async (text: string, opts?: { voice?: string; speed?: number; style?: string; fx?: Record<string, number>; voiceStyle?: string }) => {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ text, ...opts }) });
    if (!r.ok) throw new Error(await r.text());
    return r.blob();
  },
  stt: (audio: Blob) => {
    const fd = new FormData();
    fd.append('file', audio, 'speech.webm');
    return req<{ text: string }>('/api/stt', { method: 'POST', body: fd });
  },

  secretaryMeetings: () => req<MeetingSummaryItem[]>('/api/secretary/meetings'),
  secretaryMeeting: (id: string) => req<Meeting>(`/api/secretary/meetings/${id}`),
  createSecretaryMeeting: (data?: { title?: string; speakers?: MeetingSpeaker[] }) =>
    req<Meeting>('/api/secretary/meetings', { method: 'POST', body: json(data ?? {}) }),
  patchSecretaryMeeting: (id: string, patch: Partial<Meeting>) =>
    req<Meeting>(`/api/secretary/meetings/${id}`, { method: 'PATCH', body: json(patch) }),
  deleteSecretaryMeeting: (id: string) => req<{ deleted: boolean; id: string }>(`/api/secretary/meetings/${id}`, { method: 'DELETE' }),
  secretaryUtterance: (id: string, audioBlob: Blob, start: number, end: number, speakerHint?: string, sensitivity?: string) => {
    const fd = new FormData();
    fd.append('file', audioBlob, 'utterance.wav');
    fd.append('start', String(start));
    fd.append('end', String(end));
    if (speakerHint) fd.append('speaker_hint', speakerHint);
    if (sensitivity) fd.append('sensitivity', sensitivity);
    return req<{ utterance: MeetingUtterance; speakers: MeetingSpeaker[]; duration: number }>(`/api/secretary/meetings/${id}/utterance`, { method: 'POST', body: fd });
  },
  secretaryUploadAudio: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<Meeting>(`/api/secretary/meetings/${id}/upload-audio`, { method: 'POST', body: fd });
  },
  secretaryRediarize: (id: string, numSpeakers?: number, sensitivity?: string) =>
    req<Meeting>(`/api/secretary/meetings/${id}/rediarize`, { method: 'POST', body: json({ numSpeakers, sensitivity }) }),
  secretaryReassignUtterance: (mid: string, uid: string, speakerId: string) =>
    req<Meeting>(`/api/secretary/meetings/${mid}/utterances/${uid}`, { method: 'PATCH', body: json({ speakerId }) }),
  secretarySummarize: (id: string) =>
    req<{ summary: string; summaryData: MeetingSummaryData; title: string }>(`/api/secretary/meetings/${id}/summarize`, { method: 'POST' }),
  secretarySuggestNames: (id: string) =>
    req<{ suggestions: Record<string, string> }>(`/api/secretary/meetings/${id}/suggest-names`, { method: 'POST' }),
  secretarySaveToCodex: (id: string) =>
    req<{ ok: boolean; codexEntry: CodexEntry }>(`/api/secretary/meetings/${id}/save-to-codex`, { method: 'POST' }),
  secretaryAsk: (id: string, question: string) =>
    req<{ answer: string }>(`/api/secretary/meetings/${id}/ask`, { method: 'POST', body: json({ question }) }),

  network: () => req<NetworkInfo>('/api/network'),
};

export interface NetworkInterfaceInfo {
  interface: string;
  operstate: string;
  connected: boolean;
  mac: string;
  ipv4: string[];
  ipv6: string[];
  rxBytes: number;
  txBytes: number;
  type: string;
  ssid?: string;
  signalDbm?: number;
  frequency?: string;
  speed?: string;
  duplex?: string;
}

export interface NetworkInfo {
  timestamp: number;
  defaultGateway: { gateway: string; interface: string; prefsrc?: string } | null;
  dns: string[];
  wifi: NetworkInterfaceInfo[];
  wired: NetworkInterfaceInfo[];
  vpn: NetworkInterfaceInfo[];
  tailscale: {
    backendState: string;
    version: string;
    ips: string[];
    dnsName: string;
    hostName: string;
    online: boolean;
    tun: boolean;
  } | null;
}

export interface ChatRequest {
  content: string;
  attachments?: Attachment[];
  agentId?: string;
  effort?: string;
  fromMessageId?: string;
  /** an @mention: answer this turn as `agentId` without making it the conversation's agent */
  routeOnly?: boolean;
  /** this turn only: another model from the agent's own provider (the composer's model picker) */
  model?: string;
  /** plan mode: read-only tools, and the reply is a plan to approve (server/planmode.py) */
  mode?: 'plan';
  /** spoken in hands-free voice mode: the server asks for a short, speakable reply (app.py VOICE_NOTE) */
  voice?: boolean;
}

/** POSTs a chat turn and yields server-sent events until the turn finishes. */
export async function* streamChat(convId: string, body: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const r = await fetch(`/api/conversations/${convId}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json(body), signal,
  });
  if (!r.ok || !r.body) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* not json */ }
    throw new Error(`${r.status}: ${detail}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (line) yield JSON.parse(line.slice(6)) as StreamEvent;
    }
  }
}

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

export const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (projectId: string, path: string) => `/api/projects/${projectId}/raw/${encPath(path)}`;
/** rawUrl for a page shown in a sandboxed frame: under the frame key, so its relative fetches work without the cookie. */
export const frameRawUrl = (projectId: string, path: string) => `${frameApi(`p-${projectId}`)}/projects/${projectId}/raw/${encPath(path)}`;

/** Streams a grounded notebook answer: citations first, then text deltas, then done. */
export type NotebookEvent =
  | { type: 'citations'; citations: Record<string, NotebookCitation> }
  | { type: 'delta'; text: string }
  | { type: 'done'; id: string; citations: Record<string, NotebookCitation> }
  | { type: 'error'; error: string };

export async function* streamNotebookChat(id: string, message: string, signal?: AbortSignal): AsyncGenerator<NotebookEvent> {
  const r = await fetch(`/api/research/${id}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ message }), signal,
  });
  if (!r.ok || !r.body) throw new Error(`${r.status}: ${r.statusText}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (line) yield JSON.parse(line.slice(6)) as NotebookEvent;
    }
  }
}
