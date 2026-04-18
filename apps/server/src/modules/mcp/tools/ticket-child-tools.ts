/**
 * Child ticket (subtask) MCP tools.
 *
 * Tools: create_child_ticket, update_child_ticket, delete_child_ticket
 *
 * Split out of the legacy monolithic `ticket-tools.ts`. Siblings handle
 * root-ticket CRUD and state transitions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { maxChildPosition, resolveAgentId, shiftTicketPositions } from '../shared/ticket-helpers';
import type { ToolContext } from './context';

export function registerTicketChildTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'create_child_ticket',
    'Create a child ticket (subtask) under a parent ticket',
    {
      parent_id: z.string().describe('Parent ticket ID'),
      title: z.string().describe('Child ticket title'),
      description: z.string().optional().default('').describe('Description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().default('todo').describe('Status'),
      assignee: z.string().optional().default('').describe('Assignee name'),
      reporter: z.string().optional().default('').describe('Reporter name'),
      assignee_id: z.string().optional().default('').describe('Assignee user ID'),
      reporter_id: z.string().optional().default('').describe('Reporter user ID'),
      labels: z.array(z.string()).optional().default([]).describe('Labels'),
      created_by: z.string().optional().default('').describe('Creator name (user or agent)'),
      created_by_type: z.enum(['user', 'agent']).optional().default('agent').describe('Creator type'),
      created_by_id: z.string().optional().default('').describe('Creator ID'),
    },
    async ({ parent_id, title, description, priority, status, assignee, reporter, assignee_id, reporter_id, labels, created_by, created_by_type, created_by_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const parent = await ticketRepo.findOne({ where: { id: parent_id } });
      if (!parent) return err('Parent ticket not found');

      const newDepth = (parent.depth || 0) + 1;
      if (newDepth > 2) return err('Maximum nesting depth is 2 (sub-subtask)');

      const caller = getCallerAgent(extra);
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId(dataSource, '', reporter) : '');

      const position = await maxChildPosition(dataSource, parent_id);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id, depth: newDepth, column_id: null as any, title, description, priority, status,
        assignee, reporter, assignee_id, reporter_id,
        labels: JSON.stringify(labels), position,
        created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
      }));

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: child.id, action: 'created',
        new_value: child.title, ticket_id: parent_id, actor_name: creatorName || reporter || assignee,
      });

      return ok(child);
    }
  );

  server.tool(
    'update_child_ticket',
    'Update a child ticket (title, description, status, priority, assignee, etc.)',
    {
      ticket_id: z.string().describe('Child ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().describe('New status'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      assignee: z.string().optional().describe('New assignee name'),
      reporter: z.string().optional().describe('New reporter name'),
      assignee_id: z.string().optional().describe('New assignee user ID'),
      reporter_id: z.string().optional().describe('New reporter user ID'),
      labels: z.array(z.string()).optional().describe('New labels'),
    },
    async ({ ticket_id, title, description, status, priority, assignee, reporter, assignee_id, reporter_id, labels }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Child ticket not found');

      const caller = getCallerAgent(extra);
      const oldStatus = ticket.status;

      if (title !== undefined) ticket.title = title;
      if (description !== undefined) ticket.description = description;
      if (status !== undefined) ticket.status = status;
      if (priority !== undefined) ticket.priority = priority;
      if (assignee !== undefined) ticket.assignee = assignee;
      if (reporter !== undefined) ticket.reporter = reporter;
      if (assignee_id !== undefined) ticket.assignee_id = assignee_id;
      if (reporter_id !== undefined) ticket.reporter_id = reporter_id;
      if (labels !== undefined) ticket.labels = JSON.stringify(labels);

      const updated = await ticketRepo.save(ticket);

      if (oldStatus !== ticket.status) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
          field_changed: 'status', old_value: oldStatus, new_value: ticket.status,
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      } else {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      return ok(updated);
    }
  );

  server.tool(
    'delete_child_ticket',
    'Delete a child ticket',
    { ticket_id: z.string().describe('Child ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Child ticket not found');

      const caller = getCallerAgent(extra);
      const deletedTitle = ticket.title;
      const parentId = ticket.parent_id;
      const deletedPosition = ticket.position;

      await ticketRepo.delete(ticket.id);

      if (parentId) {
        await shiftTicketPositions(ticketRepo, { parent_id: parentId }, deletedPosition, -1);
      }

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket_id, action: 'deleted',
        new_value: deletedTitle, ticket_id: parentId || ticket_id,
        actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      return ok({ success: true, deleted_ticket_id: ticket_id });
    }
  );

  // ─── Role routing ─────────────────────────────────────

}
