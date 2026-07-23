/**
 * Session-based agent identity helper.
 *
 * Each MCP tool handler receives an `extra` object with an optional
 * `sessionId`. When present, that session maps to an agent identity
 * registered at session-initialization time by mcp.controller.ts. Tools
 * use `getCallerAgent(extra)` to auto-fill creator/author fields and to
 * enforce same-agent impersonation guards.
 */

import { sessionStore, type McpAgentContext } from '../internal/session-store';

export function getCallerAgent(extra: { sessionId?: string }): McpAgentContext | undefined {
  if (!extra.sessionId) return undefined;
  return sessionStore.getAuth(extra.sessionId);
}

export type { McpAgentContext };

/**
 * Clearing a ticket's `pending_user_action` flag asserts "a human made the
 * call" — that's the whole point of the flag (see pend_ticket's doc / the
 * respawn-storm circuit breaker). MCP is an agent-only connection surface
 * (every session here resolves to an `McpAgentContext`, never a `User`), so
 * no MCP caller can ever prove that signal. Every MCP path that could flip
 * the flag true→false (`unpend_ticket`, `update_ticket`) rejects with this
 * message instead — the flip only happens through the AuthGuard-protected
 * REST `PATCH /api/tickets/:id` (wired to the ticket panel's Resume button),
 * which is unaffected by this restriction.
 */
export const HUMAN_ONLY_UNPEND_MESSAGE =
  'pending_user_action can only be cleared by a human. MCP is an agent-only connection surface with ' +
  'no authenticated user session to prove a human made this call — clear it from the AWB web UI ' +
  '(ticket panel → User tab → Resume) or an authenticated REST call to PATCH /api/tickets/:id. ' +
  'If a human already left their answer as a comment, do not call this: stop and wait — the dispatch ' +
  'loop wakes you once they (or an operator) unpend it.';
