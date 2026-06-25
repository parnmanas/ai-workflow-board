import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `boards.environment_config` + `workspaces.environment_config` (ticket
 * 354d336b) — JSON text columns holding the per-board environment setup
 * override and the workspace-wide default (see common/environment-config.ts
 * for the schema and the key-level merge contract).
 *
 * SQLite (dev) gets these columns via synchronize=true on the entity. This
 * DDL only runs on Postgres (production) where synchronize is disabled.
 */
export class AddEnvironmentConfig1760000000041 implements MigrationInterface {
  name = 'AddEnvironmentConfig1760000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE boards ADD COLUMN IF NOT EXISTS environment_config TEXT DEFAULT NULL'
    );
    await queryRunner.query(
      'ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS environment_config TEXT DEFAULT NULL'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
