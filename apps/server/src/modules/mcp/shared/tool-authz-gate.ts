/**
 * Central MCP tool authorization gate.
 *
 * Ticket 838f43c4 (follow-up to d6b56237) — d6b56237 fixed four specific
 * tool files (user/api-key/agent/workspace) after they shipped destructive,
 * privilege-changing operations with zero caller-identity checks. That was a
 * per-file fix; the structural hole stayed open: `registerAllTools`
 * (tools/index.ts) auto-discovers and registers every `*-tools.ts` file by
 * filename convention alone, so a FIFTH admin-grade tool file added tomorrow
 * would be exposed to every MCP session with no opt-in gate — exactly what
 * happened to the four files d6b56237 had to patch after the fact.
 *
 * This module wraps `McpServer.tool()` itself, at the one place both the
 * NestJS-integrated controller (mcp.controller.ts) and the standalone entry
 * point (mcp-server.ts) funnel through — `registerAllTools()`. Every tool
 * registration, from every tool file, passes through here before its own
 * handler ever runs:
 *
 *   - Tools explicitly listed in TOOL_AUTHZ_TABLE are checked against their
 *     assigned tier BEFORE the tool's own handler runs — redundant, on
 *     purpose. If a future edit ever drops the per-file check (the exact
 *     failure mode d6b56237 fixed), this still catches it.
 *   - Tools NOT in the table but named like a destructive operation
 *     (`delete_*` / `revoke_*`) fall back to a safe default tier instead of
 *     running completely ungated — this is what actually closes the
 *     "forgot to gate the 5th file" hole for tools that don't exist yet.
 *   - Everything else (reads, non-destructive-looking names) passes through
 *     untouched — this gate does not attempt to re-audit the full 190-tool
 *     surface, only the destructive slice this ticket scoped in.
 *
 * Tier semantics reuse shared/authz.ts exactly so behavior never diverges
 * from what the per-file gates already enforce:
 *   - 'full'   → requireFullScopeCaller: DB-backed, full-scope, agent-bound.
 *                Only used where the tool's OWN logic already requires this
 *                unconditionally (verified directly against source, not
 *                inferred from tests — see the table comments below).
 *   - 'caller' → any resolvable MCP caller identity (getCallerAgent(extra)
 *                is non-null). The same minimal floor create_user /
 *                update_user already use — safe as a universal default
 *                because every legitimately authenticated session already
 *                has one by the time a tool handler runs; it only rejects
 *                sessionless / stale / malformed calls.
 *
 * Deliberately NOT tiered here (left to their existing per-file logic):
 * update_workspace (a workspace-bound non-full-scope caller is intentionally
 * allowed — see workspace-tools.ts's callerCanAccessWorkspace usage) and
 * move_agent_to_workspace (only gated when dry_run=false; a static per-name
 * tier can't express that without misgating the dry-run preview). Neither
 * matches the delete_* / revoke_* fallback pattern, so both stay exactly as
 * they were before this ticket.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataSource } from 'typeorm';
import { err } from './helpers';
import { getCallerAgent, type McpAgentContext } from './session-auth';
import { requireFullScopeCaller } from './authz';

export type AuthzTier = 'full' | 'caller';

/**
 * Tool name → required tier. Every entry has been verified against its own
 * handler source (not inferred from tests) to confirm the tier never
 * rejects a call the tool's existing logic would otherwise allow.
 */
export const TOOL_AUTHZ_TABLE: Record<string, AuthzTier> = {
  // Role/permission + credential-minting + cross-workspace-cascade tools —
  // d6b56237's originally-reported set. Every one of these unconditionally
  // calls requireFullScopeCaller (directly, or via
  // requireWorkspaceScopedFullAccess whose first step is
  // requireFullScopeCaller), so 'full' here never conflicts with existing
  // behavior.
  delete_user: 'full',
  create_agent: 'full',
  update_agent: 'full',
  delete_agent: 'full',
  delete_workspace: 'full',

  // Same file family, but their own logic deliberately allows a
  // non-full-scope caller through (e.g. a 'write'-scoped key minting a
  // 'read'-scoped key for itself) — the central gate only asserts SOME
  // resolvable caller, never anonymous/sessionless, and leaves the
  // scope-ceiling / workspace-match nuance to the handler that already
  // implements it.
  create_user: 'caller',
  update_user: 'caller',
  create_api_key: 'caller',
  update_api_key: 'caller',
  revoke_api_key: 'caller',
  delete_api_key: 'caller',
};

