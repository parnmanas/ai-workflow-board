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
import { Agent } from '../../../entities/Agent';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Comment } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// Role → ticket field. The three system-defined role slots on a Ticket.
// routing_config maps user-chosen column names to these three roles.
const ROLE_TO_TICKET_FIELD: Record<string, 'assignee_id' | 'reporter_id' | 'reviewer_id'> = {
  assignee: 'assignee_id',
  reporter: 'reporter_id',
  reviewer: 'reviewer_id',
};

// Plugin-side priority ordering uses index in this list (lower = higher priority).
// Values not in the list sort last.
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
function priorityIndex(p: string | null | undefined): number {
  const i = PRIORITY_ORDER.indexOf(((p || 'medium').toLowerCase() as typeof PRIORITY_ORDER[number]));
  return i >= 0 ? i : PRIORITY_ORDER.length;
}

export function registerTriggerTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

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
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');
      if (agent.workspace_id && agent.workspace_id !== workspace_id) {
        return err('Agent does not belong to the requested workspace');
      }

      // Every ticket in the workspace where this agent holds a role slot.
      const ticketRepo = dataSource.getRepository(Ticket);
      const tickets = await ticketRepo.createQueryBuilder('t')
        .innerJoin('columns', 'col', 'col.id = t.column_id')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .where('b.workspace_id = :workspaceId', { workspaceId: workspace_id })
        .andWhere('(t.assignee_id = :agentId OR t.reporter_id = :agentId OR t.reviewer_id = :agentId)', { agentId: agent_id })
        .getMany();

      if (tickets.length === 0) return ok([]);

      const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
      if (colIds.length === 0) return ok([]);
      const columns = await dataSource.getRepository(BoardColumn)
        .createQueryBuilder('col')
        .where('col.id IN (:...ids)', { ids: colIds })
        .getMany();
      const boardIds = Array.from(new Set(columns.map(c => c.board_id)));
      const boards = boardIds.length === 0 ? []
        : await dataSource.getRepository(Board)
          .createQueryBuilder('b')
          .where('b.id IN (:...ids)', { ids: boardIds })
          .getMany();
      const colById = new Map(columns.map(c => [c.id, c]));
      const boardById = new Map(boards.map(b => [b.id, b]));

      // Walk the tickets and build the (ticket, role) pairs that the agent
      // actually holds + the column routes to that role. Collect them first,
      // then batch-query my_last_update_at for the set of ticket ids in one
      // pass each over comments + activity_logs.
      type Row = {
        ticket_id: string;
        role: string;
        column_id: string;
        column_position: number;
        priority: string;
        priority_index: number;
        title: string;
        my_last_update_at: string | null;
      };
      const rows: Row[] = [];
      const rowTicketIds = new Set<string>();

      for (const ticket of tickets) {
        if (!ticket.column_id) continue;
        const col = colById.get(ticket.column_id);
        if (!col) continue;
        // v0.25.0: exclude terminal columns — those are "done" and never need agent action.
        if ((col as any).is_terminal === true) continue;
        const board = boardById.get(col.board_id);
        if (!board) continue;

        const routing = safeJsonParse<Record<string, string | string[]>>(board.routing_config, {});
        const columnKey = (col.name || '').toLowerCase();
        const rawRoles = Object.prototype.hasOwnProperty.call(routing, columnKey)
          ? routing[columnKey]
          : undefined;
        if (rawRoles === undefined) continue;
        const roles = Array.isArray(rawRoles) ? rawRoles : [rawRoles];
        if (roles.length === 0) continue;

        for (const role of roles) {
          const field = ROLE_TO_TICKET_FIELD[role];
          if (!field) continue;
          if ((ticket as any)[field] !== agent_id) continue;
          rows.push({
            ticket_id: ticket.id,
            role,
            column_id: ticket.column_id,
            column_position: col.position,
            priority: ticket.priority || 'medium',
            priority_index: priorityIndex(ticket.priority),
            title: ticket.title,
            my_last_update_at: null, // filled in below
          });
          rowTicketIds.add(ticket.id);
        }
      }

      if (rows.length === 0) return ok([]);

      // my_last_update_at: MAX of (latest comment by this agent, latest
      // activity log entry with actor_id = this agent) per ticket.
      const ticketIdsArr = Array.from(rowTicketIds);

      const latestComments = await dataSource.getRepository(Comment)
        .createQueryBuilder('c')
        .select('c.ticket_id', 'ticket_id')
        .addSelect('MAX(c.created_at)', 'latest')
        .where('c.ticket_id IN (:...ids)', { ids: ticketIdsArr })
        .andWhere(`c.author_type = 'agent' AND c.author_id = :agentId`, { agentId: agent_id })
        .groupBy('c.ticket_id')
        .getRawMany<{ ticket_id: string; latest: string | Date | null }>();

      const latestActivity = await dataSource.getRepository(ActivityLog)
        .createQueryBuilder('a')
        .select('a.ticket_id', 'ticket_id')
        .addSelect('MAX(a.created_at)', 'latest')
        .where('a.ticket_id IN (:...ids)', { ids: ticketIdsArr })
        .andWhere('a.actor_id = :agentId', { agentId: agent_id })
        .groupBy('a.ticket_id')
        .getRawMany<{ ticket_id: string; latest: string | Date | null }>();

      const maxByTicket = new Map<string, number>();
      const fold = (row: { ticket_id: string; latest: string | Date | null }) => {
        if (!row.latest) return;
        const ts = row.latest instanceof Date ? row.latest.getTime() : new Date(row.latest).getTime();
        if (!Number.isFinite(ts)) return;
        const prev = maxByTicket.get(row.ticket_id) ?? 0;
        if (ts > prev) maxByTicket.set(row.ticket_id, ts);
      };
      latestComments.forEach(fold);
      latestActivity.forEach(fold);

      for (const r of rows) {
        const ts = maxByTicket.get(r.ticket_id);
        r.my_last_update_at = ts ? new Date(ts).toISOString() : null;
      }

      return ok(rows);
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
