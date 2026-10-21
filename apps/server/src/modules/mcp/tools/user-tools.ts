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
import { User } from '../../../entities/User';
import { Account } from '../../../entities/Account';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { resolveCallerAccountId, resolveCallerIdentityRow } from '../shared/authz';
import type { ToolContext } from './context';

export function registerUserTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;
  const ownerId = async (extra: { sessionId?: string }) => {
    const accountId = await resolveCallerAccountId(dataSource, getCallerAgent(extra));
    return accountId ? (await dataSource.getRepository(Account).findOneBy({ id: accountId }))?.owner_user_id : null;
  };

  server.tool(
    'list_users',
    'List login users in the authenticated account',
    {},
    async (_args, extra) => {
      const id = await ownerId(extra);
      if (!id) return err('Unauthorized: account owner is unavailable');
      const users = await dataSource.getRepository(User).find({ where: { id } });
      return ok(users);
    }
  );

  server.tool(
    'get_user',
    'Get a single user by ID',
    { user_id: z.string().describe('User ID') },
    async ({ user_id }, extra) => {
      if (await ownerId(extra) !== user_id) return err('User not found');
      const user = await dataSource.getRepository(User).findOne({ where: { id: user_id } });
      if (!user) return err('User not found');
      return ok(user);
    }
  );

  // A runtime key controls work, not login identities. Keep old tool names as
  // explicit denials so old clients cannot regain cross-account user writes.
  const loginUserInput = {
      user_id: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
      avatar_url: z.string().optional(),
      role: z.enum(['admin', 'user']).optional(),
      discord_user_id: z.string().optional(),
      permissions: z.array(z.string()).optional(),
  };
  const humanOnly = async () => err('Unauthorized: manage login users, role and permissions from the AWB admin UI.');
  server.tool('create_user', 'Login-user administration requires the human admin UI.', loginUserInput, humanOnly);
  server.tool('update_user', 'Login-user administration requires the human admin UI.', loginUserInput, humanOnly);
  server.tool('delete_user', 'Login-user administration requires the human admin UI.', loginUserInput, humanOnly);

  server.tool(
    'whoami',
    'Returns the authenticated agent identity for this MCP session. Use this to verify your connection and identity.',
    {},
    async (_args: any, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return ok({ authenticated: false, message: 'No agent context — running in dev mode or unauthenticated.' });

      // P4: Agent 행 또는 Host 행 — host-keyed 세션도 identity 를 본다.
      let agentInfo: Record<string, any> | null = null;
      if (caller.agentId) {
        const found = await resolveCallerIdentityRow(dataSource, caller.agentId);
        if (found) {
          agentInfo = {
            id: found.id,
            name: found.name,
            kind: found.kind,
            account_id: found.account_id || '',
          };
        }
      }

      return ok({
        authenticated: true,
        agent_id: caller.agentId || null,
        agent_name: caller.agentName || null,
        // Surfaced at top level too so plugin pollers don't have to dig into
        // the nested agent object — they need this to call account-scoped
        // tools like get_pending_triggers without an extra round trip.
        account_id: agentInfo?.account_id || '',
        scope: caller.scope || 'full',
        source: caller.source,
        agent: agentInfo,
      });
    }
  );
}
