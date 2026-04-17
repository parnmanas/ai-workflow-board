import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { RoomMembershipService } from './room-membership.service';

const CONTENT_MAX = 10000;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Owns message I/O for chat rooms.
 *
 * Responsibilities:
 *  - send (with @mention / DM-agent dispatch)
 *  - paginated history (cursor on composite created_at + id)
 *  - monotonic read marker advance
 *  - workspace-scoped message search
 *
 * Participant validation and member-id lookups are delegated to RoomMembershipService
 * so the 403 / active-participant invariant lives in one place. Mention dispatch
 * (chat_request events) is owned here because it is inherently message-bound.
 */
@Injectable()
export class RoomMessagingService {
  constructor(
    @InjectRepository(ChatRoom)
    private readonly roomRepo: Repository<ChatRoom>,

    @InjectRepository(ChatRoomParticipant)
    private readonly participantRepo: Repository<ChatRoomParticipant>,

    @InjectRepository(ChatRoomMessage)
    private readonly messageRepo: Repository<ChatRoomMessage>,

    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,

    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,

    private readonly logService: LogService,

    private readonly membership: RoomMembershipService,
  ) {}

  /**
   * Paginated message history for a room (cursor-based with `before` message ID).
   * Caller must be an active participant (left_at IS NULL) — else 403.
   */
  async getMessages(
    roomId: string,
    userId: string,
    limit: number,
    before?: string,
  ): Promise<any[]> {
    await this.membership.requireActiveParticipant(roomId, userId);

    const cappedLimit = Math.min(limit, 200);

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.room_id = :roomId', { roomId })
      .orderBy('m.created_at', 'DESC')
      .limit(cappedLimit);

    if (before) {
      // Cursor pagination: use composite (created_at, id) to avoid skipping messages
      // with identical timestamps (common under message bursts at millisecond precision)
      const cursorMsg = await this.messageRepo.findOne({ where: { id: before } });
      if (cursorMsg) {
        qb.andWhere(
          '(m.created_at < :cursorAt OR (m.created_at = :cursorAt AND m.id < :cursorId))',
          { cursorAt: cursorMsg.created_at, cursorId: cursorMsg.id },
        );
      }
    }

    const messages = await qb.getMany();

    // Resolve sender names with caching
    const nameCache = new Map<string, string>();
    const resolved = await Promise.all(
      messages.map(async msg => {
        const cacheKey = `${msg.sender_type}:${msg.sender_id}`;
        let senderName = nameCache.get(cacheKey);
        if (!senderName) {
          senderName = await this.membership.resolveParticipantName(msg.sender_type, msg.sender_id);
          nameCache.set(cacheKey, senderName);
        }
        return {
          id: msg.id,
          room_id: msg.room_id,
          workspace_id: msg.workspace_id,
          sender_type: msg.sender_type,
          sender_id: msg.sender_id,
          sender_name: senderName,
          content: msg.content,
          created_at: msg.created_at,
          updated_at: msg.updated_at,
        };
      }),
    );

    // Return in chronological order
    return resolved.reverse();
  }

  /**
   * Send a message to a room. Sender must be an active participant.
   * Updates room.last_message_at and emits activityEvents 'chat_room_message' with member_ids.
   * Optionally accepts image attachments (validated in controller before this call).
   * For user-sent messages, parses @mentions and emits chat_request to SubagentManager (CHAT-17, CHAT-18).
   */
  async sendMessage(
    roomId: string,
    workspaceId: string,
    senderType: string,
    senderId: string,
    senderName: string,
    content: string,
    images?: Array<{ data: string; filename: string; mimetype: string }>,
  ): Promise<any> {
    await this.membership.requireActiveParticipant(roomId, senderId, senderType);

    if (!content || typeof content !== 'string') {
      throw makeError(400, 'content is required');
    }
    const trimmed = content.trim();
    if (!trimmed) {
      throw makeError(400, 'content cannot be empty');
    }
    if (trimmed.length > CONTENT_MAX) {
      throw makeError(400, `Message exceeds ${CONTENT_MAX} character limit`);
    }

    const savedMsg = await this.messageRepo.save(
      this.messageRepo.create({
        room_id: roomId,
        workspace_id: workspaceId,
        sender_type: senderType,
        sender_id: senderId,
        content: trimmed,
        images: images && images.length > 0 ? JSON.stringify(images) : '[]',
      }),
    );

    // Update denormalized last_message_at for room list sort
    await this.roomRepo.update(roomId, { last_message_at: new Date() });

    // CHAT-18: only parse mentions from user messages — prevents agent-to-agent loops
    if (senderType === 'user') {
      const dispatched = await this._processMentions(roomId, workspaceId, senderId, trimmed, savedMsg);
      await this._handleDmAgentRequest(roomId, workspaceId, senderId, trimmed, savedMsg, dispatched);
    }

    // Get active member IDs for SSE filtering (CRITICAL Pitfall 1)
    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);

