/**
 * DispatchIntentService — durable dispatch outbox state machine (ticket e7c87517).
 *
 * This service owns the `dispatch_intents` table: it records an intent whenever
 * a trigger is attempted (from the single `TriggerLoopService._emitTrigger`
 * chokepoint every source funnels through), applies manager ack/nack, and
 * exposes the pure decision helpers + queries the DispatchReconcilerService
 * drives its sweep with. It deliberately depends ONLY on the DataSource (no
 * TriggerLoopService) so TriggerLoopService can depend on IT with no DI cycle —
 * the reconciler is the side that owns the emit callback.
 *
 * The rationale, state machine, and invariants live on the DispatchIntent
 * entity. The one load-bearing rule restated here because it is the crux the
 * reviewer flagged: a manager `processed` ack (spawn started) is NOT resolution
 * — it only defers the retry deadline. Only observed forward progress (or a
 * terminal / parked / unstaffed ticket) resolves an intent.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { DispatchIntent } from '../../entities/DispatchIntent';
import { ActivityLog } from '../../entities/ActivityLog';
import { LogService } from '../../services/log.service';

export const DISPATCH_INTENT_STATUS = {
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  RESOLVED: 'resolved',
} as const;

// The trigger_source the reconciler stamps on its OWN re-dispatch. Shared so
// TriggerLoopService._emitTrigger can recognise a reconciler-originated emit and
// skip re-recording the intent (the reconciler already owns that row's lifecycle
// via claimForDispatch — re-recording would double-count attempts / drop the
// lease). Ticket e7c87517.
export const DISPATCH_RECONCILE_SOURCE = 'dispatch_reconcile';

export interface DispatchReconcilerConfig {
  enabled: boolean;
  sweepMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  processingGraceMs: number;
  seedAfterMs: number;
  escalateAfterAttempts: number;
  forceAfterAttempts: number;
  leaseMs: number;
}

// Bounds so a fat-fingered env can never disable the "no 24h silent stall"
// guarantee or spin a tight retry loop. The sweep + max backoff must stay well
// under 24h; the base backoff must stay above a sane floor so a permanently
// ungateable intent can't hot-loop.
const SWEEP_FLOOR_MS = 15_000;             // 15s
const SWEEP_CEILING_MS = 5 * 60_000;       // 5 min — << 24h guarantee
const BASE_BACKOFF_FLOOR_MS = 10_000;      // 10s
const MAX_BACKOFF_CEILING_MS = 30 * 60_000; // 30 min — capped so no starvation

export const DISPATCH_RECONCILER_DEFAULTS: DispatchReconcilerConfig = {
  enabled: true,
  sweepMs: 60_000,               // 1 min — guaranteed resend cadence
  baseBackoffMs: 60_000,         // 1 min first retry
  maxBackoffMs: 15 * 60_000,     // 15 min cap
  processingGraceMs: 5 * 60_000, // 5 min for a spawned strand to show progress
  seedAfterMs: 3 * 60_000,       // 3 min routed-but-idle → seed a durable intent
  escalateAfterAttempts: 3,      // alert operator after 3 fruitless re-dispatches
  forceAfterAttempts: 4,         // force_respawn a wedged strand after 4
  leaseMs: 2 * 60_000,           // 2 min reconcile lease
};

/**
 * Capped exponential backoff for the Nth dispatch attempt (ticket e7c87517).
 * attempts=1 → base, doubling each attempt, hard-capped at maxBackoffMs so a
 * long-running stall re-checks at a bounded cadence (no starvation, no tight
 * loop). Extracted pure so the backoff schedule is unit-testable.
 */
export function dispatchBackoffMs(attempts: number, cfg: Pick<DispatchReconcilerConfig, 'baseBackoffMs' | 'maxBackoffMs'>): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2^(n-1) without Math.pow overflow surprises for large n.
  const factor = n >= 31 ? Number.MAX_SAFE_INTEGER : 2 ** (n - 1);
  const raw = cfg.baseBackoffMs * factor;
  return Math.min(cfg.maxBackoffMs, Math.max(cfg.baseBackoffMs, raw));
}

