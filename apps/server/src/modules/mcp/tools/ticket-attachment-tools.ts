/**
 * Ticket attachment MCP tools.
 *
 * Tools: add_ticket_attachment, list_ticket_attachments, get_ticket_attachment,
 *        delete_ticket_attachment
 *
 * Distinct from comment attachments — those go through Resource (type=
 * 'comment_attachment') because comments are timeline entries that can stand
 * alone outside of any ticket. Ticket-level attachments are bound to the
 * ticket itself: storage is the dedicated `ticket_attachments` table, no
 * Resource indirection, deletes cascade with the ticket.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Ticket } from '../../../entities/Ticket';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import {
  MAX_TICKET_ATTACHMENT_SIZE,
  MAX_TICKET_ATTACHMENTS,
} from '../../../common/constants/upload';
import { ok, err } from '../shared/helpers';
import {
  approxBase64Size,
  inferTicketAttachmentMimetype,
  projectTicketAttachment,
} from '../shared/ticket-helpers';
import { getCallerAgent } from '../shared/session-auth';
import { TicketArchivedError } from '../shared/archive-helpers';
import type { ToolContext } from './context';

export function registerTicketAttachmentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, activityService } = ctx;

  server.tool(
    'add_ticket_attachment',
    'Attach a file directly to a ticket (NOT through Resources — distinct from comment attachments). ' +
      'Pass the binary inline as base64 in `file_data`. The file lifecycle is bound to the ticket — ' +
      'attachments cascade-delete when the ticket is deleted.',
    {
      ticket_id: z.string().describe('Ticket ID'),
      file_name: z.string().describe('File name with extension (used to infer mimetype if file_mimetype omitted)'),
      file_data: z.string().describe('Base64-encoded file bytes (no data: URI prefix)'),
      file_mimetype: z.string().optional().describe('Explicit MIME type. If omitted, inferred from extension; falls back to application/octet-stream.'),
      uploaded_by_type: z.enum(['user', 'agent']).optional().describe('Uploader type (auto-detected from auth)'),
      uploaded_by_id: z.string().optional().describe('Uploader ID (auto-filled from auth)'),
      uploaded_by: z.string().optional().describe('Uploader display name (auto-filled from auth)'),
    },
    async ({ ticket_id, file_name, file_data, file_mimetype, uploaded_by_type, uploaded_by_id, uploaded_by }, extra: { sessionId?: string }) => {
      if (!file_data) return err('file_data is required (base64-encoded bytes)');
      if (!file_name) return err('file_name is required');

      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const size = approxBase64Size(file_data);
      if (size > MAX_TICKET_ATTACHMENT_SIZE) {
        return err(`Attachment exceeds ${MAX_TICKET_ATTACHMENT_SIZE / 1024 / 1024}MB limit`);
      }

      const attRepo = dataSource.getRepository(TicketAttachment);
      const existing = await attRepo.count({ where: { ticket_id } });
      if (existing >= MAX_TICKET_ATTACHMENTS) {
        return err(`Maximum ${MAX_TICKET_ATTACHMENTS} attachments per ticket (have ${existing})`);
      }

      const caller = getCallerAgent(extra);
      const resolvedType = uploaded_by_type || (caller?.agentId ? 'agent' : 'user');
      const resolvedId = uploaded_by_id || caller?.agentId || '';
      const resolvedName = uploaded_by || caller?.agentName || '';
      const mimetype = inferTicketAttachmentMimetype(file_name, file_mimetype);

      const row = await attRepo.save(attRepo.create({
        owner_type: 'ticket',
        owner_id: ticket_id,
        ticket_id,
        workspace_id: ticket.workspace_id || '',
        file_name,
        file_mimetype: mimetype,
        file_data,
        file_size: size,
        uploaded_by_type: resolvedType,
        uploaded_by_id: resolvedId,
        uploaded_by: resolvedName,
      }));

      await activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticket.id,
        action: 'updated',
        ticket_id: ticket.parent_id || ticket.id,
        actor_id: resolvedId,
        actor_name: resolvedName,
        field_changed: 'attachment',
        new_value: file_name,
      });

      return ok(projectTicketAttachment(row, { includeData: false }));
    }
  );

  server.tool(
    'list_ticket_attachments',
    'List all file attachments on a ticket. Returns metadata only (no file_data) — call get_ticket_attachment to download the bytes.',
    {
      ticket_id: z.string().describe('Ticket ID'),
    },
    async ({ ticket_id }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      const rows = await dataSource.getRepository(TicketAttachment).find({
        where: { ticket_id },
        order: { created_at: 'DESC' },
      });
      return ok(rows.map(r => projectTicketAttachment(r, { includeData: false })));
    }
  );

  server.tool(
    'get_ticket_attachment',
    'Fetch a single ticket attachment INCLUDING the base64 file_data so the caller can decode the binary. ' +
      'Use list_ticket_attachments first to discover the attachment_id.',
    {
      attachment_id: z.string().describe('TicketAttachment ID (from list_ticket_attachments)'),
    },
    async ({ attachment_id }) => {
      const row = await dataSource.getRepository(TicketAttachment).findOne({ where: { id: attachment_id } });
      // Chat attachments share this table (owner_type='chat_room' or
      // 'chat_message'). Pretend they don't exist here so a caller that learns
      // a chat attachment id can't bypass the chat participant-only download
      // path (`/api/chat-rooms/:roomId/attachments/:id`).
      if (!row || row.owner_type !== 'ticket' || !row.ticket_id) return err('Attachment not found');
      return ok(projectTicketAttachment(row, { includeData: true }));
    }
  );

  server.tool(
    'delete_ticket_attachment',
    'Remove a file attachment from a ticket. The ticket itself is left unchanged.',
    {
      attachment_id: z.string().describe('TicketAttachment ID'),
    },
    async ({ attachment_id }, extra: { sessionId?: string }) => {
      const attRepo = dataSource.getRepository(TicketAttachment);
      const row = await attRepo.findOne({ where: { id: attachment_id } });
      // Same scoping as get_ticket_attachment: refuse to act on chat rows so
      // this tool can't hard-delete a chat attachment past the uploader +
      // pending-only checks in delete_chat_message_attachment.
      if (!row || row.owner_type !== 'ticket' || !row.ticket_id) return err('Attachment not found');

      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: row.ticket_id } });
      if (ticket?.archived_at) return err(new TicketArchivedError(ticket.id).message);
      await attRepo.delete({ id: attachment_id });

      const caller = getCallerAgent(extra);
      if (ticket) {
        await activityService.logActivity({
          entity_type: 'ticket',
          entity_id: ticket.id,
          action: 'updated',
          ticket_id: ticket.parent_id || ticket.id,
          actor_id: caller?.agentId,
          actor_name: caller?.agentName,
          field_changed: 'attachment',
          old_value: row.file_name,
        });
      }

      return ok({ success: true, id: attachment_id });
    }
  );
}
