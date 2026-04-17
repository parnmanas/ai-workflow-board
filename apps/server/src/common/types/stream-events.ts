// Unified SSE event envelope — see .planning/phases/01-foundation/01-CONTEXT.md D-06/D-07/D-08
// ALL five event types listed here; only the first three have producers in Phase 1.
// chat_message (Phase 2) and agent_status (Phase 3) are skeleton-only — type declared,
// filter branch exists, NO emit producer. This is the explicit D-08 scope.

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
  | 'user_mention';        // Mention feature: user @-mentioned (web UI unread badge)

export interface StreamEventScope {
  board_id?: string;
  agent_id?: string;
  user_id?: string;
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

// Phase 3 — producer wired in Plan 03-01 (AgentStatusService + agentStatusListener)
export interface AgentStatusPayload {
  agent_id: string;
  is_online: boolean;
  last_seen_at: string | null;  // ISO-8601
  current_task?: {
    ticket_id: string;
    ticket_title: string;
    claimed_at: string;  // ISO-8601
  };
}

// Phase 4 D-71/D-72/D-73 — emitted by ChatService.sendUserMessage on activityEvents 'chat_request'.
// Proxy.mjs consumes this envelope-native (NOT flattened) to spawn a dedicated chat subagent per
// conversation (CHAT-09 completion via Phase 4 delegation path). Per-agent delivery only:
// only the target agent's connected proxy sees the event.
export interface ChatRequestHistoryEntry {
  message_id: string;
  sender_type: 'user' | 'agent';
  content: string;
  created_at: string; // ISO-8601
}

export interface ChatRequestPayload {
  agent_id: string;
  user_id: string;
  ticket_id: string | null;
  role_prompt: string;
  new_message: string;
  history: ChatRequestHistoryEntry[];
}

// Phase 7 — room-based chat
export interface ChatRoomMessagePayload {
  room_id: string;
  message_id: string;
  sender_type: 'user' | 'agent';
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: string; // ISO-8601
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
}

export interface ChatRoomTypingPayload {
  room_id: string;
  agent_id: string;
  agent_name: string;
  is_typing: boolean;
  status?: string | null;
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

// Mention feature — user @-mentioned. Fires only for the mentioned user's
// connected sessions so the sidebar badge reconciles without a round-trip.
export interface UserMentionPayload {
  mention_id: string;           // UserMention.id
  user_id: string;              // mentioned user
  workspace_id: string;
  source_type: 'comment' | 'chat_message';
  source_id: string;
  ticket_id: string | null;
  room_id: string | null;
  actor_id: string;
  actor_type: 'user' | 'agent';
  actor_name: string;
  preview: string;
  created_at: string; // ISO-8601
}
