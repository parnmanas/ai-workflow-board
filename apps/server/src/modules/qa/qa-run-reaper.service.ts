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
 * Pluggable liveness (ticket 40010b25): a single global "age > TTL" rule broke
 * both ways across boards (false-reaped live-but-slow runs; let dead drives sit
 * `running` once a single token was recorded). "Dead" is board-specific, so the
 * per-run reap decision is now delegated to a registered LivenessDetector
 * (qa-liveness-policy.ts) resolved from the run's scenario- then board-level
 * `liveness_policy`. A run with no policy resolves to the built-in
 * `zero_progress` detector — whose behavior is identical to the pre-ticket
 * reaper, so every existing board is regression-safe.
 *
 * The default `zero_progress` detector keeps the pre-ticket TWO FUSES (a run is
 * reaped when EITHER trips):
 *   • zero-progress — ZERO steps recorded and age past QA_RUN_ZERO_PROGRESS_MS
 *     (default 40m). The fast fuse for the common rot: a run that started but its
 *     backing build/drive job died before a single step landed. A run that
 *     recorded ≥1 step is treated as progressing and waits for the TTL below.
 *   • 6h-TTL (absolute) — age past QA_RUN_TTL_MS (default 6h) regardless of step
 *     count; the backstop for a run that DID make progress then stalled.
 * Boards that need a different liveness signal (e.g. GameClient's disk-artifact
 * heartbeat) opt into the `heartbeat_deadline` policy instead.
 *
 * Per-tick mechanics:
 *   1. Select NON-TERMINAL QaRuns (status IN ('running','pending')), oldest
 *      first, capped at QA_RUN_REAPER_BATCH.
 *   2. Bulk-resolve each run's liveness policy (one scenario + one board query
 *      for the whole batch), then ask its detector whether the run is dead.
 *   3. For each run the detector condemns, stamp status='error', finished_at=now,
 *      prepend the detector's reason as a clear marker so the board row reads as
 *      a reaped run (distinguishing "infra death" from a tested failure), and —
 *      if the run belonged to a sequential batch — advance that batch.
 *
 * Activation: OnModuleInit runs ONE immediate sweep before planting the periodic
 * timer, so a deploy/restart clears any standing phantom within seconds instead
 * of waiting up to a full sweep interval. runOnce() is also public so an operator
 * can fire a sweep on demand via POST /api/qa/runs/reap (no restart needed).
 *
 * Idempotent: a reaped run is terminal, so the next sweep's SELECT skips it.
 * Env: QA_RUN_REAPER_ENABLED (default on), QA_RUN_REAPER_SWEEP_MS (default 30m,
 * clamped 1m..24h), QA_RUN_TTL_MS (default 6h, clamped 5m..7d — the `zero_progress`
 * absolute backstop), QA_RUN_ZERO_PROGRESS_MS (default 40m, clamped 1m..6h — the
 * `zero_progress` fast fuse).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QaRun } from '../../entities/QaRun';
import { QaScenario } from '../../entities/QaScenario';
import { Board } from '../../entities/Board';
import { LogService } from '../../services/log.service';
import { QaRunService } from './qa-run.service';
import {
  LivenessPolicy,
  getLivenessDetector,
  resolveLivenessPolicy,
} from './qa-liveness-policy';
import { QaPhasesConfig, resolveQaPhases } from './qa-phases';

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
    @InjectRepository(QaScenario) private readonly scenarioRepo: Repository<QaScenario>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
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
    details: Array<{ id: string; reason: string; age_min: number }>;
  }> {
    // Candidate non-terminal runs. The liveness decision (age / heartbeat
    // staleness) is computed in JS per policy so the started_at-null fallback and
    // the heartbeat baseline stay portable across SQLite + Postgres (no
    // COALESCE-in-WHERE dialect divergence).
    const candidates = await this.runRepo.find({
      where: { status: In(NON_TERMINAL) },
      order: { created_at: 'ASC' },
      take: QA_RUN_REAPER_BATCH,
    });
    if (candidates.length === 0) return { reaped: [], details: [] };

    const resolveForRun = await this._buildPolicyResolver(candidates);
    const baseCtx = { now, defaultTtlMs: this.ttlMs, defaultZeroProgressMs: this.zeroProgressMs };

    const reaped: string[] = [];
    const details: Array<{ id: string; reason: string; age_min: number }> = [];
    for (const run of candidates) {
      try {
        const { policy, phases } = resolveForRun(run);
        // Unknown type can only happen if a registered detector was removed after
        // a board stored its policy; fall back to zero_progress so the run is
        // still subject to the TTL backstop rather than becoming immortal.
        const detector = getLivenessDetector(policy.type) ?? getLivenessDetector('zero_progress');
        // Per-run ctx: phases is the only per-run field (the `phase_timeouts`
        // detector reads it); the rest of baseCtx is shared across the sweep.
        const reason = detector ? detector.evaluate(run, policy, { ...baseCtx, phases }) : null;
        if (!reason) continue;

        const startedAt = run.started_at ?? run.created_at;
        const ageMin = startedAt
          ? Math.round((now.getTime() - new Date(startedAt).getTime()) / 60_000)
          : 0;
        run.status = 'error';
        run.finished_at = now;
        const marker = `[auto-reaped by QaRunReaperService] ${reason}`;
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

  /**
   * Bulk-resolve the liveness policy AND QA phase model for every candidate run
   * with a single scenario query + single board query (no per-run N+1). The phase
   * model (scenario.qa_phases ?? board.qa_phases) is resolved alongside the policy
   * so the `phase_timeouts` detector can be auto-selected when phases are defined
   * and no explicit liveness_policy overrides it. The board is taken from the
   * run's own board_id, falling back to the scenario's board_id (workspace-scoped
   * runs carry a null board_id but their scenario may still be board-pinned).
   */
  private async _buildPolicyResolver(
    runs: QaRun[],
  ): Promise<(run: QaRun) => { policy: LivenessPolicy; phases: QaPhasesConfig | null }> {
    const scenarioIds = [...new Set(runs.map((r) => r.scenario_id).filter(Boolean))];
    const scenarios = scenarioIds.length
      ? await this.scenarioRepo.find({ where: { id: In(scenarioIds) } })
      : [];
    const scenarioById = new Map(scenarios.map((s) => [s.id, s]));

    const boardIds = new Set<string>();
    for (const r of runs) if (r.board_id) boardIds.add(r.board_id);
    for (const s of scenarios) if (s.board_id) boardIds.add(s.board_id);
    const boards = boardIds.size ? await this.boardRepo.find({ where: { id: In([...boardIds]) } }) : [];
    const boardById = new Map(boards.map((b) => [b.id, b]));

    return (run: QaRun): { policy: LivenessPolicy; phases: QaPhasesConfig | null } => {
      const scenario = scenarioById.get(run.scenario_id);
      const boardId = run.board_id ?? scenario?.board_id ?? null;
      const board = boardId ? boardById.get(boardId) : undefined;
      const phases = resolveQaPhases(scenario?.qa_phases ?? null, board?.qa_phases ?? null);
      const policy = resolveLivenessPolicy(
        scenario?.liveness_policy ?? null,
        board?.liveness_policy ?? null,
        phases,
      );
      return { policy, phases };
    };
  }
}
