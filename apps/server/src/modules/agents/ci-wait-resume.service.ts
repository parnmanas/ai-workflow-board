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
 * Delivery design (review rounds 1-3 — read this before touching
 * `_deliver`): a resolved wait must be delivered (comment + resume dispatch)
 * EXACTLY ONCE even though a crash can land at any point.
 *
 *   1. `tryUpdateContext` (phase 1) records the outcome WITHOUT touching
 *      `pending_ci_wait` — a crash here is free to retry, no GitHub re-poll
 *      needed (round 1 P0 fix).
 *   2. `_deliver` (phase 2 — delivery) calls `CiWaitService.claimDelivery`,
 *      which runs ONE DB transaction that atomically (a) CASes
 *      `pending_ci_wait: true -> false` and (b) — only if that CAS wins —
 *      inserts the resolution comment on the SAME transaction manager.
 *
 *      Round 2 tried to coordinate this with a lease
 *      (`lease_owner`/`lease_expires_at`/`delivery_generation`, mirroring
 *      `DispatchIntentService.claimForDispatch`) plus two separate durable
 *      flags (`comment_posted`/`dispatch_done`) flipped by CAS AFTER each
 *      side effect. Round 3 correctly rejected this: a lease only
 *      coordinates CONCURRENT attempts — it cannot close the window between
 *      "the comment was actually written" and "the flag saying so was
 *      written", because those are two SEPARATE durable writes no matter
 *      how they are sequenced or leased. A crash in that sub-window (or the
 *      lease simply expiring mid-side-effect on a slow write) reliably
 *      reproduces a duplicate.
 *
 *      The actual fix: the comment insert and the `pending_ci_wait` CAS are
 *      not two steps to coordinate — they are ONE local DB transaction
 *      (`CiWaitService.claimDelivery`). A transaction is the one primitive
 *      this codebase has that is genuinely all-or-nothing, so there is no
 *      window left to crash in: either both land, or neither does, and a
 *      retry after a rollback safely redoes both from scratch. As defense
 *      in depth (not the primary guarantee), the comment itself also carries
 *      a globally unique `operational_recurrence_key`
 *      (`ci-wait-resolved:${ticketId}:${resolved_at}`) — the SAME
 *      nullable-unique idempotency column the silent-exit fallback already
 *      uses (`Comment.operational_recurrence_key`) — inserted with
 *      `.orIgnore()` so even a hypothetical second winning transaction for
 *      the same outcome could not produce two comments.
 *
 *   3. The resume DISPATCH (`dispatchCurrentColumn`) is deliberately NOT
 *      inside that transaction — it is a fire-and-forget in-process
 *      EventEmitter emit that crosses to agent-manager over SSE, so it
 *      cannot participate in a local DB transaction, and by the time
 *      `_deliver` reaches it `pending_ci_wait` is ALREADY durably false
 *      (`dispatchCurrentColumn` itself refuses to emit for a still-pending
 *      ticket — trigger-loop.service.ts's `pending_user_action /
 *      pending_on_tickets / pending_ci_wait` gate — so this call MUST run
 *      after the CAS, never before; an earlier draft of this service called
 *      it before clearing the flag and its dispatch was silently always a
 *      no-op against the real gate, a gap the round-2 tests never caught
 *      because they stubbed `dispatchCurrentColumn` without reproducing
 *      that gate). This call is therefore best-effort: if it throws or the
 *      process dies right after the transaction commits, there is no
 *      "resume dispatch" bookkeeping left to lose, because the general
 *      dispatch-durability machinery already owns this ticket the instant
 *      `pending_ci_wait` flips false — `DispatchReconcilerService.
 *      _seedMissingIntents` (dispatch-reconciler.service.ts) scans every
 *      non-terminal, non-archived, non-pending ticket (its own pending
 *      check already includes `pending_ci_wait`, added in this ticket's
 *      round 1) and seeds+dispatches any routed ticket idle past
 *      `seedAfterMs` (default 3 min) with no open `DispatchIntent` for the
 *      role — itself DB-deduped via `dispatch_intents`' partial unique
 *      index. So the guarantee is layered, not hand-waved: AT MOST one
 *      direct dispatch from this call (nothing retries it — this ticket is
 *      no longer in the `pending_ci_wait=true` sweep candidate set), and AT
 *      LEAST one eventual dispatch from the reconciler's independent,
 *      already-hardened idle-seed sweep.
 *
 * Bounded wait: a run that never reaches a terminal status (deleted
 * workflow, stuck queue, wrong run id) would otherwise hang the ticket
 * forever — `CI_WAIT_MAX_AGE_MS` (default 6h) gives up, records a timeout
 * outcome, and resumes the ticket with an explanatory comment so a
 * human/agent can re-dispatch or escalate instead of the ticket silently
 * never coming back.
 *
 * Credential resolution (ticket 9bbe9146): `getWorkflowRun` needs a
 * `credential_id` to authenticate past `GitHubConnectorService`'s env-token
 * fallback (`process.env.GITHUB_TOKEN`, commonly unset — this deployment
 * authenticates via per-Resource stored credentials instead, see
 * `github-tools.ts`'s `sync_github_resource` comment). An earlier version of
 * this service never resolved one at all, so every poll silently degraded
 * to "no token" (`isGitHubDegradableError` → `getWorkflowRun` returns null)
 * and looked EXACTLY like "still queued" — six real Merging tickets sat
 * parked for 1-2h before a human noticed. `_resolveCredentialId` now mirrors
 * `ClaimVerificationService._lookupRemoteSha`'s existing pattern:
 * `Ticket.base_repo_resource_id` → `Resource` (workspace-scope checked) →
 * `Resource.credential_id`. Degrades to null (same as before) when the
 * ticket has no repo binding — never blocks the sweep.
 *
 * Poll-failure surfacing (ticket 9bbe9146): the silent-degrade case above is
 * exactly why a run that cannot be READ at all (thrown error, or degraded
 * to null) is now tracked separately from a run that is legitimately still
 * queued/in_progress (`CiWaitContext.poll_issue`, cleared the instant a poll
 * succeeds). After `CI_WAIT_ALERT_AFTER_FAILURES` consecutive unreadable
 * polls (default 5, ~10 min) `_trackPollFailure` posts ONE ticket comment —
 * the wait stays registered (this is a notification, not a resolution) so
 * the problem is visible long before the 6h timeout, not just at it.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { LogService } from '../../services/log.service';
import { GitHubConnectorService, GitHubWorkflowRun } from '../../services/github-connector.service';
import { CiWaitService, parseCiWaitContext, CiWaitContext, CiWaitOutcome, CiWaitPollIssue } from '../tickets/ci-wait.service';
import { TriggerLoopService } from './trigger-loop.service';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 2 * 60_000,          // 2 min — short, since a ticket is actively parked on this
  MAX_AGE_MS: 6 * 60 * 60_000,   // 6 h — safety valve for a run that never resolves
  ALERT_AFTER_FAILURES: 5,       // ~10 min at the default sweep interval
} as const;

export interface CiWaitResumeConfig {
  enabled: boolean;
  sweepMs: number;
  maxAgeMs: number;
  alertAfterFailures: number;
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
    alertAfterFailures: parseIntEnv(env.CI_WAIT_ALERT_AFTER_FAILURES, DEFAULTS.ALERT_AFTER_FAILURES),
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

  private _freshOutcome(kind: CiWaitOutcome['kind'], message: string, nowMs: number): CiWaitOutcome {
    return { kind, message, resolved_at: new Date(nowMs).toISOString() };
  }

  private async _evaluateOne(ticket: Ticket, nowMs: number, stats: CiWaitSweepStats): Promise<void> {
    const rawContext = ticket.ci_wait_context;
    const ctx = parseCiWaitContext(rawContext);

    if (ctx?.outcome) {
      // Already resolved by this or an earlier (possibly crashed-before-
      // fully-delivering) attempt — skip straight to delivery, no GitHub call.
      await this._deliver(ticket, rawContext, ctx, stats);
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
      await this._deliver(ticket, freshJson, fresh, stats);
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
      await this._deliver(ticket, nextJson, nextCtx, stats);
      return;
    }

    const credentialId = await this._resolveCredentialId(ticket);
    let run: GitHubWorkflowRun | null;
    try {
      run = await this.github.getWorkflowRun(ctx.owner, ctx.repo, ctx.run_id, credentialId);
    } catch (e) {
      stats.fetch_failures++;
      this.logService.warn('CI', 'ci-wait GitHub read failed (will retry next sweep)', {
        err: String(e), ticket_id: ticket.id, owner: ctx.owner, repo: ctx.repo, run_id: ctx.run_id,
      });
      run = null;
    }
    if (!run) {
      // Either the throw above, or GitHubConnectorService's own degrade-to-
      // null (404 / unresolved credential). Either way this sweep learned
      // nothing about the run — track it so a persistently broken
      // credential/run_id surfaces well before CI_WAIT_MAX_AGE_MS instead of
      // retrying in total silence for up to 6h (see class docstring).
      await this._trackPollFailure(ticket, rawContext, ctx, nowMs);
      return;
    }
    if (run.status !== 'completed') {
      // Still running/queued — retry next sweep. This readable poll still
      // clears a stale failure streak, but that is the ONLY mutation this
      // sweep performs, so it is safe as its own CAS against `rawContext`.
      if (ctx.poll_issue) await this._clearPollFailure(ticket, rawContext, ctx);
      return;
    }

    // Run completed — record the resolved outcome AND drop any poll-failure
    // streak in the SAME CAS. Review round 1 (ticket 9bbe9146): these used to
    // be two separate tryUpdateContext calls against the same `rawContext`
    // (clear-streak, then record-outcome) — the second one always lost the
    // CAS because the first had already advanced `ci_wait_context` past
    // `rawContext`, silently deferring delivery to the NEXT sweep and
    // breaking the "resumes within one sweep" guarantee on exactly the
    // recovery-after-failure path this ticket exists to fix.
    const outcome = this._freshOutcome('resolved', this._formatResolvedMessage(ctx, run), nowMs);
    const nextCtx: CiWaitContext = { ...ctx, outcome, poll_issue: undefined };
    const nextJson = JSON.stringify(nextCtx);
    const won = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, nextJson);
    if (!won) return; // lost the race — the winner (or a future sweep) delivers
    await this._deliver(ticket, nextJson, nextCtx, stats);
  }

  /**
   * Resolve this ticket's stored GitHub credential — mirrors
   * `ClaimVerificationService._lookupRemoteSha`'s existing pattern
   * (claim-verification.service.ts) exactly: `Ticket.base_repo_resource_id`
   * → `Resource`, workspace-scope checked so a stale id pointing at another
   * workspace's Resource can never leak that workspace's credential →
   * `Resource.credential_id`. Degrades to null (→ GitHubConnectorService's
   * env-token fallback, same as before this ticket) when the ticket has no
   * repo binding or the Resource is unresolvable — never blocks the sweep.
   */
  private async _resolveCredentialId(ticket: Ticket): Promise<string | null> {
    if (!ticket.base_repo_resource_id || !ticket.workspace_id) return null;
    const resource = await this.dataSource.getRepository(Resource).findOne({ where: { id: ticket.base_repo_resource_id } });
    if (resource && resource.workspace_id !== null && resource.workspace_id !== ticket.workspace_id) return null;
    return resource?.credential_id || null;
  }

  /**
   * Record one more sweep that could not read the run at all (see class
   * docstring's "Poll-failure surfacing"). CAS-conditioned on `rawContext`
   * like every other context mutation in this file — a losing race just
   * means another sweep already recorded (or is recording) the same streak.
   * Posts an alert comment the sweep that crosses `alertAfterFailures`
   * (never resolves/clears the wait — this is a notification, not an
   * outcome).
   */
  private async _trackPollFailure(ticket: Ticket, rawContext: string, ctx: CiWaitContext, nowMs: number): Promise<void> {
    const prior = ctx.poll_issue;
    const consecutiveFailures = (prior?.consecutive_failures || 0) + 1;
    const firstFailureAt = prior?.first_failure_at || new Date(nowMs).toISOString();
    const alreadyAlerted = !!prior?.alerted;
    const shouldAlert = !alreadyAlerted && consecutiveFailures >= this.config.alertAfterFailures;
    const nextIssue: CiWaitPollIssue = {
      consecutive_failures: consecutiveFailures,
      first_failure_at: firstFailureAt,
      alerted: alreadyAlerted || shouldAlert,
    };
    const nextCtx: CiWaitContext = { ...ctx, poll_issue: nextIssue };
    const won = await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, JSON.stringify(nextCtx));
    if (!won || !shouldAlert) return;
    await this._postPollFailureAlert(ticket, ctx, consecutiveFailures, firstFailureAt);
  }

  /** A poll finally succeeded — drop the failure streak entirely so a LATER
   *  unrelated streak starts counting from zero and can alert again. */
  private async _clearPollFailure(ticket: Ticket, rawContext: string, ctx: CiWaitContext): Promise<void> {
    const nextCtx: CiWaitContext = { ...ctx, poll_issue: undefined };
    await this.ciWaitService.tryUpdateContext(ticket.id, rawContext, JSON.stringify(nextCtx));
  }

  /**
   * Best-effort notification comment — deliberately NOT routed through
   * `CiWaitService.claimDelivery` (that CASes `pending_ci_wait` false, which
   * would be wrong here: the wait is still legitimately active, only
   * struggling to read its run). Dedupe key is stable for the whole streak
   * (`firstFailureAt`, not `nowMs`) so a retry after a mid-write crash can
   * never double-post — same `.orIgnore()` idempotency column the resolution
   * comment uses (see `_deliver`).
   */
  private async _postPollFailureAlert(ticket: Ticket, ctx: CiWaitContext, consecutiveFailures: number, firstFailureAt: string): Promise<void> {
    const dedupeKey = `ci-wait-poll-alert:${ticket.id}:${firstFailureAt}`;
    try {
      await this.dataSource.getRepository(Comment)
        .createQueryBuilder()
        .insert()
        .into(Comment)
        .values({
          ticket_id: ticket.id,
          workspace_id: ticket.workspace_id || '',
          author_type: 'system',
          author_id: '',
          author: 'CiWaitResumeService',
          content:
            `⚠️ **CI 대기 폴링 반복 실패** — ${ctx.owner}/${ctx.repo} run ${ctx.run_id} 상태를 ${consecutiveFailures}회 연속(최초 실패 ${firstFailureAt}) 확인하지 못했습니다. ` +
            'GitHub 자격증명(credential) 또는 run_id를 확인하세요. 대기 자체는 계속 유지되며, ' +
            `계속 실패하면 최대 ${Math.round(this.config.maxAgeMs / 3_600_000)}시간 후 타임아웃으로 자동 해제됩니다.`,
          type: 'note',
          operational_recurrence_key: dedupeKey,
        })
        .orIgnore()
        .execute();
    } catch (e) {
      this.logService.warn('CI', 'ci-wait poll-failure alert comment failed', { err: String(e), ticket_id: ticket.id });
    }
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
   * Delivery — see the class docstring for the full transactional-claim
   * design this implements. `rawContext` MUST be the exact `ci_wait_context`
   * string matching `ctx` (the caller's most recent read or write); the
   * claim below is conditioned against it.
   */
  private async _deliver(ticket: Ticket, rawContext: string, ctx: CiWaitContext, stats: CiWaitSweepStats): Promise<void> {
    const outcome = ctx.outcome;
    if (!outcome) return; // defensive — callers always pass a context with outcome set

    // Globally-unique dedupe key for the resolution comment — defense in
    // depth alongside the transaction below (see class docstring). Reuses
    // the SAME nullable-unique idempotency column the silent-exit fallback
    // already uses (Comment.operational_recurrence_key), namespaced so the
    // two sources can never collide.
    const dedupeKey = `ci-wait-resolved:${ticket.id}:${outcome.resolved_at}`;

    let claimed: boolean;
    try {
      claimed = await this.ciWaitService.claimDelivery(ticket.id, rawContext, async (manager) => {
        await manager.getRepository(Comment)
          .createQueryBuilder()
          .insert()
          .into(Comment)
          .values({
            ticket_id: ticket.id,
            workspace_id: ticket.workspace_id || '',
            author_type: 'system',
            author_id: '',
            author: 'CiWaitResumeService',
            content: outcome.message,
            type: 'note',
            operational_recurrence_key: dedupeKey,
          })
          .orIgnore()
          .execute();
      });
    } catch (e) {
      // The whole transaction rolled back — pending_ci_wait is untouched, no
      // comment landed. Safe to retry from scratch next sweep.
      this.logService.warn('CI', 'ci-wait delivery transaction failed — left pending, retried next sweep', {
        err: String(e), ticket_id: ticket.id,
      });
      return;
    }
    if (!claimed) return; // lost the race, or already delivered by an earlier attempt

    if (outcome.kind === 'resolved') stats.resolved++;

    // Best-effort resume dispatch — MUST run after the claim above, never
    // before: dispatchCurrentColumn refuses to emit while pending_ci_wait is
    // still true (trigger-loop.service.ts's pending gate), and by this point
    // it is already durably false. If this call throws or the process dies
    // right here, nothing is lost: this ticket is no longer a sweep
    // candidate, and DispatchReconcilerService's idle-seed sweep
    // (dispatch-reconciler.service.ts) independently guarantees it still
    // gets dispatched — see class docstring for the full reasoning.
    try {
      await this.triggerLoopService.dispatchCurrentColumn(ticket.id, 'ci_wait_resolved', 'system');
    } catch (e) {
      this.logService.warn('CI', 'ci-wait resume dispatch failed — comment already posted and pending_ci_wait already cleared; DispatchReconcilerService idle-seed will still resume the ticket', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }
}
