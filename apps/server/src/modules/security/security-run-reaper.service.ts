/**
 * SecurityRunReaperService — background sweep that fails SecurityRuns whose
 * inspection agent died without ever calling complete_security_run, so the board
 * can't display a run as `running` forever.
 *
 * Direct analogue of QaRunReaperService (see qa-run-reaper.service.ts). A
 * SecurityRun is created with status='running' and only moves to a terminal
 * status when the agent calls completeRun(). If that agent dies mid-inspection,
 * nothing ever stamps a terminal status — the run sits `running` indefinitely.
 *
 * Pattern mirrors TicketArchiverService / QaRunReaperService: OnModuleInit plants
 * a plain setInterval (no @Cron, no scheduler dep), torn down on destroy.
 *
 * Per-tick mechanics:
 *   1. Select SecurityRuns with status IN ('running','pending') whose age —
 *      measured from started_at, falling back to created_at — exceeds the TTL.
 *   2. Stamp status='error', finished_at=now, and prepend a clear marker to the
 *      summary so the board row reads as a reaped run, not a genuine failure.
 *   3. Capped at SECURITY_RUN_REAPER_BATCH per tick.
 *
 * Idempotent: a reaped run is terminal, so the next sweep's SELECT skips it.
 * Env: SECURITY_RUN_REAPER_ENABLED (default on), SECURITY_RUN_REAPER_SWEEP_MS
 * (default 30m, clamped 1m..24h), SECURITY_RUN_TTL_MS (default 6h, clamped
 * 5m..7d).
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SecurityRun } from '../../entities/SecurityRun';
import { LogService } from '../../services/log.service';
import { SecurityRunService } from './security-run.service';

const DEFAULT_SWEEP_MS = 30 * 60_000; // 30 minutes
const MIN_SWEEP_MS = 60_000;          // 1 minute
const MAX_SWEEP_MS = 24 * 60 * 60_000; // 24 hours
const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6 hours
const MIN_TTL_MS = 5 * 60_000;          // 5 minutes
const MAX_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days
const SECURITY_RUN_REAPER_BATCH = 200;
const NON_TERMINAL: SecurityRun['status'][] = ['running', 'pending'];

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class SecurityRunReaperService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly sweepMs = clampEnv('SECURITY_RUN_REAPER_SWEEP_MS', DEFAULT_SWEEP_MS, MIN_SWEEP_MS, MAX_SWEEP_MS);
  private readonly ttlMs = clampEnv('SECURITY_RUN_TTL_MS', DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
  private readonly enabled = (process.env.SECURITY_RUN_REAPER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(SecurityRun) private readonly runRepo: Repository<SecurityRun>,
    private readonly logService: LogService,
    private readonly runService: SecurityRunService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('SecurityReaper', 'disabled via SECURITY_RUN_REAPER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('SecurityReaper', 'tick failed', { err: String(e) });
      });
    }, this.sweepMs);
    // Don't keep the event loop alive on the timer alone (mirrors the other sweeps).
    this.tickHandle.unref?.();
    this.logService.info('SecurityReaper', 'Service initialized', { sweep_ms: this.sweepMs, ttl_ms: this.ttlMs });
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
      take: SECURITY_RUN_REAPER_BATCH,
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
          `[auto-reaped by SecurityRunReaperService] no terminal status within ${Math.round(this.ttlMs / 60_000)} min ` +
          `(ran for ~${ageMin} min); the inspection agent is presumed dead. ` +
          `This is NOT a confirmed pass/fail — re-run the inspection.`;
        run.summary = run.summary ? `${marker}\n\n${run.summary}` : marker;
        await this.runRepo.save(run);
        reaped.push(run.id);
        // If this dead run belonged to a sequential batch, advance the batch from
        // here too (terminal-status reached, just not via complete_security_run).
        // Never let a batch hiccup abort the sweep.
        await this.runService.onRunFinalized(run).catch((e) =>
          this.logService.warn('SecurityReaper', 'batch advance after reap failed (continuing)', { err: String(e), run_id: run.id }),
        );
      } catch (e) {
        this.logService.warn('SecurityReaper', 'per-run reap failed (continuing)', { err: String(e), run_id: run.id });
      }
    }

    if (reaped.length > 0) {
      this.logService.info('SecurityReaper', 'reaped stale runs', { count: reaped.length, ttl_ms: this.ttlMs, run_ids: reaped });
    }
    return { reaped };
  }
}
