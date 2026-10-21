/**
 * Activity log MCP tools.
 *
 * Tools: get_ticket_activity, get_recent_activity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { resolveCallerAccountId } from '../shared/authz';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerActivityTools(server: McpServer, ctx: ToolContext): void {
  const { activityService } = ctx;

  server.tool(
    'get_ticket_activity',
    'Get activity log for a specific ticket',
    {
      ticket_id: z.string().describe('Ticket ID'),
      limit: z.number().optional().default(50).describe('Max number of entries'),
    },
    async ({ ticket_id, limit }, extra) => {
      const accountId = await resolveCallerAccountId(ctx.dataSource, getCallerAgent(extra));
      if (!accountId) return err('Unauthorized: account required');
      const logs = await activityService.getTicketActivity(ticket_id, [accountId], limit);
      return ok(logs);
    }
  );

  server.tool(
    'get_recent_activity',
    'Get recent activity in the authenticated account',
    {
      limit: z.number().optional().default(100).describe('Max number of entries'),
    },
    async ({ limit }, extra) => {
      const accountId = await resolveCallerAccountId(ctx.dataSource, getCallerAgent(extra));
      if (!accountId) return err('Unauthorized: account required');
      const logs = await activityService.getRecentActivity([accountId], limit);
      return ok(logs);
    }
  );
}
