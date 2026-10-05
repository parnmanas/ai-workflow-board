import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates automation_schedules (general-purpose agent-task scheduler — ticket
 * 8845be79). Same shape/rationale as CreateQaSchedules: in dev (sql.js)
 * synchronize:true auto-creates the table from the entity, so this only runs DDL
 * on Postgres (production). All statements are IF NOT EXISTS so they are harmless
 * even if synchronize already produced the schema.
 *
 * task_prompt is TEXT (free-form multi-line prompt).
 */
export class CreateWorkspaceSchedules1760000000043 implements MigrationInterface {
  name = 'CreateWorkspaceSchedules1760000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; table auto-created from the entity.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS automation_schedules (
        id UUID PRIMARY KEY,
        account_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        name VARCHAR NOT NULL,
        target_agent_id VARCHAR NOT NULL,
        task_prompt TEXT NOT NULL DEFAULT '',
        cron VARCHAR NULL,
        interval_ms INTEGER NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        next_run_at TIMESTAMP NULL,
        last_run_at TIMESTAMP NULL,
        last_room_id VARCHAR NULL,
        triggered_by_type VARCHAR NOT NULL DEFAULT 'user',
        created_by VARCHAR NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_automation_schedules_ws_enabled ON automation_schedules(account_id, enabled)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
