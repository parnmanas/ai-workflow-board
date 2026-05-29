import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the hot-path indices the core tables were missing (perf ticket
 * b3812637). These columns are filtered on the most frequent reads in the
 * product — the board GET, the trigger loop, the focus selector, chat
 * membership checks, resource pickers — yet none of them were indexed, so
 * every such query degraded to a sequential scan that got slower as each
 * table grew.
 *
 *   tickets(column_id, parent_id) — board GET loads root tickets per column
 *     via `column_id = ? AND parent_id IS NULL`; the same composite serves
 *     the per-parent child loads.
 *   tickets(parent_id)            — subtask lookups + the "root tickets only"
 *     filter (`parent_id IS NULL`) used by the archiver / focus selector.
 *   tickets(workspace_id)         — workspace-scoped scans across the trigger
 *     loop, claim-verification, and the REST controllers.
 *   tickets(archived_at)          — `archived_at IS NULL` archive filter on
 *     nearly every board / focus / supervisor read.
 *   boards(workspace_id)          — board listing per workspace.
 *   ticket_prerequisites(ticket_id) — forward "what blocks ticket X?" lookup
 *     (the reverse prereq side was already indexed).
 *   chat_room_participants(room_id, participant_id) — per-message membership
 *     check; the leading column also serves room_id-only participant lists.
 *   resources(workspace_id, board_id) — resource picker listing (the table
 *     also holds large file_data/content blobs, so a scan is doubly costly).
 *
 * Concurrency:
 *   `CREATE INDEX CONCURRENTLY` builds without an ACCESS EXCLUSIVE lock so the
 *   board stays readable+writable during the build — the only safe choice on a
 *   busy production table. It must run OUTSIDE a transaction, hence
 *   `transaction = false`. `IF NOT EXISTS` makes the migration idempotent (an
 *   interrupted CONCURRENTLY build leaves an INVALID index; drop it manually
 *   and re-run). Mirrors AddActivityLogIndices1760000000027.
 *
 * SQLite (dev): no-op. The @Index decorators on the entities drive
 *   synchronize=true to create equivalent indices on startup, so dev databases
 *   match production's shape.
 */
export class AddHotPathIndices1760000000028 implements MigrationInterface {
  name = 'AddHotPathIndices1760000000028';

  // Required for `CREATE INDEX CONCURRENTLY` — Postgres rejects it inside a
  // transaction block. A partial run leaves whichever indices already landed;
  // `IF NOT EXISTS` recreates the rest on the next attempt.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    const statements = [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_column_parent ON tickets (column_id, parent_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_parent ON tickets (parent_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_workspace ON tickets (workspace_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_archived ON tickets (archived_at)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_boards_workspace ON boards (workspace_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticket_prerequisites_ticket ON ticket_prerequisites (ticket_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_room_participants_room_participant ON chat_room_participants (room_id, participant_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_resources_workspace_board ON resources (workspace_id, board_id)',
    ];
    for (const sql of statements) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    // DROP INDEX CONCURRENTLY is also out-of-transaction; mirror the up path
    // in reverse so a rollback on a live system doesn't take a table down.
    const statements = [
      'DROP INDEX CONCURRENTLY IF EXISTS idx_resources_workspace_board',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_chat_room_participants_room_participant',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_ticket_prerequisites_ticket',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_boards_workspace',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_tickets_archived',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_tickets_workspace',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_tickets_parent',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_tickets_column_parent',
    ];
    for (const sql of statements) {
      await queryRunner.query(sql);
    }
  }
}
