/**
 * CiWaitService — back-end for the durable "blocked on one external CI run"
 * wait (ticket 778b6dc7).
 *
 * Distinct from `TicketPrerequisitesService` (blocked on another TICKET) and
 * `pending_user_action` (blocked on a HUMAN): this is a 1:1 wait on a single
 * external GitHub Actions run, registered by the `await_ci_run` MCP tool
 * (typically from the Merging workflow's pre-landing `workflow_dispatch`
 * check) and resolved server-side by `CiWaitResumeService`'s poll sweep —
 * no session has to stay alive across the run.
 *
 * Why it exists: a live session blocked on sleep/poll/`gh run watch`/
 * `ScheduleWakeup` for a multi-minute CI matrix has repeatedly died mid-wait
 * (clean exit or crash), leaving the ticket needing manual recovery. Moving
 * the wait into durable DB state (this service) + a background poller
 * (`CiWaitResumeService`) means the wait survives the session that
 * registered it.
 *
 * Mutator surface:
 *   - `registerWait(ticket, ctx, actor)` — set `pending_ci_wait=true` +
 *     `ci_wait_context`. Rejects if a wait is already active (call
 *     `cancelWait` first) so a stale registration is never silently
 *     overwritten. Validates `owner`/`repo`/`run_id`/`head_sha` against
 *     their real external formats — never truncates or silently accepts a
 *     malformed identifier (review round 1, P1).
 *   - `cancelWait(ticket, actor)` — clear both fields. Idempotent.
 *   - `tryUpdateContext(ticketId, expectedPriorContext, nextContextJson)` —
 *     the atomic CAS primitive phase 1 (resolving the wait) uses to record
 *     an outcome without clearing `pending_ci_wait` — see
 *     `CiWaitResumeService`'s docstring for why that separation is the crux
 *     of the review round 1 P0 fix (a crash between "resolved" and
 *     "delivered" must not lose the ticket's sweep-candidate status).
 *   - `claimDelivery(ticketId, expectedContext, withinTx)` — phase 2
 *     (delivery), review round 3's fix. A SINGLE DB transaction that
 *     atomically (a) CASes `pending_ci_wait: true -> false` conditioned on
 *     the exact `ci_wait_context` this delivery attempt is resolving, and
 *     (b) — ONLY if that CAS wins — runs the caller's `withinTx` (the
 *     resolution comment insert) on the SAME transaction manager. Two
 *     SEPARATE durable writes (post the comment, THEN CAS a
 *     `comment_posted` flag) can never fully close the crash-between-them
 *     window no matter how they are sequenced or leased — only wrapping
 *     both in one transaction can, since a transaction is the one
 *     primitive this codebase has that is genuinely all-or-nothing. See
 *     `CiWaitResumeService._deliver` for how the comment insert itself is
 *     ALSO independently idempotent (DB unique constraint on
 *     `Comment.operational_recurrence_key`) — defense in depth, not the
 *     primary guarantee.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { ActivityService } from '../../services/activity.service';
import { isValidRepoRef, isValidGitHubRunId, isValidGitSha } from '../../services/github-connector.service';

export interface CiWaitOutcome {
  kind: 'resolved' | 'timeout' | 'error';
  message: string;
  /** Durable per-resolution identity — set once, never changes. Also the
   *  suffix of the resolution comment's dedupe key (see `_deliver`). */
  resolved_at: string; // ISO timestamp
}

/**
 * Tracks an ONGOING streak of sweeps that learned nothing about the run
 * (GitHub read threw, or degraded to null — no credential resolvable / 404)
 * — ticket 9bbe9146. Distinct from `outcome`: the wait is still legitimately
 * active, this just means recent sweeps could not make progress on it.
 * Cleared entirely the moment a poll succeeds (even "still queued" counts as
 * success here — only the INABILITY to read the run is tracked).
 */
export interface CiWaitPollIssue {
  consecutive_failures: number;
  /** ISO timestamp of the first failure in the CURRENT streak — stable
   *  across retries, doubles as the alert comment's dedupe key suffix. */
  first_failure_at: string;
  /** Set once an alert comment has been posted for this streak, so later
   *  sweeps don't re-attempt it every 2 minutes. */
  alerted: boolean;
}

