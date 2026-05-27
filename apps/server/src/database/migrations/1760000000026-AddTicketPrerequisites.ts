import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `ticket_prerequisites` join table + `tickets.pending_on_tickets`
 * column used by the prereq feature (ticket 48d14fff).
 *
 * SQLite (dev) picks both up automatically via synchronize=true on the
 * entities. This DDL only runs on Postgres (production) where synchronize
 * is disabled.
 *
 * The join table mirrors `Ticket.next_ticket_id`'s semantics in reverse:
 * `next_ticket_id` is a forward 1:1 push (A finishes → B wakes), this
 * table is a backward M:N pull (B is blocked until every A finishes).
 */
export class AddTicketPrerequisites1760000000026 implements MigrationInterface {
  name = 'AddTicketPrerequisites1760000000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_on_tickets BOOLEAN NOT NULL DEFAULT false"
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ticket_prerequisites (
        ticket_id VARCHAR NOT NULL,
        prerequisite_ticket_id VARCHAR NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_by VARCHAR NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (ticket_id, prerequisite_ticket_id),
        CONSTRAINT fk_ticket_prereq_ticket FOREIGN KEY (ticket_id)
          REFERENCES tickets(id) ON DELETE CASCADE,
        CONSTRAINT fk_ticket_prereq_prereq FOREIGN KEY (prerequisite_ticket_id)
          REFERENCES tickets(id) ON DELETE CASCADE
      )
    `);

    // Auto-resume sweep keys off this index: when a prereq lands on a
    // terminal column TriggerLoopService scans `WHERE prerequisite_ticket_id = ?`
    // and re-evaluates each dependent.
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_ticket_prerequisites_prereq ON ticket_prerequisites (prerequisite_ticket_id)"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
