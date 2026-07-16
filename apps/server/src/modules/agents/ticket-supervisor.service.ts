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
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { StuckTicketAlert } from '../../entities/StuckTicketAlert';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import {
  AgentStatusService,
  OUTPUT_LIVENESS_TTL_FLOOR_MS,
  OUTPUT_LIVENESS_TTL_CEILING_MS,
  CURRENT_TASK_STALE_MS,
} from './agent-status.service';
import { AllocationService, AllocatedTicketRow } from './allocation.service';
import { TriggerLoopService } from './trigger-loop.service';
import {
  DEFAULT_SUPERVISOR_STALE_MS,
  DEFAULT_SUPERVISOR_RESEND_MS,
  SUPERVISOR_STALE_MS_SANE_MAX,
  resolveSupervisorLivenessFloorMs,
  resolveFirstPushThresholdMs,
  classifySupervisorStaleMs,
} from '../../common/supervisor-liveness';

// Minimum resend cadence for tickets flagged as stuck (ticket b55e4421).
// Prevents force_respawn spam on BLOCKED tickets that the stuck detector
// has already identified — each respawn writes a redundant heartbeat
// comment and wastes LLM budget for zero output.
const STUCK_TICKET_MIN_RESEND_MS = 60 * 60_000; // 1 hour

// Circuit-breaker cap (ticket fdc69c13). A genuinely silent (no output-
// liveness AND no ticket-write) session is force_respawned on each resend tick.
// If that recovery still hasn't worked after this many CONSECUTIVE
// force_respawns (no my_last_update_at progress in between), stop forcing and
// raise a grepable flag — respawning a truly unrecoverable ticket forever just
// burns budget. Resets the instant the ticket makes progress (state entry
// dropped) or the session shows fresh output-liveness.
const SUPERVISOR_FORCE_RESPAWN_MAX = 5;

const SUPERVISOR_TICK_MS = 60_000;
// Defaults — overridable per Workspace via Workspace.supervisor_stale_ms /
// Workspace.supervisor_resend_ms (v0.41 makes these runtime settings).
// The constants live here only as the in-code fallback for workspaces
// whose row hasn't been backfilled yet, or when a settings lookup errors.
// DEFAULT_SUPERVISOR_STALE_MS and DEFAULT_SUPERVISOR_RESEND_MS are imported from
// common/supervisor-liveness so the sane-max classification, this tick fallback,
// and the cadence diagnostic all share one source of truth.
// Fast liveness-based re-dispatch floor (ticket 1fcba693). Resolved once at
// module load (honors the SUPERVISOR_LIVENESS_FLOOR_MS env override). Caps the
// FIRST-re-push threshold for a stale allocation nobody is working (no live
// strand AND no recent output), so a dead / killed / never-spawned strand is
// re-dispatched in minutes instead of waiting the full — operator-tunable,
// historically mis-set to 4 h — stale window. Present-but-quiet strands are
// untouched (they keep the full stale window + output-liveness gate).
const SUPERVISOR_LIVENESS_FLOOR_MS = resolveSupervisorLivenessFloorMs();
// Match AgentStatusService.OFFLINE_THRESHOLD_MS. Agents whose last_seen_at is
// older than this are considered offline and skipped — no point pushing
// triggers to a proxy that isn't listening.
const ONLINE_THRESHOLD_MS = 90_000;

interface SupervisorEntry {
  lastEmitAt: number;
  // Consecutive force_respawns emitted for this key with no ticket-write
  // progress in between (ticket fdc69c13). Drives the circuit-breaker; reset to
  // 0 when the ticket advances (entry deleted) or the session shows fresh
  // output-liveness.
  forceCount: number;
  // Latched once the circuit-breaker trips so the grepable flag is written
  // exactly once per stuck episode, not on every resend tick.
  circuitOpen: boolean;
}

