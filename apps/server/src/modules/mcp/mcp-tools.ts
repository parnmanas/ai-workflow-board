/**
 * AI-Workflow Board MCP Tool Registrations — thin shim.
 *
 * Phase 3 split the 68 MCP tools into `tools/<domain>-tools.ts` files.
 * This module used to contain the monolithic registration (2600+ lines);
 * it now exists only to preserve the pre-split public API for external
 * importers (notably `apps/server/test/chat-roundtrip.test.mjs`, which
 * references `setSessionAuth`, `removeSessionAuth`, and `registerAllTools`
 * at the module level).
 *
 * New code should import from `./tools` directly:
 *
 *   import { registerAllTools, createStandaloneContext } from './tools';
 */

export { registerAllTools, createStandaloneContext, type ToolContext } from './tools';

// ─── Agent Auth Context (per-session) ──────────────────────
// Session auth context lives in internal/session-store. These re-exports
// preserve backward compatibility for callers that used to set/clear
// session-level agent identity via mcp-tools.ts. The controller now
// registers auth atomically at session-init via sessionStore.register().
import { sessionStore, type McpAgentContext } from './internal/session-store';

export type { McpAgentContext };

export function setSessionAuth(sessionId: string, ctx: McpAgentContext) {
  sessionStore.setAuth(sessionId, ctx);
}

export function removeSessionAuth(sessionId: string) {
  sessionStore.removeAuth(sessionId);
}
