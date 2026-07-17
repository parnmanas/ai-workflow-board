import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Scope-5 safety columns for the Action → ticket auto-resume flow (ticket
 * 524bb434). Adds:
 *
 *   - actions.high_impact          — deploy/publish/release classification.
 *     A failed high-impact run is NOT auto-retried by the server; the failure
 *     surfaces to the source ticket for a human decision (a bounded retry is
 *     not operation idempotency — a blind re-run of a half-completed deploy
 *     can double the external effect).
 *   - action_runs.idempotency_key  — minted once per ticket-driven run chain
 *     and carried verbatim across bounded retries so the target operation can
 *     dedupe repeated external effects.
 *
 * SQLite (dev/test) gets these via synchronize=true on the entities; this DDL
 * only runs on Postgres (production) where synchronize is disabled. Every ADD
 * COLUMN uses IF NOT EXISTS so a re-run on an already-migrated DB is a no-op.
 * Existing rows backfill to high_impact=false / idempotency_key='' — inert for
 * historical data (no run is retroactively reclassified or deduped).
 */
export class AddActionHighImpactAndIdempotency1760000000054 implements MigrationInterface {
  name = 'AddActionHighImpactAndIdempotency1760000000054';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE actions ADD COLUMN IF NOT EXISTS high_impact BOOLEAN NOT NULL DEFAULT false',
    );
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR NOT NULL DEFAULT ''",
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
