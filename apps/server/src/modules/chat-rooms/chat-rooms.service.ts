import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { RoomMembershipService } from './room-membership.service';

const CONTENT_MAX = 10000;
const PARTICIPANT_CAP = 50;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Facade for chat-room operations.
 *
 * Kept as the single entry point used by ChatRoomsController, AgentApiController, and
 * the rest of the app. Membership bookkeeping lives in RoomMembershipService; this class
 * delegates there (and will delegate to sibling Messaging/CRUD services in later commits)
 * while preserving the historical public API so callers don't need updating.
 */
@Injectable()
export class ChatRoomsService {
  constructor(
    @InjectRepository(ChatRoom)
    private readonly roomRepo: Repository<ChatRoom>,

    @InjectRepository(ChatRoomParticipant)
    private readonly participantRepo: Repository<ChatRoomParticipant>,

    @InjectRepository(ChatRoomMessage)
    private readonly messageRepo: Repository<ChatRoomMessage>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,

    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,

    private readonly logService: LogService,

    private readonly membership: RoomMembershipService,
  ) {}

  /** Wraps a column reference with ::text on postgres to avoid varchar/uuid mismatch */
  private toText(col: string): string {
    return this.membership.toText(col);
  }

  /**
   * List all rooms the current user actively participates in.
   * Returns rooms sorted by last_message_at DESC (COALESCE for SQLite safety).
   * Includes unread_count (datetime comparison, not UUID) and dm_partner_name for DMs.
   */
  async listRooms(workspaceId: string, userId: string): Promise<any[]> {
    const t = (col: string) => this.toText(col);
    // Join on active participant row for calling user
    const rawResult = await this.roomRepo
      .createQueryBuilder('r')
      .innerJoin(
        'chat_room_participants',
        'p',
        `${t('p.room_id')} = ${t('r.id')} AND p.participant_id = :userId AND p.participant_type = 'user' AND p.left_at IS NULL`,
        { userId },
      )
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      // Unread count: messages after last_read_at (datetime comparison per CHAT-12)
      .addSelect(
        `(SELECT COUNT(*) FROM chat_room_messages m WHERE ${t('m.room_id')} = ${t('r.id')} AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at))`,
        'unread_count',
      )
      .orderBy("COALESCE(r.last_message_at, '1970-01-01')", 'DESC')
      .getRawAndEntities();

    const rooms = rawResult.entities;
    const raws = rawResult.raw;

    const roomIds = rooms.map(r => r.id);

    // Batch-fetch DM partner rows (one query for all rooms instead of one per DM room)
    const dmPartnerRows = roomIds.length > 0
      ? await this.participantRepo
          .createQueryBuilder('p')
          .where('p.room_id IN (:...roomIds)', { roomIds })
          .andWhere('p.participant_id != :userId', { userId })
          .andWhere('p.left_at IS NULL')
          .getMany()
      : [];

    // Batch-fetch last messages (one query with ROW_NUMBER equivalent via subquery-free approach:
    // fetch all and pick max per room in memory — acceptable since rooms list is bounded)
    const lastMsgRows = roomIds.length > 0
      ? await this.messageRepo
          .createQueryBuilder('m')
          .where('m.room_id IN (:...roomIds)', { roomIds })
          .orderBy('m.created_at', 'DESC')
          .getMany()
      : [];

    // Build per-room maps from batch results
    const dmPartnerByRoom = new Map<string, ChatRoomParticipant>();
    for (const p of dmPartnerRows) {
      if (!dmPartnerByRoom.has(p.room_id)) {
        dmPartnerByRoom.set(p.room_id, p);
      }
    }
    const lastMsgByRoom = new Map<string, ChatRoomMessage>();
    for (const m of lastMsgRows) {
      if (!lastMsgByRoom.has(m.room_id)) {
        lastMsgByRoom.set(m.room_id, m);
      }
    }

    // Batch-resolve all participant names (users + agents) in two queries
    const participantIds = new Set<string>();
    for (const p of dmPartnerRows) participantIds.add(`${p.participant_type}:${p.participant_id}`);
    for (const m of lastMsgRows) {
      if (lastMsgByRoom.get(m.room_id) === m) {
        participantIds.add(`${m.sender_type}:${m.sender_id}`);
      }
    }
    const userIds = [...participantIds].filter(k => k.startsWith('user:')).map(k => k.slice(5));
    const agentIds = [...participantIds].filter(k => k.startsWith('agent:')).map(k => k.slice(6));
    const [usersById, agentsById] = await Promise.all([
      userIds.length > 0
        ? this.userRepo.findByIds(userIds).then(list => new Map(list.map(u => [u.id, u.name || u.email])))
        : Promise.resolve(new Map<string, string>()),
      agentIds.length > 0
        ? this.agentRepo.findByIds(agentIds).then(list => new Map(list.map(a => [a.id, a.name])))
        : Promise.resolve(new Map<string, string>()),
    ]);

    const resolveName = (type: string, id: string): string => {
      if (type === 'user') return usersById.get(id) ?? 'Unknown User';
      if (type === 'agent') return agentsById.get(id) ?? 'Unknown Agent';
      return 'Unknown';
    };

    const results = rooms.map((room, idx) => {
      const raw = raws[idx];
      const unreadCount = parseInt(raw['unread_count'] ?? '0', 10) || 0;

      let displayName: string;
      let dmPartnerName: string | null = null;

      if (room.type === 'dm') {
        const partner = dmPartnerByRoom.get(room.id);
        if (partner) {
          dmPartnerName = resolveName(partner.participant_type, partner.participant_id);
          displayName = dmPartnerName;
        } else {
          displayName = 'Direct Message';
        }
      } else {
        displayName = room.name;
      }

      let lastMessagePreview: string | null = null;
      const lastMsg = lastMsgByRoom.get(room.id);
      if (lastMsg) {
        const senderName = resolveName(lastMsg.sender_type, lastMsg.sender_id);
        const preview = `${senderName}: ${lastMsg.content}`;
        lastMessagePreview = preview.length > 80 ? preview.slice(0, 77) + '...' : preview;
      }

      return {
        id: room.id,
        workspace_id: room.workspace_id,
        type: room.type,
        name: displayName,
        dm_partner_name: dmPartnerName,
        last_message_at: room.last_message_at,
        last_message_preview: lastMessagePreview,
        unread_count: unreadCount,
        created_at: room.created_at,
        updated_at: room.updated_at,
      };
    });

    return results;
  }

