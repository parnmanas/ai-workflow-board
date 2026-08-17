/**
 * QaRunBatchReaperService — background sweep that resumes any QaRunBatch
 * wedged `running` with no live run at its current index, independent of
 * whether a QaSchedule is tracking it (ticket 5a0593ae).
 *
 * Why this exists: QaRunService.resumeWedgedBatch (ticket a51ec6d9 review
 * round 2) closes the wedge left by a transient RunBudgetExceededError
 * mid-batch — but ONLY for a batch a QaSchedule still points at via
 * last_batch_id, driven from QaScheduleService.runOnce's SKIP-if-running
 * branch. Three classes of `running` QaRunBatch never reach that branch and
 * so never get resumed:
 *   - ad-hoc batches dispatched directly via start_qa_batch (MCP) — no
 *     QaSchedule ever existed for them (this ticket's original gap).
 *   - a batch orphaned when its owning schedule's last_batch_id is
 *     overwritten by a later dispatch (e.g. run_qa_schedule_now, which
 *     starts a fresh batch without checking SKIP/RESUME first).
 *   - a batch whose owning schedule has enabled=false — runOnce's due query
 *     filters on enabled:true, so the schedule (and its wedged batch) is
 *     never swept.
 * All three share ONE signature, independent of any schedule:
 * `status='running' AND !run_ids[current_index]` — exactly the predicate
 * QaRunService.resumeWedgedBatch already uses. This reaper finds that
 * signature schedule-agnostically and drives the SAME resume entry point,
 * so there remains exactly one place that decides how to un-wedge a batch.
 *
 * Pattern mirrors the sibling QA/Action/Orchestration reapers: OnModuleInit
 * plants a plain unref'd setInterval (no @Cron dep), an immediate boot sweep
 * clears standing phantoms within seconds of a deploy, runOnce() is public
 * for tests/the operator endpoint, and a `sweeping` flag drops an overlapping
 * tick instead of letting two sweeps race (mirrors ActionRunReaperService /
 * OrchestrationReaperService). Unlike those reapers this one never mutates a
 * run's terminal status or reaps anything by age — "resuming" here means
 * re-attempting the exact dispatch resumeWedgedBatch already performs, which
 * is itself guarded against a batch that is still genuinely in-flight (a live
 * run recorded at current_index, or another entry point mid-dispatch — see
 * QaRunService's `_inFlightBatchIds` guard), so sweeping a batch that was
 * never actually wedged is always a safe no-op.
 *
 * Sweep default is shorter than the sibling TTL reapers (5m vs the 15-30m
 * QA/Action run reapers use): those wait out a fixed TTL before killing
 * something, but this reaper is racing the run-budget window's own clear
 * (default 1h, Workspace.hard_budget_config) to retry a cheap, side-effect-
 * free dispatch — a shorter cadence recovers sooner at negligible cost when
 * nothing is actually wedged.
 *
 * Env: QA_BATCH_REAPER_ENABLED (default on), QA_BATCH_REAPER_SWEEP_MS
 * (default 5m, clamped 1m..1h).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QaRunBatch } from '../../entities/QaRunBatch';
import { LogService } from '../../services/log.service';
import { QaRunService } from './qa-run.service';

const DEFAULT_SWEEP_MS = 5 * 60_000;  // 5 minutes
const MIN_SWEEP_MS = 60_000;          // 1 minute
const MAX_SWEEP_MS = 60 * 60_000;     // 1 hour
const QA_BATCH_REAPER_BATCH = 200;

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class QaRunBatchReaperService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly sweepMs = clampEnv('QA_BATCH_REAPER_SWEEP_MS', DEFAULT_SWEEP_MS, MIN_SWEEP_MS, MAX_SWEEP_MS);
  private readonly enabled = (process.env.QA_BATCH_REAPER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(QaRunBatch) private readonly batchRepo: Repository<QaRunBatch>,
    private readonly logService: LogService,
    private readonly qaRunService: QaRunService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('QaBatchReaper', 'disabled via QA_BATCH_REAPER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('QaBatchReaper', 'tick failed', { err: String(e) });
      });
    }, this.sweepMs);
    // Don't keep the event loop alive on the timer alone (mirrors the other sweeps).
    this.tickHandle.unref?.();
    this.logService.info('QaBatchReaper', 'Service initialized', { sweep_ms: this.sweepMs });
    // Immediate boot sweep: a deploy/restart resumes any standing wedge within
    // seconds instead of idling up to a full sweep interval. Fire-and-forget so
    // a slow/failed first sweep never blocks module init.
    this.runOnce().catch((e: unknown) => {
      this.logService.error('QaBatchReaper', 'boot sweep failed', { err: String(e) });
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One sweep. Public so a test / operator endpoint can drive it
   * deterministically. Safe to call concurrently — an overlapping call is
   * dropped (mirrors ActionRunReaperService/OrchestrationReaperService).
   */
  async runOnce(): Promise<{ resumed: string[] }> {
    if (this.sweeping) return { resumed: [] };
    this.sweeping = true;
    try {
      const candidates = await this.batchRepo.find({
        where: { status: 'running' },
        order: { created_at: 'ASC' },
        take: QA_BATCH_REAPER_BATCH,
      });
      if (candidates.length === 0) return { resumed: [] };

      const resumed: string[] = [];
      for (const batch of candidates) {
        // Same wedge signature resumeWedgedBatch checks internally — filtered
        // here too so `resumed` reflects batches this sweep actually attempted,
        // not every batch that merely happens to be `running`.
        const runIds = Array.isArray(batch.run_ids) ? batch.run_ids : [];
        if (runIds[batch.current_index]) continue; // live run already dispatched — not wedged
        try {
          await this.qaRunService.resumeWedgedBatch(batch.id);
          resumed.push(batch.id);
        } catch (e) {
          this.logService.warn('QaBatchReaper', 'per-batch resume failed (continuing)', { err: String(e), batch_id: batch.id });
        }
      }

      if (resumed.length > 0) {
        this.logService.info('QaBatchReaper', 'resumed wedged batches', { count: resumed.length, resumed });
      }
      return { resumed };
    } finally {
      this.sweeping = false;
    }
  }
}
