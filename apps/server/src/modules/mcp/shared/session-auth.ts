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
