/**
 * AgentDispatchQueueService — per-agent priority queue for triggers that
 * couldn't fire immediately because the agent had hit its
 * `Board.max_concurrent_tickets_per_agent` cap.
 *
 * Why this exists (v0.41 root-cause fix):
 *
 *   The pre-v0.41 TriggerLoopService logged a `trigger_skipped_cap`
 *   activity row and **silently dropped** any trigger that arrived while
 *   the agent was busy. That made high-priority work (e.g. a
 *   `priority: critical` Review column-move) starve behind a long-running
 *   backlog promotion: the column-move trigger landed mid-promotion, found
 *   the cap closed, and disappeared. The supervisor backstop only re-pushed
 *   after 30 minutes of staleness — long enough for the user to think the
 *   pipeline had stalled.
 *
 * What the queue does:
 *
 *   1. TriggerLoopService, on cap-exceeded, calls `enqueue()` instead of
 *      dropping. The item carries the ticket / role / priority_index /
 *      trigger_id needed to reconstruct the SSE payload later.
 *   2. AgentStatusService.clearCurrentTask() emits 'agent_idle' on
 *      activityEvents whenever an agent's active_tasks set shrinks. The
 *      TriggerLoop subscribes to that signal and asks the queue for the
 *      next item via `tryDispatchNext()`.
 *   3. Queue items are sorted by `priority_index` (low = high priority)
 *      then `enqueued_at` (FIFO within the same priority). High-priority
 *      Review work jumps the queue ahead of medium-priority backlog
 *      narration even if the latter arrived first.
 *
 * Cap on depth:
 *
 *   `Workspace.dispatch_queue_depth` (default 100) bounds the per-agent
 *   queue size. Beyond that, the lowest-priority pending item is
 *   evicted — never the highest. The eviction is logged as a
 *   `queue_dropped_low_priority` activity row so admins can see that the
 *   queue is overloaded (i.e. the agent legitimately can't keep up rather
 *   than the dispatcher silently losing work).
 *
 * Observability:
 *
 *   Every state transition logs an ActivityLog row:
 *   - `trigger_enqueued`        (cap-exceeded path)
 *   - `dispatched_from_queue`   (idle path picked up an item)
 *   - `queue_dropped_low_priority` (depth cap evicted the worst item)
 *
 *   Acceptance criterion #5 in ticket 47a90ea3 is verifiable by querying
 *   ActivityLog for those three event types.
 *
 * State is in-memory only. A server restart drops the queue, which means
 * the supervisor's stale-allocation re-push (now also priority-aware)
 * becomes the eventual-consistency backstop. Persisting the queue would
 * just be additional write traffic for a recovery path we already cover.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';

export interface QueueItem {
  ticket_id: string;
  /** Workspace-scoped role slug. Used by TriggerLoop to recompose the SSE payload. */
  role: string;
  agent_id: string;
  workspace_id: string;
  /**
   * Priority sort key: 0 = critical, 1 = high, 2 = medium, 3 = low,
   * 4+ = unknown / lowest. Computed by AllocationService.priorityIndex
   * from `Ticket.priority`. The single sort key for the dispatch order;
   * code MUST NOT compare the raw priority string anywhere.
   */
  priority_index: number;
  /**
   * The `trigger_id` UUID minted by the TriggerLoop when it tried to
   * fire — so when we eventually dispatch from the queue, the plugin
   * dedupe key matches the original SSE attempt. This is what makes the
   * "queued then dispatched" event observable in the audit trail.
   */
  trigger_id: string;
  trigger_source: string;
  /** ms epoch — secondary sort key for FIFO within a priority. */
  enqueued_at: number;
  triggered_by: string;
  /** Whether the original cap-skip emit was a force_respawn. Preserved end-to-end. */
  force_respawn?: boolean;
  /**
   * Cap-skip rationale token surfaced on the `trigger_enqueued` audit
   * row. Currently `'workflow-state'` for the workflow-load gate
   * introduced by ticket e79eef92; future gates (e.g. `'rate-limit'`,
   * `'maintenance'`) can reuse the channel. Optional because not every
   * caller computes a gate label.
   */
  gate?: string;
}

/**
 * Default depth used when the workspace setting can't be loaded (e.g.
 * agent has no workspace_id, or the row is null mid-migration). Matches
 * the Workspace entity column default.
 */
export const DEFAULT_DISPATCH_QUEUE_DEPTH = 100;

