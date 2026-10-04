import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { Action } from '../../entities/Action';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { DONE_STATUS, isDoneStatus } from '../../common/ticket-status';
import { parseRuntimeSpec } from '../../common/runtime-spec';
import { parseTags } from '../tickets/ticket.service';
import { ActionsService } from './actions.service';
import { ActionTicketContext } from './action-prompt';

// The `Action.trigger` value that opts an Action into the on-ticket-done hook.
export const ON_TICKET_DONE_TRIGGER = 'on_ticket_done';

// Recursion guard tag (ticket 16a6339c requirement 4). A finished ticket
// carrying this tag is NEVER eligible for the on-ticket-done hook: a hook
// Action that files a follow-up ticket should stamp this tag on what it
// creates so the follow-up reaching Done can't recursively re-fire the hook.
// Documented in docs/on-ticket-done-action-hook.md. (The constant keeps its
// historical `_LABEL` name — tags replaced labels with the same encoding.)
export const ON_DONE_HOOK_GUARD_LABEL = 'no-on-done-hook';

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(val || JSON.stringify(fallback)) as T;
  } catch {
    return fallback;
  }
}

/**
 * On-ticket-done Action hook (ticket 16a6339c).
 *
 * Subscribes to the `activityEvents` 'activity' stream — deliberately a
 * SEPARATE listener in the actions module rather than a call inside the ticket
 * move path, so ticket status changes don't take a dependency on Actions. When
 * a ticket enters `done` (a 'moved' activity whose new_value is the done
 * status), this service dispatches every Action bound to that completion, with
 * the finished ticket exposed to the prompt as `{{ticket.*}}` and its project
 * as `{{project.*}}`.
 *
 * Binding (union of two methods, deduped by action id):
 *   (a) per-ticket — `Ticket.on_done_action_ids` lists explicit Action ids.
 *   (b) tag policy — `Action.trigger='on_ticket_done'`, workspace-wide, narrowed
 *       by `trigger_label` (empty = any ticket; else the finished ticket's tags
 *       must include that exact tag).
 *
 * Guarantees:
 *   - enabled=false Actions are skipped (manual run_action only) — both methods.
 *   - At most one dispatch per terminal ENTRY: an atomic conditional claim on
 *     `Ticket.on_done_dispatched_at` vs `terminal_entered_at`. Re-entry (leave
 *     Done then return) re-stamps terminal_entered_at and fires again; a reorder
 *     within Done does not (terminal_entered_at is untouched).
 *   - Recursion guard: a ticket tagged `no-on-done-hook` is never eligible.
 */
