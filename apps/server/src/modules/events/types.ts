// Shared types for the SSE events module.
// Defined separately from event-registry.ts so the registry file stays focused
// on the EVENT_TYPES table, and consumers (the controller) can import the
// identity / context types without pulling in the registry data.
import { StreamEvent } from '../../common/types/stream-events';

/**
 * Subscriber identity resolved by the SSE stream handler from the auth token
 * or API key, plus any connection-scoped query params (e.g. boardId).
 */
export interface SubscriberIdentity {
  type: 'user' | 'agent';
  name: string;
  agentId?: string;
  userId?: string;
  /** boardId query param, scoping board_update delivery. */
  boardId?: string;
  /**
   * Server-generated UUID for THIS specific SSE connection. Lets the
   * controller's filter pipeline route agent-targeted events (triggers,
   * mentions, chat) to a single "main" session when an agent has 2+
   * concurrent proxies, instead of fanning out and racing duplicate
   * subagents. Always set in events.controller.ts; only optional here so
   * legacy callers building the identity ad-hoc still type-check.
   */
  sseSessionId?: string;
}

/**
 * Helpers an EventDefinition.map() can call when it needs data beyond the raw
 * emitter payload (e.g., board_update resolves ticket → board_id via the DB).
 */
export interface EventMapContext {
  resolveBoardId(ticketId: string, entityId: string): Promise<string | null>;
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
   * Some legacy types flatten payload fields up to the top level for proxy.mjs compat.
   */
  flatten?(envelope: StreamEvent<P>): any;
}
