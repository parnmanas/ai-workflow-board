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
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface Credential {
  id: string;
  workspace_id: string;
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

// Hydrated Resource metadata returned with a comment. file_data is the
// raw base64 payload — the server ships it inline so the UI can render
// image thumbnails (<img src="data:...">) and kick off downloads without
// a second round-trip per attachment.
export interface CommentAttachment {
  id: string; // Resource.id (type='comment_attachment')
  file_name: string;
  file_mimetype: string;
  file_data: string;
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
  created_by: string; // Name of the creator (user or agent)
  created_by_type: 'user' | 'agent' | ''; // Creator type
  created_by_id: string; // GUID — references User.id or Agent.id
  position: number;
  children: Ticket[];
  comments: Comment[];
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
  columns: Column[];
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string; // GUID
  name: string;
  description: string;
  boards: Board[];
  board_count?: number;
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
  name: string;                    // group name or empty for DM
  last_message_at: string | null;  // ISO-8601
  created_at: string;
  // Computed by server in room list query:
  unread_count: number;
  last_message_preview: string | null;  // "SenderName: content..." truncated
  last_message_sender: string | null;
  // For DM rooms: the other participant's display name (per-viewer)
  dm_partner_name: string | null;
  dm_partner_type: string | null; // 'user' | 'agent'
}

export interface ChatRoomDetail {
  id: string;
  type: 'dm' | 'group';
  name: string;
  workspace_id: string;
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

export interface ChatRoomMessageItem {
  id: string;
  room_id: string;
  sender_type: 'user' | 'agent';
  sender_id: string;
  sender_name: string;           // denormalized by server
  content: string;
  images?: string | Array<{ data: string; filename: string; mimetype: string }>; // JSON string or parsed array
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

// One live SSE connection (proxy.mjs ↔ AWB) for an agent. The Agent
// Details modal renders a list so the user can spot multi-proxy
// situations. `session_id` is server-generated and stable for the
// lifetime of the connection. Fields mirror SseSessionDetail in
// EventsController on the server side.
export interface AgentProxySession {
  session_id: string;
  connected_at: string;
  ip: string;            // X-Plugin-Ip from plugin (preferred), else
                          // reverse-proxy chain, else 'unknown'
  plugin_version: string; // X-Plugin-Version from plugin; 'unknown' for
                          // pre-v0.35.5 plugins that don't ship it
  user_agent: string;
  board_id: string | null;
}

// Phase 3 — single daemon/proxy/manager instance heartbeating against AWB.
// Mirrors InstanceRecord in
// apps/server/src/modules/agent-manager/instance-registry.service.ts.
// One Agent row can have multiple instances (proxy + daemon, or several
// machines for the same agent identity); the registry preserves the per-
// process detail the admin dashboard renders. ST-4 adds the 'manager' mode
// for the standalone awb-agent-manager process (claude/codex/gemini parent).
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
  // ST-4 manager-mode fields. Daemons/proxies leave these undefined.
  agent_ids?: string[];
  working_dirs?: string[];
  paired_at?: string;
}
