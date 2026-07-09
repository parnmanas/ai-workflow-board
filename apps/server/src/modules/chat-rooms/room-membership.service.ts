import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { activityEvents } from '../../services/activity.service';
import { resolveAgentDisplayName } from '../../utils/agent-name';

const PARTICIPANT_CAP = 50;

/**
 * RFC-4122 shape. A participant/sender id that isn't a uuid (the synthetic
 * 'system' author QA/Action dispatch uses) must never reach a uuid-typed
 * column lookup — see resolveParticipantName for the full rationale.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Owns participant (membership) state for chat rooms.
 *
 * Responsibilities:
 *  - add / remove (leave) participants
 *  - list active member ids (users / agents) for SSE filtering
 *  - shared membership helpers (`requireActiveParticipant`, name resolution, DB-dialect text coercion)
 *    used by the sibling CRUD and Messaging services so they don't duplicate participant lookups.
 *
 * Kept separate from message I/O (RoomMessagingService) and room CRUD (RoomCrudService / facade)
 * so the participant invariants (50-cap transaction, soft-delete via left_at) live in one place.
 */
@Injectable()
export class RoomMembershipService {
  constructor(
    @InjectRepository(ChatRoom)
    private readonly roomRepo: Repository<ChatRoom>,

    @InjectRepository(ChatRoomParticipant)
    private readonly participantRepo: Repository<ChatRoomParticipant>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,

    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Wraps a column reference with ::text on postgres to avoid varchar/uuid mismatch */
  toText(col: string): string {
    return this.dataSource.options.type === 'postgres' ? `${col}::text` : col;
  }

  /**
   * Agent Manager(type='manager')는 chat 참가자가 될 수 없다 (ticket 941c72d3) —
   * 절대 작업하지 않으므로 대화에도 끼지 않는다. 참가자 목록에서 manager agent 를
   * 조용히 제거한다(user 참가자·비-manager agent 는 그대로 통과). manager 가 없으면
   * 입력 배열을 그대로 반환(추가 질의 없음). RoomCrudService 도 이 헬퍼를 공유한다.
   */
  async filterOutManagerParticipants(
    participants: { participant_type: string; participant_id: string }[],
  ): Promise<{ participant_type: string; participant_id: string }[]> {
    const agentIds = [...new Set(
      participants.filter(p => p.participant_type === 'agent').map(p => p.participant_id).filter(Boolean),
    )];
    if (agentIds.length === 0) return participants;
    const managers = await this.agentRepo.find({ where: { id: In(agentIds), type: 'manager' }, select: ['id'] });
    if (managers.length === 0) return participants;
    const managerSet = new Set(managers.map(a => a.id));
    return participants.filter(p => !(p.participant_type === 'agent' && managerSet.has(p.participant_id)));
  }

  /**
   * Add participants to a group room (not DM). Respects 50-participant cap.
   * Re-joining a previously left user creates a new participant row.
   */
  async addParticipants(
    roomId: string,
    caller: { type: 'user' | 'agent'; id: string } | string,
    newParticipants: { participant_type: string; participant_id: string }[],
  ): Promise<void> {
    // Back-compat: existing controller call site passes a bare userId string;
    // the new MCP path passes a typed caller. Normalize here so both work.
    const c = typeof caller === 'string' ? { type: 'user' as const, id: caller } : caller;
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) {
      throw makeError(404, 'Room not found');
    }
    if (room.type === 'dm') {
      throw makeError(400, 'Cannot add participants to a direct message');
    }

    await this.requireActiveParticipant(roomId, c.id, c.type);

    // Manager(type='manager')는 chat 참가자가 될 수 없다 (ticket 941c72d3) — 조용히 제거.
    newParticipants = await this.filterOutManagerParticipants(newParticipants);

    // Wrap cap-check and insert in a transaction to prevent concurrent requests from
    // exceeding the participant cap (read-check-then-write race condition).
    await this.participantRepo.manager.transaction(async (em) => {
      const currentCount = await em
        .createQueryBuilder(ChatRoomParticipant, 'p')
        .where('p.room_id = :roomId', { roomId })
        .andWhere('p.left_at IS NULL')
        .getCount();

      if (currentCount + newParticipants.length > PARTICIPANT_CAP) {
        throw makeError(400, 'This room is full (50 participant limit).');
      }

      // B2 fix: initialize last_read_at to NOW() so existing room history isn't
      // flagged as unread to the newly added participant. They see the backlog
      // when they scroll, but the room doesn't shout at them with a large badge.
      const joinedAt = new Date();
      const rows = newParticipants.map(p =>
        em.create(ChatRoomParticipant, {
          room_id: roomId,
          participant_type: p.participant_type,
          participant_id: p.participant_id,
          last_read_at: joinedAt,
          left_at: null,
        }),
      );
      await em.save(rows);
    });

    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'participant_added',
      participant_ids: newParticipants.map(p => p.participant_id),
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Leave a room by soft-deleting the participant row (sets left_at).
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const participant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_id: userId,
        participant_type: 'user',
      },
    });

    if (!participant || participant.left_at !== null) {
      throw makeError(400, 'Not an active participant in this room');
    }

    await this.participantRepo.update(participant.id, { left_at: new Date() });

    // Get updated member IDs after the leave
    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'participant_left',
      participant_id: userId,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Helper: Returns a Set of active user participant IDs for a room.
   * Used to populate member_ids in SSE events for synchronous filtering.
   */
  async getRoomMemberIds(roomId: string): Promise<Set<string>> {
    const participants = await this.participantRepo
      .createQueryBuilder('p')
      .select('p.participant_id')
      .where('p.room_id = :roomId', { roomId })
      .andWhere("p.participant_type = 'user'")
      .andWhere('p.left_at IS NULL')
      .getMany();

    return new Set(participants.map(p => p.participant_id));
  }

  /**
   * Helper: Returns a Set of active agent participant IDs for a room.
   * Used to allow agent proxies to receive chat_room_message via SSE.
   */
  async getRoomAgentMemberIds(roomId: string): Promise<Set<string>> {
    const participants = await this.participantRepo
      .createQueryBuilder('p')
      .select('p.participant_id')
      .where('p.room_id = :roomId', { roomId })
      .andWhere("p.participant_type = 'agent'")
      .andWhere('p.left_at IS NULL')
      .getMany();

    return new Set(participants.map(p => p.participant_id));
  }

  /**
   * Shared helper: throw 403 unless (participantId, participantType) is an active
   * participant of roomId. Used by CRUD/Messaging siblings as well.
   */
  async requireActiveParticipant(
    roomId: string,
    participantId: string,
    participantType: string = 'user',
  ): Promise<void> {
    const participant = await this.participantRepo
      .createQueryBuilder('p')
      .where('p.room_id = :roomId', { roomId })
      .andWhere('p.participant_id = :participantId', { participantId })
      .andWhere('p.participant_type = :participantType', { participantType })
      .andWhere('p.left_at IS NULL')
      .getOne();

    if (!participant) {
      throw makeError(403, 'Not an active participant in this room');
    }
  }

  /**
   * Shared helper: resolve a (type, id) pair to a human-readable display name.
   * Returns 'Unknown User' / 'Unknown Agent' / 'Unknown' on miss (never throws).
   *
   * Synthetic non-uuid senders short-circuit BEFORE any DB lookup. QA-run and
   * scheduler-triggered Action dispatch author their first room message as the
   * literal `'system'` sender (see QaRunService.startQaRun / ActionsService.
   * dispatch). users.id / agents.id are uuid columns, so on Postgres the lookup
   * `WHERE id = 'system'` aborts the whole query with `invalid input syntax for
   * type uuid: "system"`. That doesn't just 500 a manual get_chat_room_messages
   * read — the agent-manager fetches a room's history (this same getMessages →
   * resolveParticipantName path, via GET /api/agent/chat-rooms/:id/messages)
   * BEFORE spawning a worker for a chat dispatch, so the throw made the dispatch
   * fall into its catch-and-drop branch and NO QA executor ever spawned. Guarding
   * the cast here fixes both the read and the silent no-spawn in one place, and
   * also covers every already-persisted 'system' row.
   */
  async resolveParticipantName(participantType: string, participantId: string): Promise<string> {
    if (!participantId || !UUID_RE.test(participantId)) {
      // 'system' is the known dispatch author; anything else non-uuid is a
      // malformed/legacy id — neither is a row in users/agents.
      return participantId === 'system' ? 'System' : 'Unknown';
    }
    if (participantType === 'user') {
      const user = await this.userRepo.findOne({ where: { id: participantId } });
      return user ? (user.name || user.email) : 'Unknown User';
    } else if (participantType === 'agent') {
      const display = await resolveAgentDisplayName(this.agentRepo, participantId);
      return display ?? 'Unknown Agent';
    }
    return 'Unknown';
  }
}
