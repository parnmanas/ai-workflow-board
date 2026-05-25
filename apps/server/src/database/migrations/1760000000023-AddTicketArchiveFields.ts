import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `tickets.archived_at` / `tickets.terminal_entered_at` columns and
 * the `boards.auto_archive_days` column used by the ticket auto-archive
 * feature (ticket 9b44526b).
 *
 * SQLite (dev) gets these via synchronize=true on the entities. This DDL only
 * runs on Postgres (production) where synchronize is disabled.
 *
 * Backfill for terminal_entered_at: existing tickets that currently sit on a
 * terminal column (BoardColumn.is_terminal=true OR kind='terminal') are
 * backfilled with `updated_at` as a conservative fallback — never EARLIER
 * than the actual entry time, so the archiver waits at least the full
 * configured window before it touches a previously-done ticket on the first
 * archiver tick after the operator flips the toggle.
 */
export class AddTicketArchiveFields1760000000023 implements MigrationInterface {
  name = 'AddTicketArchiveFields1760000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP DEFAULT NULL"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS terminal_entered_at TIMESTAMP DEFAULT NULL"
    );
    await queryRunner.query(
      "ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_archive_days INTEGER DEFAULT NULL"
    );

    // Backfill terminal_entered_at for tickets already sitting on a terminal
    // column. Conservative fallback: use updated_at — never earlier than the
    // real entry time, so the archiver gives the operator the full configured
    // grace window on the first tick after enabling auto-archive.
    await queryRunner.query(`
      UPDATE tickets t
      SET terminal_entered_at = t.updated_at
      FROM columns c
      WHERE t.column_id = c.id
        AND t.terminal_entered_at IS NULL
        AND t.archived_at IS NULL
        AND (c.is_terminal = true OR c.kind = 'terminal')
    `);

    // Partial index for the hot read path: active-ticket queries all filter
    // on `archived_at IS NULL`. Postgres-only; SQLite filters fine on the
    // small dev data set without the index.
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_tickets_active ON tickets (column_id) WHERE archived_at IS NULL"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
