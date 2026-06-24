import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the on-failure auto-ticket columns:
 *   - qa_scenarios.on_failure_ticket (TEXT / simple-json) — the policy config.
 *   - qa_runs.auto_ticket_id (VARCHAR) — run-level idempotency guard / link to
 *     the auto-filed fix ticket.
 *
 * In dev (sql.js) synchronize:true auto-adds the columns from the entity
 * definitions, so this migration is a Postgres-only no-op there. All statements
 * are IF NOT EXISTS / idempotent and harmless if synchronize already added them.
 */
export class AddQaOnFailureTicket1760000000037 implements MigrationInterface {
  name = 'AddQaOnFailureTicket1760000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; columns auto-added from entities.
      return;
    }
    await queryRunner.query(
      'ALTER TABLE qa_scenarios ADD COLUMN IF NOT EXISTS on_failure_ticket TEXT NULL'
    );
    await queryRunner.query(
      'ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS auto_ticket_id VARCHAR NULL'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('ALTER TABLE qa_scenarios DROP COLUMN IF EXISTS on_failure_ticket');
    await queryRunner.query('ALTER TABLE qa_runs DROP COLUMN IF EXISTS auto_ticket_id');
  }
}