/**
 * Pure force_respawn decision (ticket fdc69c13) — extracted so the suppression
 * + circuit-breaker logic can be unit-tested deterministically without booting
 * the supervisor / DataSource (mirrors the decideRunFreshness pattern). Given
 * the current signals for a stale (agent, ticket, role):
 *   - isStuck         → stuck detector already flagged it (existing throttle)
 *   - hasRecentOutput → agent-manager reported fresh output-liveness
 *   - forceCount      → consecutive force_respawns so far with no progress
 *   - maxForce        → circuit-breaker cap (SUPERVISOR_FORCE_RESPAWN_MAX)
 * Returns whether to force this tick, whether the breaker just tripped, and
 * whether the caller should reset the breaker counter (the session recovered).
 */
export function decideForceRespawn(opts: {
  isStuck: boolean;
  hasRecentOutput: boolean;
  forceCount: number;
  maxForce: number;
}): { forceRespawn: boolean; circuitOpen: boolean; resetBreaker: boolean } {
  // Live worker (fresh output) or stuck-flagged ticket → never force. Fresh
  // output also means the session recovered, so clear any prior breaker count.
  if (opts.isStuck || opts.hasRecentOutput) {
    return { forceRespawn: false, circuitOpen: false, resetBreaker: opts.hasRecentOutput };
  }
  // Genuinely silent AND the force budget is spent → give up forcing and raise
  // the circuit-breaker flag.
  if (opts.forceCount >= opts.maxForce) {
    return { forceRespawn: false, circuitOpen: true, resetBreaker: false };
  }
  // Genuinely silent, budget remains → force_respawn (the legitimate recovery).
  return { forceRespawn: true, circuitOpen: false, resetBreaker: false };
}

