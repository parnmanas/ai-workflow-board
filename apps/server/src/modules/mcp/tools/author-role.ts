/**
 * author_role resolution for agent-authored comments.
 *
 * Extracted from `comment-tools.ts` (was an inner closure of
 * `registerCommentTools`) so the resolution-order contract can be unit-tested
 * directly. The closure form was unreachable from tests, which left the
 * **#2 session-pin auto-fill** path — the exact one operational assignee /
 * reviewer subagents ride — covered only by a QA scenario that structurally
 * cannot reproduce it (the awb-mcp QA driver is a chat subagent and never
 * carries an `X-AWB-Subagent-Role` pin). Ticket ed07eeeb.
 *
 * `comment-tools.ts` keeps a thin wrapper that binds `ticketRoleAssignmentService`
 * so the four call sites (add_comment / ask_question / answer_question /
 * record_decision / handoff_to_agent) keep their original signature.
 */

/**
 * Minimal slice of `TicketRoleAssignmentService.resolveForTicket` that the
 * #3 fallback depends on — typed structurally so tests can pass a plain stub
 * without constructing the full Nest service + its four repositories.
 */
export interface AuthorRoleResolver {
  resolveForTicket(ticketId: string): Promise<
    Array<{
      holder?: { type?: string; id?: string } | null;
      role: { slug: string };
    }>
  >;
}

/**
 * Snapshot which role an agent comment was authored as, on the ticket the
 * comment lives on. The caller stores the result under `metadata.author_role`
 * (a string when the role is unambiguous; otherwise the field is omitted).
 *
 * Resolution order:
 *   1. caller-supplied `requestedRole` (override — the agent knows what it is
 *      doing right now). Trimmed + lower-cased.
 *   2. session-pinned role from `X-AWB-Subagent-Role` headers (the plugin
 *      ticket-session-manager spawns one subagent per (ticket, role) and pins
 *      the role on that child's MCP config — this is the common path for
 *      agent-authored comments). Only honored when the pinned ticket matches
 *      the ticket being commented on.
 *   3. `AuthorRoleResolver` lookup. Only used when the agent holds exactly ONE
 *      role on the ticket — falling back to "all roles the agent holds" stamps
 *      every role onto the comment, which is exactly the multi-role attribution
 *      bug we want to avoid. When the agent holds 2+ roles and didn't pin one,
 *      return null and let the UI render the comment without a role badge
 *      instead of attributing it to roles the agent isn't currently acting as.
 *
 * Returns `null` when nothing resolves, so callers can omit the field entirely
 * rather than write a misleading empty string.
 */
export async function resolveAuthorRole(
  ticketRoleAssignmentService: AuthorRoleResolver | null | undefined,
  ticketId: string,
  requestedRole: string | undefined,
  authorType: 'user' | 'agent',
  authorId: string,
  sessionRole: string | undefined,
  sessionTicketId: string | undefined,
): Promise<string | null> {
  const explicit = (requestedRole || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (authorType !== 'agent') return null;

  const sessionMatchesTicket = sessionTicketId && sessionTicketId === ticketId;
  if (sessionMatchesTicket && sessionRole) return sessionRole;

  if (!ticketRoleAssignmentService) return null;
  try {
    const resolved = await ticketRoleAssignmentService.resolveForTicket(ticketId);
    const slugs = resolved
      .filter(r => r.holder?.type === 'agent' && r.holder.id === authorId)
      .map(r => r.role.slug);
    if (slugs.length === 1) return slugs[0];
    // 0 holdings → not on this ticket; 2+ → ambiguous (e.g. same agent is
    // both assignee and reviewer). Either way we don't have enough info to
    // say which role the agent is acting as right now, so omit the badge.
    return null;
  } catch {
    return null;
  }
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
