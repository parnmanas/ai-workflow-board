/**
 * author_role resolution for agent-authored comments.
 *
 * Kept separate from `comment-tools.ts` so the resolution-order contract can
 * be unit-tested directly (ticket ed07eeeb). A ticket has one agent — its
 * assignee — so the only role an agent comment can carry is `assignee`, or
 * whatever the caller / subagent session pinned explicitly.
 */

/**
 * Snapshot which role an agent comment was authored as. The caller stores the
 * result under `metadata.author_role` (a string when it resolves; otherwise the
 * field is omitted).
 *
 * Resolution order:
 *   1. caller-supplied `requestedRole` (trimmed + lower-cased).
 *   2. session-pinned role from `X-AWB-Subagent-Role` headers, only when the
 *      pinned ticket is the ticket being commented on.
 *   3. `assignee` when the author is the ticket's assignee identity.
 *
 * Returns `null` when nothing resolves, so callers can omit the field entirely
 * rather than write a misleading empty string.
 */
export function resolveAuthorRole(
  ticket: { id: string; assignee_key?: string | null },
  requestedRole: string | undefined,
  authorType: 'user' | 'agent',
  authorId: string,
  sessionRole: string | undefined,
  sessionTicketId: string | undefined,
): string | null {
  const explicit = (requestedRole || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (authorType !== 'agent') return null;
  if (sessionTicketId && sessionTicketId === ticket.id && sessionRole) return sessionRole;
  if (ticket.assignee_key && authorId && ticket.assignee_key === authorId) return 'assignee';
  return null;
}

/**
 * Merge a resolved `author_role` into a comment's metadata bag without
 * clobbering an explicit `author_role` the caller already placed there.
 * `authorRole === null` means "unresolved" → leave metadata untouched.
 */
export function mergeAuthorRoleIntoMetadata(
  metadata: Record<string, unknown> | undefined,
  authorRole: string | null,
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (authorRole === null) return base;
  if (base.author_role === undefined) base.author_role = authorRole;
  return base;
}
