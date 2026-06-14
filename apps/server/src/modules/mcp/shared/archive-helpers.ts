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
 * True when a move would drag a ticket OUT of a terminal column back into a
 * non-terminal one (ticket ad0eb567).
 *
 * On a board where one agent holds assignee+reviewer+reporter, every column
 * transition fires a fresh role-trigger to the same agent, so multiple strands
 * run concurrently. A strand spawned while the ticket was still in
 * Review/Merging reads that stale snapshot; by the time its `move_ticket`
 * lands, a sibling strand may have already merged the ticket into Done. The
 * stale call then re-opens the completed merge (observed on tickets e163c952
 * and 9f507f5c). This is the exact transition to refuse by default — forward
 * moves into terminal and reorders within terminal are unaffected.
 */
export function isTerminalReopen(
  sourceColumn: BoardColumn | null | undefined,
  destColumn: BoardColumn | null | undefined,
): boolean {
  return isTerminalColumn(sourceColumn) && !isTerminalColumn(destColumn);
}

/**
 * Thrown / surfaced when a move is rejected because it would reopen a ticket
 * out of a terminal column without an explicit override. Callers that genuinely
 * mean to reopen (a human dragging a Done card, or an automated caller passing
 * `force`) bypass the guard; everyone else gets a stable, greppable rejection.
 */
export class TerminalReopenError extends Error {
  status = 409;
  code = 'terminal_reopen_blocked';
  hint = 'Pass force=true to intentionally reopen a ticket out of a terminal column';
  constructor(ticketId: string, sourceName: string, destName: string) {
    super(
      `Ticket ${ticketId} is in terminal column "${sourceName}" — refusing to move it back to non-terminal "${destName}". ` +
      `This is almost always a stale concurrent strand acting on an out-of-date snapshot of an already-completed ticket. ` +
      `Pass force=true if you really mean to reopen it.`,
    );
    this.name = 'TerminalReopenError';
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
 * Compound cursor for archived-ticket pagination — `<isoTimestamp>|<id>`.
 *
 * The archiver stamps every ticket in a per-board batch with the same
 * `archived_at` (single `new Date()` reused across the loop). A cursor that
 * only carries the timestamp and filters `archived_at < cursor` would skip
 * the rest of that batch when the page boundary lands inside it.
 *
 * Pairs with ORDER BY archived_at DESC, id DESC and predicate
 *   (archived_at < :ts OR (archived_at = :ts AND id < :id))
 * to walk past same-timestamp ties stably.
 *
 * Backwards-compatible: if a caller hands us a bare ISO timestamp (the old
 * cursor format), we treat it as `(ts, null)` and skip the tiebreak — older
 * clients still page forward, just with the original same-timestamp gap.
 */
export function buildArchiveCursor(archivedAt: Date | string, id: string): string {
  const iso = archivedAt instanceof Date ? archivedAt.toISOString() : new Date(archivedAt).toISOString();
  return `${iso}|${id}`;
}

export function parseArchiveCursor(cursor: string | null | undefined): { ts: Date | null; id: string | null } {
  if (!cursor) return { ts: null, id: null };
  const sep = cursor.indexOf('|');
  const rawTs = sep === -1 ? cursor : cursor.slice(0, sep);
  // Legacy bare-timestamp cursor → id is null so callers skip the tiebreak.
  const id = sep === -1 ? null : cursor.slice(sep + 1) || null;
  const ts = new Date(rawTs);
  if (Number.isNaN(ts.getTime())) return { ts: null, id: null };
  return { ts, id };
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
