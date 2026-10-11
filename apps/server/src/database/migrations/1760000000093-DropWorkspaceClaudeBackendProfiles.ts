import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `workspace_claude_backend_profiles`, orphaned since 8a382b20 made Claude
 * backend profiles instance-global and deleted the WorkspaceClaudeBackendProfile
 * entity. synchronize never drops a table that has no entity, so the per-account
 * profile assignments it held stayed behind on every existing database — nothing
 * reads them (dispatch resolves pin → global default only).
 *
 * Runs on every driver (sql.js dev DBs carry the same leftover). No down: the
 * rows were already dead data when the entity went away.
 */
export class DropWorkspaceClaudeBackendProfiles1760000000093 implements MigrationInterface {
  name = 'DropWorkspaceClaudeBackendProfiles1760000000093';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS workspace_claude_backend_profiles');
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No rollback — see above.
  }
}
