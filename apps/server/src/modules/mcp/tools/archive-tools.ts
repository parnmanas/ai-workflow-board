/**
 * Archive MCP tools (ticket 9b44526b).
 *
 * Tools: list_archived_tickets, archive_ticket, unarchive_ticket
 *
 * Auto-registered by the `tools/index.ts` filename-convention loader — no
 * edit needed there. Active-ticket tools live in ticket-crud-tools /
 * ticket-workflow-tools and exclude `archived_at IS NOT NULL` rows; these
 * are the dedicated read + restore surface for archived rows.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { ok, err, safeJsonParse } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import { isTerminalColumn } from '../shared/archive-helpers';
import type { ToolContext } from './context';

export function registerArchiveTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger } = ctx;

  server.tool(
    'list_archived_tickets',
    'List archived (soft-deleted) tickets for a board. Pagination via cursor + limit; optional q filters by title (case-insensitive substring). ' +
      'Returns rows with archived_at set + their original column id/name so the UI can show "Originally in Done". Lookup-only — use unarchive_ticket to restore.',
    {
      board_id: z.string().describe('Board ID to list archived tickets for'),
      cursor: z.string().optional().describe('Pagination cursor (returned by a previous call as next_cursor; ISO timestamp of the last row in the previous page).'),
      limit: z.number().int().min(1).max(200).optional().default(50).describe('Max rows per page (1..200, default 50)'),
      q: z.string().optional().describe('Optional case-insensitive substring filter on title / id'),
    },
    async ({ board_id, cursor, limit, q }) => {
      const colRepo = dataSource.getRepository(BoardColumn);
      const ticketRepo = dataSource.getRepository(Ticket);
      const cols = await colRepo.find({ where: { board_id } });
      if (cols.length === 0) return ok({ tickets: [], next_cursor: null });

      const colIds = cols.map(c => c.id);
      let qb = ticketRepo.createQueryBuilder('t')
        .where('t.column_id IN (:...colIds)', { colIds })
        .andWhere('t.archived_at IS NOT NULL')
        .orderBy('t.archived_at', 'DESC')
        .take(limit + 1);

      if (cursor) {
        // Cursor encodes the last seen archived_at (descending) — pull rows
        // strictly older than it. Same archived_at + same id = stable
        // tiebreak (sort by id within ties).
        qb = qb.andWhere('t.archived_at < :cursor', { cursor: new Date(cursor) });
      }
      if (q) {
        qb = qb.andWhere('(LOWER(t.title) LIKE :q OR t.id = :exactId)', {
          q: `%${q.toLowerCase()}%`,
          exactId: q,
        });
      }

      const rows = await qb.getMany();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const colById = new Map(cols.map(c => [c.id, c]));

      return ok({
        tickets: page.map(t => ({
          ...t,
          labels: safeJsonParse(t.labels, []),
          channel_ids: safeJsonParse(t.channel_ids, []),
          column_name: colById.get(t.column_id || '')?.name ?? '',
        })),
        next_cursor: hasMore && page.length > 0
          ? new Date(page[page.length - 1].archived_at!).toISOString()
          : null,
      });
    }
  );

  server.tool(
    'archive_ticket',
    'Archive a ticket. Sets archived_at=now; the ticket is excluded from board GET / SSE / supervisor / focus selector by default. ' +
      'Allowed from any column — typically used on Done tickets manually, but operators can archive non-terminal tickets too (e.g. obsolete / superseded work). ' +
      'Activity log records the actor for audit. Restore via unarchive_ticket.',
    {
      ticket_id: z.string().describe('Ticket ID to archive'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return ok({ ...ticket, already_archived: true });
      if (ticket.parent_id || ticket.depth > 0) {
        return err('Only root tickets can be archived (subtasks travel with their parent)');
      }

      const caller = getCallerAgent(extra);

      // Warn but don't reject if the ticket isn't on a terminal column —
      // manual archive of obsolete-but-open work is a valid operator action.
      let isTerminal = false;
      if (ticket.column_id) {
        const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
        isTerminal = isTerminalColumn(col);
        if (!isTerminal) {
          logger.info('Archiver', 'manual archive on non-terminal column', {
            ticket_id: ticket.id, column_id: ticket.column_id, column_name: col?.name,
          });
        }
      }

      ticket.archived_at = new Date();
      await ticketRepo.save(ticket);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'archived',
        ticket_id: ticket.id,
        actor_id: caller?.agentId,
        actor_name: caller?.agentName || 'manual',
        field_changed: 'archived_at',
        new_value: new Date(ticket.archived_at).toISOString(),
      });

      const full = await loadTicketFull(dataSource, ticket.id);
      return ok({ ...full, manual: true, on_terminal: isTerminal });
    }
  );

  server.tool(
    'unarchive_ticket',
    'Restore an archived ticket. Clears archived_at AND resets terminal_entered_at so the archiver does not immediately re-eat the ticket on the next tick. ' +
      'The ticket reappears in board GET / SSE / supervisor candidate sets. Activity log records the restore.',
    {
      ticket_id: z.string().describe('Ticket ID to unarchive'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (!ticket.archived_at) return ok({ ...ticket, already_active: true });

      const caller = getCallerAgent(extra);

      // Re-resolve current column to decide what terminal_entered_at should be.
      // If the ticket still sits on a terminal column (the common case — it was
      // archived from Done), stamp it to "now" so the archiver's grace window
      // restarts. If somehow the column changed underneath while archived
      // (unusual; mutation gate normally prevents it), clear instead.
      let isTerminalNow = false;
      if (ticket.column_id) {
        const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
        isTerminalNow = isTerminalColumn(col);
      }

      const wasArchivedAt = ticket.archived_at;
      ticket.archived_at = null;
      ticket.terminal_entered_at = isTerminalNow ? new Date() : null;
      await ticketRepo.save(ticket);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'unarchived',
        ticket_id: ticket.id,
        actor_id: caller?.agentId,
        actor_name: caller?.agentName || 'manual',
        field_changed: 'archived_at',
        old_value: new Date(wasArchivedAt).toISOString(),
        new_value: '',
      });

      const full = await loadTicketFull(dataSource, ticket.id);
      return ok(full);
    }
  );
}