  /**
   * Create a new chat room (DM or group). Handles DM dedup (CHAT-03).
   * Auto-determines type based on participant count: 2 = dm, 3+ = group.
   */
  async createRoom(
    workspaceId: string,
    creatorUserId: string,
    participantIds: { participant_type: string; participant_id: string }[],
    name?: string,
  ): Promise<{ room: any; existing: boolean }> {
    // Ensure creator is always included (deduplicate)
    const alreadyIncluded = participantIds.some(
      p => p.participant_type === 'user' && p.participant_id === creatorUserId,
    );
    if (!alreadyIncluded) {
      participantIds = [{ participant_type: 'user', participant_id: creatorUserId }, ...participantIds];
    }

    // Deduplicate participants list
    const seen = new Set<string>();
    const uniqueParticipants = participantIds.filter(p => {
      const key = `${p.participant_type}:${p.participant_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (uniqueParticipants.length < 2) {
      throw makeError(400, 'At least 2 participants required');
    }
    if (uniqueParticipants.length > PARTICIPANT_CAP) {
      throw makeError(400, 'This room is full (50 participant limit).');
    }

    const roomType = uniqueParticipants.length === 2 ? 'dm' : 'group';

    // DM dedup: if exactly 2 participants, check for existing active DM
    if (roomType === 'dm') {
      const t = (col: string) => this.toText(col);
      const [p1, p2] = uniqueParticipants;
      const existing = await this.roomRepo
        .createQueryBuilder('r')
        .innerJoin(
          'chat_room_participants',
          'pa',
          `${t('pa.room_id')} = ${t('r.id')} AND pa.participant_id = :id1 AND pa.left_at IS NULL`,
          { id1: p1.participant_id },
        )
        .innerJoin(
          'chat_room_participants',
          'pb',
          `${t('pb.room_id')} = ${t('r.id')} AND pb.participant_id = :id2 AND pb.left_at IS NULL`,
          { id2: p2.participant_id },
        )
        .where("r.type = 'dm'")
        .andWhere('r.workspace_id = :wsId', { wsId: workspaceId })
        .getOne();

      if (existing) {
        const detail = await this.getRoomDetail(existing.id, creatorUserId);
        return { room: detail, existing: true };
      }
    }

    // Determine group room name
    let roomName = '';
    if (roomType === 'group') {
      if (name && name.trim()) {
        roomName = name.trim();
      } else {
        // Build default name from first 3 participant names
        const names: string[] = [];
        for (const p of uniqueParticipants.slice(0, 3)) {
          const resolved = await this._resolveParticipantName(p.participant_type, p.participant_id);
          names.push(resolved);
        }
        if (uniqueParticipants.length > 3) {
          roomName = `${names.join(', ')} and ${uniqueParticipants.length - 3} more`;
        } else {
          roomName = names.join(', ');
        }
      }
    }

    // Save room
    const room = await this.roomRepo.save(
      this.roomRepo.create({
        workspace_id: workspaceId,
        type: roomType,
        name: roomName,
        last_message_at: null,
      }),
    );

    // Bulk-save participants
    const participantRows = uniqueParticipants.map(p =>
      this.participantRepo.create({
        room_id: room.id,
        participant_type: p.participant_type,
        participant_id: p.participant_id,
        last_read_message_id: null,
        last_read_at: null,
        left_at: null,
      }),
    );
    await this.participantRepo.save(participantRows);

    this.logService.info('ChatRooms', `Created ${roomType} room ${room.id} in workspace ${workspaceId}`);

    const detail = await this.getRoomDetail(room.id, creatorUserId);
    return { room: detail, existing: false };
  }

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
    await this._requireActiveParticipant(roomId, userId);

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
          senderName = await this._resolveParticipantName(msg.sender_type, msg.sender_id);
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
    await this._requireActiveParticipant(roomId, senderId, senderType);

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
    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);

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

    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'read',
      participant_id: userId,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Rename a group room (DM rooms cannot be renamed — returns 400).
   */
  async renameRoom(roomId: string, userId: string, newName: string): Promise<void> {
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) {
      throw makeError(404, 'Room not found');
    }
    if (room.type === 'dm') {
      throw makeError(400, 'Cannot rename a direct message');
    }

    await this._requireActiveParticipant(roomId, userId);

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw makeError(400, 'Room name must be 1-100 characters');
    }

    await this.roomRepo.update(roomId, { name: trimmedName });

    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'renamed',
      new_name: trimmedName,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Add participants to a group room (not DM). Respects 50-participant cap.
   * Re-joining a previously left user creates a new participant row.
   */
  async addParticipants(
    roomId: string,
    userId: string,
    newParticipants: { participant_type: string; participant_id: string }[],
  ): Promise<void> {
    return this.membership.addParticipants(roomId, userId, newParticipants);
  }

  /**
   * Leave a room by soft-deleting the participant row (sets left_at).
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    return this.membership.leaveRoom(roomId, userId);
  }

  /**
   * Helper: Returns a Set of active user participant IDs for a room.
   * Used to populate member_ids in SSE events for synchronous filtering.
   */
  async getRoomMemberIds(roomId: string): Promise<Set<string>> {
    return this.membership.getRoomMemberIds(roomId);
  }

  /**
   * Helper: Returns a Set of active agent participant IDs for a room.
   * Used to allow agent proxies to receive chat_room_message via SSE.
   */
  async getRoomAgentMemberIds(roomId: string): Promise<Set<string>> {
    return this.membership.getRoomAgentMemberIds(roomId);
  }

  /**
   * Get room detail with participant list (names resolved).
   * Verifies userId is an active participant.
   */
  async getRoomDetail(roomId: string, userId: string): Promise<any> {
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) {
      throw makeError(404, 'Room not found');
    }

    const participants = await this.participantRepo
      .createQueryBuilder('p')
      .where('p.room_id = :roomId', { roomId })
      .andWhere('p.left_at IS NULL')
      .getMany();

    const resolvedParticipants = await Promise.all(
      participants.map(async p => ({
        id: p.id,
        participant_type: p.participant_type,
        participant_id: p.participant_id,
        name: await this._resolveParticipantName(p.participant_type, p.participant_id),
        last_read_at: p.last_read_at,
        joined_at: p.joined_at,
      })),
    );

    let displayName = room.name;
    let dmPartnerName: string | null = null;

    if (room.type === 'dm') {
      const partner = participants.find(p => p.participant_id !== userId);
      if (partner) {
        const partnerName = await this._resolveParticipantName(
          partner.participant_type,
          partner.participant_id,
        );
        dmPartnerName = partnerName;
        displayName = partnerName;
      }
    }

    return {
      id: room.id,
      workspace_id: room.workspace_id,
      type: room.type,
      name: displayName,
      dm_partner_name: dmPartnerName,
      last_message_at: room.last_message_at,
      created_at: room.created_at,
      updated_at: room.updated_at,
      participants: resolvedParticipants,
    };
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

  // --- Private helpers ---

  private async _resolveParticipantName(participantType: string, participantId: string): Promise<string> {
    return this.membership.resolveParticipantName(participantType, participantId);
  }

  private async _requireActiveParticipant(
    roomId: string,
    participantId: string,
    participantType: string = 'user',
  ): Promise<void> {
    return this.membership.requireActiveParticipant(roomId, participantId, participantType);
  }

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
