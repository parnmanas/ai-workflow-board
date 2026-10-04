/**
 * Event-subscription MCP tool.
 *
 * Tools:
 *   - subscribe_events: pull activity log slice (time-cursor paginated),
 *     optionally narrowed to a workspace / tag set / the caller's tickets.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActivityLog } from '../../../entities/ActivityLog';
import { Ticket } from '../../../entities/Ticket';
import { ok } from '../shared/helpers';
import { parseTags } from '../../tickets/ticket.service';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerTriggerTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'subscribe_events',
    'Subscribe to ticket events. Returns recent events since the given cursor (ISO timestamp or event ID). Events include ticket creation, updates, moves, comments, and agent assignments. Poll periodically to receive updates.',
    {
      workspace_id: z.string().optional().describe('Filter events by workspace (omit for all)'),
      tags: z.array(z.string()).optional().describe('Only events of tickets carrying every one of these tags'),
      since: z.string().optional().describe('ISO timestamp or activity log ID cursor — returns events after this point. Omit for last 10 minutes.'),
      limit: z.number().optional().default(50).describe('Max events to return'),
      assigned_to_me: z.boolean().optional().default(false).describe('Only return events for tickets assigned to the authenticated agent'),
    },
    async ({ workspace_id, tags, since, limit, assigned_to_me }, extra: { sessionId?: string }) => {
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

      if (workspace_id || (tags && tags.length)) {
        const qb = dataSource.getRepository(Ticket).createQueryBuilder('t').select(['t.id', 't.parent_id', 't.tags']);
        if (workspace_id) qb.where('t.workspace_id = :ws', { ws: workspace_id });
        const rows = await qb.getMany();
        const wanted = (tags || []).map((t) => t.toLowerCase());
        const rootOk = new Set(rows
          .filter((t) => !t.parent_id)
          .filter((t) => wanted.every((tag) => parseTags(t.tags).some((have) => have.toLowerCase() === tag)))
          .map((t) => t.id));
        const ticketIds = new Set<string>(rootOk);
        for (const t of rows) if (t.parent_id && rootOk.has(t.parent_id)) ticketIds.add(t.id);
        events = events.filter(e => e.ticket_id && ticketIds.has(e.ticket_id));
      }

      if (assigned_to_me && caller?.runtimeKey) {
        const myTickets = await dataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .where('t.assignee_key = :key', { key: caller.runtimeKey })
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
