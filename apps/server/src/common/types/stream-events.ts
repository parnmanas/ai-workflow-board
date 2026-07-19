// Unified SSE event envelope — see .planning/phases/01-foundation/01-CONTEXT.md D-06/D-07/D-08
// ALL five event types listed here; only the first three have producers in Phase 1.
// chat_message (Phase 2) and agent_status (Phase 3) are skeleton-only — type declared,
// filter branch exists, NO emit producer. This is the explicit D-08 scope.

import type { HarnessConfig } from '../harness-config';
import type { ResolvedEffortPreset } from '../effort-presets';
import type { ResolvedEnvironmentConfig } from '../environment-config';
import type { RunProvision } from '../workspace-folder-options';
import type { WorktreeMode } from '../worktree-config';

export type StreamEventType =
  | 'board_update'
  | 'agent_typing'
  | 'agent_trigger'
  | 'chat_message'
  | 'agent_status'
  | 'chat_request'         // Phase 4 D-71/D-72 — proxy.mjs consumes this to spawn chat subagents
  | 'chat_room_message'    // Phase 7: new message in a chat room
  | 'chat_room_update'     // Phase 7: room renamed / participant added / user left
  | 'chat_room_typing'     // Phase 7+: agent typing indicator in a chat room
  | 'comment_mention'      // Mention feature: agent @-mentioned in a ticket comment
  | 'user_mention'         // Mention feature: user @-mentioned (web UI unread badge)
  | 'comment_typing'       // Phase-9 typed comments: someone is composing a comment on a ticket
  | 'ticket_presence'      // Tier-1 E: viewer set for a ticket (who has the panel open)
  | 'fs_request'           // File browser: server → plugin reverse RPC to read agent-machine files
  | 'subagent_registered'  // Subagent monitor: plugin spawned a subagent
  | 'subagent_log'         // Subagent monitor: stream-json line in/out
  | 'subagent_ended'       // Subagent monitor: subagent process exited
  | 'agent_instance_update' // Agent Manager: daemon/proxy instance heartbeat / removal
  | 'agent_manager_command' // ST-4: AWB → awb-agent-manager control message (spawn/stop/reload-config)
  | 'consensus_update';     // 다중담당자·합의 T4: 합의 상태 변화 (UI T6 소비, agent 비소비)

export interface StreamEventScope {
  board_id?: string;
  agent_id?: string;
  user_id?: string;
  workspace_id?: string;    // v0.32: workspace-scoped events (subagent monitor)
  ticket_id?: string; // Phase 2 D-26 — chat thread scoping (global vs ticket-scoped)
  room_id?: string;         // Phase 7: chat room targeting
  member_ids?: Set<string>; // Phase 7: pre-resolved participant user IDs for sync filter
  agent_member_ids?: Set<string>; // Phase 7: pre-resolved agent participant IDs for proxy delivery
}

export interface StreamEvent<P = unknown> {
  event_type: StreamEventType;
  scope: StreamEventScope;
  payload: P;
  timestamp: string;
}

// ── Payload shapes ─────────────────────────────────────────

export interface BoardUpdatePayload {
  ticket_id: string;
  repository_resource_id?: string;
  entity_type: string;
  action: string;
  field_changed?: string;
  actor_name?: string;
}

export interface AgentTypingPayload {
  ticket_id: string;
  agent_id: string;
  is_typing: boolean;
}

