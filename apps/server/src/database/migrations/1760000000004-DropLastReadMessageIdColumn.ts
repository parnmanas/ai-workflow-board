import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the unused `last_read_message_id` column from chat_room_participants.
 *
 * The field was written by markRead but never read by any code path:
 *   - Unread count is computed purely from `last_read_at` (datetime) — UUIDs
 *     are not monotonic, so the message id cannot serve that purpose.
 *   - No "jump to last-read position" UI feature ever consumed it.
 *   - No MCP tool exposed it.
 *
 * Dev (synchronize:true) already drops the column once the entity is updated;
 * this migration covers production where synchronize is disabled.
 *
 * IF EXISTS guard keeps the migration idempotent for fresh installs and any
 * DB that already lost the column through prior synchronize runs.
 *
 * down() is intentionally empty — there's no data to restore; the column was
 * pure derived state. Rollback via backup if needed.
 */
export class DropLastReadMessageIdColumn1760000000004 implements MigrationInterface {
  name = 'DropLastReadMessageIdColumn1760000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('chat_room_participants');
    if (table && table.findColumnByName('last_read_message_id')) {
      await queryRunner.query(
        'ALTER TABLE chat_room_participants DROP COLUMN last_read_message_id',
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No reverse — column was dead state with no recoverable data.
  }
}
