import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';

/**
 * Backfill: set `workspace_id = NULL` on every `type='manager'` Agent row.
 *
 * Migration 18 (MakeManagerAgentsWorkspaceless) previously normalised them
 * to the empty string '' because the column was declared NOT NULL DEFAULT ''.
 * The entity is now nullable and we use NULL as the canonical "no workspace"
 * marker — operator-facing rule is "AgentManager is never connected to a
 * workspace", and '' was an implementation accident that leaked through the
 * list/filter query path as a synthetic workspace.
 *
 * Invariants (per CLAUDE.md + D-02/D-03/D-04):
 *
 * - DATA only, no schema DDL. The column was made nullable in the entity;
 *   TypeORM's `synchronize: true` rewrites the column shape before this
 *   migration runs. We only touch row values.
 * - Repository API for portability across sqlite/mysql/postgres.
 * - Idempotent — if every manager already has NULL workspace_id, this is
 *   a no-op. Re-running touches zero rows.
 *
 * down() is intentionally a no-op: there is no faithful inverse — the
 * original per-manager workspace was discarded by migration 18, and
 * reconstructing it would need an audit log we don't keep.
 */
export class NullManagerAgentWorkspace1760000000019 implements MigrationInterface {
  name = 'NullManagerAgentWorkspace1760000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const agentRepo = queryRunner.manager.getRepository(Agent);
    const managers = await agentRepo.find({ where: { type: 'manager' } });
    const orphaned = managers.filter((a) => a.workspace_id !== null);
    if (orphaned.length === 0) return;
    for (const agent of orphaned) {
      agent.workspace_id = null;
      await agentRepo.save(agent);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No faithful inverse — see header.
  }
}
