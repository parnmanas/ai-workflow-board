import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the user_channels table backing the per-user notification channel
 * bindings (Discord / Slack / Telegram). Dev uses sql.js with
 * synchronize:true — the table is created from the entity there, so this
 * migration is a no-op. Production (Postgres) has synchronize disabled, so
 * we have to spell out the DDL here or the feature blows up on first use.
 *
 * Mirrors `entities/UserChannel.ts`. Index on (user_id, provider) matches
 * the dispatcher's `find({ where: { user_id, is_active: 1 } })` lookup.
 */
export class CreateUserChannels1760000000014 implements MigrationInterface {
  name = 'CreateUserChannels1760000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_channels (
        id UUID PRIMARY KEY,
        user_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        target VARCHAR NOT NULL,
        label VARCHAR NOT NULL DEFAULT '',
        credentials TEXT NOT NULL DEFAULT '',
        is_active INT NOT NULL DEFAULT 1,
        notify_mention INT NOT NULL DEFAULT 1,
        notify_chat INT NOT NULL DEFAULT 1,
        notify_ticket INT NOT NULL DEFAULT 0,
        verified_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_user_channels_user_provider ON user_channels(user_id, provider)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
