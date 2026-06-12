import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `boards.harness_config` + `workspaces.harness_config` (ticket
 * 7122600c) — JSON text columns holding the per-board agent harness override
 * and the workspace-wide default (see common/harness-config.ts for the
 * schema and the key-level resolve contract).
 *
 * SQLite (dev) gets these columns via synchronize=true on the entity. This
 * DDL only runs on Postgres (production) where synchronize is disabled.
 */
export class AddHarnessConfig1760000000032 implements MigrationInterface {
  name = 'AddHarnessConfig1760000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE boards ADD COLUMN IF NOT EXISTS harness_config TEXT DEFAULT NULL'
    );
    await queryRunner.query(
      'ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS harness_config TEXT DEFAULT NULL'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
