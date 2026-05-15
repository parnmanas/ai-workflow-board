import { MigrationInterface, QueryRunner } from 'typeorm';
import { seedDefaultColumnRolePolicies } from '../../modules/column-policies/seed-helper';

/**
 * v0.42 — ColumnRolePolicy (ticket f886ada7). Declarative "what should
 * happen in this column×role cycle" layered on top of the existing
 * stuck-WAIT detector. PR #2 of the epic — seeds the alert path only.
 *
 *   1. Creates the `column_role_policies` table (Postgres DDL only —
 *      synchronize:true handles SQLite at boot).
 *
 *   2. Seeds default rows for every existing (board, column, role) tuple
 *      derived from `BoardColumn.role_routing`. Logic lives in
 *      `seedDefaultColumnRolePolicies` so DatabaseModule's first-run
 *      bootstrap can call the same code path.
 *
 * Idempotent — `seedDefaultColumnRolePolicies` skips any (board, column,
 * role) tuple that already has a row, so re-runs / partial inserts are safe.
 */
export class CreateColumnRolePolicies1760000000017 implements MigrationInterface {
  name = 'CreateColumnRolePolicies1760000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      // Defensive DDL — synchronize:true would have created the table on
      // SQLite (and on Postgres if it was enabled at boot), but the
      // production migration runner sometimes lands first.
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS column_role_policies (
          id UUID PRIMARY KEY,
          board_id VARCHAR NOT NULL,
          column_id VARCHAR NOT NULL,
          role_slug VARCHAR NOT NULL,
          expected_action VARCHAR NOT NULL DEFAULT 'move',
          target_column_id VARCHAR NOT NULL DEFAULT '',
          gate_labels TEXT NOT NULL DEFAULT '["BLOCKED-*"]',
          max_cycles_without_progress INTEGER NOT NULL DEFAULT 4,
          on_violation VARCHAR NOT NULL DEFAULT 'alert',
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      await queryRunner.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_crp_board_column_role ON column_role_policies(board_id, column_id, role_slug)'
      );
      await queryRunner.query(
        'CREATE INDEX IF NOT EXISTS idx_crp_column_role ON column_role_policies(column_id, role_slug)'
      );
    }

    const inserted = await seedDefaultColumnRolePolicies(queryRunner.manager);
    console.log(
      `[v0.42 migration] column_role_policies seeded: ${inserted} new row(s) ` +
      `(existing rows preserved)`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data migration — no inverse. The table can be safely truncated
    // manually if a rollback is needed; the runtime treats a missing row
    // as "no policy" (= identical to today's behaviour).
  }
}
