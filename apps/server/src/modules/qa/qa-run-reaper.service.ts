/**
 * QaRunReaperService — background sweep that fails QaRuns whose driver died
 * without ever calling complete_qa_run, so the board can't display a run as
 * `running` forever.
 *
 * Why this exists: a QaRun is created with status='running' and only moves to
 * a terminal status when the QA agent calls completeRun(). If that agent (or
 * the headless build/drive job it is waiting on) dies mid-run, nothing ever
 * stamps a terminal status — the run sits `running` indefinitely (observed:
 * a terrain QA run stuck `running` for two days while its backing cold player
 * build had already timed out and been killed). This is the QaRun analogue of
 * the orphan-worktree / stale-job-sentinel rot fixed on the GameClient side by
 * Reconcile-StaleJobs.ps1: the same "a job died and nothing closed the record"
 * class, here on the board's own DB.
 *
 * Pattern mirrors TicketArchiverService / StuckTicketDetectorService: OnModuleInit
 * plants a plain setInterval (no @Cron, no scheduler dep), torn down on destroy.
 *
 * TWO FUSES (a stale run is reaped when EITHER trips):
 *   • zero-progress — status running/pending, ZERO steps recorded, and age past
 *     QA_RUN_ZERO_PROGRESS_MS (default 40m). This is the fast fuse for the most
 *     common rot: a run that started but its backing build/drive job died before
 *     a single step landed, so it never makes progress. Steps carry no per-step
 *     timestamp, so "no progress" is read as "zero steps after N minutes" — a run
 *     that recorded even one step is treated as having made progress and is left
 *     to the absolute TTL below.
 *   • 6h-TTL (absolute) — age past QA_RUN_TTL_MS (default 6h) regardless of step
 *     count. This is the backstop for a run that DID make progress (≥1 step) then
 *     stalled; the long fuse protects a legitimately slow, still-advancing run
 *     (the longest real scenario, the veg/gather E2E with a ~13-min respawn wait,
 *     finishes well under an hour, so 6h never clips a live run).
 *
 * On reap: stamp status='error', finished_at=now, and prepend a clear marker to
 * the summary naming WHICH fuse tripped (zero-progress vs 6h-TTL) so the board
 * row reads as a reaper-closed run, not a genuine tested failure. Capped at
 * QA_RUN_REAPER_BATCH per tick.
 *
 * Activation: OnModuleInit runs ONE immediate sweep before planting the periodic
 * timer, so a deploy/restart clears any standing phantom within seconds instead
 * of waiting up to a full sweep interval. runOnce() is also public so an operator
 * can fire a sweep on demand via POST /api/qa/runs/reap (no restart needed once
 * the code is live).
 *
 * Idempotent: a reaped run is terminal, so the next sweep's SELECT skips it.
 * Env: QA_RUN_REAPER_ENABLED (default on), QA_RUN_REAPER_SWEEP_MS (default 30m,
 * clamped 1m..24h), QA_RUN_TTL_MS (default 6h, clamped 5m..7d),
 * QA_RUN_ZERO_PROGRESS_MS (default 40m, clamped 1m..6h).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QaRun } from '../../entities/QaRun';
import { LogService } from '../../services/log.service';
import { QaRunService } from './qa-run.service';

const DEFAULT_SWEEP_MS = 30 * 60_000; // 30 minutes
const MIN_SWEEP_MS = 60_000;          // 1 minute
const MAX_SWEEP_MS = 24 * 60 * 60_000; // 24 hours
const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6 hours
const MIN_TTL_MS = 5 * 60_000;          // 5 minutes
const MAX_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days
const DEFAULT_ZERO_PROGRESS_MS = 40 * 60_000; // 40 minutes
const MIN_ZERO_PROGRESS_MS = 60_000;          // 1 minute
const MAX_ZERO_PROGRESS_MS = 6 * 60 * 60_000;  // 6 hours
const QA_RUN_REAPER_BATCH = 200;
const NON_TERMINAL: QaRun['status'][] = ['running', 'pending'];

type ReapReason = 'zero-progress' | '6h-TTL';

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class QaRunReaperService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly sweepMs = clampEnv('QA_RUN_REAPER_SWEEP_MS', DEFAULT_SWEEP_MS, MIN_SWEEP_MS, MAX_SWEEP_MS);
  private readonly ttlMs = clampEnv('QA_RUN_TTL_MS', DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
  private readonly zeroProgressMs = clampEnv(
    'QA_RUN_ZERO_PROGRESS_MS', DEFAULT_ZERO_PROGRESS_MS, MIN_ZERO_PROGRESS_MS, MAX_ZERO_PROGRESS_MS,
  );
  private readonly enabled = (process.env.QA_RUN_REAPER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(QaRun) private readonly runRepo: Repository<QaRun>,
    private readonly logService: LogService,
    private readonly qaRunService: QaRunService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('QaReaper', 'disabled via QA_RUN_REAPER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('QaReaper', 'tick failed', { err: String(e) });
      });
    }, this.sweepMs);
    // Don't keep the event loop alive on the timer alone (mirrors the other sweeps).
    this.tickHandle.unref?.();
    this.logService.info('QaReaper', 'Service initialized', {
      sweep_ms: this.sweepMs, ttl_ms: this.ttlMs, zero_progress_ms: this.zeroProgressMs,
    });
    // Immediate boot sweep: a deploy/restart clears standing phantoms within
    // seconds instead of idling up to a full sweep interval. Fire-and-forget so
    // a slow/failed first sweep never blocks module init.
    this.runOnce().catch((e: unknown) => {
      this.logService.error('QaReaper', 'boot sweep failed', { err: String(e) });
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One reap sweep. Public so a test / operator endpoint can drive it
   * deterministically. Returns the ids of the runs it reaped plus per-run detail
   * (which fuse tripped, age in minutes).
   */
  async runOnce(now: Date = new Date()): Promise<{
    reaped: string[];
    details: Array<{ id: string; reason: ReapReason; age_min: number }>;
  }> {
    // Candidate non-terminal runs; the age gates (started_at ?? created_at vs the
    // fuse windows) are applied in JS so the started_at-null fallback stays
    // portable across SQLite + Postgres (no COALESCE-in-WHERE dialect divergence).
    const candidates = await this.runRepo.find({
      where: { status: In(NON_TERMINAL) },
      order: { created_at: 'ASC' },
      take: QA_RUN_REAPER_BATCH,
    });

    const reaped: string[] = [];
    const details: Array<{ id: string; reason: ReapReason; age_min: number }> = [];
    for (const run of candidates) {
      const startedAt = run.started_at ?? run.created_at;
      if (!startedAt) continue;
      const ageMs = now.getTime() - startedAt.getTime();
      const stepCount = run.step_results?.length ?? 0;

      // Decide which fuse (if any) trips. The absolute TTL applies regardless of
      // progress; the faster zero-progress fuse only applies to runs that never
      // recorded a step (a run with ≥1 step is "making progress" and waits for TTL).
      let reason: ReapReason | null = null;
      if (ageMs > this.ttlMs) reason = '6h-TTL';
      else if (stepCount === 0 && ageMs > this.zeroProgressMs) reason = 'zero-progress';
      if (!reason) continue;

      try {
        const ageMin = Math.round(ageMs / 60_000);
        run.status = 'error';
        run.finished_at = now;
        const marker =
          reason === 'zero-progress'
            ? `[auto-reaped by QaRunReaperService — fuse: zero-progress] no step recorded after ` +
              `~${ageMin} min (threshold ${Math.round(this.zeroProgressMs / 60_000)} min); the QA agent or ` +
              `its backing build/drive job is presumed dead before making any progress. ` +
              `This is NOT a tested failure — re-run the scenario.`
            : `[auto-reaped by QaRunReaperService — fuse: 6h-TTL] no terminal status within ` +
              `${Math.round(this.ttlMs / 60_000)} min (ran for ~${ageMin} min); the QA agent or its backing ` +
              `build/drive job is presumed dead. This is NOT a tested failure — re-run the scenario.`;
        run.summary = run.summary ? `${marker}\n\n${run.summary}` : marker;
        await this.runRepo.save(run);
        reaped.push(run.id);
        details.push({ id: run.id, reason, age_min: ageMin });
        // If this dead run belonged to a sequential batch, advance the batch
        // from here too (terminal-status reached, just not via complete_qa_run).
        // Never let a batch hiccup abort the sweep.
        await this.qaRunService.onRunFinalized(run).catch((e) =>
          this.logService.warn('QaReaper', 'batch advance after reap failed (continuing)', { err: String(e), run_id: run.id }),
        );
      } catch (e) {
        this.logService.warn('QaReaper', 'per-run reap failed (continuing)', { err: String(e), run_id: run.id });
      }
    }

    if (reaped.length > 0) {
      this.logService.info('QaReaper', 'reaped stale runs', {
        count: reaped.length, ttl_ms: this.ttlMs, zero_progress_ms: this.zeroProgressMs, details,
      });
    }
    return { reaped, details };
  }
}
