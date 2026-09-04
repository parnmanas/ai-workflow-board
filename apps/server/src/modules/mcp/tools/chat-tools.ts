/**
 * Chat / typing MCP tools.
 *
 * Tools:
 *   - set_typing: typing indicator for ticket processing
 *   - send_chat_room_message: agent-authored chat-room message
 *   - list_chat_rooms: rooms the authenticated agent is a participant in
 *   - get_chat_room_messages: cursor-paginated message history read
 *   - search_chat_messages: workspace full-text search over participating rooms
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IsNull } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { ChatRoom } from '../../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { Ticket } from '../../../entities/Ticket';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { activityEvents } from '../../../services/activity.service';
import { MAX_TICKET_ATTACHMENT_SIZE } from '../../../common/constants/upload';
import { ok, err, MENTION_SYNTAX_DOC, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { approxBase64Size, projectChatAttachment, validateAttachmentMimetype } from '../shared/ticket-helpers';
import type { ToolContext } from './context';
import { normalizeAgentWorkspaceId } from '../../../common/agent-workspace-scope';
import { resolveAgentDisplayName } from '../../../utils/agent-name';

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger, roomCrudService, roomMembershipService, roomMessagingService } = ctx;

  // Per-(agent_id, ticket_id) auto-clear timers for set_typing. Without this
  // map, every `is_typing=true` call schedules a fresh 60s setTimeout that
  // retains a new closure capturing (agent_id, ticket_id, timestamp). A
  // chatty / buggy / malicious agent could accumulate unbounded pending
  // timers — Finding-002 in docs/audit/2026-05-system-cascade-audit.md.
  // The map is closed over the registerChatTools invocation, which runs once
  // per MCP server instance (one per session), so it is naturally session-
  // scoped and dies when the session does.
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      // Resolve the canonical `<Manager>/<Agent>` display once, at emit time.
      // The ticket panel used to render the raw agent UUID here because the
      // event carried no name at all — see .claude/skills/awb-agent-display-name.
      const agentName =
        (await resolveAgentDisplayName(dataSource.getRepository(Agent), agent_id)) || 'Agent';
      activityEvents.emit('agent_typing', { agent_id, agent_name: agentName, ticket_id, is_typing, timestamp });
      const key = `${agent_id}:${ticket_id}`;
      const prev = typingTimers.get(key);
      if (prev) {
        clearTimeout(prev);
        typingTimers.delete(key);
      }
      // Auto-clear after 60s if agent crashes without sending stop signal.
      // Only one pending auto-clear per (agent, ticket) at a time — repeated
      // is_typing=true calls reset the clock instead of stacking timers.
      if (is_typing) {
        const handle = setTimeout(() => {
          typingTimers.delete(key);
          activityEvents.emit('agent_typing', {
            agent_id,
            agent_name: agentName,
            ticket_id,
            is_typing: false,
            timestamp: new Date().toISOString(),
          });
        }, 60_000);
        typingTimers.set(key, handle);
      }
      return ok({ status: 'ok' });
    }
  );

  server.tool(
    'request_ticket_unpend_approval',
    'Post a Resume (Unpend) approval card to a chat room. This tool never clears pending_user_action. ' +
    'A human participant must click the card, which uses their authenticated web session to update the ticket.',
    {
      room_id: z.string().describe('Chat room that should receive the approval card'),
      ticket_id: z.string().describe('Pending ticket to resume after human approval'),
    },
    async ({ room_id, ticket_id }, extra: { sessionId?: string }) => {
      if (!roomMessagingService || !roomMembershipService) {
        return err('Ticket approval cards are unavailable in this MCP context');
      }
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');

      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');
      const callerWorkspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!callerWorkspaceId) return err('Could not resolve workspace from caller API key');

      try {
        await roomMembershipService.requireActiveParticipant(room_id, agent.id, 'agent');
        const [room, ticket] = await Promise.all([
          dataSource.getRepository(ChatRoom).findOne({ where: { id: room_id } }),
          dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } }),
        ]);
        if (!room) return err('Chat room not found');
        if (!ticket) return err('Ticket not found');
        if (room.workspace_id !== callerWorkspaceId || ticket.workspace_id !== room.workspace_id) {
          return err('Ticket and chat room must belong to the caller workspace');
        }
        if (!ticket.pending_user_action) {
          return err('Ticket is not waiting for user action');
        }

        const msg = await roomMessagingService.sendMessage(
          room_id,
          room.workspace_id,
          'agent',
          agent.id,
          agent.name,
          `Resume approval requested for ${ticket.title}`,
          undefined,
          undefined,
          'ticket_action',
          {
            metadata: {
              ticket_action: {
                kind: 'unpend',
                ticket_id: ticket.id,
                title: ticket.title,
              },
            },
          },
        );
        return ok({
          message_id: msg.id,
          room_id: msg.room_id,
          ticket_id: ticket.id,
          status: 'approval_requested',
          created_at: msg.created_at,
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to request ticket unpend approval');
      }
    },
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
      // Empty string allowed when attachment_ids carries the payload
      // (attachment-only screenshot/file share). Service enforces the
      // "content OR attachment_ids required" invariant.
      content: z.string().max(10000).describe('Message content (supports markdown: bold, italic, code span, links). May be empty when attachment_ids is provided.'),
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
      const callerWorkspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!callerWorkspaceId) return err('Could not resolve workspace from caller API key');

      try {
        // Strip harness markers (see comment-tools.ts add_comment for context
        // — ticket ce6c8d58). A chat reply with a leaked `<system-reminder>`
        // block surfaces it verbatim in the room timeline; same root cause.
        const cleanContent = sanitizeHarnessMarkers(content, { logger, toolName: 'send_chat_room_message', fieldName: 'content', agentId: agent.id });
        // agent.workspace_id is nullable now (manager identities carry NULL).
        // A workspace-less manager posting via MCP is theoretical — it would
        // need an apiKey with workspace_id='', and the chat domain is
        // workspace-scoped — but fall back to '' so the typed contract holds.
        const pendingTicketRefs = ctx.pendingTicketRefs?.drain() ?? [];
        let messagePersisted = false;
        let persistedMessageId: string | undefined;
        let msg: any;
        try {
          msg = await roomMessagingService.sendMessage(
            room_id,
            callerWorkspaceId,
            'agent',
            agent.id,
            agent.name,
            cleanContent,
            undefined,
            attachment_ids,
            'message',
            pendingTicketRefs.length > 0
              ? {
                  metadata: { ticket_refs: pendingTicketRefs },
                  onPersisted: (messageId) => {
                    messagePersisted = true;
                    persistedMessageId = messageId;
                  },
                }
              : {
                  onPersisted: (messageId) => {
                    messagePersisted = true;
                    persistedMessageId = messageId;
                  },
                },
          );
        } catch (sendError) {
          if (!messagePersisted) ctx.pendingTicketRefs?.restore(pendingTicketRefs);
          if (pendingTicketRefs.length > 0) {
            logger.error('TicketArtifact', messagePersisted
              ? 'Chat message post-commit delivery failed; ticket artifacts remain durably bound'
              : 'Chat message save failed with pending ticket artifacts', {
              room_id,
              agent_id: agent.id,
              session_id: extra?.sessionId,
              ticket_ids: pendingTicketRefs.map((ref) => ref.ticket_id),
              stage: messagePersisted ? 'message_post_commit' : 'message_persist',
              message_persisted: messagePersisted,
              error: sendError instanceof Error ? sendError.message : String(sendError),
            });
          }
          // The row and its artifact metadata already exist when a failure
          // occurs after onPersisted. Echo that durable binding even on the
          // MCP error result so agent-manager can acknowledge its captured
          // refs instead of flushing a second artifact-only message at turn
          // end. Pre-commit failures intentionally carry no ack and restore
          // the refs for retry / legacy flush.
          if (messagePersisted) {
            return err(
              sendError instanceof Error ? sendError.message : String(sendError),
              {
                message_id: persistedMessageId,
                room_id,
                metadata: pendingTicketRefs.length > 0
                  ? { ticket_refs: pendingTicketRefs }
                  : undefined,
                message_persisted: true,
              },
            );
          }
          throw sendError;
        }
        return ok({
          message_id: msg.id,
          room_id: msg.room_id,
          content: msg.content,
          attachments: msg.attachments || [],
          metadata: msg.metadata,
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
      if (!agent) return err('Agent identity not found for this session');
      const callerWorkspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!callerWorkspaceId) return err('Could not resolve workspace from caller API key');

      const size = approxBase64Size(file_data);
      if (size > MAX_TICKET_ATTACHMENT_SIZE) {
        return err(`Attachment exceeds ${MAX_TICKET_ATTACHMENT_SIZE / 1024 / 1024}MB limit`);
      }

      try {
        await roomMembershipService.requireActiveParticipant(room_id, agent.id, 'agent');
        // Sniff the file bytes BEFORE persistence so a forged mime can
        // never reach disk. Mirrors the REST upload path — same helper,
        // same security guard, surfaced as a tool error here instead of
        // a 400 response.
        const verifiedMime = validateAttachmentMimetype(file_name, file_mimetype, file_data);
        // Pre-send owner_type='chat_room', owner_id=room_id (planner-fixed
        // contract). send_chat_room_message → _validatePendingAttachments
        // transitions to owner_type='chat_message', owner_id=message_id.
        const row = await dataSource.getRepository(TicketAttachment).save(dataSource.getRepository(TicketAttachment).create({
          owner_type: 'chat_room',
          owner_id: room_id,
          ticket_id: null,
          room_id,
          workspace_id: callerWorkspaceId,
          file_name,
          file_mimetype: verifiedMime,
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
        // 자유 참여 여부(ticket 995a9519). 에이전트의 발신 규약은 이 값과 무관하게
        // 그대로 참여자 행을 요구한다 — 완화는 유저 전용이다. 여기 실리는 것은
        // 방의 성격을 알리는 메타데이터일 뿐이다.
        open_join: !!p.room?.open_join,
      })));
    }
  );

  server.tool(
    'get_chat_room_messages',
    'Read the message history of a chat room the agent participates in. ' +
    'Returns full messages (sender, content, attachments, created_at) in chronological order. ' +
    'Use the `before` cursor (a message id) to page backwards through older history. ' +
    'The agent must be an active participant in the room.',
    {
      room_id: z.string().describe('Chat room ID to read messages from'),
      limit: z.number().int().min(1).max(200).optional().describe('Max messages to return (default 50, max 200).'),
      before: z.string().optional().describe('Message ID cursor — return messages strictly older than this one. Omit for the latest page.'),
    },
    async ({ room_id, limit, before }, extra: { sessionId?: string }) => {
      if (!roomMessagingService || !roomMembershipService) {
        return err('get_chat_room_messages is unavailable in this MCP context (no chat services)');
      }
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');

      try {
        // Mirror the agent-api GET /chat-rooms/:roomId/messages path
        // (agent-api.controller): enforce the agent participant gate
        // explicitly, then read in `observer` mode so the service's own
        // user-scoped gate + per-user cleared_at cut are bypassed (those
        // are meaningless for an agent caller). `excludeProgress` keeps the
        // tool's view identical to the history that gets injected into a
        // chat subagent on wake — manager tool-call heartbeats stay hidden
        // so the model reads conversation, not its own narration.
        await roomMembershipService.requireActiveParticipant(room_id, agent.id, 'agent');
        const messages = await roomMessagingService.getMessages(
          room_id,
          agent.id,
          limit ?? 50,
          before,
          { observer: true, excludeProgress: true },
        );
        return ok({ room_id, count: messages.length, messages });
      } catch (e: any) {
        return err(e?.message || 'Failed to read chat room messages');
      }
    }
  );

  server.tool(
    'search_chat_messages',
    'Full-text search chat messages across the workspace, scoped to rooms the agent actively participates in. ' +
    'Case-insensitive substring match on message content. Returns up to 20 matches, newest first, ' +
    'each with room_id/room_name, sender, content, and created_at.',
    {
      query: z.string().describe('Search text (minimum 2 characters; shorter queries are rejected). Case-insensitive substring match.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20, max 50).'),
    },
    async ({ query, limit }, extra: { sessionId?: string }) => {
      if (!roomMessagingService) {
        return err('search_chat_messages is unavailable in this MCP context (no RoomMessagingService)');
      }
      if (!query || query.trim().length < 2) {
        return err('query must be at least 2 characters');
      }
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');
      const callerWorkspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!callerWorkspaceId) return err('Could not resolve workspace from caller API key');

      try {
        // participantType='agent' so the participant-scoping subquery matches
        // THIS agent's room memberships (rows are keyed by participant_type) —
        // see RoomMessagingService.searchMessages. Results are bounded to the
        // agent's own workspace, so cross-workspace history never leaks.
        const results = await roomMessagingService.searchMessages(
          callerWorkspaceId,
          agent.id,
          query.trim(),
          Math.min(limit ?? 20, 50),
          'agent',
        );
        return ok({ query: query.trim(), count: results.length, results });
      } catch (e: any) {
        return err(e?.message || 'Failed to search chat messages');
      }
    }
  );

  // v0.32: room creation from MCP. Lets an agent open a DM with a user or
  // another agent (or a group room) without going through the web UI. The
  // creator is auto-included; pass at least one OTHER participant.
  server.tool(
    'create_chat_room',
    'Create a chat room (DM or group) with the given participants. Caller is auto-included so you only list the OTHER members. Two participants total → DM; three+ → group. Same-member DMs are not deduped — calling this twice with the same two participants creates two distinct rooms (useful for topic-tagged threads).',
    {
      participants: z.array(z.object({
        type: z.enum(['user', 'agent']).describe("Participant kind"),
        id: z.string().describe("User ID or Agent ID"),
      })).min(1).describe('Other participants to include. Caller (this agent) is added automatically.'),
      name: z.string().optional().describe('Optional room name. Persisted for DMs too — when set, the client uses it in place of the partner name fallback.'),
    },
    async ({ participants, name }, extra: { sessionId?: string }) => {
      if (!roomCrudService) return err('Chat room creation is unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');
      const callerWorkspaceId = caller.workspaceId || normalizeAgentWorkspaceId(agent.workspace_id);
      if (!callerWorkspaceId) return err('Could not resolve workspace from caller API key');
      try {
        const result = await roomCrudService.createRoom(
          callerWorkspaceId,
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

  // Rename a room the caller participates in. Primary use: an untitled room
  // (name === '') gets a concise topic title generated by the responding chat
  // subagent on its first turn — see composeChatRoomPrompt in the
  // agent-manager. Works for DMs and groups; reuses renameRoom's 1-100 char
  // validation and emits the same chat_room_update 'renamed' SSE.
  server.tool(
    'set_chat_room_name',
    'Set or rename a chat room title. The caller must be an active participant. ' +
    'Intended for giving an untitled room a short, descriptive topic-based name (1-100 characters). ' +
    'Renames both DMs and group rooms.',
    {
      room_id: z.string().describe('Chat room ID to rename'),
      name: z.string().describe('New room title (1-100 characters, trimmed)'),
    },
    async ({ room_id, name }, extra: { sessionId?: string }) => {
      if (!roomCrudService) return err('Chat room rename is unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');
      try {
        await roomCrudService.renameRoom(room_id, agent.id, name, 'agent');
        return ok({ room_id, name: name.trim() });
      } catch (e: any) {
        return err(e?.message || 'Failed to set chat room name');
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

  // ticket 6ff827cb: explicit keep-alive declaration. The idle/maxTurns/TTL
  // reapers already defer on their own when they detect model output, a live
  // background task, or fresh cli-home activity (see agent-manager's
  // session-progress.ts) — this tool exists for the one case those signals
  // CANNOT observe: a session blocked purely on an external wait (an MCP/API
  // call with no output and no child process). It is deliberately
  // self-service and self-scoped — an agent may only extend/release the
  // keep-alive for a room IT is an active participant of, which the manager
  // then applies only to that same agent's own live session for that room.
  server.tool(
    'keep_chat_session_alive',
    'Declare that THIS agent\'s own live chat session in room_id is doing long-running work ' +
    '(e.g. an in-process multi-agent Workflow, or waiting on a slow external call) and must not be ' +
    'idle/maxTurns-reaped for `minutes`. Call action="extend" before/during long work and again if more ' +
    'time is needed; call action="release" when done so normal idle reaping resumes immediately. Only ' +
    'useful for work invisible to the manager\'s automatic progress gate — most long-running work (model ' +
    'output, a live background process, an in-process Workflow writing transcripts) already defers reaping ' +
    'on its own; you do not need to call this for those. Grants are clamped to a hard ceiling (default 120 ' +
    'minutes total, manager-configured) measured from your FIRST call for this session and never reset — ' +
    'this cannot be used to keep a session alive indefinitely. Reaching the ceiling force-terminates the ' +
    'session with a visible room notice, even if you call extend again. Requires the calling agent to have ' +
    'a live agent-manager instance and be an active participant of room_id; the grant is issued ' +
    'fire-and-forget over the manager control channel (this tool does not wait for the manager to ack it).',
    {
      room_id: z.string().describe('The chat room this agent\'s own live session is running in'),
      action: z.enum(['extend', 'release']).default('extend')
        .describe('extend = request/renew a keep-alive grant; release = clear an active grant early'),
      minutes: z.number().int().positive().max(24 * 60).optional()
        .describe('Requested grant length in minutes (extend only). Clamped to the configured hard ceiling. Omit to request the full remaining ceiling.'),
      reason: z.string().max(500).optional()
        .describe('Short human-readable reason, surfaced in the forced-termination room notice if the ceiling is later reached'),
    },
    async ({ room_id, action, minutes, reason }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('Unauthorized: agent identity required');
      if (!ctx.agentManagerCommandService) {
        return err('keep_chat_session_alive is unavailable in this MCP context (no AgentManagerCommandService)');
      }
      const agent = await dataSource.getRepository(Agent).findOne({ where: { id: caller.agentId } });
      if (!agent) return err('Agent identity not found for this session');

      const participant = await dataSource.getRepository(ChatRoomParticipant).findOne({
        where: { room_id, participant_type: 'agent', participant_id: agent.id, left_at: IsNull() },
      });
      if (!participant) {
        return err('This agent is not an active participant of that room — keep-alive only covers your own live session');
      }

      if (!agent.manager_agent_id) {
        return err('This agent has no manager_agent_id — it is not run by an agent-manager instance');
      }
      const instance = ctx.agentManagerCommandService.resolveLiveManagerInstance(agent.manager_agent_id);
      if (!instance) {
        return err('No live agent-manager instance for this agent — is the manager online?');
      }

      const command = action === 'release' ? 'release_chat_keepalive' : 'extend_chat_keepalive';
      const { command_id } = await ctx.agentManagerCommandService.issue(
        instance,
        command,
        { agent_id: agent.id, room_id, minutes, reason },
        agent.id,
      );
      return ok({
        ok: true,
        issued: true,
        command_id,
        action,
        room_id,
        note: 'Issued to the manager over the async control channel — this does not confirm the grant was applied; check the manager log or the room for the forced-termination notice if the ceiling is later reached.',
      });
    },
  );
}
