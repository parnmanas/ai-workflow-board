import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the legacy v1.0 chat_messages table unconditionally.
 *
 * This migration runs in DatabaseModule.onModuleInit() BEFORE synchronize:true
 * processes entities. The ChatMessage entity has been removed from the barrel
 * (entities/index.ts) in the same deploy, so TypeORM will not attempt to
 * recreate the table after this migration drops it.
 *
 * IF EXISTS guard makes this idempotent — safe to run against a DB that never
 * had the legacy table (fresh installs).
 *
 * down() is intentionally empty — v1.0 data migration is out of scope per
 * CONTEXT.md; table restoration is accomplished via backup, not migration reversal.
 */
export class DropLegacyChatMessages1760000000003 implements MigrationInterface {
  name = 'DropLegacyChatMessages1760000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS chat_messages');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No reverse — v1.0 data migration is out of scope per CONTEXT.md.
    // Rollback via database backup if needed.
  }
}
