export type Effort = 'off' | 'low' | 'medium' | 'high';

export interface Agent {
  id: string;
  name: string;
  title: string;
  avatar: string;
  color: [string, string];
  description: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  effort: Effort;
  tools: string[];
  numCtx?: number;
  builtin?: boolean;
  studio?: boolean;
  cloud?: boolean;
  unavailable?: string;
  skills?: 'all' | string[];
}

export interface Skill {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  updatedAt: number;
  source: string;
  words: number;
  fileCount: number;
}

export interface SkillDetail extends Skill {
  content: string;
  files: { path: string; size: number }[];
}

export interface ClaudeSkill { name: string; description: string; path: string; plugin: string; imported: boolean }

export interface ToolInfo {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  category: string;
  enabled: boolean;
  available: boolean;
  service: string | null;
  /** agent: picked per agent in the Agent Lab; the others are added by server/agent.py's rules (`auto` says when) */
  scope?: 'agent' | 'global' | 'group' | 'project' | 'skills';
  auto?: string;
  cloud?: boolean;
}

export interface ConnectorField {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'bool' | 'path';
  placeholder?: string;
  required?: boolean;
  hint?: string;
  default?: boolean | string;
  multiline?: boolean;
}

export interface Connector {
  id: string;
  name: string;
  icon: string;
  category: 'Local' | 'Cloud' | 'Custom' | 'Community';
  local: boolean | null;
  description: string;
  fields: ConnectorField[];
}

export interface McpServer {
  id: string;
  name: string;
  connector: string;
  values: Record<string, string | boolean>;
  enabled: boolean;
  disabledTools: string[];
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  status: 'stopped' | 'starting' | 'ready' | 'error';
  error: string;
  tools: { name: string; description: string; enabled: boolean; readOnly: boolean }[];
  /** installed from Discover (server/community.py): where it came from, and its own form fields */
  community?: { itemId: string; registryName: string; version: string; fields: ConnectorField[]; installedAt: number };
  /** a community server still missing a required key */
  incomplete?: boolean;
}

/** Discover (server/community.py): community MCP servers, skills and plugins. */
export interface CommunityItem {
  id: string;
  kind: 'mcp' | 'skill' | 'plugin';
  name: string;
  title?: string;
  description: string;
  source: string;
  repo?: string;
  sha?: string;
  version?: string;
  publisher?: string;
  plugin?: string;
  license?: string;
  installed?: { kind: 'skill' | 'mcp'; name: string; enabled?: boolean } | null;
}

export interface CommunityOption {
  key: string; kind: 'remote' | 'npm' | 'pypi' | 'oci'; label: string; preview: string; local: boolean; fields: ConnectorField[];
}

export interface CommunityDetails extends CommunityItem {
  content?: string;
  files?: { path: string; size: number }[];
  scripts?: string[];
  url?: string;
  options?: CommunityOption[];
  skills?: CommunityItem[];
  mcpServers?: string[];
  note?: string;
  websiteUrl?: string;
}

export interface CommunitySource { id: string; kind: 'registry' | 'github' | 'marketplace'; name: string; repo?: string; items: number; fetched: number; custom?: boolean }

export interface Provider {
  name: string;
  product: string;
  env: string;
  keyHint: string;
  baseUrl: string | null;
  configured: boolean;
  apiKey: string;
  keyTail: string;
  fromEnv: boolean;
}

export interface CliAgent {
  name: string;
  product: string;
  vendor: string;
  bin: string;
  login: string;
  installed: boolean;
  loggedIn: boolean;
  account: string;
}

export interface ModelInfo {
  name: string;
  size: number;
  capabilities: string[];
  numCtx: number;
  nativeCtx: number;
  family: string;
  parameterSize: string;
  quantization: string;
  loaded: boolean;
  cloud?: boolean;
  provider?: string;
  label?: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: 'image' | 'text' | 'file' | 'ref';
  url: string;
  inline?: string;
  /** kind 'ref' (a # reference): a library ref (conv/artifact, proj-…, rb-…, grp-…, media) or a URL; the server fills in `inline` */
  ref?: string;
  refKind?: string;
  truncated?: boolean;
  uploading?: boolean;
  localPreview?: string;
  projectPath?: string;
}

export interface Source { title: string; url: string }

