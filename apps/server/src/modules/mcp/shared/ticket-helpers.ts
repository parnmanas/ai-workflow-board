/**
 * Small DB helpers shared between ticket/board/column tools.
 *
 * All functions take an explicit DataSource so they work uniformly in the
 * NestJS-integrated and standalone MCP contexts.
 */

import type { DataSource } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';

/** Case-insensitive column lookup by name, scoped to a board. */
export async function findColumnByName(dataSource: DataSource, boardId: string, columnName: string) {
  return dataSource.getRepository(BoardColumn)
    .createQueryBuilder('col')
    .where('col.board_id = :boardId AND LOWER(col.name) = LOWER(:name)', { boardId, name: columnName })
    .getOne();
}

/** Next free `position` value at the end of a column. */
export async function maxTicketPosition(dataSource: DataSource, columnId: string): Promise<number> {
  const result = await dataSource.getRepository(Ticket)
    .createQueryBuilder('t')
    .select('COALESCE(MAX(t.position), -1)', 'max')
    .where('t.column_id = :columnId', { columnId })
    .getRawOne();
  return (result?.max ?? -1) + 1;
}

/** Next free `position` value at the end of a parent's child list. */
export async function maxChildPosition(dataSource: DataSource, parentId: string): Promise<number> {
  const result = await dataSource.getRepository(Ticket)
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
export async function resolveAgentId(dataSource: DataSource, id: string, name: string): Promise<string> {
  if (id) return id;
  if (!name) return '';
  const agent = await dataSource.getRepository(Agent).findOne({ where: { name } }).catch(() => null);
  return agent?.id || '';
}
