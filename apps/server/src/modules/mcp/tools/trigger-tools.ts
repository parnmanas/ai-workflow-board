/**
 * Agent allocation + event-subscription MCP tools.
 *
 * v0.25.0: AgentTrigger table + manual/get_pending/acknowledge tools removed.
 * Plugin-side 5-minute polling of get_allocated_tickets replaces the pending
 * trigger retry path.
 *
 * Tools:
 *   - get_allocated_tickets: tickets whose current column's routing_config
 *     assigns a role the calling agent holds AND the column is not terminal.
 *     Each row carries `my_last_update_at` — max of (this agent's latest
 *     comment on the ticket, this agent's latest ActivityLog entry on the
 *     ticket) — so the plugin can detect silent subagents and respawn them.
 *   - subscribe_events: pull activity log slice (time-cursor paginated)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActivityLog } from '../../../entities/ActivityLog';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerTriggerTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, allocationService } = ctx;

  server.tool(
    'get_allocated_tickets',
    'Return tickets currently allocated to the calling agent: tickets whose ' +
    'column\'s routing_config assigns a role the agent holds AND whose column ' +
    'is not marked terminal (is_terminal=false). Each row carries column_position ' +
    'and priority_index for client-side sorting, plus my_last_update_at = MAX(' +
    'latest comment by this agent, latest ActivityLog actor=this agent) so the ' +
    'plugin can detect silent subagents. Purely routing_config-driven.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      workspace_id: z.string().describe('Workspace to scope results'),
    },
    async ({ agent_id, workspace_id }) => {
      if (!allocationService) {
        return err('get_allocated_tickets is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const result = await allocationService.getAllocatedTickets(agent_id, workspace_id);
      if ('error' in result) return err(result.error);
      return ok(result);
    }
  );

  server.tool(
    'subscribe_events',
    'Subscribe to board events. Returns recent events since the given cursor (ISO timestamp or event ID). Events include ticket creation, updates, moves, comments, and agent assignments. Poll periodically to receive updates.',
    {
      board_id: z.string().optional().describe('Filter events by board ID (omit for all boards)'),
      since: z.string().optional().describe('ISO timestamp or activity log ID cursor — returns events after this point. Omit for last 10 minutes.'),
      limit: z.number().optional().default(50).describe('Max events to return'),
      assigned_to_me: z.boolean().optional().default(false).describe('Only return events for tickets assigned to the authenticated agent'),
    },
    async ({ board_id, since, limit, assigned_to_me }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const repo = dataSource.getRepository(ActivityLog);

      let query = repo.createQueryBuilder('a')
        .orderBy('a.created_at', 'ASC')
        .take(limit);

      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          query = query.where('a.created_at > :since', { since: sinceDate.toISOString() });
        } else {
          const ref = await repo.findOne({ where: { id: parseInt(since) as any } });
          if (ref) {
            query = query.where('a.created_at > :since', { since: ref.created_at });
          }
        }
      } else {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        query = query.where('a.created_at > :since', { since: tenMinAgo });
      }

      let events = await query.getMany();

      if (board_id) {
        const ticketIds = new Set<string>();
        const tickets = await dataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .innerJoin(BoardColumn, 'col', 'col.id = t.column_id')
          .where('col.board_id = :board_id', { board_id })
          .select('t.id')
          .getMany();
        tickets.forEach(t => ticketIds.add(t.id));

        if (ticketIds.size > 0) {
          const children = await dataSource.getRepository(Ticket)
            .createQueryBuilder('t')
            .where('t.parent_id IN (:...ids)', { ids: Array.from(ticketIds) })
            .select('t.id')
            .getMany();
          children.forEach(c => ticketIds.add(c.id));
        }

        events = events.filter(e => e.ticket_id && ticketIds.has(e.ticket_id));
      }

      if (assigned_to_me && caller?.agentId) {
        const myTickets = await dataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .where('t.assignee_id = :agentId', { agentId: caller.agentId })
          .select('t.id')
          .getMany();
        const myTicketIds = new Set(myTickets.map(t => t.id));
        events = events.filter(e => e.ticket_id && myTicketIds.has(e.ticket_id));
      }

      const cursor = events.length > 0
        ? events[events.length - 1].created_at
        : since || new Date().toISOString();

      return ok({
        events: events.map(e => ({
          id: e.id,
          entity_type: e.entity_type,
          action: e.action,
          ticket_id: e.ticket_id,
          field_changed: e.field_changed || undefined,
          old_value: e.old_value || undefined,
          new_value: e.new_value || undefined,
          actor_id: e.actor_id || undefined,
          actor_name: e.actor_name || undefined,
          timestamp: e.created_at,
        })),
        cursor,
        count: events.length,
        has_more: events.length >= limit,
      });
    }
  );
}
