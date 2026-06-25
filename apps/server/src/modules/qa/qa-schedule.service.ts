import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { QaSchedule, QaScheduleScope } from '../../entities/QaSchedule';
import { QaRunBatch } from '../../entities/QaRunBatch';
import { LogService } from '../../services/log.service';
import { findOrFail } from '../../common/find-or-fail';
import { QaRunService } from './qa-run.service';
import { isValidCron, nextCronAfter } from './qa-cron';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const DEFAULT_TICK_MS = 30_000;        // 30s — fine enough for short interval schedules
const MIN_TICK_MS = 5_000;             // 5s
const MAX_TICK_MS = 60 * 60_000;       // 1h
const MIN_INTERVAL_MS = 1_000;         // reject 0/negative; the tick caps real cadence anyway
const TICK_BATCH = 100;                // max schedules dispatched per tick

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

export interface CreateScheduleInput {
  workspaceId: string;
  boardId?: string | null;
  name: string;
  scope?: QaScheduleScope;
  scenarioIds?: string[] | null;
  cron?: string | null;
  intervalMs?: number | null;
  enabled?: boolean;
  stopOnFail?: boolean;
  triggeredByType?: string;
  createdBy?: string;
}

export type UpdateScheduleInput = Partial<Omit<CreateScheduleInput, 'workspaceId' | 'createdBy'>>;

/**
 * QaScheduleService — automatic trigger layer over the sequential QA batch
 * (ticket b6bb7efd). Owns QaSchedule CRUD plus a background tick that, every
 * QA_SCHEDULER_TICK_MS, finds due schedules and kicks a QaRunBatch through
 * QaRunService.startBatch — the SAME orchestrator the manual "순차 실행" buttons
 * use. Scheduling is the "when"; the batch is the "what" (reused, not forked).
 *
 * Background-loop shape mirrors QaRunReaperService: OnModuleInit plants a plain
 * unref'd setInterval (no @Cron / scheduler dep), torn down on destroy, with an
 * env on/off switch and a clamped cadence.
 *
 * Idempotency / overlap policy (the ticket's "멱등 + 이미 도는 batch 있으면 skip"):
 *   - Each due schedule's next_run_at is advanced to its NEXT firing and saved
 *     BEFORE the (async) dispatch — so a re-entrant/overlapping tick sees the
 *     cursor already moved past `now` and no-ops. next_run_at is computed from
 *     `now` (the firing instant), not the old next_run_at, so a server that was
 *     down does not backfill a storm of missed occurrences — it fires once and
 *     reschedules forward.
 *   - SKIP (not queue): if the schedule's previous batch (last_batch_id) is
 *     still `running`, this occurrence is dropped (next_run_at already advanced)
 *     and logged — a slow batch can never pile up overlapping runs.
 *
 * Deployment timing (same footgun as #467dbc7a): a scheduled run hits the
 * RUNNING server, which auto-deploys from production.private only AFTER main
 * merges. A schedule firing right after a fix-merge can validate pre-deploy
 * code. The honest mitigation here is operational — set the cadence coarser than
 * your main→prod deploy lag (cron at a fixed wall-clock hour, or a multi-minute
 * interval), so a scheduled run lands after the deploy. (Unlike the rerun-on-fix
 * delay gate, a fixed-cadence schedule has no merge edge to defer from.) Noted on
 * the editor + docs/qa-scheduler.md.
 */