/**
 * Tool names matching this pattern, when NOT already a key in
 * TOOL_AUTHZ_TABLE, fall back to DEFAULT_DESTRUCTIVE_TIER instead of
 * running completely ungated.
 */
const DESTRUCTIVE_NAME_PATTERN = /^(delete_|revoke_)/;

/**
 * Safe universal floor for a delete_* / revoke_* tool nobody has explicitly
 * classified yet. Deliberately 'caller', not 'full': today's ~16 delete_*
 * tools outside d6b56237's set (delete_board, delete_ticket, delete_action,
 * delete_qa_scenario, ...) run with ZERO caller check today — defaulting
 * them straight to full-scope-required would be a production-breaking
 * behavior change this ticket explicitly scopes out (see the ticket's
 * "범위가 아닌 것" section). 'caller' is non-breaking (every legitimately
 * authenticated session already has one) while still closing the
 * fully-anonymous / malformed-session gap for every destructive tool that
 * exists today, and forces a conscious tier choice for anything genuinely
 * new.
 */
const DEFAULT_DESTRUCTIVE_TIER: AuthzTier = 'caller';

/** Resolves the tier a tool name must satisfy, or null if this gate does not apply to it. */
export function resolveAuthzTier(toolName: string): AuthzTier | null {
  const mapped = TOOL_AUTHZ_TABLE[toolName];
  if (mapped) return mapped;
  return DESTRUCTIVE_NAME_PATTERN.test(toolName) ? DEFAULT_DESTRUCTIVE_TIER : null;
}

async function checkAuthzTier(
  tier: AuthzTier,
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (tier === 'full') {
    return requireFullScopeCaller(dataSource, caller);
  }
  return caller ? null : 'Unauthorized: this operation requires a resolvable MCP caller identity.';
}

type ToolMethod = McpServer['tool'];

/**
 * Wraps `server.tool()` in place so every registration made through this
 * `server` instance from this call forward is checked against the authz
 * table before its handler runs. Overload-agnostic: `.tool()` supports
 * several positional-argument shapes (name, [description], [schema],
 * [annotations], callback) but the callback is always the last argument and
 * every other argument is forwarded untouched, so this never needs to
 * interpret the SDK's overload resolution itself.
 *
 * Mutates `server` (`.tool` becomes an own-property shadowing the prototype
 * method) — safe because `registerAllTools` builds a brand-new McpServer
 * per MCP session (see internal/create-mcp-server.ts), so there is never a
 * shared instance to double-wrap or leak state across sessions.
 */
export function installToolAuthzGate(server: McpServer, dataSource: DataSource): void {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as unknown as { tool: ToolMethod }).tool = ((...args: unknown[]) => {
    const name = args[0];
    const lastIndex = args.length - 1;
    const handler = args[lastIndex];
    const tier = typeof name === 'string' ? resolveAuthzTier(name) : null;

    if (!tier || typeof handler !== 'function') {
      return originalTool(...args);
    }

    const gatedHandler = async (...handlerArgs: unknown[]) => {
      const extra = (handlerArgs[handlerArgs.length - 1] || {}) as { sessionId?: string };
      const caller = getCallerAgent(extra);
      const gateError = await checkAuthzTier(tier, dataSource, caller);
      if (gateError) return err(gateError);
      return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
    };

    const nextArgs = args.slice(0, lastIndex).concat([gatedHandler]);
    return originalTool(...nextArgs);
  }) as ToolMethod;
}