    activityEvents.emit('chat_room_message', {
      room_id: roomId,
      workspace_id: workspaceId,
      message_id: savedMsg.id,
      sender_type: senderType,
      sender_id: senderId,
      sender_name: senderName,
      content: trimmed,
      images: savedMsg.images,
      created_at: savedMsg.created_at.toISOString(),
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });

    return {
      id: savedMsg.id,
      room_id: savedMsg.room_id,
      workspace_id: savedMsg.workspace_id,
      sender_type: savedMsg.sender_type,
      sender_id: savedMsg.sender_id,
      sender_name: senderName,
      content: savedMsg.content,
      images: savedMsg.images,
      created_at: savedMsg.created_at,
      updated_at: savedMsg.updated_at,
    };
  }

  /**
   * Mark room as read up to the latest message (monotonic advance only).
   * Only advances last_read_at if the latest message is newer than current last_read_at.
   */
  async markRead(roomId: string, userId: string): Promise<void> {
    const participant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_id: userId,
        participant_type: 'user',
      },
    });

    if (!participant || participant.left_at !== null) {
      throw makeError(403, 'Not a participant in this room');
    }

    // Find the latest message in the room
    const latestMsg = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.room_id = :roomId', { roomId })
      .orderBy('m.created_at', 'DESC')
      .limit(1)
      .getOne();

    if (!latestMsg) {
      // No messages yet — nothing to mark
      return;
    }

    // Monotonic advance: only update if latest message is newer than current last_read_at
    const shouldUpdate =
      participant.last_read_at === null ||
      latestMsg.created_at > participant.last_read_at;

    if (shouldUpdate) {
      await this.participantRepo.update(participant.id, {
        last_read_message_id: latestMsg.id,
        last_read_at: latestMsg.created_at,
      });
    }

    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'read',
      participant_id: userId,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Search messages within a workspace, scoped to rooms the user actively participates in.
   * Uses NFC normalization + LOWER LIKE for case-insensitive match (CHAT-15).
   * T-08-03-01/02: participant-scoped subquery; parameterized :pattern prevents injection.
   * T-08-03-03: LIMIT 20; minimum 2-char query enforced in controller.
   */
  async searchMessages(workspaceId: string, userId: string, query: string, limit = 20): Promise<any[]> {
    const normalized = query.normalize('NFC').toLowerCase();
    const pattern = `%${normalized}%`;

    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        'chat_room_participants',
        'p',
        "p.room_id = m.room_id AND p.participant_id = :userId AND p.participant_type = 'user' AND p.left_at IS NULL",
        { userId },
      )
      .where('m.workspace_id = :wsId', { wsId: workspaceId })
      .andWhere('LOWER(m.content) LIKE :pattern', { pattern })
      .orderBy('m.created_at', 'DESC')
      .limit(limit)
      .getMany();

    // Enrich with room names for display
    const roomIds = [...new Set(messages.map(m => m.room_id))];
    const rooms = roomIds.length
      ? await this.roomRepo.findByIds(roomIds)
      : [];
    const roomMap = new Map(rooms.map(r => [r.id, r]));

    return messages.map(m => ({
      message_id: m.id,
      room_id: m.room_id,
      room_name: roomMap.get(m.room_id)?.name || 'Direct Message',
      room_type: roomMap.get(m.room_id)?.type || 'dm',
      sender_id: m.sender_id,
      sender_type: m.sender_type,
      content: m.content,
      created_at: m.created_at,
    }));
  }

  // --- Private helpers (mention dispatch) ---

  /**
   * Parse @mention tokens from a user message and emit chat_request for each resolved agent.
   * CHAT-17: Supports direct agent name matches and role shortcuts (@reviewer/@assignee/@reporter).
   * CHAT-18: Only called for sender_type === 'user' to prevent agent-to-agent loops.
   * Returns the set of agent IDs dispatched (used by _handleDmAgentRequest to avoid duplicate dispatch).
   */
  private async _processMentions(
    roomId: string,
    workspaceId: string,
    senderId: string,
    content: string,
    savedMessage: ChatRoomMessage,
  ): Promise<Set<string>> {
    const dispatched = new Set<string>();
    const tokens = content.match(/@([\w-]+)/g) ?? [];
    for (const token of tokens) {
      const name = token.slice(1); // strip leading @
      const agent = await this._resolveAgentByMention(name, roomId, workspaceId);
      if (!agent) continue;

      activityEvents.emit('chat_request', {
        agent_id: agent.id,
        user_id: senderId,
        ticket_id: null, // will be resolved by event handler from room context if needed
        role_prompt: agent.role_prompt || '',
        new_message: content,
        history: [],
        timestamp: savedMessage.created_at.toISOString(),
        mention_depth: 1,
      });

      dispatched.add(agent.id);
      this.logService.info('ChatRooms', `@mention routed to agent ${agent.name} (${agent.id}) in room ${roomId}`);
    }
    return dispatched;
  }

  /**
   * Auto-dispatch to agent in DM rooms where the other participant is an agent.
   * Emits chat_request only if the agent was not already dispatched via @mention (dedup).
   * No-op for group rooms or user-to-user DMs.
   */
  private async _handleDmAgentRequest(
    roomId: string,
    workspaceId: string,
    senderId: string,
    content: string,
    savedMessage: ChatRoomMessage,
    alreadyDispatched: Set<string>,
  ): Promise<void> {
    // Look up the room to confirm it's a DM
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room || room.type !== 'dm') return;

    // Find the agent participant in this DM room
    const otherParticipant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_type: 'agent',
      },
    });
    if (!otherParticipant) return; // DM is user-to-user, not user-to-agent

    // Resolve the agent entity for role_prompt
    const agent = await this.agentRepo.findOne({ where: { id: otherParticipant.participant_id } });
    if (!agent) return;

    // Dedup: skip if @mention already dispatched to this agent
    if (alreadyDispatched.has(agent.id)) return;

    activityEvents.emit('chat_request', {
      agent_id: agent.id,
      user_id: senderId,
      ticket_id: null,
      role_prompt: agent.role_prompt || '',
      new_message: content,
      history: [],
      timestamp: savedMessage.created_at.toISOString(),
      mention_depth: 1,
    });

    this.logService.info('ChatRooms', `DM auto-routed to agent ${agent.name} (${agent.id}) in room ${roomId}`);
  }

  /**
   * Resolve an @mention name to an Agent entity.
   * Handles role shortcuts (@reviewer/@assignee/@reporter) via the linked ticket if present.
   */
  private async _resolveAgentByMention(
    name: string,
    roomId: string,
    workspaceId: string,
  ): Promise<Agent | null> {
    const ROLE_SHORTCUTS = ['reviewer', 'assignee', 'reporter'];
    const lower = name.toLowerCase();

    if (ROLE_SHORTCUTS.includes(lower)) {
      const agentId = await this._resolveRoleShortcut(lower, roomId);
      if (!agentId) return null;
      return this.agentRepo.findOne({ where: { id: agentId } });
    }

    // Case-insensitive name match scoped to workspace (compatible with SQLite and PostgreSQL)
    return this.agentRepo
      .createQueryBuilder('a')
      .where('LOWER(a.name) = LOWER(:name)', { name })
      .andWhere('a.workspace_id = :wsId', { wsId: workspaceId })
      .getOne();
  }

  /**
   * Resolve a role shortcut (@reviewer/@assignee/@reporter) to an agent ID
   * via the ticket linked to this room. Returns null if no ticket context.
   */
  private async _resolveRoleShortcut(shortcut: string, roomId: string): Promise<string | null> {
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room?.ticket_id) return null;

    const ticket = await this.ticketRepo.findOne({ where: { id: room.ticket_id } });
    if (!ticket) return null;

    const fieldMap: Record<string, keyof Ticket> = {
      reviewer: 'reviewer_id',
      assignee: 'assignee_id',
      reporter: 'reporter_id',
    };

    const field = fieldMap[shortcut];
    if (!field) return null;

    const agentId = ticket[field] as string;
    return agentId || null;
  }
}
