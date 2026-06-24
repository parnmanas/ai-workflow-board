import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QA → fix → QA closed loop (ticket 467dbc7a). Adds the two columns the
 * deterministic rerun-on-fix hook needs:
 *
 *   - qa_runs.rerun_generation        — rerun generation counter (0 = first run).
 *   - tickets.qa_rerun_dispatched_at  — idempotency stamp for QaRerunOnFixService
 *                                       (a SEPARATE stamp from on_done_dispatched_at
 *                                       so the on-done hook and the QA rerun hook
 *                                       don't starve each other on the same entry).
 *
 * SQLite (dev) gets these via synchronize=true on the entities; this DDL only
 * runs on Postgres (production) where synchronize is disabled. Both use ADD
 * COLUMN IF NOT EXISTS so a re-run on an already-migrated DB is a no-op.
 */
export class AddQaRerunOnFix1760000000038 implements MigrationInterface {
  name = 'AddQaRerunOnFix1760000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS rerun_generation INTEGER NOT NULL DEFAULT 0',
    );
    await queryRunner.query(
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS qa_rerun_dispatched_at TIMESTAMP DEFAULT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('ALTER TABLE qa_runs DROP COLUMN IF EXISTS rerun_generation');
    await queryRunner.query('ALTER TABLE tickets DROP COLUMN IF EXISTS qa_rerun_dispatched_at');
  }
}
