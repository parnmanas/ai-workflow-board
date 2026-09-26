/**
 * Small DB helpers shared between ticket/board/column tools.
 *
 * All functions take an explicit DataSource so they work uniformly in the
 * NestJS-integrated and standalone MCP contexts.
 */

import type { DataSource, EntityManager, Repository } from 'typeorm';
import { In } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { Comment } from '../../../entities/Comment';
import { Resource } from '../../../entities/Resource';
import { TicketAttachment } from '../../../entities/TicketAttachment';

/**
 * Anything that provides `getRepository(Entity)` — both `DataSource` and a
 * transaction `EntityManager` qualify. Helpers accept either so callers can
 * stay inside a running transaction without the read escaping to the outer
 * connection.
 */
export type RepoScope = DataSource | EntityManager;

/** Case-insensitive column lookup by name, scoped to a board. */
export async function findColumnByName(scope: RepoScope, boardId: string, columnName: string) {
  return scope.getRepository(BoardColumn)
    .createQueryBuilder('col')
    .where('col.board_id = :boardId AND LOWER(col.name) = LOWER(:name)', { boardId, name: columnName })
    .getOne();
}

/** Next free `position` value at the end of a column (root tickets only). */
export async function maxTicketPosition(scope: RepoScope, columnId: string): Promise<number> {
  const result = await scope.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.column_id = :columnId AND t.parent_id IS NULL', { columnId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

/** Next free `position` value at the end of a parent's child list. */
export async function maxChildPosition(scope: RepoScope, parentId: string): Promise<number> {
  const result = await scope.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.parent_id = :parentId', { parentId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

/**
 * Logger sink accepted by the agent-resolution helpers. Optional in every
 * call site — when omitted the helpers stay silent (used by tests + the
 * standalone MCP entry point). When present we surface name-based lookup
 * deprecation + backfill events so operators can spot legacy callers.
 */
export interface AgentResolveLogger {
  warn?(category: string, message: string, meta?: Record<string, any>): any;
  info?(category: string, message: string, meta?: Record<string, any>): any;
}

/**
 * Format an agent for display in TicketCard / activity log / system comment.
 * `Manager/Agent` when the agent has a `manager_agent_id` we can resolve;
 * just `Agent` otherwise (no manager, or manager row missing — survives
 * dangling ids without breaking the write). Centralized so the four MCP
 * entry points (root + child × create + update) and the REST controller all
 * agree, which is what kills the same-name disambiguation problem in B3.
 */
export async function formatAgentDisplayName(
  scope: RepoScope,
  agent: Agent,
): Promise<string> {
  if (!agent.manager_agent_id) return agent.name;
  const manager = await scope.getRepository(Agent)
    .findOne({ where: { id: agent.manager_agent_id } })
    .catch(() => null);
  if (!manager) return agent.name;
  return `${manager.name}/${agent.name}`;
}

/**
 * Canonical `<Manager>/<Agent>` display for the current MCP caller. Resolves
 * the caller's agentId through the same `formatAgentDisplayName` TicketCard /
 * activity log use, so denormalized snapshots the UI reads back carry the full
 * name instead of the bare API-key leaf that `caller.agentName` holds
 * (mcp.controller sets it to `ak.agent?.name`, no manager prefix).
 *
 * Needed where the stored snapshot has NO companion id to re-resolve on read —
 * `Ticket.pending_set_by` (User tab "Parked by …") is a lone display string.
 * Activity `actor_name` carries an `actor_id`, so that path is fixed on read
 * instead; this helper is for the id-less write paths.
 *
 * Falls back to the bare leaf when the id is absent or unresolvable (env-key
 * callers with no agentId, deleted agent row) so the field is never blanked.
 */
export async function resolveCallerDisplayName(
  scope: RepoScope,
  caller: { agentId?: string; agentName?: string } | null | undefined,
): Promise<string> {
  if (caller?.agentId) {
    const agent = await scope.getRepository(Agent)
      .findOne({ where: { id: caller.agentId } })
      .catch(() => null);
    if (agent) return formatAgentDisplayName(scope, agent);
  }
  return caller?.agentName || '';
}

/**
 * Resolve an agent UUID from either a raw ID (passthrough) or a display name.
 * Returns the empty string when neither yields a match.
 *
 * Name lookup is documented as deprecated: the workspace can host multiple
 * agents with identical `name` (e.g. `Ralf` as both a manager Agent row and
 * a Claude subagent), and a silent first-match pick routes triggers to the
 * wrong agent type. We log a warn on the name path and throw on multi-match
 * — callers must migrate to ID-based lookup.
 */
export async function resolveAgentId(
  scope: RepoScope,
  id: string,
  name: string,
  logger?: AgentResolveLogger,
): Promise<string> {
  if (id) return id;
  if (!name) return '';
  const agents = await scope.getRepository(Agent)
    .find({ where: { name } })
    .catch(() => [] as Agent[]);
  if (agents.length === 0) return '';
  if (agents.length > 1) {
    const ids = agents.map(a => a.id).join(', ');
    throw new Error(
      `Agent name "${name}" matches ${agents.length} agents (ids: ${ids}). ` +
      `Pass *_id directly — name-based lookup is ambiguous.`,
    );
  }
  logger?.warn?.('MCP', 'Deprecated name-based agent lookup', { name, agent_id: agents[0].id });
  return agents[0].id;
}

/**
 * Resolve both the agent id and display name from whichever side the caller
 * supplied. Callers that hand us an id without a name (the MCP `create_ticket`
 * path used by remote agents) would otherwise leave the legacy `assignee` /
 * `reporter` text columns blank — TicketCard reads those columns directly and
 * renders "Unassigned" until someone re-saves with the name.
 *
 * Display rules (B3):
 *   - When the resolved Agent has `manager_agent_id`, the returned `name` is
 *     `<manager.name>/<agent.name>` so the same string works for activity
 *     log, system comments, and TicketCard regardless of how many agents
 *     share a leaf name. The lookup happens even when the caller pre-filled
 *     `name`, so the format stays canonical.
 *   - Name-only lookup logs a deprecation warn and throws on multi-match —
 *     `resolveAgentId` shares the same policy. ID-only lookup is the
 *     happy path and stays silent.
 *
 * Lookup miss (id points at a non-agent — e.g. a User row, or stale id) keeps
 * whatever the caller supplied so user assignees / unknown ids aren't
 * accidentally cleared.
 */
export async function resolveAgentIdAndName(
  scope: RepoScope,
  id: string,
  name: string,
  logger?: AgentResolveLogger,
): Promise<{ id: string; name: string }> {
  if (!id && !name) return { id: '', name: '' };
  const agentRepo = scope.getRepository(Agent);
  if (id) {
    // Always look the id up so we can build the canonical Manager/Agent
    // display, even when the caller pre-filled `name`. Falling back to the
    // caller's name on miss preserves user-id assignees.
    const agent = await agentRepo.findOne({ where: { id } }).catch(() => null);
    if (!agent) return { id, name: name || '' };
    const display = await formatAgentDisplayName(scope, agent);
    return { id: agent.id, name: display };
  }
  // Name-only: deprecated path.
  const agents = await agentRepo.find({ where: { name } }).catch(() => [] as Agent[]);
  if (agents.length === 0) return { id: '', name };
  if (agents.length > 1) {
    const ids = agents.map(a => a.id).join(', ');
    throw new Error(
      `Agent name "${name}" matches ${agents.length} agents (ids: ${ids}). ` +
      `Pass *_id directly — name-based lookup is ambiguous.`,
    );
  }
  logger?.warn?.('MCP', 'Deprecated name-based agent lookup', { name, agent_id: agents[0].id });
  const display = await formatAgentDisplayName(scope, agents[0]);
  return { id: agents[0].id, name: display };
}

/**
 * Backfill `ticket.workspace_id` from its column → board when the row was
 * saved with the empty default (`Ticket.workspace_id` defaults to '' so MCP
 * create paths that don't supply it land empty). Mutates the in-memory
 * ticket and persists the new value via a targeted UPDATE so the very next
 * `syncBuiltinTrio` / `setHolder` call has the workspace context it needs
 * to find the workspace's WorkspaceRole rows.
 *
 * No-op when workspace_id is already set, or when the column / board lookup
 * misses (e.g. transient race during column delete) — failing here would
 * cascade into a confusing assignment-sync skip; the caller's later read
 * will discover the empty workspace_id and degrade gracefully on its own.
 *
 * Mirrors the REST controller's previous private `_refreshWorkspaceId`
 * helper (`tickets.controller.ts`); extracted here so MCP and REST share a
 * single implementation. The MCP `create_ticket` path historically skipped
 * this step entirely, which silently broke the v0.34 trigger loop for
 * every ticket created via MCP.
 */
export async function refreshTicketWorkspaceId(
  scope: RepoScope,
  ticket: Ticket,
): Promise<void> {
  if (ticket.workspace_id) return;
  if (!ticket.column_id) return;
  const col = await scope.getRepository(BoardColumn)
    .findOne({ where: { id: ticket.column_id } })
    .catch(() => null);
  if (!col) return;
  const board = await scope.getRepository(Board)
    .findOne({ where: { id: col.board_id } })
    .catch(() => null);
  if (!board?.workspace_id) return;
  ticket.workspace_id = board.workspace_id;
  await scope.getRepository(Ticket)
    .update(ticket.id, { workspace_id: board.workspace_id })
    .catch(() => { /* persist failure is non-fatal — caller still has the value in-memory */ });
}

/**
 * Validate a `next_ticket_id` candidate before persisting it on a ticket:
 *   - empty / null / undefined  → returns null (clears the link)
 *   - same id as the ticket itself → throws (no self-link)
 *   - target row missing → throws
 *   - target lives in a different workspace → throws
 *
 * Mirrors the `base_repo_resource_id` workspace guard so a guessed id from
 * another workspace can never wire a cross-workspace trigger here.
 *
 * `currentTicketId` is the ticket being updated (or null when creating, in
 * which case the self-link check is skipped — a new ticket can't reference
 * itself before it has an id). `currentWorkspaceId` is the workspace the
 * link is being established in; when empty, only the existence + self-link
 * checks run (workspace guard skipped to keep parity with refreshTicketWorkspaceId
 * deferred backfill — same posture as base_repo_resource_id).
 */
export async function validateNextTicketId(
  scope: RepoScope,
  raw: unknown,
  currentTicketId: string | null,
  currentWorkspaceId: string,
): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  const candidate = String(raw).trim();
  if (!candidate) return null;
  if (currentTicketId && candidate === currentTicketId) {
    throw new Error('next_ticket_id cannot point at the ticket itself');
  }
  const target = await scope.getRepository(Ticket).findOne({ where: { id: candidate } });
  if (!target) {
    throw new Error('next_ticket_id not found');
  }
  if (currentWorkspaceId && target.workspace_id && target.workspace_id !== currentWorkspaceId) {
    throw new Error('next_ticket_id must point to a ticket in the same workspace');
  }
  return candidate;
}

/**
 * Shift sibling ticket positions within a scope.
 *
 *   scope: { column_id }  → root tickets in a board column (parent_id IS NULL).
 *   scope: { parent_id }  → children of the given parent.
 *
 *   delta = -1: close the gap left by a removed ticket (position > fromPos).
 *   delta = +1: open a slot for an inserted ticket (position >= fromPos, when `inclusive`).
 *
 * Accepts any `Repository<Ticket>` so it works inside transactions (pass
 * `manager.getRepository(Ticket)`).
 */
export async function shiftTicketPositions(
  ticketRepo: Repository<Ticket>,
  scope: { column_id: string } | { parent_id: string },
  fromPos: number,
  delta: 1 | -1,
  options: { inclusive?: boolean; excludeId?: string } = {},
): Promise<void> {
  const { inclusive = false, excludeId } = options;
  const cmp = inclusive ? '>=' : '>';
  const expr = delta > 0 ? 'position + 1' : 'position - 1';

  const qb = ticketRepo.createQueryBuilder().update().set({ position: () => expr });

  if ('column_id' in scope) {
    qb.where(`column_id = :colId AND position ${cmp} :pos AND parent_id IS NULL`,
      { colId: scope.column_id, pos: fromPos });
  } else {
    qb.where(`parent_id = :parentId AND position ${cmp} :pos`,
      { parentId: scope.parent_id, pos: fromPos });
  }

  if (excludeId) qb.andWhere('id != :excludeId', { excludeId });

  await qb.execute();
}

/**
 * Walk a ticket's subtree (self + children + grandchildren), collect every
 * Resource id referenced via `comments.attachment_resource_ids`, and return
 * them de-duplicated. Used on ticket delete to cascade away
 * type='comment_attachment' Resources — Comment rows already cascade via the
 * @ManyToOne onDelete, but the Resource table doesn't, so attachments would
 * otherwise leak as orphans that no longer trace back to any ticket.
 */
export async function collectCommentAttachmentResourceIds(
  scope: RepoScope,
  rootTicketId: string,
): Promise<string[]> {
  const ticketRepo = scope.getRepository(Ticket);
  const tree = await ticketRepo.find({
    where: [
      { id: rootTicketId },
      { parent_id: rootTicketId },
    ],
  });
  const ticketIds = new Set<string>([rootTicketId]);
  for (const t of tree) ticketIds.add(t.id);

  // Grandchildren: any ticket whose parent is one of our level-1 children.
  const level1 = tree.filter(t => t.parent_id === rootTicketId).map(t => t.id);
  if (level1.length > 0) {
    const grandchildren = await ticketRepo.find({ where: { parent_id: In(level1) } as any });
    for (const gc of grandchildren) ticketIds.add(gc.id);
  }

  if (ticketIds.size === 0) return [];
  const comments = await scope.getRepository(Comment).find({ where: { ticket_id: In([...ticketIds]) } as any });
  const resourceIds = new Set<string>();
  for (const c of comments) {
    try {
      const parsed = JSON.parse(c.attachment_resource_ids || '[]');
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && id) resourceIds.add(id);
    } catch { /* malformed row — ignore, nothing to delete */ }
  }
  return [...resourceIds];
}

