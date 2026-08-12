/**
 * User-domain MCP tools.
 *
 * Tools: list_users, get_user, create_user, update_user, delete_user, whoami
 *
 * `whoami` returns the authenticated agent identity for the MCP session
 * — it lives with user tools because it answers "who am I" from the
 * caller's perspective.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { User } from '../../../entities/User';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { requireFullScopeCaller } from '../shared/authz';
import type { ToolContext } from './context';

export function registerUserTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'list_users',
    'List all registered users',
    {},
    async () => {
      const users = await dataSource.getRepository(User).find({ order: { name: 'ASC' } });
      return ok(users);
    }
  );

  server.tool(
    'get_user',
    'Get a single user by ID',
    { user_id: z.string().describe('User ID') },
    async ({ user_id }) => {
      const user = await dataSource.getRepository(User).findOne({ where: { id: user_id } });
      if (!user) return err('User not found');
      return ok(user);
    }
  );

  server.tool(
    'create_user',
    'Create a new user',
    {
      name: z.string().describe('User name'),
      email: z.string().optional().default('').describe('Email address'),
      avatar_url: z.string().optional().default('').describe('Avatar URL'),
      role: z.enum(['admin', 'user']).optional().default('user').describe('User role'),
      discord_user_id: z.string().optional().default('').describe('Discord user ID for @mentions'),
      permissions: z.array(z.string()).optional().default([]).describe('Custom permissions (e.g. ["admin.users","admin.agents"])'),
    },
    async ({ name, email, avatar_url, role, discord_user_id, permissions }, extra: { sessionId?: string }) => {
      // Fail-closed caller identity gate (ticket d6b56237 review round 2):
      // a request with no session, or a sessionId that resolves to nothing,
      // must be rejected rather than silently treated as an anonymous-but-
      // permitted create. This does NOT require full scope — any resolvable
      // caller identity is enough — role/permissions stay fully blocked below
      // regardless of who's calling.
      if (!getCallerAgent(extra)) {
        return err('Unauthorized: create_user requires a resolvable MCP caller identity.');
      }
      // MCP is an agent-only connection surface (see HUMAN_ONLY_UNPEND_MESSAGE
      // in shared/session-auth.ts) — no MCP caller, regardless of scope, may
      // mint an admin AWB user or grant custom permissions through this tool.
      // Role/permission management is a human-operator (web UI) action.
      if ((role && role !== 'user') || (permissions && permissions.length > 0)) {
        return err('Unauthorized: role and permissions cannot be set via MCP. Manage them from the AWB admin UI.');
      }
      const userRepo = dataSource.getRepository(User);
      const userData: any = { name, email, avatar_url, role: 'user', discord_user_id };
      const user = await userRepo.save(userRepo.create(userData));
      return ok(user);
    }
  );

  server.tool(
    'update_user',
    'Update a user',
    {
      user_id: z.string().describe('User ID'),
      name: z.string().optional().describe('New name'),
      email: z.string().optional().describe('New email'),
      avatar_url: z.string().optional().describe('New avatar URL'),
      role: z.enum(['admin', 'user']).optional().describe('New role'),
      discord_user_id: z.string().optional().describe('New Discord user ID'),
      permissions: z.array(z.string()).optional().describe('Custom permissions array'),
    },
    async ({ user_id, name, email, avatar_url, role, discord_user_id, permissions }, extra: { sessionId?: string }) => {
      // Same fail-closed caller identity gate as create_user — a request
      // with no session, or an unresolvable sessionId, is rejected outright
      // rather than allowed to rename/re-email/re-link a user anonymously.
      if (!getCallerAgent(extra)) {
        return err('Unauthorized: update_user requires a resolvable MCP caller identity.');
      }
      // Same rationale as create_user: role/permissions are a human-operator
      // concern, never MCP-writable — this closes the privilege-escalation
      // path where any authenticated key could promote an arbitrary user to
      // admin or grant custom permissions.
      if (role !== undefined || permissions !== undefined) {
        return err('Unauthorized: role and permissions cannot be changed via MCP. Manage them from the AWB admin UI.');
      }
      const userRepo = dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: user_id } });
      if (!user) return err('User not found');

      if (name !== undefined) user.name = name;
      if (email !== undefined) user.email = email;
      if (avatar_url !== undefined) user.avatar_url = avatar_url;
      if (discord_user_id !== undefined) user.discord_user_id = discord_user_id;

      const updated = await userRepo.save(user);
      return ok(updated);
    }
  );

  server.tool(
    'delete_user',
    'Delete a user',
    { user_id: z.string().describe('User ID') },
    async ({ user_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const gateError = await requireFullScopeCaller(dataSource, caller);
      if (gateError) return err(gateError);

      const userRepo = dataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: user_id } });
      if (!user) return err('User not found');
      await userRepo.delete(user.id);
      return ok({ success: true });
    }
  );

  server.tool(
    'whoami',
    'Returns the authenticated agent identity for this MCP session. Use this to verify your connection and identity.',
    {},
    async (_args: any, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return ok({ authenticated: false, message: 'No agent context — running in dev mode or unauthenticated.' });

      let agentInfo: Record<string, any> | null = null;
      if (caller.agentId) {
        const found = await dataSource.getRepository(Agent).findOne({
          where: { id: caller.agentId },
        });
        if (found) {
          agentInfo = {
            id: found.id,
            name: found.name,
            type: found.type,
            description: found.description,
            is_active: found.is_active,
            workspace_id: found.workspace_id || '',
          };
        }
      }

      return ok({
        authenticated: true,
        agent_id: caller.agentId || null,
        agent_name: caller.agentName || null,
        // Surfaced at top level too so plugin pollers don't have to dig into
        // the nested agent object — they need this to call workspace-scoped
        // tools like get_pending_triggers without an extra round trip.
        workspace_id: agentInfo?.workspace_id || '',
        scope: caller.scope || 'full',
        source: caller.source,
        agent: agentInfo,
      });
    }
  );
}
