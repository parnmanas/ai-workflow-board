// Phase 3 Plan 03-01 — Agent status runtime service (D-38, D-39, D-52, D-53, D-54)
//
// This service is the single runtime source of truth for broadcasting live agent
// status changes over SSE. It LAYERS ON TOP OF AgentConnectionService — it does
// NOT replace it. AgentConnectionService continues to update Agent.is_online in
// the DB (authoritative for admin views); this service reads that state on a
// 30s sweep and emits `agent_status` events on the activityEvents bus whenever
// the in-memory Map<agent_id, AgentStatus> actually changes.
//
// NOTE on multi-workspace: Phase 3 is single-workspace (see REQUIREMENTS Out of
// Scope). The sweep reads every agent in the agents table regardless of workspace.
// When multi-tenant arrives, the sweep + emit path will need a workspace filter
// (see 03-RESEARCH.md §Pitfall 7).
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';

// Internal shape — held in memory with Date objects for precision. The wire
// shape (AgentStatusPayload in common/types/stream-events.ts) carries ISO-8601
// strings; conversion happens at the EventsController listener boundary.
//
// `active_tasks` (internal-only) tracks every ticket the agent has an active
// subagent for, keyed by ticket_id. The wire-facing `current_task` (singular)
// is derived as the most-recently-claimed entry so the existing SSE shape
// stays unchanged. Multiple-active-task tracking is what the per-board
// `max_concurrent_tickets_per_agent` gate counts against.
interface ActiveTask {
  ticket_id: string;
  ticket_title: string;
  claimed_at: Date;
  // Role slug the subagent was spawned for (assignee/reporter/reviewer
  // or a workspace-custom slug). Optional because pre-v0.34 plugins do
  // not pin a role; the dashboard renders without it when undefined.
  role?: string;
}
interface AgentStatus {
  agent_id: string;
  is_online: boolean;
  last_seen_at: Date | null;
  // Map<ticket_id, ActiveTask>. Internal-only; never serialized to SSE.
  active_tasks?: Map<string, ActiveTask>;
  // Derived from active_tasks — most-recently-claimed entry, or undefined
  // when active_tasks is empty. Kept on the object so the existing
  // event-registry mapper and dashboard reads stay unchanged.
  current_task?: ActiveTask;
}

const SWEEP_INTERVAL_MS = 30_000;
const OFFLINE_THRESHOLD_MS = 90_000;
// current_task is plugin-signal driven. If a plugin crashes between
// setCurrentTask and clearCurrentTask the task would otherwise stay stuck;
// the sweep auto-clears any task older than this so the dashboard recovers
// without manual intervention. Tuned long enough that legitimate long-running
// reviews don't flap, short enough that crashes self-heal within ~one sweep.
const CURRENT_TASK_STALE_MS = 15 * 60_000;

