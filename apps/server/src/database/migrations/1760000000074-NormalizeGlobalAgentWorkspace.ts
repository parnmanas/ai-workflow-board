import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';

/** Canonicalize the legacy empty-string global Agent scope to NULL. */
export class NormalizeGlobalAgentWorkspace1760000000074 implements MigrationInterface {
  name = 'NormalizeGlobalAgentWorkspace1760000000074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const repo = queryRunner.manager.getRepository(Agent);
    const rows = await repo.find();
    for (const agent of rows) {
      if (typeof agent.workspace_id === 'string' && !agent.workspace_id.trim()) {
        agent.workspace_id = null;
        await repo.save(agent);
      }
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // NULL and legacy blank both mean global; the original representation
    // cannot be reconstructed without changing behavior.
  }
}
