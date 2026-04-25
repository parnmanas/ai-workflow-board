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
import { ChatRoom } from '../../../entities/ChatRoom';
import { ChatRoomMessage } from '../../../entities/ChatRoomMessage';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { activityEvents } from '../../../services/activity.service';
import { ok, err, MENTION_SYNTAX_DOC } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, roomCrudService, roomMembershipService } = ctx;

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
    },
    async ({ room_id, content }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller) return err('Unauthorized: no agent identity for this session');

      const agent = caller.agentId
        ? await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } })
        : null;
      if (!agent) return err('Agent identity not found for this session');

      // Verify agent is an active participant
      const participant = await dataSource.getRepository(ChatRoomParticipant).findOne({
        where: { room_id, participant_id: agent.id, participant_type: 'agent', left_at: undefined },
      });
      if (!participant) return err(`Agent is not an active participant in room ${room_id}`);

      // Save message
      const msg = await dataSource.getRepository(ChatRoomMessage).save(
        dataSource.getRepository(ChatRoomMessage).create({
          room_id,
          sender_type: 'agent',
          sender_id: agent.id,
          content,
          workspace_id: agent.workspace_id,
        }),
      );

      // Update room last_message_at
      await dataSource.getRepository(ChatRoom).update(room_id, { last_message_at: msg.created_at });

      // Resolve member_ids for SSE participant filter
      const members = await dataSource.getRepository(ChatRoomParticipant).find({
        where: { room_id, left_at: undefined },
      });
      const memberIds = new Set(members.filter(m => m.participant_type === 'user').map(m => m.participant_id));
      const agentMemberIds = new Set(members.filter(m => m.participant_type === 'agent').map(m => m.participant_id));

      activityEvents.emit('chat_room_message', {
        room_id,
        workspace_id: agent.workspace_id,
        message_id: msg.id,
        sender_type: 'agent',
        sender_id: agent.id,
        sender_name: agent.name,
        content,
        images: [],
        created_at: msg.created_at instanceof Date ? msg.created_at.toISOString() : msg.created_at,
        member_ids: memberIds,
        agent_member_ids: agentMemberIds,
      });

      return ok({ message_id: msg.id, room_id, content, created_at: msg.created_at });
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