export type IntentReconcileAction = 'resolve' | 'dispatch' | 'defer';

/**
 * Pure reconcile decision for ONE open intent (ticket e7c87517). Extracted so
 * the resolution-precedence + backoff-gate logic is deterministically testable
 * without a DataSource (mirrors decideNoProgress / decideForceRespawn).
 *
 * Resolution precedence (first match wins) — an intent is CLOSED when there is
 * nothing left to dispatch, and only then:
 *   1. ticketMissing            — the ticket row is gone.
 *   2. archived                 — operator archived it.
 *   3. terminalOrUnrouted       — landed terminal, or its current column no
 *                                 longer routes to this role (responsibility moved).
 *   4. parked                   — pending_user_action / pending_on_tickets (a
 *                                 human/prereq gate; a fresh trigger re-records on resume).
 *   5. progressed               — forward progress (comment / move / claim /
 *                                 output-liveness) landed AFTER the intent was created.
 *   6. unstaffed                — the routed role has no agent holder to serve it.
 * Otherwise the intent is still OWED:
 *   - now < nextAttemptAt       → defer (backoff not elapsed).
 *   - else                      → dispatch (force decided by the caller from attempts).
 *
 * CRITICAL: `everDispatchedOk` / spawn success is intentionally NOT a resolution
 * input — spawn is not progress.
 */
export function decideIntentReconcile(opts: {
  nowMs: number;
  intentCreatedAtMs: number;
  nextAttemptAtMs: number;
  ticketMissing: boolean;
  archived: boolean;
  terminalOrUnrouted: boolean;
  parked: boolean;
  unstaffed: boolean;
  lastProgressAtMs: number;
}): { action: IntentReconcileAction; reason: string } {
  if (opts.ticketMissing) return { action: 'resolve', reason: 'ticket_deleted' };
  if (opts.archived) return { action: 'resolve', reason: 'archived' };
  if (opts.terminalOrUnrouted) return { action: 'resolve', reason: 'terminal_or_unrouted' };
  if (opts.parked) return { action: 'resolve', reason: 'parked' };
  if (opts.lastProgressAtMs > opts.intentCreatedAtMs) return { action: 'resolve', reason: 'progressed' };
  if (opts.unstaffed) return { action: 'resolve', reason: 'unstaffed' };
  if (opts.nowMs < opts.nextAttemptAtMs) return { action: 'defer', reason: 'backoff' };
  return { action: 'dispatch', reason: 'owed' };
}

function readReconcilerConfig(env: NodeJS.ProcessEnv = process.env): DispatchReconcilerConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const bool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const d = DISPATCH_RECONCILER_DEFAULTS;
  return {
    enabled: bool(env.DISPATCH_RECONCILER_ENABLED, d.enabled),
    sweepMs: clamp(num(env.DISPATCH_RECONCILER_SWEEP_MS, d.sweepMs), SWEEP_FLOOR_MS, SWEEP_CEILING_MS),
    baseBackoffMs: Math.max(BASE_BACKOFF_FLOOR_MS, num(env.DISPATCH_RECONCILER_BASE_BACKOFF_MS, d.baseBackoffMs)),
    maxBackoffMs: Math.min(MAX_BACKOFF_CEILING_MS, num(env.DISPATCH_RECONCILER_MAX_BACKOFF_MS, d.maxBackoffMs)),
    processingGraceMs: num(env.DISPATCH_RECONCILER_PROCESSING_GRACE_MS, d.processingGraceMs),
    seedAfterMs: num(env.DISPATCH_RECONCILER_SEED_AFTER_MS, d.seedAfterMs),
    escalateAfterAttempts: num(env.DISPATCH_RECONCILER_ESCALATE_AFTER, d.escalateAfterAttempts),
    forceAfterAttempts: num(env.DISPATCH_RECONCILER_FORCE_AFTER, d.forceAfterAttempts),
    leaseMs: num(env.DISPATCH_RECONCILER_LEASE_MS, d.leaseMs),
  };
}

export const __dispatch_test__ = { readReconcilerConfig, DISPATCH_RECONCILER_DEFAULTS };

