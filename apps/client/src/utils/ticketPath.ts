// Stable work links address tickets by id. Ownership is enforced by the server.
export function ticketsPagePath(accountId: string): string {
  return `/tickets`;
}

/** True on the Tickets page itself — it owns `?ticket=` and opens its own detail panel. */
export function isTicketsPagePath(pathname: string): boolean {
  return /^\/tickets\/?$/.test(pathname);
}

export function ticketPath(
  accountId: string,
  ticketId: string,
  opts?: { commentId?: string | null },
): string {
  const qs = new URLSearchParams();
  qs.set('ticket', ticketId);
  if (opts?.commentId) qs.set('comment', opts.commentId);
  return `${ticketsPagePath(accountId)}?${qs.toString()}`;
}

/** Ownership metadata is not required to follow a ticket id. */
export function canOpenTicket(t: { id?: string | null; account_id?: string | null } | null | undefined): boolean {
  return !!t?.id;
}
