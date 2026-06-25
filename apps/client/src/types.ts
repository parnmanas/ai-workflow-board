export interface User {
  id: string; // GUID
  name: string;
  email: string;
  avatar_url: string;
  role: 'admin' | 'user';
  status: 'active' | 'pending' | 'rejected';
  discord_user_id: string;
  permissions: string; // JSON array string
  resolved_permissions: string[];
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string; // GUID
  name: string;
  key_masked: string;
  agent_id: string | null; // GUID — references Agent.id
  agent: Agent | null;
  scope: string; // 'full' | 'read' | 'write'
  is_active: number;
  expires_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
  // 생성 시에만 반환
  raw_key?: string;
  _notice?: string;
}

export interface PermissionMeta {
  label: string;
  description: string;
  group: string;
}

export interface Agent {
  id: string; // GUID
  name: string;
  description: string;
  type: string;
  avatar_url: string;
  is_active: number;
  is_online: number;           // 0 = offline, 1 = online (Phase 2)
  connected_at: string | null; // ISO timestamp or null (Phase 2)
  last_seen_at: string | null; // ISO timestamp or null (Phase 2)
  // Phase 1 role prompt fields (D-14 / ROLE-02)
  role_prompt?: string;
  role_prompt_meta?: Record<string, any> | null;
  // ST-4 — agent-manager-managed agents. Empty/null on legacy rows.
  working_dir?: string;
  manager_agent_id?: string | null;
  /** Workspace this agent identity belongs to. Server populates on every
   *  list/get; the AgentManager admin page uses it to render the per-row
   *  workspace picker that lets operators relocate managed agents that
   *  were created against a global manager. */
  workspace_id?: string;
  /** Optional Credential row that supplies CLI auth (subscription / API key)
   *  for the spawned agent. null = fall back to the operator's main HOME. */
  credential_id?: string | null;
  /** Per-agent default model the spawned CLI runs under (e.g. 'opus',
   *  'claude-opus-4-8', 'deepseek-reasoner'). null/empty = the CLI's own
   *  default (no --model flag). Candidates come from the manager's reported
   *  available_models; free-text is also accepted. */
  model?: string | null;
  /** ST-7: name of the manager Agent that supervises this agent. Populated
   *  by the server's agent listing endpoints (one DB lookup per request).
   *  Drives the `<ManagerName>/<AgentName>` display format used everywhere
   *  in the UI; undefined for legacy / standalone agents (no slash prefix). */
  manager_name?: string;
  /** Live process snapshot from InstanceRegistry. Set by `/api/agents` and
   *  `/api/agents/:id` when the agent is currently being heartbeated by a
   *  proxy/daemon process or supervised by an agent-manager instance. The
   *  AI Agents admin page renders mode/version/host/heartbeat from this so
   *  managed agents (which have no SSE session of their own) are visible. */
  live_instance?: AgentLiveInstance;
  /** Subagent rollup attached server-side from SubagentMonitor. Lets the AI
   *  Agents admin page show "5 active / 23 total" without an extra fetch. */
  subagents?: AgentSubagentRollup;
  created_at: string;
  updated_at: string;
}

/** Subset of AgentManagerInstance attached to each Agent in /api/agents. The
 *  full record is still available via /api/admin/agent-manager/instances when
 *  the operator wants the master/detail layout. */
export interface AgentLiveInstance {
  instance_id: string;
  mode: 'daemon' | 'proxy' | 'manager';
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  /** True when this agent is supervised by a manager (manager.agent_ids
   *  includes this id). False when this agent IS the instance's primary
   *  agent_id (proxy / daemon / a manager identity itself). */
  supervised: boolean;
  working_dirs?: string[];
  agent_ids?: string[];
}

export interface AgentSubagentRollup {
  total: number;
  active: number;
  recent: SubagentSummary[];
}

