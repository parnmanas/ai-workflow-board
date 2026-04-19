/**
 * Agent trigger + event-subscription MCP tools.
 *
 * Tools:
 *   - get_pending_triggers: unacknowledged AgentTriggers for the calling agent
 *   - get_my_actionable_tickets: tickets whose current column's routing_config
 *     assigns a role the calling agent holds (idle-path reconciliation so that
 *     agents entering backlog/staging columns get noticed even when no
 *     AgentTrigger was ever created — e.g. ticket existed before the agent
 *     was set as reporter, or the original trigger was already acked)
 *   - acknowledge_trigger: mark a trigger as processed
 *   - subscribe_events: pull activity log slice (time-cursor paginated)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActivityLog } from '../../../entities/ActivityLog';
import { Agent } from '../../../entities/Agent';
import { AgentTrigger } from '../../../entities/AgentTrigger';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// Role → ticket field. Intentional: these are the three system-defined role
// slots on a Ticket (not column names). routing_config is the mapping layer
// between user-chosen column names and these three roles.
const ROLE_TO_TICKET_FIELD: Record<string, 'assignee_id' | 'reporter_id' | 'reviewer_id'> = {
  assignee: 'assignee_id',
  reporter: 'reporter_id',
  reviewer: 'reviewer_id',
};

export function registerTriggerTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, triggerService } = ctx;

  server.tool(
    'manual_trigger',
    'Manually (re-)trigger an agent on a ticket. Use when the automatic trigger ' +
    'fired but the agent never reacted, or to wake an agent on a stale ticket. ' +
    'Bypasses the 60s cooldown (still sets a fresh one for future auto-triggers). ' +
    'Either specify a role — the ticket\'s assignee_id/reporter_id/reviewer_id ' +
    'is resolved accordingly — or pass agent_id explicitly to override.',
    {
      ticket_id: z.string().describe('Ticket ID to trigger on'),
      role: z.enum(['assignee', 'reporter', 'reviewer']).describe('Which role slot to wake'),
      agent_id: z.string().optional().describe('Explicit target agent (overrides the role slot lookup)'),
    },
    async ({ ticket_id, role, agent_id }, extra: { sessionId?: string }) => {
      if (!triggerService) {
        return err('manual_trigger is unavailable in standalone MCP server mode — use the NestJS-integrated server.');
      }
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const roleField = role === 'assignee' ? 'assignee_id'
        : role === 'reporter' ? 'reporter_id'
        : 'reviewer_id';
      const targetAgentId = agent_id || ((ticket as any)[roleField] || '');
      if (!targetAgentId) {
        return err(`No ${role} assigned on ticket ${ticket_id}. Set ticket.${roleField} first, or pass agent_id.`);
      }

      const caller = getCallerAgent(extra);
      try {
        const trigger = await triggerService.createManualTrigger(
          ticket_id,
          targetAgentId,
          role,
          {
            id: caller?.agentId || '',
            name: caller?.agentName || 'mcp-caller',
          },
        );
        return ok({
          trigger_id: trigger.id,
          ticket_id: trigger.ticket_id,
          agent_id: trigger.agent_id,
          role: trigger.role,
          trigger_source: 'manual',
          pushed_at: new Date().toISOString(),
        });
      } catch (e: any) {
        return err(e?.message || 'Manual trigger failed');
      }
    }
  );

  server.tool(
    'get_pending_triggers',
    'Fetch unacknowledged AgentTrigger records targeting this agent. ' +
    'Returns triggers where acknowledged_at IS NULL and expires_at has not passed. ' +
    'Agents also receive real-time agent_trigger SSE events when new triggers are created.',
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

      const now = new Date();
      const triggers = await dataSource.getRepository(AgentTrigger)
        .createQueryBuilder('t')
        .where('t.acknowledged_at IS NULL')
        .andWhere('(t.expires_at IS NULL OR t.expires_at > :now)', { now })
        .andWhere('t.agent_id = :agentId', { agentId: agent_id })
        .orderBy('t.created_at', 'ASC')
        .getMany();

      return ok(triggers);
    }
  );

  server.tool(
    'get_my_actionable_tickets',
    'Return tickets whose current column\'s routing_config assigns a role held by the calling agent, ' +
    'excluding tickets that already have a pending (unacknowledged) AgentTrigger. Purely ' +
    'routing_config-driven — no column-name conventions, no status assumptions, no role-list baked in.',
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

      // Every ticket where this agent holds at least one role slot within
      // the requested workspace. We walk these tickets, resolve each one's
      // column → board.routing_config, and emit the (ticket, role) pairs
      // where routing matches a role the agent actually holds.
      const ticketRepo = dataSource.getRepository(Ticket);
      const tickets = await ticketRepo.createQueryBuilder('t')
        .innerJoin('columns', 'col', 'col.id = t.column_id')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .where('b.workspace_id = :workspaceId', { workspaceId: workspace_id })
        .andWhere('(t.assignee_id = :agentId OR t.reporter_id = :agentId OR t.reviewer_id = :agentId)', { agentId: agent_id })
        .getMany();

      if (tickets.length === 0) return ok([]);

      // Resolve routing_config for every column we'll touch, in one pass.
      // column_id is cached; we batch by board to minimize queries.
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

      // Tickets with an unacknowledged AgentTrigger are already en route via
      // the push / get_pending_triggers path — don't double-report them.
      const now = new Date();
      const pendingRows = await dataSource.getRepository(AgentTrigger)
        .createQueryBuilder('t')
        .select('t.ticket_id', 'ticket_id').addSelect('t.role', 'role')
        .where('t.acknowledged_at IS NULL')
        .andWhere('(t.expires_at IS NULL OR t.expires_at > :now)', { now })
        .andWhere('t.agent_id = :agentId', { agentId: agent_id })
        .getRawMany<{ ticket_id: string; role: string }>();
      const pendingPairs = new Set(pendingRows.map(r => `${r.ticket_id}::${r.role}`));

      const actionable: Array<{ ticket_id: string; role: string; column_id: string; title: string }> = [];

      for (const ticket of tickets) {
        if (!ticket.column_id) continue;
        const col = colById.get(ticket.column_id);
        if (!col) continue;
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
          if ((ticket as any)[field] !== agent_id) continue; // agent doesn't hold this role
          if (pendingPairs.has(`${ticket.id}::${role}`)) continue; // already en route
          actionable.push({
            ticket_id: ticket.id,
            role,
            column_id: ticket.column_id,
            title: ticket.title,
          });
        }
      }

      return ok(actionable);
    }
  );

  server.tool(
    'acknowledge_trigger',
    'Mark an AgentTrigger as acknowledged so it no longer appears in get_pending_triggers. ' +
    'Call this after you have started processing the triggered ticket.',
    {
      trigger_id: z.string().describe('AgentTrigger ID to acknowledge'),
      agent_id: z.string().describe('Calling agent ID (for audit log)'),
    },
    async ({ trigger_id, agent_id }) => {
      const repo = dataSource.getRepository(AgentTrigger);
      const trigger = await repo.findOne({ where: { id: trigger_id } });
      if (!trigger) return err('Trigger not found');

      if (trigger.acknowledged_at) {
        return ok({ already_acknowledged: true, trigger_id, acknowledged_at: trigger.acknowledged_at });
      }

      // Only the target agent can acknowledge their own trigger
      if (trigger.agent_id !== agent_id) {
        return err(`Trigger belongs to agent "${trigger.agent_id}", not "${agent_id}"`);
      }

      trigger.acknowledged_at = new Date();
      await repo.save(trigger);

      // NOTE: do NOT touch current_task here. Trigger ack ("I received this,
      // don't re-deliver") and current_task ("I'm actively processing now")
      // are separate signals. Plugin acks immediately on dispatch but the
      // subagent runs for a long time afterward — clearing current_task at
      // ack time would race-clear the dashboard while work is still going.
      // current_task is owned exclusively by set_current_task /
      // clear_current_task + the 15-min stale sweep.

      await activityService.logActivity({
        entity_type: 'ticket',
        entity_id: trigger.ticket_id,
        action: 'updated',
        field_changed: 'trigger_acknowledged',
        new_value: trigger_id,
        ticket_id: trigger.ticket_id,
        actor_id: agent_id,
        role: trigger.role,
        trigger_source: 'agent_trigger',
      });

      return ok({ acknowledged: true, trigger_id, role: trigger.role, ticket_id: trigger.ticket_id });
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

      // Time cursor
      if (since) {
        // Try as ISO date first, then as activity ID
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          query = query.where('a.created_at > :since', { since: sinceDate.toISOString() });
        } else {
          // Treat as activity log ID — get events after that ID's timestamp
          const ref = await repo.findOne({ where: { id: parseInt(since) as any } });
          if (ref) {
            query = query.where('a.created_at > :since', { since: ref.created_at });
          }
        }
      } else {
        // Default: last 10 minutes
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        query = query.where('a.created_at > :since', { since: tenMinAgo });
      }

      let events = await query.getMany();

      // Filter by board if specified
      if (board_id) {
        const ticketIds = new Set<string>();
        const tickets = await dataSource.getRepository(Ticket)
          .createQueryBuilder('t')
          .innerJoin(BoardColumn, 'col', 'col.id = t.column_id')
          .where('col.board_id = :board_id', { board_id })
          .select('t.id')
          .getMany();
        tickets.forEach(t => ticketIds.add(t.id));

        // Also include child tickets
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

      // Filter to only events for tickets assigned to the calling agent
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