@Injectable()
export class TicketSupervisorService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, SupervisorEntry>();
  // Workspaces whose supervisor_stale_ms currently exceeds the output-liveness
  // retention FLOOR (ticket 47a72129). Drives a once-per-workspace warn (no log
  // spam across ticks) and an observability gauge — the "silent neutering must
  // be observable" DoD. Membership == currently-misconfigured set: added on
  // detection, removed when the value drops back within the floor.
  private readonly staleMsExceedsTtlWorkspaces = new Set<string>();
  // Workspaces whose supervisor_stale_ms exceeds the sane-max (ticket 1fcba693)
  // — 4× the default. Catches values that sit BELOW the 6 h retention floor and
  // so never trip staleMsExceedsTtlWorkspaces, yet are far larger than any
  // reasonable cadence (the incident's 4 h value). Drives a once-per-workspace
  // warn + the ticketSupervisor.staleMsElevated gauge so a mis-set / units-bug /
  // stale-band-aid value is observable in /api/diagnostics/memory.
  private readonly staleMsElevatedWorkspaces = new Set<string>();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly allocationService: AllocationService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly agentStatus: AgentStatusService,
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    // Size gauge for /api/diagnostics/memory + the [Memory] watchdog row.
    // At rest this tracks the count of live (agent, ticket, role) supervisor
    // pairs; a persistent climb is the signal that key eviction regressed
    // (e.g. sustained per-agent allocation errors orphaning entries — the leak
    // this ticket closes).
    metrics.register('ticketSupervisor.state', () => this.state.size);
    // Observability for the staleMs > retention-floor regime (ticket 47a72129).
    // Non-zero means at least one workspace set supervisor_stale_ms above the
    // output-liveness base TTL — retention auto-extends to match, but an operator
    // should know the window grew (and, past the CEILING, that the gate is
    // capped). Pairs with the once-per-workspace warn in resolveCadence.
    metrics.register('ticketSupervisor.staleMsExceedsTtl', () => this.staleMsExceedsTtlWorkspaces.size);
    // Elevated-stale gauge (ticket 1fcba693). Non-zero means at least one
    // workspace carries a supervisor_stale_ms above the sane-max (4× default) —
    // the observable surface for "why is recovery paced so slowly". Pairs with
    // the once-per-workspace warn in resolveCadence.
    metrics.register('ticketSupervisor.staleMsElevated', () => this.staleMsElevatedWorkspaces.size);
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

  /**
   * Surface a supervisor_stale_ms that exceeds the output-liveness retention
   * FLOOR (ticket 47a72129) — the "no silent neutering" DoD. Below the CEILING
   * this is informational (retention auto-extends so the gate still honors the
   * full stale window); above the CEILING it is actionable (retention is capped
   * at the ceiling, so a worker output-silent past the ceiling but within the
   * stale window can be force_respawned). Warns at most once per workspace per
   * episode; clears when the value drops back within the floor so a later
   * re-misconfiguration re-warns. Also feeds the ticketSupervisor.staleMsExceedsTtl
   * gauge.
   */
  private _observeStaleMsVsTtl(workspaceId: string, staleMs: number): void {
    if (staleMs > OUTPUT_LIVENESS_TTL_FLOOR_MS) {
      if (!this.staleMsExceedsTtlWorkspaces.has(workspaceId)) {
        this.staleMsExceedsTtlWorkspaces.add(workspaceId);
        const beyondCeiling = staleMs > OUTPUT_LIVENESS_TTL_CEILING_MS;
        this.logService.warn(
          'TicketSupervisor',
          beyondCeiling
            ? 'supervisor_stale_ms exceeds the output-liveness retention CEILING — force-suppression gate is capped at the ceiling; a worker output-silent past the ceiling (but within the stale window) may be force_respawned'
            : 'supervisor_stale_ms exceeds the output-liveness base TTL — output-liveness retention auto-extends to match (gate still honors the full stale window); verify the large stale window is intended',
          {
            workspace_id: workspaceId,
            supervisor_stale_ms: staleMs,
            output_liveness_ttl_floor_ms: OUTPUT_LIVENESS_TTL_FLOOR_MS,
            output_liveness_ttl_ceiling_ms: OUTPUT_LIVENESS_TTL_CEILING_MS,
          },
        );
      }
    } else {
      this.staleMsExceedsTtlWorkspaces.delete(workspaceId);
    }

    // Sane-max flag (ticket 1fcba693). Independent of the floor/ceiling logic
    // above: a value can sit BELOW the 6 h retention floor yet still be far
    // above any reasonable cadence (the 4 h incident band-aid). Classify →
    // once-per-workspace warn + gauge so it is observable at the source.
    const { elevated } = classifySupervisorStaleMs(staleMs);
    if (elevated) {
      if (!this.staleMsElevatedWorkspaces.has(workspaceId)) {
        this.staleMsElevatedWorkspaces.add(workspaceId);
        this.logService.warn(
          'TicketSupervisor',
          'supervisor_stale_ms is far above the default — stalled-ticket recovery for a PRESENT-but-wedged strand is paced off this window; verify it is intentional (not a units bug or a stale incident band-aid). Dead/absent strands are unaffected (fast liveness floor).',
          {
            workspace_id: workspaceId,
            supervisor_stale_ms: staleMs,
            default_supervisor_stale_ms: DEFAULT_SUPERVISOR_STALE_MS,
            sane_max_ms: SUPERVISOR_STALE_MS_SANE_MAX,
            liveness_floor_ms: SUPERVISOR_LIVENESS_FLOOR_MS,
          },
        );
      }
    } else {
      this.staleMsElevatedWorkspaces.delete(workspaceId);
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
      // Observe the staleMs > output-liveness retention regime (ticket 47a72129).
      // Warn once per workspace per misconfiguration episode — not every tick.
      this._observeStaleMsVsTtl(workspaceId, staleMs);
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

        // Stuck-ticket throttle (ticket b55e4421): if the stuck detector
        // has already flagged this ticket, suppress force_respawn and
        // extend the resend cadence to STUCK_TICKET_MIN_RESEND_MS. Each
        // force_respawn on a BLOCKED ticket just writes a redundant
        // heartbeat comment — pure waste.
        const isStuck = stuckTicketIds.has(row.ticket_id);
        const effectiveResendMs = isStuck
          ? Math.max(resendMs, STUCK_TICKET_MIN_RESEND_MS)
          : resendMs;

        // Output-liveness gate (ticket fdc69c13). my_last_update_at only sees
        // ticket WRITES; a subagent can spend 30+ min exploring/editing code —
        // actively emitting tokens — without touching the ticket. agent-manager
        // reports per-(agent,ticket,role) output to AgentStatusService; if that
        // output is fresh (within the same stale window) the worker is alive and
        // must NOT be force_respawned — killing it is the exit-143 deathloop
        // this ticket fixes. (A non-force re-push still fires below: harmless —
        // the in-flight strand gate drops it for a live strand, and it wakes a
        // truly idle-but-finished session to move its ticket.)
        // Clamp the gate window to what AgentStatusService actually retains
        // (ticket 47a72129). The raw window is staleMs, but if staleMs exceeds
        // the retention TTL an entry in the (TTL, staleMs) band is already
        // evicted → getOutputLivenessAt undefined → a live worker looks silent →
        // force_respawned (exit-143 deathloop, silently regressed). Retention is
        // derived to be >= staleMs up to a ceiling, so in the normal and
        // moderately-raised range this equals staleMs (the operator's full
        // escalation window is honored); only a pathological staleMs past the
        // ceiling caps it. Enforces the `gate-window <= retention` invariant
        // directly, independent of the derivation's freshness.
        const gateWindowMs = Math.min(staleMs, this.agentStatus.getOutputLivenessTtlMs());
        const lastOutputMs = this.agentStatus.getOutputLivenessAt(agent.id, row.ticket_id, row.role);
        const hasRecentOutput = lastOutputMs !== undefined && (now - lastOutputMs) < gateWindowMs;

        // Fast liveness-based re-dispatch floor (ticket 1fcba693). A stale
        // allocation with NO live strand (current_task absent / TTL-expired)
        // AND NO recent output-liveness is one NOBODY is working — its strand
        // died / was killed on a manager restart (exit 143) / never spawned, and
        // nothing re-fires its column (the edge-trigger was already consumed).
        // For such a ticket the FIRST re-push fires after the short liveness
        // floor (SUPERVISOR_LIVENESS_FLOOR_MS) instead of the full stale window
        // (up to 4 h on a mis-set workspace — the incident this ticket fixes).
        // It is still the ordinary non-force nudge and funnels through the
        // server's in-flight-strand gate (_emitTrigger drops it when
        // hasLiveRoleStrand is true) AND, downstream, the agent-manager's
        // provision-spanning single-flight (one session per ticket:role:agent
        // key). So if a strand IS live (or mid-provision) the nudge is dropped
        // by one of those two layers — no double-spawn, no respawn storm, no
        // branch collision. A PRESENT / producing strand (hasLiveStrand ||
        // hasRecentOutput) and a stuck-flagged ticket keep the full stale
        // window, so the exit-143 deathloop fix and the stuck-detector throttle
        // are untouched.
        const hasLiveStrand = this.agentStatus.hasLiveRoleStrand(agent.id, row.ticket_id, row.role);
        const absentStrand = !hasLiveStrand && !hasRecentOutput;
        const firstPushThresholdMs = resolveFirstPushThresholdMs({
          staleMs,
          livenessFloorMs: SUPERVISOR_LIVENESS_FLOOR_MS,
          absentStrand,
          isStuck,
        });

        if (stalenessMs < firstPushThresholdMs) {
          this.state.delete(key);
          continue;
        }

        const entry = this.state.get(key);

        if (!entry) {
          // Atomic dead-strand slot reclaim (ticket 1fcba693). This is the FIRST
          // re-push of a stale allocation NOBODY is working. Before nudging,
          // reclaim the seat the dead strand leaked — the agent-manager is meant
          // to clear_current_task + release_ticket on exit, but a SIGTERM
          // self-update (no drain), a respawn child (no release listener), or a
          // reap-without-exit can skip it, stranding current_task ≤15 min and the
          // claim ≤30 min. Reclaiming here makes active-count / the claim correct
          // at re-dispatch instead of waiting a sweep. Successor-safe: a live
          // strand that grabbed the seat is never evicted. present/producing
          // strands never reach here (absentStrand=false → full stale window).
          if (absentStrand) {
            await this._reclaimStaleSlot(row.ticket_id, agent.id, now);
          }
          // First re-push after crossing the stale threshold is ALWAYS non-force
          // (a gentle nudge), regardless of output-liveness. Escalation to force
          // only happens on later ticks if silence persists.
          await this._emit(row, agent.id, false, now);
          this.state.set(key, { lastEmitAt: now, forceCount: 0, circuitOpen: false });
          continue;
        }

        if (now - entry.lastEmitAt >= effectiveResendMs) {
          // Force is the recovery hammer for a genuinely SILENT (wedged/dead)
          // session; it is suppressed for (a) stuck-detector-flagged tickets,
          // (b) sessions with fresh output-liveness (deathloop fix), and (c)
          // sessions already force_respawned SUPERVISOR_FORCE_RESPAWN_MAX times
          // with no progress (circuit-breaker). See decideForceRespawn.
          const decision = decideForceRespawn({
            isStuck,
            hasRecentOutput,
            forceCount: entry.forceCount,
            maxForce: SUPERVISOR_FORCE_RESPAWN_MAX,
          });
          if (decision.resetBreaker) {
            entry.forceCount = 0;
            entry.circuitOpen = false;
          }
          if (decision.forceRespawn) {
            entry.forceCount += 1;
          } else if (decision.circuitOpen && !entry.circuitOpen) {
            entry.circuitOpen = true;
            await this._flagCircuitOpen(row, agent.id, entry.forceCount);
          }
          // Reclaim on the resend path too (ticket 1fcba693): a strand can die
          // AFTER its state entry was created (its own first nudge, or a nudge
          // dropped while it was briefly live), so the absent-strand seat cleanup
          // must not be exclusive to the first-push branch. Successor-safe and a
          // no-op when nothing is stale.
          if (absentStrand) {
            await this._reclaimStaleSlot(row.ticket_id, agent.id, now);
          }
          await this._emit(row, agent.id, decision.forceRespawn, now);
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

  /**
   * Atomic dead-strand slot reclaim (ticket 1fcba693). Called just before the
   * FIRST supervisor re-push of a stale allocation with NO live strand and NO
   * recent output — a ticket whose session died / was killed on a manager
   * restart (exit 143) / never spawned. Frees BOTH halves of the seat the dead
   * strand leaked so a fresh strand starts clean and observability is correct:
   *   1. current_task (in-memory, AgentStatusService): compare-and-clear the
   *      ghost entry — successor-safe, never evicts a live re-stamp.
   *   2. ticket claim (DB lock): an atomic conditional UPDATE clearing
   *      locked_by_agent_id / locked_at ONLY while still held by THIS (dead)
   *      agent AND acquired before the reclaim grace (CURRENT_TASK_STALE_MS),
   *      mirroring AgentConnectionService.sweepExpiredLocks' query-builder idiom
   *      (bypasses @VersionColumn). Tightens claim recovery from the 30-min
   *      lock-TTL sweep to the liveness window; a live successor's fresh claim
   *      (recent locked_at) is left intact.
   *
   * Recovery bound — NOT instant for a leak. This runs only once absentStrand is
   * true, and hasLiveRoleStrand keeps counting a leaked current_task as LIVE
   * until its TTL (CURRENT_TASK_STALE_MS) expires. So a REGISTRY-ABSENT seat
   * (never spawned, or manager-cleared on a clean exit / release) is reclaimed +
   * re-dispatched within the liveness floor, whereas a LEAKED current_task /
   * claim is only reclaimed after CURRENT_TASK_STALE_MS (+ up to one tick) —
   * exactly the split the cadence diagnostic's recovery_bounds_ms surfaces.
   *
   * Both steps are best-effort — a failure must not block the re-dispatch. It
   * writes NO ticket activity: a claim release is intentionally excluded from
   * my_last_update_at (allocation.service), and resetting the staleness clock
   * here would suppress the very resend cadence we depend on.
   */
  private async _reclaimStaleSlot(ticketId: string, agentId: string, now: number): Promise<void> {
    // 1. current_task ghost (in-memory).
    try {
      const cleared = this.agentStatus.reclaimStaleStrand(agentId, ticketId, CURRENT_TASK_STALE_MS);
      if (cleared) {
        this.logService.info('TicketSupervisor', 'reclaimed stale current_task at re-dispatch', {
          ticket_id: ticketId, agent_id: agentId,
        });
      }
    } catch (e) {
      this.logService.warn('TicketSupervisor', 'current_task reclaim failed (non-fatal)', {
        err: String(e), ticket_id: ticketId, agent_id: agentId,
      });
    }
    // 2. stale claim / lock (DB) — successor-safe atomic conditional UPDATE.
    try {
      const cutoff = new Date(now - CURRENT_TASK_STALE_MS);
      const res = await this.dataSource
        .getRepository(Ticket)
        .createQueryBuilder()
        .update(Ticket)
        .set({ locked_by_agent_id: null, locked_at: null })
        .where(
          'id = :ticketId AND locked_by_agent_id = :agentId AND (locked_at IS NULL OR locked_at < :cutoff)',
          { ticketId, agentId, cutoff },
        )
        .execute();
      if ((res.affected ?? 0) > 0) {
        this.logService.info('TicketSupervisor', 'released stale claim at re-dispatch', {
          ticket_id: ticketId, agent_id: agentId,
        });
      }
    } catch (e) {
      this.logService.warn('TicketSupervisor', 'stale-claim reclaim failed (non-fatal)', {
        err: String(e), ticket_id: ticketId, agent_id: agentId,
      });
    }
  }

  /**
   * Circuit-breaker flag (ticket fdc69c13). A genuinely silent session has been
   * force_respawned SUPERVISOR_FORCE_RESPAWN_MAX times with no my_last_update_at
   * progress — respawning isn't recovering it, so the caller stops forcing
   * (switches to non-force) and we write ONE grepable ActivityLog flag.
   *
   * actor_id='system' so the row does NOT re-enter TriggerLoopService.
   * _handleActivity (no self-trigger). Deliberately NOT a StuckTicketAlert row:
   * that table is owned by StuckTicketDetectorService, whose unstuck sweep would
   * delete a row that doesn't match its WAIT-loop shape. Failing the write must
   * not change the circuit-open outcome.
   */
  private async _flagCircuitOpen(
    row: AllocatedTicketRow,
    agentId: string,
    forceCount: number,
  ): Promise<void> {
    this.logService.warn(
      'TicketSupervisor',
      'force_respawn circuit-breaker OPEN — giving up force (session silent through max respawns)',
      { ticket_id: row.ticket_id, agent_id: agentId, role: row.role, force_count: forceCount },
    );
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      await activityLogRepo.save(activityLogRepo.create({
        entity_type: 'ticket',
        entity_id: row.ticket_id,
        ticket_id: row.ticket_id,
        actor_id: 'system',
        actor_name: 'TicketSupervisor',
        action: 'supervisor_force_respawn_circuit_open',
        new_value: `agent=${agentId} role=${row.role} force_count=${forceCount} reason=silent_through_max_respawns`,
        role: row.role,
        trigger_source: 'supervisor',
      }));
    } catch (e) {
      this.logService.warn('TicketSupervisor', 'circuit-open flag write failed (circuit still open)', {
        err: String(e), ticket_id: row.ticket_id,
      });
    }
  }
}