/** A file in a chat's sandbox /work folder, served at `url` (add `?download=1` to save it). */
export interface WorkspaceFile { path: string; url: string; size: number; mtime?: number }

/** Generation details ORPHEUS reports alongside a clip. */
export interface AudioInfo { model?: string; elapsed?: number; prompt?: string }

export interface ToolDisplay {
  images?: string[];
  audio?: string[];
  audioInfo?: AudioInfo;
  files?: string[];
  downloads?: WorkspaceFile[];
  sources?: Source[];
  artifact?: { id: string; version: number; title: string; type: ArtifactType; language: string };
  prompt?: string;
  memory?: string;
  delegate?: string;
  exitCode?: number;
  file?: { path: string; action: 'created' | 'modified' | 'deleted' };
  shot?: { path: string; width: number; height: number };
  board?: { id: string; title: string; counts: ResearchCounts; added?: number; started?: boolean; synthesized?: boolean };
  plan?: { id: string; title: string; status: PlanStatus; counts: StepCounts; created?: boolean; added?: number; reviewed?: number; finished?: boolean };
  circleNote?: import('./circlesApi').CircleNote;  // circles.py: an agent's draft, published from its card
}

export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** One answer per question: the options picked, and/or the owner's own words */
export interface AskAnswer { selected: string[]; other: string }

export type Block =
  | { type: 'thinking'; text: string; startedAt?: number; durationMs?: number }
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      args: Record<string, unknown>;
      status: 'running' | 'approval' | 'done' | 'error';
      /** set while a remote (SSH) workspace call, or a deploy of Shell:B's own code (kind 'self'), waits for the owner */
      approval?: { id: string; kind?: 'self' | 'secret' | 'question' | 'schedule' | 'install' | 'browser' | 'email'; title?: string; detail?: string };
      /** ask_user: the questions shown to the owner, and their answers once given */
      questions?: AskQuestion[];
      answers?: AskAnswer[];
      decision?: 'allow' | 'allow_turn' | 'deny' | 'timeout' | 'stopped';
      result?: string;
      display?: ToolDisplay;
      durationMs?: number;
      startedAt?: number;
      agentId?: string;
      children?: { name: string; status: string; args: string }[];
    };

export interface Message {
  id: string;
  /** 'summary': a lossy summary standing in for older messages in the agent's prompt (server/compaction.py) */
  role: 'user' | 'assistant' | 'summary';
  content: string;
  timestamp: number;
  /** on a summarized message: the summary that replaced it in the prompt (the message itself is kept) */
  summarizedBy?: string;
  /** on a summary: the messages it stands for, and how many in total (earlier summaries folded in) */
  summaryOf?: string[];
  count?: number;
  /** filled in by foldSummarized for display: the originals behind a summary */
  originals?: Message[];
  /** how full the agent's context will be on the next turn (estimate) */
  context?: ContextInfo;
  attachments?: Attachment[];
  agentId?: string;
  model?: string;
  blocks?: Block[];
  status?: 'streaming' | 'complete' | 'stopped' | 'error';
  error?: string;
  durationMs?: number;
  usage?: { prompt: number; completion: number; node?: string };
  note?: string;
  /** 'plan': sent in plan mode (read-only research ending in a plan for the owner to approve; server/planmode.py) */
  mode?: 'plan';
  /** what Shell:B learned about the user from this exchange (server/memory.py after_turn) */
  learned?: LearnedItem[];
  /** follow-ups noted from this exchange (server/commitments.py after_turn) */
  followUps?: FollowUpNoted[];
  /** memories the reply was given (server/memory.py recalled_view): `relevant` ones were picked for this message,
   *  the rest are the core profile that goes in every prompt */
  recalled?: RecalledMemory[];
  /** other people's circle notes this reply was given (server/circles.py), as labelled background */
  circleNotes?: { id: string; circle: string; circleName: string; author: { handle: string; name: string; emoji: string }; kind: string; text: string; link: string }[];
  /** spoken in hands-free voice mode and transcribed (components/VoiceMode.tsx) */
  voice?: boolean;
  /** the owner's rating of this reply (server/feedback.py) */
  feedback?: MessageFeedback;
}

export interface ChatHitHit {
  msgId: string;
  role: string;
  createdAt?: number;
  snippet: string;
}

export interface ChatHit {
  convId: string;
  title: string;
  agentId?: string;
  createdAt?: number;
  updatedAt: number;
  href: string;
  where: string;
  summary?: string;
  hits: ChatHitHit[];
  totalHits?: number;
}

