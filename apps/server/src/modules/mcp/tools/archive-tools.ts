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
import { Ticket } from '../../../entities/Ticket';
import { ok, err, safeJsonParse } from '../shared/helpers';
import { loadTicketFull } from '../shared/ticket-parsing';
import { getCallerAgent } from '../shared/session-auth';
import { buildArchiveCursor, parseArchiveCursor } from '../shared/archive-helpers';
import type { ToolContext } from './context';

export function registerArchiveTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService, logger } = ctx;

  server.tool(
    'list_archived_tickets',
    'List archived (soft-deleted) tickets of a workspace. Pagination via cursor + limit; optional q filters by title / id / tag (case-insensitive). ' +
      'Rows keep their status so the UI can show "archived from Done". Lookup-only — use unarchive_ticket to restore.',
    {
      workspace_id: z.string().optional().describe('Workspace (defaults to the caller\'s workspace)'),
      cursor: z.string().optional().describe('Pagination cursor returned by a previous call as next_cursor (opaque compound `<isoTimestamp>|<id>`). Bare ISO timestamps from older callers still work.'),
      limit: z.number().int().min(1).max(200).optional().default(50).describe('Max rows per page (1..200, default 50)'),
      q: z.string().optional().describe('Optional case-insensitive substring filter on title / exact id match / tag name'),
    },
    async ({ workspace_id, cursor, limit, q }, extra: { sessionId?: string }) => {
      const ws = workspace_id || getCallerAgent(extra)?.workspaceId || '';
      if (!ws) return err('workspace_id is required');
      const ticketRepo = dataSource.getRepository(Ticket);
      // Compound (archived_at DESC, id DESC) sort — the archiver stamps a
      // whole batch with the same archived_at, so an archived_at-only cursor
      // would drop the rest of that batch on the next page.
      let qb = ticketRepo.createQueryBuilder('t')
        .where('t.workspace_id = :ws', { ws })
        .andWhere('t.parent_id IS NULL')
        .andWhere('t.archived_at IS NOT NULL')
        .orderBy('t.archived_at', 'DESC')
        .addOrderBy('t.id', 'DESC')
        .take(limit + 1);

      if (cursor) {
        const { ts, id } = parseArchiveCursor(cursor);
        if (ts && id != null) {
          qb = qb.andWhere(
            '(t.archived_at < :ts) OR (t.archived_at = :ts AND t.id < :id)',
            { ts, id },
          );
        } else if (ts) {
          // Legacy bare-timestamp cursor (no tiebreak) — keep older clients
          // paging forward without dropping silently.
          qb = qb.andWhere('t.archived_at < :ts', { ts });
        }
      }
      if (q) {
        // Match title (substring), id (exact), or tag (substring of the
        // JSON-encoded tags column — `["foo","bar"]`).
        qb = qb.andWhere(
          '(LOWER(t.title) LIKE :q OR CAST(t.id AS VARCHAR) = :exactId OR LOWER(t.tags) LIKE :tagQ)',
          {
            q: `%${q.toLowerCase()}%`,
            exactId: q,
            tagQ: `%"${q.toLowerCase()}"%`,
          },
        );
      }

      const rows = await qb.getMany();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return ok({
        tickets: page.map(t => ({
          ...t,
          tags: safeJsonParse(t.tags, []),
          channel_ids: safeJsonParse(t.channel_ids, []),
          assignee: t.assignee ?? null,
        })),
        next_cursor: hasMore && page.length > 0
          ? buildArchiveCursor(page[page.length - 1].archived_at!, page[page.length - 1].id)
          : null,
      });
    }
  );

  server.tool(
    'archive_ticket',
    'Archive a ticket. Sets archived_at=now; the ticket is excluded from the ticket list and from dispatch. ' +
      'Allowed from any status — typically used on done tickets, but obsolete / superseded open work can be archived too. ' +
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

      const isTerminal = ticket.status === 'done';
      if (!isTerminal) {
        logger.info('Archiver', 'manual archive of an open ticket', { ticket_id: ticket.id, status: ticket.status });
      }

      ticket.archived_at = new Date();
      // 아카이브된 티켓이 키를 계속 쥐고 있으면 outreach-ingest.service.ts의 dedupe
      // winner 조회가 이 비가시 티켓을 승자로 골라버릴 수 있다(티켓 a565b657).
      ticket.operational_dedupe_key = null;
      await ticketRepo.save(ticket);

      await activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'archived',
        ticket_id: ticket.id,
        workspace_id: ticket.workspace_id,
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
      'The ticket reappears in the ticket list and dispatch. Activity log records the restore.',
    {
      ticket_id: z.string().describe('Ticket ID to unarchive'),
    },
    async ({ ticket_id }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (!ticket.archived_at) return ok({ ...ticket, already_active: true });

      const caller = getCallerAgent(extra);

      // A done ticket gets a fresh terminal stamp so the archiver's grace
      // window restarts instead of re-archiving it on the next tick.
      const wasArchivedAt = ticket.archived_at;
      ticket.archived_at = null;
      ticket.terminal_entered_at = ticket.status === 'done' ? new Date() : null;
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
