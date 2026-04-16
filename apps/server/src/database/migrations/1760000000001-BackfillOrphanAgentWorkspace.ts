import { MigrationInterface, QueryRunner } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Workspace } from '../../entities/Workspace';

/**
 * Backfill data migration — attach legacy agents with empty `workspace_id` to
 * the first available workspace (usually the default one).
 *
 * Problem: `Agent.workspace_id` is declared as `varchar default ''`, and the
 * agents registration path did not always populate it at create time. This
 * left legacy agents with `workspace_id = ''`, which made them invisible to
 * Phase 3's `GET /api/agents/dashboard` endpoint (it strictly filters by
 * workspace_id match, returning `[]` on empty values — see Plan 03-02).
 *
 * Symptom: the dashboard shows "No agents yet" despite agents existing in
 * the database.
 *
 * Fix: this migration walks the agents table and sets `workspace_id` on any
 * row where it's empty/null, pointing at the oldest workspace (which is the
 * Default Workspace seeded by DatabaseModule.onModuleInit when the server
 * first booted).
 *
 * Invariants (inherited from 01-CONTEXT.md):
 *
 * - D-02: DATA only, no schema DDL. Uses Repository API to read/save rows.
 * - D-03: Repository API via queryRunner.manager for all data manipulation.
 *         No raw SQL, no DB-specific branching. Runs portably on
 *         sqlite/mysql/postgres.
 * - D-04: Idempotent — if no agents have empty workspace_id, this is a no-op.
 *         Re-running on an already-migrated DB touches zero rows.
 *
 * The down() method is a no-op — data migrations do not have a true inverse.
 */
export class BackfillOrphanAgentWorkspace1760000000001 implements MigrationInterface {
  name = 'BackfillOrphanAgentWorkspace1760000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const agentRepo = manager.getRepository(Agent);
    const wsRepo = manager.getRepository(Workspace);

    // ── Idempotency check ──
    // Load all agents and filter in memory to cover both '' and NULL shapes
    // across sqlite (stores as '') and postgres (may store NULL). Repository
    // API normalizes both on read.
    const allAgents = await agentRepo.find();
    const orphans = allAgents.filter(
      (a) => !a.workspace_id || a.workspace_id.trim() === '',
    );

    if (orphans.length === 0) return;

    // Resolve the target workspace — the oldest one by creation order.
    // DatabaseModule.onModuleInit seeds a Default Workspace when none exist,
    // so by the time this migration runs there is always at least one.
    const defaultWs = await wsRepo.findOne({ where: {}, order: { id: 'ASC' } });
    if (!defaultWs) {
      // Safety fallback: skip backfill when no workspace exists. The server
      // startup seeding path will create one on next boot, and this migration
      // will run again (idempotent) once it exists.
      return;
    }

    for (const agent of orphans) {
      agent.workspace_id = defaultWs.id;
      await agentRepo.save(agent);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data migrations do not have a true inverse — we cannot reconstruct
    // which agents originally had empty workspace_id without a separate
    // audit log. Rollback is accomplished by restoring from a backup.
    // Empty method satisfies DataSource.undoLastMigration() for the
    // FOUND-01 round-trip test.
  }
}
