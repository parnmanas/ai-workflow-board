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
 *     overwritten.
 *   - `cancelWait(ticket, actor)` — clear both fields. Idempotent.
 *   - `claimResolved(ticketId)` — ATOMIC conditional UPDATE used ONLY by
 *     `CiWaitResumeService`'s sweep, so two overlapping sweep ticks (or a
 *     sweep racing an explicit `cancel_ci_wait`) resolve a given ticket's
 *     wait exactly once. Returns whether THIS call won the claim.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { ActivityService } from '../../services/activity.service';
import { isValidRepoRef } from '../../services/github-connector.service';

export interface CiWaitContext {
  owner: string;
  repo: string;
  run_id: string;
  head_sha: string;
  html_url: string;
  registered_by: string;
  registered_at: string; // ISO timestamp
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
    return {
      owner: String(parsed.owner),
      repo: String(parsed.repo),
      run_id: String(parsed.run_id),
      head_sha: String(parsed.head_sha || ''),
      html_url: String(parsed.html_url || ''),
      registered_by: String(parsed.registered_by || ''),
      registered_at: String(parsed.registered_at || ''),
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
    if (!isValidRepoRef(owner, repo)) throw badRequest(`Invalid GitHub owner/repo: ${JSON.stringify(owner)}/${JSON.stringify(repo)}`);
    if (!runId) throw badRequest('run_id is required');

    const ctx: CiWaitContext = {
      owner, repo, run_id: runId,
      head_sha: String(input.head_sha || ''),
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
   * Atomic claim — ONLY caller should be CiWaitResumeService's sweep.
   * Conditional UPDATE (criteria includes `pending_ci_wait: true`) so an
   * overlapping sweep tick or a racing `cancel_ci_wait` cannot both act on
   * the same resolution. Mirrors the CAS pattern in
   * `common/hard-budget-guard.ts`'s `pendTicketForHardBudget`.
   */
  async claimResolved(ticketId: string): Promise<boolean> {
    const result = await this.dataSource.getRepository(Ticket).update(
      { id: ticketId, pending_ci_wait: true } as any,
      { pending_ci_wait: false, ci_wait_context: '' },
    );
    return (result.affected || 0) > 0;
  }
}
