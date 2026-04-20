import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the agent_channel_identities table.
 *
 * Per-agent external-channel mapping (Discord user IDs, Slack handles, etc.)
 * was used to resolve @-mention targets when posting ticket activity to
 * Discord. The feature is retired — channel wiring is now workspace-level
 * rather than per-agent, and user.discord_user_id remains the only bridge
 * for @-mentions.
 *
 * Dev (sql.js) uses synchronize:true so the table is dropped automatically
 * when the AgentChannelIdentity entity is removed from the TypeORM schema.
 * This migration only executes DDL on Postgres (production).
 */
export class DropAgentChannelIdentities1760000000007 implements MigrationInterface {
  name = 'DropAgentChannelIdentities1760000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('DROP TABLE IF EXISTS agent_channel_identities CASCADE');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No rollback — the table's data was per-agent external-channel mapping
    // that the codebase no longer consumes.
  }
}
