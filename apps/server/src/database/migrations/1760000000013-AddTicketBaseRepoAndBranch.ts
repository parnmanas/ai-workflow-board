import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the per-ticket base-repo binding columns:
 *   - tickets.base_repo_resource_id  (FK by id to resources, plain varchar)
 *   - tickets.base_branch
 *   - resources.default_branch       (only meaningful for type='repository')
 *
 * SQLite (dev) gets these via synchronize=true on the entity definitions;
 * this migration only runs DDL on Postgres (production) where synchronize
 * is disabled.
 */
export class AddTicketBaseRepoAndBranch1760000000013 implements MigrationInterface {
  name = 'AddTicketBaseRepoAndBranch1760000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS base_repo_resource_id VARCHAR NOT NULL DEFAULT ''"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS base_branch VARCHAR NOT NULL DEFAULT ''"
    );
    await queryRunner.query(
      "ALTER TABLE resources ADD COLUMN IF NOT EXISTS default_branch VARCHAR NOT NULL DEFAULT ''"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
