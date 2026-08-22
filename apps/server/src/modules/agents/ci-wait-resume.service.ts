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
 * Two-phase resolve/deliver (ticket 778b6dc7 review round 1, P0 fix):
 *
 *   Phase 1 — `_recordOutcome`: once a run resolves (success/failure) or the
 *   wait times out or the context is corrupt, atomically CAS-stamp an
 *   `outcome` onto `ci_wait_context` via `CiWaitService.tryRecordOutcome`.
 *   This does NOT touch `pending_ci_wait` — the ticket stays a sweep
 *   candidate. A crash right after this succeeds is free to retry: the next
 *   sweep finds `ctx.outcome` already set and skips straight to phase 2,
 *   no GitHub re-poll needed.
 *
 *   Phase 2 — `_deliver`: idempotent comment (checked by a stable
 *   `resolved_at` marker embedded in the comment body — skipped if already
 *   posted) + `dispatchCurrentColumn`. Only once BOTH have been attempted
 *   does `CiWaitService.markDelivered` clear `pending_ci_wait`. If either
 *   step throws, delivery returns early WITHOUT clearing the flag — the
 *   next sweep retries phase 2 alone (comment idempotency prevents a
 *   duplicate post; a redundant `dispatchCurrentColumn` call is itself safe
 *   because the trigger loop's live-twin dispatch-suppression layer absorbs
 *   a repeat wake for a ticket already mid-dispatch — see this ticket's own
 *   audit trail for that mechanism firing in practice).
 *
 * Splitting "resolution is a fact" from "delivery has happened" is what
 * makes a crash/exception ANYWHERE in the chain retryable instead of a
 * silent, permanent loss of the resume — the exact failure mode ticket
 * 778b6dc7 exists to eliminate, this time for its own fix.
 *
 * Bounded wait: a run that never reaches a terminal status (deleted
 * workflow, stuck queue, wrong run id) would otherwise hang the ticket
 * forever — `CI_WAIT_MAX_AGE_MS` (default 6h) gives up, records a timeout
 * outcome, and resumes the ticket with an explanatory comment so a
 * human/agent can re-dispatch or escalate instead of the ticket silently
 * never coming back.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { LogService } from '../../services/log.service';
import { GitHubConnectorService, GitHubWorkflowRun } from '../../services/github-connector.service';
import { CiWaitService, parseCiWaitContext, CiWaitContext, CiWaitOutcome } from '../tickets/ci-wait.service';
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

