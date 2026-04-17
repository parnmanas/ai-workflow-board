/**
 * Small DB helpers shared between ticket/board/column tools.
 *
 * All functions take an explicit DataSource so they work uniformly in the
 * NestJS-integrated and standalone MCP contexts.
 */

import type { DataSource, EntityManager, Repository } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';

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
