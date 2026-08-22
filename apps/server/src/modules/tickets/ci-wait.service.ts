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
 *     malformed identifier (ticket 778b6dc7 review round 1).
 *   - `cancelWait(ticket, actor)` — clear both fields. Idempotent.
 *   - `tryRecordOutcome(ticketId, expectedPriorContext, nextContextJson)` —
 *     ATOMIC CAS that stamps a resolved/timeout/error `outcome` onto
 *     `ci_wait_context` WITHOUT touching `pending_ci_wait`. This is
 *     deliberately NOT the same step as clearing the pending flag (see
 *     `markDelivered` below) — ticket 778b6dc7 review round 1 P0: the old
 *     single-step design cleared `pending_ci_wait` (the only signal driving
 *     the sweep to reconsider a ticket) BEFORE the comment+dispatch side
 *     effects ran, so a crash or thrown exception in either side effect
 *     lost the resume permanently — the next sweep no longer found the
 *     ticket, because the thing that used to make it a candidate was
 *     already cleared. Recording the outcome INTO the still-pending context
 *     means a crash here is free to retry: the next sweep sees
 *     `pending_ci_wait=true` (still a candidate) with `ci_wait_context`
 *     already carrying the outcome, skips the GitHub re-poll, and resumes
 *     delivery from wherever it left off.
 *   - `markDelivered(ticketId)` — the FINAL atomic CAS
 *     (`pending_ci_wait: true -> false`), called only once
 *     `CiWaitResumeService`'s delivery step (idempotent comment + dispatch)
 *     has actually been attempted. Until this succeeds, the ticket remains a
 *     sweep candidate and delivery is safely retried.
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
  /** Stable per-resolution marker CiWaitResumeService uses to detect an
   *  already-posted resolution comment on retry (idempotent delivery). */
  resolved_at: string; // ISO timestamp
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
   *  but delivery (comment + dispatch) may not have completed yet — see
   *  `tryRecordOutcome`'s docstring above. */
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
    const outcome = parsed.outcome && typeof parsed.outcome === 'object' && parsed.outcome.kind
      ? {
          kind: parsed.outcome.kind as CiWaitOutcome['kind'],
          message: String(parsed.outcome.message || ''),
          resolved_at: String(parsed.outcome.resolved_at || ''),
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
    // Full external-format validation (ticket 778b6dc7 review round 1, P1):
    // never truncate or silently accept a malformed run_id/head_sha — the
    // whole caller-supplied value must satisfy the real GitHub format.
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
   * Atomic CAS that stamps `outcome` onto `ci_wait_context` — does NOT
   * touch `pending_ci_wait`, which is the whole point (see class docstring).
   * `expectedPriorContext` must be the exact `ci_wait_context` string this
   * caller most recently read; the CAS only succeeds if nobody else (an
   * overlapping sweep tick) already changed it. Returns whether THIS call
   * won.
   */
  async tryRecordOutcome(ticketId: string, expectedPriorContext: string, nextContextJson: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true, ci_wait_context: expectedPriorContext } as any,
      { ci_wait_context: nextContextJson },
    );
    return (result.affected || 0) > 0;
  }

  /**
   * Final atomic CAS — ONLY call once delivery (idempotent comment +
   * dispatch) has actually been attempted for the recorded outcome.
   * Conditional on `pending_ci_wait: true` so a racing `cancel_ci_wait`
   * (or a second delivery attempt that already won) cannot double-clear.
   */
  async markDelivered(ticketId: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true } as any,
      { pending_ci_wait: false, ci_wait_context: '' },
    );
    return (result.affected || 0) > 0;
  }
}
