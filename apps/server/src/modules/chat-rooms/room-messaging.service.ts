import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, IsNull, In, DataSource } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../entities/ChatRoomMessage';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { UserMention } from '../../entities/UserMention';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { AgentConnectivityRegistry } from '../../services/agent-connectivity.registry';
import { AGENT_AUTOSTART_REQUESTED, AutostartRequestEvent } from '../../common/agent-autostart-events';
import { MentionService, ResolvedMention } from '../../services/mention.service';
import { RoomMembershipService } from './room-membership.service';
import { resolveAgentDisplayName, resolveAgentDisplayMap } from '../../utils/agent-name';
import { projectChatAttachment } from '../mcp/shared/ticket-helpers';
import { RunProvision, resolveWorkspaceFolder } from '../../common/workspace-folder-options';
import { ChatRoomMessageMetadata, ChatMessageTicketRef, ChatMessageArtifactRef, ChatMessageAgentRef, ChatMessageBoardRef, ChatMessageTicketAction } from '../../common/types/stream-events';
import { computeChainDepth } from '../../common/agent-chain-depth';
import { ArtifactRefsService } from '../artifact-refs/artifact-refs.service';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { CliRuntimeProfile } from '../../common/cli-runtime-profiles';
import { resolveClaudeBackendProfileForDispatch } from '../../common/claude-backend-registry';
import { requiredManagerCapability, evaluateManagerCapability, checkManagerCapabilityForDispatch } from '../../common/manager-capability-gate';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';

const CONTENT_MAX = 10000;

// Raised ceiling for in-process server-issued run dispatch (QA / security run
// prompts). These are machine-rendered from a scenario/profile the workspace
// controls, not a human typing into a box, and can legitimately exceed the
// interactive CONTENT_MAX (observed: a 10,257-char QA prompt 400-blocked at the
// 10k cliff — ticket acd24e5d). Still bounded (not unlimited) so a pathological
// scenario prompt can't be a memory/DB DoS. Reachable ONLY via sendMessage's
// internal opts.bypassContentLimit, which no REST / MCP / agent-api caller sets
// (they all stop at positional args before `opts`) — so user/agent senders stay
// held to CONTENT_MAX.
const SYSTEM_DISPATCH_CONTENT_MAX = 100000;

// Look-back window for agent-chain depth derivation. Bounded so the query
// stays cheap even on very busy rooms; large enough to expose any realistic
// loop because the plugin caps long before this many turns.
const AGENT_CHAIN_LOOKBACK = 8;

// Whitelisted message-type discriminators accepted from external callers
// (REST / MCP). 'system' is intentionally excluded — only the in-process
// sendSystemMessage path may stamp that value.
export const CHAT_MESSAGE_TYPES = ['message', 'progress', 'ticket_action'] as const;
export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// F-1 (ticket 24694916): bound + shape-check the structured metadata an agent
// (via agent-api) attaches to a chat message before it is persisted / broadcast.
// Only well-formed refs survive; everything else is dropped so a caller can't
// stuff arbitrary / unbounded JSON onto the row or the SSE wire.
// F2-4 (ticket d21b28fc): `ticket_refs` 와 `artifact_refs` 를 독립적으로 정제한다 —
// 한쪽만 있어도(예: 빌드 결과물만) metadata 는 유지되고, 둘 다 없을 때만 null.
const MAX_TICKET_REFS = 20;
const MAX_ARTIFACT_REFS = 20;
// F-3 (ticket 3ca88253): agent/board refs share the same string bound. Capped lower
// than ticket/artifact refs — a turn realistically surfaces at most a handful of
// agent-status or board-summary cards, never a batch-mutation-sized burst.
const MAX_AGENT_REFS = 10;
const MAX_BOARD_REFS = 10;
const TICKET_REF_STR_MAX = 300;

