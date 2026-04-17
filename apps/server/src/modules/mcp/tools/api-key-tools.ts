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
import type { ToolContext } from './context';

export function registerApiKeyTools(server: McpServer, ctx: ToolContext): void {
  const { apiKeyService } = ctx;

  server.tool(
    'list_api_keys',
    'List all API keys (key values are masked). Shows name, scope, agent, status, usage stats.',
    {},
    async () => {
      const keys = await apiKeyService.listApiKeys();
      return ok(keys);
    }
  );

  server.tool(
    'get_api_key',
    'Get details of a single API key by ID',
    { key_id: z.string().describe('API key ID') },
    async ({ key_id }) => {
      const key = await apiKeyService.getApiKey(key_id);
      if (!key) return err('API key not found');
      return ok(key);
    }
  );

  server.tool(
    'create_api_key',
    'Create a new API key for MCP authentication. The raw key is returned ONLY in this response — save it immediately.',
    {
      name: z.string().describe('Display name for the key (e.g. "claude-prod", "gpt-dev")'),
      agent_id: z.string().optional().describe('Link to an Agent ID (optional)'),
      scope: z.enum(['full', 'read', 'write']).optional().default('full').describe('Permission scope'),
      expires_in_days: z.number().optional().describe('Auto-expire after N days (optional, null = never)'),
    },
    async ({ name, agent_id, scope, expires_in_days }) => {
      let expires_at: Date | null = null;
      if (expires_in_days && expires_in_days > 0) {
        expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + expires_in_days);
      }

      const result = await apiKeyService.createApiKey({ name, agent_id: agent_id ?? null, scope, expires_at });
      return ok({
        ...result.apiKey,
        raw_key: result.raw_key,
        _notice: 'Save the raw_key now. It will NOT be shown again.',
      });
    }
  );

  server.tool(
    'revoke_api_key',
    'Revoke (deactivate) an API key. The key remains in DB but can no longer authenticate.',
    { key_id: z.string().describe('API key ID to revoke') },
    async ({ key_id }) => {
      const success = await apiKeyService.revokeApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true, message: 'Key revoked' });
    }
  );

  server.tool(
    'delete_api_key',
    'Permanently delete an API key from the database',
    { key_id: z.string().describe('API key ID to delete') },
    async ({ key_id }) => {
      const success = await apiKeyService.deleteApiKey(key_id);
      if (!success) return err('API key not found');
      return ok({ success: true });
    }
  );

  server.tool(
    'update_api_key',
    'Update an API key\'s metadata (name, scope, active status, expiration, agent link)',
    {
      key_id: z.string().describe('API key ID'),
      name: z.string().optional().describe('New display name'),
      scope: z.enum(['full', 'read', 'write']).optional().describe('New scope'),
      is_active: z.number().optional().describe('1 = active, 0 = revoked'),
      agent_id: z.string().optional().describe('Link to Agent ID (null to unlink)'),
      expires_in_days: z.number().optional().describe('Set expiry N days from now (0 or null = never expire)'),
    },
    async ({ key_id, name, scope, is_active, agent_id, expires_in_days }) => {
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
