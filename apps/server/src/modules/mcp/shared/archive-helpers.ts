/**
 * Helpers for the ticket auto-archive feature (ticket 9b44526b).
 *
 *   - `assertTicketActive(ticket)` — throws a tagged Error when an archived
 *     ticket reaches a mutation path. The error.status is 409 and message is
 *     stable so REST controllers + MCP tools can map it to a consistent reply.
 *   - archive cursor helpers + `getRootArchivedAt` for subtasks.
 *
 * Status transitions (and `terminal_entered_at`) are owned by
 * TicketService.move — see docs/tickets.md.
 */

import type { DataSource, EntityManager } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';

type RepoScope = DataSource | EntityManager;

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
 * Compound cursor for archived-ticket pagination — `<isoTimestamp>|<id>`.
 *
 * The archiver stamps every ticket in a batch with the same
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
 * its parent is archived — the root is the only ticket carrying the flag.
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
