/**
 * API key management MCP tools.
 *
 * Tools: list_api_keys, get_api_key, create_api_key, revoke_api_key,
 *        delete_api_key, update_api_key
 *
 * All persistence goes through ctx.apiKeyService (which in turn uses the
 * ApiKey TypeORM repository). The previous in-file createApiKey/listApiKeys
 * helpers are gone.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { resolveCallerWorkspaceId } from '../shared/authz';
import { Agent } from '../../../entities/Agent';
import { agentIsVisibleInWorkspace } from '../../../common/agent-workspace-scope';
import type { ToolContext } from './context';

const FOREIGN_AGENT_MESSAGE =
  'Unauthorized: agent_id must reference an Agent visible in your workspace.';

/**
 * An api key's agent_id link must point at an Agent the caller's own
 * workspace can actually see — otherwise workspace A could bind its key to
 * a workspace B Agent id, muddying audit/attribution across the tenant
 * boundary (ticket d6b56237 review round 2). Reuses the same visibility
 * rule artifacts already use (`agentIsVisibleInWorkspace`): workspace-local
 * or genuinely global Agents pass, anything bound to a DIFFERENT workspace
 * does not.
 */
async function agentIdVisibleInWorkspace(
  ctx: ToolContext,
  agentId: string,
  workspaceId: string,
): Promise<boolean> {
  const agent = await ctx.dataSource.getRepository(Agent).findOne({ where: { id: agentId } });
  return !!agent && agentIsVisibleInWorkspace(agent.workspace_id, workspaceId);
}

const SCOPE_RANK: Record<string, number> = { read: 0, write: 1, full: 2 };

const UNAUTHORIZED_MESSAGE =
  'Unauthorized: API key management requires a DB-backed MCP key bound to an Agent with a resolvable workspace.';

/**
 * Every api-key MCP tool is workspace-scoped to the caller — the REST
 * `/api/keys` path (guarded by PermissionGuard + WorkspaceGuard +
 * MANAGE_API_KEYS) is the intended cross-workspace admin surface. Resolves
 * to the caller's real workspace, or null when the gate fails (never trust
 * a request-supplied workspace_id — there isn't one on these tools, but the
 * same "unbound caller = deny" rule from workflow-function-tools applies).
 */
async function requireCallerWorkspace(
  ctx: ToolContext,
  extra: { sessionId?: string },
): Promise<string | null> {
  const caller = getCallerAgent(extra);
  return resolveCallerWorkspaceId(ctx.dataSource, caller);
}

