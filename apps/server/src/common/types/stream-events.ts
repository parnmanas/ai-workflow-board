// Unified SSE event envelope — see .planning/phases/01-foundation/01-CONTEXT.md D-06/D-07/D-08
// ALL five event types listed here; only the first three have producers in Phase 1.
// chat_message (Phase 2) and agent_status (Phase 3) are skeleton-only — type declared,
// filter branch exists, NO emit producer. This is the explicit D-08 scope.

import type { HarnessConfig } from '../harness-config';
import type { ResolvedEffortPreset } from '../effort-presets';
import type { ResolvedEnvironmentConfig } from '../environment-config';
import type { ResolvedClonePolicy } from '../clone-policy';
import type { RunProvision } from '../workspace-folder-options';
import type { WorktreeMode } from '../worktree-config';
import type { CliRuntimeProfile } from '../cli-runtime-profiles';

export type StreamEventType =
  | 'board_update'
  | 'agent_typing'
  | 'agent_trigger'
  | 'chat_message'
  | 'agent_status'
  | 'chat_request'         // Phase 4 D-71/D-72 — Runtime Host consumes this for chat work
  | 'chat_room_message'    // Phase 7: new message in a chat room
  | 'chat_room_update'     // Phase 7: room renamed / participant added / user left
  | 'chat_room_typing'     // Phase 7+: agent typing indicator in a chat room
  | 'chat_room_session_status' // ticket e18be8ff: keep-alive / live background-task-count badge for a chat session
  | 'comment_mention'      // Mention feature: agent @-mentioned in a ticket comment
  | 'user_mention'         // Mention feature: user @-mentioned (web UI unread badge)
  | 'comment_typing'       // Phase-9 typed comments: someone is composing a comment on a ticket
  | 'ticket_presence'      // Tier-1 E: viewer set for a ticket (who has the panel open)
  | 'fs_request'           // File browser: server → agent-manager reverse RPC to read agent-machine files
  | 'subagent_registered'  // Subagent monitor: agent-manager spawned a subagent
  | 'subagent_log'         // Subagent monitor: stream-json line in/out
  | 'subagent_ended'       // Subagent monitor: subagent process exited
  | 'agent_instance_update' // Runtime Host instance heartbeat / removal
  | 'agent_manager_command' // ST-4: AWB → awb-agent-manager control message (spawn/stop/reload-config)
  | 'consensus_update'      // 다중담당자·합의 T4: 합의 상태 변화 (UI T6 소비, agent 비소비)
  | 'orchestration_update'  // 오케스트레이션: Mission/Step 상태 변화 (UI 전용, agent 비소비)
  | 'ticket_reads_cleared'  // 티켓 628f4b39: 티켓 코멘트 일괄 읽음 처리 — 다른 탭/기기의 뱃지 동기화용
  | 'cli_login_progress'  // 티켓 b2e79108: CLI 자동 로그인(device-auth) 진행 상태 — UI 전용, agent-manager 비소비
  | 'ontology_graph_progress'; // 티켓 964014f5: Ontology Graph 증분 갱신 진행 + graph_status 상태 — UI 전용, agent-manager 비소비

export interface StreamEventScope {
  board_id?: string;
  agent_id?: string;
  user_id?: string;
  workspace_id?: string;    // v0.32: workspace-scoped events (subagent monitor)
  ticket_id?: string; // Phase 2 D-26 — chat thread scoping (global vs ticket-scoped)
  room_id?: string;         // Phase 7: chat room targeting
  member_ids?: Set<string>; // Phase 7: pre-resolved participant user IDs for sync filter
  agent_member_ids?: Set<string>; // Phase 7: pre-resolved Agent participant IDs for Host delivery
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
  // Raw actor id behind `actor_name`. The web UI needs it to tell "someone
  // else commented" from "I commented" — without it the unread-badge listener
  // counted the viewer's own comments as unread (names are not unique and
  // agent actors get re-projected to `<Manager>/<Agent>`, so name comparison
  // is not a substitute). Empty string for system actors.
  actor_id?: string;
  current_column_id?: string;
  current_column_name?: string;
  current_column_kind?: string;
  previous_column_name?: string;
  new_column_name?: string;
}