export interface MessageFeedback {
  rating: 'up' | 'down'; reasons: string[]; note: string; at: number;
  /** the preference rule distilled from it, if any */
  learned?: { id: string; text: string; existing: boolean };
}

export interface LearnedItem { op: 'add' | 'update' | 'retire'; id: string; text: string; old?: string; reason?: string; status: 'active' | 'pending' | 'retired' }

/** A follow-up the learner noted (`add`) or closed (`done`) from a chat turn. `who`: me | agent. */
export interface FollowUpNoted { op: 'add' | 'done'; id: string; text: string; due?: string | null; who?: string }

export type ArtifactType = 'html' | 'svg' | 'markdown' | 'mermaid' | 'code';

export interface ArtifactVersion {
  id: string;
  version: number;
  title: string;
  type: ArtifactType;
  language: string;
  content: string;
  messageId: string;
  timestamp?: number;
}

export interface ArtifactGroup {
  id: string;
  title: string;
  type: ArtifactType;
  language: string;
  versions: ArtifactVersion[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  streaming?: boolean;
  projectId?: string | null;
  groupId?: string | null;
  /** not remembered, learned from or searched; deleted after 24 h (server/privacy.py) */
  incognito?: boolean;
}

/** A chat Project: groups chats with shared instructions and knowledge (not a Studio design project). */
export interface ChatProject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  emoji: string;
  color: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  chatCount?: number;
  fileCount?: number;
}

export interface ChatProjectFile {
  name: string;
  size: number;
  uploadedAt: number;
  status: 'indexing' | 'ready' | 'no-text' | 'error';
  chars?: number;
  chunks?: number;
  error?: string;
  source?: string;
}

export interface ChatProjectDetail extends ChatProject {
  files: ChatProjectFile[];
  knowledgeChars: number;
  inline: boolean;
  chats: ConversationSummary[];
  artifacts: { id: string; title: string; type: string; version: number; convId: string; chatTitle: string }[];
}

export type TodoStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped';
export type TodoPriority = 'high' | 'normal' | 'low';

/** One task preloaded into a chat Project's to-do list, run by an agent on its own in a new project chat. */
export interface ProjectTodo {
  id: string;
  groupId: string;
  n: number;
  title: string;
  details: string;
  agentId: string;
  priority: TodoPriority;
  status: TodoStatus;
  attempts: number;
  convId: string | null;
  result: string;
  error: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  queued: boolean;
}

export interface ProjectTodoList {
  items: ProjectTodo[];
  active: boolean;
  note: string;
  live: { item: string; group: string; conv: string | null; since: number } | null;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
  artifacts: ArtifactGroup[];
  researchBoard?: { id: string; title: string } | null;
  megaPlan?: { id: string; title: string; role: 'orchestrator' | 'step' | 'creator'; status: PlanStatus } | null;
}

export interface Settings {
  defaultAgent: string;
  visionFallbackModel: string;
  utilityModel: string;
  embeddingModel: string;
  ttsVoice: string;
  /** read-aloud and voice mode speed, 0.7–1.5 */
  ttsSpeed?: number;
  /** tone instruction for expressive (Qwen3-TTS) voices */
  ttsStyle?: string;
  autoMemory: boolean;
  /** learn from each chat after the reply (server/memory.py): apply at once, queue for review, or not at all */
  memoryLearning: 'auto' | 'review' | 'off';
  /** nightly memory tidy-up and weekly digest (server/reflection.py), at this local hour */
  memoryReflection?: boolean;
  memoryReflectionHour?: number;
  /** incognito chats are deleted this long after their last message (server/privacy.py) */
  incognitoHours?: number;
  promptSuggestions: boolean;
  maxToolRounds: number;
  /** ceiling the loop guard may extend maxToolRounds to (server/agent.py) */
  maxToolRoundsHardCap?: number;
  runawayLoopChecker?: boolean;
  loopCheckInterval?: number;
  /** end a local turn when Ollama sends nothing for this long */
  streamStallMinutes?: number;
  /** rewrite the empty-chat starter cards every few hours (server/suggestions.py) */
  suggestionsRefresh?: boolean;
  /** context window (tokens) for night-shift jobs on the big model */
  nightShiftContext?: number;
  /** domain whose p-<project>.<domain> hosts reach this machine; "" = tailnet :8210-8217 previews (server/devserver.py) */
  previewHost?: string;
  /** Settings → Usage: $ per million prompt (in) and completion (out) tokens, per cloud model id */
  modelCosts?: Record<string, { in?: number; out?: number }>;
  cloudEnabled: boolean;
  cloudDelegation: boolean;
  cloudMemory: boolean;
  cloudLibrary: boolean;
  cloudCodex: boolean;
  cloudScreen?: boolean;
  cloudBrowser?: boolean;
  /** Aphrodite, the opt-in adult agent (server/adult.py): admin-only master switch */
  adultEnabled?: boolean;
  /** SDXL checkpoint file for Aphrodite's images; "" = FLUX.1-dev */
  adultImageCheckpoint?: string;
  timeZone: string;
  /** a ThemeId (src/themes); kept on the server so it follows you across devices */
  theme?: string;
}

