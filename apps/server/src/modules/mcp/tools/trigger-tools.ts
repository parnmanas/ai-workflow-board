/**
 * Agent trigger + event-subscription MCP tools.
 *
 * Tools:
 *   - get_pending_triggers: unacknowledged AgentTriggers for the calling agent
 *   - acknowledge_trigger: mark a trigger as processed
 *   - subscribe_events: pull activity log slice (time-cursor paginated)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActivityLog } from '../../../entities/ActivityLog';
import { Agent } from '../../../entities/Agent';
import { AgentTrigger } from '../../../entities/AgentTrigger';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

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
