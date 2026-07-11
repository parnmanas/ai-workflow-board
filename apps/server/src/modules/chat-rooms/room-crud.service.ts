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
import { resolveAgentDisplayMap } from '../../utils/agent-name';

const PARTICIPANT_CAP = 50;

/**
 * RFC-4122 shape guard (same pattern as room-membership.service). A non-uuid
 * participant/sender id — notably the synthetic 'system' author QA/Action
 * dispatch seeds as a room participant (qa-run.service.ts / actions.service.ts)
 * — must never reach a uuid-typed column lookup (users.id / agents.id). See
 * listAllWorkspaceRooms for the Postgres crash this prevents.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Owns room-level lifecycle: list / create / detail / rename.
 *
 * Same-member DM rooms are intentionally NOT deduplicated — users want to keep
 * separate threads per topic (feature discussion / on-call / casual) with the
 * same person. DM is a participant-count label only (2 = dm, 3+ = group), not
 * a uniqueness key.
 *
 * Participant bookkeeping (adds, leaves, member lookups, name resolution) is
 * delegated to RoomMembershipService so the 50-cap transaction and the
 * active-participant 403 invariant live in one place.
 */
@Injectable()
export class RoomCrudService {
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
  ) {}

  /**
   * List all rooms the current user actively participates in.
   * Returns rooms sorted by last_message_at DESC (COALESCE for SQLite safety).
   * Includes unread_count (datetime comparison, not UUID) and dm_partner_name for DMs.
   */
  async listRooms(workspaceId: string, userId: string): Promise<any[]> {
    const t = (col: string) => this.membership.toText(col);
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
      // Action-Run rooms (action_id IS NOT NULL) are surfaced inside the
      // Actions detail view, not the global chat list — hiding them here
      // keeps the chat sidebar from filling up with one row per Run as the
      // FIFO ring grows.
      .andWhere('r.action_id IS NULL')
      // Unread count: messages after last_read_at (datetime comparison per CHAT-12).
      // Progress rows are agent-manager tool-call heartbeats — the user
      // sees them live but they shouldn't pump the unread badge, which is
      // reserved for messages the user actually needs to act on.
      //
      // cleared_at branch (ticket 1ae77f55): messages older than the user's
      // per-room Clear cutoff don't count toward unread either, so wiping a
      // chat takes the badge to zero immediately and keeps it there until a
      // genuinely new message arrives.
      .addSelect(
        `(SELECT COUNT(*) FROM chat_room_messages m WHERE ${t('m.room_id')} = ${t('r.id')} AND m.type <> 'progress' AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at) AND (p.cleared_at IS NULL OR m.created_at > p.cleared_at))`,
        'unread_count',
      )
      // Surface the caller's cleared_at into the raw projection so the
      // last_message_preview pick below can skip messages older than the cut.
      .addSelect('p.cleared_at', 'cleared_at')
      .orderBy("COALESCE(r.last_message_at, '1970-01-01')", 'DESC')
      .getRawAndEntities();

    const rooms = rawResult.entities;
    const raws = rawResult.raw;

    const roomIds = rooms.map(r => r.id);

    // Batch-fetch ALL active participant rows once. Two consumers downstream:
    //   1. DM partner-name resolution (filter to !== userId per room)
    //   2. Group member-name projection (filter to participant_type='user'|'agent')
    // Doing one query saves a round-trip when both group + DM rooms coexist.
    const allParticipantRows = roomIds.length > 0
      ? await this.participantRepo
          .createQueryBuilder('p')
          .where('p.room_id IN (:...roomIds)', { roomIds })
          .andWhere('p.left_at IS NULL')
          .getMany()
      : [];
    const dmPartnerRows = allParticipantRows.filter(p => p.participant_id !== userId);

    // Batch-fetch last messages (one query with ROW_NUMBER equivalent via subquery-free approach:
    // fetch all and pick max per room in memory — acceptable since rooms list is bounded).
    // Skip progress rows: the preview line in the sidebar should mirror what a
    // human would call "the last thing said", and a tool-call narration is
    // not useful as a room-level summary.
    const lastMsgRows = roomIds.length > 0
      ? await this.messageRepo
          .createQueryBuilder('m')
          .where('m.room_id IN (:...roomIds)', { roomIds })
          .andWhere("m.type <> 'progress'")
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

    // Batch-resolve all participant names (users + agents) in two queries.
    // Includes every active participant — not just DM partners — so the
    // light-weight `participants` projection below can carry display names
    // for group-member filtering on the client.
    const participantIds = new Set<string>();
    for (const p of allParticipantRows) participantIds.add(`${p.participant_type}:${p.participant_id}`);
    for (const m of lastMsgRows) {
      if (lastMsgByRoom.get(m.room_id) === m) {
        participantIds.add(`${m.sender_type}:${m.sender_id}`);
      }
    }
    // Guard the uuid columns before the bulk lookup: participant_id / sender_id
    // are plain varchar that can hold the synthetic 'system' author QA/Action
    // dispatch seeds as a room participant (qa-run.service.ts:229-235). users.id
    // / agents.id are uuid, so feeding 'system' to findByIds aborts the WHOLE
    // query on Postgres with `invalid input syntax for type uuid: "system"` — the
    // same 500 the observer view hit (see listAllWorkspaceRooms). SQLite doesn't
    // type-check so dev never saw it. My rooms is latent today (a QA room's only
    // user participant is 'system', which the caller can't be), but filter
    // defensively — synthetic ids resolve by name in resolveName() below.
    const userIds = [...participantIds].filter(k => k.startsWith('user:')).map(k => k.slice(5)).filter(id => UUID_RE.test(id));
    const agentIds = [...participantIds].filter(k => k.startsWith('agent:')).map(k => k.slice(6)).filter(id => UUID_RE.test(id));
    const [usersById, agentsById] = await Promise.all([
      userIds.length > 0
        ? this.userRepo.findByIds(userIds).then(list => new Map(list.map(u => [u.id, u.name || u.email])))
        : Promise.resolve(new Map<string, string>()),
      agentIds.length > 0
        ? this.agentRepo.findByIds(agentIds).then(list => resolveAgentDisplayMap(this.agentRepo, list))
        : Promise.resolve(new Map<string, string>()),
    ]);

    const resolveName = (type: string, id: string): string => {
      // Non-uuid ids never made it into the maps above (filtered out) — resolve
      // the known synthetic 'system' author by convention (mirrors nameOf in
      // listAllWorkspaceRooms) so My rooms shows "System" not "Unknown".
      if (!id || !UUID_RE.test(id)) return id === 'system' ? 'System' : 'Unknown';
      if (type === 'user') return usersById.get(id) ?? 'Unknown User';
      if (type === 'agent') return agentsById.get(id) ?? 'Unknown Agent';
      return 'Unknown';
    };

    // Group active participants by room for the projection.
    const participantsByRoom = new Map<string, ChatRoomParticipant[]>();
    for (const p of allParticipantRows) {
      const arr = participantsByRoom.get(p.room_id) || [];
      arr.push(p);
      participantsByRoom.set(p.room_id, arr);
    }

    // Per-room map of cleared_at for the calling user (one row per room from
    // the inner join). Used both to decide whether the cached lastMsgRows
    // pick survives the cut and to short-circuit the unread badge.
    const clearedAtByRoom = new Map<string, Date | null>();
    for (let i = 0; i < rooms.length; i++) {
      const raw = raws[i];
      const v = raw['cleared_at'];
      clearedAtByRoom.set(rooms[i].id, v ? new Date(v) : null);
    }

    const results = rooms.map((room, idx) => {
      const raw = raws[idx];
      const unreadCount = parseInt(raw['unread_count'] ?? '0', 10) || 0;

      // DM partner snapshot for the client-side fallback when the room has no
      // custom name. We expose it separately from `name` so the client can
      // pick `name || dm_partner_name || 'Direct Message'` in order — that
      // way a renamed DM keeps its custom title without losing the partner's
      // identity (rendered as a subtitle / tooltip if the UI wants).
      let dmPartnerName: string | null = null;
      if (room.type === 'dm') {
        const partner = dmPartnerByRoom.get(room.id);
        if (partner) dmPartnerName = resolveName(partner.participant_type, partner.participant_id);
      }

      // Hide preview text when the cached "last message" predates the user's
      // own Clear cutoff. We don't refetch a different lastMsg from the
      // backlog — Clear is meant to wipe the visible history for this viewer,
      // so an older message surfacing as the preview would defeat the point.
      let lastMessagePreview: string | null = null;
      const lastMsg = lastMsgByRoom.get(room.id);
      const clearedAt = clearedAtByRoom.get(room.id) || null;
      if (lastMsg && (!clearedAt || lastMsg.created_at > clearedAt)) {
        const senderName = resolveName(lastMsg.sender_type, lastMsg.sender_id);
        const preview = `${senderName}: ${lastMsg.content}`;
        lastMessagePreview = preview.length > 80 ? preview.slice(0, 77) + '...' : preview;
      }

      // Light projection used by the room-list filter input — just
      // (type, id, name) per active participant. Distinct from
      // `getRoomDetail` which also carries last_read_at / joined_at.
      const participantProjection = (participantsByRoom.get(room.id) || []).map(p => ({
        participant_type: p.participant_type,
        participant_id: p.participant_id,
        name: resolveName(p.participant_type, p.participant_id),
      }));

      return {
        id: room.id,
        workspace_id: room.workspace_id,
        type: room.type,
        // Raw room.name (possibly empty for un-renamed DMs). Client picks
        // displayName via `name || dm_partner_name || 'Direct Message'`.
        name: room.name || '',
        dm_partner_name: dmPartnerName,
        last_message_at: room.last_message_at,
        last_message_preview: lastMessagePreview,
        unread_count: unreadCount,
        participants: participantProjection,
        created_at: room.created_at,
        updated_at: room.updated_at,
      };
    });

    return results;
  }

  /**
   * Create a new chat room (DM or group).
   * Auto-determines type based on participant count: 2 = dm, 3+ = group.
   * Always creates a fresh room — same-member DMs are NOT deduped so users
   * can keep multiple topic-separated threads with the same person.
   */
  async createRoom(
    workspaceId: string,
    creator: { type: 'user' | 'agent'; id: string },
    participantIds: { participant_type: string; participant_id: string }[],
    name?: string,
  ): Promise<{ room: any; existing: boolean }> {
    // Ensure creator is always included (deduplicate). v0.32: creator can be
    // an agent (MCP create_chat_room path) — previously we hardcoded 'user'.
    const alreadyIncluded = participantIds.some(
      p => p.participant_type === creator.type && p.participant_id === creator.id,
    );
    if (!alreadyIncluded) {
      participantIds = [{ participant_type: creator.type, participant_id: creator.id }, ...participantIds];
    }

    // Deduplicate participants list
    const seen = new Set<string>();
    let uniqueParticipants = participantIds.filter(p => {
      const key = `${p.participant_type}:${p.participant_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Manager(type='manager')는 chat 참가자가 될 수 없다 (ticket 941c72d3). 걸러낸 뒤
    // 남은 인원으로 방을 만든다 — manager 만 상대로 지정하면 아래 최소-2명 가드가 거른다.
    uniqueParticipants = await this.membership.filterOutManagerParticipants(uniqueParticipants);

    if (uniqueParticipants.length < 2) {
      throw makeError(400, 'At least 2 participants required');
    }
    if (uniqueParticipants.length > PARTICIPANT_CAP) {
      throw makeError(400, 'This room is full (50 participant limit).');
    }

    const roomType = uniqueParticipants.length === 2 ? 'dm' : 'group';

    // Determine room name. DMs may carry a name now (renamable + topic-tagged
    // multi-rooms with the same partner); when the caller doesn't supply one
    // we leave it empty and the read path falls back to the partner's name.
    let roomName = '';
    if (name && name.trim()) {
      roomName = name.trim();
    } else if (roomType === 'group') {
      // Auto-generated default for groups so the list isn't full of "(unnamed)".
      const names: string[] = [];
      for (const p of uniqueParticipants.slice(0, 3)) {
        const resolved = await this.membership.resolveParticipantName(p.participant_type, p.participant_id);
        names.push(resolved);
      }
      if (uniqueParticipants.length > 3) {
        roomName = `${names.join(', ')} and ${uniqueParticipants.length - 3} more`;
      } else {
        roomName = names.join(', ');
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

    // B2 fix: initialize last_read_at to NOW(). A new room has no backlog
    // relevant to a joiner — starting them at zero unread avoids a confusing
    // badge on first entry. Any message sent between this insert and the
    // first page load is caught via SSE/REST refresh.
    const joinedAt = new Date();
    const participantRows = uniqueParticipants.map(p =>
      this.participantRepo.create({
        room_id: room.id,
        participant_type: p.participant_type,
        participant_id: p.participant_id,
        last_read_at: joinedAt,
        left_at: null,
      }),
    );
    await this.participantRepo.save(participantRows);

    this.logService.info('ChatRooms', `Created ${roomType} room ${room.id} in workspace ${workspaceId}`);

    const viewerUserId = creator.type === 'user' ? creator.id : '';
    const detail = await this.getRoomDetail(room.id, viewerUserId);
    return { room: detail, existing: false };
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
        name: await this.membership.resolveParticipantName(p.participant_type, p.participant_id),
        last_read_at: p.last_read_at,
        joined_at: p.joined_at,
      })),
    );

    // Surface the partner's display name separately for DMs so the client
    // can fall back to it when the room has no custom name yet. Same
    // contract as listRooms — `name` is the raw room.name (possibly empty).
    let dmPartnerName: string | null = null;
    if (room.type === 'dm') {
      const partner = participants.find(p => p.participant_id !== userId);
      if (partner) {
        dmPartnerName = await this.membership.resolveParticipantName(
          partner.participant_type,
          partner.participant_id,
        );
      }
    }

    return {
      id: room.id,
      workspace_id: room.workspace_id,
      type: room.type,
      name: room.name || '',
      dm_partner_name: dmPartnerName,
      last_message_at: room.last_message_at,
      created_at: room.created_at,
      updated_at: room.updated_at,
      participants: resolvedParticipants,
    };
  }

  /**
   * Rename any room (DM or group). DMs may be renamed now that same-member
   * DM dedup is gone — users keeping multiple topic-tagged threads with the
   * same person rely on naming to tell them apart.
   */
  async renameRoom(roomId: string, actorId: string, newName: string, actorType: string = 'user'): Promise<void> {
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) {
      throw makeError(404, 'Room not found');
    }

    // actorType lets an agent (set_chat_room_name MCP tool) rename a room it
    // participates in; the REST endpoint still passes the default 'user'.
    await this.membership.requireActiveParticipant(roomId, actorId, actorType);

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw makeError(400, 'Room name must be 1-100 characters');
    }

    await this.roomRepo.update(roomId, { name: trimmedName });

    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'renamed',
      new_name: trimmedName,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Workspace-wide observer view: every active room regardless of caller's
   * membership. Used by the chat page's "All workspace rooms" toggle so a
   * human can monitor agent-to-agent conversations they aren't a participant
   * in. Does not compute per-user unread counts (caller may not be a member).
   */
  async listAllWorkspaceRooms(workspaceId: string): Promise<any[]> {
    // Same action_id IS NULL filter as listRooms — observer view also wants to
    // skip Action-Run rooms because they belong to the Actions surface.
    const rooms = await this.roomRepo.createQueryBuilder('r')
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      .andWhere('r.action_id IS NULL')
      .orderBy('r.last_message_at', 'DESC')
      .getMany();
    if (rooms.length === 0) return [];
    const roomIds = rooms.map(r => r.id);
    const participantRows = await this.participantRepo
      .createQueryBuilder('p')
      .where('p.room_id IN (:...roomIds)', { roomIds })
      .andWhere('p.left_at IS NULL')
      .getMany();
    const lastMsgRows = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.room_id IN (:...roomIds)', { roomIds })
      .orderBy('m.created_at', 'DESC')
      .getMany();
    const lastByRoom = new Map<string, ChatRoomMessage>();
    for (const m of lastMsgRows) if (!lastByRoom.has(m.room_id)) lastByRoom.set(m.room_id, m);
    const partsByRoom = new Map<string, ChatRoomParticipant[]>();
    for (const p of participantRows) {
      const arr = partsByRoom.get(p.room_id) || [];
      arr.push(p);
      partsByRoom.set(p.room_id, arr);
    }
    // Bulk-resolve participant names. Guard the uuid columns: participant_id is
    // a plain varchar that can legitimately hold the synthetic 'system' author
    // QA-run dispatch seeds as a room participant (qa-run.service.ts:229-235).
    // users.id / agents.id are uuid, so feeding 'system' to findByIds aborts the
    // WHOLE observer query on Postgres with `invalid input syntax for type uuid:
    // "system"` — a 500 that surfaces as "Could not load chats". SQLite doesn't
    // type-check, so it silently matched nothing and masked the bug. Filter to
    // well-formed uuids before the bulk lookup; synthetic ids are resolved by
    // name in nameOf() below. Mirrors resolveParticipantName's single-lookup
    // UUID_RE guard in room-membership.service.
    const userIds = [...new Set(participantRows.filter(p => p.participant_type === 'user').map(p => p.participant_id))].filter(id => UUID_RE.test(id));
    const agentIds = [...new Set(participantRows.filter(p => p.participant_type === 'agent').map(p => p.participant_id))].filter(id => UUID_RE.test(id));
    const [usersById, agentsById] = await Promise.all([
      userIds.length > 0 ? this.userRepo.findByIds(userIds).then(list => new Map(list.map(u => [u.id, u.name || u.email]))) : Promise.resolve(new Map<string, string>()),
      agentIds.length > 0 ? this.agentRepo.findByIds(agentIds).then(list => resolveAgentDisplayMap(this.agentRepo, list)) : Promise.resolve(new Map<string, string>()),
    ]);
    const nameOf = (type: string, id: string): string => {
      // Non-uuid ids never made it into the maps above (filtered out) — resolve
      // the known synthetic 'system' author by convention, same as
      // resolveParticipantName, so the observer view shows "System" not "Unknown".
      if (!id || !UUID_RE.test(id)) return id === 'system' ? 'System' : 'Unknown';
      if (type === 'user') return usersById.get(id) || 'Unknown User';
      if (type === 'agent') return agentsById.get(id) || 'Unknown Agent';
      return 'Unknown';
    };
    return rooms.map((r) => {
      const parts = (partsByRoom.get(r.id) || []).map(p => ({
        type: p.participant_type,
        id: p.participant_id,
        name: nameOf(p.participant_type, p.participant_id),
      }));
      const last = lastByRoom.get(r.id);
      return {
        id: r.id,
        type: r.type,
        name: r.name || (parts.map(p => p.name).join(', ') || '(unnamed)'),
        last_message_at: r.last_message_at,
        participants: parts,
        last_message: last
          ? {
              content: last.content,
              sender_name: nameOf(last.sender_type, last.sender_id),
              created_at: last.created_at,
            }
          : null,
      };
    });
  }
}
