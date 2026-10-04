// Shared types for the SSE events module.
// Defined separately from event-registry.ts so the registry file stays focused
// on the EVENT_TYPES table, and consumers (the controller) can import the
// identity / context types without pulling in the registry data.
import { StreamEvent } from '../../common/types/stream-events';

/**
 * Subscriber identity resolved by the SSE stream handler from the auth token
 * or API key.
 */
export interface SubscriberIdentity {
  type: 'user' | 'agent';
  name: string;
  agentId?: string;
  userId?: string;
  /** Server-generated UUID for this SSE connection. */
  sseSessionId?: string;
  /**
   * ST-6: When this identity is an agent-manager, the set of managed-agent
   * ids it owns (Agent rows where manager_agent_id == this.agentId).
   * Resolved at SSE connect time; used by the controller's filter pipeline
   * to also deliver agent-targeted events whose target agent is owned by
   * this manager. Without it, the manager's SSE stream would only see
   * events for the manager's own identity and never see triggers / chat /
   * mentions destined for the managed agents it spawns.
   */
  managedAgentIds?: Set<string>;
  /**
   * P4c-2b: 이 SSE 연결의 Runtime Host id (ApiKey.host_id, P0 dual-write).
   * 구 키에는 없어 undefined — 그 경우 host-affinity 분기는 조용히 스킵된다.
   * chat_room_message의 rt- 멤버 해석에 쓴다: broadcast의
   * agent_member_runtimes 맵에서 spec.manager_agent_id가 이 hostId(또는
   * legacy agentId)와 일치하는 멤버가 있으면 그 매니저에게 배달한다.
   */
  hostId?: string;
}

/**
 * Helpers an EventDefinition.map() can call when it needs data beyond the raw
 * emitter payload (e.g., board_update resolves the ticket's root via the DB).
 */
export interface EventMapContext {
  /**
   * The ROOT ticket behind an activity (subtasks walk up to their root):
   * workspace, status and project. null when the ticket is gone.
   */
  resolveTicketSnapshot(ticketId: string, entityId: string): Promise<{
    root_id: string;
    workspace_id: string;
    status: string;
    project_id: string;
  } | null>;
  /**
   * Canonical `<Manager>/<Agent>` display for an actor id, so a live
   * `board_update` SSE frame carries the SAME name the durable read path
   * (ActivityService.getTicketActivity) projects — without this the realtime
   * consumer sees the bare leaf `actor_name` the write path stamped until it
   * refetches. Returns null when the id is empty or resolves to a non-agent
   * (user, system label) so the caller keeps the stored `actor_name` verbatim.
   */
  resolveActorDisplayName(actorId: string): Promise<string | null>;
}

/**
 * Return shape of EventDefinition.map(): the pieces needed to assemble a
 * StreamEvent envelope. timestamp is optional — handlers default to now()
 * when the source event doesn't carry one.
 */
export interface MappedEnvelope<P = any> {
  payload: P;
  scope: StreamEvent<P>['scope'];
  timestamp?: string;
}

/**
 * Full lifecycle definition for one SSE event type. See EVENT_TYPES in
 * event-registry.ts for the registered instances.
 */
export interface EventDefinition<SourceEvent = any, P = any> {
  /** StreamEvent.event_type emitted on the wire. */
  eventType: StreamEvent['event_type'];
  /** Name of the event on the activityEvents EventEmitter. */
  emitterEvent: string;
  /**
   * Convert an emitter payload into the envelope fields (payload/scope/timestamp).
   * Return null/undefined to skip emission (e.g., activity without a resolvable board_id).
   * May be synchronous or asynchronous.
   */
  map(
    event: SourceEvent,
    ctx: EventMapContext,
  ): MappedEnvelope<P> | null | undefined | Promise<MappedEnvelope<P> | null | undefined>;
  /**
   * Return true if the envelope should reach this subscriber. Default: deliver to all.
   */
  filter?(envelope: StreamEvent<P>, identity: SubscriberIdentity): boolean;
  /**
   * Transform the envelope into the wire `data` object. Default: envelope as-is.
   * Some Runtime Host-consumed types flatten payload fields to the top level.
   */
  flatten?(envelope: StreamEvent<P>): any;
}