export interface RecalledMemory { id: string; text: string; category?: string; relevant: boolean }

export interface Memory { id: string; text: string; tags: string[]; createdAt: number }

export interface Status {
  version: string;
  services: Record<string, { ok: boolean; error?: string }>;
  memory: { MemTotal: number; MemAvailable: number };
  loaded: { name: string; size: number; context?: number }[];
  active: string[];
  scheduledRunAt?: number;
  megaPlan?: PlanLive | null;
  assetJob?: { job: string; lib: string; conv: string | null; since: number } | null;
  activity?: ActivitySummary;
  /** memories the learner proposed that wait for the owner (server/memory.py, review mode or past chats) */
  memoryPending?: number;
  /** the offline-data download running now (server/datasets.py) */
  dataJob?: { id: string; phase: 'download' | 'verify' | 'install'; done: number; bytes: number } | null;
  /** every large download in flight or queued: offline data and Ollama model pulls (datasets.downloads) */
  downloads?: DownloadItem[];
  /** Generate-playground jobs queued or running (server/generate.py); they don't survive a restart */
  generate?: { id: string; kind: 'image' | 'music' | 'sfx'; status: 'queued' | 'running' }[];
}

export interface DownloadItem {
  id: string; kind: 'data' | 'model'; name: string; detail: string; phase: 'download' | 'verify' | 'install' | 'queued';
  done: number; total: number; rate: number | null; note?: string | null; started?: number; link: string;
}

export type ActivitySource = 'schedule' | 'todo' | 'plan' | 'scout' | 'notebook' | 'deploy' | 'codex' | 'memory' | 'data' | 'brief' | 'health' | 'shopping' | 'nightshift' | 'circles' | 'guest' | 'calendar' | 'feeds';

/** Unread events, how many of them need the owner, and approvals agents are waiting on right now. */
export interface ActivitySummary { unread: number; attention: number; pending: number }

export interface ActivityItem {
  id: string;
  ts: number;
  source: ActivitySource;
  status: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  attention: boolean;
}

export type CodexKind = 'note' | 'link' | 'snippet' | 'file' | 'secret' | 'contact' | 'event';

export interface CodexCollection { id: string; name: string; description: string; color: string; count: number; updatedAt: number }

export interface ContactMeta {
  role?: string;
  company?: string;
  email?: string;
  emails?: string[];
  phone?: string;
  phones?: string[];
  location?: string;
  birthday?: string;
  pronouns?: string;
  urls?: string[];
  avatar?: string;
  /** nicknames ("Maika"): chats, the learner and the Me page treat them as this person */
  aka?: string[];
}

