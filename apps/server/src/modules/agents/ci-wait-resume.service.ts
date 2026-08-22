/**
 * CiWaitResumeService — durable resume for the `await_ci_run` wait (ticket
 * 778b6dc7).
 *
 * Background: the Merging workflow gates landing on a pre-landing
 * `workflow_dispatch` CI run (ticket 34a6281a/623400e7). Waiting for that
 * run to complete inside a live session — `sleep`/`gh run watch`/polling,
 * or worse, misusing the CLI-harness-only `ScheduleWakeup` tool (which has
 * no concept in AWB itself) — has repeatedly ended the session mid-wait
 * (clean exit or crash), leaving the ticket needing a fresh session to
 * rediscover rebase/push/CI state from scratch. `await_ci_run` moves the
 * wait into durable ticket state (`pending_ci_wait` + `ci_wait_context`)
 * instead; this service is the sweep that resolves it.
 *
 * Sibling of `CiHealthMonitorService` / `StuckTicketDetectorService` — same
 * setInterval+unref sweep skeleton — but polls a SPECIFIC registered run per
 * ticket (from `Ticket.ci_wait_context`) rather than scanning a board's
 * recent runs for a red streak. No dedicated alert entity: the wait state
 * already lives directly on the Ticket row, one wait at a time.
 *
 * Resolution claim: `CiWaitService.claimResolved` performs an atomic
 * conditional UPDATE (`WHERE pending_ci_wait = true`) before any side effect
 * (comment + dispatch) runs, so an overlapping sweep tick, a racing
 * `cancel_ci_wait`, or (if ever run with >1 instance) a concurrent process
 * resolves a given ticket's wait exactly once.
 *
 * Bounded wait: a run that never reaches a terminal status (deleted
 * workflow, stuck queue, wrong run id) would otherwise hang the ticket
 * forever — `CI_WAIT_MAX_AGE_MS` (default 6h) gives up, clears the flag, and
 * resumes the ticket with an explanatory comment so a human/agent can
 * re-dispatch or escalate instead of the ticket silently never coming back.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { LogService } from '../../services/log.service';
import { GitHubConnectorService, GitHubWorkflowRun } from '../../services/github-connector.service';
import { CiWaitService, parseCiWaitContext, CiWaitContext } from '../tickets/ci-wait.service';
import { TriggerLoopService } from './trigger-loop.service';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 2 * 60_000,          // 2 min — short, since a ticket is actively parked on this
  MAX_AGE_MS: 6 * 60 * 60_000,   // 6 h — safety valve for a run that never resolves
} as const;

export interface CiWaitResumeConfig {
  enabled: boolean;
  sweepMs: number;
  maxAgeMs: number;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CiWaitResumeConfig {
  const parseIntEnv = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled: parseBool(env.CI_WAIT_ENABLED, DEFAULTS.ENABLED),
    sweepMs: parseIntEnv(env.CI_WAIT_SWEEP_MS, DEFAULTS.SWEEP_MS),
    maxAgeMs: parseIntEnv(env.CI_WAIT_MAX_AGE_MS, DEFAULTS.MAX_AGE_MS),
  };
}

// Exposed for unit tests (mirrors ci-health-monitor.service.ts's __test__).
export const __test__ = { readConfigFromEnv, DEFAULTS };

export interface CiWaitSweepStats {
  scanned: number;
  resolved: number;
  timed_out: number;
  fetch_failures: number;
  skipped_disabled: boolean;
}

type Outcome = { kind: 'resolved' | 'timeout' | 'error'; message: string };

@Injectable()
export class CiWaitResumeService implements OnModuleInit, OnModuleDestroy {
  private readonly config: CiWaitResumeConfig;
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly github: GitHubConnectorService;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly ciWaitService: CiWaitService,
    private readonly triggerLoopService: TriggerLoopService,
  ) {
    this.config = readConfigFromEnv();
    // GitHubConnectorService lives in McpServicesModule, which AgentsModule
    // does not import (avoids a cross-module cycle) — same constraint and
    // same fix as ci-health-monitor.service.ts's constructor.
    this.github = new GitHubConnectorService(this.dataSource);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('CI', 'CiWaitResumeService disabled via CI_WAIT_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('CI', 'ci-wait sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // The tick loop must never keep the process alive on its own — Nest's
    // lifecycle owns shutdown (same unref discipline as every sibling poller;
    // an un-unref'd interval here is the exact bug class that has repeatedly
    // hung `--test-force-exit`-less test runs).
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('CI', 'CI wait resume sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Test helper — read the loaded config so a spec can assert env parsing. */
  getConfig(): CiWaitResumeConfig {
    return { ...this.config };
  }

  /** Public test hook — equivalent to one tick of the internal loop. */
  async sweep(): Promise<CiWaitSweepStats> {
    const stats: CiWaitSweepStats = {
      scanned: 0, resolved: 0, timed_out: 0, fetch_failures: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const candidates = await ticketRepo.find({ where: { pending_ci_wait: true } });
    // Archived tickets are skipped (no point spending a GitHub call on a
    // dead ticket) but not excluded from the query itself — this filter is
    // defensive and self-correcting: an unarchive flips archived_at back to
    // null, so the ticket naturally reappears on the next sweep.
    const live = candidates.filter((t) => !t.archived_at);

    const now = Date.now();
    for (const ticket of live) {
      stats.scanned++;
      try {
        await this._evaluateOne(ticket, now, stats);
      } catch (e) {
        this.logService.warn('CI', 'ci-wait per-ticket evaluation failed (continuing)', {
          err: String(e), ticket_id: ticket.id,
        });
      }
    }
    if (stats.scanned > 0) {
      this.logService.info('CI', 'ci-wait sweep complete', { stats });
    }
    return stats;
  }

  private async _evaluateOne(ticket: Ticket, nowMs: number, stats: CiWaitSweepStats): Promise<void> {
    const ctx = parseCiWaitContext(ticket.ci_wait_context);
    if (!ctx) {
      // Flagged but unparseable/incomplete context — nothing to poll. Treat
      // like a timeout so a corrupt row cannot hang the ticket forever.
      await this._resolveAndResume(ticket, {
        kind: 'error',
        message: 'CI 대기 컨텍스트가 손상되어(파싱 불가) 대기를 해제합니다. 상태를 직접 확인한 뒤 필요하면 `await_ci_run`을 다시 등록하세요.',
      }, stats);
      return;
    }

    const registeredAtMs = Date.parse(ctx.registered_at);
    const ageMs = Number.isFinite(registeredAtMs) ? nowMs - registeredAtMs : this.config.maxAgeMs;
    if (ageMs >= this.config.maxAgeMs) {
      await this._resolveAndResume(ticket, {
        kind: 'timeout',
        message: `⏱️ **CI 대기 타임아웃** — ${ctx.owner}/${ctx.repo} run ${ctx.run_id}이(가) ` +
          `${Math.round(this.config.maxAgeMs / 3_600_000)}시간 동안 완료되지 않아 대기를 해제합니다. ` +
          `직접 run 상태를 확인한 뒤 재-dispatch 하거나, 필요하면 \`pend_ticket\`으로 사람에게 넘기세요.`,
      }, stats);
      stats.timed_out++;
      return;
    }

    let run: GitHubWorkflowRun | null;
    try {
      run = await this.github.getWorkflowRun(ctx.owner, ctx.repo, ctx.run_id);
    } catch (e) {
      stats.fetch_failures++;
      this.logService.warn('CI', 'ci-wait GitHub read failed (will retry next sweep)', {
        err: String(e), ticket_id: ticket.id, owner: ctx.owner, repo: ctx.repo, run_id: ctx.run_id,
      });
      return;
    }
    if (!run) return; // degradable (404 / no token) — retry next sweep, not yet a timeout
    if (run.status !== 'completed') return; // still running/queued — retry next sweep

    await this._resolveAndResume(ticket, { kind: 'resolved', message: this._formatResolvedMessage(ctx, run) }, stats);
  }

  private _formatResolvedMessage(ctx: CiWaitContext, run: GitHubWorkflowRun): string {
    const conclusion = run.conclusion || 'unknown';
    const success = conclusion === 'success';
    const shaNote = ctx.head_sha && run.head_sha && run.head_sha !== ctx.head_sha
      ? ` ⚠️ run의 head_sha(\`${run.head_sha.slice(0, 12)}\`)가 등록된 SHA(\`${ctx.head_sha.slice(0, 12)}\`)와 다릅니다 — 확인이 필요합니다.`
      : '';
    return success
      ? `✅ **CI 대기 완료** — [run 결과](${run.html_url || ''}) \`${conclusion}\`.${shaNote} 이어서 진행하세요.`
      : `⚠️ **CI 대기 완료 — 결과: \`${conclusion}\`** — [run 결과](${run.html_url || ''}).${shaNote} "When to integrate vs. escalate"에 따라 처리하세요(수정 후 재-dispatch, 또는 In Progress로 bounce/pend).`;
  }

  private async _resolveAndResume(ticket: Ticket, outcome: Outcome, stats: CiWaitSweepStats): Promise<void> {
    // Atomic claim BEFORE any side effect — the exactly-once guarantee this
    // service exists to provide. A lost race (cancelled / already claimed by
    // an overlapping tick) is a silent no-op, not an error.
    const claimed = await this.ciWaitService.claimResolved(ticket.id);
    if (!claimed) return;

    try {
      const commentRepo = this.dataSource.getRepository(Comment);
      await commentRepo.save(commentRepo.create({
        ticket_id: ticket.id,
        workspace_id: ticket.workspace_id || '',
        author_type: 'system',
        author_id: '',
        author: 'CiWaitResumeService',
        content: outcome.message,
        type: 'note',
      }));
    } catch (e) {
      this.logService.warn('CI', 'ci-wait resolution comment write failed (resume still applied)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

    if (outcome.kind === 'resolved') stats.resolved++;

    try {
      await this.triggerLoopService.dispatchCurrentColumn(ticket.id, 'ci_wait_resolved', 'system');
    } catch (e) {
      this.logService.warn('CI', 'ci-wait resume dispatch failed (continuing)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }
}