export interface PromptTemplate {
  id: string; // GUID
  workspace_id: string; // GUID — references Workspace.id
  name: string;
  description: string;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface Resource {
  id: string;
  workspace_id: string;
  board_id: string | null;
  credential_id: string | null;
  name: string;
  description: string;
  type: 'repository' | 'document' | 'image' | 'link';
  url: string;
  content: string;
  file_data: string;
  file_name: string;
  file_mimetype: string;
  tags: string[];
  // For type='repository': the branch tickets default to when no per-ticket
  // base_branch is set. Empty leaves the choice to git's `origin/HEAD`.
  default_branch?: string;
  created_at: string;
  updated_at: string;
}

// Embedded snapshot of the ticket's base repository — populated by
// loadTicketFull on the server when ticket.base_repo_resource_id is set.
export interface TicketBaseRepo {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  type: string;
}

// One "blocked-by another ticket" link (ticket 48d14fff). The dependent
// ticket (`ticket_id`) stays parked until `prerequisite_ticket_id` reaches a
// terminal column. `prerequisite` is the server-hydrated snapshot used by the
// detail panel to render a status pill without a second round-trip; it is
// null only for a stale link whose prereq row was deleted.
export interface TicketPrerequisiteRow {
  ticket_id: string;
  prerequisite_ticket_id: string;
  created_at: string;
  created_by: string;
  reason: string;
  prerequisite?: {
    id: string;
    title: string;
    column_id: string | null;
    column_name: string;
    is_terminal: boolean;
    archived_at: string | null;
  } | null;
}

// Result of GET /api/resources/:id/branches — git ls-remote output for a
// repository resource, with the default branch (if configured) pinned first.
export interface RepoBranch {
  name: string;
  sha: string;
}

// ─── server-side git reading (history / diff / file tree) ───────────────────
// Backed by a per-Resource bare blobless cache clone (git-repo-cache.ts). All
// of these come from GET /api/resources/:id/{refs,commits,commits/:sha,tree,file}.

// Branches + tags + resolved HEAD for the ref picker shared by History/Files.
export interface RepoRefs {
  branches: string[];
  tags: string[];
  head: string;
}

// One row in the commit list.
export interface RepoCommitSummary {
  sha: string;
  short_sha: string;
  subject: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  committed_at: string;
}

// One changed file inside a commit detail. `additions`/`deletions` are null for
// binary files (numstat reports `-`).
export interface RepoCommitFileChange {
  path: string;
  old_path?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

// Full commit detail: metadata + changed files + a byte-bounded unified diff.
export interface RepoCommitDetail {
  sha: string;
  short_sha: string;
  subject: string;
  body: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  committed_at: string;
  parents: string[];
  files: RepoCommitFileChange[];
  diff: string;
  diff_truncated: boolean;
}

// One entry in a directory listing. `size` is null for trees/submodules.
export interface RepoTreeEntry {
  name: string;
  path: string;
  type: 'tree' | 'blob' | 'commit';
  sha: string;
  size: number | null;
}

// A single-file preview. `content` is empty when `binary` or `too_large`.
export interface RepoFileContent {
  path: string;
  size: number;
  binary: boolean;
  too_large: boolean;
  truncated: boolean;
  content: string;
}

// User-defined Action: a saved prompt addressed to a target Agent. Each Run
// creates a new ChatRoom and posts the rendered prompt as the first message;
// the agent's reply (and any follow-ups) live in that room.
export interface Action {
  id: string;
  workspace_id: string;
  board_id: string | null;
  name: string;
  description: string;
  prompt: string;
  target_agent_id: string;
  schedule_cron: string;
  trigger: string;
  trigger_label: string;
  enabled: boolean;
  max_runs: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionRun {
  id: string;
  action_id: string;
  workspace_id: string;
  room_id: string;
  triggered_by_type: 'user' | 'system' | 'agent';
  triggered_by_id: string;
  prompt_rendered: string;
  created_at: string;
}

// ─── Scenario-based QA (ticket 3c655d20) ───────────────────────────────────
export interface QaScenarioStep {
  idx: number;
  action: string;
  expect?: string;
  mcp_tool?: string;
  params?: Record<string, any>;
}

export interface QaOnFailureTicketConfig {
  enabled: boolean;
  board_id?: string;
  column_name?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee_id?: string;
  labels?: string[];
  dedupe?: 'per_run' | 'per_open_ticket';
  title_template?: string;
  // QA → fix → QA closed loop (ticket 467dbc7a). When rerun_on_fix is on, the
  // server re-runs this scenario once its auto-filed fix ticket reaches Done,
  // capped at max_rerun_attempts (default 3) reruns. rerun_delay_seconds defers
  // each rerun so a main→prod deploy can land first (deploy-timing gate).
  rerun_on_fix?: boolean;
  max_rerun_attempts?: number;
  rerun_delay_seconds?: number;
}

export interface QaScenario {
  id: string;
  workspace_id: string;
  board_id: string | null;
  name: string;
  description: string;
  steps: QaScenarioStep[];
  target_agent_id: string;
  qa_driver: string;
  qa_driver_config: Record<string, any> | null;
  enabled: boolean;
  tags: string[];
  on_failure_ticket: QaOnFailureTicketConfig | null;
  created_by: string;
  max_runs: number;
  created_at: string;
  updated_at: string;
}

export type QaRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

/**
 * List view-model returned by GET /api/qa/scenarios — a QaScenario plus the
 * last-run rollup the QA dashboard table renders (last-run time + result +
 * pass-rate). Server computes it in a single query (see QaService.list).
 */
export interface QaScenarioListItem extends QaScenario {
  last_run_at: string | null;
  last_run_status: QaRunStatus | null;
  pass_rate: number | null;
  run_count: number;
}

export interface QaStepResult {
  idx: number;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  log?: string;
  artifact_resource_ids?: string[];
}

export interface QaRun {
  id: string;
  scenario_id: string;
  workspace_id: string;
  board_id: string | null;
  status: QaRunStatus;
  room_id: string;
  step_results: QaStepResult[];
  artifact_resource_ids: string[];
  summary: string;
  auto_ticket_id: string | null;
  rerun_generation: number;
  triggered_by_type: string;
  triggered_by_id: string;
  batch_id?: string | null;
  batch_index?: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export type QaRunBatchStatus = 'running' | 'done' | 'aborted';

/**
 * QaRunBatch — a manual sequential run of several scenarios (ticket daf06262).
 * Only one scenario runs at a time: index N+1 dispatches when run N terminates.
 * `current_index`/`total` drive the progress display; run_ids[i] is the QaRun
 * dispatched for scenario_ids[i] ('' = that index's dispatch was skipped).
 */
export interface QaRunBatch {
  id: string;
  workspace_id: string;
  board_id: string | null;
  scenario_ids: string[];
  run_ids: string[];
  current_index: number;
  total: number;
  status: QaRunBatchStatus;
  stop_on_fail: boolean;
  passed: number;
  failed: number;
  errored: number;
  triggered_by_type: string;
  triggered_by_id: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type QaScheduleScope = 'all' | 'selected';

/**
 * QaSchedule — automatic trigger layer over the sequential QA batch (ticket
 * b6bb7efd, on top of daf06262). When due, the server kicks a QaRunBatch via the
 * SAME orchestrator the manual "순차 실행" buttons use. scope='all' resolves
 * enabled scenarios in scope at dispatch time (no id snapshot); scope='selected'
 * runs the ordered `scenario_ids`. Cadence is exactly one of `cron` (5-field UTC)
 * or `interval_ms`. `next_run_at`/`last_run_at`/`last_batch_id` track firing.
 */
export interface QaSchedule {
  id: string;
  workspace_id: string;
  board_id: string | null;
  name: string;
  scope: QaScheduleScope;
  scenario_ids: string[];
  cron: string | null;
  interval_ms: number | null;
  enabled: boolean;
  stop_on_fail: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_batch_id: string | null;
  triggered_by_type: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Credential {
  id: string;
  // null = global (instance-level) credential shared across all workspaces.
  workspace_id: string | null;
  // 'global' credentials are read-only inside a workspace view (editable only
  // from the Admin global-credentials page); 'workspace' credentials are owned
  // by the active workspace.
  scope?: 'workspace' | 'global';
  name: string;
  description: string;
  provider: string;
  credential_fields: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Channel {
  id: string; // GUID
  name: string;
  type: string;
  bot_token: string;
  channel_id: string;
  is_active: number;
  notify_on_status_change: number;
  notify_on_update: number;
  notify_on_comment: number;
  created_at: string;
  updated_at: string;
}

/**
 * Per-user outbound notification channel binding (discord/slack/telegram).
 * Server returns `has_credentials: boolean` rather than the encrypted blob —
 * the bot token is never echoed back over the API.
 */
export interface UserNotificationChannel {
  id: string;
  user_id: string;
  provider: string; // 'discord' | 'slack' | 'telegram'
  target: string;
  label: string;
  is_active: number;
  notify_mention: number;
  notify_chat: number;
  notify_ticket: number;
  has_credentials: boolean;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityLog {
  id: string; // GUID
  entity_type: string;
  entity_id: string; // GUID — references ticket/comment id
  action: string;
  field_changed: string;
  old_value: string;
  new_value: string;
  actor_id: string; // GUID — references User.id
  actor_name: string;
  ticket_id: string; // GUID — references Ticket.id
  created_at: string;
}

// Hydrated Resource metadata returned with a comment. Metadata only — the
// server no longer ships the base64 payload inline (it bloated every refetch
// and made large videos unusable, ticket ff3e7337). The UI renders thumbnails
// and downloads by pointing media tags at GET /api/resources/:id/raw via
// rawResourceUrl(). `file_data` is kept optional for backward compatibility
// but is not populated by the current server.
export interface CommentAttachment {
  id: string; // Resource.id (type='comment_attachment')
  file_name: string;
  file_mimetype: string;
  file_data?: string;
}

// Ticket-level attachment. Distinct from CommentAttachment — the binary lives
// on the dedicated `ticket_attachments` table (NOT through Resources), which
// is why this row carries no Resource indirection. List responses omit
// `file_data` to keep payloads small; the dedicated GET endpoint returns it.
export interface TicketAttachmentMeta {
  id: string;
  workspace_id: string;
  ticket_id: string;
  file_name: string;
  file_mimetype: string;
  file_size: number;
  uploaded_by_type: 'user' | 'agent' | string;
  uploaded_by_id: string;
  uploaded_by: string;
  created_at: string;
  file_data?: string; // present only when fetched via getTicketAttachment
}

export type CommentType = 'note' | 'question' | 'answer' | 'decision' | 'chat' | 'system' | 'handoff';
export type CommentStatus = 'open' | 'resolved' | null;

export interface Comment {
  id: string; // GUID
  ticket_id: string; // GUID — references Ticket.id
  author_type: 'user' | 'agent' | 'system';
  author_id: string; // GUID — references User.id or Agent.id
  author: string;
  content: string;
  attachment_resource_ids: string[]; // Resource ids (type='comment_attachment')
  attachments: CommentAttachment[]; // server-hydrated from Resource table
  created_at: string;
  // Discriminator: routes UI rendering and filter chips. Defaults to 'note' for
  // legacy rows and any caller that omits the field. 'system' is reserved for
  // SystemCommentService output (REST endpoint rejects it explicitly).
  type: CommentType;
  // Only populated for type='question'. Server flips it to 'resolved' when an
  // 'answer' child arrives.
  status: CommentStatus;
  // Threading link: 'answer' -> 'question' or generic reply chain. Same-ticket
  // only (server validated).
  parent_id: string | null;
  // Type-specific extension bag (e.g., handoff target_agent_id, decision refs).
  metadata: Record<string, unknown>;
  // Dedupe counters for noisy auto-generated system rows (silent-exit fallback,
  // usage-limit retries, etc.). The server bumps these in place when the same
  // fingerprint repeats as the most recent comment on the ticket; NULL means
  // the row hasn't been deduped yet (treat as 1).
  repeat_count?: number | null;
  last_repeated_at?: string | null;
}

export interface Ticket {
  id: string; // GUID
  column_id: string | null; // GUID — references BoardColumn.id, null for child tickets
  parent_id: string | null; // GUID — references parent Ticket.id
  depth: number; // 0=root, 1=subtask, 2=sub-subtask
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: string; // todo, in_progress, done
  assignee: string;
  reporter: string;
  assignee_id: string; // GUID — references User.id
  reporter_id: string; // GUID — references User.id
  reviewer_id: string; // GUID — references User.id
  labels: string[];
  channel_ids: string[]; // GUID array — references Channel.id
  // Phase 1 ticket prompt snapshot (D-17 / ROLE-08)
  prompt_text?: string;
  // Repository resource the ticket builds against (set via the picker in the
  // detail tab). The agent uses this + base_branch to pull the right base
  // before cutting its feature branch. Empty when the ticket is non-code.
  base_repo_resource_id?: string;
  base_branch?: string;
  // Server-hydrated snapshot of base_repo_resource_id (loadTicketFull only).
  // Carries url + default_branch so the picker UI doesn't need a second
  // round-trip per ticket open.
  base_repo?: TicketBaseRepo | null;
  // Optional pointer to the ticket TriggerLoopService should auto-trigger
  // once this one lands on a terminal column. Cleared/empty → no chain.
  next_ticket_id?: string | null;
  // Per-ticket on-done action binding (ticket 16a6339c, method "a"). Action
  // ids dispatched exactly once when THIS ticket lands on a terminal column —
  // independent of board/label-scoped policy. Server stores it as a JSON
  // string but decodes to an array on every read path (loadTicketFull /
  // parseTicket), so the client always sees string[]. Empty array = no binding.
  on_done_action_ids?: string[];
  // Abstract effort preset id (resolved against the board's effort_presets at
  // dispatch into per-CLI options). null/empty = "no effort override", spawn
  // exactly as before. Not a CLI flag — the server maps it per CLI.
  effort_preset?: string | null;
  // Ticket parked awaiting user intervention (ticket a57517be). When true the
  // server drops every agent_trigger for this ticket, the focus selector
  // skips it, and the board view renders a high-visibility outline + badge.
  // The detail panel surfaces a dedicated "User" tab with the reason, set_at,
  // set_by, and an "Unpend" action button.
  pending_user_action?: boolean;
  pending_reason?: string;
  pending_set_at?: string | null;
  pending_set_by?: string;
  // "Blocked by another ticket" flag (ticket 48d14fff) — distinct from
  // pending_user_action so the board/panel render a separate badge and the
  // trigger loop auto-resumes when every prerequisite lands on a terminal
  // column (no human unpend). `prerequisites` is the hydrated link set
  // (loadTicketFull only). `prerequisite_count` is the cheap total-link count
  // attached to board listings so the card can show a dependency badge
  // without loading the full set.
  pending_on_tickets?: boolean;
  prerequisites?: TicketPrerequisiteRow[];
  prerequisite_count?: number;
  // Server-hydrated snapshot of next_ticket_id (loadTicketFull only) —
  // title + current column name so the Next Ticket picker can render the
  // link without a second round-trip. null when unset or when the linked
  // ticket is missing / lives in another workspace.
  next_ticket?: { id: string; title: string; column_name: string } | null;
  created_by: string; // Name of the creator (user or agent)
  created_by_type: 'user' | 'agent' | ''; // Creator type
  created_by_id: string; // GUID — references User.id or Agent.id
  position: number;
  children: Ticket[];
  comments: Comment[];
  // bounded 코멘트 로드 신호: detail GET(loadTicketFull commentLimit)은 `comments`
  // 의 최신 페이지만 싣고, 더 오래된 코멘트가 있으면 이 값을 true 로 세팅한다.
  // 패널은 probe fetch 없이 scroll-load-older 를 켤 수 있다. 전체 eager-load
  // 경로(MCP get_ticket, agent-api)에는 없음(이미 전체 코멘트가 있음).
  comments_has_more?: boolean;
  // 서버 계산 stale-open-question 플래그(bounded detail 로드). 오래된 미답변
  // 질문이 로드된 코멘트 윈도우 밖에 있어도 패널 헤더 배지가 보드 카드와
  // 일치하도록 한다. 전체 eager-load 경로에는 없음.
  has_stale_open_question?: boolean;
  // File attachments stored directly on the ticket (NOT via Resources).
  // Populated as metadata only by `loadTicketFull` — `file_data` is fetched
  // on demand via getTicketAttachment.
  attachments?: TicketAttachmentMeta[];
  created_at: string;
  updated_at: string;
}

export interface Column {
  id: string; // GUID
  board_id: string; // GUID — references Board.id
  name: string;
  position: number;
  color: string;
  description: string;
  is_terminal: boolean;
  tickets: Ticket[];
  created_at: string;
}

export interface Board {
  id: string; // GUID
  workspace_id: string; // GUID — references Workspace.id
  name: string;
  description: string;
  routing_config: string; // JSON: { [columnName]: 'assignee' | 'reporter' | 'reviewer' }
  column_prompts?: string | null; // JSON: { [columnId: string]: promptTemplateId: string }
  // Max distinct tickets one agent can be actively working on at once
  // under this board. Default 1; raise per-board when concurrent local-repo
  // work is safe. Drives the trigger gate on the server side and the
  // defensive cap on the manager side.
  max_concurrent_tickets_per_agent?: number;
  columns: Column[];
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  // Board-wide soft pause. When set, the server drops every agent_trigger
  // for tickets on this board and BacklogPromotionService becomes a no-op.
  // UI surfaces a banner + flips Pause ↔ Resume on the index card.
  paused_at?: string | null;
  // Per-board self-improvement mode. 'off' (default) suppresses the
  // post-done reviewer dispatch; 'same_board' / 'remote_awb' / 'both' opt in
  // and choose where the reviewer files follow-up improvement tickets.
  self_improvement_mode?: 'off' | 'same_board' | 'remote_awb' | 'both';
  // Per-board benchmark mode. 'off' (default) is an ordinary board; 'on' turns
  // the board into a benchmark host — candidate children get scored by
  // evaluator agents on review entry and the Leaderboard panel renders.
  benchmark_mode?: 'off' | 'on';
  // Auto-archive policy: null/absent disables, 1..365 archives Done-column
  // tickets that have been idle for N days — where "idle" means no Done-entry,
  // edit, or comment newer than N days (GREATEST(terminal_entered_at,
  // updated_at, newest comment) older than the cutoff). Server enforces the
  // range; UI maps a disabled toggle to null and re-introduces the previous
  // days value when toggled back on.
  auto_archive_days?: number | null;
  // Per-board agent harness override. Raw JSON string of HarnessConfig (same
  // wire convention as routing_config / column_prompts — the client parses).
  // Keys set here override the workspace default per key at dispatch; null/
  // absent = no override.
  harness_config?: string | null;
  // Per-board abstract effort presets. Stored JSON-encoded (same wire
  // convention as harness_config — the client parses); null/absent falls back
  // to BUILTIN_EFFORT_PRESETS for display. A ticket's `effort_preset` (a preset
  // id) is resolved against this at dispatch into per-CLI options.
  effort_presets?: EffortPresetsConfig | string | null;
  // Per-board output language (i18n). Human-readable language name (e.g.
  // "Korean") folded into the agent's system prompt at dispatch so its
  // comments / chat / commit messages are written in that language. null/
  // absent = no override (agent default, English).
  language?: string | null;
}

// ─── Effort presets (abstract effort → per-CLI options) ─────────
// A Ticket carries an ABSTRACT effort option (a preset id), NOT CLI-specific
// flags. The board defines the presets; each preset maps to per-CLI options.
// Mirror of the server-side contract — both sides must agree byte-for-byte on
// these JSON keys. Claude gets rich options (effort + ultracode + model);
// codex/antigravity get model-only (other keys gracefully skipped at dispatch).
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface EffortPreset {
  id: string;    // stable slug, e.g. 'standard'
  label: string; // human label shown in UI
  // claude: real `--effort` flag (session-level) + `ultracode` PROMPT keyword
  // (appended to the task text, NOT a flag) + optional `--model`.
  claude?: { effort?: EffortLevel; ultracode?: boolean; model?: string };
  // codex / antigravity: model-only (`-m`/`--model`).
  codex?: { model?: string };
  antigravity?: { model?: string };
}

export interface EffortPresetsConfig {
  default: string;           // preset id
  presets: EffortPreset[];
}

// Resolved object the server ships on the SSE agent_trigger payload as
// `effort_preset` — the single matched preset (or board default), or null.
export type ResolvedEffortPreset = EffortPreset;

// Builtin presets used for display when a board has none stored. Identical to
// the server-side BUILTIN_EFFORT_PRESETS — keep in sync.
export const BUILTIN_EFFORT_PRESETS: EffortPresetsConfig = {
  default: 'standard',
  presets: [
    { id: 'light',    label: 'Light',    claude: { effort: 'low' } },
    { id: 'standard', label: 'Standard', claude: { effort: 'medium' } },
    { id: 'deep',     label: 'Deep',     claude: { effort: 'high' } },
    { id: 'max',      label: 'Max',      claude: { effort: 'xhigh', ultracode: true } },
  ],
};

// Agent harness configuration (ticket 7122600c). Mirror of the server-side
// zod schema in apps/server/src/common/harness-config.ts — keep in sync.
// Stored JSON-encoded in Board.harness_config (per-board override) and
// Workspace.harness_config (workspace default); resolution is key-level
// (board wins per key it sets).
export interface HarnessConfig {
  system_prompt_append?: string; // merged into subagent --append-system-prompt
  allowed_tools?: string[];      // claude CLI --allowedTools
  disallowed_tools?: string[];   // claude CLI --disallowedTools
  model?: string;                // --model override
  permission_mode?: string;      // --permission-mode
}

// ─── Board-GET card projections ──────────────────────────────
// The board GET (GET /api/boards/:id) ships a *lightened* payload for the
// kanban cards: each ticket's `comments` relation is projected down to only
// the fields a card renders (count + the stale-open-question badge), and the
// full thread is fetched separately via getTicket (loadTicketFull) when a card
// is opened. These types make that projection explicit so the contract is
// enforced at compile time — a card consumer that reads a dropped field
// (content / author / author_type / parent_id / metadata / attachments) fails
// to build instead of silently reading `undefined` at runtime. Mirror of the
// server projection in apps/server/src/modules/boards/boards.controller.ts
// (BoardCardComment); keep the two field lists in sync. Perf ticket b3812637
// introduced the projection; hardening ticket 24bbd0ad typed it.
export type BoardCardComment = Pick<Comment, 'id' | 'ticket_id' | 'type' | 'status' | 'created_at'>;

// A ticket as it appears on a board card: identical to the full Ticket except
// its `comments` (and recursively its `children`) carry only the narrow
// projection. The detail panel re-fetches the full Ticket via getTicket, so
// only the card pipeline (useBoard → Board → Column → TicketCard) is typed
// with this.
export type BoardCardTicket = Omit<Ticket, 'comments' | 'children'> & {
  comments: BoardCardComment[];
  children: BoardCardTicket[];
};

export type BoardCardColumn = Omit<Column, 'tickets'> & {
  tickets: BoardCardTicket[];
};

export type BoardWithCards = Omit<Board, 'columns'> & {
  columns: BoardCardColumn[];
};

// Benchmark run lifecycle (ticket 5eb459c4). Mirrors BenchmarkService.RunDetail.
export interface BenchmarkRunCandidate {
  candidate_ticket_id: string;
  assignee_agent_id: string;
  assignee_name: string;
  title: string;
  pending: boolean; // parked (draft, not yet dispatched)
  column_id: string;
}

export interface BenchmarkRunDetail {
  run_ticket_id: string;
  title: string;
  state: 'draft' | 'started';
  started_at: number | null;
  board_id: string;
  workspace_id: string;
  run_column_id: string;
  candidate_column_id: string;
  prompt: string;
  rubric: string;
  base_repo: string;
  evaluator_agent_ids: string[];
  evaluators: Array<{ agent_id: string; name: string }>;
  candidates: BenchmarkRunCandidate[];
}

export interface Workspace {
  id: string; // GUID
  name: string;
  description: string;
  boards: Board[];
  board_count?: number;
  // Workspace-wide default agent harness. Raw JSON string of HarnessConfig;
  // boards override it per key via Board.harness_config.
  harness_config?: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 2 chat types — backed by server ChatMessage entity and ChatService aggregations.
export interface ChatMessage {
  id: string; // GUID
  workspace_id: string; // GUID — references Workspace.id
  agent_id: string; // GUID — references Agent.id
  sender_type: 'user' | 'agent';
  sender_id: string; // GUID — User.id or Agent.id
  content: string;
  ticket_id: string | null; // null = global thread, GUID = ticket-scoped thread (D-25)
  created_at: string;
  updated_at: string;
}

export interface ChatThread {
  agent_id: string; // GUID — references Agent.id
  ticket_id: string | null; // null = global thread, GUID = ticket-scoped thread (D-25)
  last_message: ChatMessage | null; // null for synthetic empty threads the UI may inject
  unread_count: number;
}

// ─── Phase 3: Dashboard types ────────────────────────────────
// These mirror the wire shapes emitted by Plan 03-01 (AgentStatusPayload) and
// Plan 03-02 (REST dashboard endpoints). Server-side source of truth:
// - apps/server/src/common/types/stream-events.ts (AgentStatusPayload)
// - apps/server/src/modules/agents/agents.controller.ts (dashboard + :id + :id/activity)
// - apps/server/src/modules/activity/activity.controller.ts (recent activity)

export interface AgentCurrentTask {
  ticket_id: string;
  ticket_title: string;
  claimed_at: string; // ISO-8601
  // Role slug the subagent was spawned for (assignee/reporter/reviewer or
  // workspace-custom). Optional — older plugins don't pin a role.
  role?: string;
}

export interface DashboardAgent {
  id: string;
  name: string;
  /** ST-7 — same semantics as Agent.manager_name. Server populates on
   *  /api/agents/dashboard so the dashboard tile can render
   *  "<ManagerName>/<AgentName>". Optional for back-compat. */
  manager_agent_id?: string | null;
  manager_name?: string;
  avatar_url?: string;
  is_online: boolean;
  last_seen_at: string | null;
  connected_at: string | null;
  workspace_id: string;
  pending_trigger_count: number;
  current_task?: AgentCurrentTask;
}

export interface AgentDetail extends DashboardAgent {
  description?: string;
  type?: string;
  is_active?: number;
  role_prompt: string;                                // '' when redacted per D-44
  role_prompt_meta: { updated_at: string; updated_by: string } | null;
  redacted: boolean;                                  // true for non-admin viewer per D-44
  /** Managed-agent fields. Populated for agents created via the agent-manager
   *  spawn pipeline (manager_agent_id !== null); empty/null on standalone
   *  agents. The detail modal surfaces these in the INFO tab so the same
   *  identity reads the same way on the AI Agents page and the AgentManager
   *  admin page (ticket 7988c041). */
  working_dir?: string;
  credential_id?: string | null;
  /** Set by `_enrichLiveData` server-side when this agent has a heartbeating
   *  process (proxy / daemon) or a supervising manager. The AgentDetail INFO
   *  tab uses live_instance.instance_id to dispatch `set_working_dir` SSE
   *  commands when the operator edits a managed agent's working_dir. */
  live_instance?: AgentLiveInstance;
}

// ActivityRow mirrors the ActivityLog entity shape emitted by GET /api/activity
// and GET /api/agents/:id/activity, with an optional `row_id` used by DashboardPage
// to dedupe between the REST snapshot and live SSE envelopes that may echo the
// same activity event.
export interface ActivityRow {
  id?: string | number;
  row_id?: string;
  entity_type?: string;
  entity_id?: string;
  action: string;
  field_changed?: string;
  old_value?: string;
  new_value?: string;
  actor_id?: string;
  actor_name?: string;
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
  trigger_source?: string;
  created_at: string; // ISO-8601
}

// ── Phase 7: Room-based chat ─────────────────────────
export interface ChatRoomListItem {
  id: string;
  type: 'dm' | 'group';
  // Raw room.name from the server — possibly empty for un-renamed DMs. Use
  // `name || dm_partner_name || 'Direct Message'` (DM) or `name || 'Unnamed
  // Group'` (group) to derive the display label.
  name: string;
  last_message_at: string | null;  // ISO-8601
  created_at: string;
  // Computed by server in room list query:
  unread_count: number;
  last_message_preview: string | null;  // "SenderName: content..." truncated
  last_message_sender: string | null;
  // For DM rooms: the other participant's display name (per-viewer)
  dm_partner_name: string | null;
  dm_partner_type: string | null; // 'user' | 'agent'
  // Light projection of every active participant — drives the room-list
  // filter input (matches members by display name without an extra fetch).
  // Server-side projection added in v0.42; older responses may omit it.
  participants?: Array<{
    participant_type: 'user' | 'agent';
    participant_id: string;
    name: string;
  }>;
}

export interface ChatRoomDetail {
  id: string;
  type: 'dm' | 'group';
  // Raw room.name — may be empty for un-renamed DMs. See ChatRoomListItem.name
  // for the display-fallback contract.
  name: string;
  // Partner display name for DMs (per-viewer); null for group rooms or when
  // the viewer is the only active participant.
  dm_partner_name?: string | null;
  workspace_id: string;
  last_message_at?: string | null;
  created_at: string;
  participants: ChatRoomParticipantInfo[];
}

export interface ChatRoomParticipantInfo {
  id: string;
  participant_type: 'user' | 'agent';
  participant_id: string;
  participant_name: string;
  joined_at: string;
}

export interface ChatAttachment {
  id: string;
  attachment_id?: string;
  workspace_id?: string;
  room_id?: string;
  message_id?: string;
  filename: string;
  file_name?: string;
  mime_type: string;
  file_mimetype?: string;
  size_bytes: number;
  file_size?: number;
  download_url: string;
  thumbnail_url?: string;
  uploaded_by_type?: string;
  uploaded_by_id?: string;
  uploaded_by?: string;
  created_at?: string;
}

export type ChatRoomMessageType = 'message' | 'progress';

export interface ChatRoomMessageItem {
  id: string;
  room_id: string;
  sender_type: 'user' | 'agent' | 'system';
  sender_id: string;
  sender_name: string;           // denormalized by server
  // Discriminator added in v0.41:
  //   'message'  — real chat turn rendered as a bubble.
  //   'progress' — agent-manager tool-call heartbeat, rendered as a compact
  //                muted line (no bubble, no avatar).
  // Optional/undefined collapses to 'message' for legacy rows persisted before
  // the column was added.
  type?: ChatRoomMessageType;
  content: string;
  images?: string | Array<{ data: string; filename: string; mimetype: string }>; // JSON string or parsed array (legacy inline images)
  attachments?: ChatAttachment[]; // new uniform attachment surface (any mimetype)
  created_at: string;
}

// ─── Agent Error Logs (Phase C) ──────────────────────────────
// Error logs uploaded by each agent's MCP plugin (proxy.log tail).
// Server source of truth: apps/server/src/modules/agent-logs/*.
export interface AgentErrorLog {
  id: string;
  agent_id: string;
  agent_name?: string;  // joined from Agent table (server may populate)
  workspace_id: string | null;
  occurred_at: string;   // ISO
  level: 'error' | 'warn' | 'fatal';
  category: string;      // 'crash' | 'sse' | 'presence' | 'subagent' | 'ipc' | 'misc'
  message: string;
  raw_line: string | null;
  pid: string | null;
  plugin_version: string | null;
  created_at: string;
}

export interface AgentErrorLogAgentSummary {
  agent_id: string;
  agent_name: string;
  error_count: number;
}

// SSE envelope wrapping AgentStatusPayload (Plan 03-01 wire shape).
export interface AgentStatusEnvelope {
  event_type: 'agent_status';
  scope: { agent_id: string };
  payload: {
    agent_id: string;
    is_online: boolean;
    last_seen_at: string | null;
    current_task?: AgentCurrentTask;
  };
  timestamp: string;
}

// ─── Agent File Browser (v0.31.0) ───────────────────────────
// Responses returned by the plugin (via /api/agents/:id/fs/*) when browsing
// files on an agent's machine. Path enforcement happens on the plugin side
// against configured scope roots; server is a pure forwarder.
export interface FsListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string;
  mode: number;
}

export interface FsListResult {
  path: string;
  entries: FsListEntry[];
  truncated: boolean;
}

export interface FsStatResult {
  path: string;
  real_path?: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string;
  mode: number;
}

export interface FsReadResult {
  path: string;
  content: string;           // utf8 text, or base64 bytes — see encoding
  encoding: 'utf8' | 'base64';
  size: number;              // full file size at stat time
  read_bytes: number;        // bytes this response actually contains
  offset: number;
  truncated: boolean;        // true when size > offset + read_bytes
  mtime: string;
}

export interface FsRootsResult {
  cwd: string;               // plugin process cwd (may or may not be in scope)
  roots: string[];           // configured scope roots (realpath'd)
  enabled: boolean;          // false when plugin has fs_browser off or no valid roots
  // os.platform() reported by the manager. Lets the picker enable
  // Windows-only affordances (drive-list mode) without sniffing path
  // shapes. Older managers may omit this field.
  platform?: string;
}

// Result of POST /api/agents/:id/fs/mkdir. Shape is a subset of FsStatResult
// so the picker can render the new entry without an extra round-trip.
export interface FsMkdirResult {
  path: string;
  type: 'directory';
  size: number;
  mtime: string;
  mode: number;
}

// Drive-letter / volume-root listing for cross-volume navigation. On
// Windows the picker fetches this when the user goes "up" from a drive
// root (`C:\`) so they can switch to D:/E:/etc; on UNIX the result is
// always the single `/` root.
export interface FsDriveEntry {
  name: string;
  path: string;
}
export interface FsDrivesResult {
  drives: FsDriveEntry[];
}

// ─── Subagent monitor (v0.32) ───────────────────────────────
export type SubagentKind = 'chat' | 'ticket' | 'oneshot';

export interface SubagentSummary {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  kind: SubagentKind;
  session_key: string;
  pid: number;
  started_at: string;
  label?: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number;
  line_count: number;
  // Set once `ended_at` is set; ISO-8601 instant the server will purge the
  // record (default 48h after end). undefined while live.
  expires_at?: string;
  // v0.34: ticket + role context for ticket-kind subagents. Lets the UI show
  // "Ticket title · reviewer" instead of the raw session_key.
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
}

export interface SubagentLogLine {
  direction: 'in' | 'out';
  line: string;
  ts: string;
}

export interface SubagentTranscript {
  summary: SubagentSummary;
  lines: SubagentLogLine[];
}

// One row in the unified SESSIONS panel for an agent. `source` discriminates
// real proxy.mjs ↔ AWB SSE buckets ('proxy') from synthesized rows backed by
// an agent-manager InstanceRegistry record ('manager'). Manager rows surface
// managed agents — which never open their own SSE connection because the
// manager mediates everything — under the same panel as legacy proxy rows so
// the user has a single place to see "what's keeping this agent online".
// Mirrors SseSessionDetail (+ routing flags) on the server.
export interface AgentLiveSession {
  source: 'proxy' | 'manager';
  session_id: string;       // proxy: server-generated UUID; manager: `mgr:<instance_id>`
  connected_at: string;     // proxy: SSE connect time; manager: process started_at
  ip: string;               // proxy: peer IP; manager: 'via manager'
  plugin_version: string;   // X-Plugin-Version (proxy) or InstanceRecord.plugin_version (manager)
  user_agent: string;       // empty for manager rows
  board_id: string | null;
  // Routing flags filled by the server. `is_main` = this session currently
  // receives the agent's recipient-scoped events (triggers, mentions, chat,
  // fs_request) when 2+ proxies are connected. `main_pinned` = the user
  // explicitly picked it; when false but `is_main` is true the server
  // auto-selected (oldest-connected). Both are always false for manager rows —
  // manager rows don't participate in routing; only proxy rows do.
  is_main: boolean;
  main_pinned: boolean;

  // ── Manager-source only (undefined for proxy rows) ─────────────────────
  instance_id?: string;
  manager_agent_id?: string;
  manager_name?: string;
  cli?: string;
  cli_adapters?: string[];
  hostname?: string;
  pid?: number;
  started_at?: string;
  paired_at?: string;
  working_dir?: string;
}

/** @deprecated Use AgentLiveSession. Kept as an alias for ABI compatibility. */
export type AgentProxySession = AgentLiveSession;

// Phase 3 — single daemon/proxy/manager instance heartbeating against AWB.
// Mirrors InstanceRecord in
// apps/server/src/modules/agent-manager/instance-registry.service.ts.
// One Agent row can have multiple instances (proxy + daemon, or several
// machines for the same agent identity); the registry preserves the per-
// process detail the admin dashboard renders. ST-4 adds the 'manager' mode
// for the standalone awb-agent-manager process (claude/codex/antigravity parent).
export interface AgentManagerInstance {
  instance_id: string;
  agent_id: string;
  workspace_id: string | null;
  mode: 'daemon' | 'proxy' | 'manager';
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  // Agent.name from the agents table — the operator-facing label edited
  // via "Edit Identity". Server enriches this on the list response so the
  // admin list can show the configured name instead of the OS hostname.
  // null when the Agent row is missing or has no name set.
  agent_name?: string | null;
  // ST-4 manager-mode fields. Daemons/proxies leave these undefined.
  agent_ids?: string[];
  working_dirs?: string[];
  paired_at?: string;
  // Per-managed-agent CLI credential metadata. One row per supervised
  // agent the manager could read auth state for. Older managers leave
  // this undefined; the UI degrades to "no credential metadata" then.
  agent_credentials?: AgentCredentialEntry[];
  // Per-CLI model lists the manager's installed CLIs accept (cliType →
  // model ids), gathered via each adapter's listModels() at boot. Drives the
  // per-agent model selector in ManagedAgentDialog. Older managers leave
  // this undefined; the UI degrades to a free-text model input then.
  available_models?: Record<string, string[]>;
  // Self-update fields — manager-mode only (managed by the manager's
  // UpdateChecker). Pre-update managers leave these undefined; the UI's
  // version compare degrades to "no info" in that case.
  latest_version?: string | null;
  update_available?: boolean;
  repo_root?: string | null;
  default_branch?: string | null;
  update_last_checked_at?: string | null;
  update_last_error?: string | null;
}

/**
 * Per-managed-agent CLI credential snapshot, reported on the manager's
 * heartbeat. Mirrors AgentCredentialEntry on the manager + server. Never
 * carries the raw token.
 *
 * `kind`:
 *   - 'subscription' — per-agent OAuth credential (OAuth file in cli-home).
 *   - 'api_key' — env-var auth; no expiry concept.
 *   - 'operator_home' — fallback symlink/copy of operator's HOME credential.
 *   - 'unknown' — file present but unrecognized shape.
 *   - 'missing' — no credential file on disk for this agent.
 */
export interface AgentCredentialEntry {
  agent_id: string;
  cli: string;
  kind: 'subscription' | 'api_key' | 'operator_home' | 'unknown' | 'missing';
  /** OAuth access-token expiry (Unix ms); null when not applicable. */
  expires_at_ms: number | null;
  refresh_token_present: boolean;
}

// ST-5 — pairing tokens. PairingTokenMint is the response of
// POST /admin/agent-manager/pair (raw token shown ONCE); PairingTokenSafe is
// the masked listing form (no `token` field). Both share the rest of the
// shape so list rows can render the same metadata.
export interface PairingTokenSafe {
  id: string;
  code: string;
  workspace_id: string;
  created_by_user_id: string;
  agent_name?: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_instance_id: string | null;
}

export interface PairingTokenMint extends PairingTokenSafe {
  token: string; // raw bearer — show once, never persist client-side beyond the modal session
}

// ST-4 control commands surfaced to the manager-mode instance over SSE. The
// UI maps each to a button on the instance detail panel.
export type AgentManagerCommandKind =
  | 'spawn_agent'
  | 'stop_agent'
  | 'restart_agent'
  | 'restart_all_agents'
  | 'set_working_dir'
  | 'reload_config'
  | 'update_plugins'
  | 'refresh_mcp_config'
  | 'pull_working_dir'
  | 'update_manager'
  | 'restart_manager';

export interface AgentManagerCommandResult {
  ok: boolean;
  command_id: string;
  issued_at: string;
}

export interface ManagedAgentCreateBody {
  name: string;
  cli: 'claude' | 'deepseek' | 'codex' | 'antigravity' | 'custom';
  working_dir?: string;
  manager_agent_id?: string | null;
  description?: string;
  /** Optional per-agent CLI credential — see Agent.credential_id. */
  credential_id?: string | null;
  /** Optional per-agent default model — see Agent.model. */
  model?: string | null;
}

// ─── Cross-workspace board move (ticket 8882056b) ───────────────
// Mirror of the server's WorkspaceMoveService.BoardMovePreview /
// MovePreviewItem. The dry-run preview and the committed result share the
// same shape so the UI renders one report type for both.
export interface BoardMovePreviewItem {
  /**
   * restamp — hard UPDATE of workspace_id on a board-owned row
   * copy     — workspace-shared dep duplicated into dest (non-destructive)
   * reuse    — workspace-shared dep already present in dest, id remapped
   * remap    — a referencing id rewritten (role_id, template id, channel id)
   * carry    — companion agent moved along with the board
   * warn     — something the operator should know (cleared dangling link, …)
   * block    — a hard stop; commit is refused while any block item exists
   */
  kind: 'restamp' | 'copy' | 'reuse' | 'remap' | 'carry' | 'warn' | 'block';
  entity:
    | 'board' | 'column' | 'ticket' | 'prompt_template' | 'action' | 'resource'
    | 'workspace_role' | 'role_assignment' | 'channel' | 'agent' | 'api_key' | 'credential';
  id: string;
  detail: string;
}

// ─── Inline blocker remedies (ticket 9efa643b) ──────────────────
// Mirror of the server's WorkspaceMoveService.MoveRemedy / MoveBlocker. A
// blocked preview now ships structured blockers (code + entity refs +
// remedies[]) so each move UI can render an inline fix next to the bullet.
// `message` preserves the legacy human-readable string.
export interface MoveRemedy {
  action: string; // e.g. 'drop_companion_agent', 'unassign_from_tickets', 'set_cross_ref_policy', 'set_api_key_policy', 'clear_credential'
  label: string;
  /** repreview — flip a local move option + re-run the dry-run preview (no write).
   *  mutation  — confirm, POST …/move-to-workspace/remedy, then re-preview. */
  kind: 'repreview' | 'mutation';
  params?: Record<string, any>;
}

export interface MoveBlocker {
  code: string;
  message: string;
  agent_id?: string;
  ticket_ids?: string[];
  fields?: string[];
  credential_id?: string;
  api_key_ids?: string[];
  remedies: MoveRemedy[];
}

export interface BoardMovePreview {
  board: { id: string; name: string };
  source_workspace: { id: string; name: string } | null;
  target_workspace: { id: string; name: string };
  counts: { columns: number; tickets: number; copied: number; remapped: number; restamped: number };
  items: BoardMovePreviewItem[];
  /** Non-empty → commit is refused. Structured blockers carry inline remedies;
   *  `message` is the legacy human-readable reason. */
  blockers: MoveBlocker[];
  carry_agents: boolean;
  /** false for a dry-run preview, true once the transaction has committed. */
  committed: boolean;
}

// ─── Cross-workspace agent move (ticket 868ead64) ───────────────
// Mirror of the server's WorkspaceMoveService.AgentMovePreview. Shares the
// MovePreviewItem shape with the board move (same kinds/entities).
export type AgentApiKeyPolicy = 'migrate' | 'clear' | 'refuse';
export type AgentCrossRefPolicy = 'block' | 'clear';

export interface AgentMovePreview {
  agent: { id: string; name: string };
  source_workspace: { id: string; name: string } | null;
  target_workspace: { id: string; name: string };
  counts: { api_keys: number; copied: number; cleared: number; cross_refs: number };
  items: BoardMovePreviewItem[];
  /** Non-empty → commit is refused. Structured blockers carry inline remedies;
   *  `message` is the legacy human-readable reason. */
  blockers: MoveBlocker[];
  api_key_policy: AgentApiKeyPolicy;
  cross_ref_policy: AgentCrossRefPolicy;
  /** false for a dry-run preview, true once the transaction has committed. */
  committed: boolean;
}
