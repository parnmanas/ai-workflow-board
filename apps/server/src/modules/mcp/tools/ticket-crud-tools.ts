/**
 * Ticket CRUD MCP tools.
 *
 * Tools: get_ticket, create_ticket, update_ticket, delete_ticket, get_my_tickets
 *
 * Split out of the legacy monolithic `ticket-tools.ts` (565 lines · 11 tools).
 * Siblings: ticket-child-tools.ts (hierarchy), ticket-workflow-tools.ts
 * (state transitions). The auto-discovery loader in `tools/index.ts` picks
 * each sibling up by filename convention — no index edit needed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Resource } from '../../../entities/Resource';
import { Ticket } from '../../../entities/Ticket';
import { ok, err, safeJsonParse } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { findColumnByName, maxTicketPosition, resolveAgentId, resolveAgentIdAndName, shiftTicketPositions, deleteCommentAttachmentsForTicket } from '../shared/ticket-helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerTicketCrudTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, ticketRoleAssignmentService } = ctx;

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

        // Backfill name↔id from the Agent table when the caller passed only
        // one side. The MCP `create_ticket` path is regularly invoked with
        // just `assignee_id` / `reporter_id` (e.g. Ralf/GameClient agents),
        // and TicketCard reads the legacy `assignee` / `reporter` text
        // columns — without this, the card shows "Unassigned" even though
        // the trigger loop sees the assignment via *_id.
        const assigneeResolved = await resolveAgentIdAndName(dataSource, assignee_id, assignee);
        const reporterResolved = await resolveAgentIdAndName(dataSource, reporter_id, reporter);
        let resolvedAssigneeId = assigneeResolved.id;
        let resolvedAssignee = assigneeResolved.name;
        let resolvedReporterId = reporterResolved.id;
        let resolvedReporter = reporterResolved.name;
        // Default Reporter to the ticket's creator when none was supplied —
        // mirrors the REST controller so an agent that calls create_ticket
        // ends up listed as Reporter automatically.
        if (!resolvedReporter && !resolvedReporterId && creatorId) {
          resolvedReporter = creatorName;
          resolvedReporterId = creatorId;
        }
        const position = await maxTicketPosition(dataSource, resolvedColumnId!);
        const t = await tRepo.save(tRepo.create({
          column_id: resolvedColumnId!, title, description, priority,
          assignee: resolvedAssignee, reporter: resolvedReporter,
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

      // v0.34: mirror builtin trio onto TicketRoleAssignment so the trigger
      // loop / mention resolution / allocation see the new ticket.
      if (ticketRoleAssignmentService && ticket.workspace_id) {
        await ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, {
          assignee_id: ticket.assignee_id || '',
          reporter_id: ticket.reporter_id || '',
          reviewer_id: ticket.reviewer_id || '',
        });
      }

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
    'Update a root ticket\'s fields (title, description, priority, assignee, reporter, reviewer_id, labels, channel_ids, base_repo_resource_id, base_branch).\n\n' +
    'NOTE: this tool does NOT change `status` and is intended for ROOT tickets. ' +
    'Status on a root ticket is driven by which column it sits in — use move_ticket to advance it. ' +
    'For SUBTASKS (depth > 0), use update_child_ticket — that\'s also where you mark a finished subtask ' +
    'with status="done".\n\n' +
    'Base repo & branch: pass `base_repo_resource_id` (a workspace/board Resource of type="repository") together with ' +
    '`base_branch` to pin the branch the ticket\'s feature branch should be cut from. Empty strings clear the binding.',
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
      base_repo_resource_id: z.string().optional().describe('Resource ID (type=repository) the ticket builds against. Empty string clears.'),
      base_branch: z.string().optional().describe('Branch the agent should treat as the base when starting work. Empty string clears.'),
    },
    async ({ ticket_id, title, description, priority, assignee, reporter, assignee_id, reporter_id, reviewer_id, labels, channel_ids, base_repo_resource_id, base_branch }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');

      const caller = getCallerAgent(extra);

      // Track old values before updating
      const oldAssignee = ticket.assignee;
      const oldReporter = ticket.reporter;
      const oldBaseRepoId = ticket.base_repo_resource_id;
      const oldBaseBranch = ticket.base_branch;

      const changes: string[] = [];
      if (title !== undefined) { ticket.title = title; changes.push('title'); }
      if (description !== undefined) { ticket.description = description; changes.push('description'); }
      if (priority !== undefined) { ticket.priority = priority; changes.push('priority'); }
      // When the caller updates either side of the (id, name) pair, backfill
      // the other from the Agent table. Without this, an agent that calls
      // update_ticket with only `assignee_id` clears nothing but also leaves
      // the legacy `assignee` text column at its previous (stale) value, and
      // a caller that only swaps `assignee` keeps the old `assignee_id`
      // pointing at the previous holder.
      //
      // Pass empty strings for the omitted side so `resolveAgentIdAndName`
      // actually does a DB lookup — pre-filling from `ticket.assignee` /
      // `ticket.assignee_id` makes both helper args truthy and the helper's
      // `if (id && name) return { id, name }` short-circuit fires, which
      // skips the lookup and silently re-saves the previous holder's name.
      // The existing row only kicks in as a last-resort fallback when the
      // lookup misses (id points at a User row or stale agent).
      if (assignee !== undefined || assignee_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          assignee_id !== undefined ? assignee_id : '',
          assignee !== undefined ? assignee : '',
        );
        ticket.assignee_id = assignee_id !== undefined ? assignee_id : (resolved.id || ticket.assignee_id);
        ticket.assignee    = assignee    !== undefined ? assignee    : (resolved.name || ticket.assignee);
        if (ticket.assignee !== oldAssignee) changes.push('assignee');
      }
      if (reporter !== undefined || reporter_id !== undefined) {
        const resolved = await resolveAgentIdAndName(
          dataSource,
          reporter_id !== undefined ? reporter_id : '',
          reporter !== undefined ? reporter : '',
        );
        ticket.reporter_id = reporter_id !== undefined ? reporter_id : (resolved.id || ticket.reporter_id);
        ticket.reporter    = reporter    !== undefined ? reporter    : (resolved.name || ticket.reporter);
        if (ticket.reporter !== oldReporter) changes.push('reporter');
      }
      if (reviewer_id !== undefined) { ticket.reviewer_id = reviewer_id; changes.push('reviewer'); }
      if (labels !== undefined) { ticket.labels = JSON.stringify(labels); changes.push('labels'); }
      if (channel_ids !== undefined) { ticket.channel_ids = JSON.stringify(channel_ids); changes.push('channel_ids'); }
      if (base_repo_resource_id !== undefined) {
        const next = base_repo_resource_id || '';
        if (next && ticket.workspace_id) {
          // Mirror the REST guard: pin only repos that live in the ticket's
          // workspace so a guessed cross-workspace id can't bleed url/name
          // into the SSE prompt.
          const repoExists = await dataSource.getRepository(Resource).findOne({
            where: { id: next, workspace_id: ticket.workspace_id },
          });
          if (!repoExists) return err('base_repo_resource_id not found in this workspace');
        }
        ticket.base_repo_resource_id = next;
        // Skip the activity-feed entry on idempotent writes — matches REST
        // semantics so a no-op `update_ticket` doesn't spam the log.
        if (next !== (oldBaseRepoId || '')) changes.push('base_repo');
      }
      if (base_branch !== undefined) {
        const next = base_branch || '';
        ticket.base_branch = next;
        if (next !== (oldBaseBranch || '')) changes.push('base_branch');
      }

      await ticketRepo.save(ticket);

      // v0.34: assignment-table sync. Only synced fields the caller actually
      // included; undefined slots preserve their existing assignment.
      if (ticketRoleAssignmentService && ticket.workspace_id) {
        const trio: { assignee_id?: string; reporter_id?: string; reviewer_id?: string } = {};
        if (assignee !== undefined || assignee_id !== undefined) trio.assignee_id = ticket.assignee_id || '';
        if (reporter !== undefined || reporter_id !== undefined) trio.reporter_id = ticket.reporter_id || '';
        if (reviewer_id !== undefined) trio.reviewer_id = ticket.reviewer_id || '';
        if (Object.keys(trio).length > 0) {
          await ticketRoleAssignmentService.syncBuiltinTrio(ticket.id, ticket.workspace_id, trio);
        }
      }

      // Log assignee/reporter changes separately for system comment generation.
      // Trigger off the post-save name (which now reflects backfilled lookups)
      // so a caller passing only `assignee_id` still produces a legible
      // activity entry instead of an empty `→` arrow.
      if ((assignee !== undefined || assignee_id !== undefined) && ticket.assignee !== oldAssignee) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'assignee', old_value: oldAssignee || '', new_value: ticket.assignee || '',
          ticket_id: ticket.id, actor_id: caller?.agentId, actor_name: caller?.agentName,
        });
      }
      if ((reporter !== undefined || reporter_id !== undefined) && ticket.reporter !== oldReporter) {
        await activityService.logActivity({
          entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
          field_changed: 'reporter', old_value: oldReporter || '', new_value: ticket.reporter || '',
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

      await deleteCommentAttachmentsForTicket(dataSource, ticket.id);
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
    'get_my_tickets',
    'Get tickets where this agent is assignee, reporter, or reviewer within the workspace. Each row includes `my_roles` — the role slug(s) the agent holds on that ticket — so an agent juggling multiple roles can see at a glance which hat to wear per ticket.',
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

      // Resolve role slugs the agent holds per ticket. Prefer
      // TicketRoleAssignment (handles workspace-custom roles); fall back to
      // the legacy assignee_id / reporter_id / reviewer_id columns when the
      // assignment service is unavailable (standalone MCP server mode) or
      // returns nothing for a row.
      const rolesByTicket = new Map<string, string[]>();
      if (ticketRoleAssignmentService) {
        for (const t of tickets) {
          try {
            const resolved = await ticketRoleAssignmentService.resolveForTicket(t.id);
            const slugs = resolved
              .filter(r => r.holder?.type === 'agent' && r.holder.id === agent_id)
              .map(r => r.role.slug);
            if (slugs.length > 0) rolesByTicket.set(t.id, slugs);
          } catch { /* fall through to legacy lookup */ }
        }
      }

      return ok(tickets.map(t => {
        let myRoles = rolesByTicket.get(t.id);
        if (!myRoles || myRoles.length === 0) {
          const legacy: string[] = [];
          if (t.assignee_id === agent_id) legacy.push('assignee');
          if (t.reporter_id === agent_id) legacy.push('reporter');
          if (t.reviewer_id === agent_id) legacy.push('reviewer');
          myRoles = legacy;
        }
        return {
          ...t,
          labels: safeJsonParse(t.labels, []),
          channel_ids: safeJsonParse(t.channel_ids, []),
          my_roles: myRoles,
        };
      }));
    }
  );

  // ─── Ticket locking ─────────────────────────────────────

}
