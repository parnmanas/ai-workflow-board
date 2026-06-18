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
import { StuckTicketAlert } from '../../entities/StuckTicketAlert';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import { AllocationService, AllocatedTicketRow } from './allocation.service';
import { TriggerLoopService } from './trigger-loop.service';

// Minimum resend cadence for tickets flagged as stuck (ticket b55e4421).
// Prevents force_respawn spam on BLOCKED tickets that the stuck detector
// has already identified — each respawn writes a redundant heartbeat
// comment and wastes LLM budget for zero output.
const STUCK_TICKET_MIN_RESEND_MS = 60 * 60_000; // 1 hour

const SUPERVISOR_TICK_MS = 60_000;
// Defaults — overridable per Workspace via Workspace.supervisor_stale_ms /
// Workspace.supervisor_resend_ms (v0.41 makes these runtime settings).
// The constants live here only as the in-code fallback for workspaces
// whose row hasn't been backfilled yet, or when a settings lookup errors.
const DEFAULT_SUPERVISOR_STALE_MS = 30 * 60_000;
const DEFAULT_SUPERVISOR_RESEND_MS = 5 * 60_000;
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
    metrics: MemoryMetricsRegistry,
  ) {
    // Size gauge for /api/diagnostics/memory + the [Memory] watchdog row.
    // At rest this tracks the count of live (agent, ticket, role) supervisor
    // pairs; a persistent climb is the signal that key eviction regressed
    // (e.g. sustained per-agent allocation errors orphaning entries — the leak
    // this ticket closes).
    metrics.register('ticketSupervisor.state', () => this.state.size);
  }

  onModuleInit(): void {
    this.tickHandle = setInterval(() => {
      this._tick().catch((e: unknown) => {
        this.logService.error('TicketSupervisor', 'tick failed', { err: e });
      });
    }, SUPERVISOR_TICK_MS);
    this.logService.info('TicketSupervisor', 'Service initialized', {
      tick_ms: SUPERVISOR_TICK_MS,
      default_stale_ms: DEFAULT_SUPERVISOR_STALE_MS,
      default_resend_ms: DEFAULT_SUPERVISOR_RESEND_MS,
      note: 'cadence is per-workspace (Workspace.supervisor_stale_ms / supervisor_resend_ms)',
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

  /**
   * Drop every state entry belonging to one agent (keys are
   * `${agentId}:${ticketId}:${role}`; agentId is a colon-free UUID so the
   * prefix match is unambiguous). Called when an agent's allocation lookup
   * fails this tick: such an agent contributes nothing to `liveKeys`, but the
   * end-of-tick reap only runs if the tick completes. Under sustained
   * per-agent allocation errors that agent's stale keys would otherwise never
   * be reaped — pruning here keeps the Map bounded regardless.
   */
  private _pruneAgentKeys(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of this.state.keys()) {
      if (key.startsWith(prefix)) this.state.delete(key);
    }
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    const onlineCutoff = new Date(now - ONLINE_THRESHOLD_MS);

    const agents = await this.agentRepo.find();
    const liveKeys = new Set<string>();

    // v0.41 — workspace-keyed cadence cache. Avoids re-querying the
    // Workspace row for every (agent, ticket, role) row in this tick.
    // Cadence settings change rarely; the worst-case lag of one tick
    // (60s) is acceptable for an admin tweak to propagate.
    const cadenceByWorkspace = new Map<string, { staleMs: number; resendMs: number }>();
    const resolveCadence = async (workspaceId: string): Promise<{ staleMs: number; resendMs: number }> => {
      let cadence = cadenceByWorkspace.get(workspaceId);
      if (cadence) return cadence;
      let staleMs = DEFAULT_SUPERVISOR_STALE_MS;
      let resendMs = DEFAULT_SUPERVISOR_RESEND_MS;
      try {
        const ws = await this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
        if (ws) {
          if (Number.isFinite(ws.supervisor_stale_ms) && ws.supervisor_stale_ms > 0) {
            staleMs = Math.floor(ws.supervisor_stale_ms);
          }
          if (Number.isFinite(ws.supervisor_resend_ms) && ws.supervisor_resend_ms > 0) {
            resendMs = Math.floor(ws.supervisor_resend_ms);
          }
        }
      } catch (e) {
        this.logService.warn('TicketSupervisor', 'failed to load workspace cadence — using defaults', {
          err: String(e), workspace_id: workspaceId,
        });
      }
      cadence = { staleMs, resendMs };
      cadenceByWorkspace.set(workspaceId, cadence);
      return cadence;
    };

    for (const agent of agents) {
      if (!agent.last_seen_at || agent.last_seen_at < onlineCutoff) continue;
      if (!agent.workspace_id) continue;

      // On allocation lookup failure (throw or a non-array result) this agent
      // contributes no live keys this tick. Prune its existing keys here so a
      // persistent per-agent error can't strand them — and so a throw can't
      // abort the whole tick and skip the end-of-tick reap for every agent.
      let result: AllocatedTicketRow[];
      try {
        const raw = await this.allocationService.getAllocatedTickets(agent.id, agent.workspace_id);
        if (!Array.isArray(raw)) {
          this._pruneAgentKeys(agent.id);
          continue;
        }
        result = raw;
      } catch (e) {
        this.logService.warn('TicketSupervisor', 'getAllocatedTickets failed — pruning agent keys', {
          err: String(e), agent_id: agent.id,
        });
        this._pruneAgentKeys(agent.id);
        continue;
      }

      const { staleMs, resendMs } = await resolveCadence(agent.workspace_id);

      // Pre-fetch stuck alert rows for this agent's tickets so the
      // per-row loop doesn't need N+1 queries (ticket b55e4421).
      const alertRepo = this.dataSource.getRepository(StuckTicketAlert);
      const stuckTicketIds = new Set<string>();
      try {
        const ticketIds = result.map((r: AllocatedTicketRow) => r.ticket_id).filter(Boolean);
        if (ticketIds.length > 0) {
          const alerts = await alertRepo
            .createQueryBuilder('sa')
            .where('sa.ticket_id IN (:...ids)', { ids: ticketIds })
            .getMany();
          for (const a of alerts) stuckTicketIds.add(a.ticket_id);
        }
      } catch (e) {
        this.logService.warn('TicketSupervisor', 'stuck-alert prefetch failed (continuing without)', {
          err: String(e), agent_id: agent.id,
        });
      }

      for (const row of result) {
        const key = this._key(agent.id, row.ticket_id, row.role);
        liveKeys.add(key);

        const lastUpdateMs = row.my_last_update_at ? Date.parse(row.my_last_update_at) : 0;
        const stalenessMs = lastUpdateMs > 0 ? (now - lastUpdateMs) : Infinity;

        if (stalenessMs < staleMs) {
          this.state.delete(key);
          continue;
        }

        // Stuck-ticket throttle (ticket b55e4421): if the stuck detector
        // has already flagged this ticket, suppress force_respawn and
        // extend the resend cadence to STUCK_TICKET_MIN_RESEND_MS. Each
        // force_respawn on a BLOCKED ticket just writes a redundant
        // heartbeat comment — pure waste.
        const isStuck = stuckTicketIds.has(row.ticket_id);
        const effectiveResendMs = isStuck
          ? Math.max(resendMs, STUCK_TICKET_MIN_RESEND_MS)
          : resendMs;

        const entry = this.state.get(key);

        if (!entry) {
          await this._emit(row, agent.id, false, now);
          this.state.set(key, { lastEmitAt: now });
          continue;
        }

        if (now - entry.lastEmitAt >= effectiveResendMs) {
          // Suppress force_respawn for stuck tickets — a non-force
          // re-push still lets the subagent check the gate, but
          // doesn't kill a potentially useful session.
          await this._emit(row, agent.id, isStuck ? false : true, now);
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
