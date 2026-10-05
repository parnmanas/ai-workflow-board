import { MigrationInterface, QueryRunner } from 'typeorm';

/** Canonicalize the legacy empty-string global Agent scope to NULL. */
export class NormalizeGlobalAgentWorkspace1760000000074 implements MigrationInterface {
  name = 'NormalizeGlobalAgentWorkspace1760000000074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // P4c-4: agents 테이블 없음 — 대상 자체가 존재하지 않는다.
    if (!(await queryRunner.hasTable('agents'))) return;
    const repo = queryRunner.manager.getRepository('agents');
    const rows = await repo.find();
    for (const agent of rows) {
      if (typeof agent.account_id === 'string' && !agent.account_id.trim()) {
        agent.account_id = null;
        await repo.save(agent);
      }
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // NULL and legacy blank both mean global; the original representation
    // cannot be reconstructed without changing behavior.
  }
}
