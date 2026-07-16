import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Action → ticket auto-resume linkage (ticket 524bb434). Adds the columns the
 * run lifecycle needs to tie an Action Run back to the ticket that dispatched
 * it and to drive the "run finished → resume the original ticket" flow:
 *
 *   - action_runs.source_ticket_id — the dispatching ticket ('' = none)
 *   - action_runs.status           — 'running' | 'succeeded' | 'failed'
 *   - action_runs.result_summary   — completing agent's outcome text
 *   - action_runs.attempt          — 1-based retry counter (retry cap bound)
 *   - action_runs.completed_at     — terminal-transition stamp (NULL = in flight)
 *
 * SQLite (dev/test) gets these via synchronize=true on the ActionRun entity;
 * this DDL only runs on Postgres (production) where synchronize is disabled.
 * Every ADD COLUMN uses IF NOT EXISTS so a re-run on an already-migrated DB is
 * a no-op. Existing rows backfill to status='running' (inert — they are never
 * auto-completed) with an empty source_ticket_id, so no historical run is
 * mistaken for a resumable one.
 */
export class AddActionRunResume1760000000053 implements MigrationInterface {
  name = 'AddActionRunResume1760000000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS source_ticket_id VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS status VARCHAR NOT NULL DEFAULT 'running'",
    );
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS result_summary TEXT NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      'ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1',
    );
    await queryRunner.query(
      'ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL',
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
