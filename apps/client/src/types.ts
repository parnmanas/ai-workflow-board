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

export interface AgentChannelIdentity {
  id: string; // GUID
  agent_id: string; // GUID — references Agent.id
  channel_type: string;
  channel_external_id: string;
  display_name: string;
  created_at: string;
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
  channel_identities: AgentChannelIdentity[];
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

export interface CommentImage {
  filename: string;
  mimetype: string;
  data: string; // base64
}

export interface Comment {
  id: string; // GUID
  ticket_id: string; // GUID — references Ticket.id
  author_type: 'user' | 'agent' | 'system';
  author_id: string; // GUID — references User.id or Agent.id
  author: string;
  content: string;
  images: CommentImage[];
  created_at: string;
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
  tickets: Ticket[];
  created_at: string;
}

export interface Board {
  id: string; // GUID
  workspace_id: string; // GUID — references Workspace.id
  name: string;
  description: string;
  routing_config: string; // JSON: { [columnName]: 'assignee' | 'reporter' | 'reviewer' }
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
  role_prompt: string;                                // '' when redacted per D-44
  role_prompt_meta: { updated_at: string; updated_by: string } | null;
  redacted: boolean;                                  // true for non-admin viewer per D-44
  channel_identities?: any[];
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
