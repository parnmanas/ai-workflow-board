import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the four composite indices that `activity_logs` was missing since
 * day one. The table is unbounded (every column move / claim / release /
 * comment / trigger_emitted / backlog_promotion_* writes a row), and the
 * service code grew read patterns that filter by ticket_id, workspace_id,
 * (entity_type, entity_id), and actor_id — none of which were indexed.
 * Every such query degraded to a sequential scan, which on a NAS host
 * with a spinning disk pinned disk I/O at 100% utilisation once the table
 * crossed ~10⁵ rows. Symptom: every HTTP request, agent trigger, and
 * sweep tick competed for the same disk queue and slowed in lockstep.
 *
 * See ActivityLog entity for the read-pattern catalogue that drove the
 * composite shapes.
 *
 * Concurrency:
 *   `CREATE INDEX CONCURRENTLY` runs without taking an ACCESS EXCLUSIVE
 *   lock — the table stays readable+writable while the index builds. On
 *   a large bloated activity_logs this is the only safe choice; a normal
 *   `CREATE INDEX` blocks all writes for the entire build duration,
 *   which on a 100%-busy NAS disk can be minutes. CONCURRENTLY requires
 *   running OUTSIDE a transaction, hence `transaction = false` below;
 *   it does a two-pass scan, so the build itself is slower than the
 *   non-concurrent form, but the production board stays responsive
 *   throughout. `IF NOT EXISTS` makes the migration idempotent so an
 *   interrupted run (CONCURRENTLY rolls back to an INVALID index on
 *   error — visible in pg_index) is safe to re-attempt after a manual
 *   `DROP INDEX <name>`.
 *
 * SQLite (dev): no-op. The @Index decorators on the entity drive
 *   synchronize=true to create equivalent indices automatically on every
 *   restart, so dev databases match production's shape.
 */
export class AddActivityLogIndices1760000000027 implements MigrationInterface {
  name = 'AddActivityLogIndices1760000000027';

  // Required for `CREATE INDEX CONCURRENTLY` — Postgres rejects it inside
  // a transaction block. TypeORM honours this flag by running the up/down
  // body outside the implicit BEGIN..COMMIT it normally wraps migrations
  // in. Side effect: a partial migration leaves whichever indices already
  // landed in place, and the rest are recreated by `IF NOT EXISTS` on the
  // next attempt — no rollback bookkeeping needed.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_ticket_created ' +
      'ON activity_logs (ticket_id, created_at)'
    );
    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_workspace_created ' +
      'ON activity_logs (workspace_id, created_at)'
    );
    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_entity ' +
      'ON activity_logs (entity_type, entity_id, created_at)'
    );
    await queryRunner.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_logs_actor_created ' +
      'ON activity_logs (actor_id, created_at)'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    // DROP INDEX CONCURRENTLY is also out-of-transaction; mirror the up
    // path so a rollback on a live system doesn't take the table down.
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_actor_created');
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_entity');
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_workspace_created');
    await queryRunner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_logs_ticket_created');
  }
}
