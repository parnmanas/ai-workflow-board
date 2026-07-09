// Table-driven SSE event registry — single source of truth for every StreamEvent type.
//
// Each EventDefinition below captures the full lifecycle of one event type:
//   1. which EventEmitter event name to subscribe to (`emitterEvent`)
//   2. how to turn the raw emitter payload into a StreamEvent envelope (`map`)
//   3. whether a given subscriber (user or agent) should receive it (`filter`)
//   4. how to serialize the envelope on the wire for legacy consumers (`flatten`)
//
// Adding a new event type = append one entry here. No switch-statement editing.
//
// Historical context: before Phase 5 structural cleanup, events.controller.ts carried
// 9 hand-written listeners + a 9-arm filter switch + an 8-arm flatten switch. This file
// replaces all three with one table.
import {
  StreamEvent,
  BoardUpdatePayload,
  AgentTypingPayload,
  AgentTriggerPayload,
  ChatMessagePayload,
  AgentStatusPayload,
  ChatRequestPayload,
  ChatRoomMessagePayload,
  ChatRoomUpdatePayload,
  ChatRoomTypingPayload,
  CommentMentionPayload,
  CommentTypingPayload,
  TicketPresencePayload,
  UserMentionPayload,
  FsRequestPayload,
  SubagentRegisteredPayload,
  SubagentLogPayload,
  SubagentEndedPayload,
  AgentInstanceUpdatePayload,
  AgentManagerCommandPayload,
  ConsensusUpdatePayload,
} from '../../common/types/stream-events';
import { EventDefinition, SubscriberIdentity } from './types';

// ── Helpers used by multiple filter functions ─────────────────────────────

/** Participant-based filter: only members of the room receive the event.
 *
 * Manager fan-out: events.controller rewrites a manager's identity to the
 * matching managed-agent before invoking this filter (see the override block
 * around `effectiveIdentity` there), so this filter only needs to compare
 * against identity.agentId — managed-agent membership is already resolved at
 * the call site. */
function roomMemberFilter(envelope: StreamEvent<any>, identity: SubscriberIdentity): boolean {
  if (identity.type === 'user') {
    const memberSet = envelope.scope.member_ids as Set<string> | undefined;
    return memberSet ? memberSet.has(identity.userId!) : false;
  }
  if (identity.type === 'agent') {
    const agentSet = envelope.scope.agent_member_ids as Set<string> | undefined;
    return agentSet ? agentSet.has(identity.agentId!) : false;
  }
  return false;
}

// ── The registry ──────────────────────────────────────────────────────────

