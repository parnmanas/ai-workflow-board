// Stable work links address tickets by id. Ownership is enforced by the server.
export function ticketsPagePath(wsId: string): string {
  return `/tickets`;
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

/** Ownership metadata is not required to follow a ticket id. */
export function canOpenTicket(t: { id?: string | null; account_id?: string | null } | null | undefined): boolean {
  return !!t?.id;
}
