/**
 * Shared MCP tool authorization helpers.
 *
 * Ticket d6b56237 — user/api-key/agent/workspace MCP tools performed
 * destructive or privilege-changing writes without ever consulting the
 * caller's session identity. These helpers give every tool file a single,
 * fail-closed place to (a) require a DB-backed, full-scope caller bound to
 * a live Agent row (mirrors `requireAgentRegistryAccess` in
 * claude-backend-profile-tools.ts), and (b) resolve the caller's REAL
 * workspace (never trust a caller-supplied workspace_id) the same way
 * chat-tools.ts already does at its `callerWorkspaceId` call sites.
 */

import type { DataSource } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { normalizeAgentWorkspaceId } from '../../../common/agent-workspace-scope';
import type { McpAgentContext } from './session-auth';

export const FULL_SCOPE_GATE_ERROR =
  'Unauthorized: this operation requires a DB-backed, full-scope MCP key bound to an Agent.';

/**
 * Requires a DB-backed, full-scope caller bound to a live Agent row.
 * Returns an error string when the gate fails, or null when it passes —
 * callers do `const gateError = await requireFullScopeCaller(...); if (gateError) return err(gateError);`.
 */
export async function requireFullScopeCaller(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (
    !caller ||
    caller.source !== 'db' ||
    caller.scope !== 'full' ||
    !caller.agentId
  ) {
    return FULL_SCOPE_GATE_ERROR;
  }
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  return agent ? null : FULL_SCOPE_GATE_ERROR;
}

/**
 * Resolves the caller's REAL workspace: the workspace bound to the API key
 * session itself, falling back to the workspace on the caller's own Agent
 * row. Never trusts a request-supplied workspace_id parameter — that is
 * exactly the fail-open bug this helper replaces (previously
 * `!caller?.workspaceId || caller.workspaceId === workspaceId`, which
 * trusted an unbound caller's claimed workspace_id unconditionally).
 *
 * Returns null when no workspace can be resolved (unbound caller with no
 * Agent row) — callers must treat null as "deny", not "allow everything".
 */
export async function resolveCallerWorkspaceId(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (!caller) return null;
  if (caller.workspaceId) return normalizeAgentWorkspaceId(caller.workspaceId);
  if (!caller.agentId) return null;
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  return agent ? normalizeAgentWorkspaceId(agent.workspace_id) : null;
}

/**
 * True when the caller may act within `targetWorkspaceId`. A caller with an
 * explicitly bound workspace (session workspaceId, or its own Agent row's
 * workspace_id) must match exactly — this is the fail-closed replacement for
 * the old `!caller?.workspaceId || caller.workspaceId === workspaceId`
 * pattern, which trusted an unbound caller's claimed workspace_id
 * unconditionally.
 *
 * The one deliberate escape hatch preserved from that prior behavior: a
 * genuinely GLOBAL full-scope Agent (DB row with workspace_id NULL/'') may
 * still reach every workspace, but only after a DB lookup proves the agent
 * really is global — never merely because the caller omitted workspaceId.
 * Every other unresolved case (no caller, no agentId, unknown agent) denies.
 */
export async function callerCanAccessWorkspace(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
  targetWorkspaceId: string | null,
): Promise<boolean> {
  if (!caller) return false;
  if (caller.workspaceId) {
    return normalizeAgentWorkspaceId(caller.workspaceId) === targetWorkspaceId;
  }
  if (!caller.agentId) return false;
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  if (!agent) return false;
  const agentWorkspaceId = normalizeAgentWorkspaceId(agent.workspace_id);
  if (agentWorkspaceId === null) {
    return caller.scope === 'full';
  }
  return agentWorkspaceId === targetWorkspaceId;
}

export const WORKSPACE_SCOPE_GATE_ERROR =
  'Unauthorized: this operation requires a full-scope caller bound to (or a genuinely global Agent spanning) the target workspace.';

/**
 * Combines `requireFullScopeCaller` with a workspace-boundary check against
 * a specific target resource's workspace (ticket d6b56237 review round 2:
 * `requireFullScopeCaller` alone only proves "some live, full-scope Agent
 * called this," never that the caller belongs to the workspace it's about
 * to mutate — so a full-scope key bound to workspace A could update/delete
 * an Agent in workspace B, or cascade-delete workspace B itself).
 * `targetWorkspaceId` is the resource's OWN workspace (null for a genuinely
 * global resource) — never a caller-supplied parameter parroted back.
 * Returns an error string when either gate fails, or null when both pass.
 */
export async function requireWorkspaceScopedFullAccess(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
  targetWorkspaceId: string | null,
): Promise<string | null> {
  const gateError = await requireFullScopeCaller(dataSource, caller);
  if (gateError) return gateError;
  const allowed = await callerCanAccessWorkspace(dataSource, caller, targetWorkspaceId);
  return allowed ? null : WORKSPACE_SCOPE_GATE_ERROR;
}