export interface CiWaitContext {
  owner: string;
  repo: string;
  run_id: string;
  head_sha: string;
  html_url: string;
  registered_by: string;
  registered_at: string; // ISO timestamp
  /** Present once the wait has resolved (success/failure/timeout/malformed)
   *  but delivery (comment + dispatch) may not have completed yet. */
  outcome?: CiWaitOutcome;
  /** Present only while there is an ONGOING run of poll failures. */
  poll_issue?: CiWaitPollIssue;
}

export interface RegisterWaitInput {
  owner: string;
  repo: string;
  run_id: string;
  head_sha?: string;
  html_url?: string;
}

function badRequest(msg: string): Error {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  return e;
}

/** Parses `Ticket.ci_wait_context`; returns null on empty/malformed/incomplete input
 *  so callers (the sweep) can treat a corrupt row the same as a missing one. */
export function parseCiWaitContext(raw: string | null | undefined): CiWaitContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.owner || !parsed.repo || !parsed.run_id) return null;
    const o = parsed.outcome;
    const outcome: CiWaitOutcome | undefined = (o && typeof o === 'object' && o.kind)
      ? {
          kind: o.kind as CiWaitOutcome['kind'],
          message: String(o.message || ''),
          resolved_at: String(o.resolved_at || ''),
        }
      : undefined;
    const pi = parsed.poll_issue;
    const poll_issue: CiWaitPollIssue | undefined = (pi && typeof pi === 'object' && pi.consecutive_failures)
      ? {
          consecutive_failures: Number(pi.consecutive_failures) || 0,
          first_failure_at: String(pi.first_failure_at || ''),
          alerted: !!pi.alerted,
        }
      : undefined;
    return {
      owner: String(parsed.owner),
      repo: String(parsed.repo),
      run_id: String(parsed.run_id),
      head_sha: String(parsed.head_sha || ''),
      html_url: String(parsed.html_url || ''),
      registered_by: String(parsed.registered_by || ''),
      registered_at: String(parsed.registered_at || ''),
      outcome,
      poll_issue,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class CiWaitService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  async registerWait(
    ticketId: string,
    input: RegisterWaitInput,
    opts: { actorId?: string; actorName?: string } = {},
  ): Promise<{ ticket: Ticket }> {
    const tRepo = this.dataSource.getRepository(Ticket);
    const ticket = await tRepo.findOne({ where: { id: ticketId } });
    if (!ticket) throw badRequest('Ticket not found');
    if (ticket.archived_at) throw badRequest('Ticket is archived');
    if (ticket.pending_ci_wait) {
      throw badRequest('Ticket already has an active CI wait registered — call cancel_ci_wait first to replace it');
    }

    const owner = String(input.owner || '').trim();
    const repo = String(input.repo || '').trim();
    const runId = String(input.run_id || '').trim();
    const headShaRaw = input.head_sha != null ? String(input.head_sha).trim() : '';
    if (!isValidRepoRef(owner, repo)) throw badRequest(`Invalid GitHub owner/repo: ${JSON.stringify(owner)}/${JSON.stringify(repo)}`);
    // Full external-format validation (review round 1, P1): never truncate
    // or silently accept a malformed run_id/head_sha — the whole
    // caller-supplied value must satisfy the real GitHub format.
    if (!isValidGitHubRunId(runId)) {
      throw badRequest(`Invalid run_id — must be a decimal GitHub Actions run id (1-20 digits, no leading zero): ${JSON.stringify(input.run_id)}`);
    }
    if (headShaRaw && !isValidGitSha(headShaRaw)) {
      throw badRequest(`Invalid head_sha — must be a full 40-character hex commit SHA: ${JSON.stringify(input.head_sha)}`);
    }
    // GitHub's own head_sha is always lowercase — normalize so the later
    // resolved-run comparison (CiWaitResumeService) isn't a false mismatch
    // purely from case.
    const headSha = headShaRaw.toLowerCase();

    const ctx: CiWaitContext = {
      owner, repo, run_id: runId,
      head_sha: headSha,
      html_url: String(input.html_url || ''),
      registered_by: opts.actorName || '',
      registered_at: new Date().toISOString(),
    };

    ticket.pending_ci_wait = true;
    ticket.ci_wait_context = JSON.stringify(ctx);
    // Same reuse-if-empty convention TicketPrerequisitesService.addPrerequisites
    // uses for pending_reason — never overwrites a hand-authored pend_ticket reason.
    if (!ticket.pending_reason) {
      ticket.pending_reason = `CI 실행 대기 중 — ${owner}/${repo} run ${runId}` +
        (ctx.head_sha ? ` (SHA ${ctx.head_sha.slice(0, 12)})` : '');
    }
    await tRepo.save(ticket);

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'updated',
      field_changed: 'pending_ci_wait', old_value: 'false', new_value: 'true',
      actor_id: opts.actorId, actor_name: opts.actorName || '',
    });

    return { ticket };
  }

  async cancelWait(
    ticketId: string,
    opts: { actorId?: string; actorName?: string } = {},
  ): Promise<{ cancelled: boolean; ticket: Ticket }> {
    const tRepo = this.dataSource.getRepository(Ticket);
    const ticket = await tRepo.findOne({ where: { id: ticketId } });
    if (!ticket) throw badRequest('Ticket not found');
    if (!ticket.pending_ci_wait) return { cancelled: false, ticket };

    ticket.pending_ci_wait = false;
    ticket.ci_wait_context = '';
    await tRepo.save(ticket);

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'updated',
      field_changed: 'pending_ci_wait', old_value: 'true', new_value: 'false',
      actor_id: opts.actorId, actor_name: opts.actorName || '',
    });

    return { cancelled: true, ticket };
  }

  /**
   * Phase 1 atomic CAS. Does NOT touch `pending_ci_wait` — that is
   * `claimDelivery`'s job alone (see class docstring for why that
   * separation matters). `expectedPriorContext` must be the exact
   * `ci_wait_context` string the caller most recently read (or itself just
   * wrote); the CAS only succeeds if nobody else changed it since. Returns
   * whether THIS call won.
   */
  async tryUpdateContext(ticketId: string, expectedPriorContext: string, nextContextJson: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true, ci_wait_context: expectedPriorContext } as any,
      { ci_wait_context: nextContextJson },
    );
    return (result.affected || 0) > 0;
  }

  /**
   * Phase 2 (delivery) atomic claim — review round 3's fix. Runs inside ONE
   * DB transaction:
   *   1. CAS `pending_ci_wait: true -> false`, conditioned on BOTH
   *      `pending_ci_wait: true` AND the EXACT `expectedContext` this
   *      delivery attempt is resolving (review round 2 finding: conditioning
   *      on `pending_ci_wait` alone let a stale in-flight delivery for an
   *      OLD wait clear a brand-new wait that raced in via cancel +
   *      re-register in between — pinning the exact context closes that).
   *   2. ONLY if that CAS affects a row, call `withinTx(manager)` — the
   *      caller's side effect (the resolution comment insert) — using the
   *      SAME transaction manager, so it commits or rolls back atomically
   *      together with step 1. If `withinTx` throws, the WHOLE transaction
   *      (including the CAS) rolls back — `pending_ci_wait` is left exactly
   *      as it was, so a later retry safely re-attempts both from scratch.
   * Returns whether this call actually claimed delivery (and therefore ran
   * `withinTx`).
   */
  async claimDelivery(
    ticketId: string,
    expectedContext: string,
    withinTx: (manager: EntityManager) => Promise<void>,
  ): Promise<boolean> {
    let claimed = false;
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.getRepository(Ticket).update(
        { id: ticketId, pending_ci_wait: true, ci_wait_context: expectedContext } as any,
        { pending_ci_wait: false, ci_wait_context: '' },
      );
      if ((result.affected || 0) === 0) return; // lost the race / already delivered — commit as a no-op
      await withinTx(manager);
      claimed = true;
    });
    return claimed;
  }
}
