import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the ticket_attachments table for direct file uploads on a Ticket.
 * Distinct from comment attachments (which live in resources with type=
 * 'comment_attachment') — ticket-level attachments cascade with the ticket
 * and have no Resource indirection, so the binary stays bound to the
 * ticket's lifecycle.
 *
 * Dev (sql.js) uses synchronize:true so the entity creates the table for
 * free; this migration only runs DDL on Postgres (production).
 */
export class CreateTicketAttachments1760000000011 implements MigrationInterface {
  name = 'CreateTicketAttachments1760000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR DEFAULT '',
        ticket_id VARCHAR NOT NULL,
        file_name VARCHAR NOT NULL,
        file_mimetype VARCHAR DEFAULT '',
        file_data TEXT DEFAULT '',
        file_size INT DEFAULT 0,
        uploaded_by_type VARCHAR DEFAULT 'user',
        uploaded_by_id VARCHAR DEFAULT '',
        uploaded_by VARCHAR DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_ticket_attachments_ticket
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_time ON ticket_attachments(ticket_id, created_at DESC)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
