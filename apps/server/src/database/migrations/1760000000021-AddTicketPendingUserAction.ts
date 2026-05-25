import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `tickets.pending_user_action` flag (+ reason / set_at / set_by
 * companions) used by the ticket-blocking-improvements ticket (a57517be).
 *
 * SQLite (dev) gets these columns via synchronize=true on the entity. This
 * DDL only runs on Postgres (production) where synchronize is disabled.
 */
export class AddTicketPendingUserAction1760000000021 implements MigrationInterface {
  name = 'AddTicketPendingUserAction1760000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_user_action BOOLEAN NOT NULL DEFAULT false"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_reason TEXT NOT NULL DEFAULT ''"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_set_at TIMESTAMP DEFAULT NULL"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_set_by VARCHAR NOT NULL DEFAULT ''"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