/**
 * Delete the comment_attachment Resources attached to the given ticket's
 * subtree. Intended to run BEFORE ticketRepo.remove() so we can still read
 * comment rows; the Resource rows themselves have no cascade to tickets, so
 * dropping them afterwards would work too but costs an extra round-trip to
 * rediscover the comment rows that already cascaded away.
 */
export async function deleteCommentAttachmentsForTicket(
  scope: RepoScope,
  rootTicketId: string,
): Promise<number> {
  const ids = await collectCommentAttachmentResourceIds(scope, rootTicketId);
  if (ids.length === 0) return 0;
  const result = await scope.getRepository(Resource)
    .createQueryBuilder()
    .delete()
    .where('id IN (:...ids) AND type = :t', { ids, t: 'comment_attachment' })
    .execute();
  return result.affected || 0;
}

/**
 * Cheap mimetype inference for ticket-level uploads. Mirrors the same map
 * used inline by the comment add path so the two attachment surfaces agree
 * on what an extensionless or unknown file resolves to.
 */
export function inferTicketAttachmentMimetype(fileName: string, explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const extMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    zip: 'application/zip', csv: 'text/csv',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    log: 'text/plain', xml: 'application/xml', html: 'text/html',
  };
  return extMap[ext] || 'application/octet-stream';
}

