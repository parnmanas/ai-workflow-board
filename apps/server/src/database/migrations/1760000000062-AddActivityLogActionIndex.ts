import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the composite `(action, field_changed)` index `activity_logs` was
 * still missing after 1760000000027 (ticket 3970db66 review — P1 blocker).
 *
 * `RespawnStormDetectorService.getSuppressionStats()` runs three queries
 * filtered on `action` (`respawn_storm_halted` count, `respawn_twin_detected`
 * count, `comment_pingpong_suppressed` grouped by `field_changed`) on every
 * `/api/admin/workflow-health` rollup call — which the dashboard polls every
 * 15s. None of the four indices from 1760000000027 lead with `action`, so
 * all three degraded to a sequential scan of the largest table in the
 * database, three times a poll cycle. This index leads with `action` and
 * trails with `field_changed` so the by-reason GROUP BY is covered too.
 *
 * Same CONCURRENTLY / dual-backend shape as 1760000000027 — see that
 * migration for the full rationale (NAS spinning-disk lock avoidance on an
 * unbounded, already-large table).
 */
export class AddActivityLogActionIndex1760000000062 implements MigrationInterface {
  name = 'AddActivityLogActionIndex1760000000062';

  // CREATE INDEX CONCURRENTLY must run outside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_action_field ' +
      'ON activity_logs (action, field_changed)'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_action_field');
  }
}
