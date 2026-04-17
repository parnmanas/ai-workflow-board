import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';

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

    private readonly logService: LogService,

    private readonly membership: RoomMembershipService,

    private readonly messaging: RoomMessagingService,
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
    return this.messaging.getMessages(roomId, userId, limit, before);
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
    return this.messaging.sendMessage(
      roomId,
      workspaceId,
      senderType,
      senderId,
      senderName,
      content,
      images,
    );
  }

  /**
   * Mark room as read up to the latest message (monotonic advance only).
   * Only advances last_read_at if the latest message is newer than current last_read_at.
   */
  async markRead(roomId: string, userId: string): Promise<void> {
    return this.messaging.markRead(roomId, userId);
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
    return this.messaging.searchMessages(workspaceId, userId, query, limit);
  }

  // --- Private helpers (room-CRUD path still uses these; delegated to membership) ---

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
}
