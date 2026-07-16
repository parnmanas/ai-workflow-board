import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates action_approvals (ticket 524bb434, scope 5) — the human-created,
 * one-time, (action_id, source_ticket_id)-bound approval GRANT that the
 * pre-execution approval gate in ActionsService.dispatch atomically consumes
 * before a high-impact ticket-driven run may execute.
 *
 * Same shape as the other Create* migrations: dev (sql.js) uses synchronize:true
 * and auto-creates this table from the ActionApproval entity, so the DDL only
 * runs on Postgres (production, synchronize disabled). CREATE TABLE / CREATE
 * INDEX IF NOT EXISTS make a re-run — or a run after synchronize already built
 * the table — a harmless no-op.
 */
export class CreateActionApprovals1760000000056 implements MigrationInterface {
  name = 'CreateActionApprovals1760000000056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; the table is auto-created from the entity.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS action_approvals (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        action_id VARCHAR NOT NULL,
        source_ticket_id VARCHAR NOT NULL,
        approved_by VARCHAR NOT NULL,
        approved_by_name VARCHAR NOT NULL DEFAULT '',
        status VARCHAR NOT NULL DEFAULT 'pending',
        consumed_by_run_id VARCHAR NOT NULL DEFAULT '',
        consumed_at TIMESTAMP NULL,
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    // The gate looks up a pending grant by (action_id, source_ticket_id, status);
    // index that lookup so the consume path stays O(log n) under many stale
    // consumed rows.
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_action_approvals_lookup ON action_approvals(action_id, source_ticket_id, status)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
