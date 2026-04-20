// TicketSupervisorService — server-side backstop for dropped SSE agent_trigger
// deliveries and wedged subagent sessions. Replaces the plugin's former
// 5-minute get_allocated_tickets poll (ticket-poller.mjs, removed in plugin
// v0.26.0).
//
// Rule: for every (agent, ticket, role) pair where the agent holds a role on
// a non-terminal column, if my_last_update_at hasn't advanced within
// SUPERVISOR_STALE_MS (30 min), re-push the agent_trigger. On the first re-push
// (no prior emit for this key) the plugin's dispatchTrigger either spawns a
// fresh session or sends a follow-up to an existing live session. If that
// fails to restore activity, the next tick after SUPERVISOR_RESEND_MS (5 min)
// re-pushes with force_respawn=true — the plugin kills the wedged child and
// spawns a fresh one.
//
// State is in-memory only. A server restart drops the Map, which means the
// first post-restart tick may emit a "first-time" trigger for an already-stale
// ticket rather than a force_respawn — acceptable since the next tick escalates
// if the session is truly wedged.

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { AllocationService, AllocatedTicketRow } from './allocation.service';
import { TriggerLoopService } from './trigger-loop.service';

const SUPERVISOR_TICK_MS = 60_000;
const SUPERVISOR_STALE_MS = 30 * 60_000;
const SUPERVISOR_RESEND_MS = 5 * 60_000;
// Match AgentStatusService.OFFLINE_THRESHOLD_MS. Agents whose last_seen_at is
// older than this are considered offline and skipped — no point pushing
// triggers to a proxy that isn't listening.
const ONLINE_THRESHOLD_MS = 90_000;

interface SupervisorEntry {
  lastEmitAt: number;
}

@Injectable()
export class TicketSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, SupervisorEntry>();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly allocationService: AllocationService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    this.tickHandle = setInterval(() => {
      this._tick().catch((e: unknown) => {
        this.logService.error('TicketSupervisor', 'tick failed', { err: e });
      });
    }, SUPERVISOR_TICK_MS);
    this.logService.info('TicketSupervisor', 'Service initialized', {
      tick_ms: SUPERVISOR_TICK_MS, stale_ms: SUPERVISOR_STALE_MS, resend_ms: SUPERVISOR_RESEND_MS,
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private _key(agentId: string, ticketId: string, role: string): string {
    return `${agentId}:${ticketId}:${role}`;
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    const onlineCutoff = new Date(now - ONLINE_THRESHOLD_MS);

    const agents = await this.agentRepo.find();
    const liveKeys = new Set<string>();

    for (const agent of agents) {
      if (!agent.last_seen_at || agent.last_seen_at < onlineCutoff) continue;
      if (!agent.workspace_id) continue;

      const result = await this.allocationService.getAllocatedTickets(agent.id, agent.workspace_id);
      if (!Array.isArray(result)) continue;

      for (const row of result) {
        const key = this._key(agent.id, row.ticket_id, row.role);
        liveKeys.add(key);

        const lastUpdateMs = row.my_last_update_at ? Date.parse(row.my_last_update_at) : 0;
        const stalenessMs = lastUpdateMs > 0 ? (now - lastUpdateMs) : Infinity;

        if (stalenessMs < SUPERVISOR_STALE_MS) {
          this.state.delete(key);
          continue;
        }

        const entry = this.state.get(key);

        if (!entry) {
          await this._emit(row, agent.id, false, now);
          this.state.set(key, { lastEmitAt: now });
          continue;
        }

        if (now - entry.lastEmitAt >= SUPERVISOR_RESEND_MS) {
          await this._emit(row, agent.id, true, now);
          entry.lastEmitAt = now;
        }
      }
    }

    // Drop state entries for (agent, ticket, role) pairs that are no longer
    // allocated — ticket moved to a terminal column, role reassigned, agent
    // deleted, etc. Prevents the Map from growing unbounded over uptime.
    for (const key of this.state.keys()) {
      if (!liveKeys.has(key)) this.state.delete(key);
    }
  }

  private async _emit(
    row: AllocatedTicketRow,
    agentId: string,
    forceRespawn: boolean,
    now: number,
  ): Promise<void> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: row.ticket_id } });
    if (!ticket) return;

    try {
      await this.triggerLoop.emitAgentTrigger(
        ticket,
        agentId,
        row.role,
        'supervisor',
        'system',
        { forceRespawn },
      );
      this.logService.info('TicketSupervisor', 'supervisor re-push', {
        ticket_id: row.ticket_id,
        agent_id: agentId,
        role: row.role,
        force_respawn: forceRespawn,
        last_update_at: row.my_last_update_at,
      });
    } catch (e: unknown) {
      this.logService.error('TicketSupervisor', 'emit failed', {
        err: e, ticket_id: row.ticket_id, agent_id: agentId, role: row.role,
      });
    }
  }
}
