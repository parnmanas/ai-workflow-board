import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Board-owned reusable definitions became unreachable when catalog navigation
 * was consolidated at Workspace level. Promote every such definition in place
 * instead of deleting it: ids and all run/history references stay intact while
 * board_id becomes NULL.
 *
 * Workflow Functions are the only catalog with a workspace/key unique index.
 * If a promoted board override collides with an existing Workspace definition
 * (or another board override), keep both by deterministically suffixing the
 * promoted key before clearing board_id.
 */
export class PromoteBoardCatalogScopes1760000000069 implements MigrationInterface {
  name = 'PromoteBoardCatalogScopes1760000000069';

  private readonly scopedTables = [
    'workflow_functions',
    'actions',
    'credentials',
    'prompt_templates',
    'resources',
    'qa_scenarios',
    'qa_schedules',
    'security_profiles',
    'security_schedules',
    'workspace_schedules',
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    const failureTargetUpdates = await this.collectFailureTicketTargetUpdates(queryRunner);
    await this.repairMissingWorkspaceIds(queryRunner);
    for (const update of failureTargetUpdates) {
      await queryRunner.manager
        .createQueryBuilder()
        .update(update.table)
        .set({ on_failure_ticket: update.config })
        .where('id = :id', { id: update.id })
        .execute();
    }
    if (failureTargetUpdates.length > 0) {
      console.log(
        `[catalog-scope migration] preserved ${failureTargetUpdates.length} failure-ticket Board target(s)`,
      );
    }
    await this.promoteFunctions(queryRunner);
    await queryRunner.query('DROP INDEX IF EXISTS "uq_workflow_functions_board_key"');

    for (const table of this.scopedTables.filter((name) => name !== 'workflow_functions')) {
      if (!await queryRunner.hasTable(table) || !await queryRunner.hasColumn(table, 'board_id')) continue;
      const result = await queryRunner.manager
        .createQueryBuilder()
        .update(table)
        .set({ board_id: null })
        .where('board_id IS NOT NULL')
        .execute();
      if ((result.affected ?? 0) > 0) {
        console.log(`[catalog-scope migration] promoted ${result.affected} ${table} row(s) to Workspace scope`);
      }
    }
  }

  private async collectFailureTicketTargetUpdates(
    queryRunner: QueryRunner,
  ): Promise<Array<{ table: string; id: string; config: string }>> {
    const updates: Array<{ table: string; id: string; config: string }> = [];
    for (const table of ['qa_scenarios', 'security_profiles']) {
      if (
        !await queryRunner.hasTable(table) ||
        !await queryRunner.hasColumn(table, 'board_id') ||
        !await queryRunner.hasColumn(table, 'on_failure_ticket')
      ) continue;

      const rows: Array<{ id: string; board_id: string; on_failure_ticket: string | object | null }> =
        await queryRunner.query(
          `SELECT "id", "board_id", "on_failure_ticket" FROM "${table}" ` +
          'WHERE "board_id" IS NOT NULL AND "on_failure_ticket" IS NOT NULL',
        );
      for (const row of rows) {
        let config: any;
        try {
          config = typeof row.on_failure_ticket === 'string'
            ? JSON.parse(row.on_failure_ticket)
            : row.on_failure_ticket;
        } catch {
          throw new Error(
            `[catalog-scope migration] ${table}:${row.id} has malformed on_failure_ticket JSON; ` +
            'refusing to discard its Board target',
          );
        }
        if (!config || typeof config !== 'object' || Array.isArray(config) || config.board_id) continue;
        updates.push({
          table,
          id: row.id,
          config: JSON.stringify({ ...config, board_id: row.board_id }),
        });
      }
    }
    return updates;
  }

