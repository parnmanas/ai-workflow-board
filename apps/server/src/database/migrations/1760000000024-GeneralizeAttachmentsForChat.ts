import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the existing ticket_attachments storage table so chat message
 * attachments can reuse the same binary backend.
 */
export class GeneralizeAttachmentsForChat1760000000024 implements MigrationInterface {
  name = 'GeneralizeAttachmentsForChat1760000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS owner_type VARCHAR DEFAULT 'ticket'`);
    await queryRunner.query(`ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS owner_id VARCHAR DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE ticket_attachments ADD COLUMN IF NOT EXISTS room_id VARCHAR NULL`);
    await queryRunner.query(`UPDATE ticket_attachments SET owner_type = 'ticket' WHERE owner_type IS NULL OR owner_type = ''`);
    await queryRunner.query(`UPDATE ticket_attachments SET owner_id = ticket_id WHERE owner_id IS NULL OR owner_id = ''`);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE ticket_attachments DROP CONSTRAINT IF EXISTS fk_ticket_attachments_ticket;
        ALTER TABLE ticket_attachments ALTER COLUMN ticket_id DROP NOT NULL;
        ALTER TABLE ticket_attachments
          ADD CONSTRAINT fk_ticket_attachments_ticket
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
      END $$;
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_ticket_attachments_owner_time ON ticket_attachments(owner_type, owner_id, created_at DESC)'
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_ticket_attachments_room_time ON ticket_attachments(room_id, created_at DESC)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
