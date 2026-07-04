import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cross-board handoff pipeline (ticket ac21a745). Adds the three columns the
 * relay needs to the tickets table:
 *
 *   - tickets.handoff_spec              — JSON relay definition ('' = none)
 *   - tickets.handoff_dispatched_at     — idempotency stamp (once per terminal entry)
 *   - tickets.handoff_source_ticket_id  — relay lineage back-pointer ('' = not a follow-up)
 *
 * SQLite (dev) gets these via synchronize=true on the entity. This DDL only runs
 * on Postgres (production) where synchronize is disabled. All three use ADD
 * COLUMN IF NOT EXISTS so a re-run on an already-migrated DB is a no-op. The two
 * varchar columns default to '' (safe backfill for existing rows — reads as
 * "no handoff"); the timestamp defaults to NULL.
 */
export class AddCrossBoardHandoff1760000000048 implements MigrationInterface {
  name = 'AddCrossBoardHandoff1760000000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS handoff_spec VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS handoff_dispatched_at TIMESTAMP DEFAULT NULL',
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS handoff_source_ticket_id VARCHAR NOT NULL DEFAULT ''",
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
