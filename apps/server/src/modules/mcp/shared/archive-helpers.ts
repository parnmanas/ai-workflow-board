/**
 * Helpers for the ticket auto-archive feature (ticket 9b44526b).
 *
 * Three responsibilities:
 *
 *   1. `isTerminalColumn(col)` — single source of truth for "is this a
 *      terminal column?". Reads kind='terminal' OR is_terminal=true. Both
 *      forms are written by different code paths; checking either keeps the
 *      archive logic forward- and backward-compatible.
 *
 *   2. `applyTerminalEnteredAtForMove(repo, ticketId, sourceColumn, destColumn)`
 *      — stamps or clears Ticket.terminal_entered_at when a move changes the
 *      column's terminal status. Idempotent: a move that doesn't cross the
 *      terminal boundary leaves the column alone.
 *
 *   3. `assertTicketActive(ticket)` — throws a tagged Error when an archived
 *      ticket reaches a mutation path. The error.status is 409 and message is
 *      stable so REST controllers + MCP tools can map it to a consistent
 *      reply.
 */

import type { DataSource, EntityManager, Repository } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';

type RepoScope = DataSource | EntityManager;

export function isTerminalColumn(col: BoardColumn | null | undefined): boolean {
  if (!col) return false;
  return (col as any).is_terminal === true || (col as any).kind === 'terminal';
}

/**
 * Update Ticket.terminal_entered_at to reflect a column transition.
 *
 *   - moving INTO a terminal column from a non-terminal one → stamp `now`
 *   - moving OUT of a terminal column → null
 *   - terminal → terminal (e.g. position reorder within Done) → leave alone
 *   - non-terminal → non-terminal → leave alone
 *
 * The repo is whichever Repository<Ticket> the caller already has (transaction
 * manager's repo for atomic move flows, the bare repo elsewhere).
 */
export async function applyTerminalEnteredAtForMove(
  ticketRepo: Repository<Ticket>,
  ticketId: string,
  sourceColumn: BoardColumn | null | undefined,
  destColumn: BoardColumn | null | undefined,
): Promise<void> {
  const wasTerminal = isTerminalColumn(sourceColumn);
  const isTerminal = isTerminalColumn(destColumn);
  if (wasTerminal === isTerminal) return;
  await ticketRepo.update(ticketId, {
    terminal_entered_at: isTerminal ? new Date() : null,
  });
}

export class TicketArchivedError extends Error {
  status = 409;
  code = 'ticket_archived';
  hint = 'Call unarchive_ticket first';
  constructor(ticketId: string) {
    super(`Ticket ${ticketId} is archived — call unarchive_ticket to mutate it`);
    this.name = 'TicketArchivedError';
  }
}

/**
 * Throws `TicketArchivedError` when the ticket has a non-null `archived_at`.
 * Returns the ticket otherwise so callers can chain it.
 *
 * Callers that need a different error surface (e.g. MCP `err()`) should catch
 * and translate.
 */
export function assertTicketActive<T extends { id: string; archived_at: Date | null }>(
  ticket: T,
): T {
  if (ticket.archived_at) throw new TicketArchivedError(ticket.id);
  return ticket;
}

/**
 * Walk from a ticket up to its root and return the root's archived_at.
 * Used by child-ticket mutation paths so a subtask can't be edited while
 * its parent is archived — the root is the only ticket carrying the flag
 * because archive is a board-level concept and subtasks have no column.
 *
 * Bounded by the 2-level depth cap; worst case 2 reads. Returns null when
 * walking fails (orphan row) so the caller treats it as "not archived"
 * rather than blocking on a database inconsistency.
 */
export async function getRootArchivedAt(
  scope: RepoScope,
  ticket: { id: string; parent_id: string | null; archived_at: Date | null },
): Promise<Date | null> {
  if (!ticket.parent_id) return ticket.archived_at;
  const ticketRepo = scope.getRepository(Ticket);
  let cursor: Ticket | null = ticket as any;
  for (let depth = 0; cursor && cursor.parent_id && depth < 3; depth++) {
    cursor = await ticketRepo.findOne({ where: { id: cursor.parent_id } });
  }
  return cursor?.archived_at ?? null;
}