/**
 * Project a TicketAttachment row into the wire-shape the API surfaces use
 * (REST list + ticket detail). `includeData=false` strips `file_data` so list
 * responses don't pay the base64 cost; the single-attachment GET passes
 * `true` to ship the binary alongside metadata for download/preview.
 */
export function projectTicketAttachment(
  row: TicketAttachment,
  options: { includeData?: boolean } = {},
) {
  const { includeData = false } = options;
  const out: any = {
    id: row.id,
    workspace_id: row.workspace_id,
    ticket_id: row.ticket_id,
    file_name: row.file_name,
    file_mimetype: row.file_mimetype,
    file_size: row.file_size,
    uploaded_by_type: row.uploaded_by_type,
    uploaded_by_id: row.uploaded_by_id,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
  if (includeData) {
    // 읽는 순간에만 스트림을 닫아 준다 — 저장된 행은 그대로 둔다(위 함수 주석 참고).
    const repaired = repairTruncatedMediaForRead(row.file_mimetype, row.file_data);
    out.file_data = repaired.file_data;
    out.truncated = repaired.truncated;
  }
  return out;
}

export function isImageAttachment(row: TicketAttachment): boolean {
  return /^image\//i.test(row.file_mimetype || '');
}

export function projectChatAttachment(
  row: TicketAttachment,
  options: { includeData?: boolean } = {},
) {
  const { includeData = false } = options;
  const downloadUrl = row.room_id
    ? `/api/chat-rooms/${row.room_id}/attachments/${row.id}`
    : `/api/chat-rooms/attachments/${row.id}`;
  const out: any = {
    id: row.id,
    attachment_id: row.id,
    workspace_id: row.workspace_id,
    room_id: row.room_id,
    message_id: row.owner_type === 'chat_message' ? row.owner_id : '',
    filename: row.file_name,
    file_name: row.file_name,
    mime_type: row.file_mimetype,
    file_mimetype: row.file_mimetype,
    size_bytes: row.file_size,
    file_size: row.file_size,
    download_url: downloadUrl,
    thumbnail_url: isImageAttachment(row) ? downloadUrl : undefined,
    uploaded_by_type: row.uploaded_by_type,
    uploaded_by_id: row.uploaded_by_id,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
  if (includeData) out.file_data = row.file_data;
  return out;
}

/**
 * Approximate decoded byte count for a base64 string. Mirrors the formula
 * the comment-attachment path uses (length * 3 / 4); padding overcounts by
 * 1–2 bytes which is tolerable for size-cap enforcement.
 */
export function approxBase64Size(base64: string): number {
  return Math.floor(((base64?.length || 0) * 3) / 4);
}

/**
 * Best-effort magic-byte sniffer for the file formats the chat / ticket
 * attachment surfaces actually render specially (images for inline
 * preview + thumbnails; pdf/zip for download). Returns null when the
 * leading bytes don't match a known signature — sniffable text formats
 * (text/plain, application/json, source code) deliberately fall through
 * because every text payload would otherwise have to be parsed before
 * upload.
 *
 * Decodes only the first ~24 base64 chars (≈ 18 bytes) so this stays
 * cheap on big payloads. Callers pass the same base64 string the
 * controller saved verbatim, so what we sniff is what hits disk — no
 * trust-on-claim window between the check and the persistence.
 */
const MAGIC_SIGNATURES: Array<{ mime: string; prefix: number[]; offset?: number }> = [
  { mime: 'image/png',  prefix: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg', prefix: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif',  prefix: [0x47, 0x49, 0x46, 0x38] },          // "GIF8" — 7a / 9a both fine
  { mime: 'application/pdf', prefix: [0x25, 0x50, 0x44, 0x46] },     // "%PDF"
  { mime: 'application/zip', prefix: [0x50, 0x4B, 0x03, 0x04] },     // "PK\x03\x04"
  { mime: 'image/bmp', prefix: [0x42, 0x4D] },                       // "BM"
];

export function sniffMimetypeFromBase64(base64: string): string | null {
  if (!base64) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(base64.slice(0, 32), 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  // RIFF...WEBP — magic split across a length field, so check explicitly.
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  for (const sig of MAGIC_SIGNATURES) {
    if (buf.length < sig.prefix.length) continue;
    let matched = true;
    for (let i = 0; i < sig.prefix.length; i++) {
      if (buf[i] !== sig.prefix[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return sig.mime;
  }
  return null;
}

/**
 * Verify the caller-claimed mime against the actual bytes, then return
 * the canonical mime to persist. The acceptance criteria for ticket
 * 92082b55 (security section) requires this on every chat-attachment
 * upload so a client cannot smuggle an executable masquerading as
 * `image/png` past the inline-render guard.
 *
 * Decision matrix:
 *   - bytes are unknown to the sniffer → trust the caller's claim (text/log/source
 *     files don't have a fixed signature; bouncing every unknown upload would
 *     break the most common chat use case — pasting a log snippet).
 *   - sniffed type matches the canonical inferred type → accept the canonical
 *     mime (no rewrite needed).
 *   - sniffed type AND inferred type are both known, and they disagree → throw
 *     400. This is the security guard: a client cannot send PNG bytes labeled
 *     as `application/pdf`, or vice versa.
 *   - sniffer found a definitive type but inferred is the application/octet-stream
 *     fallback (extensionless or unknown extension) → accept the sniffed type so
 *     the row carries an accurate mime for downstream rendering.
 */
// Common non-canonical mime spellings → canonical form. Used when comparing
// the caller's claim against what the sniffer found, so legitimate uploads
// from browsers / SDKs that still send legacy spellings (`image/jpg`,
// `image/x-png`, `application/x-zip-compressed`) don't get rejected by the
// magic-byte mismatch guard.
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-zip': 'application/zip',
  'application/x-zip-compressed': 'application/zip',
};

/** status 400 을 실은 Error — 업로드 경로들이 그대로 400/툴 에러로 바꿔 내보낸다. */
function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function normalizeMime(mime: string): string {
  const lower = (mime || '').toLowerCase().trim();
  return MIME_ALIASES[lower] || lower;
}

/**
 * 이 형식의 파일이 **끝까지 다 왔는가**. 헤더만 맞고 뒤가 잘린 파일을 upload 시점에
 * 잡아내는 검사다.
 *
 * 왜 필요한가(2026-09-26 실측): 미션 evidence 로 올라온 스크린샷 4장 중 3장이 JPEG
 * 종료 마커(`FFD9`)가 **아예 없는** 잘린 파일이었다. base64 자체는 완전하고 헤더도
 * 진짜 JPEG 라서 기존 sniffer 를 그대로 통과했고, 몇 시간 뒤 운영자가 "스크린샷이 다
 * 깨져 보인다"로 발견했다. 원인은 업로더 쪽이다 — 아직 쓰이는 중인 캡처 파일을 읽으면
 * 정확히 이 모양이 된다. 그래도 **받는 쪽에서 막는 것이 맞다**: 검증 증거가 깨진 채로
 * 기록되면 그 step 은 증거가 없는 것과 같고, agent 는 실패를 알 방법이 없어 다시
 * 올리지도 않는다. 업로드가 실패하면 agent 는 그 자리에서 다시 시도할 수 있다.
 *
 * 종료 마커를 **마지막 64바이트 안에서** 찾는다. 정확히 끝에 있어야 한다고 요구하면
 * 일부 인코더가 붙이는 꼬리 패딩을 오탐하고, 파일 전체에서 찾으면 EXIF 안에 박힌
 * 썸네일(그 자체로 완결된 JPEG)의 마커를 보고 잘린 파일을 통과시킨다.
 *
 * 검사하지 않는 형식은 **조용히 통과시킨다**. 동영상 컨테이너(mp4/webm)는 꼬리 한 번으로
 * 완결성을 판정할 수 없고, 텍스트·로그·PDF·zip 은 "잘렸다"는 개념이 형식마다 다르다.
 * 여기서 억지 추측을 하면 정상 업로드를 막는다 — 이 검사의 값어치는 **확실할 때만
 * 거부하는 것**에 있다.
 */
/**
 * 이 바이트가 그 형식으로 **끝까지 왔는가**. 업로드 거부(`assertAttachmentNotTruncated`)와
 * 읽기 복구(`repairTruncatedMediaForRead`)가 같은 판정을 써야 하므로 여기 한 곳에 둔다 —
 * 둘이 갈리면 "업로드는 통과했는데 읽을 때 잘렸다고 표시" 같은 모순이 생긴다.
 *
 * 반환 `format: null` 은 "이 형식은 값싸게 판정할 수 없다"(동영상 컨테이너·텍스트·PDF·zip)
 * 이고, 그때 `complete` 는 항상 true 다 — 확실할 때만 판정하는 것이 이 검사의 값어치다.
 */
function mediaCompleteness(
  mime: string,
  bytes: Buffer,
): { format: 'JPEG' | 'PNG' | 'GIF' | 'WebP' | null; complete: boolean } {
  const normalized = normalizeMime(mime);
  // 종료 마커는 **마지막 64바이트 안에서** 찾는다. 정확히 끝만 보면 일부 인코더의 꼬리
  // 패딩을 오탐하고, 파일 전체에서 찾으면 EXIF 안에 박힌 완결 썸네일의 마커를 보고 잘린
  // 파일을 통과시킨다.
  const tail = bytes.subarray(Math.max(0, bytes.length - 64));
  const endsWith = (sig: Buffer) => tail.lastIndexOf(sig) >= 0;
  if (normalized === 'image/jpeg') return { format: 'JPEG', complete: endsWith(Buffer.from([0xff, 0xd9])) };
  if (normalized === 'image/png') {
    // IEND chunk + its CRC — PNG 는 이것으로 끝나야 한다.
    return {
      format: 'PNG',
      complete: endsWith(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])),
    };
  }
  if (normalized === 'image/gif') return { format: 'GIF', complete: endsWith(Buffer.from([0x3b])) };
  if (normalized === 'image/webp') {
    // RIFF 컨테이너는 길이를 헤더에 적어 둔다 — 꼬리를 볼 필요 없이 정확히 대조된다.
    if (bytes.length < 12) return { format: 'WebP', complete: false };
    return { format: 'WebP', complete: bytes.readUInt32LE(4) + 8 <= bytes.length };
  }
  return { format: null, complete: true };
}

export function assertAttachmentNotTruncated(fileName: string, mime: string, base64: string): void {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return; // base64 자체가 깨졌으면 이 검사의 소관이 아니다(상위에서 다룬다).
  }
  if (bytes.length === 0) {
    throw badRequest(`Attachment ${fileName}: the file is empty (0 bytes decoded)`);
  }
  const { format, complete } = mediaCompleteness(mime, bytes);
  if (format && !complete) {
    throw badRequest(
      `Attachment ${fileName}: the ${format} data is incomplete — ${bytes.length} bytes decoded with no ` +
        `end-of-file marker. This almost always means the file was read while it was still being written ` +
        `(a screenshot or recording that had not finished saving). Wait for the writer to close the file, ` +
        `confirm it opens in an image viewer, then upload it again. Nothing was stored.`,
    );
  }
}

/**
 * 읽을 때 한 번 손보기 — **남아 있는 부분만이라도 보이게** 한다.
 *
 * 업로드 게이트가 생기기 전에 저장된 잘린 파일들이 남아 있다(2026-09-26 실측: 미션
 * evidence 6장 중 4장). 그 바이트는 쓸모없지 않았다 — 종료 마커만 붙이면 디코더가
 * 도착한 스캔라인까지 그려 준다(실측: 한 장은 98%, 나머지는 6~18% 복원). 그런데 마커가
 * 없으면 브라우저는 아무것도 그리지 않아 운영자에게는 빈 칸으로만 보였다.
 *
 * **저장된 행은 고치지 않는다.** 실제로 올라온 바이트가 기록이고, 그걸 덮어쓰면 무엇이
 * 잘못 올라왔는지의 증거가 사라진다. 읽는 순간에만 스트림을 닫아 주고, `truncated` 로
 * 사실을 함께 알린다 — 화면이 "일부만 남음"이라고 말할 수 있어야 7% 짜리 스크린샷을
 * 온전한 증거로 착각하지 않는다.
 *
 * JPEG 만 복구한다. PNG/GIF 는 청크·CRC 구조라 꼬리를 붙인다고 디코드되지 않고, 잘린
 * PNG 는 브라우저가 이미 받은 만큼 점진적으로 그린다. 복구하지 못하는 형식도 `truncated`
 * 는 그대로 알려 준다.
 */
export function repairTruncatedMediaForRead(
  mime: string,
  base64: string,
): { file_data: string; truncated: boolean } {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64 || '', 'base64');
  } catch {
    return { file_data: base64, truncated: false };
  }
  if (bytes.length === 0) return { file_data: base64, truncated: false };
  const { format, complete } = mediaCompleteness(mime, bytes);
  if (!format || complete) return { file_data: base64, truncated: false };
  if (format === 'JPEG') {
    return {
      file_data: Buffer.concat([bytes, Buffer.from([0xff, 0xd9])]).toString('base64'),
      truncated: true,
    };
  }
  return { file_data: base64, truncated: true };
}

