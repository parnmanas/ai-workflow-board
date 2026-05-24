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
import { ok, err, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { maxChildPosition, refreshTicketWorkspaceId, resolveAgentId, resolveAgentIdAndName, shiftTicketPositions } from '../shared/ticket-helpers';
import type { ToolContext } from './context';

export function registerTicketChildTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger, ticketRoleAssignmentService } = ctx;

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
      description = sanitizeHarnessMarkers(description, { logger, toolName: 'create_child_ticket', fieldName: 'description', agentId: caller?.agentId });
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId(dataSource, '', reporter, logger) : '');

      // Backfill name↔id from the Agent table when only one side was supplied
      // (mirrors the root `create_ticket` fix — see ticket-crud-tools.ts).
      const assigneeResolved = await resolveAgentIdAndName(dataSource, assignee_id, assignee, logger);
      const reporterResolved = await resolveAgentIdAndName(dataSource, reporter_id, reporter, logger);
      let resolvedAssigneeId = assigneeResolved.id;
      let resolvedAssignee = assigneeResolved.name;
      let resolvedReporterId = reporterResolved.id;
      let resolvedReporter = reporterResolved.name;
      if (!resolvedReporter && !resolvedReporterId && creatorId) {
        resolvedReporter = creatorName;
        resolvedReporterId = creatorId;
      }

      // B1: if the parent's workspace_id is still the legacy '' (e.g. parent
      // was created via the pre-fix MCP path), backfill it now so this child
      // — which inherits below — also lands with a usable workspace_id.
      await refreshTicketWorkspaceId(dataSource, parent);

      const position = await maxChildPosition(dataSource, parent_id);
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id, depth: newDepth, column_id: null as any, title, description, priority, status,
        assignee: resolvedAssignee, reporter: resolvedReporter,
        assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId,
        labels: JSON.stringify(labels), position,
        // Inherit workspace_id from parent so role lookups work immediately.
        workspace_id: parent.workspace_id || '',
        created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
      }));

      // v0.34: assignment-table sync.
      if (ticketRoleAssignmentService && child.workspace_id) {
        await ticketRoleAssignmentService.syncBuiltinTrio(child.id, child.workspace_id, {
          assignee_id: child.assignee_id || '',
          reporter_id: child.reporter_id || '',
        });
      }

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: child.id, action: 'created',
        new_value: child.title, ticket_id: parent_id, actor_name: creatorName || reporter || assignee,
      });

      return ok(child);
    }
  );

  server.tool(
    'update_child_ticket',
    'Update a child (subtask) ticket\'s fields — title, description, status, priority, assignee, etc.\n\n' +
    'WORKFLOW RULE — finishing a subtask:\n' +
    'Subtasks (depth > 0, parent_id != null) do NOT live on a column, so move_ticket does not apply to them — ' +
    'their column_id is null by design. When you finish work on a subtask, mark completion by calling ' +
    'update_child_ticket with status="done". Without this, the parent ticket\'s "Subtasks (X/Y done)" progress ' +
    'never advances and the parent\'s reviewer cannot tell whether the work is finished. The standard ' +
    'subtask-end sequence is:\n' +
    '  1) add_comment(ticket_id, "<results / notes>")\n' +
    '  2) update_child_ticket(ticket_id, status="done")\n' +
    'No move_ticket call — the parent will be moved later by whoever owns the root ticket once every sibling ' +
    'subtask is also "done".',
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
      if (description !== undefined) {
        ticket.description = sanitizeHarnessMarkers(description, { logger, toolName: 'update_child_ticket', fieldName: 'description', agentId: caller?.agentId });
      }
      if (status !== undefined) ticket.status = status;
      if (priority !== undefined) ticket.priority = priority;
      // Same backfill as root update_ticket: when only one side of the pair
      // changes, look the other up from the Agent table so TicketCard /
      // activity log don't see a half-stale row. Pass empty strings for the
      // omitted side so the helper actually does a DB lookup — pre-filling
      // from the existing row hits the helper's `if (id && name)` short-
      // circuit and silently re-saves the previous holder's name.
      if (assignee !== undefined || assignee_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          assignee_id !== undefined ? assignee_id : '',
          assignee !== undefined ? assignee : '',
          logger,
        );
        ticket.assignee_id = assignee_id !== undefined ? assignee_id : (resolved.id || ticket.assignee_id);
        ticket.assignee    = assignee    !== undefined ? assignee    : (resolved.name || ticket.assignee);
      }
      if (reporter !== undefined || reporter_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          reporter_id !== undefined ? reporter_id : '',
          reporter !== undefined ? reporter : '',
          logger,
        );
        ticket.reporter_id = reporter_id !== undefined ? reporter_id : (resolved.id || ticket.reporter_id);
        ticket.reporter    = reporter    !== undefined ? reporter    : (resolved.name || ticket.reporter);
      }
      if (labels !== undefined) ticket.labels = JSON.stringify(labels);

      const updated = await ticketRepo.save(ticket);

      // B1: backfill workspace_id for legacy children that lost it (the
      // pre-fix MCP create path left it ''). Children inherit from parent
      // at create time, but a child whose parent was created before the
      // workspace_id backfill landed may still be empty.
      await refreshTicketWorkspaceId(dataSource, ticket);

      // v0.34: assignment-table sync (only fields the caller included).
      if (ticketRoleAssignmentService && ticket.workspace_id) {
        const trio: { assignee_id?: string; reporter_id?: string } = {};
        if (assignee !== undefined || assignee_id !== undefined) trio.assignee_id = ticket.assignee_id || '';
        if (reporter !== undefined || reporter_id !== undefined) trio.reporter_id = ticket.reporter_id || '';
        if (Object.keys(trio).length > 0) {
          await ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, trio);
        }
      }

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
