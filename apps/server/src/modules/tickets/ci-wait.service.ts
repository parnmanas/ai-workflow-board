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
 *     the ONE generic atomic CAS primitive every mid-delivery transition
 *     uses: recording an outcome, claiming/renewing the delivery lease,
 *     flipping `comment_posted`/`dispatch_done`. Never touches
 *     `pending_ci_wait` — see CiWaitResumeService's docstring for why that
 *     separation is the crux of the review round 1 P0 fix (a crash between
 *     "resolved" and "delivered" must not lose the ticket's sweep-candidate
 *     status).
 *   - `markDelivered(ticketId, expectedContext)` — the FINAL atomic CAS
 *     (`pending_ci_wait: true -> false`), conditioned on BOTH
 *     `pending_ci_wait: true` AND the EXACT `ci_wait_context` this delivery
 *     attempt just finished with (review round 2 finding: conditioning on
 *     `pending_ci_wait` alone let a stale in-flight delivery for an OLD wait
 *     clear a brand-new wait that raced in via cancel+re-register in
 *     between — pinning the exact context closes that).
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { ActivityService } from '../../services/activity.service';
import { isValidRepoRef, isValidGitHubRunId, isValidGitSha } from '../../services/github-connector.service';

export interface CiWaitOutcome {
  kind: 'resolved' | 'timeout' | 'error';
  message: string;
  /** Durable per-resolution identity — set once, never changes. Also used as
   *  the idempotent resolution-comment marker. */
  resolved_at: string; // ISO timestamp
  /** Bumped every time a delivery attempt (re)claims the lease below. */
  delivery_generation: number;
  /** Opaque per-attempt token; '' when no attempt currently holds the lease. */
  lease_owner: string;
  /** ISO timestamp; '' when no attempt currently holds the lease. A lease
   *  past this time is stale and may be reclaimed by a fresh attempt. */
  lease_expires_at: string;
  /** Durable — true only once the resolution comment has actually been
   *  saved. Delivery retries check this before posting again (idempotent). */
  comment_posted: boolean;
  /** Durable — true only once `dispatchCurrentColumn` has actually returned
   *  without throwing. Delivery retries check this before dispatching again. */
  dispatch_done: boolean;
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
          delivery_generation: Number.isFinite(o.delivery_generation) ? o.delivery_generation : 0,
          lease_owner: String(o.lease_owner || ''),
          lease_expires_at: String(o.lease_expires_at || ''),
          comment_posted: !!o.comment_posted,
          dispatch_done: !!o.dispatch_done,
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
   * The one generic atomic CAS every mid-delivery transition uses. Does NOT
   * touch `pending_ci_wait` — that is `markDelivered`'s job alone (see class
   * docstring for why that separation matters). `expectedPriorContext` must
   * be the exact `ci_wait_context` string the caller most recently read (or
   * itself just wrote); the CAS only succeeds if nobody else changed it
   * since. Returns whether THIS call won.
   */
  async tryUpdateContext(ticketId: string, expectedPriorContext: string, nextContextJson: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true, ci_wait_context: expectedPriorContext } as any,
      { ci_wait_context: nextContextJson },
    );
    return (result.affected || 0) > 0;
  }

  /**
   * Final atomic CAS — ONLY call once delivery (comment + dispatch, both
   * durably flagged done) has actually completed for the recorded outcome.
   * Conditioned on BOTH `pending_ci_wait: true` AND the exact
   * `expectedContext` this delivery attempt finished with, so a stale
   * in-flight delivery for an OLD wait can never clear a brand-new wait
   * that raced in via cancel + re-register in the meantime (review round 2).
   */
  async markDelivered(ticketId: string, expectedContext: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true, ci_wait_context: expectedContext } as any,
      { pending_ci_wait: false, ci_wait_context: '' },
    );
    return (result.affected || 0) > 0;
  }
}
