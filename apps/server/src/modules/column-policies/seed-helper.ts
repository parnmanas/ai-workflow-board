/**
 * Default-seeding helper for `ColumnRolePolicy` (ticket f886ada7).
 *
 * Single source of truth shared by:
 *   - the 1760000000017 migration (back-fills existing DBs at boot)
 *   - DatabaseModule's first-run bootstrap (seeds the brand-new default
 *     workspace's board so the alert layer is active out of the box)
 *   - any future column-CRUD code that wants to attach default policies
 *     when an operator adds a new column×role pair.
 *
 * The helper is intentionally framework-agnostic — takes either a DataSource
 * or an EntityManager so the migration's transaction-bound runner can call
 * it without instantiating Nest DI.
 *
 * Idempotency contract: NEVER overwrites an existing (board, column, role)
 * row. Operator-edited values stay put. Returns the count of newly inserted
 * rows so callers can log a useful summary.
 */
import { DataSource, EntityManager } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { ColumnRolePolicy } from '../../entities/ColumnRolePolicy';

export interface SeedDefaultPoliciesOptions {
  /**
   * If set, only seed rows for this board. Default: every board in the
   * database — used by the migration backfill.
   */
  boardId?: string;
}

export async function seedDefaultColumnRolePolicies(
  ds: DataSource | EntityManager,
  options: SeedDefaultPoliciesOptions = {},
): Promise<number> {
  const manager = ds instanceof DataSource ? ds.manager : ds;
  const colRepo = manager.getRepository(BoardColumn);
  const polRepo = manager.getRepository(ColumnRolePolicy);

  const cols = options.boardId
    ? await colRepo.find({ where: { board_id: options.boardId } })
    : await colRepo.find();
  if (cols.length === 0) return 0;

  // Group by board so we can resolve "next column by position" cheaply.
  const colsByBoard = new Map<string, BoardColumn[]>();
  for (const c of cols) {
    const list = colsByBoard.get(c.board_id) ?? [];
    list.push(c);
    colsByBoard.set(c.board_id, list);
  }

  // Pre-fetch existing rows so re-runs are no-ops. Scoped to the boards we
  // touch to keep the read minimal.
  const boardIds = Array.from(colsByBoard.keys());
  const existing = await polRepo
    .createQueryBuilder('p')
    .where('p.board_id IN (:...boardIds)', { boardIds })
    .getMany();
  const existingKey = (b: string, c: string, r: string) => `${b}::${c}::${r}`;
  const have = new Set(existing.map(p => existingKey(p.board_id, p.column_id, p.role_slug)));

  const toInsert: Array<Partial<ColumnRolePolicy>> = [];
  for (const [, group] of colsByBoard) {
    group.sort((a, b) => a.position - b.position);
    for (let i = 0; i < group.length; i++) {
      const col = group[i];
      const isTerminal = col.kind === 'terminal' || col.is_terminal === true;
      let targetColumnId = '';
      if (!isTerminal) {
        // Pick the very next column by position. Even a terminal successor
        // is a valid hop — the final move into Done is allowed.
        for (let j = i + 1; j < group.length; j++) {
          targetColumnId = group[j].id;
          break;
        }
      }
      let slugs: string[] = [];
      try {
        const parsed = JSON.parse(col.role_routing || '[]');
        if (Array.isArray(parsed)) {
          slugs = parsed.filter(s => typeof s === 'string' && s.length > 0);
        }
      } catch {
        // malformed routing — skip this column
      }
      if (slugs.length === 0) continue;
      for (const slug of slugs) {
        if (have.has(existingKey(col.board_id, col.id, slug))) continue;
        const expectedAction = isTerminal
          ? 'terminal'
          : (targetColumnId ? 'move' : 'terminal');
        toInsert.push({
          board_id: col.board_id,
          column_id: col.id,
          role_slug: slug,
          expected_action: expectedAction,
          target_column_id: isTerminal ? '' : targetColumnId,
          gate_labels: '["BLOCKED-*"]',
          max_cycles_without_progress: 4,
          on_violation: 'alert',
          enabled: true,
        });
      }
    }
  }

  if (toInsert.length === 0) return 0;
  await polRepo.save(toInsert.map(r => polRepo.create(r)));
  return toInsert.length;
}