export const EVENT_TYPES: EventDefinition[] = [
  // ───────── board_update ─────────
  // activityEvents emits 'activity' for every entity change. We resolve board_id from
  // the ticket chain (ticket → column → board, or parent chain for subtasks). If no
  // board can be resolved we skip emission.
  {
    eventType: 'board_update',
    emitterEvent: 'activity',
    async map(activity: any, ctx) {
      const boardId = await ctx.resolveBoardId(activity.ticket_id, activity.entity_id);
      if (!boardId) return null;
      const payload: BoardUpdatePayload = {
        ticket_id: activity.ticket_id,
        entity_type: activity.entity_type,
        action: activity.action,
        field_changed: activity.field_changed || '',
        actor_name: activity.actor_name || '',
      };
      return { payload, scope: { board_id: boardId } };
    },
    // D-07: deliver when subscriber requested this board, or when they subscribed to all.
    filter: (env, id) => !id.boardId || env.scope.board_id === id.boardId,
    // proxy.mjs reads ticket_id/action/field_changed/actor_name at the top level — flatten.
    flatten: (env) => {
      const p = env.payload as BoardUpdatePayload;
      return {
        board_id: env.scope.board_id || '',
        event_type: 'board_update',
        ticket_id: p.ticket_id,
        entity_type: p.entity_type,
        action: p.action,
        field_changed: p.field_changed || '',
        actor_name: p.actor_name || '',
        timestamp: env.timestamp,
      };
    },
  },

  // ───────── agent_typing ─────────
  {
    eventType: 'agent_typing',
    emitterEvent: 'agent_typing',
    map(event: any) {
      const payload: AgentTypingPayload = {
        ticket_id: event.ticket_id,
        agent_id: event.agent_id,
        is_typing: !!event.is_typing,
      };
      return {
        payload,
        scope: {}, // typing events have no default scope filter (see filter below)
        timestamp: event.timestamp,
      };
    },
    // D-28: chat-mode typing carries user_id in scope → narrow to that user/agent.
    // Board-level typing (no user_id) still broadcasts for backward compat.
    filter: (env, identity) => {
      if (env.scope.user_id) {
        if (identity.type === 'user') return env.scope.user_id === identity.userId;
        if (identity.type === 'agent') return env.scope.agent_id === identity.agentId;
        return false;
      }
      return true;
    },
    flatten: (env) => {
      const p = env.payload as AgentTypingPayload;
      return {
        board_id: '__typing__',
        event_type: 'agent_typing',
        ticket_id: p.ticket_id,
        entity_type: 'agent',
        action: p.is_typing ? 'started' : 'stopped',
        actor_name: p.agent_id,
        timestamp: env.timestamp,
      };
    },
  },

  // ───────── agent_trigger ─────────
  {
    eventType: 'agent_trigger',
    emitterEvent: 'agent_trigger',
    map(event: any) {
      const payload: AgentTriggerPayload = {
        trigger_id: event.trigger_id || '',
        ticket_id: event.ticket_id,
        agent_id: event.agent_id,
        role: event.role || '',
        role_prompt: event.role_prompt || '',
        ticket_prompt: event.ticket_prompt || '',
        trigger_source: event.trigger_source || '',
        column_prompt: event.column_prompt ?? null,
        base_repo: event.base_repo ?? null,
        base_branch: event.base_branch || '',
        harness_config: event.harness_config ?? null,
        // Resolved abstract effort preset (board catalog × ticket effort_preset);
        // agent-manager maps it onto per-CLI options at spawn. Null = no override.
        // Previously DROPPED by this field-by-field reconstruction (and by flatten
        // below), so board effort presets silently no-op'd on the SSE wire — the
        // exact "one cell missed" class the parity guard test now prevents.
        effort_preset: event.effort_preset ?? null,
        // Resolved environment setup (ticket 354d336b); agent-manager provisions
        // the working env (clone/update repos, setup commands, env_vars) before
        // spawn. Null = no provisioning. Same drop story as effort_preset.
        environment_config: event.environment_config ?? null,
        // Resolved board worktree placement mode (worktree 규약 ②). agent-manager
        // maps it onto the worktree slug at spawn (per_ticket → `.awb/wt/<ticket8>`,
        // shared → `.awb/wt/shared`). Undefined = manager defaults to per_ticket.
        // Same field-by-field drop story as effort_preset/environment_config.
        worktree_mode: event.worktree_mode ?? undefined,
        // Working_dir-relative worktree folder AWB assigned this ticket (규약 ④).
        // agent-manager fills the `{{AWB_WORK_FOLDER}}` column-prompt placeholder
        // from it (joined onto the working_dir / the actual resolved cwd). Same
        // field-by-field drop story — omit it and the manager never sees the
        // assigned folder, so the placeholder can't render the real spawn path.
        worktree_rel_path: event.worktree_rel_path ?? undefined,
        // TicketSupervisor kill-and-respawn signal — agent-manager reads
        // force_respawn off the flattened event to drop a wedged subagent before
        // handling the trigger. Defaults false.
        force_respawn: event.force_respawn === true,
        max_concurrent_tickets_per_agent:
          typeof event.max_concurrent_tickets_per_agent === 'number'
            ? event.max_concurrent_tickets_per_agent
            : undefined,
      };
      return {
        payload,
        scope: { agent_id: event.agent_id },
        timestamp: event.timestamp,
      };
    },
    // Recipient-scoped delivery: only the target agent's SSE stream receives
    // the trigger. Without this, every connected agent's proxy would process
    // the event (the "proxy.mjs filters client-side" comment was aspirational
    // — the proxy had no such filter). Cross-agent leaks caused unrelated
    // agents to pick up triggers meant for others; see incident notes.
    filter: (env, identity) => {
      if (identity.type !== 'agent') return false;
      return env.scope.agent_id === identity.agentId;
    },
    flatten: (env) => {
      const p = env.payload as AgentTriggerPayload;
      return {
        board_id: '__trigger__',
        event_type: 'agent_trigger',
        ticket_id: p.ticket_id,
        entity_type: 'trigger',
        action: p.role,
        field_changed: p.trigger_id,
        actor_name: p.agent_id,
        // D-20: new fields added at top level. proxy.mjs ignores unknown fields.
        role_prompt: p.role_prompt,
        ticket_prompt: p.ticket_prompt,
        trigger_source: p.trigger_source,
        // phase12: forward column_prompt (PromptTemplate wired to the ticket's
        // column) so proxy.mjs can include it in composeTriggerPrompt. Without
        // this, ev.column_prompt stays undefined on the proxy side and the
        // column workflow guide never reaches the agent.
        column_prompt: p.column_prompt,
        // e9c7a896: resolved workspace+board harness — agent-manager's
        // handleTrigger reads ev.harness_config off the flattened event and
        // maps the keys onto subagent CLI flags at spawn. Same flatten rule
        // as column_prompt: without this line the field never leaves the
        // envelope and the manager sees undefined.
        harness_config: p.harness_config ?? null,
        // Same flatten rule as harness_config: agent-manager's event-dispatcher
        // reads these off the FLATTENED event (parseEffortPreset(ev.effort_preset),
        // parseEnvironmentConfig(ev.environment_config), ev.force_respawn). Without
        // these lines the fields never leave the envelope and the manager silently
        // falls back to "no override / no provisioning / no respawn" — the latent
        // wire break this ticket's parity guard now locks down.
        effort_preset: p.effort_preset ?? null,
        environment_config: p.environment_config ?? null,
        // Worktree mode rides the same flatten rule — agent-manager's
        // #applyWorktreeCwd reads ev.worktree_mode off the FLATTENED event.
        // Without this line it never leaves the envelope and the manager
        // falls back to per_ticket regardless of the board setting.
        worktree_mode: p.worktree_mode ?? undefined,
        // 규약 ④: the assigned worktree folder. agent-manager reads
        // ev.worktree_rel_path off the FLATTENED event to fill the work-folder
        // placeholder — same flatten rule as worktree_mode.
        worktree_rel_path: p.worktree_rel_path ?? undefined,
        force_respawn: p.force_respawn === true,
        // Per-board cap forwarded so the manager can keep a defensive drop
        // alongside the server-side gate.
        max_concurrent_tickets_per_agent: p.max_concurrent_tickets_per_agent,
        timestamp: env.timestamp,
      };
    },
  },

  // ───────── chat_message ─────────
  // Phase 2 D-26. ChatService emits on 'chat_message'. Scoped by user_id/agent_id so
  // recipient filtering is strict — one side must match for delivery.
  {
    eventType: 'chat_message',
    emitterEvent: 'chat_message',
    map(event: any) {
      const payload: ChatMessagePayload = {
        message_id: event.message_id,
        sender_type: event.sender_type,
        sender_id: event.sender_id,
        recipient_agent_id: event.agent_id,
        content: event.content,
        ticket_id: event.ticket_id || undefined,
        created_at: event.created_at || new Date().toISOString(),
      };
      return {
        payload,
        scope: {
          agent_id: event.agent_id,
          user_id: event.user_id,
          ticket_id: event.ticket_id || undefined,
        },
        timestamp: event.created_at,
      };
    },
    // D-07 / D-27: recipient-only. Agents match on scope.agent_id, users on scope.user_id.
    // Cross-user leak is impossible because both sides must match strictly.
    filter: (env, identity) => {
      if (identity.type === 'agent') return env.scope.agent_id === identity.agentId;
      return env.scope.user_id === identity.userId;
    },
    // No flatten — new event types ship the envelope natively.
  },

  // ───────── agent_status ─────────
  // Phase 3 D-40. AgentStatusService emits Dates → convert to ISO strings.
  {
    eventType: 'agent_status',
    emitterEvent: 'agent_status',
    map(event: any) {
      const payload: AgentStatusPayload = {
        agent_id: event.agent_id,
        is_online: !!event.is_online,
        last_seen_at: event.last_seen_at
          ? event.last_seen_at instanceof Date
            ? event.last_seen_at.toISOString()
            : String(event.last_seen_at)
          : null,
        current_task: event.current_task
          ? {
              ticket_id: event.current_task.ticket_id,
              ticket_title: event.current_task.ticket_title,
              claimed_at:
                event.current_task.claimed_at instanceof Date
                  ? event.current_task.claimed_at.toISOString()
                  : String(event.current_task.claimed_at),
              role: event.current_task.role || undefined,
            }
          : undefined,
      };
      return { payload, scope: { agent_id: event.agent_id } };
    },
    // D-07: broadcast to all authenticated subscribers
    filter: () => true,
  },

  // ───────── chat_request ─────────
  // Phase 4 D-71/D-72. Per-agent delivery — only the target agent's proxy spawns the
  // chat subagent. Users never see this; they see the persisted 'chat_message' reply.
  {
    eventType: 'chat_request',
    emitterEvent: 'chat_request',
    map(event: any) {
      const payload: ChatRequestPayload = {
        agent_id: event.agent_id,
        user_id: event.user_id,
        ticket_id: event.ticket_id || null,
        role_prompt: event.role_prompt || '',
        new_message: event.new_message,
        history: Array.isArray(event.history) ? event.history : [],
        // room_id passes through when the emitter set it. agent-manager
        // gates the persistent-chat-session path on its presence — without
        // it the request falls through to the legacy one-shot subagent
        // path that has no room context to reply into.
        room_id: typeof event.room_id === 'string' ? event.room_id : undefined,
      };
      return {
        payload,
        scope: { agent_id: event.agent_id },
        timestamp: event.timestamp,
      };
    },
    filter: (env, identity) => {
      if (identity.type === 'agent') return env.scope.agent_id === identity.agentId;
      return false;
    },
  },

  // ───────── chat_room_message ─────────
  // Phase 7. Room participants only. proxy.mjs (and UI) expects the payload at top level.
  {
    eventType: 'chat_room_message',
    emitterEvent: 'chat_room_message',
    map(event: any) {
      const payload: ChatRoomMessagePayload = {
        room_id: event.room_id,
        message_id: event.message_id,
        sender_type: event.sender_type,
        sender_id: event.sender_id,
        sender_name: event.sender_name,
        // Forward the discriminator so live consumers (web UI + agent-manager
        // history ring) can distinguish real turns from progress heartbeats.
        // Omit when absent so the wire shape stays unchanged for legacy emits.
        type: event.type === 'progress' || event.type === 'message' ? event.type : undefined,
        content: event.content,
        // RoomMessagingService projects attachment rows via projectChatAttachment
        // before emit — the array is already in wire shape, so pass it through
        // when non-empty (and drop the field entirely otherwise so legacy
        // consumers that don't read it stay byte-for-byte unchanged).
        attachments: Array.isArray(event.attachments) && event.attachments.length > 0
          ? event.attachments
          : undefined,
        created_at: event.created_at,
        // v0.33: trailing agent-chain depth — plugin uses to break loops.
        agent_chain_depth: typeof event.agent_chain_depth === 'number'
          ? event.agent_chain_depth
          : undefined,
        // Carry agent membership on the wire so an agent-manager can pick
        // which managed agent should respond. The Set-typed scope copy
        // below stays for server-side filtering; the array form is the
        // wire shape consumers see.
        agent_member_ids: event.agent_member_ids
          ? Array.from(event.agent_member_ids as Set<string>)
          : undefined,
        // ticket 25db3cc6 / fe297886: forward the run-workspace provisioning
        // hint untouched. RoomMessagingService.sendMessage stamps it ONLY on a
        // QA/security run-dispatch send; the agent-manager reads p.run_provision
        // (event-dispatcher.ts) to prepare the run folder + pin the subagent cwd
        // BEFORE spawning. This field-by-field map() previously dropped it, so
        // every run dispatched into an unprovisioned cwd → the driver had no
        // checkout to build/drive → 0 record_qa_step → reaper. Omit when absent
        // so ordinary chat turns keep the wire shape byte-for-byte unchanged.
        run_provision: event.run_provision ? event.run_provision : undefined,
      };
      return {
        payload,
        scope: {
          room_id: event.room_id,
          member_ids: event.member_ids,
          agent_member_ids: event.agent_member_ids,
        },
      };
    },
    filter: roomMemberFilter,
    flatten: (env) => {
      const p = env.payload as ChatRoomMessagePayload;
      return { ...p, id: p.message_id };
    },
  },

  // ───────── chat_room_update ─────────
  {
    eventType: 'chat_room_update',
    emitterEvent: 'chat_room_update',
    map(event: any) {
      const payload: ChatRoomUpdatePayload = {
        room_id: event.room_id,
        update_type: event.update_type,
        new_name: event.new_name,
        participant_id: event.participant_id,
        participant_ids: event.participant_ids,
        // B3: read-event reader identity + marker, populated only when present.
        participant_type: event.participant_type,
        last_read_at: event.last_read_at,
        agent_member_ids: event.agent_member_ids
          ? Array.from(event.agent_member_ids as Set<string>)
          : undefined,
      };
      return {
        payload,
        scope: {
          room_id: event.room_id,
          member_ids: event.member_ids,
          agent_member_ids: event.agent_member_ids,
        },
      };
    },
    filter: roomMemberFilter,
    flatten: (env) => env.payload,
  },

  // ───────── chat_room_typing ─────────
  {
    eventType: 'chat_room_typing',
    emitterEvent: 'chat_room_typing',
    map(event: any) {
      const payload: ChatRoomTypingPayload = {
        room_id: event.room_id,
        agent_id: event.agent_id,
        agent_name: event.agent_name || 'Agent',
        is_typing: !!event.is_typing,
        status: event.status ?? null,
        agent_member_ids: event.agent_member_ids
          ? Array.from(event.agent_member_ids as Set<string>)
          : undefined,
      };
      return {
        payload,
        scope: {
          room_id: event.room_id,
          member_ids: event.member_ids,
          agent_member_ids: event.agent_member_ids,
        },
      };
    },
    filter: roomMemberFilter,
    flatten: (env) => env.payload,
  },

  // ───────── comment_mention ─────────
  // Fired when an @-mention in a ticket comment targets an agent. Only the
  // mentioned agent's proxy receives this — other agents stay idle so the
  // subagent spawn budget isn't spent on bystanders.
  //
  // proxy.mjs reads fields at the top level (like agent_trigger), so flatten
  // is provided explicitly.
  {
    eventType: 'comment_mention',
    emitterEvent: 'comment_mention',
    map(event: any) {
      const payload: CommentMentionPayload = {
        ticket_id: event.ticket_id,
        comment_id: event.comment_id,
        workspace_id: event.workspace_id,
        agent_id: event.agent_id,
        actor_id: event.actor_id || '',
        actor_type: event.actor_type || 'user',
        actor_name: event.actor_name || '',
        content: event.content || '',
        role_prompt: event.role_prompt || '',
        mention_source: event.mention_source === 'role' ? 'role' : 'direct',
        role_shortcut: event.role_shortcut,
      };
      return {
        payload,
        scope: { agent_id: event.agent_id, workspace_id: event.workspace_id },
        timestamp: event.timestamp,
      };
    },
    filter: (env, identity) => {
      if (identity.type !== 'agent') return false;
      return env.scope.agent_id === identity.agentId;
    },
    flatten: (env) => {
      const p = env.payload as CommentMentionPayload;
      return {
        board_id: '__mention__',
        event_type: 'comment_mention',
        ticket_id: p.ticket_id,
        entity_type: 'comment',
        action: 'mention',
        field_changed: p.comment_id,
        actor_name: p.actor_name,
        // Flat fields proxy.mjs reads:
        comment_id: p.comment_id,
        agent_id: p.agent_id,
        actor_id: p.actor_id,
        actor_type: p.actor_type,
        content: p.content,
        role_prompt: p.role_prompt,
        mention_source: p.mention_source,
        role_shortcut: p.role_shortcut || '',
        timestamp: env.timestamp,
      };
    },
  },

  // ───────── user_mention ─────────
  // Fired when a user is @-mentioned. Only delivered to the mentioned user's
  // own web sessions so the sidebar unread badge increments without polling.
  {
    eventType: 'user_mention',
    emitterEvent: 'user_mention',
    map(event: any) {
      const payload: UserMentionPayload = {
        mention_id: event.mention_id,
        user_id: event.user_id,
        workspace_id: event.workspace_id,
        source_type: event.source_type,
        source_id: event.source_id,
        ticket_id: event.ticket_id ?? null,
        board_id: event.board_id ?? null,
        room_id: event.room_id ?? null,
        actor_id: event.actor_id || '',
        actor_type: event.actor_type || 'user',
        actor_name: event.actor_name || '',
        preview: event.preview || '',
        created_at: event.created_at,
      };
      return {
        payload,
        scope: { user_id: event.user_id, workspace_id: event.workspace_id },
        timestamp: event.created_at,
      };
    },
    filter: (env, identity) => {
      if (identity.type !== 'user') return false;
      return env.scope.user_id === identity.userId;
    },
  },

  // ───────── ticket_presence ─────────
  // Tier-1 E. Fires only on viewer-set transitions. Ticket-scoped — the
  // client filters by ticket_id locally because we don't track "who has
  // panel X open" on the server (presence IS the answer to that question).
  {
    eventType: 'ticket_presence',
    emitterEvent: 'ticket_presence',
    map(event: any) {
      const payload: TicketPresencePayload = {
        ticket_id: event.ticket_id,
        workspace_id: event.workspace_id,
        viewers: Array.isArray(event.viewers) ? event.viewers : [],
      };
      return {
        payload,
        scope: { ticket_id: event.ticket_id, workspace_id: event.workspace_id },
        timestamp: event.timestamp,
      };
    },
    // Pass everything through; the client decides which presence updates
    // are relevant to the panel currently open in the foreground.
    filter: () => true,
    flatten: (env) => env.payload,
  },

  // ───────── comment_typing ─────────
  // Phase-9: someone is composing a comment on a ticket. Broadcast to everyone
  // EXCEPT the actor — the actor doesn't need their own keystrokes echoed back.
  // No board scope: the client filters by ticket_id since multiple ticket panels
  // can be open across tabs.
  {
    eventType: 'comment_typing',
    emitterEvent: 'comment_typing',
    map(event: any) {
      const payload: CommentTypingPayload = {
        ticket_id: event.ticket_id,
        workspace_id: event.workspace_id,
        actor_type: event.actor_type === 'agent' ? 'agent' : 'user',
        actor_id: event.actor_id,
        actor_name: event.actor_name || '',
        is_typing: !!event.is_typing,
        comment_type: event.comment_type,
      };
      return {
        payload,
        scope: { ticket_id: event.ticket_id, workspace_id: event.workspace_id },
        timestamp: event.timestamp,
      };
    },
    // Skip the actor (suppresses self-echo). Everything else passes through —
    // ticket-level audience scoping is the client's job because we don't track
    // "who has the ticket panel open" on the server.
    filter: (env, identity) => {
      const p = env.payload as CommentTypingPayload;
      if (identity.type === 'agent' && p.actor_type === 'agent') return p.actor_id !== identity.agentId;
      if (identity.type === 'user'  && p.actor_type === 'user')  return p.actor_id !== identity.userId;
      return true;
    },
    flatten: (env) => env.payload,
  },

  // ───────── fs_request ─────────
  // Reverse RPC: server (acting on behalf of a web-UI user) asks a specific
  // agent's plugin proxy to perform a filesystem op on the agent machine.
  // Only the target agent's SSE stream receives the event — same filter shape
  // as agent_trigger. Plugin answers via HTTP POST to
  // `/api/fs/responses/:request_id` (out-of-band) so response bodies aren't
  // constrained by event-stream framing.
  {
    eventType: 'fs_request',
    emitterEvent: 'fs_request',
    map(event: any) {
      const payload: FsRequestPayload = {
        request_id: event.request_id,
        agent_id: event.agent_id,
        op: event.op,
        path: event.path,
        offset: event.offset,
        limit: event.limit,
      };
      return {
        payload,
        scope: { agent_id: event.agent_id },
        timestamp: event.timestamp,
      };
    },
    filter: (env, identity) => {
      if (identity.type !== 'agent') return false;
      return env.scope.agent_id === identity.agentId;
    },
    flatten: (env) => {
      const p = env.payload as FsRequestPayload;
      return {
        board_id: '__fs__',
        event_type: 'fs_request',
        ticket_id: '',
        entity_type: 'fs',
        action: p.op,
        field_changed: p.request_id,
        actor_name: p.agent_id,
        // Plugin reads these top-level fields when dispatching.
        request_id: p.request_id,
        agent_id: p.agent_id,
        op: p.op,
        path: p.path,
        offset: p.offset,
        limit: p.limit,
        timestamp: env.timestamp,
      };
    },
  },

  // ───────── subagent_registered / subagent_log / subagent_ended ─────────
  // Workspace-scoped fan-out: every user with an SSE stream subscribed to the
  // workspace sees every subagent on every agent machine in that workspace.
  // No agent-side filter — the events are observability traffic the agents
  // don't need to consume themselves. UI does the rendering.
  {
    eventType: 'subagent_registered',
    emitterEvent: 'subagent_registered',
    map(event: any) {
      const payload: SubagentRegisteredPayload = {
        subagent_id: event.subagent_id,
        agent_id: event.agent_id,
        workspace_id: event.workspace_id,
        kind: event.kind,
        session_key: event.session_key || '',
        pid: event.pid || 0,
        started_at: event.started_at || new Date().toISOString(),
        label: event.label,
        ticket_id: event.ticket_id || undefined,
        ticket_title: event.ticket_title || undefined,
        role: event.role || undefined,
      };
      return { payload, scope: { workspace_id: event.workspace_id }, timestamp: payload.started_at };
    },
    // Workspace scoping happens at the page (REST) level; SSE filter only
    // restricts to user subscribers (agents don't need this traffic).
    filter: (env, identity) => identity.type === 'user',
    flatten: (env) => ({ event_type: 'subagent_registered', ...(env.payload as object), timestamp: env.timestamp }),
  },
  {
    eventType: 'subagent_log',
    emitterEvent: 'subagent_log',
    map(event: any) {
      const payload: SubagentLogPayload = {
        subagent_id: event.subagent_id,
        agent_id: event.agent_id,
        workspace_id: event.workspace_id,
        direction: event.direction,
        line: event.line,
        ts: event.ts || new Date().toISOString(),
      };
      return { payload, scope: { workspace_id: event.workspace_id }, timestamp: payload.ts };
    },
    // Workspace scoping happens at the page (REST) level; SSE filter only
    // restricts to user subscribers (agents don't need this traffic).
    filter: (env, identity) => identity.type === 'user',
    flatten: (env) => ({ event_type: 'subagent_log', ...(env.payload as object), timestamp: env.timestamp }),
  },
  {
    eventType: 'subagent_ended',
    emitterEvent: 'subagent_ended',
    map(event: any) {
      const payload: SubagentEndedPayload = {
        subagent_id: event.subagent_id,
        agent_id: event.agent_id,
        workspace_id: event.workspace_id,
        exit_code: event.exit_code ?? null,
        signal: event.signal ?? null,
        duration_ms: event.duration_ms || 0,
        ended_at: event.ended_at || new Date().toISOString(),
        expires_at: event.expires_at,
      };
      return { payload, scope: { workspace_id: event.workspace_id }, timestamp: payload.ended_at };
    },
    // Workspace scoping happens at the page (REST) level; SSE filter only
    // restricts to user subscribers (agents don't need this traffic).
    filter: (env, identity) => identity.type === 'user',
    flatten: (env) => ({ event_type: 'subagent_ended', ...(env.payload as object), timestamp: env.timestamp }),
  },

  // ───────── agent_instance_update ─────────
  // Phase 3 Agent Manager — daemon/proxy presence registry change. Workspace-
  // scoped so the admin UI for one workspace doesn't see every other tenant's
  // instance traffic; agent subscribers don't need this (it's pure UI fuel for
  // the human-side dashboard).
  {
    eventType: 'agent_instance_update',
    emitterEvent: 'agent_instance_update',
    map(event: any) {
      const inst = event?.instance || {};
      const mode: 'daemon' | 'proxy' | 'manager' =
        inst.mode === 'daemon' ? 'daemon' : inst.mode === 'manager' ? 'manager' : 'proxy';
      const payload: AgentInstanceUpdatePayload = {
        action: event?.action === 'registered' || event?.action === 'removed' ? event.action : 'updated',
        instance: {
          instance_id: String(inst.instance_id || ''),
          agent_id: String(inst.agent_id || ''),
          workspace_id: typeof inst.workspace_id === 'string' ? inst.workspace_id : null,
          mode,
          hostname: String(inst.hostname || 'unknown'),
          plugin_version: String(inst.plugin_version || 'unknown'),
          cli: String(inst.cli || 'claude'),
          cli_adapters: Array.isArray(inst.cli_adapters) ? inst.cli_adapters.map(String) : [],
          pid: Number.isFinite(inst.pid) ? Number(inst.pid) : 0,
          started_at: String(inst.started_at || ''),
          last_seen_at: String(inst.last_seen_at || ''),
          agent_ids: Array.isArray(inst.agent_ids) ? inst.agent_ids.map(String) : undefined,
          working_dirs: Array.isArray(inst.working_dirs) ? inst.working_dirs.map(String) : undefined,
          paired_at: typeof inst.paired_at === 'string' ? inst.paired_at : undefined,
          // Manager self-update fields — the admin UI (AgentManagerPage) reads
          // these off the LIVE SSE instance to render the "update available"
          // badge. This field-by-field reconstruction previously dropped them,
          // so the badge only appeared on a full REST page reload, never via the
          // live heartbeat. Same silent-drop class as the agent_trigger fields.
          latest_version:
            typeof inst.latest_version === 'string' || inst.latest_version === null
              ? inst.latest_version
              : undefined,
          update_available:
            typeof inst.update_available === 'boolean' ? inst.update_available : undefined,
          repo_root:
            typeof inst.repo_root === 'string' || inst.repo_root === null ? inst.repo_root : undefined,
          default_branch:
            typeof inst.default_branch === 'string' || inst.default_branch === null
              ? inst.default_branch
              : undefined,
          update_last_checked_at:
            typeof inst.update_last_checked_at === 'string' || inst.update_last_checked_at === null
              ? inst.update_last_checked_at
              : undefined,
          update_last_error:
            typeof inst.update_last_error === 'string' || inst.update_last_error === null
              ? inst.update_last_error
              : undefined,
        },
      };
      return {
        payload,
        scope: { workspace_id: payload.instance.workspace_id || undefined },
        timestamp: event?.timestamp || payload.instance.last_seen_at,
      };
    },
    // UI fuel only — admins watching the dashboard. Agents have no use for
    // their sibling instances' presence (they already know about their own).
    filter: (env, identity) => identity.type === 'user',
    flatten: (env) => ({ event_type: 'agent_instance_update', ...(env.payload as object), timestamp: env.timestamp }),
  },

  // ───────── agent_manager_command ─────────
  // ST-4 — AWB → awb-agent-manager control message. Per-agent delivery: only
  // the manager whose Agent identity matches scope.agent_id receives this.
  // Multiple manager processes can share one Agent identity (e.g., laptop + VM
  // running with the same pairing code) — instance_id discrimination happens
  // on the manager side after delivery.
  {
    eventType: 'agent_manager_command',
    emitterEvent: 'agent_manager_command',
    map(event: any) {
      const payload: AgentManagerCommandPayload = {
        command_id: String(event.command_id || ''),
        instance_id: String(event.instance_id || ''),
        agent_id: String(event.agent_id || ''),
        command: event.command,
        args: typeof event.args === 'object' && event.args ? event.args : {},
        issued_by: String(event.issued_by || ''),
        issued_at: String(event.issued_at || new Date().toISOString()),
      };
      return {
        payload,
        scope: { agent_id: payload.agent_id },
        timestamp: payload.issued_at,
      };
    },
    // Only the target manager-agent identity receives the command. agent-only
    // delivery — admins watching the dashboard see the SSE round-trip via the
    // ack-driven activity log entry, not the command event itself.
    filter: (env, identity) => {
      if (identity.type !== 'agent') return false;
      return env.scope.agent_id === identity.agentId;
    },
    flatten: (env) => ({
      event_type: 'agent_manager_command',
      ...(env.payload as object),
      timestamp: env.timestamp,
    }),
  },

  // ───────── consensus_update ─────────
  // 다중담당자·합의 T4. record_agreement 시그널 직후 서버가 재판정한 합의 상태를
  // 밀어 넣는다. UI(T6)만 소비 — agent(agent-manager 포함)는 서버가 이동 시점에
  // getConsensusState 로 재계산하므로 이 이벤트가 필요 없다. 따라서 user-only
  // filter: agent-manager 스위치는 이 타입을 받지 않고 SSE contract 무관.
  // subagent_*/agent_instance_update 와 같은 "UI fuel" 패턴 — 워크스페이스
  // 스코프는 페이지(REST) 레벨에서 좁혀지고, 여기선 user 구독자에게만 흘린다.
  {
    eventType: 'consensus_update',
    emitterEvent: 'consensus_update',
    map(event: any) {
      const payload: ConsensusUpdatePayload = {
        ticket_id: event.ticket_id,
        workspace_id: event.workspace_id || '',
        proposal_id: event.proposal_id ?? null,
        satisfied: !!event.satisfied,
        required: Number.isFinite(event.required) ? Number(event.required) : 0,
        agreed: Number.isFinite(event.agreed) ? Number(event.agreed) : 0,
        objected: Number.isFinite(event.objected) ? Number(event.objected) : 0,
        pending: Number.isFinite(event.pending) ? Number(event.pending) : 0,
        status: event.status === 'object' ? 'object' : 'agree',
        override: !!event.override,
        actor_id: event.actor_id || '',
        actor_name: event.actor_name || '',
      };
      return {
        payload,
        scope: { workspace_id: event.workspace_id || undefined, ticket_id: event.ticket_id },
        timestamp: event.timestamp,
      };
    },
    // UI fuel only — human dashboards / ticket panels. Agents don't consume
    // consensus state (the gate recomputes server-side at move time).
    filter: (_env, identity) => identity.type === 'user',
    flatten: (env) => ({ event_type: 'consensus_update', ...(env.payload as object), timestamp: env.timestamp }),
  },
];
