import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates qa_schedules (automatic QA batch trigger layer — ticket b6bb7efd).
 *
 * Same shape as CreateQaRunBatches: in dev (sql.js) synchronize:true
 * auto-creates everything from the entity definition, so this only runs DDL on
 * Postgres (production). All statements are IF NOT EXISTS so they are harmless
 * even if synchronize already produced the schema.
 *
 * The JSON column (scenario_ids) is TEXT (TypeORM `simple-json`).
 */
export class CreateQaSchedules1760000000040 implements MigrationInterface {
  name = 'CreateQaSchedules1760000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; table auto-created from the entity.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qa_schedules (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        name VARCHAR NOT NULL,
        scope VARCHAR NOT NULL DEFAULT 'all',
        scenario_ids TEXT NULL,
        cron VARCHAR NULL,
        interval_ms INTEGER NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        stop_on_fail BOOLEAN NOT NULL DEFAULT FALSE,
        next_run_at TIMESTAMP NULL,
        last_run_at TIMESTAMP NULL,
        last_batch_id VARCHAR NULL,
        triggered_by_type VARCHAR NOT NULL DEFAULT 'user',
        created_by VARCHAR NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_qa_schedules_ws_enabled ON qa_schedules(workspace_id, enabled)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
