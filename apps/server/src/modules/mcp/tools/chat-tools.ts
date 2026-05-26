/**
 * Chat / typing MCP tools.
 *
 * Tools:
 *   - set_typing: typing indicator for ticket processing
 *   - send_chat_room_message: agent-authored chat-room message
 *   - list_chat_rooms: rooms the authenticated agent is a participant in
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { activityEvents } from '../../../services/activity.service';
import { MAX_TICKET_ATTACHMENT_SIZE } from '../../../common/constants/upload';
import { ok, err, MENTION_SYNTAX_DOC, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { approxBase64Size, inferTicketAttachmentMimetype, projectChatAttachment } from '../shared/ticket-helpers';
import type { ToolContext } from './context';

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger, roomCrudService, roomMembershipService, roomMessagingService } = ctx;

  server.tool(
    'set_typing',
    'Signal that this agent is actively processing a ticket (shows typing indicator in the UI). ' +
    'Call with is_typing=false when done to clear the indicator immediately.',
    {
      agent_id: z.string().describe('Your agent ID'),
      ticket_id: z.string().describe('ID of the ticket being processed'),
      is_typing: z.boolean().describe('true = started processing, false = done processing'),
    },
    async ({ agent_id, ticket_id, is_typing }) => {
      const timestamp = new Date().toISOString();
      activityEvents.emit('agent_typing', { agent_id, ticket_id, is_typing, timestamp });
      // Auto-clear after 60s if agent crashes without sending stop signal
      if (is_typing) {
        setTimeout(() => {
          activityEvents.emit('agent_typing', {
            agent_id,
            ticket_id,
            is_typing: false,
            timestamp: new Date().toISOString(),
          });
        }, 60_000);
      }
      return ok({ status: 'ok' });
    }
  );

  server.tool(
    'send_chat_room_message',
    'Send a message to a chat room. The agent must be an active participant in the room. ' +
    'Messages are persisted and delivered to all room participants via SSE.\n\n' +
    MENTION_SYNTAX_DOC +
    '\n\nNote: chat rooms are not ticket-scoped, so `@[role:...]` role shortcuts have no target context and are dropped on delivery. ' +
    'Stick to `@[user:<uuid>|Name]` and `@[agent:<uuid>|Name]` in chat messages.',
    {
      room_id: z.string().describe('Chat room ID to send the message to'),
      content: z.string().min(1).max(10000).describe('Message content (supports markdown: bold, italic, code span, links)'),
      attachment_ids: z.array(z.string()).optional().describe('Pre-uploaded chat attachment IDs from add_chat_message_attachment or POST /api/chat-rooms/:room_id/attachments.'),
    },
    async ({ room_id, content, attachment_ids }, extra: { sessionId?: string }) => {
      // v0.33: route through RoomMessagingService so the MCP tool, the user
      // REST endpoint (chat-rooms.controller) and the agent ack endpoint
      // (agent-api.controller) all share one save → emit path. That's also
      // what stamps `agent_chain_depth` on the SSE so the plugin can break
      // agent-to-agent loops. Standalone MCP context has no DI, so the
      // service is undefined there and the tool returns a clear error.
      if (!roomMessagingService) {
        return err('send_chat_room_message is unavailable in this MCP context (no RoomMessagingService)');
      }
      const caller = getCallerAgent(extra);
      if (!caller) return err('Unauthorized: no agent identity for this session');

      const agent = caller.agentId
        ? await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } })
        : null;
      if (!agent) return err('Agent identity not found for this session');

      try {
        // Strip harness markers (see comment-tools.ts add_comment for context
        // — ticket ce6c8d58). A chat reply with a leaked `<system-reminder>`
        // block surfaces it verbatim in the room timeline; same root cause.
        const cleanContent = sanitizeHarnessMarkers(content, { logger, toolName: 'send_chat_room_message', fieldName: 'content', agentId: agent.id });
        // agent.workspace_id is nullable now (manager identities carry NULL).
        // A workspace-less manager posting via MCP is theoretical — it would
        // need an apiKey with workspace_id='', and the chat domain is
        // workspace-scoped — but fall back to '' so the typed contract holds.
        const msg = await roomMessagingService.sendMessage(
          room_id,
          agent.workspace_id ?? '',
          'agent',
          agent.id,
          agent.name,
          cleanContent,
          undefined,
          attachment_ids,
        );
        return ok({
          message_id: msg.id,
          room_id: msg.room_id,
          content: msg.content,
          attachments: msg.attachments || [],
          created_at: msg.created_at,
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to send chat room message');
      }
    }
  );

  server.tool(
    'add_chat_message_attachment',
    'Upload a file into a chat room using the shared attachment storage backend. Pass returned attachment_id in send_chat_room_message.attachment_ids.',
    {
      room_id: z.string().describe('Chat room ID'),
      file_name: z.string().describe('File name with extension'),
      file_data: z.string().describe('Base64-encoded file bytes (no data: URI prefix)'),
      file_mimetype: z.string().optional().describe('Explicit MIME type. If omitted, inferred from extension; falls back to application/octet-stream.'),
    },
    async ({ room_id, file_name, file_data, file_mimetype }, extra: { sessionId?: string }) => {
      if (!file_data) return err('file_data is required (base64-encoded bytes)');
      if (!file_name) return err('file_name is required');
      if (!roomMembershipService) return err('Chat membership is unavailable in this MCP context');

      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent?.workspace_id) return err('Could not resolve workspace from caller agent');

      const size = approxBase64Size(file_data);
      if (size > MAX_TICKET_ATTACHMENT_SIZE) {
        return err(`Attachment exceeds ${MAX_TICKET_ATTACHMENT_SIZE / 1024 / 1024}MB limit`);
      }

      try {
        await roomMembershipService.requireActiveParticipant(room_id, agent.id, 'agent');
        // Pre-send owner_type='chat_room', owner_id=room_id (planner-fixed
        // contract). send_chat_room_message → _validatePendingAttachments
        // transitions to owner_type='chat_message', owner_id=message_id.
        const row = await dataSource.getRepository(TicketAttachment).save(dataSource.getRepository(TicketAttachment).create({
          owner_type: 'chat_room',
          owner_id: room_id,
          ticket_id: null,
          room_id,
          workspace_id: agent.workspace_id,
          file_name,
          file_mimetype: inferTicketAttachmentMimetype(file_name, file_mimetype),
          file_data,
          file_size: size,
          uploaded_by_type: 'agent',
          uploaded_by_id: agent.id,
          uploaded_by: caller.agentName || agent.name,
        }));
        return ok(projectChatAttachment(row, { includeData: false }));
      } catch (e: any) {
        return err(e?.message || 'Failed to upload chat attachment');
      }
    }
  );

  server.tool(
    'delete_chat_message_attachment',
    'Discard a chat attachment that has NOT been sent yet. Mirrors DELETE ' +
    '/api/chat-rooms/:room_id/attachments/:id. Once the attachment has been ' +
    'bound to a sent message (owner_type=chat_message), it lives and dies ' +
    'with the message — use message/room deletion instead.',
    {
      attachment_id: z.string().describe('Pre-send attachment ID returned by add_chat_message_attachment.'),
    },
    async ({ attachment_id }, extra: { sessionId?: string }) => {
      if (!roomMembershipService) return err('Chat membership is unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');

      const repo = dataSource.getRepository(TicketAttachment);
      const row = await repo.findOne({ where: { id: attachment_id } });
      if (!row || (row.owner_type !== 'chat_room' && row.owner_type !== 'chat_message')) {
        return err('Attachment not found');
      }
      if (row.owner_type === 'chat_message') {
        return err('Attachment is already sent and cannot be deleted directly');
      }
      if (row.uploaded_by_type !== 'agent' || row.uploaded_by_id !== caller.agentId) {
        return err('Only the uploader can discard a pending attachment');
      }
      try {
        // Re-check membership at delete time too — the room or agent could
        // have been removed between upload and discard.
        if (row.room_id) {
          await roomMembershipService.requireActiveParticipant(row.room_id, caller.agentId, 'agent');
        }
        await repo.delete({ id: attachment_id });
        return ok({ ok: true, attachment_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete chat attachment');
      }
    }
  );

  server.tool(
    'list_chat_rooms',
    'List chat rooms the agent participates in, with last message preview and unread count.',
    {},
    async (_args: Record<string, never>, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return err('Unauthorized: no agent identity for this session');

      const agent = caller.agentId
        ? await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } })
        : null;
      if (!agent) return err('Agent identity not found');

      const rooms = await dataSource.getRepository(ChatRoomParticipant)
        .createQueryBuilder('p')
        .innerJoinAndSelect('p.room', 'r')
        .where('p.participant_id = :agentId', { agentId: agent.id })
        .andWhere('p.participant_type = :type', { type: 'agent' })
        .andWhere('p.left_at IS NULL')
        .orderBy('r.last_message_at', 'DESC', 'NULLS LAST')
        .getMany();

      return ok(rooms.map(p => ({
        room_id: p.room_id,
        name: p.room?.name || null,
        type: p.room?.type || 'group',
        last_message_at: p.room?.last_message_at || null,
      })));
    }
  );

  // v0.32: room creation from MCP. Lets an agent open a DM with a user or
  // another agent (or a group room) without going through the web UI. The
  // creator is auto-included; pass at least one OTHER participant.
  server.tool(
    'create_chat_room',
    'Create a chat room (DM or group) with the given participants. Caller is auto-included so you only list the OTHER members. Two participants total → DM; three+ → group. If a DM already exists between the same two members, returns the existing room (existing=true).',
    {
      participants: z.array(z.object({
        type: z.enum(['user', 'agent']).describe("Participant kind"),
        id: z.string().describe("User ID or Agent ID"),
      })).min(1).describe('Other participants to include. Caller (this agent) is added automatically.'),
      name: z.string().optional().describe('Group room name (ignored for DMs).'),
    },
    async ({ participants, name }, extra: { sessionId?: string }) => {
      if (!roomCrudService) return err('Chat room creation is unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent?.workspace_id) return err('Could not resolve workspace from caller agent');
      try {
        const result = await roomCrudService.createRoom(
          agent.workspace_id,
          { type: 'agent', id: caller.agentId },
          participants.map(p => ({ participant_type: p.type, participant_id: p.id })),
          name,
        );
        return ok({
          room_id: result.room.id,
          existing: result.existing,
          type: result.room.type,
          name: result.room.name,
          participants: result.room.participants || [],
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to create room');
      }
    }
  );

  // Group rooms only — DMs are immutable. Caller must already be a member.
  server.tool(
    'add_chat_participants',
    'Add participants to an existing group chat room. Fails on DMs, on rooms the caller is not in, and on cap (50). Re-adding a previously-left member creates a fresh participant row.',
    {
      room_id: z.string().describe('Target room ID'),
      participants: z.array(z.object({
        type: z.enum(['user', 'agent']),
        id: z.string(),
      })).min(1).describe('Participants to add'),
    },
    async ({ room_id, participants }, extra: { sessionId?: string }) => {
      if (!roomMembershipService) return err('Chat membership is unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      try {
        await roomMembershipService.addParticipants(
          room_id,
          { type: 'agent', id: caller.agentId },
          participants.map(p => ({ participant_type: p.type, participant_id: p.id })),
        );
        return ok({ ok: true, room_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to add participants');
      }
    }
  );
}
