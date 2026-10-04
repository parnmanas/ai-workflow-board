// Ticket deep links (docs/tickets.md). Tickets live in one workspace pool, so a
// ticket is addressed by workspace + id alone — the Tickets page opens the
// detail panel from `?ticket=<id>` (and scrolls to `?comment=<id>` when given).
// Replaces the old board deep link (`/ws/:wsId/boards/:boardId?ticket=`), which
// needed a board id the client often did not have.

export function ticketsPagePath(wsId: string): string {
  return `/ws/${wsId}/tickets`;
}

export function ticketPath(
  wsId: string,
  ticketId: string,
  opts?: { commentId?: string | null },
): string {
  const qs = new URLSearchParams();
  qs.set('ticket', ticketId);
  if (opts?.commentId) qs.set('comment', opts.commentId);
  return `${ticketsPagePath(wsId)}?${qs.toString()}`;
}

/** A ticket reference is openable when both halves of its address are known. */
export function canOpenTicket(t: { id?: string | null; workspace_id?: string | null } | null | undefined): boolean {
  return !!t?.id && !!t?.workspace_id;
}
