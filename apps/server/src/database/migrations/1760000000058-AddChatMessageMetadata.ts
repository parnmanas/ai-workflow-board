import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `chat_room_messages.metadata` (F-1 · ticket 24694916) — a nullable JSON
 * (text) column carrying structured message metadata. The agent-manager captures
 * ticket-action references from mcp__awb__* tool results and emits them here
 * (`{ ticket_refs: [...] }`) so agent ticket actions render as reliable cards on
 * the client, without depending on the model to type an @[ticket:...] token.
 *
 * SQLite (dev) gets this column via synchronize=true on the entity. This DDL
 * only runs on Postgres (production), mirroring AddWorkspaceAssistantAgent /
 * AddHarnessConfig. `IF NOT EXISTS` keeps it idempotent — synchronize may have
 * already created it. Existing rows default to NULL (no metadata), so every
 * pre-existing message + ordinary chat turn sees no behaviour change.
 */
export class AddChatMessageMetadata1760000000058 implements MigrationInterface {
  name = 'AddChatMessageMetadata1760000000058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE chat_room_messages ADD COLUMN IF NOT EXISTS metadata TEXT DEFAULT NULL'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('ALTER TABLE chat_room_messages DROP COLUMN IF EXISTS metadata');
  }
}