export interface AgentTriggerPayload {
  trigger_id: string;
  ticket_id: string;
  agent_id: string;
  role: string;
  role_prompt: string;      // D-20 — populated by trigger-loop in Task 3
  ticket_prompt: string;    // D-20 — populated by trigger-loop in Task 3
  trigger_source: string;
  // phase12 — board column → prompt-template content; null when no template wired
  column_prompt: { template_id: string; name: string; content: string } | null;
  // Ticket's configured base repository (Resource of type='repository') and
  // base branch — agent-manager renders these into the in-progress prompt so
  // the agent fetches + branches off the right ref. Both null/empty when the
  // ticket leaves them unset (pure-discussion / non-code work).
  base_repo: { id: string; name: string; url: string; default_branch: string } | null;
  base_branch: string;
  // TicketSupervisor signal: plugin should kill any live subagent for this
  // ticket before handling the trigger. Set when a wedged session has failed
  // to advance my_last_update_at after the initial supervisor re-push.
  force_respawn?: boolean;
  // Per-board cap on distinct active tickets per agent. Server's
  // TriggerLoopService is the primary enforcer; this field is forwarded so
  // the manager can keep a defensive drop in case two triggers raced past
  // the server gate (set_current_task lags the trigger by the spawn
  // round-trip). Defaults to 1 in the manager when absent.
  max_concurrent_tickets_per_agent?: number;
  // Resolved harness config (ticket e9c7a896): workspace default merged with
  // the board override via resolveHarnessConfig(). agent-manager maps the
  // keys onto subagent CLI flags at spawn time (--append-system-prompt /
  // --allowedTools / --disallowedTools / --model / --permission-mode).
  // Null when neither layer configures a harness — the manager must treat
  // null as "spawn exactly as before".
  harness_config?: HarnessConfig | null;
  // Resolved abstract effort preset: the board's effort_presets catalog
  // matched against the ticket's effort_preset id (or the catalog default).
  // agent-manager maps this onto per-CLI options at spawn — for claude the
  // `claude.effort` block becomes the `--effort` flag and `claude.ultracode`
  // appends the literal "ultracode" PROMPT KEYWORD to the task turn (not a
  // flag); codex/antigravity take model-only and gracefully skip the rest.
  // Null when the board has no presets or resolution fails — treat as "no
  // effort override, spawn exactly as before".
  effort_preset?: ResolvedEffortPreset | null;
  // Resolved environment setup (ticket 354d336b): workspace default merged
  // with the board override via mergeEnvironmentConfig(), then each repository's
  // resource_id expanded to a concrete url/branch. agent-manager provisions
  // the working environment just before spawning the subagent — clone/update
  // repos under the agent home, run setup commands, inject env_vars — guarded
  // by a per-(agent,board) fingerprint marker so a prepared environment is not
  // re-provisioned. Null when neither layer configures an environment (or
  // nothing resolves to a cloneable/runnable step) — the manager must treat
  // null as "no provisioning, spawn exactly as before".
  environment_config?: ResolvedEnvironmentConfig | null;
  // Resolved board worktree placement mode (worktree 규약 ②, board option ①).
  // 'per_ticket' → one worktree per ticket at `<working_dir>/.awb/wt/<ticket8>`;
  // 'shared' → one reused worktree at `<working_dir>/.awb/wt/shared`. agent-manager's
  // WorktreeManager.resolveCwd reads this to pick the worktree slug at spawn.
  // Absent/undefined → the manager defaults to 'per_ticket' (DEFAULT_WORKTREE_MODE),
  // so a pre-② server that never sets the field keeps today's per-ticket behaviour.
  worktree_mode?: WorktreeMode;
  // Working_dir-relative worktree folder AWB assigns this ticket (worktree 규약 ④):
  // `.awb/wt/<ticket8>` (per_ticket) or `.awb/wt/shared` (shared) — computed from
  // worktree_mode via resolveWorktreeRelPath(), mirroring the manager's slug so
  // the two agree on placement. The server never knows the absolute working_dir,
  // so it ships only this relative path; agent-manager substitutes the
  // `{{AWB_WORK_FOLDER}}` placeholder in the column-prompt with the ACTUAL resolved
  // worktree cwd (which equals this joined onto working_dir) so the trigger prompt
  // names the exact folder the subagent is spawned in — and falls back to this
  // relative path only when it can't resolve a concrete cwd. Absent/undefined →
  // the manager leaves any placeholder untouched (byte-identical to a pre-④ prompt).
  worktree_rel_path?: string;
}

// Phase 2 D-26 — finalized payload shape emitted by chat producers.
// Plan 02-01 pins the full field set Plans 02/03 will emit and Plan 04 will render.
export interface ChatMessagePayload {
  message_id: string;
  sender_type: 'user' | 'agent';
  sender_id: string;
  recipient_agent_id: string;
  content: string;
  ticket_id?: string;
  created_at: string; // ISO-8601; carried alongside envelope.timestamp for client-side rendering
}

