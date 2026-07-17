import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `workspaces.assistant_agent_id` (에픽 bf65ca00 · S2) — the nullable
 * soft-pointer to the workspace's AWB assistant agent that the Chat-first
 * landing connects to as a DM preset (see entities/Workspace.ts and
 * workspaces.controller PATCH validation).
 *
 * SQLite (dev) gets this column via synchronize=true on the entity. This DDL
 * only runs on Postgres (production), mirroring AddHarnessConfig /
 * AddEnvironmentConfig. `IF NOT EXISTS` keeps it idempotent — synchronize may
 * have already created it. Existing rows default to NULL (unset), so Advanced /
 * Board flows see no behaviour change.
 */
export class AddWorkspaceAssistantAgent1760000000057 implements MigrationInterface {
  name = 'AddWorkspaceAssistantAgent1760000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS assistant_agent_id VARCHAR DEFAULT NULL'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
