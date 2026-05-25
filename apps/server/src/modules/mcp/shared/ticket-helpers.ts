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
  if (includeData) out.file_data = row.file_data;
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
