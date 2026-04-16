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
import { ActivityLog } from '../../entities/ActivityLog';
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
  };
}

const SWEEP_INTERVAL_MS = 30_000;
const OFFLINE_THRESHOLD_MS = 90_000;

// D-39: "done" column detection uses a case-insensitive whitelist of common
// terminal column names. ActivityLog records every column move with
// action='moved' and the destination name in new_value (see
// trigger-loop.service.ts:87), so we match against new_value, not a sentinel action.
const DONE_COLUMN_NAMES = new Set(['done', 'complete', 'completed', 'closed']);

function isDoneColumn(name: string | null | undefined): boolean {
  if (!name) return false;
  return DONE_COLUMN_NAMES.has(name.toLowerCase().trim());
}

@Injectable()
export class AgentStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, AgentStatus>();
  private sweepHandle: NodeJS.Timeout | null = null;
  private readonly triggerListener: (event: any) => void;
  private readonly activityListener: (log: ActivityLog) => void;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {
    // Arrow wrappers catch promise rejections so a single bad event cannot
    // crash the Node process or tear down the EventEmitter listener chain.
    this.triggerListener = (event) => {
      this._onAgentTrigger(event).catch((e: unknown) => {
        this.logService.error('AgentStatus', 'triggerListener failed', { err: e });
      });
    };
    this.activityListener = (log) => {
      this._onActivity(log).catch((e: unknown) => {
        this.logService.error('AgentStatus', 'activityListener failed', { err: e });
      });
    };
  }

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

    activityEvents.on('agent_trigger', this.triggerListener);
    activityEvents.on('activity', this.activityListener);

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
    activityEvents.removeListener('agent_trigger', this.triggerListener);
    activityEvents.removeListener('activity', this.activityListener);
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
   * D-39: When an agent is triggered on a ticket, record it as their current_task
   * with a fresh title lookup. Also stamps is_online=true and last_seen_at=now
   * because the agent demonstrably has an active identity at this moment.
   */
  private async _onAgentTrigger(event: any): Promise<void> {
    const agent_id = event?.agent_id;
    const ticket_id = event?.ticket_id;
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
      },
    };
    this.state.set(agent_id, updated);
    this._emit(updated);
  }

  /**
   * D-39: When any activity log is emitted, check if it's a ticket move into a
   * "done" column for an agent whose current_task is that ticket. If so, clear.
   */
  private async _onActivity(log: ActivityLog): Promise<void> {
    if (!log) return;
    if (log.action !== 'moved' || !log.actor_id || !log.ticket_id) return;
    if (!isDoneColumn(log.new_value)) return;

    const status = this.state.get(log.actor_id);
    if (!status?.current_task || status.current_task.ticket_id !== log.ticket_id) return;

    const updated: AgentStatus = { ...status, current_task: undefined };
    this.state.set(log.actor_id, updated);
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
    const agents = await this.agentRepo.find();
    for (const a of agents) {
      const prev = this.state.get(a.id);
      const is_online = !!(a.last_seen_at && a.last_seen_at > threshold);

      const prevLastSeenMs = prev?.last_seen_at?.getTime();
      const nextLastSeenMs = a.last_seen_at?.getTime();
      const stateChanged =
        !prev || prev.is_online !== is_online || prevLastSeenMs !== nextLastSeenMs;
      if (!stateChanged) continue;

      const updated: AgentStatus = {
        agent_id: a.id,
        is_online,
        last_seen_at: a.last_seen_at,
        // Clear current_task on offline transition; preserve across same-online sweeps.
        current_task: is_online ? prev?.current_task : undefined,
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
