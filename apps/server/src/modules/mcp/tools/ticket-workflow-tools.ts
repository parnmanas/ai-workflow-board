/**
 * Ticket workflow MCP tools — status transitions (docs/tickets.md).
 *
 * Tools: move_ticket, claim_ticket, release_ticket
 *
 * `claim_ticket` / `release_ticket` predate the single-agent model (the
 * dispatcher now starts a ticket by moving it to in_progress itself). They stay
 * as harmless compatibility verbs because older agent-manager prompts and the
 * manager's own bookkeeping still call them.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { In } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { TicketArchivedError } from '../shared/archive-helpers';
import { getCallerAgent } from '../shared/session-auth';
import { TicketInputError } from '../../tickets/ticket.service';
import { DONE_STATUS, parseTicketStatus, TICKET_STATUSES } from '../../../common/ticket-status';
import { callerActor } from './ticket-crud-tools';
import type { ToolContext } from './context';

export function registerTicketWorkflowTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, ticketService } = ctx;

  server.tool(
    'move_ticket',
    `Change a root ticket's status: ${TICKET_STATUSES.join(' → ')}.\n\n` +
    'As the assignee, finish your ticket with exactly one move: `done` when the work is complete and landed, ' +
    '`review` when a human should check the result first (say what to check in a comment). ' +
    'Use `backlog` to shelve work that is not ready. Subtasks are not moved — update_child_ticket(status) them.\n\n' +
    'DONE GUARD — moving to `done` while child tickets are still open is rejected; finish or remove the open items first ' +
    '(pass force=true only when the open items are deliberately abandoned, and say so in a comment).',
    {
      ticket_id: z.string().describe('Ticket ID'),
      status: z.string().optional().describe(`Target status (${TICKET_STATUSES.join(', ')})`),
      target_column_name: z.string().optional().describe('DEPRECATED alias of `status` for older prompts ("In Progress", "Done", …)'),
      position: z.number().optional().describe('Position inside the status lane (default: end)'),
      force: z.boolean().optional().describe('Skip the open-children guard on a move to done'),
    },
    async ({ ticket_id, status, target_column_name, position, force }, extra: { sessionId?: string }) => {
      const target = parseTicketStatus(status ?? target_column_name ?? '');
      if (!target) return err(`status is required: one of ${TICKET_STATUSES.join(', ')}`);
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);
      if (ticket.parent_id) return err('Subtasks have no status lane — use update_child_ticket(status="done"|"todo")');
      if (target === DONE_STATUS && !force) {
        const open = await dataSource.getRepository(Ticket).count({
          where: { parent_id: ticket.id, status: In(['todo', 'backlog', 'in_progress', 'review']) },
        });
        if (open > 0) {
          return err(`${open} child ticket(s) are still open — finish them (update_child_ticket status="done") or delete them before moving to done.`);
        }
      }
      try {
        await ticketService.move(ticket.id, target, callerActor(getCallerAgent(extra)), { position });
      } catch (e: any) {
        if (e instanceof TicketInputError) return err(e.message);
        throw e;
      }
      return ok(await loadTicketFull(dataSource, ticket.id));
    },
  );

  server.tool(
    'claim_ticket',
    'Compatibility verb: AWB already moves a ticket to in_progress when it dispatches it to you. ' +
    'Calling this on a todo ticket assigned to you starts it; on any other status it is a no-op.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      agent_id: z.string().optional().describe('Ignored — the caller is identified by its session'),
      ttl_minutes: z.number().optional().describe('Ignored'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);
      if (ticket.status === 'todo') {
        await ticketService.move(ticket.id, 'in_progress', callerActor(getCallerAgent(extra)));
        return ok({ claimed: true, ticket_id, status: 'in_progress' });
      }
      return ok({ claimed: ticket.status === 'in_progress', ticket_id, status: ticket.status });
    },
  );

  server.tool(
    'release_ticket',
    'Compatibility verb from the lock era — tickets are no longer locked. Always returns { released: false }.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      agent_id: z.string().optional().describe('Ignored'),
    },
    async ({ ticket_id }) => ok({ released: false, ticket_id, reason: 'Tickets are not locked' }),
  );
}
