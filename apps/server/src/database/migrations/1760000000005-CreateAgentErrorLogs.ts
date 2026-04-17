import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the agent_error_logs table and adds Agent.last_error_upload_at for
 * the agent error log upload feature (C1). In dev (sql.js) synchronize:true
 * handles entity + column creation, so this migration is a no-op there and
 * only runs DDL on Postgres (production) where synchronize is disabled.
 */
export class CreateAgentErrorLogs1760000000005 implements MigrationInterface {
  name = 'CreateAgentErrorLogs1760000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; entity + column auto-created
      return;
    }
    await queryRunner.query(
      'ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_error_upload_at TIMESTAMP NULL'
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_error_logs (
        id UUID PRIMARY KEY,
        agent_id VARCHAR NOT NULL,
        workspace_id VARCHAR NULL,
        occurred_at TIMESTAMP NOT NULL,
        level VARCHAR NOT NULL,
        category VARCHAR NOT NULL,
        message TEXT NOT NULL,
        raw_line TEXT NULL,
        pid VARCHAR NULL,
        plugin_version VARCHAR NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_agent_error_logs_agent_time ON agent_error_logs(agent_id, occurred_at DESC)'
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_agent_error_logs_level ON agent_error_logs(level)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
