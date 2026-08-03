/**
 * Terminal-aware system pend gate (ticket ec498050).
 *
 * A ticket already sitting in a terminal column (Done, or any column with
 * kind='terminal'/is_terminal=true) is never picked up again — the trigger
 * loop, the focus selector, and BacklogPromotionService all treat pending as
 * "a still-active ticket is waiting on a human". Setting `pending_user_action`
 * on an already-terminal ticket does nothing useful and actively misleads the
 * ticket detail panel's User tab. Root cause of ticket 0709ea7c: a Done ticket
 * got auto-pended by `agent_comment_pingpong_guard` when a post-Done
 * self-improvement retrospective dispatch found nothing to retrospect on and
 * repeated a "waiting" comment — none of the system-originated pend sites
 * checked terminal state before flipping the flag.
 *
 * Every SYSTEM-originated pend site should funnel through this gate before
 * writing `pending_user_action=true`. Human-originated pend paths (REST
 * `PATCH /api/tickets/:id`, and MCP `pend_ticket`'s intentional-park call) are
 * a DIFFERENT case — a human may deliberately want to flag an already-terminal
 * ticket (e.g. "reopen and revisit this Done decision"), and REST already owns
 * that judgment call. This gate exists for automated call sites that never
 * meant to touch a finished ticket in the first place.
 *
 * Split into a pure predicate (`evaluateTerminalPendGate`, no DB — unit-tested
 * like `pend-action-gate.ts`) and a DB loader (`loadTicketColumnForPendGate`,
 * mirrors the subtask-walk in `hard-budget-guard.ts`'s `resolveTicketBoardId`)
 * so the decision logic tests without a DataSource. The loader takes bare
 * repositories (not a `DataSource`) so it drops into callers that only have
 * per-entity `@InjectRepository` fields (e.g. `ActionsService`) as easily as
 * ones holding a full `DataSource`.
 */
import type { Repository } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { isTerminalColumn } from './archive-helpers';

export interface TerminalPendGateResult {
  /** true → proceed with the pend. false → ticket is already terminal, skip it. */
  allowed: boolean;
  reason?: string;
}

/**
 * Pure predicate — no DB. `col` is the caller's already-resolved column, or
 * null/undefined when it couldn't be resolved (the caller should treat that
 * as fail-open, same as `evaluatePendActionGate`'s empty-candidates case).
 */
export function evaluateTerminalPendGate(
  col: Pick<BoardColumn, 'is_terminal' | 'kind'> | null | undefined,
): TerminalPendGateResult {
  if (isTerminalColumn(col as BoardColumn | null | undefined)) {
    return { allowed: false, reason: 'ticket_already_terminal' };
  }
  return { allowed: true };
}

export type PendGateTicketRef = { id: string; column_id?: string | null; parent_id?: string | null };

/**
 * Resolve the column governing a system pend decision. Subtasks
 * (`column_id=null`) walk up to the nearest ancestor carrying a column_id —
 * same bound (depth < 3) and shape as `hard-budget-guard.ts`'s
 * `resolveTicketBoardId`. Returns null when unresolved (orphan row, or a
 * ticket that carries no column at all) so the caller's gate fails OPEN.
 */
export async function loadTicketColumnForPendGate(
  ticketRepo: Pick<Repository<Ticket>, 'findOne'>,
  columnRepo: Pick<Repository<BoardColumn>, 'findOne'>,
  ticket: PendGateTicketRef,
): Promise<BoardColumn | null> {
  let cursor: PendGateTicketRef | null = ticket;
  for (let depth = 0; cursor && !cursor.column_id && cursor.parent_id && depth < 3; depth++) {
    cursor = await ticketRepo.findOne({ where: { id: cursor.parent_id as string } });
  }
  if (!cursor?.column_id) return null;
  return columnRepo.findOne({ where: { id: cursor.column_id } });
}
