import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `tickets.next_ticket_id` column — optional pointer to the ticket
 * that should be auto-triggered once this one lands on a terminal column.
 * See TriggerLoopService for the dispatch path.
 *
 * SQLite (dev) gets the column via synchronize=true on the entity. This DDL
 * only runs on Postgres (production) where synchronize is disabled.
 */
export class AddTicketNextTicketId1760000000015 implements MigrationInterface {
  name = 'AddTicketNextTicketId1760000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS next_ticket_id VARCHAR DEFAULT NULL'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
