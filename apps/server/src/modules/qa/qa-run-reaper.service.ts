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
 * Per-tick mechanics:
 *   1. Select QaRuns with status IN ('running','pending') whose age — measured
 *      from started_at, falling back to created_at — exceeds QA_RUN_TTL_MS.
 *      The TTL (default 6h) is far past any legitimate run (the longest real
 *      scenario, the veg/gather E2E with a ~13-min respawn wait, finishes well
 *      under an hour) so a live-but-slow run is never reaped.
 *   2. Stamp status='error', finished_at=now, and prepend a clear marker to the
 *      summary so the board row reads as a reaped run, not a genuine failure.
 *   3. Capped at QA_RUN_REAPER_BATCH per tick.
 *
 * Idempotent: a reaped run is terminal, so the next sweep's SELECT skips it.
 * Env: QA_RUN_REAPER_ENABLED (default on), QA_RUN_REAPER_SWEEP_MS (default 30m,
 * clamped 1m..24h), QA_RUN_TTL_MS (default 6h, clamped 5m..7d).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QaRun } from '../../entities/QaRun';
import { LogService } from '../../services/log.service';

const DEFAULT_SWEEP_MS = 30 * 60_000; // 30 minutes
const MIN_SWEEP_MS = 60_000;          // 1 minute
const MAX_SWEEP_MS = 24 * 60 * 60_000; // 24 hours
const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6 hours
const MIN_TTL_MS = 5 * 60_000;          // 5 minutes
const MAX_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days
const QA_RUN_REAPER_BATCH = 200;
const NON_TERMINAL: QaRun['status'][] = ['running', 'pending'];

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
  private readonly enabled = (process.env.QA_RUN_REAPER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(QaRun) private readonly runRepo: Repository<QaRun>,
    private readonly logService: LogService,
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
    this.logService.info('QaReaper', 'Service initialized', { sweep_ms: this.sweepMs, ttl_ms: this.ttlMs });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One reap sweep. Public so a test / operator endpoint can drive it
   * deterministically. Returns the ids of the runs it reaped.
   */
  async runOnce(now: Date = new Date()): Promise<{ reaped: string[] }> {
    const cutoff = new Date(now.getTime() - this.ttlMs);
    // Candidate non-terminal runs; the age gate (started_at ?? created_at <= cutoff)
    // is applied in JS so the started_at-null fallback stays portable across
    // SQLite + Postgres (no COALESCE-in-WHERE dialect divergence).
    const candidates = await this.runRepo.find({
      where: { status: In(NON_TERMINAL) },
      order: { created_at: 'ASC' },
      take: QA_RUN_REAPER_BATCH,
    });

    const reaped: string[] = [];
    for (const run of candidates) {
      const startedAt = run.started_at ?? run.created_at;
      if (!startedAt || startedAt.getTime() > cutoff.getTime()) continue; // still within TTL
      try {
        const ageMin = Math.round((now.getTime() - startedAt.getTime()) / 60_000);
        run.status = 'error';
        run.finished_at = now;
        const marker =
          `[auto-reaped by QaRunReaperService] no terminal status within ${Math.round(this.ttlMs / 60_000)} min ` +
          `(ran for ~${ageMin} min); the QA agent or its backing build/drive job is presumed dead. ` +
          `This is NOT a tested failure — re-run the scenario.`;
        run.summary = run.summary ? `${marker}\n\n${run.summary}` : marker;
        await this.runRepo.save(run);
        reaped.push(run.id);
      } catch (e) {
        this.logService.warn('QaReaper', 'per-run reap failed (continuing)', { err: String(e), run_id: run.id });
      }
    }

    if (reaped.length > 0) {
      this.logService.info('QaReaper', 'reaped stale runs', { count: reaped.length, ttl_ms: this.ttlMs, run_ids: reaped });
    }
    return { reaped };
  }
}
