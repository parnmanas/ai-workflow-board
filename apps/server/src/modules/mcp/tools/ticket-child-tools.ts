/**
 * Child ticket (subtask) MCP tools.
 *
 * Tools: create_child_ticket, update_child_ticket, delete_child_ticket
 *
 * Children are the root ticket's checklist: they have no assignee and are
 * never dispatched — the root's assignee works through them (docs/tickets.md).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Ticket } from '../../../entities/Ticket';
import { ok, err, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { maxChildPosition, shiftTicketPositions } from '../shared/ticket-helpers';
import { normalizeTags } from '../../tickets/ticket.service';
import { getRootArchivedAt, TicketArchivedError } from '../shared/archive-helpers';
import type { ToolContext } from './context';

export function registerTicketChildTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger } = ctx;

  server.tool(
    'create_child_ticket',
    'Create a child ticket (a checklist item) under a parent ticket. Children are worked by the parent\'s assignee; mark each done with update_child_ticket(status="done").',
    {
      parent_id: z.string().describe('Parent ticket ID'),
      title: z.string().describe('Child ticket title'),
      description: z.string().optional().default('').describe('Description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority'),
      status: z.enum(['todo', 'done']).optional().default('todo').describe('Status'),
      tags: z.array(z.string()).optional().default([]).describe('Tags'),
    },
    async ({ parent_id, title, description, priority, status, tags }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const parent = await ticketRepo.findOne({ where: { id: parent_id } });
      if (!parent) return err('Parent ticket not found');

      const rootArchived = await getRootArchivedAt(dataSource, parent);
      if (rootArchived) return err(new TicketArchivedError(parent.id).message);

      const newDepth = (parent.depth || 0) + 1;
      if (newDepth > 2) return err('Maximum nesting depth is 2 (sub-subtask)');

      const caller = getCallerAgent(extra);
      description = sanitizeHarnessMarkers(description, { logger, toolName: 'create_child_ticket', fieldName: 'description', agentId: caller?.agentId });
      const creatorName = caller?.agentName || '';
      const creatorId = caller?.runtimeKey || caller?.agentId || '';

      const position = await maxChildPosition(dataSource, parent_id);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id, depth: newDepth, title, description, priority, status,
        tags: JSON.stringify(normalizeTags(tags)), channel_ids: '[]', position,
        account_id: parent.account_id || '',
        created_by: creatorName, created_by_type: 'agent', created_by_id: creatorId,
      }));

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: child.id, action: 'created',
        new_value: child.title, ticket_id: parent_id, account_id: child.account_id,
        actor_id: creatorId || undefined, actor_name: creatorName,
      });

      return ok(child);
    }
  );

  server.tool(
    'update_child_ticket',
    'Update a child (subtask) ticket — title, description, status (todo/done), priority, tags.\n\n' +
    'Finishing a checklist item: add_comment(ticket_id, "<results>") then update_child_ticket(ticket_id, status="done"). ' +
    'Subtasks have no status lane, so move_ticket does not apply to them; the parent can only move to done once every child is done.',
    {
      ticket_id: z.string().describe('Child ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      status: z.enum(['todo', 'in_progress', 'done']).optional().describe('New status (in_progress is stored as todo — children only track done / not done)'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      tags: z.array(z.string()).optional().describe('New tags'),
    },
    async ({ ticket_id, title, description, status, priority, tags }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Child ticket not found');

      const rootArchivedForUpdate = await getRootArchivedAt(dataSource, ticket);
      if (rootArchivedForUpdate) return err(new TicketArchivedError(ticket.id).message);

      const caller = getCallerAgent(extra);
      const oldStatus = ticket.status;

      if (title !== undefined) ticket.title = title;
      if (description !== undefined) {
        ticket.description = sanitizeHarnessMarkers(description, { logger, toolName: 'update_child_ticket', fieldName: 'description', agentId: caller?.agentId });
      }
      if (status !== undefined) ticket.status = status === 'done' ? 'done' : 'todo';
      if (priority !== undefined) ticket.priority = priority;
      if (tags !== undefined) ticket.tags = JSON.stringify(normalizeTags(tags));

      const updated = await ticketRepo.save(ticket);

      if (oldStatus !== ticket.status) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'status_changed',
          field_changed: 'status', old_value: oldStatus, new_value: ticket.status,
          ticket_id: ticket.parent_id || ticket.id, account_id: ticket.account_id,
          actor_id: caller?.runtimeKey || caller?.agentId, actor_name: caller?.agentName,
        });
      } else {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          ticket_id: ticket.parent_id || ticket.id, account_id: ticket.account_id,
          actor_id: caller?.runtimeKey || caller?.agentId, actor_name: caller?.agentName,
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

      const rootArchivedForDelete = await getRootArchivedAt(dataSource, ticket);
      if (rootArchivedForDelete) return err(new TicketArchivedError(ticket.id).message);

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

}