export interface EventMeta {
  date?: string;          // YYYY-MM-DD
  time?: string;          // HH:mm
  endDate?: string;       // YYYY-MM-DD
  endTime?: string;       // HH:mm
  allDay?: boolean;
  location?: string;
  attendees?: string[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  /** RFC 5545 rule text when recurrence is custom (server/codex_sync.py expands it) */
  rrule?: string;
  /** minutes before the start to post a reminder to Activity; 0 = at the start */
  reminderMinutes?: number;
  /** iCalendar UID, kept across .ics import/export */
  uid?: string;
}

export interface CodexEntryMeta extends ContactMeta, EventMeta {
  index?: 'pending' | 'indexing' | 'ready' | 'error';
  indexError?: string;
  chunks?: number;
  chars?: number;
  snapshot?: { status: 'pending' | 'ok' | 'error' | 'off'; at?: number; url?: string; chars?: number; error?: string };
  file?: string;
  size?: number;
  mime?: string;
  hosts?: string[];
  approval?: 'ask' | 'auto';
  uses?: number;
}

export interface CodexEntry {
  id: string;
  collectionId: string | null;
  kind: CodexKind;
  title: string;
  url: string;
  language: string;
  tags: string[];
  pinned: boolean;
  draft: boolean;
  meta: CodexEntryMeta;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  preview?: string;      // list rows
  passage?: string;      // search hits
  score?: number;
  body?: string;         // full entry
  text?: string;         // extracted file text or the saved copy of a page
  secret?: CodexSecretInfo;
}

/** Never the value: whether one is set, where it may be sent, and how it has been used. */
export interface CodexSecretInfo {
  set: boolean;
  hosts: string[];
  approval: 'ask' | 'auto';
  uses: number;
  lastUsed?: number | null;
  recent: { t: number; outcome: string; host?: string; method?: string; agent?: string; conv?: string }[];
}

export interface CodexIndex {
  collections: CodexCollection[];
  counts: { all: number; drafts: number; pinned: number; unfiled: number; contacts?: number; events?: number; secrets?: number };
  tags: [string, number][];
}

export interface PendingApproval {
  id: string;
  kind: 'remote' | 'self' | 'secret' | 'question' | 'schedule' | 'install' | 'browser' | 'email';
  title: string;
  detail: string;
  convId: string | null;
  convTitle: string;
  since: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  agentId: string;
  groupId: string | null;
  kind: 'once' | 'cron';
  at: number | null;
  cron: string;
  tz: string;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  lastConvId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  when: string;
  running: boolean;
  queued: boolean;
}

export interface ScheduledRun {
  id: string;
  scheduleId: string;
  name: string | null;
  convId: string | null;
  trigger: 'schedule' | 'late' | 'manual';
  startedAt: number;
  finishedAt: number | null;
  status: string;
  error: string | null;
}

export type ResearchKind = 'source' | 'finding' | 'quote' | 'question' | 'note' | 'figure' | 'output';
export type StudioType = 'audio' | 'briefing' | 'study_guide' | 'faq' | 'timeline' | 'report' | 'mindmap' | 'flashcards' | 'quiz';
export interface MindNode { label: string; children?: MindNode[] }
export interface Flashcard { front: string; back: string; source?: string }
export interface QuizQuestion { question: string; options: string[]; answer: number; explanation: string; source?: string }
export type Level = 'high' | 'medium' | 'low';
export type ResearchCounts = Record<ResearchKind, number> & { openQuestions: number };

export interface ResearchItem {
  id: string;
  kind: ResearchKind;
  ref: number | null;        // sources: the stable S-number the rest of the board cites
  title: string;
  body: string;
  url: string;
  meta: {
    domain?: string; type?: string; credibility?: Level; status?: string; author?: string; published?: string; publisher?: string;
    confidence?: Level; sources?: number[]; theme?: string; contested?: boolean; source?: number | null; location?: string; answer?: string;
    // notebook sources: indexing state, origin and source guide
    index?: 'pending' | 'indexing' | 'ready' | 'no-text' | 'error'; origin?: 'url' | 'file' | 'text'; selected?: boolean;
    chars?: number; chunks?: number; topics?: string[]; guide?: string; error?: string; file?: string; fileName?: string; size?: number;
    // studio outputs (meta.type is the StudioType; status is queued/generating/voicing/ready/error)
    data?: { label?: string; children?: MindNode[]; cards?: Flashcard[]; questions?: QuizQuestion[] };
    transcript?: { speaker: 'A' | 'B'; text: string }[]; audio?: string; duration?: number; marks?: number[];
    focus?: string; length?: string; sourceIds?: string[]; startedAt?: number; finishedAt?: number; from?: string;
  };
  pinned: boolean;
  addedBy: string;           // "user", "auto" (captured from a page read) or "agent:<id>"
  convId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchBoard {
  id: string;
  title: string;
  question: string;
  summary: string;
  status: 'active' | 'complete';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  counts: ResearchCounts;
  convIds?: string[];
  emoji?: string;
  guide?: { summary?: string; questions?: string[]; at?: number };
}

export interface NotebookCitation { itemId: string; ref: number | null; title: string; chunk: number; text: string }
export interface NotebookMessage { id: string; role: 'user' | 'assistant'; content: string; citations?: Record<string, NotebookCitation>; createdAt: number }
export interface DiscoverHit { url: string; title: string; snippet: string; domain: string; added: boolean }

export interface ResearchBoardDetail extends ResearchBoard {
  items: ResearchItem[];
  conversations: { id: string; title: string; agentId: string; updatedAt: number }[];
}

export type ScheduleDraft = Pick<ScheduledTask, 'name' | 'prompt' | 'agentId' | 'groupId' | 'kind' | 'cron' | 'tz'> & { at: number | string | null; enabled?: boolean };

export interface ContextInfo { used: number; limit: number; estimated?: boolean; summarized?: number; pending?: boolean }

export type StreamEvent =
  | { type: 'start'; userMessage: Message; message: Message }
  | { type: 'summarized'; summary: Message }
  | { type: 'block_start'; index: number; block: Block }
  | { type: 'block_delta'; index: number; text: string }
  | { type: 'block_update'; index: number; block: Block }
  | { type: 'artifact'; artifact: ArtifactVersion }
  | { type: 'model'; model: string; note: string }
  | { type: 'memories'; memories: RecalledMemory[] }
  | { type: 'title'; title: string }
  | { type: 'error'; error: string }
  | { type: 'file'; path: string; action: 'created' | 'modified' | 'deleted' }
  | { type: 'commit'; sha: string }
  | { type: 'done'; message: Message };

export type ProjectKind = 'website' | 'deck' | 'print' | 'mobile' | 'dashboard' | 'design-system' | 'brand' | 'social' | 'email'
  | 'motion' | 'screensaver' | 'game' | '3d' | 'fullstack' | 'music' | 'illustration' | 'blank' | 'code';

export interface ProjectFile { path: string; size: number; mtime: number; kind: 'html' | 'image' | 'svg' | 'font' | 'pdf' | 'markdown' | 'video' | 'audio' | 'model' | 'text' | 'binary' }

export interface ProjectSummary {
  id: string;
  name: string;
  kind: ProjectKind;
  entry: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
  cover: string | null;
  /** a remote (SSH) workspace: its files live on another machine */
  remote?: RemoteInfo | null;
}

export interface RemoteInfo { hostId: string; host: string; target: string; path: string; autoApprove: boolean }

export interface SshHost {
  id: string; name: string; host: string; port: number; user: string;
  fingerprint: string; trusted: boolean; autoApprove: boolean; created: number;
}

export interface Project extends ProjectSummary {
  files: ProjectFile[];
  threads: ConversationSummary[];
  viewport: [number, number];
}

export interface Commit {
  sha: string;
  fullSha: string;
  timestamp: number;
  message: string;
  changes: { status: string; path: string }[];
}

export interface KindInfo { label: string; blurb: string; viewport: [number, number] }

/** A chat artifact's latest version, as listed in the Library. */
export interface LibraryArtifact extends ArtifactVersion {
  convId: string;
  convTitle: string;
  agentId: string;
  studioProjectId: string | null;
  groupId: string | null;
  versions: number;
  createdAt: number;
}

export interface Library { artifacts: LibraryArtifact[]; apps: ProjectSummary[] }

// ── Mega Plans ──────────────────────────────────────────────────────────────

export type PlanStatus = 'planning' | 'draft' | 'running' | 'paused' | 'complete' | 'failed';
export type StepStatus = 'pending' | 'running' | 'review' | 'revising' | 'done' | 'failed' | 'skipped';
export type StepCounts = Record<StepStatus, number> & { total: number };

/** What the plan driver is doing right now. */
export interface PlanLive { plan: string; step: string | null; conv: string | null; phase: 'work' | 'review' | 'plan' | 'final' | 'check' | 'phase'; since: number }

/** Automated checks the plan ran after a step's attempt. */
export interface CheckResult { ok: boolean; at: number; runs: { cmd: string; exit: number | null; ok: boolean; output: string }[] }
export type PlanQuality = 'thorough' | 'standard';

export interface MegaStep {
  id: string;
  n: number;
  phase: string;
  title: string;
  brief: string;
  criteria: string;
  agentId: string;
  status: StepStatus;
  attempts: number;
  convId: string | null;
  report: string;          // the worker's last reply (ends with its handoff report)
  feedback: string;        // the latest review feedback
  handoff: string;         // the orchestrator's summary on accept, which later steps see
  checkpoint: boolean;     // pause for the user's approval after this step
  check: string;           // shell command the plan runs after each attempt; must exit 0
  checkResult: CheckResult | null;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface MegaPlan {
  id: string;
  title: string;
  goal: string;
  status: PlanStatus;
  note: string;
  orchestrator: string;
  projectId: string | null;
  orchConv: string | null;
  summary: string;
  options: {
    maxAttempts?: number; autoRun?: boolean; workspace?: 'new' | 'none' | 'existing'; guidance?: string;
    quality?: PlanQuality; check?: string; phaseReviews?: boolean; phasesReviewed?: string[];
  };
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  counts: StepCounts;
  current?: { title: string; status: StepStatus } | null;
}

export interface MegaEvent { id: string; stepId: string | null; kind: string; text: string; at: number }

export interface MegaPlanDetail extends MegaPlan {
  steps: MegaStep[];
  events: MegaEvent[];
  live: PlanLive | null;
  project?: { id: string; name: string; kind: string } | null;
}

/** a HERMES text-to-speech voice; ids of engines other than Kokoro look like "engine:name" */
export interface TtsVoice { id: string; label: string; engine: string; designed?: boolean; description?: string }

export interface MeetingSpeaker {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  pitch?: number;
  utteranceCount?: number;
  totalDuration?: number;
}

export interface MeetingUtterance {
  id: string;
  speakerId: string;
  speakerName: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
  pitch?: number;
  voiceVector?: number[];
}

export interface MeetingActionItem {
  id: string;
  task: string;
  owner: string;
  priority: 'high' | 'medium' | 'low';
  deadline?: string;
  completed?: boolean;
}

export interface MeetingSummaryData {
  title?: string;
  tldr: string;
  participants: { name: string; role?: string; contribution?: string }[];
  topics: { title: string; notes: string[] }[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  openQuestions?: string[];
}

export interface Meeting {
  id: string;
  title: string;
  status: 'idle' | 'recording' | 'paused' | 'processing' | 'completed';
  created: number;
  updated: number;
  duration: number;
  speakers: MeetingSpeaker[];
  utterances: MeetingUtterance[];
  summary?: string;
  summaryData?: MeetingSummaryData;
  codexEntryId?: string | null;
  /** how voices were told apart: 'wespeaker-r34-lm' (neural voice prints) or 'legacy-17d' (pitch/timbre features) */
  diarizer?: string;
}

export interface MeetingSummaryItem {
  id: string;
  title: string;
  status: 'idle' | 'recording' | 'paused' | 'processing' | 'completed';
  created: number;
  updated: number;
  duration: number;
  speakerCount: number;
  utteranceCount: number;
  hasSummary: boolean;
  codexEntryId?: string | null;
}

export interface BackupInfo {
  id: string;
  filename: string;
  scope: 'full' | 'core';
  source: 'manual' | 'auto' | 'pre-restore';
  note?: string;
  createdAt: number;
  createdAtIso: string;
  sizeBytes: number;
  sizeFormatted: string;
  dbStats?: Record<string, number>;
  directories?: string[];
  version?: string;
}

export interface BackupCreateRequest {
  scope?: 'full' | 'core';
  note?: string;
}

export interface BackupRestoreResult {
  ok: boolean;
  message: string;
  restoredManifest?: BackupInfo;
  safetyBackup?: BackupInfo;
}

export type SettingsTabId = 'general' | 'appearance' | 'speech' | 'network' | 'memory' | 'shortcuts' | 'system' | 'backups' | 'account' | 'apikeys' | 'notifications' | 'changelog' | 'usage';

/** server/tokens.py report(): Settings → Usage */
export interface UsageRow { name: string; prompt: number; completion: number; turns: number; cost?: number }
export interface UsageReport {
  days: number; since: string;
  series: { day: string; prompt: number; completion: number; turns: number; owner: number; guests: number; api: number }[];
  agents: UsageRow[]; models: UsageRow[]; tenants: UsageRow[];
  window: { prompt: number; completion: number; turns: number };
  lifetime: { prompt: number; completion: number; total: number; turns: number };
  cost: number | null;
  costs: Record<string, { in?: number; out?: number }>;
}

export interface ChangelogEntry { date: string; area: string; title: string; summary: string }
