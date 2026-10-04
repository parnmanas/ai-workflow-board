import { DataSource, DataSourceOptions, QueryRunner, Table } from 'typeorm';

/**
 * Board removal, phase 1 of 2 (docs/tickets.md) — runs BEFORE TypeORM
 * synchronize.
 *
 * synchronize is always on (db.ts D-01): the moment the entities stop
 * declaring `tickets.column_id`, `tickets.base_repo_resource_id`,
 * `tickets.labels` and the repository columns of `resources`, the next boot
 * drops them — taking the only record of which board/column a ticket was on
 * and which repository it built against. This step copies exactly those
 * values into two snapshot tables that synchronize does not know about.
 * Phase 2 (migration 1760000000091-BoardlessTickets, after synchronize)
 * turns the snapshots into ticket status / tags / project and projects, then
 * drops the snapshots together with the retired board tables.
 *
 * Also clears two dedupe-only states whose unique keys change shape and would
 * otherwise make synchronize fail to build the new unique index:
 * board-scoped skill assignments and CI-red alert rows.
 *
 * Idempotent: once `tickets.column_id` is gone there is nothing to snapshot,
 * and an existing snapshot is never overwritten.
 */
export const BOARD_REMOVAL_TICKET_SNAPSHOT = 'board_removal_ticket_snapshot';
export const BOARD_REMOVAL_REPO_SNAPSHOT = 'board_removal_repo_snapshot';

export async function preSyncBoardRemoval(options: DataSourceOptions): Promise<void> {
  const source = new DataSource({ ...options, entities: [], subscribers: [], migrations: [], synchronize: false, migrationsRun: false } as DataSourceOptions);
  await source.initialize();
  try {
    const runner = source.createQueryRunner();
    try {
      const changed = await snapshot(runner);
      if (changed && source.options.type === 'sqljs') await (source as any).sqljsManager.saveDatabase();
    } finally {
      await runner.release();
    }
  } finally {
    await source.destroy();
  }
}

async function snapshot(runner: QueryRunner): Promise<boolean> {
  let changed = false;
  const text = 'text';
  const key = 'varchar';

  if (await runner.hasTable('tickets') && await runner.hasColumn('tickets', 'column_id')
    && !await runner.hasTable(BOARD_REMOVAL_TICKET_SNAPSHOT)) {
    const hasRepo = await runner.hasColumn('tickets', 'base_repo_resource_id');
    const hasLabels = await runner.hasColumn('tickets', 'labels');
    await runner.startTransaction();
    try {
      await runner.createTable(new Table({
        name: BOARD_REMOVAL_TICKET_SNAPSHOT,
        columns: [
          { name: 'ticket_id', type: key, isPrimary: true },
          { name: 'column_id', type: key, isNullable: true },
          { name: 'base_repo_resource_id', type: key, isNullable: true },
          { name: 'labels', type: text, isNullable: true },
        ],
      }));
      await runner.query(
        `INSERT INTO "${BOARD_REMOVAL_TICKET_SNAPSHOT}" (ticket_id, column_id, base_repo_resource_id, labels) ` +
        `SELECT CAST(id AS VARCHAR), CAST(column_id AS VARCHAR), ${hasRepo ? 'base_repo_resource_id' : 'NULL'}, ${hasLabels ? 'labels' : "'[]'"} FROM tickets`,
      );
      await runner.commitTransaction();
      changed = true;
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    }
  }

  if (await runner.hasTable('resources') && await runner.hasColumn('resources', 'default_branch')
    && !await runner.hasTable(BOARD_REMOVAL_REPO_SNAPSHOT)) {
    const hasPolicy = await runner.hasColumn('resources', 'clone_policy');
    await runner.startTransaction();
    try {
      await runner.createTable(new Table({
        name: BOARD_REMOVAL_REPO_SNAPSHOT,
        columns: [
          { name: 'id', type: key, isPrimary: true },
          { name: 'workspace_id', type: key, isNullable: true },
          { name: 'credential_id', type: key, isNullable: true },
          { name: 'name', type: key, isNullable: true },
          { name: 'description', type: text, isNullable: true },
          { name: 'url', type: text, isNullable: true },
          { name: 'default_branch', type: key, isNullable: true },
          { name: 'clone_policy', type: text, isNullable: true },
        ],
      }));
      await runner.query(
        `INSERT INTO "${BOARD_REMOVAL_REPO_SNAPSHOT}" (id, workspace_id, credential_id, name, description, url, default_branch, clone_policy) ` +
        `SELECT CAST(id AS VARCHAR), workspace_id, credential_id, name, description, url, default_branch, ${hasPolicy ? 'clone_policy' : 'NULL'} ` +
        `FROM resources WHERE type = 'repository'`,
      );
      await runner.commitTransaction();
      changed = true;
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    }
  }

  // Outreach channels filed into a target board; phase 2 turns it into tags + project.
  if (await runner.hasTable('outreach_channels') && await runner.hasColumn('outreach_channels', 'target_board_id')
    && !await runner.hasTable('board_removal_outreach_targets')) {
    await runner.createTable(new Table({
      name: 'board_removal_outreach_targets',
      columns: [
        { name: 'id', type: key, isPrimary: true },
        { name: 'target_board_id', type: key, isNullable: true },
      ],
    }));
    await runner.query(
      'INSERT INTO board_removal_outreach_targets (id, target_board_id) ' +
      'SELECT CAST(id AS VARCHAR), target_board_id FROM outreach_channels WHERE target_board_id IS NOT NULL',
    );
    changed = true;
  }

  // Skill assignments used to be scoped by (board, role). Both axes are gone;
  // keep only unscoped rows, one per (workspace, runtime, skill), so the
  // narrower unique index synchronize builds next cannot collide.
  if (await runner.hasTable('runtime_skill_assignments') && await runner.hasColumn('runtime_skill_assignments', 'board_id')) {
    await runner.query(`DELETE FROM runtime_skill_assignments WHERE COALESCE(board_id, '') <> '' OR COALESCE(role_slug, '') <> ''`);
    changed = true;
  }

  // CI-red alerts were keyed by board; the key is now the project. The rows
  // are only dedupe/cooldown state for an ongoing red streak — the next sweep
  // re-derives them.
  if (await runner.hasTable('ci_red_alerts') && await runner.hasColumn('ci_red_alerts', 'board_id')) {
    await runner.query('DELETE FROM ci_red_alerts');
    changed = true;
  }

  return changed;
}
