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
 * Delivery design (review rounds 1 and 2 — read this before touching
 * `_deliver`): a resolved wait must be delivered (comment + dispatch)
 * EXACTLY ONCE even though delivery isn't one atomic operation, and even
 * though a crash can land between any two of its steps. The fix is a
 * lease-based durable outbox living directly in `ci_wait_context.outcome` —
 * the same `lease_owner`/`lease_expires_at`/CAS-with-generation shape
 * `DispatchIntentService.claimForDispatch` already uses for the analogous
 * "durable, crash-recoverable dispatch tracking" problem elsewhere in this
 * codebase:
 *
 *   1. `tryUpdateContext` records the outcome (phase 1) WITHOUT touching
 *      `pending_ci_wait` — a crash here is free to retry, no GitHub re-poll
 *      needed (round 1 P0 fix).
 *   2. `_deliver` first checks the in-memory `lease_expires_at`: if another
 *      attempt's lease is still fresh, this sweep does nothing (round 2
 *      finding — outcome-present alone used to send EVERY sweep straight
 *      into comment+dispatch with no coordination between them). Otherwise
 *      it CAS-claims (or reclaims an expired) lease, bumping
 *      `delivery_generation` and stamping a fresh `lease_owner`+expiry.
 *      Only the CAS winner proceeds.
 *   3. Comment and dispatch are each guarded by their OWN durable flag
 *      (`comment_posted` / `dispatch_done`), flipped via `tryUpdateContext`
 *      immediately after the side effect actually succeeds — never before
 *      (that would durably claim something that didn't happen), and a
 *      failure at either step returns without flipping anything, leaving
 *      the lease to expire so a LATER sweep retries from exactly where this
 *      one left off (round 2's "comment succeeded, dispatch failed" +
 *      "crash after claim" scenarios).
 *   4. `markDelivered` (the ONLY thing that clears `pending_ci_wait`) fires
 *      once both flags are true, CAS'd on the EXACT context this delivery
 *      just finished with — not just `pending_ci_wait: true` — so a stale
 *      in-flight delivery can never clear a brand-new wait that raced in
 *      via cancel + re-register while it was working (round 2 finding).
 *
 * Residual risk, stated plainly rather than overclaimed: the window between
 * "`dispatchCurrentColumn` returns successfully" and "the `dispatch_done`
 * CAS write lands" is not literally atomic (no side effect that crosses a
 * process boundary can be). A crash in that specific sub-window causes AT
 * MOST ONE redundant re-dispatch on the eventual retry — bounded, not
 * repeating, and itself absorbed by `TriggerLoopService`'s existing
 * per-(ticket,role) intent upsert + live-twin suppression. This is the same
 * trade-off `DispatchIntentService` itself makes (an `applyManagerAck`
 * "processed" outcome is explicitly NOT resolution, only a deadline
 * extension) — no durable system can make an external side effect and its
 * own bookkeeping perfectly atomic; the goal here is bounding the gap, not
 * pretending it doesn't exist.
 *
 * Bounded wait: a run that never reaches a terminal status (deleted
 * workflow, stuck queue, wrong run id) would otherwise hang the ticket
 * forever — `CI_WAIT_MAX_AGE_MS` (default 6h) gives up, records a timeout
 * outcome, and resumes the ticket with an explanatory comment so a
 * human/agent can re-dispatch or escalate instead of the ticket silently
 * never coming back.
 */