@Injectable()
export class DispatchIntentService {
  readonly config: DispatchReconcilerConfig;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {
    this.config = readReconcilerConfig();
  }

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(DispatchIntent);
  }

  /**
   * Record that role R on ticket T was DISPATCHED (a trigger left the wire).
   * Idempotent per (ticket, role): if an open intent already exists it is moved
   * to in_flight with the fresh trigger_id + a processing-grace deadline;
   * otherwise a new in_flight intent is created. Best-effort — a failure here is
   * backstopped by the reconciler's seeder, so it never blocks the emit.
   *
   * `manager` lets a caller write the intent inside the SAME transaction as the
   * state change that produced the trigger (the reviewer's same-tx requirement);
   * callers on the fire-and-forget emit path pass none.
   */
  async recordDispatched(
    args: { workspaceId: string; boardId: string; ticketId: string; role: string; agentId: string; triggerSource: string; triggerId: string },
    manager?: EntityManager,
  ): Promise<void> {
    const now = new Date();
    const graceUntil = new Date(now.getTime() + this.config.processingGraceMs);
    try {
      const repo = this.repo(manager);
      const open = await this._findOpen(args.ticketId, args.role, repo);
      if (open) {
        open.status = DISPATCH_INTENT_STATUS.IN_FLIGHT;
        open.agent_id = args.agentId || open.agent_id;
        open.trigger_source = args.triggerSource || open.trigger_source;
        open.attempts += 1;
        open.dispatch_generation += 1;
        open.last_trigger_id = args.triggerId;
        open.last_ack_kind = '';
        open.next_attempt_at = graceUntil;
        open.lease_owner = '';
        open.lease_expires_at = null;
        await repo.save(open);
        return;
      }
      await repo.save(repo.create({
        workspace_id: args.workspaceId || '',
        board_id: args.boardId || '',
        ticket_id: args.ticketId,
        role: args.role,
        agent_id: args.agentId || '',
        trigger_source: args.triggerSource || '',
        status: DISPATCH_INTENT_STATUS.IN_FLIGHT,
        attempts: 1,
        dispatch_generation: 1,
        last_trigger_id: args.triggerId,
        next_attempt_at: graceUntil,
      }));
    } catch (e) {
      this.logService.warn('DispatchIntent', 'recordDispatched failed (reconciler seeder will backstop)', {
        err: String(e), ticket_id: args.ticketId, role: args.role,
      });
    }
  }

  /**
   * Record that role R on ticket T is OWED a dispatch but the emit was GATED
   * (focus window / in-flight strand / board paused / …) — the durable recovery
   * pointer for every gate drop. Leaves the intent `pending` so the reconciler
   * re-dispatches once the gate clears. Idempotent per (ticket, role).
   */
  async recordOwed(
    args: { workspaceId: string; boardId: string; ticketId: string; role: string; agentId: string; triggerSource: string; reason: string },
    manager?: EntityManager,
  ): Promise<void> {
    const now = new Date();
    try {
      const repo = this.repo(manager);
      const open = await this._findOpen(args.ticketId, args.role, repo);
      if (open) {
        // Already tracked — just annotate the latest gate reason; keep the
        // existing backoff / attempts (a gate drop is not a fresh attempt).
        open.last_reason = args.reason || open.last_reason;
        if (!open.next_attempt_at) open.next_attempt_at = now;
        await repo.save(open);
        return;
      }
      await repo.save(repo.create({
        workspace_id: args.workspaceId || '',
        board_id: args.boardId || '',
        ticket_id: args.ticketId,
        role: args.role,
        agent_id: args.agentId || '',
        trigger_source: args.triggerSource || '',
        status: DISPATCH_INTENT_STATUS.PENDING,
        attempts: 0,
        dispatch_generation: 0,
        next_attempt_at: now,
        last_reason: args.reason || '',
      }));
    } catch (e) {
      this.logService.warn('DispatchIntent', 'recordOwed failed (reconciler seeder will backstop)', {
        err: String(e), ticket_id: args.ticketId, role: args.role,
      });
    }
  }

  /**
   * Manager ack for a dispatched trigger (ticket e7c87517). Matched by
   * (ticket, role) AND the trigger_id the manager received on the SSE payload
   * (already carried as `field_changed` — no new SSE field). A stale ack whose
   * trigger_id ≠ the intent's current one is ignored (superseded by a newer
   * dispatch). Returns the applied outcome for the controller's response.
   *
   *   outcome='processed' — spawn started. NOT resolution; extends the retry
   *                         deadline by the processing grace so a healthy strand
   *                         gets time to show forward progress.
   *   outcome='nack'      — the manager aborted the spawn (worktree pool /
   *                         missing repo / twin suppressed). Back to `pending`
   *                         with backoff + a structured reason audit so the
   *                         reconciler re-dispatches once the blocker clears.
   */
  async applyManagerAck(args: {
    ticketId: string; role: string; triggerId: string;
    outcome: 'processed' | 'nack'; reason?: string;
  }): Promise<{ applied: boolean; matched: boolean; status?: string }> {
    const now = new Date();
    const repo = this.repo();
    const open = await this._findOpen(args.ticketId, args.role, repo);
    if (!open) return { applied: false, matched: false };
    // Stale-ack guard: only the most recent dispatch's trigger_id may mutate.
    if (args.triggerId && open.last_trigger_id && args.triggerId !== open.last_trigger_id) {
      return { applied: false, matched: false, status: open.status };
    }
    if (args.outcome === 'processed') {
      open.last_ack_kind = 'processed';
      // Extend, never shorten — a processed ack should push the retry deadline
      // out, but must not pull a longer backoff earlier.
      const grace = new Date(now.getTime() + this.config.processingGraceMs);
      if (!open.next_attempt_at || open.next_attempt_at < grace) open.next_attempt_at = grace;
      await repo.save(open);
      await this._writeAudit(open, 'dispatch_ack_processed', {
        trigger_id: args.triggerId, generation: open.dispatch_generation,
      });
      return { applied: true, matched: true, status: open.status };
    }
    // nack — the spawn was aborted; re-open for retry with backoff.
    open.status = DISPATCH_INTENT_STATUS.PENDING;
    open.last_ack_kind = 'nack';
    open.last_reason = (args.reason || 'nack').slice(0, 200);
    open.next_attempt_at = new Date(now.getTime() + dispatchBackoffMs(open.attempts, this.config));
    open.lease_owner = '';
    open.lease_expires_at = null;
    await repo.save(open);
    await this._writeAudit(open, 'dispatch_nack', {
      trigger_id: args.triggerId, reason: open.last_reason, generation: open.dispatch_generation,
      recovery: 'reconciler re-dispatches after backoff once the manager-side blocker (worktree pool / repo / twin) clears',
    });
    return { applied: true, matched: true, status: open.status };
  }

  /** All open (pending|in_flight) intents, oldest-first — the reconciler's scan set. */
  async listOpen(): Promise<DispatchIntent[]> {
    return this.repo().find({
      where: { status: In([DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT]) },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  async findOpenForTicketRole(ticketId: string, role: string): Promise<DispatchIntent | null> {
    return this._findOpen(ticketId, role, this.repo());
  }

  private async _findOpen(ticketId: string, role: string, repo = this.repo()): Promise<DispatchIntent | null> {
    return repo.findOne({
      where: {
        ticket_id: ticketId,
        role,
        status: In([DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT]),
      },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  /** Close an intent (any resolution reason). Idempotent. */
  async resolve(intent: DispatchIntent, reason: string, now = new Date()): Promise<void> {
    const repo = this.repo();
    intent.status = DISPATCH_INTENT_STATUS.RESOLVED;
    intent.last_reason = reason;
    intent.resolved_at = now;
    intent.lease_owner = '';
    intent.lease_expires_at = null;
    await repo.save(intent);
  }

  /**
   * Multi-instance-safe dispatch claim (ticket e7c87517). Atomically move a
   * chosen intent pending|in_flight → in_flight, bump attempts + generation, set
   * the next retry deadline, and take the reconcile lease — but ONLY if the row
   * is still at the generation/status we decided on and the lease is free/expired.
   * Two server instances racing the same intent: exactly one UPDATE affects a
   * row; the loser gets `false` and skips (no double spawn). Returns the fresh
   * generation + trigger deadline on success.
   */
  async claimForDispatch(
    intent: DispatchIntent,
    opts: { instanceId: string; now: Date; force: boolean },
  ): Promise<{ claimed: boolean; generation: number; nextAttemptAt: Date }> {
    const now = opts.now;
    const nextGen = intent.dispatch_generation + 1;
    const nextAttemptAt = new Date(now.getTime() + dispatchBackoffMs(intent.attempts + 1, this.config));
    const leaseExpiry = new Date(now.getTime() + this.config.leaseMs);
    const res = await this.repo()
      .createQueryBuilder()
      .update(DispatchIntent)
      .set({
        status: DISPATCH_INTENT_STATUS.IN_FLIGHT,
        attempts: () => 'attempts + 1',
        dispatch_generation: nextGen,
        next_attempt_at: nextAttemptAt,
        lease_owner: opts.instanceId,
        lease_expires_at: leaseExpiry,
        last_reason: opts.force ? 'reconcile_force_redispatch' : 'reconcile_redispatch',
      })
      .where('id = :id', { id: intent.id })
      .andWhere('dispatch_generation = :gen', { gen: intent.dispatch_generation })
      .andWhere('status IN (:...open)', { open: [DISPATCH_INTENT_STATUS.PENDING, DISPATCH_INTENT_STATUS.IN_FLIGHT] })
      .andWhere('(lease_owner = :empty OR lease_owner = :me OR lease_expires_at IS NULL OR lease_expires_at <= :now)', {
        empty: '', me: opts.instanceId, now,
      })
      .execute();
    const claimed = (res.affected ?? 0) > 0;
    return { claimed, generation: nextGen, nextAttemptAt };
  }

  /** Mark the one-shot operator escalation latch. Returns true if it was newly set. */
  async markEscalated(intentId: string, now = new Date()): Promise<boolean> {
    const res = await this.repo()
      .createQueryBuilder()
      .update(DispatchIntent)
      .set({ escalated_at: now })
      .where('id = :id', { id: intentId })
      .andWhere('escalated_at IS NULL')
      .execute();
    return (res.affected ?? 0) > 0;
  }

  async createSeed(args: {
    workspaceId: string; boardId: string; ticketId: string; role: string; agentId: string;
  }): Promise<void> {
    const now = new Date();
    const repo = this.repo();
    // Guard against a concurrent record: only seed when nothing open exists.
    const open = await this._findOpen(args.ticketId, args.role, repo);
    if (open) return;
    await repo.save(repo.create({
      workspace_id: args.workspaceId || '',
      board_id: args.boardId || '',
      ticket_id: args.ticketId,
      role: args.role,
      agent_id: args.agentId || '',
      trigger_source: 'reconcile_seed',
      status: DISPATCH_INTENT_STATUS.PENDING,
      attempts: 0,
      dispatch_generation: 0,
      next_attempt_at: now,
      last_reason: 'seeded_by_reconciler',
    }));
  }

  private async _writeAudit(intent: DispatchIntent, action: string, extra: Record<string, unknown>): Promise<void> {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      await repo.save(repo.create({
        workspace_id: intent.workspace_id ?? '',
        entity_type: 'ticket',
        entity_id: intent.ticket_id,
        action,
        field_changed: 'dispatch_intent',
        old_value: '',
        new_value: JSON.stringify({ intent_id: intent.id, role: intent.role, agent_id: intent.agent_id, attempts: intent.attempts, ...extra }),
        actor_id: 'system',
        actor_name: 'DispatchReconciler',
        ticket_id: intent.ticket_id,
        role: intent.role,
        trigger_source: 'dispatch_reconcile',
      }));
    } catch (e) {
      this.logService.warn('DispatchIntent', 'audit write failed (continuing)', {
        err: String(e), ticket_id: intent.ticket_id, action,
      });
    }
  }
}