@Injectable()
export class QaScheduleService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickMs = clampEnv('QA_SCHEDULER_TICK_MS', DEFAULT_TICK_MS, MIN_TICK_MS, MAX_TICK_MS);
  private readonly enabled = (process.env.QA_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(QaSchedule) private readonly scheduleRepo: Repository<QaSchedule>,
    @InjectRepository(QaRunBatch) private readonly batchRepo: Repository<QaRunBatch>,
    private readonly qaRunService: QaRunService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('QaScheduler', 'disabled via QA_SCHEDULER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('QaScheduler', 'tick failed', { err: String(e) });
      });
    }, this.tickMs);
    // Don't keep the event loop alive on the timer alone (mirrors the reaper).
    this.tickHandle.unref?.();
    this.logService.info('QaScheduler', 'Service initialized', { tick_ms: this.tickMs });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async list(workspaceId: string, boardId?: string): Promise<QaSchedule[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.scheduleRepo.createQueryBuilder('s').where('s.workspace_id = :ws', { ws: workspaceId });
    // Scope rule mirrors list_qa_scenarios: omit board_id → all; "" → workspace
    // (board_id IS NULL); <uuid> → that board.
    if (boardId !== undefined) {
      if (boardId) qb.andWhere('s.board_id = :bid', { bid: boardId });
      else qb.andWhere('s.board_id IS NULL');
    }
    return qb.orderBy('s.created_at', 'DESC').getMany();
  }

  async get(id: string, workspaceId: string): Promise<QaSchedule> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    return findOrFail(this.scheduleRepo, { where: { id, workspace_id: workspaceId } }, 'QA schedule not found in workspace');
  }

  async create(input: CreateScheduleInput): Promise<QaSchedule> {
    if (!input.workspaceId) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');

    const scope: QaScheduleScope = input.scope === 'selected' ? 'selected' : 'all';
    const scenarioIds = this._validateScope(scope, input.scenarioIds);
    const { cron, intervalMs } = this._validateCadence(input.cron, input.intervalMs);
    const enabled = input.enabled !== false;

    const draft = this.scheduleRepo.create({
      workspace_id: input.workspaceId,
      board_id: input.boardId ?? null,
      name: input.name.trim(),
      scope,
      scenario_ids: scenarioIds,
      cron,
      interval_ms: intervalMs,
      enabled,
      stop_on_fail: !!input.stopOnFail,
      next_run_at: null,
      last_run_at: null,
      last_batch_id: null,
      triggered_by_type: input.triggeredByType || 'user',
      created_by: input.createdBy || '',
    });
    draft.next_run_at = this.computeNextRun(draft, new Date());
    return this.scheduleRepo.save(draft);
  }

  async update(id: string, workspaceId: string, patch: UpdateScheduleInput): Promise<QaSchedule> {
    const schedule = await this.get(id, workspaceId);

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      schedule.name = patch.name.trim();
    }
    if (patch.boardId !== undefined) schedule.board_id = patch.boardId ?? null;
    if (patch.stopOnFail !== undefined) schedule.stop_on_fail = !!patch.stopOnFail;
    if (patch.triggeredByType !== undefined) schedule.triggered_by_type = patch.triggeredByType || 'user';

    // Scope / scenario_ids — re-validate together so a scope flip to 'selected'
    // always carries a non-empty list.
    if (patch.scope !== undefined || patch.scenarioIds !== undefined) {
      const nextScope: QaScheduleScope =
        patch.scope !== undefined ? (patch.scope === 'selected' ? 'selected' : 'all') : schedule.scope;
      const nextIds = patch.scenarioIds !== undefined ? patch.scenarioIds : schedule.scenario_ids;
      schedule.scenario_ids = this._validateScope(nextScope, nextIds);
      schedule.scope = nextScope;
    }

    // Cadence — re-validate together; only touch when the caller sends either key.
    if (patch.cron !== undefined || patch.intervalMs !== undefined) {
      const nextCron = patch.cron !== undefined ? patch.cron : schedule.cron;
      const nextInterval = patch.intervalMs !== undefined ? patch.intervalMs : schedule.interval_ms;
      const validated = this._validateCadence(nextCron, nextInterval);
      schedule.cron = validated.cron;
      schedule.interval_ms = validated.intervalMs;
    }

    if (patch.enabled !== undefined) schedule.enabled = patch.enabled;

    // Recompute the next firing whenever enable-state or cadence could have moved
    // it. Disabled → null (the tick query skips it); enabled → compute from now.
    schedule.next_run_at = this.computeNextRun(schedule, new Date());
    return this.scheduleRepo.save(schedule);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    const schedule = await this.get(id, workspaceId);
    await this.scheduleRepo.delete({ id: schedule.id });
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /**
   * Manual immediate trigger (REST/MCP run-now). Dispatches the schedule's batch
   * right now regardless of `enabled` (explicit user intent) and stamps
   * last_run_at / last_batch_id, but does NOT touch next_run_at — a manual run
   * must not disturb the automatic cadence.
   */
  async runNow(id: string, workspaceId: string, triggeredById: string): Promise<{ schedule: QaSchedule; batch: QaRunBatch }> {
    const schedule = await this.get(id, workspaceId);
    const batch = await this._dispatchBatch(schedule, triggeredById);
    schedule.last_run_at = new Date();
    schedule.last_batch_id = batch.id;
    const saved = await this.scheduleRepo.save(schedule);
    this.logService.info('QaScheduler', 'run-now dispatched', { schedule_id: id, batch_id: batch.id });
    return { schedule: saved, batch };
  }

  /**
   * One scheduler sweep. Public so a test / operator endpoint can drive it
   * deterministically (mirrors QaRunReaperService.runOnce). Returns the schedule
   * ids it dispatched a batch for this tick.
   */
  async runOnce(now: Date = new Date()): Promise<{ dispatched: string[]; skipped: string[] }> {
    const dispatched: string[] = [];
    const skipped: string[] = [];

    // Self-heal: an enabled schedule with a null next_run_at (legacy row / cadence
    // edited while disabled) gets its cursor computed forward — without firing, so
    // enabling never causes a surprise immediate run.
    const orphans = await this.scheduleRepo.find({ where: { enabled: true, next_run_at: IsNull() } });
    for (const s of orphans) {
      s.next_run_at = this.computeNextRun(s, now);
      await this.scheduleRepo.save(s);
    }

    const due = await this.scheduleRepo.find({
      where: { enabled: true, next_run_at: LessThanOrEqual(now) },
      order: { next_run_at: 'ASC' },
      take: TICK_BATCH,
    });

    for (const schedule of due) {
      try {
        // Advance the cursor + persist BEFORE the (slow, async) dispatch so a
        // duplicate/overlapping tick sees next_run_at already moved and no-ops —
        // the same idempotency ordering QaRunService.onRunFinalized uses.
        schedule.next_run_at = this.computeNextRun(schedule, now);
        await this.scheduleRepo.save(schedule);

        // SKIP-if-running: never let a slow previous batch overlap.
        if (schedule.last_batch_id) {
          const prev = await this.batchRepo.findOne({ where: { id: schedule.last_batch_id } });
          if (prev && prev.status === 'running') {
            skipped.push(schedule.id);
            this.logService.info('QaScheduler', 'skip — previous batch still running', {
              schedule_id: schedule.id, batch_id: prev.id,
            });
            continue;
          }
        }

        const batch = await this._dispatchBatch(schedule, schedule.triggered_by_type || 'qa-scheduler');
        schedule.last_run_at = now;
        schedule.last_batch_id = batch.id;
        await this.scheduleRepo.save(schedule);
        dispatched.push(schedule.id);
        this.logService.info('QaScheduler', 'dispatched batch for schedule', {
          schedule_id: schedule.id, batch_id: batch.id, total: batch.scenario_ids?.length ?? 0,
          next_run_at: schedule.next_run_at,
        });
      } catch (e: any) {
        // A bad schedule (no runnable scenarios, etc.) must not stall the sweep.
        // next_run_at is already advanced, so it retries next occurrence.
        this.logService.warn('QaScheduler', 'schedule dispatch failed (continuing)', {
          schedule_id: schedule.id, err: e?.message || String(e),
        });
      }
    }

    if (dispatched.length || skipped.length) {
      this.logService.info('QaScheduler', 'sweep done', { dispatched: dispatched.length, skipped: skipped.length });
    }
    return { dispatched, skipped };
  }

  /** Compute the next firing instant for a schedule (null when disabled / no cadence). */
  computeNextRun(schedule: Pick<QaSchedule, 'enabled' | 'cron' | 'interval_ms'>, from: Date): Date | null {
    if (!schedule.enabled) return null;
    if (schedule.cron) return nextCronAfter(schedule.cron, from);
    if (schedule.interval_ms && schedule.interval_ms > 0) return new Date(from.getTime() + schedule.interval_ms);
    return null;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Kick the batch for a schedule via the shared sequential-batch orchestrator. */
  private async _dispatchBatch(schedule: QaSchedule, triggeredById: string): Promise<QaRunBatch> {
    if (schedule.scope === 'selected') {
      const ids = Array.isArray(schedule.scenario_ids) ? schedule.scenario_ids : [];
      if (ids.length === 0) throw makeError(400, 'selected schedule has no scenario_ids');
      return this.qaRunService.startBatch({
        workspaceId: schedule.workspace_id,
        // explicit ids: board scope is irrelevant (startBatch ignores boardId when scenarioIds set)
        scenarioIds: ids,
        stopOnFail: schedule.stop_on_fail,
        triggeredByType: 'system',
        triggeredById,
      });
    }
    // scope='all' → resolve enabled scenarios in scope AT DISPATCH TIME (no id
    // snapshot), so scenario add/remove is reflected automatically. board_id null
    // → whole workspace (boardId undefined); <uuid> → that board.
    return this.qaRunService.startBatch({
      workspaceId: schedule.workspace_id,
      boardId: schedule.board_id ?? undefined,
      all: true,
      stopOnFail: schedule.stop_on_fail,
      triggeredByType: 'system',
      triggeredById,
    });
  }

  private _validateScope(scope: QaScheduleScope, scenarioIds: string[] | null | undefined): string[] | null {
    if (scope === 'selected') {
      const ids = Array.isArray(scenarioIds) ? scenarioIds.filter((x) => typeof x === 'string' && x) : [];
      if (ids.length === 0) throw makeError(400, "scope='selected' requires a non-empty scenario_ids list");
      return ids;
    }
    // scope='all' keeps no id snapshot.
    return null;
  }

  private _validateCadence(cron: string | null | undefined, intervalMs: number | null | undefined): { cron: string | null; intervalMs: number | null } {
    const hasCron = typeof cron === 'string' && cron.trim() !== '';
    const hasInterval = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0;
    if (hasCron && hasInterval) throw makeError(400, 'set exactly one of cron or interval_ms, not both');
    if (!hasCron && !hasInterval) throw makeError(400, 'one of cron or interval_ms is required');
    if (hasCron) {
      if (!isValidCron(cron!.trim())) throw makeError(400, `invalid cron expression: "${cron}" (5 UTC fields, e.g. "0 3 * * *")`);
      return { cron: cron!.trim(), intervalMs: null };
    }
    if (intervalMs! < MIN_INTERVAL_MS) throw makeError(400, `interval_ms must be >= ${MIN_INTERVAL_MS}`);
    return { cron: null, intervalMs: Math.floor(intervalMs!) };
  }
}