  private async repairMissingWorkspaceIds(queryRunner: QueryRunner): Promise<void> {
    const repairs: Array<{ table: string; id: string; workspaceId: string }> = [];
    const unresolved: Array<{ table: string; id: string; boardId: string }> = [];
    const hasBoards = await queryRunner.hasTable('boards');

    for (const table of this.scopedTables) {
      if (!await queryRunner.hasTable(table) || !await queryRunner.hasColumn(table, 'board_id')) continue;
      const rows: Array<{ id: string; board_id: string }> = await queryRunner.query(
        `SELECT "id", "board_id" FROM "${table}" WHERE "board_id" IS NOT NULL AND "workspace_id" IS NULL`,
      );
      for (const row of rows) {
        const boards: Array<{ workspace_id: string | null }> = hasBoards
          ? await queryRunner.manager
            .createQueryBuilder()
            .select('board.workspace_id', 'workspace_id')
            .from('boards', 'board')
            .where('board.id = :id', { id: row.board_id })
            .getRawMany()
          : [];
        const workspaceId = String(boards[0]?.workspace_id || '').trim();
        if (workspaceId) repairs.push({ table, id: row.id, workspaceId });
        else unresolved.push({ table, id: row.id, boardId: row.board_id });
      }
    }

    // Validate every row before writing anything. TypeORM normally wraps boot
    // migrations in a transaction, but this also keeps direct/manual execution
    // atomic with respect to validation failures.
    if (unresolved.length > 0) {
      const sample = unresolved
        .slice(0, 5)
        .map((row) => `${row.table}:${row.id} (board ${row.boardId})`)
        .join(', ');
      throw new Error(
        `[catalog-scope migration] ${unresolved.length} board-scoped row(s) have no resolvable Workspace; ` +
        `refusing to guess a destination (${sample})`,
      );
    }

    for (const repair of repairs) {
      await queryRunner.manager
        .createQueryBuilder()
        .update(repair.table)
        .set({ workspace_id: repair.workspaceId })
        .where('id = :id', { id: repair.id })
        .execute();
    }
    if (repairs.length > 0) {
      console.log(`[catalog-scope migration] repaired Workspace ownership for ${repairs.length} row(s) from their Board`);
    }
  }

  private async promoteFunctions(queryRunner: QueryRunner): Promise<void> {
    const table = 'workflow_functions';
    if (!await queryRunner.hasTable(table) || !await queryRunner.hasColumn(table, 'board_id')) return;

    const rows: Array<{ id: string; workspace_id: string; board_id: string; key: string }> =
      await queryRunner.query(
        'SELECT "id", "workspace_id", "board_id", "key" FROM "workflow_functions" ' +
        'WHERE "board_id" IS NOT NULL ORDER BY "workspace_id", "key", "board_id", "id"',
      );
    if (rows.length === 0) return;

    const existing: Array<{ workspace_id: string; key: string }> = await queryRunner.query(
      'SELECT "workspace_id", "key" FROM "workflow_functions" ' +
      'WHERE "workspace_id" IS NOT NULL AND "board_id" IS NULL',
    );
    const occupied = new Set(existing.map((row) => `${row.workspace_id}\0${row.key}`));
    let renamed = 0;

    for (const row of rows) {
      let key = row.key;
      if (occupied.has(`${row.workspace_id}\0${key}`)) {
        const base = `${row.key}-board-${String(row.board_id).slice(0, 8).toLowerCase()}`;
        key = base;
        if (occupied.has(`${row.workspace_id}\0${key}`)) {
          key = `${base}-${String(row.id).slice(0, 6).toLowerCase()}`;
        }
        let sequence = 2;
        while (occupied.has(`${row.workspace_id}\0${key}`)) {
          key = `${base}-${sequence++}`;
        }
        renamed++;
      }

      await queryRunner.manager
        .createQueryBuilder()
        .update(table)
        .set({ key, board_id: null })
        .where('id = :id', { id: row.id })
        .execute();
      occupied.add(`${row.workspace_id}\0${key}`);
    }

    console.log(
      `[catalog-scope migration] promoted ${rows.length} workflow_functions row(s) to Workspace scope` +
      (renamed ? `; renamed ${renamed} conflicting key(s)` : ''),
    );
  }

  async down(): Promise<void> {
    // The source board cannot be reconstructed after promotion. A rollback
    // must remain data-preserving, so this migration intentionally has no down.
  }
}
