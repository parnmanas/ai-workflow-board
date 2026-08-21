import { BoardCardTicket } from '../types';

/**
 * Rolls a ticket's own unread comment count up with every subtask's,
 * recursively — BoardCardTicket.children nests root→child→grandchild the
 * same way the server's unread-counts resolution does (tickets.controller.ts
 * `_resolveTicketsToBoards`). Subtasks never render their own card on the
 * board, so without this rollup a comment on a subtask would count toward
 * the sidebar/board badge total but never show up on any card — the "where
 * did this number come from" gap ticket 628f4b39 flags.
 *
 * Pure + framework-free (no React) so it can be unit tested directly with
 * `node --test`, mirroring sidebarRoomsPaging.ts's extraction of Sidebar's
 * pagination math.
 */
export function sumUnread(ticket: BoardCardTicket, perTicket: Record<string, number>): number {
  let total = perTicket[ticket.id] || 0;
  for (const child of ticket.children || []) total += sumUnread(child, perTicket);
  return total;
}
