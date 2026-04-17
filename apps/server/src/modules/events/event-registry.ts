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
} from '../../common/types/stream-events';
import { EventDefinition, SubscriberIdentity } from './types';

// ── Helpers used by multiple filter functions ─────────────────────────────

/** Participant-based filter: only members of the room receive the event. */
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
      };
      return {
        payload,
        scope: { agent_id: event.agent_id },
        timestamp: event.timestamp,
      };
    },
    // Phase 1 keeps broadcast behavior (proxy.mjs filters client-side).
    // D-07 recipient-scoping is skeleton for future tightening.
    filter: () => true,
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
        content: event.content,
        created_at: event.created_at,
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
];