@Injectable()
export class AgentStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, AgentStatus>();
  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Seed the in-memory map from the current DB snapshot so that the first
    // sweep after startup compares against real state (not an empty map).
    const agents = await this.agentRepo.find();
    for (const a of agents) {
      this.state.set(a.id, {
        agent_id: a.id,
        is_online: !!a.is_online,
        last_seen_at: a.last_seen_at,
      });
    }

    // Note: previously a `agent_trigger` listener auto-set current_task on
    // every trigger emit. That made "processing" indistinguishable from
    // "trigger queued" — agents that never picked the trigger up (proxy
    // disconnected, subagent silent-exit, spawn failure) appeared busy
    // forever. current_task is now strictly plugin-signal driven via
    // setCurrentTask / clearCurrentTask, so the dashboard reflects what's
    // actually executing rather than what was dispatched.

    // D-53: 30s sweep handle stored in field (cleared in onModuleDestroy per §Pitfall 8).
    this.sweepHandle = setInterval(() => {
      this._sweep().catch((e: unknown) => {
        this.logService.error('AgentStatus', 'sweep failed', { err: e });
      });
    }, SWEEP_INTERVAL_MS);

    this.logService.info('AgentStatus', 'Service initialized with N agents seeded', {
      count: agents.length,
    });
  }

  onModuleDestroy(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /** Snapshot accessor for REST endpoints (Plan 03-02 dashboard GET). */
  getSnapshot(): AgentStatus[] {
    return Array.from(this.state.values());
  }

  /** Single-agent lookup for REST endpoints (Plan 03-02 agent detail GET). */
  getOne(agentId: string): AgentStatus | undefined {
    return this.state.get(agentId);
  }

  /**
   * Distinct ticket_ids this agent currently has live subagents on, after
   * the stale-cutoff filter (mirrors what the sweep would clear). Used by
   * TriggerLoopService's per-board cap check — comparing list length
   * against `Board.max_concurrent_tickets_per_agent` decides whether a
   * new trigger emits or gets skipped.
   */
  getActiveTicketIds(agent_id: string): string[] {
    const status = this.state.get(agent_id);
    if (!status?.active_tasks || status.active_tasks.size === 0) return [];
    const cutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    const out: string[] = [];
    for (const [ticketId, task] of status.active_tasks) {
      if (task.claimed_at >= cutoff) out.push(ticketId);
    }
    return out;
  }

  /**
   * Emit the internal (Date-containing) shape on the activityEvents bus.
   * EventsController.agentStatusListener converts Date → ISO string at the
   * envelope construction boundary.
   */
  private _emit(status: AgentStatus): void {
    activityEvents.emit('agent_status', status);
  }

  /**
   * Plugin signal: an agent has just spawned a ticket-session subagent and
   * actually started working on the ticket. Stamps current_task + is_online +
   * last_seen_at so the dashboard reflects "in progress" the instant the
   * subagent process is alive — not when the trigger was queued.
   */
  async setCurrentTask(agent_id: string, ticket_id: string, role?: string): Promise<void> {
    if (!agent_id || !ticket_id) return;

    const ticket = await this.dataSource
      .getRepository(Ticket)
      .findOne({ where: { id: ticket_id } });

    const existing = this.state.get(agent_id) ?? {
      agent_id,
      is_online: true,
      last_seen_at: new Date(),
    };
    const tasks = new Map(existing.active_tasks ?? []);
    const task: ActiveTask = {
      ticket_id,
      ticket_title: ticket?.title ?? '(unknown ticket)',
      claimed_at: new Date(),
      role: role || undefined,
    };
    tasks.set(ticket_id, task);
    const updated: AgentStatus = {
      ...existing,
      is_online: true,
      last_seen_at: new Date(),
      active_tasks: tasks,
      current_task: pickMostRecent(tasks),
    };
    this.state.set(agent_id, updated);
    this._emit(updated);
  }

  /**
   * Plugin signal: subagent for the ticket has exited (idle TTL, normal
   * completion, or crash). Clears current_task so the dashboard releases the
   * "processing" badge.
   *
   * `expectedTicketId` lets the caller assert intent — if a newer task
   * already overwrote current_task we must not clobber it. Pass undefined to
   * force-clear unconditionally (e.g. agent shutdown).
   */
  clearCurrentTask(agent_id: string, expectedTicketId?: string): void {
    if (!agent_id) return;
    const status = this.state.get(agent_id);
    if (!status?.active_tasks || status.active_tasks.size === 0) return;

    const tasks = new Map(status.active_tasks);
    if (expectedTicketId) {
      // Targeted clear: drop just this ticket's entry. No-op if a newer
      // setCurrentTask already replaced it (which on a Map means the same
      // key is still present but with a fresher claimed_at — caller's
      // intent was to clear THIS task, so we still drop it; the manager
      // would call setCurrentTask again on the next session anyway).
      if (!tasks.delete(expectedTicketId)) return;
    } else {
      // Force-clear all (agent shutdown). Mirrors pre-multi-task behavior.
      tasks.clear();
    }

    const updated: AgentStatus = {
      ...status,
      active_tasks: tasks.size > 0 ? tasks : undefined,
      current_task: tasks.size > 0 ? pickMostRecent(tasks) : undefined,
    };
    this.state.set(agent_id, updated);
    this._emit(updated);

    // 'agent_idle' broadcast — preserved for BacklogPromotionService,
    // which subscribes to attempt a single promotion pass on each board
    // the freed agent has any role assignment on. The dispatch-queue
    // listener that used to consume this signal was removed in ticket
    // 4a6cdfd7 (focus-selector replacement); the supervisor 60s tick
    // is the canonical recovery path for missed focus rotations.
    activityEvents.emit('agent_idle', {
      agent_id,
      cleared_ticket_id: expectedTicketId,
      remaining_active_count: tasks.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * D-53/D-54: Periodic reconciliation against Agent.last_seen_at (which MCP
   * `ping` tool updates every 30s). Any agent with last_seen_at older than
   * OFFLINE_THRESHOLD_MS is considered offline. On state change, emit and
   * persist is_online=0 to the DB so admin views stay consistent.
   */
  private async _sweep(): Promise<void> {
    const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    const staleTaskCutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    const agents = await this.agentRepo.find();
    for (const a of agents) {
      const prev = this.state.get(a.id);
      const is_online = !!(a.last_seen_at && a.last_seen_at > threshold);

      // Stale-task auto-clear: covers plugin crashes that skipped
      // clearCurrentTask. Never blocks legitimate long work — sweep just
      // forgets the badge after CURRENT_TASK_STALE_MS, the next setCurrentTask
      // re-establishes it. With multi-task tracking we filter the Map and
      // keep entries newer than the cutoff (offline agents drop everything).
      let nextTasks: Map<string, ActiveTask> | undefined;
      if (is_online && prev?.active_tasks) {
        const kept = new Map<string, ActiveTask>();
        for (const [tid, t] of prev.active_tasks) {
          if (t.claimed_at >= staleTaskCutoff) kept.set(tid, t);
        }
        if (kept.size > 0) nextTasks = kept;
      }
      const next_current_task = nextTasks ? pickMostRecent(nextTasks) : undefined;

      const prevLastSeenMs = prev?.last_seen_at?.getTime();
      const nextLastSeenMs = a.last_seen_at?.getTime();
      const prevTaskCount = prev?.active_tasks?.size ?? 0;
      const nextTaskCount = nextTasks?.size ?? 0;
      const tasksChanged = prevTaskCount !== nextTaskCount;
      const stateChanged =
        !prev ||
        prev.is_online !== is_online ||
        prevLastSeenMs !== nextLastSeenMs ||
        tasksChanged;
      if (!stateChanged) continue;

      const updated: AgentStatus = {
        agent_id: a.id,
        is_online,
        last_seen_at: a.last_seen_at,
        active_tasks: nextTasks,
        current_task: next_current_task,
      };
      this.state.set(a.id, updated);
      this._emit(updated);

      // v0.41 — sweep-driven idle signal. If active_tasks shrank as a
      // result of stale-task cleanup (plugin crashed before clearing),
      // surface the same 'agent_idle' event so the dispatch queue gets
      // a chance to drain its head item. Same contract as the
      // clearCurrentTask path; only the trigger differs.
      if (is_online && tasksChanged && nextTaskCount < prevTaskCount) {
        activityEvents.emit('agent_idle', {
          agent_id: a.id,
          cleared_ticket_id: undefined,
          remaining_active_count: nextTaskCount,
          timestamp: new Date().toISOString(),
        });
      }

      // D-54: persist is_online flip when crossing from online → offline.
      // We only write when it actually changed to avoid write amplification.
      if (!is_online && a.is_online === 1) {
        await this.agentRepo.update(a.id, { is_online: 0 });
      }
    }
  }
}

// Pick the most-recently-claimed entry from a non-empty active_tasks map.
// Used to derive the wire-facing `current_task` (singular) so the existing
// dashboard doesn't need to learn about the multi-task internal shape.
function pickMostRecent(tasks: Map<string, ActiveTask>): ActiveTask | undefined {
  let best: ActiveTask | undefined;
  for (const t of tasks.values()) {
    if (!best || t.claimed_at > best.claimed_at) best = t;
  }
  return best;
}