@Injectable()
export class AgentDispatchQueueService {
  // agent_id → priority-sorted item list. Sorted on every mutation so
  // peek/dequeue is O(1). With per-agent depths bounded by
  // Workspace.dispatch_queue_depth (default 100) the resort cost is
  // negligible vs. the simplicity gain over a heap.
  private readonly queues = new Map<string, QueueItem[]>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  /**
   * Enqueue an item, evicting the lowest-priority entry if depth is
   * exceeded. Returns whether the new item ended up in the queue
   * (false means it was the one evicted because every other entry
   * was higher priority).
   */
  async enqueue(item: QueueItem): Promise<{ enqueued: boolean; dropped?: QueueItem }> {
    // CRITICAL — get-or-create + register the queue array SYNCHRONOUSLY
    // (no await between get and set). Two concurrent enqueues for the
    // same fresh agent both read `undefined`, both `?? []` to a NEW
    // array, and only the last `set` wins — silently dropping one item.
    // Touching `this.queues.set` before the await binds both calls to
    // the same array reference so the race becomes a no-op double-push.
    let queue = this.queues.get(item.agent_id);
    if (!queue) {
      queue = [];
      this.queues.set(item.agent_id, queue);
    }

    // Resolve the workspace-level depth cap. Fallback to the default if
    // the workspace row is unreachable — preferable to dropping the item
    // on the floor over a cosmetic config error.
    const depth = await this._resolveQueueDepth(item.workspace_id);

    queue.push(item);
    sortQueueInPlace(queue);

    let dropped: QueueItem | undefined;
    if (queue.length > depth) {
      // Cut the tail (worst priority + latest enqueued_at). pop() returns
      // the last entry which is exactly the worst one after sort.
      dropped = queue.pop();
      if (dropped) {
        await this._logActivity(dropped, 'queue_dropped_low_priority',
          `agent=${item.agent_id} depth=${depth} dropped_priority_index=${dropped.priority_index}`);
        this.logService.info('AgentDispatchQueue', 'queue depth exceeded — dropped lowest priority', {
          agent_id: item.agent_id, depth,
          dropped_ticket_id: dropped.ticket_id, dropped_priority_index: dropped.priority_index,
        });
      }
    }

    // The new item *may* have been the one we just popped (if it was the
    // worst entry at insertion time and the queue was already full). Detect
    // by reference identity — a fresh QueueItem is only ever inserted once.
    const enqueued = !dropped || dropped !== item;
    if (enqueued) {
      // gate=... token appended when the caller labelled the cap-skip
      // rationale. See QueueItem.gate; required by ticket e79eef92
      // acceptance ("emit skip 시 trigger_enqueued 메타에 gate=workflow-state").
      const gateToken = item.gate ? ` gate=${item.gate}` : '';
      await this._logActivity(item, 'trigger_enqueued',
        `agent=${item.agent_id} depth=${queue.length}/${depth} priority_index=${item.priority_index}${gateToken}`);
      this.logService.info('AgentDispatchQueue', 'trigger enqueued', {
        agent_id: item.agent_id, ticket_id: item.ticket_id, role: item.role,
        priority_index: item.priority_index, depth: queue.length, max_depth: depth,
      });
    }

    return { enqueued, dropped };
  }

  /** Snapshot — used by REST/admin diagnostics endpoints. */
  getAll(agentId: string): QueueItem[] {
    return [...(this.queues.get(agentId) ?? [])];
  }