const EMPTY_CONTEXT_BASE = { owner: '', repo: '', run_id: '', head_sha: '', html_url: '', registered_by: '', registered_at: '' };

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
    const rawContext = ticket.ci_wait_context;
    const ctx = parseCiWaitContext(rawContext);

    if (ctx?.outcome) {
      // Already resolved by this or an earlier (possibly crashed-before-
      // delivering) sweep — skip straight to delivery, no GitHub call.
      await this._deliver(ticket, ctx, stats);
      return;
    }

    if (!ctx) {
      // Flagged but unparseable/incomplete context — nothing to poll.
      // Record an error outcome (phase 1) so delivery is retryable exactly
      // like every other path, rather than resolving it in one step.
      const outcome: CiWaitOutcome = {
        kind: 'error',
        message: 'CI 대기 컨텍스트가 손상되어(파싱 불가) 대기를 해제합니다. 상태를 직접 확인한 뒤 필요하면 `await_ci_run`을 다시 등록하세요.',
        resolved_at: new Date(nowMs).toISOString(),
      };
      const fresh: CiWaitContext = { ...EMPTY_CONTEXT_BASE, outcome };
      const won = await this.ciWaitService.tryRecordOutcome(ticket.id, rawContext, JSON.stringify(fresh));
      if (!won) return; // another sweep already recorded it — it handles delivery
      await this._deliver(ticket, fresh, stats);
      return;
    }

    const registeredAtMs = Date.parse(ctx.registered_at);
    const ageMs = Number.isFinite(registeredAtMs) ? nowMs - registeredAtMs : this.config.maxAgeMs;
    if (ageMs >= this.config.maxAgeMs) {
      const outcome: CiWaitOutcome = {
        kind: 'timeout',
        message: `⏱️ **CI 대기 타임아웃** — ${ctx.owner}/${ctx.repo} run ${ctx.run_id}이(가) ` +
          `${Math.round(this.config.maxAgeMs / 3_600_000)}시간 동안 완료되지 않아 대기를 해제합니다. ` +
          `직접 run 상태를 확인한 뒤 재-dispatch 하거나, 필요하면 \`pend_ticket\`으로 사람에게 넘기세요.`,
        resolved_at: new Date(nowMs).toISOString(),
      };
      const nextCtx: CiWaitContext = { ...ctx, outcome };
      const won = await this.ciWaitService.tryRecordOutcome(ticket.id, rawContext, JSON.stringify(nextCtx));
      if (!won) return;
      stats.timed_out++;
      await this._deliver(ticket, nextCtx, stats);
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

    const outcome: CiWaitOutcome = {
      kind: 'resolved',
      message: this._formatResolvedMessage(ctx, run),
      resolved_at: new Date(nowMs).toISOString(),
    };
    const nextCtx: CiWaitContext = { ...ctx, outcome };
    const won = await this.ciWaitService.tryRecordOutcome(ticket.id, rawContext, JSON.stringify(nextCtx));
    if (!won) return; // lost the race — the winner (or a future sweep) delivers
    await this._deliver(ticket, nextCtx, stats);
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

  /**
   * Phase 2 — idempotent delivery. Safe to call more than once for the same
   * `ctx.outcome` (retried after a crash, or reached redundantly by a sweep
   * that lost the phase-1 CAS but still holds a stale in-memory ticket —
   * the ONLY caller that matters is the sweep that just won `tryRecordOutcome`,
   * but this method's own idempotency makes a redundant call harmless too).
   */
  private async _deliver(ticket: Ticket, ctx: CiWaitContext, stats: CiWaitSweepStats): Promise<void> {
    const outcome = ctx.outcome;
    if (!outcome) return; // defensive — callers always pass a context with outcome set

    const marker = `<!-- ci-wait-resolved:${outcome.resolved_at} -->`;
    const alreadyPosted = await this._hasResolutionComment(ticket.id, marker);
    if (!alreadyPosted) {
      try {
        const commentRepo = this.dataSource.getRepository(Comment);
        await commentRepo.save(commentRepo.create({
          ticket_id: ticket.id,
          workspace_id: ticket.workspace_id || '',
          author_type: 'system',
          author_id: '',
          author: 'CiWaitResumeService',
          content: `${outcome.message}\n${marker}`,
          type: 'note',
        }));
      } catch (e) {
        this.logService.warn('CI', 'ci-wait resolution comment write failed (will retry next sweep — pending_ci_wait stays set)', {
          err: String(e), ticket_id: ticket.id,
        });
        return; // do NOT mark delivered — retry the whole delivery next sweep
      }
    }

    if (outcome.kind === 'resolved') stats.resolved++;

    try {
      await this.triggerLoopService.dispatchCurrentColumn(ticket.id, 'ci_wait_resolved', 'system');
    } catch (e) {
      this.logService.warn('CI', 'ci-wait resume dispatch failed (will retry next sweep — pending_ci_wait stays set; comment already posted so it will not duplicate)', {
        err: String(e), ticket_id: ticket.id,
      });
      return; // do NOT mark delivered — retry just the dispatch next sweep
    }

    // Only now — comment ensured + dispatch attempted — is the wait truly
    // over. A racing cancel_ci_wait or a second delivery attempt that
    // already won this CAS both no-op safely against this call.
    await this.ciWaitService.markDelivered(ticket.id);
  }

  private async _hasResolutionComment(ticketId: string, marker: string): Promise<boolean> {
    const commentRepo = this.dataSource.getRepository(Comment);
    const existing = await commentRepo.find({
      where: { ticket_id: ticketId, author: 'CiWaitResumeService' },
    });
    return existing.some((c) => c.content.includes(marker));
  }
}