// One entry in an agent's live task list. Board-ticket tasks (kind:'ticket')
// carry the ticket id + title; QA-run tasks (kind:'qa') carry the run id as
// `ticket_id` and the scenario name as `ticket_title` (a QA run is not a board
// ticket). `kind` is absent on the legacy singular current_task shape — treat
// absent as 'ticket'.
export interface AgentActiveTask {
  ticket_id: string;
  ticket_title: string;
  claimed_at: string;  // ISO-8601
  role?: string;       // role slug the subagent was spawned for; undefined for older plugins
  kind?: 'ticket' | 'qa';
}

// Phase 3 — producer wired in Plan 03-01 (AgentStatusService + agentStatusListener)
export interface AgentStatusPayload {
  agent_id: string;
  is_online: boolean;
  last_seen_at: string | null;  // ISO-8601
  // Derived lifecycle state (ticket bfdd80b7): never_started | starting | online
  // | offline | error. Additive — older clients that only read is_online keep
  // working. The client badge reads this so "created but never started" is
  // finally distinguishable from "online" (the whole silent-drop bug was that
  // they looked identical). Optional so a legacy emit without it degrades to
  // the is_online view.
  lifecycle_state?: 'never_started' | 'starting' | 'online' | 'offline' | 'error';
  // Concrete reason for the `error` lifecycle state (ticket 1f750878) — e.g.
  // "Agent Manager 가 오프라인이라 …" for a known feasibility slug, or the
  // manager-side spawn-failure detail (working_dir empty / apiKey provisioning /
  // pool exhausted …) surfaced by the /command/ack closed loop. The client badge
  // renders it as a tooltip so "구체 실패 사유" is visible instead of a bare 오류.
  // Additive + conditional-omit: present only when lifecycle_state==='error'.
  lifecycle_detail?: string;
  // Legacy singular — most-recently-claimed task. Kept so older clients that
  // read only current_task keep rendering. New clients read active_tasks.
  current_task?: {
    ticket_id: string;
    ticket_title: string;
    claimed_at: string;  // ISO-8601
    role?: string;       // role slug the subagent was spawned for; undefined for older plugins
  };
  // Full live task list for concurrency N (max_concurrent_tickets_per_agent > 1).
  // Carries board-ticket tasks (kind:'ticket') FOLLOWED BY in-progress QA-run
  // tasks (kind:'qa'). The QA half is pushed live on QA run start/finalize
  // (ticket 09ed8def) so the AI Agents view surfaces a QA run the instant it
  // begins/ends, not just on the next REST refetch — every agent_status emit
  // carries the full authoritative list, so clients replace active_tasks
  // wholesale (no client-side QA preservation needed). The REST /dashboard and
  // /:id responses merge the same two sources. Absent/[] = idle.
  active_tasks?: AgentActiveTask[];
}

// Phase 4 D-71/D-72/D-73 — emitted by ChatService.sendUserMessage on activityEvents 'chat_request'.
// Proxy.mjs consumes this envelope-native (NOT flattened) to spawn a dedicated chat subagent per
// conversation (CHAT-09 completion via Phase 4 delegation path). Per-agent delivery only:
// only the target agent's connected proxy sees the event.
export interface ChatRequestHistoryEntry {
  message_id: string;
  sender_type: 'user' | 'agent';
  content: string;
  attachments?: Array<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    thumbnail_url?: string;
    download_url: string;
  }>;
  created_at: string; // ISO-8601
}

export interface ChatRequestPayload {
  agent_id: string;
  user_id: string;
  ticket_id: string | null;
  role_prompt: string;
  new_message: string;
  history: ChatRequestHistoryEntry[];
  // Source room id for the chat_request. Always set when the request was
  // emitted from a chat room (DM auto-route or @mention) — without it the
  // agent has no way to know which room to reply into via
  // mcp__awb__send_chat_room_message, so the persistent-chat-session path
  // in agent-manager will fall through to the legacy one-shot subagent
  // (which can only guess the room).
  room_id?: string;
}

