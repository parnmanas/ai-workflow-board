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
import { resolveCallerAccountId } from '../shared/authz';
import type { ToolContext } from './context';

const SCOPE_RANK: Record<string, number> = { read: 0, write: 1, full: 2 };

const UNAUTHORIZED_MESSAGE =
  'Unauthorized: API key management requires a DB-backed MCP key bound to an Agent with a resolvable workspace.';

/**
 * Every api-key MCP tool is account-scoped to the caller — the REST
 * `/api/keys` path (guarded by PermissionGuard + AccountGuard +
 * MANAGE_API_KEYS) is the intended cross-workspace admin surface. Resolves
 * to the caller's real workspace, or null when the gate fails (never trust
 * a request-supplied account_id — there isn't one on these tools, but the
 * same "unbound caller = deny" rule from workflow-function-tools applies).
 */
async function requireCallerWorkspace(
  ctx: ToolContext,
  extra: { sessionId?: string },
): Promise<string | null> {
  const caller = getCallerAgent(extra);
  return resolveCallerAccountId(ctx.dataSource, caller);
}

export function registerApiKeyTools(server: McpServer, ctx: ToolContext): void {
  const { apiKeyService } = ctx;

  server.tool(
    'list_api_keys',
    'List API keys in your workspace (key values are masked). Shows name, scope, agent, status, usage stats.',
    {},
    async (_args: any, extra: { sessionId?: string }) => {
      const accountId = await requireCallerWorkspace(ctx, extra);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);
      const keys = await apiKeyService.listApiKeys(accountId);
      return ok(keys);
    }
  );

  server.tool(
    'get_api_key',
    'Get details of a single API key by ID (must belong to your workspace)',
    { key_id: z.string().describe('API key ID') },
    async ({ key_id }, extra: { sessionId?: string }) => {
      const accountId = await requireCallerWorkspace(ctx, extra);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);
      const key = await apiKeyService.getApiKey(key_id);
      if (!key || key.account_id !== accountId) return err('API key not found');
      return ok(key);
    }
  );

  server.tool(
    'create_api_key',
    'Create a new API key for MCP authentication, scoped to your workspace. The raw key is returned ONLY in this response — save it immediately.',
    {
      name: z.string().describe('Display name for the key (e.g. "claude-prod", "gpt-dev")'),
      scope: z.enum(['full', 'read', 'write']).optional().default('full').describe('Permission scope'),
      expires_in_days: z.number().optional().describe('Auto-expire after N days (optional, null = never)'),
    },
    async ({ name, scope, expires_in_days }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const accountId = await resolveCallerAccountId(ctx.dataSource, caller);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);

      // A caller can never mint a key with a broader scope than its own —
      // otherwise a account-scoped key could hand itself (or anyone) a
      // full-scope credential (the exact C2 escalation this ticket closes).
      const requestedScope = scope || 'full';
      const callerScope = caller?.scope || 'full';
      if (SCOPE_RANK[requestedScope] > SCOPE_RANK[callerScope]) {
        return err(`Unauthorized: cannot mint a "${requestedScope}" key from a "${callerScope}"-scoped caller.`);
      }


      let expires_at: Date | null = null;
      if (expires_in_days && expires_in_days > 0) {
        expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + expires_in_days);
      }

      const result = await apiKeyService.createApiKey({
        name,
        scope: requestedScope,
        expires_at,
        account_id: accountId,
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
      const accountId = await requireCallerWorkspace(ctx, extra);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.account_id !== accountId) return err('API key not found');
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
      const accountId = await requireCallerWorkspace(ctx, extra);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.account_id !== accountId) return err('API key not found');
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
      expires_in_days: z.number().optional().describe('Set expiry N days from now (0 or null = never expire)'),
    },
    async ({ key_id, name, scope, is_active, expires_in_days }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const accountId = await resolveCallerAccountId(ctx.dataSource, caller);
      if (!accountId) return err(UNAUTHORIZED_MESSAGE);
      const existing = await apiKeyService.getApiKey(key_id);
      if (!existing || existing.account_id !== accountId) return err('API key not found');

      if (scope !== undefined) {
        const callerScope = caller?.scope || 'full';
        if (SCOPE_RANK[scope] > SCOPE_RANK[callerScope]) {
          return err(`Unauthorized: cannot upgrade this key to "${scope}" scope from a "${callerScope}"-scoped caller.`);
        }
      }


      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (scope !== undefined) updates.scope = scope;
      if (is_active !== undefined) updates.is_active = is_active;
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
