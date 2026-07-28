import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWorkflowFunctions1760000000067 implements MigrationInterface {
  name = 'CreateWorkflowFunctions1760000000067';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_functions (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NULL,
        key VARCHAR NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        name VARCHAR NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        executor_type VARCHAR NOT NULL DEFAULT 'builtin',
        input_schema TEXT NOT NULL DEFAULT '{}',
        output_schema TEXT NOT NULL DEFAULT '{}',
        config TEXT NOT NULL DEFAULT '{}',
        risk_level VARCHAR NOT NULL DEFAULT 'read',
        idempotency_mode VARCHAR NOT NULL DEFAULT 'none',
        timeout_ms INTEGER NOT NULL DEFAULT 300000,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        approval_policy VARCHAR NOT NULL DEFAULT 'none',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        builtin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_function_runs (
        id UUID PRIMARY KEY,
        function_id VARCHAR NOT NULL,
        function_key VARCHAR NOT NULL,
        function_version INTEGER NOT NULL DEFAULT 1,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        ticket_id VARCHAR NULL,
        parent_run_id VARCHAR NULL,
        actor_type VARCHAR NOT NULL DEFAULT 'system',
        actor_id VARCHAR NOT NULL DEFAULT '',
        actor_name VARCHAR NOT NULL DEFAULT '',
        status VARCHAR NOT NULL DEFAULT 'running',
        inputs TEXT NOT NULL DEFAULT '{}',
        outputs TEXT NOT NULL DEFAULT '{}',
        evidence TEXT NOT NULL DEFAULT '{}',
        idempotency_key VARCHAR NOT NULL DEFAULT '',
        error_code VARCHAR NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_functions_global_key ON workflow_functions(key) WHERE workspace_id IS NULL');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_functions_workspace_key ON workflow_functions(workspace_id, key) WHERE workspace_id IS NOT NULL');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_workflow_function_runs_function_created ON workflow_function_runs(function_id, created_at)');
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_workflow_function_runs_ticket_created ON workflow_function_runs(workspace_id, ticket_id, created_at)');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
