/**
 * Ticket MCP tools.
 *
 * Tools:
 *   - Root ticket CRUD: get_ticket, create_ticket, update_ticket, move_ticket, delete_ticket
 *   - Child ticket CRUD: create_child_ticket, update_child_ticket, delete_child_ticket
 *   - Role routing: get_my_tickets
 *   - Ticket locking: claim_ticket, release_ticket
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err, safeJsonParse } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { findColumnByName, maxTicketPosition, maxChildPosition, resolveAgentId, shiftTicketPositions } from '../shared/ticket-helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerTicketTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'get_ticket',
    'Get a single ticket with its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }) => {
      const ticket = await loadTicketFull(dataSource, ticket_id);
      if (!ticket) return err('Ticket not found');
      return ok(ticket);
    }
  );

  server.tool(
    'create_ticket',
    'Create a new ticket. You can specify either column_id (numeric) or column_name + board_id to find the column by name.',
    {
      title: z.string().describe('Ticket title'),
      description: z.string().optional().default('').describe('Ticket description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium').describe('Priority level'),
      assignee: z.string().optional().default('').describe('Assignee name'),
      reporter: z.string().optional().default('').describe('Reporter name'),
      assignee_id: z.string().optional().default('').describe('Assignee user ID'),
      reporter_id: z.string().optional().default('').describe('Reporter user ID'),
      reviewer_id: z.string().optional().default('').describe('Reviewer agent ID'),
      labels: z.array(z.string()).optional().default([]).describe('Labels'),
      channel_ids: z.array(z.string()).optional().default([]).describe('Notification channel IDs'),
      column_id: z.string().optional().describe('Column ID (use this OR column_name)'),
      column_name: z.string().optional().describe('Column name (case-insensitive, requires board_id)'),
      board_id: z.string().optional().describe('Board ID (used with column_name)'),
      subtasks: z.array(z.string()).optional().default([]).describe('List of subtask titles to create inline'),
      created_by: z.string().optional().default('').describe('Creator name (user or agent)'),
      created_by_type: z.enum(['user', 'agent']).optional().default('agent').describe('Creator type'),
      created_by_id: z.string().optional().default('').describe('Creator ID'),
    },
    async ({ title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, labels, channel_ids, column_id, column_name, board_id, subtasks, created_by, created_by_type, created_by_id }, extra: { sessionId?: string }) => {
      let resolvedColumnId = column_id;
      if (!resolvedColumnId && column_name) {
        if (!board_id) return err('board_id is required when using column_name');
        const col = await findColumnByName(dataSource, board_id, column_name);
        if (!col) return err(`Column "${column_name}" not found in board ${board_id}`);
        resolvedColumnId = col.id;
      }
      if (!resolvedColumnId) return err('Either column_id or column_name is required');

      const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: resolvedColumnId } });
      if (!col) return err('Column not found');

      // Auto-fill creator from authenticated agent if not provided
      const caller = getCallerAgent(extra);
      const creatorName = created_by || (caller?.agentName) || reporter || assignee || '';
      const creatorType = created_by ? created_by_type : (caller?.agentId ? 'agent' : (reporter ? 'agent' : ''));
      const creatorId = created_by_id || (caller?.agentId) || (reporter ? await resolveAgentId(dataSource, '', reporter) : '');

      const ticket = await dataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);

        const resolvedAssigneeId = await resolveAgentId(dataSource, assignee_id, assignee);
        const resolvedReporterId = await resolveAgentId(dataSource, reporter_id, reporter);
        const position = await maxTicketPosition(dataSource, resolvedColumnId!);
        const t = await tRepo.save(tRepo.create({
          column_id: resolvedColumnId!, title, description, priority, assignee, reporter,
          assignee_id: resolvedAssigneeId, reporter_id: resolvedReporterId, reviewer_id,
          labels: JSON.stringify(labels), channel_ids: JSON.stringify(channel_ids), position,
          created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
        }));

        if (subtasks.length > 0) {
          const stEntities = subtasks.map((stTitle, idx) =>
            tRepo.create({
              parent_id: t.id, depth: 1, column_id: null as any, title: stTitle, position: idx, status: 'todo',
              created_by: creatorName, created_by_type: creatorType, created_by_id: creatorId,
            })
          );
          await tRepo.save(stEntities);
        }

        return t;
      });

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'created',
        ticket_id: ticket.id, actor_name: creatorName || reporter || assignee,
      });

      const full = await loadTicketFull(dataSource, ticket.id);
      return ok(full);
    }
  );

  server.tool(
    'update_ticket',
    'Update a ticket\'s fields (title, description, priority, assignee, reporter, reviewer_id, labels, channel_ids)',
    {
      ticket_id: z.string().describe('Ticket ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New priority'),
      assignee: z.string().optional().describe('New assignee name'),
      reporter: z.string().optional().describe('New reporter name'),
      assignee_id: z.string().optional().describe('New assignee user ID'),
      reporter_id: z.string().optional().describe('New reporter user ID'),
      reviewer_id: z.string().optional().describe('Reviewer agent ID'),
      labels: z.array(z.string()).optional().describe('New labels array'),
      channel_ids: z.array(z.string()).optional().describe('New notification channel IDs'),
    },
    async ({ ticket_id, title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, labels, channel_ids }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);

      // Track old values before updating
      const oldAssignee = ticket.assignee;
      const oldReporter = ticket.reporter;

      const changes: string[] = [];
      if (title !== undefined) { ticket.title = title; changes.push('title'); }
      if (description !== undefined) { ticket.description = description; changes.push('description'); }
      if (priority !== undefined) { ticket.priority = priority; changes.push('priority'); }
      if (assignee !== undefined && assignee !== oldAssignee) {
        ticket.assignee = assignee;
        ticket.assignee_id = await resolveAgentId(dataSource, assignee_id || '', assignee);
        changes.push('assignee');
      } else if (assignee_id !== undefined) { ticket.assignee_id = assignee_id; }
      if (reporter !== undefined && reporter !== oldReporter) {
        ticket.reporter = reporter;
        ticket.reporter_id = await resolveAgentId(dataSource, reporter_id || '', reporter);
        changes.push('reporter');
      } else if (reporter_id !== undefined) { ticket.reporter_id = reporter_id; }
      if (reviewer_id !== undefined) { ticket.reviewer_id = reviewer_id; changes.push('reviewer'); }
      if (labels !== undefined) { ticket.labels = JSON.stringify(labels); changes.push('labels'); }
      if (channel_ids !== undefined) { ticket.channel_ids = JSON.stringify(channel_ids); changes.push('channel_ids'); }

      await ticketRepo.save(ticket);

      // Log assignee/reporter changes separately for system comment generation
      if (assignee !== undefined && assignee !== oldAssignee) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee', old_value: oldAssignee || '', new_value: assignee || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }
      if (reporter !== undefined && reporter !== oldReporter) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'reporter', old_value: oldReporter || '', new_value: reporter || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      // Log other field changes (excluding assignee/reporter which are logged separately above)
      const otherChanges = changes.filter(c => c !== 'assignee' && c !== 'reporter');
      if (otherChanges.length > 0) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: otherChanges.join(', '), ticket_id: ticket.id,
          actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }

      const updated = await loadTicketFull(dataSource, ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'move_ticket',
    'Move a ticket to a different column. You can specify target by column_id or column_name.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      target_column_id: z.string().optional().describe('Target column ID (use this OR target_column_name)'),
      target_column_name: z.string().optional().describe('Target column name (case-insensitive)'),
      board_id: z.string().optional().describe('Board ID (used with target_column_name)'),
      position: z.number().optional().describe('Target position in the column (default: end)'),
    },
    async ({ ticket_id, target_column_id, target_column_name, board_id, position }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);
      let destColumnId = target_column_id;
      if (!destColumnId && target_column_name) {
        if (!board_id) return err('board_id is required when using target_column_name');
        const col = await findColumnByName(dataSource, board_id, target_column_name);
        if (!col) return err(`Column "${target_column_name}" not found`);
        destColumnId = col.id;
      }
      if (!destColumnId) return err('Either target_column_id or target_column_name is required');

      const oldColumnId = ticket.column_id;

      await dataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);

        await shiftTicketPositions(tRepo, { column_id: ticket.column_id }, ticket.position, -1);

        const destCount = await tRepo.createQueryBuilder('t')
          .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: destColumnId, id: ticket.id })
          .getCount();
        const pos = Math.min(position ?? destCount, destCount);

        await shiftTicketPositions(tRepo, { column_id: destColumnId! }, pos, +1, { inclusive: true, excludeId: ticket.id });

        await tRepo.update(ticket.id, { column_id: destColumnId!, position: pos });
      });

      // Resolve column names for activity log
      const oldCol = await dataSource.getRepository(BoardColumn).findOne({ where: { id: oldColumnId } });
      const newCol = await dataSource.getRepository(BoardColumn).findOne({ where: { id: destColumnId! } });

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
        field_changed: 'column', old_value: oldCol?.name || String(oldColumnId),
        new_value: newCol?.name || String(destColumnId), ticket_id: ticket.id,
        actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      const updated = await loadTicketFull(dataSource, ticket.id);
      return ok(updated);
    }
  );

  server.tool(
    'delete_ticket',
    'Delete a ticket and all its children and comments',
    { ticket_id: z.string().describe('Ticket ID') },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({
        where: { id: ticket_id },
        relations: ['children', 'comments'],
      });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);
      const columnId = ticket.column_id;
      const position = ticket.position;

      await ticketRepo.remove(ticket);

      await shiftTicketPositions(ticketRepo, { column_id: columnId }, position, -1);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'deleted',
        ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
      });

      return ok({ success: true, deleted_ticket_id: ticket_id });
    }
  );

  // ─── Child ticket tools ─────────────────────────────────────

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

  server.tool(
    'get_my_tickets',
    'Get tickets where this agent is assignee, reporter, or reviewer within the workspace.',
    {
      agent_id: z.string().describe('Calling agent ID'),
      workspace_id: z.string().describe('Workspace to scope results'),
      status: z.string().optional().describe('Filter by ticket status (optional, e.g. "todo", "in_progress", "done")'),
    },
    async ({ agent_id, workspace_id, status }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      if (agent.workspace_id && agent.workspace_id !== workspace_id) {
        return err('Agent does not belong to the requested workspace');
      }

      const ticketRepo = dataSource.getRepository(Ticket);
      let qb = ticketRepo.createQueryBuilder('t')
        .innerJoin('columns', 'col', 'col.id = t.column_id')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .where('b.workspace_id = :workspaceId', { workspaceId: workspace_id })
        .andWhere('(t.assignee_id = :agentId OR t.reporter_id = :agentId OR t.reviewer_id = :agentId)', { agentId: agent_id });

      if (status) {
        qb = qb.andWhere('t.status = :status', { status });
      }

      const tickets = await qb.orderBy('t.created_at', 'DESC').getMany();
      return ok(tickets.map(t => ({
        ...t,
        labels: safeJsonParse(t.labels, []),
        channel_ids: safeJsonParse(t.channel_ids, []),
      })));
    }
  );

  // ─── Ticket locking ─────────────────────────────────────

  server.tool(
    'claim_ticket',
    'Exclusively claim a ticket for processing. Sets a TTL-based lock preventing other agents ' +
    'from claiming the same ticket. Returns error if ticket is currently locked by another agent. ' +
    'Same-agent re-claim is idempotent (refreshes locked_at). Subagents call this with their own agent_id.',
    {
      ticket_id: z.string().describe('Ticket ID to claim'),
      agent_id: z.string().describe('Your agent ID (the lock will be owned by this agent)'),
      ttl_minutes: z.number().optional().default(30).describe('Lock TTL in minutes (default 30, max 120)'),
    },
    async ({ ticket_id, agent_id, ttl_minutes }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Check existing lock — allow re-claim by same agent (idempotent refresh)
      if (ticket.locked_by_agent_id && ticket.locked_by_agent_id !== agent_id) {
        // Check if the existing lock has expired (in-request TTL path — LOCK-03 gap-fill)
        const lockAgeMs = Date.now() - new Date(ticket.locked_at!).getTime();
        const clampedTtlMs = Math.min(ttl_minutes ?? 30, 120) * 60 * 1000;
        if (lockAgeMs < clampedTtlMs) {
          return err(`Ticket already claimed by agent ${ticket.locked_by_agent_id}`);
        }
        // Expired lock — silent override; sweep may not have run yet
      }

      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      const previousOwner = ticket.locked_by_agent_id;
      ticket.locked_by_agent_id = agent_id;
      ticket.locked_at = new Date();

      try {
        await ticketRepo.save(ticket);
      } catch (e: any) {
        // @VersionColumn optimistic lock conflict: two agents claimed simultaneously
        if (e?.name === 'OptimisticLockVersionMismatch' || e?.message?.includes('optimistic lock')) {
          return err('Claim conflict — retry');
        }
        throw e;
      }

      await activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticket_id,
        action: 'updated',
        field_changed: 'locked_by_agent_id',
        old_value: previousOwner ?? '',
        new_value: agent_id,
        actor_id: agent_id,
        actor_name: agent.name,
        ticket_id,
        role: '',
        trigger_source: 'agent_claim',
      });

      return ok({
        claimed: true,
        ticket_id,
        agent_id,
        locked_at: ticket.locked_at,
        ...(previousOwner && previousOwner !== agent_id ? { note: 'expired lock overridden' } : {}),
      });
    }
  );

  server.tool(
    'release_ticket',
    'Release a previously claimed ticket lock. Only the agent that owns the lock can release it. ' +
    'Returns ok({released: false}) if the ticket was not locked (idempotent). ' +
    'Returns error if the lock is owned by a different agent.',
    {
      ticket_id: z.string().describe('Ticket ID to release'),
      agent_id: z.string().describe('Your agent ID — must match the current lock owner'),
    },
    async ({ ticket_id, agent_id }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      // Idempotent: ticket was not locked
      if (!ticket.locked_by_agent_id) {
        return ok({ released: false, reason: 'Ticket was not locked' });
      }

      // Ownership check (LOCK-02 release path, T-04-02-02 Tampering mitigation)
      if (ticket.locked_by_agent_id !== agent_id) {
        return err(`Lock owned by agent ${ticket.locked_by_agent_id} — cannot release`);
      }

      ticket.locked_by_agent_id = null;
      ticket.locked_at = null;
      await ticketRepo.save(ticket);

      await activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticket_id,
        action: 'updated',
        field_changed: 'locked_by_agent_id',
        old_value: agent_id,
        new_value: '',
        actor_id: agent_id,
        ticket_id,
        role: '',
        trigger_source: 'agent_release',
      });

      return ok({ released: true, ticket_id, agent_id });
    }
  );
}
