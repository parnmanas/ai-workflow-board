import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds boards.max_concurrent_tickets_per_agent (default 1). Default 1
 * matches the previous implicit behavior the operator was conveying via
 * planner role prompt; existing boards keep that contract without
 * surprise. SQLite (dev) picks the column up via synchronize=true; this
 * migration only runs DDL on Postgres (prod).
 */
export class AddBoardMaxConcurrentTicketsPerAgent1760000000012 implements MigrationInterface {
  name = 'AddBoardMaxConcurrentTicketsPerAgent1760000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE boards ADD COLUMN IF NOT EXISTS max_concurrent_tickets_per_agent INTEGER NOT NULL DEFAULT 1'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
