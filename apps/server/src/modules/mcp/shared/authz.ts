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

import { Like, type DataSource, type EntityManager } from 'typeorm';
import { isRuntimeIdentityKey } from '../../../common/runtime-spec';
import { RuntimeHost } from '../../../entities/RuntimeHost';
import { normalizeAgentWorkspaceId } from '../../../common/agent-workspace-scope';
import { ApiKey } from '../../../entities/ApiKey';
import type { McpAgentContext } from './session-auth';

export const FULL_SCOPE_GATE_ERROR =
  'Unauthorized: this operation requires a DB-backed, full-scope MCP key bound to an Agent or Runtime Host.';

/**
 * Requires a DB-backed, full-scope caller bound to a live identity.
 * P4 (manager identity → RuntimeHost): host-keyed MCP sessions carry the
 * HOST uuid as caller.agentId (mcp-http-auth) and have no Agent row — a live
 * RuntimeHost row passes the same gate. Legacy Agent rows pass unchanged.
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
  // P4c-4: Host 행 또는 페어링 링크 (Agent 테이블 없음).
  const row = await resolveCallerIdentityRow(dataSource, caller.agentId);
  return row ? null : FULL_SCOPE_GATE_ERROR;
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
  // P4c-4: Host/링크 해소 (Agent 테이블 없음).
  const row = await resolveCallerIdentityRow(dataSource, caller.agentId);
  return row ? normalizeAgentWorkspaceId(row.workspace_id) : null;
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
 *
 * A null `targetWorkspaceId` (a genuinely global resource) is checked via
 * that same DB lookup FIRST, before ever consulting `caller.workspaceId` —
 * a workspace-bound ApiKey can never legitimately equal a null target by
 * definition, so short-circuiting on it there would reject every caller,
 * including a genuinely global Agent whose ApiKey row still carries a
 * non-null workspace_id from issuance context (ticket 9b7a5bb7).
 */
export async function callerCanAccessWorkspace(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
  targetWorkspaceId: string | null,
): Promise<boolean> {
  if (!caller) return false;
  // P4c-4: Host/링크 해소 (Agent 테이블 없음). Host 는 장비 단위라
  // workspace-less manager 와 같은 full-scope 취급 — pairing workspace
  // 스탬프가 있어도 경계가 아니다.
  const callerRowWorkspace = async (): Promise<string | null | undefined> => {
    if (!caller.agentId) return undefined;
    const row = await resolveCallerIdentityRow(dataSource, caller.agentId);
    if (!row) return undefined;
    if (row.kind === 'host') return null;
    return normalizeAgentWorkspaceId(row.workspace_id);
  };
  if (targetWorkspaceId === null) {
    if (!caller.agentId) return false;
    const ws = await callerRowWorkspace();
    if (ws === undefined) return false;
    return ws === null && caller.scope === 'full';
  }
  if (caller.workspaceId) {
    return normalizeAgentWorkspaceId(caller.workspaceId) === targetWorkspaceId;
  }
  if (!caller.agentId) return false;
  const ws = await callerRowWorkspace();
  if (ws === undefined) return false;
  if (ws === null) {
    return caller.scope === 'full';
  }
  return ws === targetWorkspaceId;
}

/**
 * P4c-4 caller identity row (Agent 테이블 제거 이후). host-keyed MCP 세션은
 * HOST uuid 를 caller.agentId 로 들고 온다. 실행 키는 Host에 바인딩된
 * runtime 자격 증명으로 해소하고, 삭제된 Agent UUID는 해소하지 않는다.
 */
export async function resolveCallerIdentityRow(
  dataSource: DataSource | EntityManager,
  agentId: string | undefined,
): Promise<{ kind: 'host' | 'runtime'; id: string; name: string; workspace_id: string | null } | null> {
  if (!agentId) return null;
  // Runtime credentials already carry the execution key in their provisioned
  // name. Resolve that key without querying a UUID Host column or an Agent row.
  if (isRuntimeIdentityKey(agentId)) {
    const keys = await dataSource.getRepository(ApiKey).find({ where: { name: Like(`runtime:%:${agentId}`) } });
    for (const key of keys) {
      if (!key.host_id || !key.is_active) continue;
      const host = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: key.host_id } });
      if (host) return { kind: 'runtime', id: agentId, name: key.name.slice('runtime:'.length, -(agentId.length + 1)), workspace_id: key.workspace_id || null };
    }
    return null;
  }
  const host = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: agentId } });
  if (host) {
    return { kind: 'host', id: host.id, name: host.name, workspace_id: host.workspace_id ?? null };
  }

  return null;
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