  /** Total pending item count for an agent. */
  size(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /**
   * Peek the highest-priority item for the agent without removing it.
   * Returns null if the queue is empty.
   */
  peek(agentId: string): QueueItem | null {
    const queue = this.queues.get(agentId);
    return queue && queue.length > 0 ? queue[0] : null;
  }

  /**
   * Remove and return the highest-priority item. Used by the dispatch
   * caller (TriggerLoopService.tryDispatchFromQueue) once it has decided
   * to actually emit the SSE event. Logs `dispatched_from_queue` so the
   * audit trail makes the queue-driven flow observable.
   */
  async dequeueHead(agentId: string): Promise<QueueItem | null> {
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return null;
    const head = queue.shift()!;
    if (queue.length === 0) this.queues.delete(agentId);
    await this._logActivity(head, 'dispatched_from_queue',
      `agent=${agentId} priority_index=${head.priority_index} wait_ms=${Date.now() - head.enqueued_at}`);
    this.logService.info('AgentDispatchQueue', 'dispatched_from_queue', {
      agent_id: agentId, ticket_id: head.ticket_id, role: head.role,
      priority_index: head.priority_index, wait_ms: Date.now() - head.enqueued_at,
    });
    return head;
  }

  /**
   * Drop every queued item for an agent on a specific ticket — used when
   * the ticket lands on a terminal column (the cached triggers are stale
   * by definition) or when the role assignment changes mid-flight.
   * Returns the number of items removed.
   */
  removeForTicket(agentId: string, ticketId: string): number {
    const queue = this.queues.get(agentId);
    if (!queue) return 0;
    const before = queue.length;
    const next = queue.filter(item => item.ticket_id !== ticketId);
    if (next.length === before) return 0;
    if (next.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, next);
    return before - next.length;
  }

  /**
   * Drop every queued item for the given ticket across ALL per-agent
   * queues. Wired to the terminal-landing path: once a ticket reaches a
   * terminal column, any queued trigger naming that ticket is stale by
   * definition (the destination column is no longer triggerable). Without
   * this sweep, depth-cap pressure could evict still-valid high-priority
   * items in favour of these dead entries until each one drifts up to the
   * head and gets dropped lazily by `_tryDispatchFromQueue`.
   *
   * Returns total items removed across all agents.
   */
  removeForTicketEverywhere(ticketId: string): number {
    let removed = 0;
    for (const agentId of Array.from(this.queues.keys())) {
      removed += this.removeForTicket(agentId, ticketId);
    }
    return removed;
  }

  /**
   * Re-insert a previously dequeued item without writing a fresh
   * `trigger_enqueued` audit row. Used by `_tryDispatchFromQueue` when
   * the cap is found still-closed AFTER the dequeue: we put the item
   * back in priority order and wait for the next idle signal. The
   * original `trigger_enqueued` from the cap-skip emit is still on
   * record, so re-enqueue would be misleading double-counting.
   *
   * Bypasses the depth cap on purpose — re-insertion is recovery from
   * our own dequeue, not an enqueue admitting a new item.
   */
  requeueAtPriority(item: QueueItem): void {
    let queue = this.queues.get(item.agent_id);
    if (!queue) {
      queue = [];
      this.queues.set(item.agent_id, queue);
    }
    queue.push(item);
    sortQueueInPlace(queue);
  }

  /**
   * Look up the workspace's `dispatch_queue_depth` setting; fall back to
   * the code default on any error. Cached implicitly via the Workspace
   * row's normal repo cache lifetime — settings changes propagate on
   * the next enqueue.
   */
  private async _resolveQueueDepth(workspaceId: string): Promise<number> {
    if (!workspaceId) return DEFAULT_DISPATCH_QUEUE_DEPTH;
    try {
      const ws = await this.dataSource.getRepository(Workspace).findOne({
        where: { id: workspaceId },
      });
      const raw = ws?.dispatch_queue_depth;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    } catch (e) {
      this.logService.warn('AgentDispatchQueue', 'failed to resolve workspace depth — using default', {
        err: String(e), workspace_id: workspaceId,
      });
    }
    return DEFAULT_DISPATCH_QUEUE_DEPTH;
  }

  /**
   * Activity-log helper writing the v0.41 queue events. Writes directly
   * to the repo because ActivityService.logActivity narrows `action` to
   * the legacy enum and we deliberately ship new event names that didn't
   * exist before. The underlying column is varchar so any string is
   * accepted at the storage layer.
   */
  private async _logActivity(item: QueueItem, action: string, summary: string): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      await repo.save(repo.create({
        entity_type: 'ticket',
        entity_id: item.ticket_id,
        ticket_id: item.ticket_id,
        actor_id: 'system',
        actor_name: 'AgentDispatchQueueService',
        action,
        new_value: summary,
        role: item.role,
        trigger_source: item.trigger_source,
      }));
    } catch (e) {
      // Logging the queue state is observability-only; failing to write
      // a row never blocks dispatch — that's the whole point of this
      // service over the old silent-drop path.
      this.logService.warn('AgentDispatchQueue', 'activity log write failed (non-fatal)', {
        err: String(e), action, ticket_id: item.ticket_id,
      });
    }
  }
}

/**
 * Sort by priority_index ASC (so 0 = critical comes first), then
 * enqueued_at ASC (FIFO within a priority). Mutates in place.
 *
 * The single canonical priority sort key for the dispatch path. Anywhere
 * else that needs to order by priority MUST use the same `priority_index`
 * field — comparing the raw priority string directly is forbidden.
 */
export function sortQueueInPlace(queue: QueueItem[]): void {
  queue.sort((a, b) => {
    if (a.priority_index !== b.priority_index) return a.priority_index - b.priority_index;
    return a.enqueued_at - b.enqueued_at;
  });
}