import { randomUUID } from 'crypto';
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

  /** Delivery lease TTL — comfortably shorter than the sweep interval, so a
   *  genuinely crashed attempt's lease has already expired by the time the
   *  next scheduled sweep runs, without needing a second independent env
   *  var to keep in sync. */
  private get deliveryLeaseMs(): number {
    return Math.max(30_000, Math.floor(this.config.sweepMs * 0.75));
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

  private _freshOutcome(kind: CiWaitOutcome['kind'], message: string, nowMs: number): CiWaitOutcome {
    return {
      kind, message, resolved_at: new Date(nowMs).toISOString(),
      delivery_generation: 0, lease_owner: '', lease_expires_at: '',
      comment_posted: false, dispatch_done: false,
    };
  }

  private async _evaluateOne(ticket: Ticket, nowMs: number, stats: CiWaitSweepStats): Promise<void> {
    const rawContext = ticket.ci_wait_context;
    const ctx = parseCiWaitContext(rawContext);

    if (ctx?.outcome) {
      // Already resolved by this or an earlier (possibly crashed-before-
      // fully-delivering) attempt — skip straight to delivery, no GitHub call.
      await this._deliver(ticket, rawContext, ctx, nowMs, stats);
      return;
    }

    if (!ctx) {
      // Flagged but unparseable/incomplete context — nothing to poll.
      // Record an error outcome (phase 1) so delivery is retryable exactly
      // like every other path, rather than resolving it in one step.
      const outcome = this._freshOutcome(
        'error',
        'CI 대기 컨텍스트가 손상되어(파싱 불가) 대기를 해제합니다. 상태를 직접 확인한 뒤 필요하면 `await_ci_run`을 다시 등록하세요.',
        nowMs,
      );
      const fresh: CiWaitContext = { ...EMPTY_CONTEXT_BASE, outcome };
      const freshJson = JSON.stringify(fresh);
      const won = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, freshJson);
      if (!won) return; // another sweep already recorded it — it handles delivery
      await this._deliver(ticket, freshJson, fresh, nowMs, stats);
      return;
    }

    const registeredAtMs = Date.parse(ctx.registered_at);
    const ageMs = Number.isFinite(registeredAtMs) ? nowMs - registeredAtMs : this.config.maxAgeMs;
    if (ageMs >= this.config.maxAgeMs) {
      const outcome = this._freshOutcome(
        'timeout',
        `⏱️ **CI 대기 타임아웃** — ${ctx.owner}/${ctx.repo} run ${ctx.run_id}이(가) ` +
          `${Math.round(this.config.maxAgeMs / 3_600_000)}시간 동안 완료되지 않아 대기를 해제합니다. ` +
          `직접 run 상태를 확인한 뒤 재-dispatch 하거나, 필요하면 \`pend_ticket\`으로 사람에게 넘기세요.`,
        nowMs,
      );
      const nextCtx: CiWaitContext = { ...ctx, outcome };
      const nextJson = JSON.stringify(nextCtx);
      const won = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, nextJson);
      if (!won) return;
      stats.timed_out++;
      await this._deliver(ticket, nextJson, nextCtx, nowMs, stats);
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

    const outcome = this._freshOutcome('resolved', this._formatResolvedMessage(ctx, run), nowMs);
    const nextCtx: CiWaitContext = { ...ctx, outcome };
    const nextJson = JSON.stringify(nextCtx);
    const won = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, nextJson);
    if (!won) return; // lost the race — the winner (or a future sweep) delivers
    await this._deliver(ticket, nextJson, nextCtx, nowMs, stats);
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
   * Delivery — see the class docstring for the full lease/CAS design this
   * implements. `rawContext` MUST be the exact `ci_wait_context` string
   * matching `ctx` (the caller's most recent read or write); every CAS in
   * here is conditioned against it.
   */
  private async _deliver(ticket: Ticket, rawContext: string, ctx: CiWaitContext, nowMs: number, stats: CiWaitSweepStats): Promise<void> {
    const outcome = ctx.outcome;
    if (!outcome) return; // defensive — callers always pass a context with outcome set

    if (outcome.comment_posted && outcome.dispatch_done) {
      // Fully delivered but never cleared (shouldn't normally happen —
      // defensive backstop so a stuck row can still self-heal).
      await this.ciWaitService.markDelivered(ticket.id, rawContext);
      return;
    }

    // Someone else's lease is still fresh — don't race it, just wait for
    // either it to finish (clears pending_ci_wait) or expire (next sweep
    // reclaims). This is the round-2 fix: outcome-present alone used to
    // send EVERY sweep straight into comment+dispatch with zero
    // coordination between them.
    const leaseExpiresMs = outcome.lease_expires_at ? Date.parse(outcome.lease_expires_at) : NaN;
    if (outcome.lease_owner && Number.isFinite(leaseExpiresMs) && leaseExpiresMs > nowMs) {
      return;
    }

    // Claim (or reclaim an expired) lease atomically.
    const claimedOutcome: CiWaitOutcome = {
      ...outcome,
      delivery_generation: outcome.delivery_generation + 1,
      lease_owner: randomUUID(),
      lease_expires_at: new Date(nowMs + this.deliveryLeaseMs).toISOString(),
    };
    const claimedCtx: CiWaitContext = { ...ctx, outcome: claimedOutcome };
    const claimedJson = JSON.stringify(claimedCtx);
    const claimed = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, claimedJson);
    if (!claimed) return; // lost the race to a concurrent sweep or a fresher lease already landed

    let workingJson = claimedJson;
    let workingOutcome = claimedOutcome;

    if (!workingOutcome.comment_posted) {
      const marker = `<!-- ci-wait-resolved:${workingOutcome.resolved_at} -->`;
      try {
        const commentRepo = this.dataSource.getRepository(Comment);
        await commentRepo.save(commentRepo.create({
          ticket_id: ticket.id,
          workspace_id: ticket.workspace_id || '',
          author_type: 'system',
          author_id: '',
          author: 'CiWaitResumeService',
          content: `${workingOutcome.message}\n${marker}`,
          type: 'note',
        }));
      } catch (e) {
        this.logService.warn('CI', 'ci-wait resolution comment write failed — leaving the lease to expire, retried next sweep', {
          err: String(e), ticket_id: ticket.id,
        });
        return;
      }
      const nextOutcome: CiWaitOutcome = { ...workingOutcome, comment_posted: true };
      const nextCtx: CiWaitContext = { ...claimedCtx, outcome: nextOutcome };
      const nextJson = JSON.stringify(nextCtx);
      const won = await this.ciWaitService.tryUpdateContext(ticket.id, workingJson, nextJson);
      if (!won) {
        // We hold the lease — this should not happen. Extremely defensive:
        // stop rather than proceed against state we can no longer trust.
        this.logService.warn('CI', 'ci-wait: unexpected CAS loss right after posting the comment — leaving for next sweep', { ticket_id: ticket.id });
        return;
      }
      workingJson = nextJson;
      workingOutcome = nextOutcome;
      if (outcome.kind === 'resolved') stats.resolved++;
    }

    if (!workingOutcome.dispatch_done) {
      try {
        await this.triggerLoopService.dispatchCurrentColumn(ticket.id, 'ci_wait_resolved', 'system');
      } catch (e) {
        this.logService.warn('CI', 'ci-wait resume dispatch failed — leaving the lease to expire, retried next sweep (comment already posted, will not duplicate)', {
          err: String(e), ticket_id: ticket.id,
        });
        return;
      }
      const nextOutcome: CiWaitOutcome = { ...workingOutcome, dispatch_done: true };
      const nextCtx: CiWaitContext = { ...claimedCtx, outcome: nextOutcome };
      const nextJson = JSON.stringify(nextCtx);
      const won = await this.ciWaitService.tryUpdateContext(ticket.id, workingJson, nextJson);
      if (!won) {
        this.logService.warn('CI', 'ci-wait: unexpected CAS loss right after dispatch — leaving for next sweep', { ticket_id: ticket.id });
        return;
      }
      workingJson = nextJson;
    }

    // Both durable flags are true — delivery is done. Final CAS pinned to
    // the exact context (not just pending_ci_wait: true) so a stale
    // in-flight delivery can never clear a brand-new wait (round 2).
    await this.ciWaitService.markDelivered(ticket.id, workingJson);
  }
}
