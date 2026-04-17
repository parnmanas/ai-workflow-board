/**
 * Activity log MCP tools.
 *
 * Tools: get_ticket_activity, get_recent_activity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../shared/helpers';
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
    async ({ ticket_id, limit }) => {
      const logs = await activityService.getTicketActivity(ticket_id, limit);
      return ok(logs);
    }
  );

  server.tool(
    'get_recent_activity',
    'Get the global recent activity feed across all tickets',
    {
      limit: z.number().optional().default(100).describe('Max number of entries'),
    },
    async ({ limit }) => {
      const logs = await activityService.getRecentActivity(limit);
      return ok(logs);
    }
  );
}
