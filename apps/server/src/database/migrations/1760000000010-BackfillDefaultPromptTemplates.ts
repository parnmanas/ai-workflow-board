import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { DEFAULT_PROMPT_TEMPLATES } from '../default-prompt-templates';

/**
 * Backfill the default workflow prompt templates into every existing
 * workspace, only inserting rows whose `name` is missing in that
 * workspace.
 *
 * Why this is safe to run on customized installations:
 *   - Match key is `name` per workspace (no global uniqueness constraint
 *     in the schema, but the runtime path uses name lookups).
 *   - Existing rows are NEVER touched — content / description / category
 *     stay exactly as the operator has them.
 *   - Boards and Board.column_prompts are NOT modified. A workspace that
 *     was missing the Plan template gets the row inserted, but the
 *     existing boards' column→template wiring is left alone (admins can
 *     attach Plan via Board Settings if they add the column later).
 *
 * Constraint matrix:
 * - D-02: data only, no schema DDL.
 * - D-04: idempotent — re-running on a fully-backfilled workspace is a
 *   no-op because every name lookup hits.
 */
export class BackfillDefaultPromptTemplates1760000000010 implements MigrationInterface {
  name = 'BackfillDefaultPromptTemplates1760000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const tplRepo = manager.getRepository(PromptTemplate);

    const workspaces = await wsRepo.find();
    let inserted = 0;

    for (const ws of workspaces) {
      const existing = await tplRepo.find({
        where: { workspace_id: ws.id },
        select: ['id', 'name'],
      });
      const existingNames = new Set(existing.map(t => t.name));

      for (const def of DEFAULT_PROMPT_TEMPLATES) {
        if (existingNames.has(def.name)) continue;
        await tplRepo.save(tplRepo.create({
          workspace_id: ws.id,
          name: def.name,
          description: def.description,
          content: def.content,
          category: def.category,
        }));
        inserted++;
      }
    }

    console.log(
      `[v0.34.2 migration] inserted ${inserted} missing default prompt template(s) ` +
      `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migrations don't have a true inverse — see prior migrations'
    // empty down() for precedent. Rolling back would require deleting
    // exactly the rows we inserted, but we don't track which workspaces
    // were already-customized vs. empty before this ran.
  }
}