export function validateAttachmentMimetype(
  fileName: string,
  claimedMimetype: string | undefined,
  base64: string,
): string {
  const canonical = inferTicketAttachmentMimetype(fileName, claimedMimetype);
  const sniffed = sniffMimetypeFromBase64(base64);
  // 완결성 검사는 **이 함수 안에서** 한다. 업로드 경로가 둘(MCP 툴 / REST 컨트롤러)인데
  // 둘 다 이미 이 함수를 반드시 지나므로, 여기 두면 어느 경로도 빠뜨릴 수 없다. 별도
  // 함수로 내보내고 호출을 각자 추가하게 하면 다음 업로드 경로가 생길 때 조용히 빠진다.
  if (!sniffed) {
    assertAttachmentNotTruncated(fileName, canonical, base64);
    return canonical;
  }
  if (normalizeMime(sniffed) === normalizeMime(canonical)) {
    assertAttachmentNotTruncated(fileName, canonical, base64);
    return canonical;
  }
  // Extensionless or unknown-extension upload — canonical is the generic
  // fallback. Use the sniffed type because it's strictly more informative.
  if (canonical === 'application/octet-stream') {
    assertAttachmentNotTruncated(fileName, sniffed, base64);
    return sniffed;
  }
  // Definitive mismatch — the caller claimed one type but the bytes are
  // demonstrably another. Reject loudly so the upload never lands on disk
  // with a misleading mime that lets a non-image render in the lightbox.
  const err = new Error(
    `Attachment ${fileName}: claimed mime "${canonical}" does not match file bytes (detected "${sniffed}")`,
  ) as Error & { status: number };
  err.status = 400;
  throw err;
}
