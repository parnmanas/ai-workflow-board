import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';

/**
 * Backfill: make every existing `type='manager'` Agent row workspace-less.
 *
 * Background: pairing redemption used to pin the manager Agent identity to
 * the workspace that minted the token (`rec.workspace_id`). That made
 * managers invisible to every other workspace's AI Agents tab, even though
 * a manager can supervise managed children across any workspace.
 *
 * New contract (ticket 22cc3950): manager identities are global. The
 * controller now creates them with `workspace_id=''` and the agents list
 * query returns rows with `workspace_id IN (currentWorkspace, '')`. This
 * migration normalises previously-paired managers to the same shape.
 *
 * Invariants (inherited from 01-CONTEXT.md):
 *
 * - D-02: DATA only, no schema DDL.
 * - D-03: Repository API for portability across sqlite/mysql/postgres.
 * - D-04: Idempotent — if every manager row already has `workspace_id=''`,
 *         this is a no-op. Re-running touches zero rows.
 *
 * The down() method is a no-op: data migrations have no faithful inverse,
 * and reconstructing the original workspace_id per manager would need an
 * audit log we don't keep.
 */
export class MakeManagerAgentsWorkspaceless1760000000018 implements MigrationInterface {
  name = 'MakeManagerAgentsWorkspaceless1760000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const agentRepo = queryRunner.manager.getRepository(Agent);

    // Load every manager-type Agent and rewrite the ones still pinned to a
    // workspace. Filtering in memory keeps this portable — some drivers
    // store NULL where others store '', and the Repository API normalises
    // both shapes on read.
    const managers = await agentRepo.find({ where: { type: 'manager' } });
    const orphaned = managers.filter((a) => !!a.workspace_id && a.workspace_id.trim() !== '');
    if (orphaned.length === 0) return;

    for (const agent of orphaned) {
      agent.workspace_id = '';
      await agentRepo.save(agent);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data migrations do not have a true inverse — see header.
  }
}
