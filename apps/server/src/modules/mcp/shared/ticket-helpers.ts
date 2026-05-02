/**
 * Small DB helpers shared between ticket/board/column tools.
 *
 * All functions take an explicit DataSource so they work uniformly in the
 * NestJS-integrated and standalone MCP contexts.
 */

import type { DataSource, EntityManager, Repository } from 'typeorm';
import { In } from 'typeorm';
import { Agent } from '../../../entities/Agent';
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
 * Resolve an agent UUID from either a raw ID (passthrough) or a display name.
 * Returns the empty string when neither yields a match.
 */
export async function resolveAgentId(scope: RepoScope, id: string, name: string): Promise<string> {
  if (id) return id;
  if (!name) return '';
  const agent = await scope.getRepository(Agent).findOne({ where: { name } }).catch(() => null);
  return agent?.id || '';
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

/**
 * Approximate decoded byte count for a base64 string. Mirrors the formula
 * the comment-attachment path uses (length * 3 / 4); padding overcounts by
 * 1–2 bytes which is tolerable for size-cap enforcement.
 */
export function approxBase64Size(base64: string): number {
  return Math.floor(((base64?.length || 0) * 3) / 4);
}
