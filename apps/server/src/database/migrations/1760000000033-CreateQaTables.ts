import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the qa_scenarios and qa_runs tables for the scenario-based QA
 * feature. In dev (sql.js) synchronize:true auto-creates the tables from the
 * entity definitions, so this migration is a no-op there and only runs DDL on
 * Postgres (production). All statements are IF NOT EXISTS / idempotent so they
 * are harmless even if synchronize already produced the schema.
 *
 * JSON columns are stored as TEXT (TypeORM `simple-json`) on both backends.
 */
export class CreateQaTables1760000000033 implements MigrationInterface {
  name = 'CreateQaTables1760000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; tables auto-created from entities.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qa_scenarios (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        name VARCHAR NOT NULL,
        description VARCHAR NOT NULL DEFAULT '',
        steps TEXT NULL,
        target_agent_id VARCHAR NOT NULL,
        qa_driver VARCHAR NOT NULL DEFAULT '',
        qa_driver_config TEXT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        tags TEXT NULL,
        created_by VARCHAR NOT NULL DEFAULT '',
        max_runs INTEGER NOT NULL DEFAULT 20,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_qa_scenarios_ws_board ON qa_scenarios(workspace_id, board_id)'
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qa_runs (
        id UUID PRIMARY KEY,
        scenario_id VARCHAR NOT NULL,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        status VARCHAR NOT NULL DEFAULT 'pending',
        room_id VARCHAR NOT NULL DEFAULT '',
        step_results TEXT NULL,
        artifact_resource_ids TEXT NULL,
        summary TEXT NOT NULL DEFAULT '',
        triggered_by_type VARCHAR NOT NULL DEFAULT 'user',
        triggered_by_id VARCHAR NOT NULL DEFAULT '',
        started_at TIMESTAMP NULL,
        finished_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_qa_runs_scenario_time ON qa_runs(scenario_id, created_at DESC)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
