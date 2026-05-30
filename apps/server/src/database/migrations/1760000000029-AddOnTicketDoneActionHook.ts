import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * On-ticket-done Action hook (ticket 16a6339c). Adds the four columns the
 * lifecycle hook needs:
 *
 *   - actions.trigger        — '' (legacy cron/manual) | 'on_ticket_done'
 *   - actions.trigger_label  — optional label-scope filter for the hook
 *   - tickets.on_done_action_ids   — JSON array of per-ticket bound action ids
 *   - tickets.on_done_dispatched_at — idempotency stamp (once per terminal entry)
 *
 * SQLite (dev) gets these via synchronize=true on the entities. This DDL only
 * runs on Postgres (production) where synchronize is disabled. All four use
 * ADD COLUMN IF NOT EXISTS so a re-run on an already-migrated DB is a no-op.
 */
export class AddOnTicketDoneActionHook1760000000029 implements MigrationInterface {
  name = 'AddOnTicketDoneActionHook1760000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    // "trigger" is quoted — it collides with the TRIGGER keyword. TypeORM
    // double-quotes identifiers in its own generated SQL, so the entity column
    // works; this raw DDL has to quote it explicitly too.
    await queryRunner.query(
      'ALTER TABLE actions ADD COLUMN IF NOT EXISTS "trigger" VARCHAR NOT NULL DEFAULT \'\'',
    );
    await queryRunner.query(
      "ALTER TABLE actions ADD COLUMN IF NOT EXISTS trigger_label VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS on_done_action_ids VARCHAR NOT NULL DEFAULT '[]'",
    );
    await queryRunner.query(
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS on_done_dispatched_at TIMESTAMP DEFAULT NULL',
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
