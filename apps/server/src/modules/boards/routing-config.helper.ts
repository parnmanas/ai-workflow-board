/**
 * Helper for propagating Board.routing_config edits into per-column
 * BoardColumn.role_routing rows.
 *
 * Background — v0.41 introduced `BoardColumn.role_routing` (a JSON array of
 * role slugs) as the *single source of truth* for trigger routing. The
 * legacy `Board.routing_config` blob (keyed by lowercased column name) is
 * preserved on the entity so existing admin UIs that PATCH it keep working,
 * but every runtime path now reads `BoardColumn.role_routing` directly. To
 * keep the two stores in lock-step on writes, every code path that mutates
 * routing must call `writeRoutingConfigThrough()` so the per-column rows
 * are updated atomically with the board blob.
 *
 * Reads should NEVER pull from `Board.routing_config` in apps/server/src;
 * iterate `BoardColumn.role_routing` instead. See AllocationService and
 * TriggerLoopService for the canonical pattern.
 */
import { DataSource, EntityManager } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';

/**
 * Coerce one entry from a Board.routing_config blob into a clean role-slug
 * string array. Tolerant of legacy single-string values, null, or
 * accidental garbage; returns `[]` if no usable slugs are present.
 */
export function coerceRoutingValue(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * Resolve the role-slug list for a column from its parent board's
 * routing_config blob (lowercased-name keyed). Used by the migration
 * backfill and by mutation paths that have just finished editing
 * routing_config and now need to fan it out into per-column role_routing.
 */
export function lookupRolesForColumnFromBoard(
  board: Pick<Board, 'routing_config'>,
  columnName: string,
): string[] {
  const routing = safeJsonParse<Record<string, string | string[]>>(board.routing_config, {});
  const key = (columnName || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(routing, key)) return [];
  return coerceRoutingValue(routing[key]);
}

/**
 * Write the routing_config string onto the board AND fan it out into each
 * of the board's columns' role_routing field. Both writes happen via the
 * provided EntityManager / DataSource so the caller can wrap them in a
 * transaction.
 *
 * The board's `routing_config` is updated in-place (the caller is expected
 * to have set it before calling). Only `role_routing` propagation is the
 * responsibility of this helper.
 */
export async function writeRoutingConfigThrough(
  ds: DataSource | EntityManager,
  boardId: string,
): Promise<void> {
  const manager = ds instanceof DataSource ? ds.manager : ds;
  const board = await manager.getRepository(Board).findOne({ where: { id: boardId } });
  if (!board) return;
  const cols = await manager.getRepository(BoardColumn).find({ where: { board_id: boardId } });
  for (const col of cols) {
    const slugs = lookupRolesForColumnFromBoard(board, col.name);
    col.role_routing = JSON.stringify(slugs);
  }
  if (cols.length > 0) {
    await manager.getRepository(BoardColumn).save(cols);
  }
}

/**
 * Convenience: stamp `role_routing` on a freshly-created column row from
 * its parent board's existing routing_config. Used at column-create time
 * so a new column starts with whatever routing the operator already had
 * configured under that name (typical for a re-created default column),
 * or with an empty `'[]'` for a brand-new name.
 */
export function computeRoleRoutingForNewColumn(
  board: Pick<Board, 'routing_config'>,
  columnName: string,
): string {
  return JSON.stringify(lookupRolesForColumnFromBoard(board, columnName));
}
