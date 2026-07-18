import { Injectable } from '@nestjs/common';
import { MemoryMetricsRegistry } from './memory-metrics.registry';

/**
 * AgentConnectivityRegistry (ticket bfdd80b7).
 *
 * The single in-memory answer to "would a dispatch / chat scoped to agent X
 * actually reach a live subscriber right now?" — the TRUE reachability signal
 * the never-started/offline feedback gate needs.
 *
 * WHY NOT `Agent.is_online`
 * `is_online` is a lagging DB flag set only by the MCP `ping` tool or the
 * manager heartbeat. An agent connected over SSE that never pings (e.g. the
 * plugin proxy / the test VirtualAgent, and the ≤90s window while a heartbeat
 * is momentarily stale) receives triggers fine yet reads `is_online = 0`.
 * Gating dispatch on `is_online` would wrongly defer those — the exact
 * false-negative that would break live dispatch.
 *
 * WHAT IT TRACKS
 * EventsController owns the live SSE fan-out. On every SSE connect it records
 * the connecting identity's own `agentId` AND (for a manager identity) the set
 * of `managedAgentIds` it supervises — the exact keys the fan-out filter routes
 * `agent_trigger` / `chat_request` to. So `isReachable(X)` is true iff some live
 * SSE session would deliver an X-scoped event: X connected its own stream, OR a
 * live manager that supervises X is connected. Reference-counted by session so
 * concurrent proxies / a manager reconnect are handled, and drained on
 * disconnect so it never grows unbounded.
 *
 * Global (SharedServicesModule) so both the producer (EventsController, events
 * module) and the consumer (AgentAutostartService, agents module) reach it
 * without a module cycle.
 */
@Injectable()
export class AgentConnectivityRegistry {
  // sessionId → the ids that session makes reachable (its own agentId, if any,
  // plus every managed agent id it supervises). Kept so a disconnect can undo
  // exactly what the matching connect added.
  private readonly bySession = new Map<string, { agentId?: string; managed: string[] }>();
  // agentId → number of live sessions currently making it reachable. Entry
  // removed at zero so `.size` tracks the distinct reachable-agent count.
  private readonly reach = new Map<string, number>();

  constructor(metrics: MemoryMetricsRegistry) {
    // At rest this equals the count of distinct agents with a live delivery
    // channel. A monotonic climb means a disconnect path stopped draining.
    metrics.register('sse.reachableAgents', () => this.reach.size);
  }

  private _inc(id: string): void {
    if (!id) return;
    this.reach.set(id, (this.reach.get(id) ?? 0) + 1);
  }

  private _dec(id: string): void {
    if (!id) return;
    const n = (this.reach.get(id) ?? 0) - 1;
    if (n <= 0) this.reach.delete(id);
    else this.reach.set(id, n);
  }

  /**
   * Record a live SSE session. `agentId` is the connecting identity's own agent
   * id (undefined for a plain user session); `managedAgentIds` is the supervised
   * set for a manager identity. Idempotent per sessionId (a re-register replaces
   * the prior mapping cleanly).
   */
  noteConnected(sessionId: string, agentId: string | undefined, managedAgentIds?: Iterable<string>): void {
    if (!sessionId) return;
    this.noteDisconnected(sessionId); // idempotent replace
    const managed = managedAgentIds ? Array.from(managedAgentIds) : [];
    if (!agentId && managed.length === 0) return; // a plain user session reaches no agent
    this.bySession.set(sessionId, { agentId, managed });
    this._inc(agentId ?? '');
    for (const m of managed) this._inc(m);
  }

  /** Drop a session's contribution (SSE disconnect). No-op if unknown. */
  noteDisconnected(sessionId: string): void {
    const entry = this.bySession.get(sessionId);
    if (!entry) return;
    this.bySession.delete(sessionId);
    if (entry.agentId) this._dec(entry.agentId);
    for (const m of entry.managed) this._dec(m);
  }

  /** Would an X-scoped SSE event reach a live subscriber right now? */
  isReachable(agentId: string): boolean {
    return !!agentId && (this.reach.get(agentId) ?? 0) > 0;
  }
}
