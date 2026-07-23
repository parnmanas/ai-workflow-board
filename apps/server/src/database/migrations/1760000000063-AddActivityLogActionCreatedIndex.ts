import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the composite `(action, created_at)` index `activity_logs` was still
 * missing after 1760000000062 (ticket 6dd3f968 — token/cost usage dashboard).
 *
 * `AgentUsageService.getTokenUsageStats()` runs a windowed suppression-count
 * query — `WHERE action IN (...) AND created_at BETWEEN ? AND ?` — as part of
 * the same `/api/admin/workflow-health` rollup the dashboard polls every 15s.
 * `idx_activity_logs_action_field` (action, field_changed) leads with the
 * same `action` column but cannot serve the `created_at` range past it, so
 * without this index the query falls back to an index-scan-then-filter over
 * every row that ever carried a suppression action, not just the window —
 * the same class of bug 1760000000062 fixed for the lifetime-cumulative
 * suppression counts, recurring here for the windowed variant.
 *
 * Same CONCURRENTLY / dual-backend shape as 1760000000027 / 1760000000062 —
 * see 1760000000027 for the full NAS spinning-disk lock-avoidance rationale.
 */
export class AddActivityLogActionCreatedIndex1760000000063 implements MigrationInterface {
  name = 'AddActivityLogActionCreatedIndex1760000000063';

  // CREATE INDEX CONCURRENTLY must run outside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_action_created ' +
      'ON activity_logs (action, created_at)'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_action_created');
  }
}
