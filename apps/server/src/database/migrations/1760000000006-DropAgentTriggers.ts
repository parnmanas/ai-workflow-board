import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v0.25.0: drop the agent_triggers table.
 *
 * Trigger persistence was the root cause of the orphan-subagent multiplication
 * bug — unacked triggers kept coming back on every poll, each spawning a fresh
 * detached subagent when the short-lived proxy from the previous spawn had
 * already died. We now emit agent_trigger as a fire-and-forget SSE event with
 * an ephemeral trigger_id; the plugin's 5-minute `get_allocated_tickets` poll
 * is the backstop for missed deliveries.
 *
 * Dev (sql.js) uses synchronize:true so the table is dropped automatically
 * when the AgentTrigger entity is removed from the TypeORM schema. This
 * migration only executes DDL on Postgres (production).
 */
export class DropAgentTriggers1760000000006 implements MigrationInterface {
  name = 'DropAgentTriggers1760000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('DROP TABLE IF EXISTS agent_triggers CASCADE');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No rollback — the table's data was ephemeral (ack within hours) and
    // the new fire-and-forget design has no equivalent persistence.
  }
}
