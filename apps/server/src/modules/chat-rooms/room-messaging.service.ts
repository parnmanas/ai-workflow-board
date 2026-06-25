import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { UserMention } from '../../entities/UserMention';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { MentionService, ResolvedMention } from '../../services/mention.service';
import { RoomMembershipService } from './room-membership.service';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { projectChatAttachment } from '../mcp/shared/ticket-helpers';

const CONTENT_MAX = 10000;

// Look-back window for agent-chain depth derivation. Bounded so the query
// stays cheap even on very busy rooms; large enough to expose any realistic
// loop because the plugin caps long before this many turns.
const AGENT_CHAIN_LOOKBACK = 8;

// Whitelisted message-type discriminators accepted from external callers
// (REST / MCP). 'system' is intentionally excluded — only the in-process
// sendSystemMessage path may stamp that value.
export const CHAT_MESSAGE_TYPES = ['message', 'progress'] as const;
export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];

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

    @InjectRepository(UserMention)
    private readonly userMentionRepo: Repository<UserMention>,

    @InjectRepository(TicketAttachment)
    private readonly attachmentRepo: Repository<TicketAttachment>,

    private readonly logService: LogService,

    private readonly membership: RoomMembershipService,

    private readonly mentionService: MentionService,
  ) {}

  /**
   * Paginated message history for a room (cursor-based with `before` message ID).
   * Caller must be an active participant (left_at IS NULL) — else 403.
   *
   * `options.excludeProgress` filters out type='progress' rows. The agent-api
   * GET endpoint sets this so chat history replayed into a spawned CLI never
   * includes the manager's own tool-call heartbeats (which would teach the
   * model to talk about its tools instead of using them).
   */
  async getMessages(
    roomId: string,
    userId: string,
    limit: number,
    before?: string,
    options?: { observer?: boolean; excludeProgress?: boolean },
  ): Promise<any[]> {
    // v0.32: observer mode skips the active-participant gate so admins can
    // read agent-to-agent rooms they're not a member of (workspace-wide chat
    // monitoring). Caller (controller) must enforce its own permission check
    // before passing observer=true; this service trusts that flag.
    let clearedAt: Date | null = null;
    if (!options?.observer) {
      await this.membership.requireActiveParticipant(roomId, userId);
      // Per-viewer Clear cutoff (ticket 1ae77f55). When set, drop messages
      // older than the cut so the user sees a fresh thread until new
      // messages arrive. Observer mode bypasses (admins monitoring a room
      // they're not in have no participant row of their own to honour).
      const participant = await this.participantRepo.findOne({
        where: { room_id: roomId, participant_id: userId, participant_type: 'user', left_at: IsNull() },
      });
      clearedAt = participant?.cleared_at ?? null;
    }

    const cappedLimit = Math.min(limit, 200);

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.room_id = :roomId', { roomId })
      .orderBy('m.created_at', 'DESC')
      .limit(cappedLimit);

    if (clearedAt) {
      qb.andWhere('m.created_at > :clearedAt', { clearedAt });
    }

    if (options?.excludeProgress) {
      qb.andWhere("m.type <> 'progress'");
    }

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
    const attachmentsByMessage = await this._loadAttachmentsForMessages(messages.map(m => m.id));

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
          type: msg.type || 'message',
          content: msg.content,
          attachments: attachmentsByMessage.get(msg.id) || [],
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
    attachmentIds?: string[],
    type: ChatMessageType = 'message',
  ): Promise<any> {
    await this.membership.requireActiveParticipant(roomId, senderId, senderType);

    if (!CHAT_MESSAGE_TYPES.includes(type)) {
      throw makeError(400, `Invalid message type: ${type}`);
    }

    if (content != null && typeof content !== 'string') {
      throw makeError(400, 'content must be a string');
    }
    const trimmed = (content ?? '').trim();
    if (trimmed.length > CONTENT_MAX) {
      throw makeError(400, `Message exceeds ${CONTENT_MAX} character limit`);
    }

    const resolvedAttachmentIds = Array.isArray(attachmentIds)
      ? attachmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    // Attachment-only messages (screenshot / file share without a caption) are
    // a first-class workflow for chat — persist empty content in that case
    // rather than forcing a placeholder. Only reject when there's no content
    // AND no attachment to carry, which would be a truly empty send.
    if (!trimmed && resolvedAttachmentIds.length === 0) {
      throw makeError(400, 'content or attachment_ids required');
    }
    const attachmentRows = await this._validatePendingAttachments(
      roomId,
      workspaceId,
      senderType,
      senderId,
      resolvedAttachmentIds,
    );

    // Canonicalize agent senders to `<Manager>/<Agent>` so the SSE event +
    // return value match what getMessages() already returns for history.
    // Without this the caller decides the rendered name and the MCP path
    // (`agent.name`) ends up shorter than the agent-api path (which already
    // resolves the prefix), so the same agent's live messages flicker between
    // bare and prefixed names. Centralizing here keeps every entry point
    // (REST, agent-api ack, MCP send_chat_room_message, Actions) consistent.
    if (senderType === 'agent') {
      const display = await resolveAgentDisplayName(this.agentRepo, senderId);
      if (display) senderName = display;
    }

    // CAS-style transactional claim: save the message and bind the
    // attachments inside one transaction. The UPDATE re-asserts the
    // pending state (`owner_type='chat_room' AND owner_id=:roomId`) so
    // two concurrent sends with the same attachment_ids can never both
    // win — the first one flips the rows to 'chat_message', the second
    // one sees `affected < ids.length` and rolls back. Without this
    // CAS guard the validate→save→update sequence was lossy: both
    // senders could pass validation, both save messages, then last
    // update wins and the first sender's POST/SSE response references
    // attachment rows whose persisted owner_id points at the OTHER
    // message — review finding P1 on ticket 92082b55.
    const { savedMsg, attachments } = await this.messageRepo.manager.transaction(async (em) => {
      const messageRepoTx = em.getRepository(ChatRoomMessage);
      const attachmentRepoTx = em.getRepository(TicketAttachment);

      const created = await messageRepoTx.save(
        messageRepoTx.create({
          room_id: roomId,
          workspace_id: workspaceId,
          sender_type: senderType,
          sender_id: senderId,
          type,
          content: trimmed,
          images: images && images.length > 0 ? JSON.stringify(images) : '[]',
        }),
      );

      let projected: any[] = [];
      if (attachmentRows.length > 0) {
        const ids = attachmentRows.map(r => r.id);
        const result = await attachmentRepoTx
          .createQueryBuilder()
          .update()
          .set({ owner_type: 'chat_message', owner_id: created.id })
          .where('id IN (:...ids)', { ids })
          .andWhere('owner_type = :pendingType', { pendingType: 'chat_room' })
          .andWhere('owner_id = :roomId', { roomId })
          .execute();
        if ((result.affected ?? 0) !== ids.length) {
          // Another concurrent send claimed at least one of these
          // attachments first. Roll back the message save and surface
          // 409 so the caller knows the attachment_ids are no longer
          // pending — they should refresh the room state and retry.
          throw makeError(409, 'attachment_ids were claimed by another concurrent send');
        }
        const rows = await attachmentRepoTx.find({ where: { id: In(ids) } });
        const byId = new Map(rows.map(r => [r.id, r]));
        // Preserve the caller's attachment_ids[] order — multi-file
        // uploads share a millisecond timestamp, so created_at ASC
        // would scramble them. attachmentRows is already in
        // attachment_ids[] order from _validatePendingAttachments.
        projected = ids
          .map(id => byId.get(id))
          .filter((r): r is TicketAttachment => !!r)
          .map(r => projectChatAttachment(r, { includeData: false }));
      }

      return { savedMsg: created, attachments: projected };
    });

    // Progress messages are ephemeral tool-call heartbeats; they update
    // last_message_at so the room list sort reflects activity but skip
    // mention parsing, DM dispatch, chain-depth accounting, and the
    // sender's read-marker auto-advance — none of those apply to a
    // narration row that the agent itself shouldn't see in history.
    const isRealMessage = type === 'message';

    // Update denormalized last_message_at for room list sort
    await this.roomRepo.update(roomId, { last_message_at: new Date() });

    // CHAT-18: only parse mentions from user messages — prevents agent-to-agent loops
    if (isRealMessage && senderType === 'user') {
      const dispatched = await this._processMentions(roomId, workspaceId, senderId, senderName, trimmed, savedMsg);
      await this._handleDmAgentRequest(roomId, workspaceId, senderId, trimmed, savedMsg, dispatched);
    }

    // Get active member IDs for SSE filtering (CRITICAL Pitfall 1)
    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);

    // Trailing consecutive agent-sender count in this room INCLUDING the
    // just-saved message. Plugin uses it to short-circuit dispatch once
    // agents have been talking to each other for too many turns. Always
    // computed (cheap query) so the field is consistent on every emit.
    // Progress rows are excluded from the lookback inside _computeAgentChainDepth
    // so a chatty tool-narration burst never inflates the chain.
    const agentChainDepth = await this._computeAgentChainDepth(roomId);

    // Room title for auto-naming: the agent-manager injects a "generate a
    // title" instruction into the first chat-subagent turn only when this is
    // empty, so an untitled room gets named from its opening conversation.
    const roomForName = await this.roomRepo.findOne({ where: { id: roomId } });

    activityEvents.emit('chat_room_message', {
      room_id: roomId,
      room_name: roomForName?.name ?? '',
      workspace_id: workspaceId,
      message_id: savedMsg.id,
      sender_type: senderType,
      sender_id: senderId,
      sender_name: senderName,
      type,
      content: trimmed,
      images: savedMsg.images,
      attachments,
      created_at: savedMsg.created_at.toISOString(),
      agent_chain_depth: agentChainDepth,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });

    // B1 fix: auto-advance the sender's read marker so their own message never
    // counts toward their unread. Fired AFTER chat_room_message to guarantee
    // correct client state ordering — any client that increments unread on
    // chat_room_message then resets it via chat_room_update 'read'.
    //
    // Silently tolerate failures: the message is already saved + broadcast;
    // an unadvanced read marker is recoverable on the next explicit markRead.
    // Skip for progress: those don't bump unread on other participants either
    // (the client filters them out of the unread count), so the sender's marker
    // doesn't need to advance on a row no one will ever count.
    if (isRealMessage) {
      try {
        await this.markRead(roomId, senderId, senderType);
      } catch (err: any) {
        this.logService.warn(
          'ChatRooms',
          `Auto-markRead failed for sender ${senderType}:${senderId} in room ${roomId}: ${err?.message || err}`,
        );
      }
    }

    return {
      id: savedMsg.id,
      room_id: savedMsg.room_id,
      workspace_id: savedMsg.workspace_id,
      sender_type: savedMsg.sender_type,
      sender_id: savedMsg.sender_id,
      sender_name: senderName,
      type: savedMsg.type || 'message',
      content: savedMsg.content,
      images: savedMsg.images,
      attachments,
      created_at: savedMsg.created_at,
      updated_at: savedMsg.updated_at,
    };
  }

  /**
   * Send a SYSTEM message to a room — synthetic source (no User / Agent
   * row behind it), used by in-process detectors and supervisors that
   * need to surface state to a chat room WITHOUT impersonating a user
   * and WITHOUT routing through the MCP send_chat_room_message tool.
   *
   * Why this exists (ticket 8e934802 — Stale-WAIT detector):
   *   `StuckTicketDetectorService` posts an alert whenever a ticket
   *   newly crosses the stale-WAIT threshold. Going through the normal
   *   `sendMessage` path would require manufacturing a fake participant
   *   row (the participant gate would 403 otherwise) and the mention /
   *   DM-agent dispatch helpers would fire on a system-authored
   *   message — wrong. This bypass writes the row, updates
   *   last_message_at for the sort, and emits the same SSE event so
   *   connected clients render the alert exactly like a normal message.
   *
   * Skips by design:
   *   - active-participant gate (system has no participant row)
   *   - mention / DM-agent dispatch (system never triggers subagents)
   *   - markRead auto-advance (no participant to advance)
   *
   * `sender_id` is fixed at 'system' so a UI can render a distinctive
   * badge without joining against User/Agent. Caller supplies the
   * markdown content; length cap matches user-sent messages.
   */
  async sendSystemMessage(roomId: string, workspaceId: string, content: string): Promise<any> {
    if (!content || typeof content !== 'string') {
      throw makeError(400, 'content is required');
    }
    const trimmed = content.trim();
    if (!trimmed) throw makeError(400, 'content cannot be empty');
    if (trimmed.length > CONTENT_MAX) {
      throw makeError(400, `Message exceeds ${CONTENT_MAX} character limit`);
    }

    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) throw makeError(404, 'Room not found');

    const savedMsg = await this.messageRepo.save(
      this.messageRepo.create({
        room_id: roomId,
        workspace_id: workspaceId || room.workspace_id || '',
        sender_type: 'system',
        sender_id: 'system',
        content: trimmed,
        images: '[]',
      }),
    );

    await this.roomRepo.update(roomId, { last_message_at: new Date() });

    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);

    activityEvents.emit('chat_room_message', {
      room_id: roomId,
      workspace_id: savedMsg.workspace_id,
      message_id: savedMsg.id,
      sender_type: 'system',
      sender_id: 'system',
      sender_name: 'System',
      // System alerts are first-class history (stale-WAIT detector etc.):
      // keep the default 'message' type so agents replaying history still
      // see them — they're user-visible signals the model should condition on.
      type: savedMsg.type || 'message',
      content: trimmed,
      images: savedMsg.images,
      attachments: [],
      created_at: savedMsg.created_at.toISOString(),
      // Synthetic source: no agent chain involvement, so the plugin's
      // chain-depth short-circuit never sees this message.
      agent_chain_depth: 0,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });

    this.logService.info('ChatRooms', `system message posted to room ${roomId}`, {
      room_id: roomId, workspace_id: savedMsg.workspace_id, message_id: savedMsg.id,
    });

    return {
      id: savedMsg.id,
      room_id: savedMsg.room_id,
      workspace_id: savedMsg.workspace_id,
      sender_type: 'system',
      sender_id: 'system',
      sender_name: 'System',
      type: savedMsg.type || 'message',
      content: savedMsg.content,
      images: savedMsg.images,
      attachments: [],
      created_at: savedMsg.created_at,
      updated_at: savedMsg.updated_at,
    };
  }

  /**
   * Mark room as read up to the latest message (monotonic advance only).
   * Only advances last_read_at if the latest message is newer than current last_read_at.
   *
   * `participantType` defaults to 'user' for backward compat with the REST
   * endpoint; the message-send path passes 'agent' when the sender is an agent
   * so an agent's own messages don't count toward its unread (B1).
   */
  async markRead(roomId: string, participantId: string, participantType: string = 'user'): Promise<void> {
    // CRITICAL: scope to active row only. addParticipants() / re-join flows can
    // leave stale rows with left_at != null in place; findOne without this
    // filter may return the stale row, hit the !== null guard below, and
    // silently 403 — leaving unread_count stuck forever on the room list.
    const participant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_id: participantId,
        participant_type: participantType,
        left_at: IsNull(),
      },
    });

    if (!participant) {
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

    // CRITICAL: copy the message's DB-stored created_at via a SQL subquery so
    // we preserve full precision. PostgreSQL TIMESTAMP is microsecond-precise;
    // JavaScript Date is millisecond-only. If we serialize the fetched JS
    // Date (from latestMsg.created_at) back through TypeORM as the new
    // last_read_at value, the driver truncates sub-millisecond precision.
    // The stored last_read_at then ends up strictly less than the source
    // message's actual DB value, and the unread subquery
    //   COUNT(*) WHERE m.created_at > p.last_read_at
    // keeps counting that same message forever — regardless of how many
    // times markRead runs. This was the long-standing "badge stuck at 1" bug.
    //
    // The WHERE guard keeps the update monotonic: only advance if the new
    // message's stored value is strictly greater than the current marker.
    const result = await this.participantRepo
      .createQueryBuilder()
      .update()
      .set({
        last_read_at: () => '(SELECT created_at FROM chat_room_messages WHERE id = :msgId)',
      })
      .where('id = :pid', { pid: participant.id })
      .andWhere(
        '(last_read_at IS NULL OR last_read_at < (SELECT created_at FROM chat_room_messages WHERE id = :msgId))',
      )
      .setParameter('msgId', latestMsg.id)
      .execute();

    const didAdvance = (result.affected ?? 0) > 0;

    // The effective read marker after this call, whether we advanced or not.
    // Multi-tab sync (B3) needs this so a client can match against its local
    // unread_count even when another tab's markRead beat us to it. The ISO
    // string we emit only has millisecond resolution; that's fine for the
    // client's unread=0 reconciliation, which doesn't re-run the DB query.
    const effectiveReadAt = didAdvance ? latestMsg.created_at : participant.last_read_at!;

    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'read',
      participant_id: participantId,
      participant_type: participantType,
      last_read_at: effectiveReadAt.toISOString(),
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Per-viewer "Clear conversation" (ticket 1ae77f55) — sets the calling
   * user's cleared_at on the participant row to NOW(). After this:
   *   - getMessages filters out anything older than the cut.
   *   - listRooms' unread_count + last_message_preview honour the same cut.
   *   - Other participants are unaffected (no rows deleted).
   *
   * No SSE event is emitted: the effect is strictly per-user, so peers don't
   * need to know. (A future enhancement could broadcast a 'cleared'
   * chat_room_update on member_ids = {userId} so the same user's other tabs
   * sync immediately, but the in-room markRead path already keeps badges
   * coherent across tabs after the next visible activity.)
   */
  async clearRoomForUser(roomId: string, userId: string): Promise<{ cleared_at: string }> {
    const participant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_id: userId,
        participant_type: 'user',
        left_at: IsNull(),
      },
    });
    if (!participant) {
      throw makeError(403, 'Not an active participant in this room');
    }
    const now = new Date();
    await this.participantRepo.update(participant.id, { cleared_at: now });
    this.logService.info('ChatRooms', `User ${userId} cleared room ${roomId}`);
    return { cleared_at: now.toISOString() };
  }

  /**
   * Search messages within a workspace, scoped to rooms the caller actively participates in.
   * Uses NFC normalization + LOWER LIKE for case-insensitive match (CHAT-15).
   * T-08-03-01/02: participant-scoped subquery; parameterized :pattern prevents injection.
   * T-08-03-03: LIMIT 20; minimum 2-char query enforced in controller.
   *
   * `participantType` defaults to 'user' for the REST endpoint. The MCP
   * search_chat_messages tool passes 'agent' so the participant-scoping
   * subquery matches the calling agent's room memberships instead of a
   * user's — without it an agent caller's id never joins (rows are keyed
   * participant_type='user') and the search silently returns nothing.
   */
  async searchMessages(
    workspaceId: string,
    callerId: string,
    query: string,
    limit = 20,
    participantType: string = 'user',
  ): Promise<any[]> {
    const normalized = query.normalize('NFC').toLowerCase();
    const pattern = `%${normalized}%`;

    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        'chat_room_participants',
        'p',
        'p.room_id = m.room_id AND p.participant_id = :callerId AND p.participant_type = :participantType AND p.left_at IS NULL',
        { callerId, participantType },
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

  /**
   * Length of the strictly-alternating agent-sender chain ending at the
   * latest message. Each consecutive same-sender repeat is consolidated into
   * one chain "step", so a single agent talking to itself never inflates the
   * counter — only genuine back-and-forth between *different* agents does.
   *
   * Examples (latest first):
   *   user                             → 0     (chain broken by user)
   *   agentA                           → 1     (first agent turn)
   *   agentA, agentA, agentA           → 1     (same agent retrying — not a loop)
   *   agentA, agentB                   → 2     (one round-trip)
   *   agentA, agentB, agentA           → 3     (B replied to A, then A replied)
   *   agentA, agentA, agentB, agentA   → 3     (initial duplicates collapse)
   *
   * Plugin proxy reads this field on chat_room_message and skips delegation
   * once depth ≥ AGENT_CHAIN_DEPTH_CAP (3) so an A↔B reply chain auto-terminates.
   * Lookback stays small because the plugin breaks the chain long before this
   * many alternations can stack up.
   */
  private async _computeAgentChainDepth(roomId: string): Promise<number> {
    const recent = await this.messageRepo
      .createQueryBuilder('m')
      .select(['m.sender_type', 'm.sender_id'])
      .where('m.room_id = :roomId', { roomId })
      // Progress rows are agent-authored heartbeats — a burst of tool calls
      // would otherwise look like one agent talking to itself and inflate
      // the chain depth past the plugin cap, causing the next real reply
      // to be dropped as "loop detected".
      .andWhere("m.type <> 'progress'")
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(AGENT_CHAIN_LOOKBACK)
      .getMany();

    let depth = 0;
    let prevSenderId: string | null = null;
    for (const m of recent) {
      if (m.sender_type !== 'agent') break;
      // Same agent in a row: still part of the same chain step.
      if (m.sender_id !== prevSenderId) {
        depth++;
        prevSenderId = m.sender_id;
      }
    }
    return depth;
  }

  private async _loadAttachmentsForMessages(messageIds: string[]): Promise<Map<string, any[]>> {
    const ids = messageIds.filter(Boolean);
    const out = new Map<string, any[]>();
    if (ids.length === 0) return out;

    // (created_at, id) ordering — best-effort. Within a single multi-file upload
    // all rows share a millisecond and the PK is a random UUID, so the id tiebreak
    // does NOT reconstruct upload order for same-ms rows. The send RESPONSE returns
    // attachments in attachment_ids[] order (see _persistMessage), which is what
    // clients render live; history replay carries no per-message ordering column,
    // so consumers that care about exact order should match by id, not position.
    const rows = await this.attachmentRepo.find({
      where: { owner_type: 'chat_message', owner_id: In(ids) },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    for (const row of rows) {
      const list = out.get(row.owner_id) || [];
      list.push(projectChatAttachment(row, { includeData: false }));
      out.set(row.owner_id, list);
    }
    return out;
  }

  private async _validatePendingAttachments(
    roomId: string,
    workspaceId: string,
    senderType: string,
    senderId: string,
    attachmentIds: string[],
  ): Promise<TicketAttachment[]> {
    if (attachmentIds.length === 0) return [];
    if (attachmentIds.length > 20) throw makeError(400, 'Maximum 20 attachments per message');

    const rows = await this.attachmentRepo.find({ where: { id: In(attachmentIds) } });
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const id of attachmentIds) {
      const row = byId.get(id);
      if (!row) throw makeError(400, `attachment_ids contains unknown id: ${id}`);
      // Pre-send rows have owner_type='chat_room', owner_id=room_id.
      // owner_type='chat_message' means the row already belongs to another
      // sent message (or a stale orphan) and cannot be re-attached.
      if (row.owner_type !== 'chat_room' || row.owner_id !== roomId) {
        throw makeError(400, `attachment ${id} is already attached`);
      }
      if (row.room_id !== roomId) throw makeError(400, `attachment ${id} belongs to a different room`);
      if (row.workspace_id !== workspaceId) throw makeError(400, `attachment ${id} belongs to a different workspace`);
      if (row.uploaded_by_type !== senderType || row.uploaded_by_id !== senderId) {
        throw makeError(403, `attachment ${id} was uploaded by a different sender`);
      }
    }
    return attachmentIds.map(id => byId.get(id)!).filter(Boolean);
  }

  // --- Private helpers (mention dispatch) ---

  /**
   * Parse structured @[type:id|name] tokens from a user message, dispatch
   * agent mentions as chat_request events, and persist user mentions for the
   * sidebar unread badge.
   *
   * CHAT-18: Only called for sender_type === 'user' to prevent agent-to-agent loops.
   * Returns the set of agent IDs dispatched so _handleDmAgentRequest can avoid
   * duplicate dispatch in DM rooms.
   */
  private async _processMentions(
    roomId: string,
    workspaceId: string,
    senderId: string,
    senderName: string,
    content: string,
    savedMessage: ChatRoomMessage,
  ): Promise<Set<string>> {
    const dispatched = new Set<string>();
    const refs = this.mentionService.parseMentions(content);
    if (refs.length === 0) return dispatched;

    // Role shortcuts resolve against the ticket linked to this room (if any).
    let ticket: Ticket | null = null;
    if (refs.some(r => r.type === 'role')) {
      const room = await this.roomRepo.findOne({ where: { id: roomId } });
      if (room?.ticket_id) {
        ticket = await this.ticketRepo.findOne({ where: { id: room.ticket_id } });
      }
    }

    const resolved: ResolvedMention[] = await this.mentionService.resolveMentions(refs, ticket);
    if (resolved.length === 0) return dispatched;

    const preview = (content || '').slice(0, 500);
    const ts = savedMessage.created_at.toISOString();

    for (const m of resolved) {
      if (m.type === 'agent') {
        const agent = await this.agentRepo.findOne({ where: { id: m.id } });
        if (!agent) continue;
        // Workspace-scope safety: never cross-post a mention into the wrong workspace.
        if (agent.workspace_id && agent.workspace_id !== workspaceId) continue;

        activityEvents.emit('chat_request', {
          agent_id: agent.id,
          user_id: senderId,
          ticket_id: ticket?.id ?? null,
          role_prompt: agent.role_prompt || '',
          new_message: content,
          history: [],
          timestamp: ts,
          mention_depth: 1,
          // Source room — required for the agent to know where to reply
          // via mcp__awb__send_chat_room_message. Without it the
          // agent-manager's persistent-chat-session path is skipped and
          // the legacy fallback prompt asks the agent to "use the
          // room_id from the chat request context" with no such field.
          room_id: roomId,
        });

        dispatched.add(agent.id);
        this.logService.info(
          'ChatRooms',
          `@mention routed to agent ${agent.name} (${agent.id}) in room ${roomId}`,
        );
      } else {
        // User mention — persist + emit user_mention for sidebar badge sync.
        const row = await this.userMentionRepo.save(this.userMentionRepo.create({
          user_id: m.id,
          workspace_id: workspaceId,
          source_type: 'chat_message',
          source_id: savedMessage.id,
          ticket_id: ticket?.id ?? null,
          room_id: roomId,
          actor_id: senderId,
          actor_type: 'user',
          actor_name: senderName,
          preview,
        }));

        activityEvents.emit('user_mention', {
          mention_id: row.id,
          user_id: row.user_id,
          workspace_id: row.workspace_id,
          source_type: 'chat_message',
          source_id: savedMessage.id,
          ticket_id: ticket?.id ?? null,
          // Chat mentions deep-link to /ws/<wsId>/chat?room=<id>&message=<id>;
          // board_id is intentionally null even when the room is bound to a
          // ticket so the inbox doesn't try to resolve a board route.
          board_id: null,
          room_id: roomId,
          actor_id: senderId,
          actor_type: 'user',
          actor_name: senderName,
          preview,
          created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
        });
        this.logService.info('ChatRooms', `User @-mention recorded: user ${row.user_id} in room ${roomId}`);
      }
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

    // Find the agent participant in this DM room (active row only — a stale
    // left_at-set row would otherwise mis-route to an agent who already left).
    const otherParticipant = await this.participantRepo.findOne({
      where: {
        room_id: roomId,
        participant_type: 'agent',
        left_at: IsNull(),
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
      // See _processMentions — required for room-aware reply routing.
      room_id: roomId,
    });

    this.logService.info('ChatRooms', `DM auto-routed to agent ${agent.name} (${agent.id}) in room ${roomId}`);
  }

}