export function sanitizeTicketRefs(refsRaw: unknown): ChatMessageTicketRef[] {
  if (!Array.isArray(refsRaw)) return [];
  const refs: ChatMessageTicketRef[] = [];
  const seen = new Set<string>();
  for (const r of refsRaw) {
    if (refs.length >= MAX_TICKET_REFS) break;
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const ticketId = typeof rec.ticket_id === 'string' ? rec.ticket_id.slice(0, TICKET_REF_STR_MAX) : '';
    if (!ticketId) continue; // a ref with no ticket to point at is useless
    const ref: ChatMessageTicketRef = {
      action: typeof rec.action === 'string' ? rec.action.slice(0, TICKET_REF_STR_MAX) : '',
      ticket_id: ticketId,
    };
    const dedupeKey = `${ticketId}\u0000${ref.action}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (typeof rec.title === 'string' && rec.title) ref.title = rec.title.slice(0, TICKET_REF_STR_MAX);
    // F2-4 ⓑ: propose/consensus 카드의 대상 컬럼 등 부가 맥락(있으면 보존).
    if (typeof rec.detail === 'string' && rec.detail) ref.detail = rec.detail.slice(0, TICKET_REF_STR_MAX);
    refs.push(ref);
  }
  return refs;
}

// F2-4 ⓒ: 빌드/배포 결과물 ref 정제. `kind`+`title` 은 필수(없으면 카드가 무의미),
// status/commit/url 은 있으면 보존. ticket_refs 와 동일한 문자열 상한을 공유한다.
function sanitizeArtifactRefs(refsRaw: unknown): ChatMessageArtifactRef[] {
  if (!Array.isArray(refsRaw)) return [];
  const refs: ChatMessageArtifactRef[] = [];
  for (const r of refsRaw) {
    if (refs.length >= MAX_ARTIFACT_REFS) break;
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const kind = typeof rec.kind === 'string' ? rec.kind.slice(0, TICKET_REF_STR_MAX) : '';
    const title = typeof rec.title === 'string' ? rec.title.slice(0, TICKET_REF_STR_MAX) : '';
    if (!kind || !title) continue; // 종류/라벨 없는 ref 는 렌더 불가
    const ref: ChatMessageArtifactRef = { kind, title };
    if (typeof rec.status === 'string' && rec.status) ref.status = rec.status.slice(0, TICKET_REF_STR_MAX);
    if (typeof rec.commit === 'string' && rec.commit) ref.commit = rec.commit.slice(0, TICKET_REF_STR_MAX);
    if (typeof rec.url === 'string' && rec.url) ref.url = rec.url.slice(0, TICKET_REF_STR_MAX);
    refs.push(ref);
  }
  return refs;
}

// F-3 (ticket 3ca88253): agent ref 정제. `agent_id` 는 필수(없으면 카드가 무의미),
// `name` 은 있으면 클릭 전 표시용 라벨로 보존(상세는 클릭 시 다시 fetch).
function sanitizeAgentRefs(refsRaw: unknown): ChatMessageAgentRef[] {
  if (!Array.isArray(refsRaw)) return [];
  const refs: ChatMessageAgentRef[] = [];
  for (const r of refsRaw) {
    if (refs.length >= MAX_AGENT_REFS) break;
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const agentId = typeof rec.agent_id === 'string' ? rec.agent_id.slice(0, TICKET_REF_STR_MAX) : '';
    if (!agentId) continue;
    const ref: ChatMessageAgentRef = { agent_id: agentId };
    if (typeof rec.name === 'string' && rec.name) ref.name = rec.name.slice(0, TICKET_REF_STR_MAX);
    refs.push(ref);
  }
  return refs;
}

// F-3 (ticket 3ca88253): board ref 정제. `board_id` 는 필수, `title` 은 있으면 보존.
function sanitizeBoardRefs(refsRaw: unknown): ChatMessageBoardRef[] {
  if (!Array.isArray(refsRaw)) return [];
  const refs: ChatMessageBoardRef[] = [];
  for (const r of refsRaw) {
    if (refs.length >= MAX_BOARD_REFS) break;
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const boardId = typeof rec.board_id === 'string' ? rec.board_id.slice(0, TICKET_REF_STR_MAX) : '';
    if (!boardId) continue;
    const ref: ChatMessageBoardRef = { board_id: boardId };
    if (typeof rec.title === 'string' && rec.title) ref.title = rec.title.slice(0, TICKET_REF_STR_MAX);
    refs.push(ref);
  }
  return refs;
}

function sanitizeTicketAction(raw: unknown): ChatMessageTicketAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.kind !== 'unpend') return undefined;
  const ticketId = typeof rec.ticket_id === 'string' ? rec.ticket_id.slice(0, TICKET_REF_STR_MAX) : '';
  const title = typeof rec.title === 'string' ? rec.title.slice(0, TICKET_REF_STR_MAX) : '';
  if (!ticketId || !title) return undefined;
  return { kind: 'unpend', ticket_id: ticketId, title };
}

function sanitizeChatMessageMetadata(raw: unknown): ChatRoomMessageMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const ticketRefs = sanitizeTicketRefs((raw as { ticket_refs?: unknown }).ticket_refs);
  const artifactRefs = sanitizeArtifactRefs((raw as { artifact_refs?: unknown }).artifact_refs);
  const agentRefs = sanitizeAgentRefs((raw as { agent_refs?: unknown }).agent_refs);
  const boardRefs = sanitizeBoardRefs((raw as { board_refs?: unknown }).board_refs);
  const ticketAction = sanitizeTicketAction((raw as { ticket_action?: unknown }).ticket_action);
  if (ticketRefs.length === 0 && artifactRefs.length === 0 && agentRefs.length === 0 && boardRefs.length === 0 && !ticketAction) return null;
  const meta: ChatRoomMessageMetadata = {};
  if (ticketRefs.length > 0) meta.ticket_refs = ticketRefs;
  if (artifactRefs.length > 0) meta.artifact_refs = artifactRefs;
  if (agentRefs.length > 0) meta.agent_refs = agentRefs;
  if (boardRefs.length > 0) meta.board_refs = boardRefs;
  if (ticketAction) meta.ticket_action = ticketAction;
  return meta;
}

// Parse a persisted metadata text column back into the wire object shape,
// re-running the sanitizer so a hand-tampered row can never widen the contract.
function parseChatMessageMetadata(raw: unknown): ChatRoomMessageMetadata | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return sanitizeChatMessageMetadata(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
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

    @InjectRepository(Workspace)
    private readonly workspaceRepo: Repository<Workspace>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    private readonly logService: LogService,

    private readonly membership: RoomMembershipService,

    private readonly mentionService: MentionService,

    // Live SSE reachability (ticket bfdd80b7) — the accurate pre-filter for
    // "is this chat target actually reachable?" (global service).
    private readonly connectivity: AgentConnectivityRegistry,
    private readonly artifactRefs?: ArtifactRefsService,
    // ticket c3b767c6 — dispatch-capability gate. @Global() (see
    // instance-registry.module.ts) so ChatRoomsModule needs no new import
    // edge onto AgentManagerModule to reach it. Optional + defensively
    // guarded in _checkManagerCapability() below so hand-constructed test
    // doubles that omit it (bypassing Nest's container entirely) keep working
    // unchanged — a missing registry degrades to "no live telemetry", which
    // evaluateManagerCapability() already treats as fail-open.
    private readonly instanceRegistry?: InstanceRegistryService,
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
          metadata: parseChatMessageMetadata(msg.metadata),
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
    // QA/security run-dispatch provisioning hint (ticket 25db3cc6). Present ONLY
    // on the system 'user' send that opens a QA/security run room — the
    // agent-manager reads it to prepare the run's working folder before spawning.
    // Forwarded verbatim on the chat_room_message SSE event; never persisted.
    //
    // `bypassContentLimit` (ticket acd24e5d): raise the content ceiling to
    // SYSTEM_DISPATCH_CONTENT_MAX for this send. Set ONLY by in-process server
    // dispatch (QA / security run prompts) — never plumbed through the REST / MCP
    // / agent-api send paths, so an external caller can't lift their own limit.
    // `metadata` (ticket 24694916): structured ticket-action refs the agent-manager
    // captured from mcp__awb__* tool results. Sanitized + bounded before persist so
    // an external caller can't stuff arbitrary JSON onto the row / SSE wire.
    opts?: {
      runProvision?: RunProvision | null;
      bypassContentLimit?: boolean;
      metadata?: ChatRoomMessageMetadata | null;
      /** Internal commit boundary hook; never exposed by REST/MCP payloads. */
      onPersisted?: (messageId: string) => void;
    },
  ): Promise<any> {
    await this.membership.requireActiveParticipant(roomId, senderId, senderType);

    const sanitizedMeta = sanitizeChatMessageMetadata(opts?.metadata);

    if (!CHAT_MESSAGE_TYPES.includes(type)) {
      throw makeError(400, `Invalid message type: ${type}`);
    }

    if (content != null && typeof content !== 'string') {
      throw makeError(400, 'content must be a string');
    }
    const normalizedContent = this.artifactRefs
      ? await this.artifactRefs.normalizeStoredOutput(workspaceId, content ?? '')
      : content ?? '';
    const trimmed = normalizedContent.trim();
    // Server dispatch (opts.bypassContentLimit) is machine-rendered and may run
    // past the interactive cap; everyone else stays held to CONTENT_MAX.
    const effectiveMax = opts?.bypassContentLimit ? SYSTEM_DISPATCH_CONTENT_MAX : CONTENT_MAX;
    if (trimmed.length > effectiveMax) {
      throw makeError(400, `Message exceeds ${effectiveMax} character limit`);
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
          metadata: sanitizedMeta ? JSON.stringify(sanitizedMeta) : null,
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
    // Everything below is post-commit enrichment / dispatch. Let integrated
    // callers distinguish a durable message from a transaction failure so a
    // retry cannot bind the same pending artifact to a second row.
    opts?.onPersisted?.(savedMsg.id);

    // Progress messages are ephemeral tool-call heartbeats; they update
    // last_message_at so the room list sort reflects activity but skip
    // mention parsing, DM dispatch, chain-depth accounting, and the
    // sender's read-marker auto-advance — none of those apply to a
    // narration row that the agent itself shouldn't see in history.
    const isRealMessage = type !== 'progress';

    // Update denormalized last_message_at for room list sort
    await this.roomRepo.update(roomId, { last_message_at: new Date() });

    // 방 메타데이터: agent-manager는 이름이 비어 있을 때만 첫 chat-subagent
    // 턴에 "제목을 생성하라"는 지시를 주입하고(그래서 이름 없는 방은 첫
    // 대화 내용으로 이름이 붙는다), action_id를 읽어 Action Run을 일반
    // 채팅과 구분한다(티켓 e6d32e9d).
    const roomForName = await this.roomRepo.findOne({ where: { id: roomId } });

    // 티켓 9fd27487 — 일반 채팅방에는 애초에 run_provision이 전혀 없어서,
    // agent-manager가 이들을 working_dir 루트에서 디스패치했다(티켓
    // 41e69c91이 티켓에 대해 고쳤던 것과 같은 반스프롤(sprawl) 버그).
    // Action/QA/security 디스패처는 이미 자체적으로 `opts.runProvision`을
    // 명시적으로 넘기고 있고, 이 코드는 그 나머지 전부(일반 사용자 채팅 /
    // DM / @멘션)를 위한 FALLBACK이다 — 모든 전송 경로(REST, MCP,
    // agent-api)가 이미 통과하는 단일 병목 지점인 여기서 계산해두므로,
    // 호출자가 각자 사본을 들고 있을 필요가 없다. 티켓의 단계적 롤아웃
    // 권고에 따라 opt-in Workspace 플래그(기본값 OFF)로 게이팅한다: manager
    // 에이전트 자신의 운영용 채팅도 이 경로를 함께 타기 때문에, 폴더 고정
    // (pinning) 동작 변경을 모든 워크스페이스에 조용히 강제해서는 안 된다.
    // Action Run / Orchestration Mission / QA / security 방은 제외한다 —
    // 이미 자체 runProvision을 갖고 있거나(Action/QA/security, 방을 여는
    // 첫 전송에서만) 의도적으로 아예 없다(Mission step은 대신 티켓
    // 워크트리를 쓴다). QA/security 디스패치가 자신의 전송에서는 항상
    // opts.runProvision을 넘기더라도 run_kind 체크는 여전히 중요하다: 같은
    // 방에서 나중에 오는 메시지(예: QA 에이전트가 send_chat_room_message로
    // 올리는 런 도중 상태 업데이트)는 자체 opts.runProvision이 없고, 이
    // 제외 처리가 없으면 런의 실제 `.awb/qa/<scenario>` 체크아웃이 아니라
    // 무관한 `.awb/chat/<room>` 폴더를 가리키는 엉뚱한 kind:'chat'
    // provision으로 흘러 들어가 버린다(리뷰 후속 조치). progress 하트비트는
    // 아래 조회 대상에서 제외된다(위 chain-depth 스킵과 같은 이유): 새로운
    // 디스패치 턴을 여는 일이 절대 없다 — 그 하트비트가 서술하는 런은 이미
    // 최초 디스패치 시점에 자신의 cwd를 확정했다 — 그래서 모든 tool-call
    // 하트비트마다 Workspace 조회를 소비하면, 앱에서 가장 트래픽이 많은
    // 메시지 타입에 아무도 읽지 않는 값을 위한 비용을 물리는 셈이 된다.
    //
    // _processMentions/_handleDmAgentRequest보다 먼저 계산한다(원래 아래
    // emit 바로 앞에 있던 것을 위로 옮김) — DM이나 @멘션은 이 함수 자체의
    // `chat_room_message` emit이 아니라, 그 두 헬퍼가 발생시키는 별도의
    // `chat_request` 이벤트를 통해 디스패치되기 때문이다. `chat_room_message`
    // 쪽은 dispatch_agent_ids가 설정되면 handleChatRoomMessage가 건너뛴다
    // ("canonical execution path" 코멘트 참고). 두 헬퍼 모두 동일한
    // provision을 그대로 전달받아야, 워크스페이스 자신의 운영용 에이전트에게
    // 보낸 DM도 — 티켓 9fd27487의 리스크 섹션이 이름으로 콕 짚은 시나리오다 —
    // 명시적 대상이 없는 그룹방 턴뿐 아니라 실제로 함께 고정(pin)된다.
    let effectiveRunProvision = opts?.runProvision ?? null;
    if (
      !effectiveRunProvision &&
      isRealMessage &&
      !roomForName?.action_id &&
      !roomForName?.orchestration_mission_id &&
      !roomForName?.run_kind
    ) {
      const ws = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
      if (ws?.chat_workspace_folder_enabled) {
        effectiveRunProvision = {
          kind: 'chat',
          run_id: roomId,
          workspace_id: workspaceId,
          workspace_folder: resolveWorkspaceFolder(null, 'chat', roomId),
          checkout_mode: 'reuse',
          // ChatRoom에는 repo_ref 노브가 없다(티켓 9fd27487 인수 기준 3) —
          // 대화형 세션은 암묵적 clone을 절대 받지 않는다.
          repo: null,
        };
      }
    }

    // CHAT-18: only parse mentions from user messages — prevents agent-to-agent loops
    let explicitDispatchAgentIds: string[] = [];
    if (isRealMessage && senderType === 'user') {
      const dispatched = await this._processMentions(roomId, workspaceId, senderId, senderName, trimmed, savedMsg, effectiveRunProvision);
      await this._handleDmAgentRequest(roomId, workspaceId, senderId, trimmed, savedMsg, dispatched, effectiveRunProvision);
      explicitDispatchAgentIds = Array.from(dispatched);
    }

    // Get active member IDs for SSE filtering (CRITICAL Pitfall 1)
    const memberIds = await this.membership.getRoomMemberIds(roomId);
    const agentMemberIds = await this.membership.getRoomAgentMemberIds(roomId);

    // ticket 7d8ea7c9 (review round 1): 이 broadcast용 agent별 Claude backend
    // profile 맵 — 방의 Claude-type 멤버 각자가 DM/@mention 대상일 때뿐
    // 아니라 이 경우에도 자기 설정된 backend를 쓸 수 있도록 한다
    // (_resolveChatRuntimeProfilesForMembers doc 코멘트 참고). progress
    // 하트비트는 제외한다(위 mention/DM skip과 같은 이유): chat_room_message는
    // 모든 tool-call narration마다 발생하는데, 하트비트는 그 profile을 쓸 새
    // dispatch 턴을 여는 게 아니기 때문이다.
    //
    // ticket 9e2fc33d: manager capability 게이트가 profile을 비호환으로
    // 판정한 멤버는 profile map뿐 아니라 이번 broadcast의
    // agent_member_ids에서도 뺀다(_resolveChatRuntimeProfilesForMembers doc
    // 코멘트 참고) — 그래야 그 매니저가 map-없음 폴백으로 profile 없이
    // dispatch를 강행하지 못한다. member_ids(사람/다른 agent 포함 전체
    // 참가자)는 그대로 둔다 — 메시지 자체는 방의 모든 참가자에게 정상
    // 노출되어야 하고, 배제되는 건 "이 턴에 dispatch 후보가 될 자격"뿐이다.
    let cliRuntimeProfiles: Record<string, CliRuntimeProfile> | undefined;
    let broadcastAgentMemberIds = agentMemberIds;
    if (isRealMessage && agentMemberIds.size > 0) {
      const { profiles, incompatibleAgentIds } = await this._resolveChatRuntimeProfilesForMembers(
        Array.from(agentMemberIds),
        workspaceId,
      );
      if (Object.keys(profiles).length > 0) cliRuntimeProfiles = profiles;
      if (incompatibleAgentIds.length > 0) {
        broadcastAgentMemberIds = new Set(agentMemberIds);
        for (const id of incompatibleAgentIds) broadcastAgentMemberIds.delete(id);
      }
    }

    // Trailing consecutive agent-sender count in this room INCLUDING the
    // just-saved message. Plugin uses it to short-circuit dispatch once
    // agents have been talking to each other for too many turns. Always
    // computed (cheap query) so the field is consistent on every emit.
    // Progress rows are excluded from the lookback inside _computeAgentChainDepth
    // so a chatty tool-narration burst never inflates the chain.
    const agentChainDepth = await this._computeAgentChainDepth(roomId);

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
      agent_member_ids: broadcastAgentMemberIds,
      // DM/@mention execution is owned by the targeted chat_request event.
      // The room event still broadcasts the persisted message to participants,
      // but Runtime Hosts use this marker to avoid a second execution path.
      ...(explicitDispatchAgentIds.length > 0
        ? { dispatch_agent_ids: explicitDispatchAgentIds }
        : {}),
      // ticket e6d32e9d: signal Action Run rooms so the agent-manager gives the
      // subagent "do the work directly" instructions instead of the chat
      // "create a ticket" rule. True whenever the room carries an action_id.
      // An Orchestration Mission/Step room is task execution, not conversation,
      // so it reuses the exact same marker: the responding subagent must be told
      // to DO the work rather than to file a ticket. Keeping it on the existing
      // flag (instead of a new payload field) means the agent-manager needs no
      // change and the SSE contract is untouched.
      is_action_room: !!roomForName?.action_id || !!roomForName?.orchestration_mission_id,
      // F-1 (ticket 24694916): forward the parsed refs on the wire (object, not the
      // stringified column) so the event-registry map() + client get the shape
      // directly. Omitted when absent → ordinary chat turns keep the legacy wire.
      ...(sanitizedMeta ? { metadata: sanitizedMeta } : {}),
      ...(effectiveRunProvision ? { run_provision: effectiveRunProvision } : {}),
      ...(cliRuntimeProfiles ? { cli_runtime_profiles: cliRuntimeProfiles } : {}),
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
      metadata: sanitizedMeta ?? undefined,
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
      // ticket e6d32e9d: keep the Action-room signal consistent across both
      // chat_room_message emits. A system alert posted into an Action room
      // still carries the action_id so any responder gets the right prompt.
      is_action_room: !!room.action_id || !!room.orchestration_mission_id,
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
    // NOTE: this marker deliberately does NOT clear @-mentions in the room.
    // A room is marked read on open, which scrolls to the newest message —
    // that says nothing about a mention 200 messages up. Mentions clear when
    // their own message enters the viewport (useMentionViewportReader).
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

    // chat_room_participants.room_id 는 ChatRoom uuid PK 의 @ManyToOne FK 라
    // pre-sync-postgres 가 운영 Postgres 에서 uuid 컬럼으로 정렬한다. 반면
    // chat_room_messages.room_id 는 평범한 varchar 컬럼이라, 컬럼-대-컬럼
    // 조인 `p.room_id = m.room_id` 가 `uuid = character varying` 로 깨진다
    // (파라미터 coercion 으로 안 풀리는 구조적 실패). listRooms 와 동일하게
    // 양쪽을 toText() 로 감싸 Postgres 에서만 ::text 로 맞춘다. (SQLite 는
    // 둘 다 text 라 무영향.)
    const t = (col: string) => this.membership.toText(col);
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        'chat_room_participants',
        'p',
        `${t('p.room_id')} = ${t('m.room_id')} AND p.participant_id = :callerId AND p.participant_type = :participantType AND p.left_at IS NULL`,
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

    // Counting rule lives in common/agent-chain-depth so the ticket-comment
    // mention path (tickets.controller.ts / comment-tools.ts) agrees with
    // this room-chat path on one algorithm.
    return computeChainDepth(
      recent.map((m) => ({ isAgent: m.sender_type === 'agent', authorKey: m.sender_id })),
    );
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
   * Resolve the agent > workspace Claude backend profile for a chat dispatch
   * (ticket 7d8ea7c9). Mirrors trigger-loop.service.ts's ticket-dispatch
   * resolution, but agent-only — a chat turn carries no ticket/board to layer
   * on top. Claude backend profiles must stay invisible to every non-Claude
   * CLI, and a profile the agent's own credential can't satisfy must not be
   * silently handed to the wire — skip (with a warn log) instead of
   * dispatching a chat turn agent-manager cannot actually honor.
   */
  private async _resolveChatRuntimeProfile(
    agent: Agent,
    workspaceId: string,
  ): Promise<CliRuntimeProfile | null> {
    if (agent.type !== 'claude') return null;
    try {
      const workspace = workspaceId
        ? await this.workspaceRepo.findOne({ where: { id: workspaceId } })
        : null;
      return await this._resolveChatRuntimeProfileCore(agent, workspace);
    } catch (err) {
      this.logService.warn('ChatRooms', 'Claude backend profile resolution failed for chat dispatch (continuing without)', {
        err: String(err), agent_id: agent.id,
      });
      return null;
    }
  }

  /**
   * chat_room_message broadcast(ticket 7d8ea7c9 review round 1)를 위한
   * _resolveChatRuntimeProfile의 배치 버전. 그룹방은 모든 멤버에게
   * 팬아웃되므로 평면 profile 필드 하나로는 "지금 응답할 그 agent에게
   * 맞는 backend"를 표현할 수 없다 — Claude-type 멤버마다 cli_runtime_profile
   * 설정이 다르거나(또는 없을) 수 있기 때문이다. Claude-type 멤버마다 하나씩
   * agent_id로 키잉된 항목을 해석해서, 각 매니저 인스턴스(이 방의 agent
   * identity를 여럿 호스팅할 수도 있음)가 dispatch 시점에 자기 responder의
   * 항목을 맵에서 직접 고를 수 있게 한다. workspace는 한 번만 가져와
   * 멤버 전체에 재사용한다 — _resolveChatRuntimeProfile처럼 호출마다
   * 반복 조회하지 않는다.
   *
   * ticket 9e2fc33d: profile을 resolve한 뒤에는 그 agent_id의 LIVE manager
   * instance(들)가 profile이 요구하는 capability(예: context_window 클램프)를
   * 실제로 지원하는지 checkManagerCapabilityForDispatch로 확인한다. 비호환이면
   * map에 아예 넣지 않는다 — profile만 빼고 agent_id는 그대로 두면, 그
   * 매니저는 "이 agent는 원래 profile이 없다"는 정상 케이스와 구분하지 못한 채
   * map에 항목이 없을 때의 폴백(agent-manager
   * resolveRoomBroadcastRuntimeProfile)을 그대로 타 profile 없이(=CLI 고정
   * 기본 output budget으로) dispatch를 진행해버린다 — c3b767c6/1af53029가
   * 막으려던 hang+500을 그대로 재현하는 것과 같다. 그래서 비호환 agent_id는
   * incompatibleAgentIds로 함께 반환해, 호출자가 그 agent를 이번 broadcast의
   * emit 대상(agent_member_ids) 자체에서도 제외하게 한다 — DM/@멘션 경로
   * (_checkManagerCapability)가 dispatch 자체를 거부하는 것과 동일한 효과를
   * 팬아웃 구조에 맞게 낸다. 다른 멤버는 영향받지 않고 정상 응답한다.
   */
  private async _resolveChatRuntimeProfilesForMembers(
    agentIds: string[],
    workspaceId: string,
  ): Promise<{ profiles: Record<string, CliRuntimeProfile>; incompatibleAgentIds: string[] }> {
    const profiles: Record<string, CliRuntimeProfile> = {};
    const incompatibleAgentIds: string[] = [];
    if (agentIds.length === 0) return { profiles, incompatibleAgentIds };
    const agents = await this.agentRepo.find({ where: { id: In(agentIds), type: 'claude' } });
    if (agents.length === 0) return { profiles, incompatibleAgentIds };
    const workspace = workspaceId
      ? await this.workspaceRepo.findOne({ where: { id: workspaceId } })
      : null;
    for (const agent of agents) {
      try {
        const profile = await this._resolveChatRuntimeProfileCore(agent, workspace);
        if (!profile) continue;
        const instances = this.instanceRegistry?.listForAgent(agent.id) ?? [];
        const verdict = checkManagerCapabilityForDispatch(profile, instances);
        if (!verdict.ok) {
          incompatibleAgentIds.push(agent.id);
          this.logService.warn(
            'ChatRooms',
            'chat_room_message broadcast profile dropped (manager capability mismatch)',
            { agent_id: agent.id, profile_id: profile.id, reason: verdict.reason, detail: verdict.detail },
          );
          continue;
        }
        profiles[agent.id] = profile;
      } catch (err) {
        this.logService.warn('ChatRooms', 'Claude backend profile resolution failed for chat dispatch (continuing without)', {
          err: String(err), agent_id: agent.id,
        });
      }
    }
    return { profiles, incompatibleAgentIds };
  }

  /** 단일 agent 경로(_resolveChatRuntimeProfile)와 배치 경로
   *  (_resolveChatRuntimeProfilesForMembers) 둘 다가 공유하는 resolve+
   *  credential-check 코어 — credential 불일치 warn / null 반환 규칙을
   *  바꿀 때 두 곳을 따로 고치지 않도록 한 곳에 모았다. 호출자가 이미
   *  agent.type === 'claude'를 확인하고 `workspace`를 가져온 상태여야
   *  한다. */
  private async _resolveChatRuntimeProfileCore(
    agent: Agent,
    workspace: Workspace | null,
  ): Promise<CliRuntimeProfile | null> {
    const profile = await resolveClaudeBackendProfileForDispatch(this.dataSource, workspace, [
      { source: 'agent', value: agent.cli_runtime_profile },
    ]);
    if (!profile) return null;
    if (profile.credential_required && profile.credential_ref !== agent.credential_id) {
      this.logService.warn(
        'ChatRooms',
        `Claude backend profile "${profile.id}" requires credential ${profile.credential_ref} ` +
          `but agent ${agent.id} does not have it selected — dispatching without a runtime profile`,
      );
      return null;
    }
    return profile;
  }

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
    // 티켓 9fd27487 — 호출자가 이미 해석해둔 chat run-workspace 힌트(또는
    // Action/QA/security가 제공한 값)를, 이 함수가 발생시키는 모든
    // chat_request에 그대로 전달해서 @멘션 디스패치도 그룹방 턴과 동일한
    // cwd 고정(pinning)을 받게 한다. opt-in하지 않은 워크스페이스라면(또는
    // non-real/에이전트가 보낸 메시지에서 파싱된 멘션이라면) null이다.
    runProvision: RunProvision | null = null,
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

    // Self-exclusion, same as every ticket-comment path (T3). This call used
    // to omit it, so a sender who wrote `@[user:<self>]` — or `@[role:…]` in a
    // ticket-bound room where they hold that role — persisted a UserMention
    // row addressed to themselves and got an unread mention badge for their
    // own message, which nothing but opening the inbox could clear.
    // `_processMentions` only runs for sender_type === 'user' (CHAT-18), so
    // scoping the exclusion to the user domain is exact; agent dispatch below
    // is unaffected.
    const resolved: ResolvedMention[] = await this.mentionService.resolveMentions(refs, ticket, {
      excludeActor: { type: 'user', id: senderId },
    });
    if (resolved.length === 0) return dispatched;

    const preview = (content || '').slice(0, 500);
    const ts = savedMessage.created_at.toISOString();

    for (const m of resolved) {
      if (m.type === 'agent') {
        const agent = await this.agentRepo.findOne({ where: { id: m.id } });
        if (!agent) continue;
        // Agent Manager(type='manager')는 절대 chat 대상이 아니다 (ticket 941c72d3) —
        // 작업하지 않으므로 @멘션을 받아도 chat_request 를 emit 하지 않는다.
        if (agent.type === 'manager') continue;
        // Workspace-scope safety: never cross-post a mention into the wrong workspace.
        if (!agentIsVisibleInWorkspace(agent.workspace_id, workspaceId)) continue;

        const cliRuntimeProfile = await this._resolveChatRuntimeProfile(agent, workspaceId);
        const capabilityError = await this._checkManagerCapability(agent, cliRuntimeProfile);
        if (capabilityError) {
          await this.sendSystemMessage(roomId, workspaceId, capabilityError);
          continue;
        }
        activityEvents.emit('chat_request', {
          agent_id: agent.id,
          user_id: senderId,
          message_id: savedMessage.id,
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
          ...(runProvision ? { run_provision: runProvision } : {}),
          ...(cliRuntimeProfile ? { cli_runtime_profile: cliRuntimeProfile } : {}),
        });

        dispatched.add(agent.id);
        this.logService.info(
          'ChatRooms',
          `@mention routed to agent ${agent.name} (${agent.id}) in room ${roomId}`,
        );
        // Never-started / offline agent (ticket bfdd80b7): the chat_request
        // above evaporates at zero subscribers with no user signal. Flag it so
        // AgentAutostartService attempts a spawn and posts a room system message.
        this._flagUnreachableAgent(agent, roomId, workspaceId);
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
          // Chat mentions deep-link to /ws/<wsId>/chat/<roomId>?message=<id>;
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
    // 티켓 9fd27487 — _processMentions의 동일한 파라미터 참고. 이 경로가
    // 바로 이 값이 정말로 필요했던 주된 경로다: DM은 티켓의 리스크 섹션이
    // 명시적으로 이름 붙인 "manager 에이전트 자신의 운영용 채팅" 시나리오다.
    runProvision: RunProvision | null = null,
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
    // Agent Manager(type='manager')는 절대 chat 대상이 아니다 (ticket 941c72d3) —
    // 방에 남아있는 manager 참가자에게도 DM auto-route 를 하지 않는다.
    if (agent.type === 'manager') return;

    // Dedup: skip if @mention already dispatched to this agent
    if (alreadyDispatched.has(agent.id)) return;

    const cliRuntimeProfile = await this._resolveChatRuntimeProfile(agent, workspaceId);
    const capabilityError = await this._checkManagerCapability(agent, cliRuntimeProfile);
    if (capabilityError) {
      await this.sendSystemMessage(roomId, workspaceId, capabilityError);
      return;
    }
    activityEvents.emit('chat_request', {
      agent_id: agent.id,
      user_id: senderId,
      message_id: savedMessage.id,
      ticket_id: null,
      role_prompt: agent.role_prompt || '',
      new_message: content,
      history: [],
      timestamp: savedMessage.created_at.toISOString(),
      mention_depth: 1,
      // See _processMentions — required for room-aware reply routing.
      room_id: roomId,
      ...(runProvision ? { run_provision: runProvision } : {}),
      ...(cliRuntimeProfile ? { cli_runtime_profile: cliRuntimeProfile } : {}),
    });
    alreadyDispatched.add(agent.id);

    this.logService.info('ChatRooms', `DM auto-routed to agent ${agent.name} (${agent.id}) in room ${roomId}`);
    // Never-started / offline agent (ticket bfdd80b7) — same flag as the
    // @mention path so a DM to a not-started agent gets feedback + auto-start.
    this._flagUnreachableAgent(agent, roomId, workspaceId);
  }

  /**
   * Fire the internal auto-start signal (ticket bfdd80b7) when a chat message
   * targets an agent that is not online. AgentAutostartService consumes it,
   * re-classifies precisely (it also sees the instance registry, covering the
   * sub-sweep window), attempts spawn_agent, and posts a room system message so
   * the user never faces a silent no-response. `is_online=0` is a cheap
   * pre-filter here; the hub is the authority, so a false pre-filter is a no-op
   * there (it finds the agent reachable and does nothing).
   */
  private _flagUnreachableAgent(agent: Agent, roomId: string, workspaceId: string): void {
    // Reachable only through a live Runtime Host delivery session. A persisted
    // heartbeat bit alone does not authorize execution.
    if (this.connectivity.isReachable(agent.id)) return;
    const evt: AutostartRequestEvent = {
      agent_id: agent.id,
      agent_name: agent.name,
      room_id: roomId,
      workspace_id: workspaceId,
      source: 'chat',
    };
    activityEvents.emit(AGENT_AUTOSTART_REQUESTED, evt);
  }

  /**
   * Manager dispatch-capability gate (ticket c3b767c6) — the chat-side twin of
   * TriggerLoopService._checkManagerCapabilityGate. This is the path the
   * source incident actually hit: a resolved profile with `context_window`
   * set silently got no clamp from a stale manager on a separate host, which
   * requested the CLI's fixed default output budget and reproduced the same
   * vLLM context-overflow hang+500 the profile fix was meant to prevent —
   * with no signal in the room beyond a chat message that never got a reply.
   *
   * Unlike the credential mismatch a few lines above this method's call
   * sites (which safely drops the profile and dispatches WITHOUT it — falling
   * back to the default Anthropic endpoint is a fine substitute when a
   * credential is missing), a capability mismatch must NOT fall back to
   * dropping the profile: the configured backend is the only one this agent
   * can reach, so silently switching away from it is worse than failing
   * clearly. Returns a Korean, room-postable explanation when incompatible;
   * null when the dispatch may proceed (including whenever `profile` needs
   * nothing an old manager could get wrong, or the registry has no live
   * telemetry to prove an incompatibility — see evaluateManagerCapability).
   */
  private async _checkManagerCapability(agent: Agent, profile: CliRuntimeProfile | null): Promise<string | null> {
    const capability = requiredManagerCapability(profile);
    if (!capability) return null;
    const instances = this.instanceRegistry?.listForAgent(agent.id) ?? [];
    const verdict = evaluateManagerCapability(instances, capability);
    if (verdict.ok) return null;

    const displayMap = await resolveAgentDisplayMap(this.agentRepo, [agent]);
    const displayName = displayMap.get(agent.id) ?? agent.name;
    this.logService.warn('ChatRooms', 'chat_request dropped (manager capability mismatch)', {
      agent_id: agent.id, capability, profile_id: profile?.id, reason: verdict.reason, detail: verdict.detail,
    });
    return (
      `⚠️ **${displayName}**에게 dispatch할 수 없습니다 — ${verdict.detail} ` +
      '백엔드가 응답 없이 대기하는 대신 여기서 즉시 실패로 표시합니다.'
    );
  }

}