// F-1 (ticket 24694916) — structured ticket-action reference. The agent-manager
// captures these mechanically from mcp__awb__* tool results (create/move/update/
// comment/…) and emits them on its own coalesced chat message, so an agent ticket
// action renders as a reliable card even when the model never types an
// @[ticket:...] token in prose. Kept a NAMED interface (not an inline literal) so
// the event-registry parity guard treats `metadata` as pass-through — only the
// top-level key must appear in map(), not each sub-field.
export interface ChatMessageTicketRef {
  // Action verb derived from the MCP tool name: 'create' | 'move' | 'update' |
  // 'comment' | 'claim' | 'pend' | 'unpend' | 'archive' | 'delete'.
  action: string;
  ticket_id: string;
  // Best-effort human label pulled from the tool result (or an agent-manager
  // per-session title cache). The client card falls back to the id when absent,
  // and the Artifact panel fetches full detail on click.
  title?: string;
  // F2-4 ⓑ 승인 카드: 제안/합의 계열(propose_move·record_agreement) ref 의 부가 맥락.
  // propose_move 결과의 대상 컬럼 이름을 담아 클라가 "→ <컬럼> 이동 제안" 배지를
  // 렌더한다. additive/nullable — 여타 action 은 이 필드를 안 실으며 legacy 카드는 무시.
  detail?: string;
}
// F2-4 ⓒ 결과물 카드: 빌드/배포 등 결과물성 tool 결과를 티켓 ref 와 별도로 방출한다.
// register_build_artifact·report_build_failure·report_deployment 는 티켓 row 를
// 바꾸지 않으므로(비-ticket) ticket_refs 로 못 싣는다 — 자체 shape 로 캡처해 카드화.
// 전부 additive/nullable, 마이그레이션 불요.
export interface ChatMessageArtifactRef {
  // 'build' — register_build_artifact / report_build_failure
  // 'deploy' — report_deployment
  kind: string;
  // 표시 라벨: 빌드는 target(+status), 배포는 environment.
  title: string;
  // 빌드/배포 상태: 'ok' | 'building' | 'failed' | 'deployed' 등(원본 tool status 반영).
  status?: string;
  // 결과물이 가리키는 커밋 SHA(있으면).
  commit?: string;
  // 배포 base_url 등 열람 대상 URL(있으면).
  url?: string;
}
export interface ChatRoomMessageMetadata {
  ticket_refs?: ChatMessageTicketRef[];
  // F2-4 ⓒ: 빌드/배포 결과물 카드. ticket_refs 와 독립적으로 존재 가능 —
  // 한쪽만 있어도 metadata 는 유지된다(sanitizer 독립 처리).
  artifact_refs?: ChatMessageArtifactRef[];
}

// Phase 7 — room-based chat
export interface ChatRoomMessagePayload {
  room_id: string;
  message_id: string;
  sender_type: 'user' | 'agent' | 'system';
  sender_id: string;
  sender_name: string;
  // Discriminator added in v0.41:
  //   'message'  — real chat turn (user input or agent's send_chat_room_message reply)
  //   'progress' — tool-call heartbeat the agent-manager posts while the
  //                spawned CLI is working. Rendered compactly and stripped
  //                from agent history replay.
  // Optional on the wire so legacy clients/agents that omit it default to
  // 'message' (matches the column default on chat_room_messages).
  type?: 'message' | 'progress';
  content: string;
  attachments?: Array<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    thumbnail_url?: string;
    download_url: string;
  }>;
  created_at: string; // ISO-8601
  // v0.33: trailing consecutive agent-sender count in the room, including this
  // message. user-sent → 0; agent reply to a user → 1; agent reply to that → 2…
  // Plugin uses it to break agent-to-agent ping-pong loops by skipping
  // delegation once a configurable cap is hit.
  agent_chain_depth?: number;
  // Agent participants of the room. Carried on the wire so an agent-manager
  // receiving the SSE event (via the managed-agent fan-out in
  // events.controller) can resolve which of its managed agents are members
  // and spawn the chat session under that agent's identity. Without this,
  // the manager has no way to pick the correct apiKey/cwd and the spawn
  // would default to the manager's identity — leading to a 403 when the
  // spawned CLI tries to send_chat_room_message into a room it does not
  // belong to.
  agent_member_ids?: string[];
  // ticket 4: run-workspace provisioning hint. Present ONLY on a QA/security run
  // dispatch message (the system 'user' send that opens the run room) — absent on
  // every ordinary chat turn. The agent-manager reads it to prepare the run's
  // working folder (clone/pull, reuse vs fresh) and pin the subagent cwd BEFORE
  // spawning, so the run never improvises a folder. Forwarded verbatim on the
  // wire; consumers that don't understand it ignore the field.
  run_provision?: RunProvision;
  // ticket e6d32e9d: true when this room was minted by an Action dispatch
  // (ActionsService stamps ChatRoom.action_id). Action Runs reuse the chat-room
  // pipeline, but their intent is the OPPOSITE of a chat: the agent must perform
  // the requested work DIRECTLY, not file an AWB ticket for it. The agent-manager
  // reads this to swap the composeChatRoomPrompt "this is a CHAT channel, create a
  // ticket" instruction for a "do the work directly" variant. Conditional-omit on
  // the wire (absent for ordinary chat turns) so the legacy shape is byte-for-byte
  // unchanged for non-Action rooms.
  is_action_room?: boolean;
  // F-1 (ticket 24694916): structured message metadata. Carries `ticket_refs`
  // captured by the agent-manager from mcp__awb__* tool results, driving the
  // reliable ticket-action card render on the client. Conditional-omit on the
  // wire (absent for ordinary chat turns) so the legacy shape is unchanged.
  metadata?: ChatRoomMessageMetadata;
}

