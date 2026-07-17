/**
 * DispatchReconcilerService — the durable dispatch backstop sweep (ticket e7c87517).
 *
 * Runs every `DISPATCH_RECONCILER_SWEEP_MS` (default 1 min) and re-derives every
 * OWED dispatch from the `dispatch_intents` table:
 *
 *   1. RESOLVE  — close intents whose ticket made real forward progress, or
 *                 reached a terminal / parked / unstaffed / unrouted state.
 *   2. DISPATCH — re-emit any still-owed intent past its backoff deadline,
 *                 claimed via a multi-instance-safe lease CAS so two server
 *                 instances never double-spawn. Force-respawn a wedged strand
 *                 after `forceAfterAttempts`.
 *   3. SEED     — for any routed ticket sitting idle past `seedAfterMs` with a
 *                 holder but NO open intent (the trigger was lost to a crash
 *                 between commit and emit, or an SSE gap), create a durable
 *                 intent so the dispatch is recovered. This is the self-healing
 *                 net that makes the guarantee hold even when the same-tx record
 *                 at the trigger source never ran.
 *
 * Because every decision is re-derived from committed DB state, the guarantee
 * survives a process restart (the next sweep re-discovers all open intents) and
 * an SSE subscription gap, and it holds across multiple instances. Operator
 * escalation (the chat alert) is intentionally left to StuckTicketDetector's
 * no-progress path so a capacity-deferred (focus-gated) intent, which the
 * reconciler legitimately keeps retrying, does not spam the alerts room — the
 * reconciler's own escalation is an audit-only latch.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { Ticket } from '../../entities/Ticket';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { LogService } from '../../services/log.service';
import { AgentStatusService } from './agent-status.service';
import { TriggerLoopService } from './trigger-loop.service';
import {
  DispatchIntentService,
  DispatchReconcilerConfig,
  decideIntentReconcile,
  DISPATCH_RECONCILE_SOURCE,
} from './dispatch-intent.service';

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try { return JSON.parse(val || JSON.stringify(fallback)) as T; }
  catch { return fallback; }
}

interface ReconcileStats {
  scanned: number;
  resolved: number;
  dispatched: number;
  deferred: number;
  seeded: number;
  skipped_disabled: boolean;
}

@Injectable()
export class DispatchReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly config: DispatchReconcilerConfig;
  private readonly instanceId = `reconciler-${randomUUID()}`;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly intents: DispatchIntentService,
    private readonly triggerLoop: TriggerLoopService,
    private readonly agentStatus: AgentStatusService,
  ) {
    this.config = this.intents.config;
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('DispatchReconciler', 'service disabled via DISPATCH_RECONCILER_ENABLED=false', {});
      return;
    }
    this.tickHandle = setInterval(() => {
      this.reconcile().catch((e: unknown) => {
        this.logService.error('DispatchReconciler', 'sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('DispatchReconciler', 'sweep loop initialized', { config: this.config, instance: this.instanceId });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** One reconcile pass. Public so a spec can drive it deterministically. */
  async reconcile(now: Date = new Date()): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      scanned: 0, resolved: 0, dispatched: 0, deferred: 0, seeded: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;

    // ── Phase 1/2: resolve + dispatch every open intent. ──────────────────────
    const open = await this.intents.listOpen();
    for (const intent of open) {
      stats.scanned += 1;
      try {
        await this._reconcileOne(intent, now, stats);
      } catch (e) {
        this.logService.warn('DispatchReconciler', 'per-intent reconcile failed (continuing)', {
          err: String(e), intent_id: intent.id, ticket_id: intent.ticket_id,
        });
      }
    }

    // ── Phase 3: seed durable intents for routed-but-idle tickets. ────────────
    try {
      await this._seedMissingIntents(now, stats);
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'seed pass failed (continuing)', { err: String(e) });
    }

    this.logService.info('DispatchReconciler', 'sweep complete', { stats });
    return stats;
  }

  private async _reconcileOne(intent: any, now: Date, stats: ReconcileStats): Promise<void> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: intent.ticket_id } });

    // Gather the resolution inputs from committed state.
    let archived = false;
    let terminalOrUnrouted = false;
    let parked = false;
    let unstaffed = false;
    let holderAgentId = '';
    let lastProgressAtMs = 0;

    if (ticket) {
      archived = !!ticket.archived_at;
      parked = !!(ticket.pending_user_action || ticket.pending_on_tickets);
      const col = ticket.column_id
        ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
        : null;
      if (!col) {
        terminalOrUnrouted = true;
      } else {
        const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
        const roles = safeJsonParse<string[]>((col as any).role_routing, []);
        if (isTerminal || !Array.isArray(roles) || !roles.includes(intent.role)) {
          terminalOrUnrouted = true;
        }
      }
      const holders = await this._resolveHolderAgentIds(ticket.workspace_id, ticket.id, intent.role);
      holderAgentId = holders[0] || intent.agent_id || '';
      unstaffed = holders.length === 0 && !intent.agent_id;
      lastProgressAtMs = await this._latestForwardProgressMs(ticket);
    }

    const decision = decideIntentReconcile({
      nowMs: now.getTime(),
      intentCreatedAtMs: new Date(intent.created_at).getTime(),
      nextAttemptAtMs: new Date(intent.next_attempt_at).getTime(),
      ticketMissing: !ticket,
      archived,
      terminalOrUnrouted,
      parked,
      unstaffed,
      lastProgressAtMs,
    });

    if (decision.action === 'resolve') {
      await this.intents.resolve(intent, decision.reason, now);
      stats.resolved += 1;
      return;
    }
    if (decision.action === 'defer') {
      stats.deferred += 1;
      return;
    }

    // action === 'dispatch'
    if (!holderAgentId) {
      // No servable holder despite the unstaffed check passing (race) — resolve
      // rather than spin; the seeder / no-progress detector re-surface it if the
      // ticket re-acquires a holder.
      await this.intents.resolve(intent, 'unstaffed', now);
      stats.resolved += 1;
      return;
    }
    const force = intent.attempts >= this.config.forceAfterAttempts;
    const claim = await this.intents.claimForDispatch(intent, { instanceId: this.instanceId, now, force });
    if (!claim.claimed) {
      // Another instance won the lease this tick — leave it to them.
      stats.deferred += 1;
      return;
    }

    // Audit-only escalation latch (no chat — StuckTicketDetector owns operator
    // alerting so a capacity-deferred intent doesn't double-notify).
    if (intent.attempts + 1 >= this.config.escalateAfterAttempts) {
      const newly = await this.intents.markEscalated(intent.id, now);
      if (newly) {
        await this._writeAudit(ticket, intent, 'dispatch_intent_escalated', {
          attempts: intent.attempts + 1,
          reason: intent.last_reason || 'repeated_redispatch_no_progress',
          recovery: 'reconciler keeps re-dispatching at capped backoff; verify agent online / worktree pool / focus capacity',
        });
      }
    }

    let triggerId = '';
    try {
      triggerId = await this.triggerLoop.emitAgentTrigger(
        ticket!, holderAgentId, intent.role, DISPATCH_RECONCILE_SOURCE, 'system', { forceRespawn: force },
      );
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'reconcile emit threw (intent stays open for next sweep)', {
        err: String(e), ticket_id: intent.ticket_id, role: intent.role,
      });
    }
    // Record the fresh trigger_id so a manager ack can be matched to THIS
    // dispatch (stale-ack guard). Empty triggerId means the emit was gated
    // (focus / in-flight strand / paused / pending) — the intent stays in_flight
    // and the next sweep reconsiders it; the gate itself already left an audit.
    await this.dataSource.getRepository('DispatchIntent').update(intent.id, {
      last_trigger_id: triggerId || intent.last_trigger_id || '',
      agent_id: holderAgentId,
    });
    await this._writeAudit(ticket, intent, 'dispatch_reconcile_redispatch', {
      generation: claim.generation,
      force,
      landed: !!triggerId,
      trigger_id: triggerId,
      next_attempt_at: claim.nextAttemptAt.toISOString(),
    });
    stats.dispatched += 1;
  }

  /**
   * Seed durable intents for routed tickets sitting idle with a holder but no
   * open intent (ticket e7c87517). Scans the same candidate set as the stuck
   * detector (active/intake columns, not archived). A ticket that has made
   * forward progress within `seedAfterMs`, is parked, or already has an open
   * intent for the role is skipped.
   */
  private async _seedMissingIntents(now: Date, stats: ReconcileStats): Promise<void> {
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const candidateCols = await colRepo
      .createQueryBuilder('c')
      .where('c.kind IN (:...kinds)', { kinds: ['active', 'intake'] })
      .getMany();
    if (candidateCols.length === 0) return;
    const colById = new Map(candidateCols.map(c => [c.id, c]));
    const colIds = candidateCols.map(c => c.id);

    const tickets = await this.dataSource.getRepository(Ticket)
      .createQueryBuilder('t')
      .where('t.column_id IN (:...colIds)', { colIds })
      .andWhere('t.archived_at IS NULL')
      .getMany();

    for (const ticket of tickets) {
      if (ticket.pending_user_action || ticket.pending_on_tickets) continue;
      const col = colById.get(ticket.column_id as string);
      if (!col) continue;
      const roles = safeJsonParse<string[]>((col as any).role_routing, []);
      if (!Array.isArray(roles) || roles.length === 0) continue;

      const lastProgressMs = await this._latestForwardProgressMs(ticket);
      // Idle only: recently-progressed / just-dispatched tickets are being
      // served — no seed. Baseline is created_at (immutable), never updated_at.
      const idleMs = now.getTime() - Math.max(lastProgressMs, new Date(ticket.created_at).getTime());
      if (idleMs < this.config.seedAfterMs) continue;

      for (const role of roles) {
        const existing = await this.intents.findOpenForTicketRole(ticket.id, role);
        if (existing) continue;
        const holders = await this._resolveHolderAgentIds(ticket.workspace_id, ticket.id, role);
        if (holders.length === 0) continue; // unstaffed → no dispatch owed
        await this.intents.createSeed({
          workspaceId: ticket.workspace_id,
          boardId: col.board_id,
          ticketId: ticket.id,
          role,
          agentId: holders[0],
        });
        await this._writeAudit(ticket, { id: '', ticket_id: ticket.id, role, workspace_id: ticket.workspace_id, agent_id: holders[0], attempts: 0 } as any, 'dispatch_intent_seeded', {
          idle_ms: Math.round(idleMs),
          reason: 'routed_ticket_idle_no_open_intent',
          recovery: 'reconciler will dispatch this seeded intent on the next pass',
        });
        stats.seeded += 1;
      }
    }
  }

  /**
   * Agent holders of `slug` on a ticket, earliest-first, managers excluded —
   * mirrors TriggerLoopService._resolveRoleHolders so the reconciler agrees with
   * the organic dispatch path on who is servable.
   */
  private async _resolveHolderAgentIds(workspaceId: string, ticketId: string, slug: string): Promise<string[]> {
    const role = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: workspaceId, slug },
    });
    if (!role) return [];
    const rows = await this.dataSource.getRepository(TicketRoleAssignment).find({
      where: { ticket_id: ticketId, role_id: role.id },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const r of rows) {
      if (r.agent_id && !seen.has(r.agent_id)) { seen.add(r.agent_id); ids.push(r.agent_id); }
    }
    if (ids.length === 0) return [];
    const managers = await this.dataSource.getRepository(Agent).find({
      where: { id: In(ids), type: 'manager' }, select: ['id'],
    });
    if (managers.length === 0) return ids;
    const mgr = new Set(managers.map(a => a.id));
    return ids.filter(id => !mgr.has(id));
  }

  /**
   * Newest EXPLICIT forward-progress signal for a ticket (ticket e7c87517),
   * in epoch ms: the latest real (non-system) comment, the latest lifecycle
   * activity (column move / claim / release), and the latest output-liveness
   * across any strand on the ticket. Deliberately EXCLUDES ticket.updated_at —
   * a label/assignee/metadata edit is not forward progress (reviewer blocker #5).
   * Returns 0 when nothing has advanced the ticket.
   *
   * Uses ENTITY reads (findOne + order), not a raw `MAX(created_at)` aggregate,
   * on purpose: TypeORM hydrates a `@CreateDateColumn` to a TZ-correct Date on
   * every backend, whereas a raw sql.js aggregate hands back a naive
   * "YYYY-MM-DD HH:MM:SS" string that `new Date()` reparses in LOCAL time —
   * shifting a comment's timestamp under a non-UTC dev TZ and silently
   * mis-deciding `progressed`. The `progressed` comparison against the intent's
   * own (entity-hydrated) created_at must use the same clock.
   */
  private async _latestForwardProgressMs(ticket: Ticket): Promise<number> {
    const latestComment = await this.dataSource.getRepository(Comment).findOne({
      where: { ticket_id: ticket.id, type: Not('system') },
      order: { created_at: 'DESC' },
      select: ['id', 'created_at'],
    });
    const commentMs = latestComment?.created_at ? new Date(latestComment.created_at).getTime() : 0;

    const latestLifecycle = await this.dataSource.getRepository(ActivityLog).findOne({
      where: [
        { ticket_id: ticket.id, action: 'moved', field_changed: 'column' },
        { ticket_id: ticket.id, action: 'updated', field_changed: 'locked_by_agent_id' },
      ],
      order: { created_at: 'DESC' },
      select: ['id', 'created_at'],
    });
    const lifecycleMs = latestLifecycle?.created_at ? new Date(latestLifecycle.created_at).getTime() : 0;

    const outputMs = this.agentStatus?.getLatestOutputLivenessForTicket?.(ticket.id) ?? 0;

    return Math.max(commentMs, lifecycleMs, outputMs);
  }

  private async _writeAudit(ticket: Ticket | null, intent: any, action: string, extra: Record<string, unknown>): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      await repo.save(repo.create({
        workspace_id: (ticket?.workspace_id || intent.workspace_id) ?? '',
        entity_type: 'ticket',
        entity_id: intent.ticket_id,
        action,
        field_changed: 'dispatch_intent',
        old_value: '',
        new_value: JSON.stringify({ intent_id: intent.id, role: intent.role, agent_id: intent.agent_id, ...extra }),
        actor_id: 'system',
        actor_name: 'DispatchReconciler',
        ticket_id: intent.ticket_id,
        role: intent.role,
        trigger_source: 'dispatch_reconcile',
      }));
    } catch (e) {
      this.logService.warn('DispatchReconciler', 'audit write failed (continuing)', {
        err: String(e), ticket_id: intent.ticket_id, action,
      });
    }
  }
}

// TypeORM `In` / `Not` imported lazily to keep the holder + progress queries readable.
import { In, Not } from 'typeorm';
