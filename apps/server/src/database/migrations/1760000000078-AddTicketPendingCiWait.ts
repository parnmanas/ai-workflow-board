import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `tickets.pending_ci_wait` + `tickets.ci_wait_context` (ticket
 * 778b6dc7) — the durable "blocked on one external CI run" wait, a third
 * pending flavor alongside `pending_user_action` (1760000000021) and
 * `pending_on_tickets` (1760000000026).
 *
 * SQLite (dev) picks both up automatically via synchronize=true on the
 * entities. This DDL only runs on Postgres (production) where synchronize
 * is disabled — same shape as 1760000000026-AddTicketPrerequisites.
 */
export class AddTicketPendingCiWait1760000000078 implements MigrationInterface {
  name = 'AddTicketPendingCiWait1760000000078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_ci_wait BOOLEAN NOT NULL DEFAULT false"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ci_wait_context TEXT NOT NULL DEFAULT ''"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
