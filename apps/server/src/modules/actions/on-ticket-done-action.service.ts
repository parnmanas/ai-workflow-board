import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Action } from '../../entities/Action';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { ActionsService } from './actions.service';
import { ActionTicketContext } from './action-prompt';

// The `Action.trigger` value that opts an Action into the on-ticket-done hook.
export const ON_TICKET_DONE_TRIGGER = 'on_ticket_done';

// Recursion guard label (ticket 16a6339c requirement 4). A finished ticket
// carrying this label is NEVER eligible for the on-ticket-done hook. This is
// the same label-convention the self-improvement post-done review uses
// (TriggerLoopService checks `self-improvement`): a hook Action that files a
// follow-up ticket should stamp this label on what it creates so the follow-up
// reaching Done can't recursively re-fire the hook. Documented in
// docs/on-ticket-done-action-hook.md.
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
 * Subscribes to the same `activityEvents` 'activity' stream that
 * TriggerLoopService listens on — deliberately a SEPARATE listener in the
 * actions module rather than a call inside TriggerLoopService, so the actions
 * module doesn't take a dependency on the agents module (and vice versa). When
 * a ticket lands on a terminal column, this service dispatches every Action
 * bound to that completion, with the finished ticket exposed to the prompt as
 * `{{ticket.*}}`.
 *
 * Binding (union of two methods, deduped by action id):
 *   (a) per-ticket — `Ticket.on_done_action_ids` lists explicit Action ids.
 *   (b) board/label policy — `Action.trigger='on_ticket_done'` scoped by the
 *       Action's `board_id` (NULL = any board in the workspace) and
 *       `trigger_label` (empty = any label; else the finished ticket must carry
 *       that label).
 *
 * Guarantees:
 *   - enabled=false Actions are skipped (manual run_action only) — both methods.
 *   - At most one dispatch per terminal ENTRY: an atomic conditional claim on
 *     `Ticket.on_done_dispatched_at` vs `terminal_entered_at`. Re-entry (leave
 *     Done then return) re-stamps terminal_entered_at and fires again; a reorder
 *     within Done does not (terminal_entered_at is untouched).
 *   - Recursion guard: a ticket labelled `no-on-done-hook` is never eligible.
 */
@Injectable()
export class OnTicketDoneActionService implements OnModuleInit, OnModuleDestroy {
  private _activityListener?: (log: ActivityLog) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly actionsService: ActionsService,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    // Mirror TriggerLoopService's listener bookkeeping so integration test rigs
    // that build/tear down the Nest module per spec don't leak listeners.
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
    // Only column moves can land a ticket on a terminal column. Everything else
    // (comments, field updates, archives) is irrelevant to this hook.
    if (log.action !== 'moved' || !log.ticket_id) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket || !ticket.column_id) return;

    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!isTerminalColumn(col)) return;

    // Defensive: the move path stamps terminal_entered_at on a non-terminal →
    // terminal crossing. Without it the idempotency comparison below has no
    // anchor, so bail (a board move that lands terminal-from-terminal won't
    // re-fire, which is the intended "same entry" semantics).
    if (!ticket.terminal_entered_at) return;

    // Recursion guard (requirement 4) — a hook-origin ticket never re-fires.
    const labels = safeJsonParse<string[]>(ticket.labels, []);
    if (Array.isArray(labels) && labels.includes(ON_DONE_HOOK_GUARD_LABEL)) {
      this.logService.info('Actions', 'on_ticket_done hook skipped (recursion guard label)', {
        ticket_id: ticket.id, guard_label: ON_DONE_HOOK_GUARD_LABEL,
      });
      return;
    }

    const boardId = col!.board_id;

    // Collect eligible Actions BEFORE claiming so a ticket reaching Done with no
    // bound hook doesn't churn a write on every completion across every board.
    const actions = await this._collectEligibleActions(ticket, boardId, labels);
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

    const ticketContext = this._buildTicketContext(ticket, boardId, labels);

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
        this.logService.info('Actions', 'on_ticket_done hook dispatched action', {
          ticket_id: ticket.id, action_id: action.id, run_id: result.run.id, room_id: result.room_id,
        });
      } catch (e) {
        this.logService.warn('Actions', 'on_ticket_done hook dispatch failed (continuing)', {
          err: String(e), ticket_id: ticket.id, action_id: action.id,
        });
      }
    }

    this.logService.info('Actions', 'on_ticket_done hook complete', {
      ticket_id: ticket.id, board_id: boardId,
      eligible: actions.length, dispatched,
    });
  }

  /**
   * Union of method (a) explicit per-ticket ids and method (b) board/label
   * policy Actions, deduped by id. enabled=false is filtered out of both.
   *
   * ORDER (ticket 59afc55a, criterion c): explicit per-ticket ids dispatch in
   * their saved `on_done_action_ids` array order — that order is the user's
   * intended execution sequence (reorderable in the TicketPanel picker). Policy
   * Actions not already named explicitly are appended after, so the per-ticket
   * order is always the leading prefix even when a bound Action also happens to
   * be an on_ticket_done policy Action. `Map` preserves insertion order.
   */
  private async _collectEligibleActions(
    ticket: Ticket,
    boardId: string,
    labels: string[],
  ): Promise<Action[]> {
    const actionRepo = this.dataSource.getRepository(Action);
    const byId = new Map<string, Action>();

    // (a) Explicit per-ticket ids FIRST, in array order. These fire regardless
    // of the Action's own `trigger` field (the binding is the ticket's, not a
    // board policy), but still honour enabled=false and workspace scope.
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

    // (b) Board/label-scoped policy Actions, appended after the explicit ones.
    // Scope board in SQL, label in JS (labels live as a JSON string — keep the
    // query DB-portable).
    const qb = actionRepo
      .createQueryBuilder('a')
      .where('a.workspace_id = :ws', { ws: ticket.workspace_id })
      .andWhere('a.trigger = :trig', { trig: ON_TICKET_DONE_TRIGGER })
      .andWhere('a.enabled = :en', { en: true })
      .andWhere('(a.board_id IS NULL OR a.board_id = :bid)', { bid: boardId });
    const policyActions = await qb.getMany();
    for (const a of policyActions) {
      if (byId.has(a.id)) continue;
      const labelOk = !a.trigger_label || (Array.isArray(labels) && labels.includes(a.trigger_label));
      if (labelOk) byId.set(a.id, a);
    }

    return [...byId.values()];
  }

  private _buildTicketContext(ticket: Ticket, boardId: string, labels: string[]): ActionTicketContext {
    return {
      id: ticket.id,
      title: ticket.title,
      board_id: boardId,
      column_id: ticket.column_id,
      priority: ticket.priority,
      status: ticket.status,
      description: ticket.description,
      base_branch: ticket.base_branch,
      base_repo_id: ticket.base_repo_resource_id,
      labels: Array.isArray(labels) ? labels.join(', ') : '',
      assignee: ticket.assignee,
      reporter: ticket.reporter,
    };
  }
}