export interface AgentTypingPayload {
  ticket_id: string;
  agent_id: string;
  /** Canonical `<Manager>/<Agent>` display, resolved at emit time. */
  agent_name: string;
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
  current_column_id?: string;
  current_column_name?: string;
  current_column_kind?: string;
  // phase12 — board column → prompt-template content; null when no template wired
  column_prompt: { template_id: string; name: string; content: string } | null;
  // Ticket's configured base repository (Resource of type='repository') and
  // base branch — agent-manager renders these into the in-progress prompt so
  // the agent fetches + branches off the right ref. Both null/empty when the
  // ticket leaves them unset (pure-discussion / non-code work).
  base_repo: { id: string; name: string; url: string; default_branch: string } | null;
  base_branch: string;
  // Resolved clone policy for `base_repo` (ticket bddb63ee): the Repo Resource's
  // own `clone_policy` merged key-by-key over the workspace default
  // (resolveClonePolicy). agent-manager applies it to the container base clone —
  // wall-clock budget, idle-stall budget, and the shallow/partial/single-branch
  // flags. Null when neither layer configures anything; the manager then uses its
  // OWN defaults, which are the same system defaults (clone timeout 60분), so an
  // unconfigured repo and a pre-bddb63ee manager behave identically.
  clone_policy?: ResolvedClonePolicy | null;
  // TicketSupervisor signal: agent-manager should kill any live subagent for this
  // ticket before handling the trigger. Set when a wedged session has failed
  // to advance my_last_update_at after the initial supervisor re-push.
  force_respawn?: boolean;
  // Per-board cap on distinct active tickets per agent. Server's
  // TriggerLoopService is the primary enforcer; this field is forwarded so
  // the manager can keep a defensive drop in case two triggers raced past
  // the server gate (set_current_task lags the trigger by the spawn
  // round-trip). Defaults to 1 in the manager when absent.
  max_concurrent_tickets_per_agent?: number;
  // Immutable skill bundle selected for this logical run. Runtime Hosts must
  // verify both the snapshot digest and every per-skill digest before exposing
  // these files to a runtime.
  skill_snapshot?: {
    run_id: string;
    digest: string;
    manifest: Array<{
      skill_id: string;
      skill_version_id: string;
      slug: string;
      version: number;
      digest: string;
      body: string;
      support_files: Array<{ path: string; content: string }>;
    }>;
  } | null;
  // Resolved harness config (ticket e9c7a896): workspace default merged with
  // the board override via resolveHarnessConfig(). agent-manager maps the
  // keys onto subagent CLI flags at spawn time (--append-system-prompt /
  // --allowedTools / --disallowedTools / --model / --permission-mode).
  // Null when neither layer configures a harness — the manager must treat
  // null as "spawn exactly as before".
  harness_config?: HarnessConfig | null;
  // Resolved Agent > Board > Workspace Claude backend profile. It remains a
  // public, declarative snapshot: credential_ref is an id and no secret value
  // is serialized onto REST/SSE.
  cli_runtime_profile?: CliRuntimeProfile | null;
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
  role?: string;       // role slug the subagent was spawned for; undefined for older managers
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
    role?: string;       // role slug the subagent was spawned for; undefined for older managers
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
// Runtime Hosts consume this envelope-native (NOT flattened) for a dedicated
// chat worker per conversation. Delivery is scoped to the target Agent.
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
  // Stable idempotency anchor shared with the chat_room_message emitted for
  // the same persisted row. Older emitters may omit it; consumers retain their
  // timestamp fallback for backward compatibility.
  message_id?: string;
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
  // ticket 9fd27487: DM / @-멘션 디스패치를 위한 run-workspace 프로비저닝
  // 힌트 — chat_room_message의 run_provision에 대응하는 `chat_request` 쪽
  // 짝이다. 대상 workspace가 chat_workspace_folder_enabled를 opt-in한
  // 경우에만 RoomMessagingService가 채워 넣으며(room-messaging.service.ts
  // 참고), opt-in하지 않은 workspace에서는 (kind로만 걸러지는 게 아니라)
  // 필드 자체가 생략되어 DM의 wire shape가 기본적으로 byte 단위까지 그대로
  // 유지된다.
  run_provision?: RunProvision;
  // ticket 7d8ea7c9: resolved agent > workspace Claude backend profile for
  // this chat dispatch — same resolution RoomMessagingService applies as
  // trigger-loop.service.ts does for ticket dispatch, but agent-only (a chat
  // turn has no ticket/board to layer). agent-manager's handleChatRequest
  // reads payload.cli_runtime_profile to pick the CLI backend. Omitted when
  // the responder isn't a Claude agent or nothing resolves, so a chat turn
  // with no configured profile keeps today's wire shape unchanged.
  cli_runtime_profile?: CliRuntimeProfile | null;
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
// F-3 (ticket 3ca88253) — agent 상태 카드: get_agent 결과를 캡처해 채팅 응답에
// AI Agents 화면과 동일한 핵심 정보(이름/온라인/heartbeat/현재 작업/manager/타입/
// working dir)를 카드로 붙인다. 캡처는 id(+표시용 name)만 싣고, 클라이언트가 클릭
// 시 GET /api/agents/:id 로 최신 상세를 다시 받아온다(TicketRefCard 가 ticket_id 만
// 싣고 열람 시 getTicket 을 다시 부르는 것과 동일 패턴) — 그래서 카드가 항상 최신이고
// 페이로드도 작다. list_agents(다건 조회)는 캡처하지 않는다 — "특정 agent" 상태
// 질문에 대한 카드이지 목록 나열용이 아니다.
export interface ChatMessageAgentRef {
  agent_id: string;
  // 표시용 라벨(있으면). 없으면 카드가 agent_id 를 보여주다가 상세 fetch 후 갱신.
  name?: string;
}
// F-3 (ticket 3ca88253) — board 현황 카드: get_board_summary(LLM 용 압축 보드 요약)
// 결과를 캡처해 채팅 응답에 보드 UI 를 축약한 카드를 붙인다. agent_refs 와 동일하게
// id(+title)만 싣고, 클라이언트가 열람 시 GET /api/boards/:id 로 전체 컬럼/티켓을
// 다시 받아 Board 화면과 같은 데이터로 렌더한다. get_board(전체 상세)는 다른 목적으로도
// 쓰이는 범용 조회라 캡처 대상에서 제외 — get_board_summary 만 "보드 현황" 질문의
// 전용 tool 이다.
export interface ChatMessageBoardRef {
  board_id: string;
  // 보드 이름(있으면). get_board_summary 결과의 `board` 필드.
  title?: string;
}
export interface ChatMessageTicketAction {
  kind: 'unpend';
  ticket_id: string;
  title: string;
}
export interface ChatRoomMessageMetadata {
  ticket_refs?: ChatMessageTicketRef[];
  // F2-4 ⓒ: 빌드/배포 결과물 카드. ticket_refs 와 독립적으로 존재 가능 —
  // 한쪽만 있어도 metadata 는 유지된다(sanitizer 독립 처리).
  artifact_refs?: ChatMessageArtifactRef[];
  // F-3: agent/board 상태 카드. 다른 refs 와 독립적으로 존재 가능.
  agent_refs?: ChatMessageAgentRef[];
  board_refs?: ChatMessageBoardRef[];
  // Human-session action card. This is display data, not an authorization
  // credential: the click still goes through the guarded ticket PATCH.
  ticket_action?: ChatMessageTicketAction;
}

// Phase 7 — room-based chat
export interface ChatRoomMessagePayload {
  room_id: string;
  // Workspace the room belongs to. SSE delivery is scoped by room membership,
  // NOT by workspace — a user who belongs to two workspaces receives room
  // events from both on the same stream. The web UI's unread badge is
  // per-workspace, so without this field it counted foreign-workspace
  // messages into the workspace currently on screen.
  workspace_id?: string;
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
  type?: 'message' | 'progress' | 'ticket_action';
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
  // Agent Manager uses it to break agent-to-agent ping-pong loops by skipping
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
  // Agent ids whose execution for this persisted message is already owned by
  // targeted chat_request events. Runtime Hosts must keep this room event for
  // history/UI fan-out but skip a second delegation when this list is non-empty.
  dispatch_agent_ids?: string[];
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
  // ticket 7d8ea7c9 (review round 1): 이 broadcast에 대해 agent_id → 해석된
  // Claude backend profile 맵. chat_request(단일 대상 agent)와 달리
  // chat_room_message는 방의 모든 멤버에게 팬아웃되므로 — Claude-type
  // 멤버마다 cli_runtime_profile 설정이 다르거나(또는 없거나) 할 때 평면
  // single-profile 필드로는 "지금 응답할 그 멤버에게 맞는 backend"를
  // 표현할 수 없다. RoomMessagingService가 Claude-type 멤버마다 하나씩
  // 항목을 해석하고(chat_request의 agent별 해석을 그대로 미러링), 각
  // 매니저 인스턴스가 자신이 관리하는 responder의 항목을 agent_id로
  // 맵에서 골라 쓴다. wire에서는 조건부 생략(어떤 멤버도 profile이
  // 해석되지 않으면 필드 자체가 없음)이라 일반 채팅 턴/비-Claude 방은
  // 기존 shape 그대로 유지된다.
  cli_runtime_profiles?: Record<string, CliRuntimeProfile>;
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

// ticket e18be8ff — pushed by ChatSessionManager after every keep-alive
// grant/release and every progress recheck (idle timer / maxTurns /
// unhealthy gate), so the room UI can render "백그라운드 작업 N개 실행 중 ·
// keep-alive 잔여 XX분" without polling. `keep_alive_until_ms` is an
// absolute epoch-ms deadline (not a pre-computed "remaining minutes") so the
// client can tick a live countdown between pushes instead of showing stale
// text. null means no active grant. Cleared (both fields reset) on session
// exit — see ChatSessionManager#_onChildExit.
export interface ChatRoomSessionStatusPayload {
  room_id: string;
  agent_id: string;
  agent_name: string;
  keep_alive_until_ms: number | null;
  background_task_count: number;
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
  // comment_id와 구별되는 hard-budget/ACK 상관 ID. 역할 멘션에만 존재한다.
  dispatch_trigger_id?: string;
  dispatch_role?: string;
  // Ticket-comment analog of ChatRoomMessagePayload.agent_chain_depth: trailing
  // strictly-alternating agent-authorship chain length on this ticket's
  // comments, including this one. agent-manager skips delegation once the
  // depth reaches its cap so an agent-mention ping-pong auto-terminates —
  // the chain resets once a human comments.
  agent_chain_depth?: number;
  // 티켓 71532b4f: agent_trigger와 동일한 ticket > agent > board 우선순위로
  // 해석된 dispatch 부가값. 이전에는 comment_mention이 이 셋을 전혀 나르지
  // 않아, 코멘트 멘션으로 깨운 세션이 agent에 명시 핀된 cli_runtime_profile을
  // 무시하고 순정 Claude로 조용히 돌았다 — agent-manager의 handleCommentMention이
  // resolveTriggerRuntimeProfile / parseHarnessConfig / parseEffortPreset로
  // 읽어 subagentManager.spawn()에 그대로 실어 보낸다(handleTrigger와 동일).
  // null = 적용할 override 없음(매니저는 기존처럼 CLI 기본값으로 spawn).
  harness_config: HarnessConfig | null;
  cli_runtime_profile: CliRuntimeProfile | null;
  effort_preset: ResolvedEffortPreset | null;
  // Same ticket 71532b4f expansion as the three fields above — env_vars-only
  // (repositories always empty; see mention-dispatch-profile.ts's resolveMentionDispatchExtras
  // doc comment for why) and the board worktree mode, so agent-manager's
  // buildDispatchEnvVars() produces the same envVars a column trigger would.
  environment_config: ResolvedEnvironmentConfig | null;
  worktree_mode: WorktreeMode;
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

// 티켓 628f4b39 — 티켓 코멘트 일괄 읽음("모두 읽음") 처리 결과. 처리한 본인의
// 다른 탭/기기 세션에만 전달되어, BroadcastChannel(같은 브라우저 탭 전용)이
// 닿지 않는 다른 기기의 사이드바/보드 뱃지도 재조회 없이 즉시 수렴시킨다.
export interface TicketReadsClearedPayload {
  user_id: string;           // 처리를 실행한 사용자
  workspace_id: string;
  board_id: string | null;   // 보드 스코프 지정 시 해당 보드, 생략(워크스페이스 전체)이면 null
  updated: number;           // TicketReadState 로 upsert 된 티켓 수
  read_at: string;           // ISO-8601
}

// File browser — server emits this toward a specific agent's SSE stream to ask
// Agent Manager to perform a filesystem op on the agent's machine. The manager answers
// via HTTP POST to /api/fs/responses/:request_id (out-of-band — not SSE) so
// response bodies aren't constrained by event-stream framing. Scope root
// enforcement lives in Agent Manager, not here — server is a pure forwarder.
export interface FsRequestPayload {
  request_id: string;                        // server-generated uuid; manager echoes it on the response POST
  agent_id: string;                          // target agent (matches identity for filter)
  op: 'list' | 'stat' | 'read' | 'mkdir' | 'roots' | 'drives';
  path: string;                              // absolute path on the agent machine
  offset?: number;                           // read: byte offset (default 0)
  limit?: number;                            // read: max bytes (server caps at 5MB)
  name?: string;                             // mkdir: single-segment name of the new folder under `path`
}

// Subagent monitor — Agent Manager reports subagent lifecycle + stream-json traffic
// to the AWB server so the web UI can render a live transcript across every
// agent machine. Storage is in-memory only (live debug, not audit log) and a
// subagent's record is dropped when its process exits or when the manager
// disconnects, so the dataset stays bounded without explicit pruning.
export interface SubagentRegisteredPayload {
  subagent_id: string;        // manager-generated uuid; identifies one transcript
  agent_id: string;           // parent registered agent
  workspace_id: string;
  kind: 'chat' | 'ticket' | 'oneshot';
  session_key: string;        // 'ticket:<id>:<role>' | 'room:<id>' | 'oneshot:<trigger_id>'
  pid: number;
  started_at: string;
  // Optional human-readable label the UI shows in the list (e.g., ticket title
  // or room name). Agent Manager best-effort fills this; server doesn't validate.
  label?: string;
  // v0.34: ticket + role context for ticket-kind subagents. Lets the UI show
  // "Ticket title · reviewer" instead of just an opaque session key. Both
  // optional — older managers and chat/oneshot subagents leave them undefined.
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
// event because the dashboard list is small (one row per Runtime Host) and the
// diff would be more code than the payload.
export interface AgentInstanceUpdatePayload {
  action: 'registered' | 'updated' | 'removed';
  instance: {
    instance_id: string;
    agent_id: string;
    workspace_id: string | null;
    mode: 'manager';
    hostname: string;
    plugin_version: string;
    cli: string;
    cli_adapters: string[];
    runtime_capabilities?: Record<string, {
      installed: boolean;
      healthy: boolean;
      version: string | null;
      reason: string | null;
      capabilities: {
        protocol: 'stream-json' | 'jsonl' | 'acp';
        session: 'oneshot' | 'persistent' | 'resumable';
        native_mcp: boolean;
        native_approvals: boolean;
        steering: boolean;
        cancellation: boolean;
        usage: 'none' | 'tokens' | 'tokens-and-cost';
        collaboration: Array<'delegated' | 'swarm'>;
        skill_delivery: Array<'prompt' | 'filesystem' | 'native'>;
        /** 등급별 표현력 (ticket 5851e435). 보고하지 않는 구버전 매니저에서는
         *  undefined — 서버는 기본값을 지어내지 않는다. */
        permission_tiers?: Record<'strict' | 'approve' | 'trusted', 'native' | 'approximated' | 'unsupported'>;
      };
      profiles?: string[];
    }>;
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
    update_channel?: string | null;
    update_last_checked_at?: string | null;
    update_last_error?: string | null;
    // ticket 9408b308 — target version the manager's `scheduled` policy is
    // waiting for an operator to approve. null = reported but nothing
    // pending; undefined = manager predates the field.
    update_approval_pending_version?: string | null;
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
  | 'restart_manager'    // re-exec the manager in place (no git pull / build) so a fresh process takes over the lockfile
  // ticket 6ff827cb — the ONLY two verbs issued by an MCP tool call (from the
  // calling agent's own live session) rather than an admin action. args:
  // { agent_id, room_id, minutes?, reason? }. Routed to the chat session for
  // that room_id on the target manager instance; see ChatSessionManager's
  // applyKeepAlive (inherited from BaseSessionManager).
  | 'extend_chat_keepalive'  // defer idle/maxTurns reap for a live chat session, up to the hard ceiling
  | 'release_chat_keepalive' // clear an active grant early
  // ticket b2e79108 — Codex/Claude CLI device-auth 자동 로그인. args:
  // { session_id, cli }. 매니저는 프로세스를 spawn한 직후 빠르게 "시작됨"만
  // ack한다 — 사람의 브라우저 승인을 기다리는 완료까지 기다리면 command-ledger
  // 의 10분 TTL을 넘길 수 있다. 이후 진행/완료는
  // POST /api/agent-manager/cli-login/:sessionId/progress 로 별도 보고한다.
  | 'cli_login_start'
  | 'cli_login_cancel'; // 세션 취소 — 이미 끝난 세션이면 매니저가 no-op으로 처리

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

/**
 * Orchestration mode live nudge (UI-only, like `consensus_update`).
 *
 * Deliberately a HEADLINE, not a full state dump: the mission board re-fetches
 * `GET /api/orchestration/missions/:id` for anything it renders in depth, so
 * this frame only has to carry enough to update a list row, animate a progress
 * bar, and decide whether the currently-open mission needs a refetch. Keeping
 * it small also keeps it honest — a fat payload would race the DB and let the
 * UI render a state that was already stale when it was serialized.
 *
 * Agents never consume this: an orchestrator learns about step results from its
 * room wake-up + `get_orchestration_mission`, and a member only ever knows about
 * its own step. That makes this event type UI fuel outside the agent-manager
 * SSE contract, exactly like consensus_update / subagent_* / agent_instance_update.
 */
export interface OrchestrationUpdatePayload {
  mission_id: string;
  workspace_id: string;
  team_id: string;
  title: string;
  status: string;
  plan_version: number;
  counts: { total: number; done: number; failed: number; inFlight: number; pending: number };
  last_event: { type: string; message: string; step_key: string } | null;
  /**
   * 이 미션이 방금 삭제됐다는 표시(티켓 03ca8b5b). 삭제는 REST
   * `DELETE /api/orchestration/missions/:id` 로만 일어나므로, 미션 목록을 그리는
   * 화면(사이드바 WORK > Orchestrations, 미션 목록 페이지)은 이 신호가 없으면
   * 사라진 미션을 계속 보여주고 클릭 시 없는 상세로 보낸다. 상태 변화 프레임과
   * 구분해야 하므로 별도 불리언으로 싣는다(status 는 삭제 직전 값 그대로).
   */
  deleted: boolean;
}

/**
 * ticket b2e79108 — CLI 자동 로그인(device-auth) 진행 상태 push. UI 전용:
 * agent-manager 는 이 이벤트를 구독하지 않는다(진행 상태를 만드는 쪽이 매니저
 * 자신이니까). consensus_update/orchestration_update 보다 더 좁게, 이 로그인을
 * 시작한 사용자 한 명에게만 전달된다(event-registry의 filter가 user_id로 좁힘).
 *
 * 토큰 원문은 절대 싣지 않는다 — succeeded 여도 created_credential_id 뿐.
 */
export interface CliLoginProgressPayload {
  session_id: string;
  workspace_id: string;
  status: 'starting' | 'awaiting_user' | 'completing' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  verification_url: string | null;
  user_code: string | null;
  // ticket b2e79108 review round 1 — parsing-failure fallback: raw (redacted,
  // size-capped) CLI stdout when the manager couldn't find a url/code in the
  // expected wording. Cleared once a real url/code is parsed.
  raw_output_fallback: string | null;
  error_detail: string;
  created_credential_id: string | null;
}

/**
 * 티켓 964014f5(Ontology Graph 4/7) — 증분 갱신(Phase A/B/C) 진행 헤더 +
 * graph_status(축 6/ticket #6, 아직 미배정) 생명주기 상태를 같은 프레임에
 * 싣는다(DESIGN.md 축 4 Integration points: "The same progress-frame shape
 * now also carries graph_status's building/ready/stale/error state").
 * UI 전용 — consensus_update/orchestration_update와 같은 패턴: agent는
 * MCP 툴 응답의 {indexed_at, confidence}로 신선도를 알지 이 스트림을
 * 구독하지 않는다. `scout-client.md` §3.4 Pattern B(직접 증분 payload,
 * 재조회 없음) — AgentSubagentsPanel.tsx의 subagent_log 카운터 증가
 * 패턴과 동일하게, 클라이언트가 progress 숫자를 그대로 누적/치환한다.
 */
export interface OntologyGraphProgressPayload {
  workspace_id: string;
  graph_id: string;
  resource_id: string;
  /** 이 진행 프레임을 낸 job(디바운스 단일 파일 갱신, 또는 git-diff 스코프
   *  배치)의 상관관계 id — 같은 job의 연속 프레임을 클라이언트가 묶어볼 때 씀. */
  job_id: string;
  phase: 'phase_a' | 'phase_b' | 'phase_c' | 'sweep';
  /** graph_status(ticket #6이 실제 소비/생성할 값) — building=Phase A/B
   *  진행 중, ready=이번 job 완료(에러 없음), stale=완료했지만 알려진
   *  backlog가 남음(스윕 대상 존재), error=job 자체가 실패. */
  graph_status: 'building' | 'ready' | 'stale' | 'error';
  files_processed: number;
  edges_extracted: number;
  edges_total: number | null;
  nodes_extracted: number;
  /** phase_a에서 조기 종료됐으면 true(완료조건 1) — UI가 "즉시 완료"로
   *  표시할 수 있게. */
  short_circuited: boolean;
  error: string | null;
}