export function registerApiKeyTools(server: McpServer, ctx: ToolContext): void {
  const { apiKeyService } = ctx;

  server.tool(
    'list_api_keys',
    'List API keys in your workspace (key values are masked). Shows name, scope, agent, status, usage stats.',
    {},
    async (_args: any, extra: { sessionId?: string }) => {
      const workspaceId = await requireCallerWorkspace(ctx, extra);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);
      const keys = await apiKeyService.listApiKeys(workspaceId);
      return ok(keys);
    }
  );

  server.tool(
    'get_api_key',
    'Get details of a single API key by ID (must belong to your workspace)',
    { key_id: z.string().describe('API key ID') },
    async ({ key_id }, extra: { sessionId?: string }) => {
      const workspaceId = await requireCallerWorkspace(ctx, extra);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);
      const key = await apiKeyService.getApiKey(key_id);
      if (!key || key.workspace_id !== workspaceId) return err('API key not found');
      return ok(key);
    }
  );

  server.tool(
    'create_api_key',
    'Create a new API key for MCP authentication, scoped to your workspace. The raw key is returned ONLY in this response — save it immediately.',
    {
      name: z.string().describe('Display name for the key (e.g. "claude-prod", "gpt-dev")'),
      agent_id: z.string().optional().describe('Link to an Agent ID (optional)'),
      scope: z.enum(['full', 'read', 'write']).optional().default('full').describe('Permission scope'),
      expires_in_days: z.number().optional().describe('Auto-expire after N days (optional, null = never)'),
    },
    async ({ name, agent_id, scope, expires_in_days }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const workspaceId = await resolveCallerWorkspaceId(ctx.dataSource, caller);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);

      // A caller can never mint a key with a broader scope than its own —
      // otherwise a workspace-scoped key could hand itself (or anyone) a
      // full-scope credential (the exact C2 escalation this ticket closes).
      const requestedScope = scope || 'full';
      const callerScope = caller?.scope || 'full';
      if (SCOPE_RANK[requestedScope] > SCOPE_RANK[callerScope]) {
        return err(`Unauthorized: cannot mint a "${requestedScope}" key from a "${callerScope}"-scoped caller.`);
      }

      if (agent_id && !(await agentIdVisibleInWorkspace(ctx, agent_id, workspaceId))) {
        return err(FOREIGN_AGENT_MESSAGE);
      }

      let expires_at: Date | null = null;
      if (expires_in_days && expires_in_days > 0) {
        expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + expires_in_days);
      }

      const result = await apiKeyService.createApiKey({
        name,
        agent_id: agent_id ?? null,
        scope: requestedScope,
        expires_at,
        workspace_id: workspaceId,
      });
      return ok({
        ...result.apiKey,
        raw_key: result.raw_key,
        _notice: 'Save the raw_key now. It will NOT be shown again.',
      });
    }
  );

  server.tool(
    'revoke_api_key',
    'Revoke (deactivate) an API key in your workspace. The key remains in DB but can no longer authenticate.',
    { key_id: z.string().describe('API key ID to revoke') },
    async ({ key_id }, extra: { sessionId?: string }) => {
      const workspaceId = await requireCallerWorkspace(ctx, extra);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.workspace_id !== workspaceId) return err('API key not found');
      const success = await apiKeyService.revokeApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true, message: 'Key revoked' });
    }
  );

  server.tool(
    'delete_api_key',
    'Permanently delete an API key from your workspace',
    { key_id: z.string().describe('API key ID to delete') },
    async ({ key_id }, extra: { sessionId?: string }) => {
      const workspaceId = await requireCallerWorkspace(ctx, extra);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.workspace_id !== workspaceId) return err('API key not found');
      const success = await apiKeyService.deleteApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true });
    }
  );

  server.tool(
    'update_api_key',
    'Update an API key\'s metadata (name, scope, active status, expiration, agent link) within your workspace',
    {
      key_id: z.string().describe('API key ID'),
      name: z.string().optional().describe('New display name'),
      scope: z.enum(['full', 'read', 'write']).optional().describe('New scope'),
      is_active: z.number().optional().describe('1 = active, 0 = revoked'),
      agent_id: z.string().optional().describe('Link to Agent ID (null to unlink)'),
      expires_in_days: z.number().optional().describe('Set expiry N days from now (0 or null = never expire)'),
    },
    async ({ key_id, name, scope, is_active, agent_id, expires_in_days }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const workspaceId = await resolveCallerWorkspaceId(ctx.dataSource, caller);
      if (!workspaceId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.workspace_id !== workspaceId) return err('API key not found');

      if (scope !== undefined) {
        const callerScope = caller?.scope || 'full';
        if (SCOPE_RANK[scope] > SCOPE_RANK[callerScope]) {
          return err(`Unauthorized: cannot upgrade this key to "${scope}" scope from a "${callerScope}"-scoped caller.`);
        }
      }

      if (agent_id !== undefined && agent_id && !(await agentIdVisibleInWorkspace(ctx, agent_id, workspaceId))) {
        return err(FOREIGN_AGENT_MESSAGE);
      }

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (scope !== undefined) updates.scope = scope;
      if (is_active !== undefined) updates.is_active = is_active;
      if (agent_id !== undefined) updates.agent_id = agent_id;
      if (expires_in_days !== undefined) {
        if (expires_in_days === 0) {
          updates.expires_at = null;
        } else {
          const d = new Date();
          d.setDate(d.getDate() + expires_in_days);
          updates.expires_at = d;
        }
      }

      const result = await apiKeyService.updateApiKey(key_id, updates);
      if (!result) return err('API key not found');
      return ok(result);
    }
  );
}