export interface ChatRoomUpdatePayload {
  room_id: string;
  update_type: 'renamed' | 'participant_added' | 'participant_left' | 'read';
  new_name?: string;
  participant_id?: string;
  participant_ids?: string[];

  // B3 fix: `read` events carry the reader's identity + the new marker so that
  // other tabs / devices of the same user can sync their local unread_count
  // without a round-trip to the room list. `participant_type` disambiguates
  // user vs agent when the same UUID collides across domains.
  participant_type?: 'user' | 'agent';
  last_read_at?: string; // ISO-8601
  // See ChatRoomMessagePayload — same managed-agent fan-out reason.
  agent_member_ids?: string[];
}

export interface ChatRoomTypingPayload {
  room_id: string;
  agent_id: string;
  agent_name: string;
  is_typing: boolean;
  status?: string | null;
  // See ChatRoomMessagePayload — same managed-agent fan-out reason.
  agent_member_ids?: string[];
}

// Mention feature — comment-sourced @-mention delivered to a specific agent.
// Proxy.mjs consumes this natively (flattened to top level) and synthesizes a
// "this comment is addressed to YOU" subagent prompt so the agent doesn't
// confuse ambient comment-activity noise with a direct request.
export interface CommentMentionPayload {
  ticket_id: string;
  comment_id: string;
  workspace_id: string;
  agent_id: string;
  actor_id: string;
  actor_type: 'user' | 'agent';
  actor_name: string;
  content: string;
  role_prompt: string;
  mention_source: 'direct' | 'role'; // direct @-mention vs. @assignee-style role shortcut
  role_shortcut?: string; // 'assignee' | 'reporter' | 'reviewer' when mention_source === 'role'
}

// Phase-9 typed comments — fires when a user/agent starts composing a comment
// on a ticket. Scoped per ticket so other viewers of the same ticket can render
// "X is typing..." without polluting the workspace-wide stream. The actor is
// excluded from delivery (filter in event-registry) so they don't see their own
// typing echoed back.
export interface CommentTypingPayload {
  ticket_id: string;
  workspace_id: string;
  actor_type: 'user' | 'agent';
  actor_id: string;
  actor_name: string;
  is_typing: boolean;
  // Optional discriminator hint — reserves room for "Alice is asking a question"
  // vs. "Alice is writing a chat" UX in a later phase.
  comment_type?: string;
}

// Tier-1 E — ticket-presence transition. Emitted when the viewer set for a
// ticket changes (someone opened the panel / their heartbeat expired / they
// left explicitly). Steady-state heartbeats DON'T fire this event; only
// transitions do, so traffic is bounded by the join/leave rate not the ping
// rate. Workspace-scoped so the client can ignore presence for tickets they
// can't see.
export interface TicketPresencePayload {
  ticket_id: string;
  workspace_id?: string;
  viewers: Array<{ type: 'user' | 'agent'; id: string; name: string }>;
}