@Injectable()
export class OnTicketDoneActionService implements OnModuleInit, OnModuleDestroy {
  private _activityListener?: (log: ActivityLog) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly actionsService: ActionsService,
    private readonly logService: LogService,
    // ticket 0f638509 — instance-wide fleet quiesce. @Global() (see
    // shared-services.module.ts), cycle-free.
    private readonly instanceQuiesce: InstanceQuiesceService,
  ) {}

  onModuleInit() {
    // Listener bookkeeping so integration test rigs that build/tear down the
    // Nest module per spec don't leak listeners.
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('Actions', 'OnTicketDoneActionService _handleActivity error', { err: e });
      });
    };
    activityEvents.on('activity', this._activityListener);
  }

  onModuleDestroy() {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
  }

  private async _handleActivity(log: ActivityLog): Promise<void> {
    // Instance-wide quiesce gate (ticket 0f638509 — live pull import), checked
    // FIRST — before the on_done_dispatched_at claim below. This hook is a
    // one-shot event listener with no periodic sweep/backstop, and the claim
    // is a permanent CAS (Ticket.on_done_dispatched_at vs terminal_entered_at):
    // gating AFTER the claim would silently and PERMANENTLY drop the hook for
    // any ticket that completes during the quiesce window (no automatic
    // retry once the operator resumes). Gating here at least avoids consuming
    // the claim, so the door is left open if some future path re-evaluates it.
    if (await this.instanceQuiesce.isQuiesced()) return;

    // Only a status change into `done` completes a ticket. Everything else
    // (comments, field updates, archives, other moves) is irrelevant here.
    if (log.action !== 'moved' || log.new_value !== DONE_STATUS || !log.ticket_id) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    // Re-check the row: it may have left `done` again before this ran.
    if (!ticket || !isDoneStatus(ticket.status)) return;

    // Defensive: the move path stamps terminal_entered_at on entering `done`.
    // Without it the idempotency comparison below has no anchor, so bail.
    if (!ticket.terminal_entered_at) return;

    // Recursion guard (requirement 4) — a hook-origin ticket never re-fires.
    const tags = parseTags(ticket.tags);
    if (tags.includes(ON_DONE_HOOK_GUARD_LABEL)) {
      this.logService.info('Actions', 'on_ticket_done hook skipped (recursion guard tag)', {
        ticket_id: ticket.id, guard_tag: ON_DONE_HOOK_GUARD_LABEL,
      });
      return;
    }

    // Collect eligible Actions BEFORE claiming so a ticket reaching Done with no
    // bound hook doesn't churn a write on every completion in the workspace.
    const actions = await this._collectEligibleActions(ticket, tags);
    if (actions.length === 0) return;

    // Atomic, once-per-terminal-entry claim. The WHERE guard is the real
    // protection against two near-simultaneous 'moved' activities for the same
    // entry both dispatching: only the first UPDATE matches.
    const claimAt = new Date();
    const claim = await ticketRepo
      .createQueryBuilder()
      .update(Ticket)
      .set({ on_done_dispatched_at: claimAt })
      .where('id = :id', { id: ticket.id })
      .andWhere('terminal_entered_at IS NOT NULL')
      .andWhere('(on_done_dispatched_at IS NULL OR on_done_dispatched_at < terminal_entered_at)')
      .execute();
    // Postgres + sql.js both populate UpdateResult.affected. If a future driver
    // leaves it undefined we fall back to "claimed" (the JS pre-checks above
    // already gated eligibility) — better to risk a rare double-dispatch than
    // to silently never fire.
    const claimed = claim.affected === undefined || claim.affected === null || claim.affected > 0;
    if (!claimed) {
      this.logService.info('Actions', 'on_ticket_done hook skipped (already dispatched this terminal entry)', {
        ticket_id: ticket.id,
      });
      return;
    }

    const ticketContext = this._buildTicketContext(ticket, tags);

    let dispatched = 0;
    for (const action of actions) {
      try {
        const result = await this.actionsService.dispatch({
          actionId: action.id,
          triggeredByType: 'system',
          triggeredById: ON_TICKET_DONE_TRIGGER,
          ticketContext,
        });
        dispatched++;
        // fan-out (티켓 fc3906c5): 대상이 여럿이면 이 한 번의 훅 발화가 run을
        // 여러 건 만든다. run_id/room_id는 첫 run으로 두고 배치 규모를 함께
        // 남겨, 로그만 보고도 몇 개 호스트로 퍼졌는지 알 수 있게 한다.
        this.logService.info('Actions', 'on_ticket_done hook dispatched action', {
          ticket_id: ticket.id, action_id: action.id, run_id: result.run.id, room_id: result.room_id,
          batch_id: result.batch_id, run_count: result.runs.length, failed_targets: result.failures.length,
        });
      } catch (e) {
        this.logService.warn('Actions', 'on_ticket_done hook dispatch failed (continuing)', {
          err: String(e), ticket_id: ticket.id, action_id: action.id,
        });
      }
    }

    this.logService.info('Actions', 'on_ticket_done hook complete', {
      ticket_id: ticket.id, project_id: ticket.project_id,
      eligible: actions.length, dispatched,
    });
  }

  /**
   * Union of method (a) explicit per-ticket ids and method (b) tag policy
   * Actions, deduped by id. enabled=false is filtered out of both.
   *
   * ORDER (ticket 59afc55a, criterion c): explicit per-ticket ids dispatch in
   * their saved `on_done_action_ids` array order — that order is the user's
   * intended execution sequence (reorderable in the TicketPanel picker). Policy
   * Actions not already named explicitly are appended after, so the per-ticket
   * order is always the leading prefix even when a bound Action also happens to
   * be an on_ticket_done policy Action. `Map` preserves insertion order.
   */
  private async _collectEligibleActions(ticket: Ticket, tags: string[]): Promise<Action[]> {
    const actionRepo = this.dataSource.getRepository(Action);
    const byId = new Map<string, Action>();

    // (a) Explicit per-ticket ids FIRST, in array order. These fire regardless
    // of the Action's own `trigger` field (the binding is the ticket's, not a
    // policy), but still honour enabled=false and workspace scope.
    const explicitIds = safeJsonParse<string[]>(ticket.on_done_action_ids, []);
    if (Array.isArray(explicitIds)) {
      for (const id of explicitIds) {
        if (typeof id !== 'string' || !id || byId.has(id)) continue;
        const a = await actionRepo.findOne({ where: { id } });
        if (!a) continue;
        if (a.workspace_id !== ticket.workspace_id) continue;
        if (!a.enabled) continue;
        byId.set(a.id, a);
      }
    }

    // (b) Tag-scoped policy Actions, appended after the explicit ones. Tag
    // match in JS (tags live as a JSON string — keep the query DB-portable).
    const qb = actionRepo
      .createQueryBuilder('a')
      .where('a.workspace_id = :ws', { ws: ticket.workspace_id })
      .andWhere('a.trigger = :trig', { trig: ON_TICKET_DONE_TRIGGER })
      .andWhere('a.enabled = :en', { en: true });
    const policyActions = await qb.getMany();
    for (const a of policyActions) {
      if (byId.has(a.id)) continue;
      const tagOk = !a.trigger_label || tags.includes(a.trigger_label);
      if (tagOk) byId.set(a.id, a);
    }

    return [...byId.values()];
  }

  private _buildTicketContext(ticket: Ticket, tags: string[]): ActionTicketContext {
    const tagList = tags.join(', ');
    const projectId = ticket.project_id || '';
    return {
      id: ticket.id,
      title: ticket.title,
      priority: ticket.priority,
      status: ticket.status,
      description: ticket.description,
      project_id: projectId,
      base_branch: ticket.base_branch,
      tags: tagList,
      assignee: parseRuntimeSpec(ticket.assignee)?.label || '',
      labels: tagList,
      base_repo_id: projectId,
    };
  }
}
