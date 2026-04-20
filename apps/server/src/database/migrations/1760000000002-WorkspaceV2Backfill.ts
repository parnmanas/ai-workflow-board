import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { User } from '../../entities/User';
import { RelationTuple } from '../../entities/RelationTuple';
import { ApiKey } from '../../entities/ApiKey';
import { Channel } from '../../entities/Channel';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { BoardColumn } from '../../entities/BoardColumn';

/**
 * v2.0 workspace backfill migration.
 *
 * Assigns every pre-v2.0 entity row to a default workspace and creates
 * ReBAC RelationTuple membership rows for all existing users.
 *
 * Invariants:
 * - D-02: DATA only, no schema DDL. Uses Repository API to read/save rows.
 * - D-03: Repository API via queryRunner.manager — no raw SQL, cross-dialect.
 * - D-04: Idempotent — if RelationTuple table already has rows, skip entirely.
 *         Re-running on an already-migrated DB touches zero rows.
 * - D-27 (PITFALL P2): Default workspace resolved by slug='default' query,
 *         never by a hardcoded UUID constant.
 *
 * The down() method is a no-op — data migrations have no true inverse.
 */
export class WorkspaceV2Backfill1760000000002 implements MigrationInterface {
  name = 'WorkspaceV2Backfill1760000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;

    // ── Idempotency check ──
    // If any RelationTuple rows exist, this migration already ran. Skip.
    const tupleRepo = manager.getRepository(RelationTuple);
    const existingTupleCount = await tupleRepo.count();
    if (existingTupleCount > 0) return;

    // ── Step 1: Resolve or create default workspace ──
    const wsRepo = manager.getRepository(Workspace);
    let defaultWs = await wsRepo.findOne({ where: { slug: 'default' } });

    if (!defaultWs) {
      // No workspace with slug='default' — check if any workspace exists
      const oldest = await wsRepo.findOne({ where: {}, order: { created_at: 'ASC' } });
      if (oldest) {
        // Promote the oldest workspace to the default
        oldest.slug = 'default';
        defaultWs = await wsRepo.save(oldest);
      } else {
        // No workspaces at all — create one
        const created = wsRepo.create({
          name: 'Default Workspace',
          slug: 'default',
          is_public: 0,
          description: 'Auto-created default workspace',
        });
        defaultWs = await wsRepo.save(created);
      }
    }

    const wsId = defaultWs.id;

    // ── Step 2: Create RelationTuple membership rows for all users ──
    const userRepo = manager.getRepository(User);
    const allUsers = await userRepo.find();

    for (const user of allUsers) {
      // All users get 'member' relation
      const memberTuple = tupleRepo.create({
        subject_type: 'user',
        subject_id: user.id,
        relation: 'member',
        object_type: 'workspace',
        object_id: wsId,
      });
      await tupleRepo.save(memberTuple);

      // Admin users also get 'owner' relation
      if (user.role === 'admin') {
        const ownerTuple = tupleRepo.create({
          subject_type: 'user',
          subject_id: user.id,
          relation: 'owner',
          object_type: 'workspace',
          object_id: wsId,
        });
        await tupleRepo.save(ownerTuple);
      }
    }

    // ── Step 3: Backfill workspace_id on all workspace-scoped entities ──
    // Helper: load all rows for a repo, filter those without workspace_id, save.
    async function backfillWorkspaceId<T extends { workspace_id: string }>(
      repo: import('typeorm').Repository<T>,
    ): Promise<void> {
      const rows = await repo.find();
      const orphans = rows.filter((r) => !r.workspace_id || r.workspace_id.trim() === '');
      for (const row of orphans) {
        row.workspace_id = wsId;
        await repo.save(row);
      }
    }

    await backfillWorkspaceId(manager.getRepository(ApiKey));
    await backfillWorkspaceId(manager.getRepository(Channel));
    await backfillWorkspaceId(manager.getRepository(PromptTemplate));
    await backfillWorkspaceId(manager.getRepository(ActivityLog));
    await backfillWorkspaceId(manager.getRepository(Agent));
    await backfillWorkspaceId(manager.getRepository(Board));
    await backfillWorkspaceId(manager.getRepository(Ticket));
    await backfillWorkspaceId(manager.getRepository(Comment));
    await backfillWorkspaceId(manager.getRepository(BoardColumn));
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data migrations do not have a true inverse — we cannot reconstruct
    // which rows originally had empty workspace_id or which RelationTuple
    // rows existed before this migration ran. Rollback via DB backup only.
  }
}
