/**
 * Ticket-prerequisite MCP tools (ticket 48d14fff) — the "blocked-by another
 * ticket" surface.
 *
 * Tools (all conceptually in the `pending` category alongside pend_ticket /
 * unpend_ticket):
 *   - add_ticket_prerequisites   — block a ticket on one or more prereqs
 *   - remove_ticket_prerequisite — drop one link; auto-unblock on the last
 *   - list_ticket_prerequisites  — read the link set (also folded into get_ticket)
 *
 * Distinct from `pend_ticket` (human-wait): prerequisites auto-resume the
 * moment every blocker lands on a terminal column — no human action needed.
 * The auto-resume sweep itself lives in TriggerLoopService; these tools own
 * the link mutations + the immediate unblock-on-remove dispatch.
 *
 * Auto-registered by the `tools/index.ts` filename-convention loader.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import { TicketPrerequisitesService } from '../../tickets/ticket-prerequisites.service';
import type { ToolContext } from './context';

export function registerTicketPrerequisiteTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, triggerLoopService, logger } = ctx;
  // Reuse the DI singleton in the integrated server; construct a thin instance
  // in standalone mode (the service is stateless over dataSource + activity).
  const svc =
    ctx.ticketPrerequisitesService ||
    new TicketPrerequisitesService(dataSource as any, activityService);

  server.tool(
    'add_ticket_prerequisites',
    'Block this ticket until the specified prerequisite ticket(s) reach a terminal column. ' +
      'Sets `pending_on_tickets=true` and AUTO-RESUMES (no human action needed) the moment every prereq lands on a terminal column — at which point the dependent\'s current-column role holders are re-triggered automatically. ' +
      'Prefer this over `pend_ticket` whenever the blocker is another ticket rather than a human decision. ' +
      'Guards: same-workspace only, no self-reference, no dependency cycle, no archived prereq. Idempotent per (ticket, prereq) pair.',
    {
      ticket_id: z.string().describe('Ticket to block (the dependent)'),
      prerequisite_ticket_ids: z
        .array(z.string())
        .min(1)
        .describe('One or more ticket IDs that must reach a terminal column before this ticket resumes'),
      reason: z
        .string()
        .optional()
        .describe('Optional context for why the block exists. Surfaced on the ticket detail panel; also reused as the ticket\'s pending_reason when none is set.'),
    },
    async ({ ticket_id, prerequisite_ticket_ids, reason }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        const result = await svc.addPrerequisites(ticket_id, prerequisite_ticket_ids, {
          reason,
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });
        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({
          added: result.added,
          pending_on_tickets: result.pending_on_tickets,
          ticket: full,
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to add prerequisites');
      }
    }
  );

  server.tool(
    'remove_ticket_prerequisite',
    'Remove a single prerequisite link from a ticket. When the last open link is removed, the ticket auto-unblocks (`pending_on_tickets=false`) and its current-column role holders are re-triggered. Idempotent — removing a link that isn\'t there is a no-op.',
    {
      ticket_id: z.string().describe('The dependent ticket'),
      prerequisite_ticket_id: z.string().describe('The prerequisite link to remove'),
    },
    async ({ ticket_id, prerequisite_ticket_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        // Snapshot the pre-removal pending state so we only dispatch on an
        // actual true → false transition (avoids waking holders when the
        // ticket was never blocked or stays blocked behind another prereq).
        const before = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
        const wasPending = !!before?.pending_on_tickets;

        const result = await svc.removePrerequisite(ticket_id, prerequisite_ticket_id, {
          actorId: caller?.agentId,
          actorName: caller?.agentName,
        });

        if (result.removed && wasPending && !result.pending_on_tickets && triggerLoopService) {
          try {
            await triggerLoopService.dispatchCurrentColumn(
              ticket_id, 'prerequisite_resolved', caller?.agentId || '',
            );
          } catch (e) {
            logger.warn('MCP', 'remove_ticket_prerequisite unblock dispatch failed (continuing)', {
              err: String(e), ticket_id,
            });
          }
        }

        const full = await loadTicketFull(dataSource, ticket_id);
        return ok({ ...result, ticket: full });
      } catch (e: any) {
        return err(e?.message || 'Failed to remove prerequisite');
      }
    }
  );

  server.tool(
    'list_ticket_prerequisites',
    'List the prerequisite tickets blocking a ticket. Each row carries the prereq\'s title, current column, whether that column is terminal (= satisfied), and archived state. The same list is also folded into `get_ticket` under `prerequisites`, so a separate call is only needed for a focused refresh.',
    {
      ticket_id: z.string().describe('The dependent ticket'),
    },
    async ({ ticket_id }) => {
      try {
        const rows = await svc.listFull(ticket_id);
        return ok({ ticket_id, prerequisites: rows });
      } catch (e: any) {
        return err(e?.message || 'Failed to list prerequisites');
      }
    }
  );
}
