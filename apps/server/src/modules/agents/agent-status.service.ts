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
interface AgentStatus {
  agent_id: string;
  is_online: boolean;
  last_seen_at: Date | null;
  current_task?: {
    ticket_id: string;
    ticket_title: string;
    claimed_at: Date;
    // Role slug the subagent was spawned for (assignee/reporter/reviewer
    // or a workspace-custom slug). Optional because pre-v0.34 plugins do
    // not pin a role; the dashboard renders without it when undefined.
    role?: string;
  };
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
    const updated: AgentStatus = {
      ...existing,
      is_online: true,
      last_seen_at: new Date(),
      current_task: {
        ticket_id,
        ticket_title: ticket?.title ?? '(unknown ticket)',
        claimed_at: new Date(),
        role: role || undefined,
      },
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
    if (!status?.current_task) return;
    if (expectedTicketId && status.current_task.ticket_id !== expectedTicketId) return;

    const updated: AgentStatus = { ...status, current_task: undefined };
    this.state.set(agent_id, updated);
    this._emit(updated);
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

      // Stale current_task auto-clear: covers plugin crashes that skipped
      // clearCurrentTask. Never blocks legitimate long work — sweep just
      // forgets the badge after CURRENT_TASK_STALE_MS, the next setCurrentTask
      // re-establishes it.
      const taskIsStale = !!prev?.current_task && prev.current_task.claimed_at < staleTaskCutoff;
      const next_current_task = !is_online || taskIsStale ? undefined : prev?.current_task;

      const prevLastSeenMs = prev?.last_seen_at?.getTime();
      const nextLastSeenMs = a.last_seen_at?.getTime();
      const taskChanged = !!prev?.current_task && next_current_task === undefined;
      const stateChanged =
        !prev || prev.is_online !== is_online || prevLastSeenMs !== nextLastSeenMs || taskChanged;
      if (!stateChanged) continue;

      const updated: AgentStatus = {
        agent_id: a.id,
        is_online,
        last_seen_at: a.last_seen_at,
        current_task: next_current_task,
      };
      this.state.set(a.id, updated);
      this._emit(updated);

      // D-54: persist is_online flip when crossing from online → offline.
      // We only write when it actually changed to avoid write amplification.
      if (!is_online && a.is_online === 1) {
        await this.agentRepo.update(a.id, { is_online: 0 });
      }
    }
  }
}
