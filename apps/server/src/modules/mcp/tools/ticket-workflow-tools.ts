/**
 * Ticket workflow MCP tools — state transitions + lock lifecycle.
 *
 * Tools: move_ticket, claim_ticket, release_ticket
 *
 * Split out of the legacy monolithic `ticket-tools.ts`. Siblings handle
 * root CRUD and child-ticket operations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { findColumnByName, maxTicketPosition, shiftTicketPositions } from '../shared/ticket-helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerTicketWorkflowTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'move_ticket',
    'Move a root ticket to a different column. Specify target by column_id or column_name.\n\n' +
    'SCOPE — root tickets only:\n' +
    'move_ticket only applies to root tickets (depth = 0, parent_id = null). Child / subtask tickets have ' +
    'column_id = null and live attached to their parent — there is no column to move them to. To finish a ' +
    'subtask, call update_child_ticket(status="done") instead; do NOT try to move it.\n\n' +
    'WORKFLOW RULE — parent moves forward only when children are done:\n' +
    'Before moving a parent ticket forward (e.g., In Progress → Review, or any column → a review/done column), ' +
    'verify that every child ticket is complete. A child counts as complete when its status is "done" OR when its ' +
    'column is marked is_terminal=true. Inspect children via get_ticket first; if any child is still open, either ' +
    'finish it (assignee should call update_child_ticket(status="done") on the subtask once their work is in) or ' +
    'leave the parent where it is. This rule is a convention (not enforced by the server), but agents must respect ' +
    'it — moving a parent past unfinished children invalidates reviewer context.',
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
