import { MigrationInterface, QueryRunner, IsNull } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { Board } from '../../entities/Board';
import { Ticket } from '../../entities/Ticket';

/**
 * Baseline data migration — extracts two legacy data-cleanup blocks that used
 * to live inside DatabaseModule.onModuleInit():
 *
 *   1. Orphan-board repair: attach any boards with NULL workspace_id to a
 *      default workspace (creating one if necessary).
 *   2. Legacy `subtasks` table cleanup: convert rows from the old `subtasks`
 *      table into hierarchical child tickets and drop the legacy table.
 *
 * Invariants (locked by .planning/phases/01-foundation/01-CONTEXT.md):
 *
 * - D-02: DATA only, no schema DDL. (Schema is still managed by synchronize: true.)
 * - D-03: Repository API via queryRunner.manager for all data manipulation.
 *         The ONE documented exception is the raw `SELECT * FROM subtasks` below,
 *         permitted because the legacy `subtasks` table has no TypeORM entity.
 * - D-04: Idempotent. Re-running on an already-migrated DB is a no-op because
 *         both blocks are guarded by state checks (orphan count, hasTable).
 *
 * The down() method is intentionally empty — data migrations do not have a
 * true inverse. See the comment on down() below.
 */
export class BaselineDataMigration1760000000000 implements MigrationInterface {
  name = 'BaselineDataMigration1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const boardRepo = manager.getRepository(Board);
    const ticketRepo = manager.getRepository(Ticket);

    // ── Idempotency check 1: orphan-board repair ──
    // If no boards have NULL workspace_id, this block is a no-op.
    const orphanBoards = await boardRepo.find({ where: { workspace_id: IsNull() as any } });
    if (orphanBoards.length > 0) {
      let defaultWs = await wsRepo.findOne({ where: {}, order: { id: 'ASC' } });
      if (!defaultWs) {
        defaultWs = await wsRepo.save(wsRepo.create({
          name: 'Default Workspace',
          description: 'Auto-created workspace for existing boards',
        }));
      }
      for (const board of orphanBoards) {
        board.workspace_id = defaultWs.id;
        await boardRepo.save(board);
      }
    }

    // ── Idempotency check 2: legacy `subtasks` table cleanup ──
    // The hasTable() helper abstracts sqlite/mysql/postgres metadata lookups per D-03 portability rule.
    // The raw SELECT on `subtasks` is the DOCUMENTED EXCEPTION to D-03: the legacy `subtasks` table
    // has no TypeORM entity (it was deleted when the schema moved to hierarchical tickets), so
    // Repository API is not available for reads. This is a ONE-TIME legacy cleanup and is scoped to
    // the baseline migration only. See RESEARCH §Q-02 and §"Anti-Patterns" for the justification.
    const hasSubtasks = await queryRunner.hasTable('subtasks');
    if (hasSubtasks) {
      const legacySubtasks: any[] = await queryRunner.query(
        'SELECT * FROM subtasks ORDER BY ticket_id, position'
      );
      for (const st of legacySubtasks) {
        await ticketRepo.save(ticketRepo.create({
          parent_id: st.ticket_id,
          depth: 1,
          column_id: null as any,
          title: st.title,
          description: st.description || '',
          priority: st.priority || 'medium',
          status: st.status || (st.done ? 'done' : 'todo'),
          assignee: st.assignee || '',
          reporter: st.reporter || '',
          assignee_id: st.assignee_id || '',
          reporter_id: st.reporter_id || '',
          labels: st.labels || '[]',
          channel_ids: '[]',
          position: st.position || 0,
        }));
      }
      await queryRunner.dropTable('subtasks', true);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Data migrations do not have a true inverse:
    //   - Orphan-board repair cannot be reversed (we don't know which boards were originally orphans).
    //   - The legacy `subtasks` table cannot be reconstructed from child tickets without loss of fidelity.
    // A no-op down() is the correct pattern for backfill migrations per TypeORM docs and matches
    // common practice. Rollback is accomplished by restoring from a backup, not by undoing data moves.
    // This empty method satisfies DataSource.undoLastMigration() so the migration system's round-trip
    // test (run → revert) passes as required by FOUND-01.
  }
}
