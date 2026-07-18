import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * DispatchIntent — the durable dispatch outbox (ticket e7c87517).
 *
 * WHY THIS EXISTS
 * The `agent_trigger` path is a fire-and-forget in-process EventEmitter emit
 * (TriggerLoopService._emitTrigger → `activityEvents.emit('agent_trigger')`).
 * There is NO acknowledgement and NO persistence: if the emit is dropped by a
 * gate (focus window / in-flight strand / board paused), lost in the SSE hop,
 * or the manager aborts the spawn (worktree `pool_exhausted`, offline agent),
 * the trigger evaporates. Nothing re-derives it, so a ticket can sit for a full
 * day with zero forward progress and zero operator signal — the exact
 * TerrainSystem `30603ce6` 25h-in-To-Do incident.
 *
 * A DispatchIntent is a durable record of "role R on ticket T is OWED a
 * dispatch". It is created in (or right after) the same state change that
 * produces a trigger, and it stays OPEN until the ticket makes real forward
 * progress or reaches a terminal / parked / unstaffed state. A background
 * reconciler (DispatchReconcilerService) re-derives owed intents from THIS
 * table on every sweep — so the guarantee survives a process restart, an SSE
 * subscription gap, and a manager-side spawn failure, and it holds across
 * multiple server instances (lease CAS below).
 *
 * STATE MACHINE
 *   pending   — owed a dispatch; the reconciler will (re)emit once
 *               `next_attempt_at` has elapsed.
 *   in_flight — dispatched this `dispatch_generation`; awaiting either
 *               forward progress (→ resolved) or the retry deadline
 *               (`next_attempt_at`) after which it drops back to a re-dispatch.
 *               A manager `processed` ack extends the deadline (spawn started);
 *               a `nack` sends it back to `pending` with backoff.
 *   resolved  — closed. Reason recorded in `last_reason` (progressed / terminal
 *               / parked / unstaffed / superseded / ticket_deleted).
 *
 * CRITICAL INVARIANT (reviewer): spawn success (`processed` ack) is NOT
 * resolution. Only observed forward progress (a fresh comment / column move /
 * claim / output-liveness AFTER `created_at`) or a terminal/parked/unstaffed
 * ticket resolves an intent. A subagent that spawns and dies silently leaves
 * the intent OPEN so the reconciler re-dispatches it.
 *
 * MULTI-INSTANCE SAFETY
 * `lease_owner` / `lease_expires_at` are claimed by a conditional (CAS) UPDATE
 * before a reconciler re-dispatches, so two instances never double-spawn the
 * same generation. `dispatch_generation` is the token a manager ack/nack must
 * carry so a late ack for an older generation cannot mutate a newer dispatch.
 *
 * STORAGE
 * TypeORM repositories only (SQLite dev + Postgres prod). The table is created
 * by TypeORM `synchronize` on every backend — `synchronize` is hardcoded ON in
 * `db.ts` (D-01) for sqlite AND postgres, so no hand-written migration is needed
 * (same as the sibling `stuck_alerts` table). No FK cascade — a deleted ticket
 * is tolerated (the reconciler resolves the orphan intent).
 */
@Entity('dispatch_intents')
// The reconciler's hot query is "open intents oldest-first"; index status so the
// sweep never scans resolved history. `_findOpen` filters by (ticket_id, role,
// status) so the (ticket_id, role) index keeps the per-emit idempotency lookup cheap.
@Index(['status', 'next_attempt_at'])
@Index(['ticket_id', 'role'])
export class DispatchIntent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', default: '' })
  board_id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  // Routed role slug the intent owes a dispatch to (assignee / reviewer / …).
  @Column({ type: 'varchar' })
  role: string;

  // Target agent holder resolved at record time. May be '' if unresolved — the
  // reconciler re-resolves the current holder each dispatch, so a late-assigned
  // holder is still picked up.
  @Column({ type: 'varchar', default: '' })
  agent_id: string;

  // Origin of the owed dispatch (column_move / comment / next_ticket /
  // prerequisite_resolved / manual / backlog_promotion / reconcile_seed / …).
  @Column({ type: 'varchar', default: '' })
  trigger_source: string;

  // pending | in_flight | resolved
  @Column({ type: 'varchar', default: 'pending' })
  @Index()
  status: string;

  // Number of dispatch attempts made for this intent (bumped each (re)dispatch).
  @Column({ type: 'int', default: 0 })
  attempts: number;

  // Earliest wall-clock the reconciler may (re)dispatch this intent. Set on
  // record (=now), pushed forward by backoff on every dispatch and by the
  // processing grace on a `processed` ack.
  @Column({ type: Date })
  next_attempt_at: Date;

  // Monotonic dispatch token. Bumped on every (re)dispatch; a manager ack/nack
  // is only honored when it carries the current generation (stale-ack guard).
  @Column({ type: 'int', default: 0 })
  dispatch_generation: number;

  // trigger_id of the most recent dispatch. The manager receives this on the
  // agent_trigger SSE payload (as `field_changed`) and echoes it on its ack, so
  // a late ack for a superseded dispatch is matched out (stale-ack guard) with
  // NO new SSE field required.
  @Column({ type: 'varchar', default: '' })
  last_trigger_id: string;

  // Multi-instance reconcile lease. Empty owner + null expiry = free.
  @Column({ type: 'varchar', default: '' })
  lease_owner: string;

  @Column({ type: Date, nullable: true, default: null })
  lease_expires_at: Date | null;

  // Last manager ack kind: '' | 'processed' | 'nack'.
  @Column({ type: 'varchar', default: '' })
  last_ack_kind: string;

  // Human-readable last transition reason (nack reason, resolution reason, …).
  @Column({ type: 'varchar', default: '' })
  last_reason: string;

  // One-shot operator escalation latch: set once the intent has burned through
  // `ESCALATE_AFTER_ATTEMPTS` re-dispatches with no progress so the alert fires
  // exactly once per stuck episode (the reconciler keeps retrying at the capped
  // backoff regardless — escalation never means "give up").
  @Column({ type: Date, nullable: true, default: null })
  escalated_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  resolved_at: Date | null;
}
