import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOperationalTicketDedupe1760000000050 implements MigrationInterface {
  name = 'AddOperationalTicketDedupe1760000000050';
  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operational_dedupe_key VARCHAR DEFAULT NULL');
    await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_operational_dedupe_open ON tickets (operational_dedupe_key)');
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query('DROP INDEX IF EXISTS uq_tickets_operational_dedupe_open');
    await queryRunner.query('ALTER TABLE tickets DROP COLUMN IF EXISTS operational_dedupe_key');
  }
}
