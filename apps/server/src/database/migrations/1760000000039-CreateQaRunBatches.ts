import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates qa_run_batches (sequential manual QA batch run) and adds the
 * batch_id / batch_index link columns to qa_runs.
 *
 * Same shape as CreateQaTables: in dev (sql.js) synchronize:true auto-creates
 * everything from the entity definitions, so this only runs DDL on Postgres
 * (production). All statements are IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so
 * they are harmless even if synchronize already produced the schema.
 *
 * JSON columns (scenario_ids / run_ids) are TEXT (TypeORM `simple-json`).
 */
export class CreateQaRunBatches1760000000039 implements MigrationInterface {
  name = 'CreateQaRunBatches1760000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; tables/columns auto-created from entities.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qa_run_batches (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        scenario_ids TEXT NULL,
        run_ids TEXT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        status VARCHAR NOT NULL DEFAULT 'running',
        stop_on_fail BOOLEAN NOT NULL DEFAULT FALSE,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        errored INTEGER NOT NULL DEFAULT 0,
        triggered_by_type VARCHAR NOT NULL DEFAULT 'user',
        triggered_by_id VARCHAR NOT NULL DEFAULT '',
        finished_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_qa_run_batches_ws_time ON qa_run_batches(workspace_id, created_at)'
    );

    await queryRunner.query('ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS batch_id VARCHAR NULL');
    await queryRunner.query('ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS batch_index INTEGER NULL');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
