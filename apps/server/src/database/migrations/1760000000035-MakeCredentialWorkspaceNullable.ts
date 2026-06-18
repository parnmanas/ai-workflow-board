import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make `credentials.workspace_id` nullable so a NULL marks a GLOBAL
 * (instance-level) credential shared across every workspace (ticket
 * b00bff52). Mirrors the Agent.workspace_id nullable transition
 * (migrations 018/019).
 *
 * SQLite (dev) picks the nullable column up via synchronize=true on the
 * entity (it rebuilds the table). This DDL only runs on Postgres
 * (production), where the documented risk is that synchronize won't issue
 * `DROP NOT NULL` against an existing column (see database.module.ts).
 *
 * Non-destructive: every existing row already carries a workspace_id, so
 * dropping the NOT NULL constraint changes no data. Idempotent — DROP NOT
 * NULL on an already-nullable column is a no-op.
 */
export class MakeCredentialWorkspaceNullable1760000000035 implements MigrationInterface {
  name = 'MakeCredentialWorkspaceNullable1760000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE credentials ALTER COLUMN workspace_id DROP NOT NULL'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    // Re-asserting NOT NULL would fail if any global credential exists; drop
    // those rows first so the inverse is at least applicable. Global
    // credentials have no faithful per-workspace home to restore.
    await queryRunner.query('DELETE FROM credentials WHERE workspace_id IS NULL');
    await queryRunner.query(
      'ALTER TABLE credentials ALTER COLUMN workspace_id SET NOT NULL'
    );
  }
}