// Mention feature — user @-mentioned. Fires only for the mentioned user's
// connected sessions so the sidebar badge reconciles without a round-trip.
export interface UserMentionPayload {
  mention_id: string;           // UserMention.id
  user_id: string;              // mentioned user
  workspace_id: string;
  source_type: 'comment' | 'chat_message';
  source_id: string;
  ticket_id: string | null;
  // Resolved board for comment mentions so the inbox can build a
  // /ws/<wsId>/boards/<boardId>?ticket=<id>&comment=<id> deep link
  // without a second round-trip. Null for chat mentions (deep link
  // uses room_id instead).
  board_id: string | null;
  room_id: string | null;
  actor_id: string;
  actor_type: 'user' | 'agent';
  actor_name: string;
  preview: string;
  created_at: string; // ISO-8601
}

// File browser — server emits this toward a specific agent's SSE stream to ask
// the plugin to perform a filesystem op on the agent's machine. Plugin answers
// via HTTP POST to /api/fs/responses/:request_id (out-of-band — not SSE) so
// response bodies aren't constrained by event-stream framing. Scope root
// enforcement lives in the plugin, not here — server is a pure forwarder.
export interface FsRequestPayload {
  request_id: string;                        // server-generated uuid; plugin echoes it on the response POST
  agent_id: string;                          // target agent (matches identity for filter)
  op: 'list' | 'stat' | 'read' | 'mkdir' | 'roots' | 'drives';
  path: string;                              // absolute path on the agent machine
  offset?: number;                           // read: byte offset (default 0)
  limit?: number;                            // read: max bytes (server caps at 5MB)
  name?: string;                             // mkdir: single-segment name of the new folder under `path`
}

// Subagent monitor — plugin reports subagent lifecycle + stream-json traffic
// to the AWB server so the web UI can render a live transcript across every
// agent machine. Storage is in-memory only (live debug, not audit log) and a
// subagent's record is dropped when its process exits or when the plugin
// disconnects, so the dataset stays bounded without explicit pruning.
export interface SubagentRegisteredPayload {
  subagent_id: string;        // plugin-generated uuid; identifies one transcript
  agent_id: string;           // parent registered agent
  workspace_id: string;
  kind: 'chat' | 'ticket' | 'oneshot';
  session_key: string;        // 'ticket:<id>:<role>' | 'room:<id>' | 'oneshot:<trigger_id>'
  pid: number;
  started_at: string;
  // Optional human-readable label the UI shows in the list (e.g., ticket title
  // or room name). Plugin best-effort fills this; server doesn't validate.
  label?: string;
  // v0.34: ticket + role context for ticket-kind subagents. Lets the UI show
  // "Ticket title · reviewer" instead of just an opaque session key. Both
  // optional — older plugins and chat/oneshot subagents leave them undefined.
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
}

export interface SubagentLogPayload {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  // direction is from the subagent's POV: 'in' = parent → subagent stdin
  // (i.e. our composed turn prompts), 'out' = subagent stdout (the model's
  // responses, tool_use frames, thinking blocks, etc.).
  direction: 'in' | 'out';
  // Raw stream-json line. UI parses; server is a pure forwarder.
  line: string;
  ts: string;
}

export interface SubagentEndedPayload {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  ended_at: string;
  // ISO-8601 instant at which the server will purge this record from the
  // in-memory registry. Drives the "expires in 47h 32m" hint in the UI.
  expires_at?: string;
}

// Phase 3 — Agent Manager dashboard. Emitted by InstanceRegistryService on
// every heartbeat upsert and on TTL eviction, so the admin UI can render
// live instance state without polling. The full record is shipped on each
// event because the dashboard list is small (one row per running daemon /
// proxy on each host) and the diff would be more code than the payload.
export interface AgentInstanceUpdatePayload {
  action: 'registered' | 'updated' | 'removed';
  instance: {
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
    agent_ids?: string[];
    working_dirs?: string[];
    paired_at?: string;
    // NOTE: `active_worktrees` (ticket 72fc244f) is intentionally NOT on this SSE
    // payload — it is REST-only telemetry, exactly like `agent_credentials` /
    // `available_models`. The admin dashboard reads `agent_instance_update` only
    // as a "re-fetch" hint and renders worktrees from the REST instance list
    // (GET /admin/agent-manager/instances), which is where the raw registry rows
    // get their `ticket_id → ticket_title` join. Declaring it here (without also
    // forwarding it in event-registry.ts `map()`) would trip the payload-parity
    // guard and ship an untitled, unread raw row on the wire for no gain.
    // Self-update fields — populated by manager-mode heartbeats. Pre-update
    // managers leave them undefined; the admin UI handles the missing case.
    latest_version?: string | null;
    update_available?: boolean;
    repo_root?: string | null;
    default_branch?: string | null;
    update_last_checked_at?: string | null;
    update_last_error?: string | null;
  };
}

// ST-4 — AWB → awb-agent-manager control messages. The manager subscribes
// to its own SSE stream (auth via the agent API key it minted at pair time),
// matches `instance_id` to the one it advertises in its heartbeat, and
// dispatches the named command. ack arrives via REST POST so the failure
// path of an in-flight SSE doesn't strand the request.
export type AgentManagerCommand =
  | 'spawn_agent'        // start a CLI for a specific agent identity
  | 'stop_agent'         // SIGTERM the running CLI for an agent identity
  | 'restart_agent'      // stop + spawn
  | 'restart_all_agents' // reap+respawn every managed agent in place; manager process stays up (zero downtime, fresh credential + immediate in-flight re-push per agent)
  | 'set_working_dir'    // update Agent.working_dir on disk + reload
  | 'reload_config'      // re-read config.json (e.g., after admin edits delegation tunables)
  | 'update_plugins'     // git pull every plugin marketplace under the managed agent's cli-home
  | 'refresh_mcp_config' // rewrite mcp-config.json so spawned subagents see the current AWB url
  | 'update_manager'     // pull + install + build the manager itself, then re-exec
  | 'restart_manager';   // re-exec the manager in place (no git pull / build) so a fresh process takes over the lockfile

export interface AgentManagerCommandPayload {
  // The dispatch correlation id — manager echoes it on /command/ack so the
  // admin UI can tell whether the command landed and which one this was.
  command_id: string;
  // Targets the manager process: must match InstanceRecord.instance_id the
  // manager advertised in its last heartbeat. Other instances on the same
  // host (or other agents on the same manager-agent identity) ignore the
  // event.
  instance_id: string;
  // The supervising agent-manager Agent row (used for SSE filtering — only
  // this agent's stream sees the command).
  agent_id: string;
  command: AgentManagerCommand;
  args: Record<string, any>;
  issued_by: string;     // user_id of the admin who triggered the command
  issued_at: string;     // ISO-8601
}

/**
 * 다중담당자·합의 T4 — 합의 상태 변화 push. `record_agreement` 시그널 직후
 * 서버가 재판정한 상태를 UI(T6)로 흘린다. agent(agent-manager 포함)는 소비하지
 * 않으므로 registry filter 는 user-only — SSE contract 상 agent-manager 무관.
 * T5 이동 게이트는 이 이벤트를 기다리지 않고 이동 시점에 서버에서 재계산한다.
 *
 * 모든 필드는 flat primitive — event-registry map() 이 필드별로 그대로 전달
 * (패리티 가드가 누락을 머지 시점에 잡는다). 세부 홀더 목록은 UI 가 필요 시
 * REST 로 재조회한다.
 */
export interface ConsensusUpdatePayload {
  ticket_id: string;
  workspace_id: string;
  proposal_id: string | null; // 판정이 고정된 이동 제안(앵커). null = 제안 무관.
  satisfied: boolean;         // 지금 합의 성립 여부.
  required: number;           // 필수 홀더 수.
  agreed: number;
  objected: number;
  pending: number;            // 미투표 + stale.
  status: 'agree' | 'object'; // 방금 캐스트된 시그널.
  override: boolean;          // reporter 강제 통과 여부.
  actor_id: string;           // 시그널을 남긴 홀더.
  actor_name: string;
}
