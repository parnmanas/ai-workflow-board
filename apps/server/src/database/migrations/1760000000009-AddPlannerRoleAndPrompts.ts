import { MigrationInterface, QueryRunner } from 'typeorm';
import { Workspace } from '../../entities/Workspace';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { BUILTIN_ROLES } from '../../db';

/**
 * v0.34.1 — add Planner to the builtin role preset and seed default
 * role_prompts onto existing builtin rows.
 *
 * Two pure-data passes (schema is already in place via synchronize):
 *
 *   1. **Insert Planner per workspace** — every workspace that doesn't
 *      already have a `planner` slug gets one inserted with the prompt
 *      text from `BUILTIN_ROLES`. Idempotent via the
 *      `(workspace_id, slug)` unique index.
 *
 *   2. **Backfill empty role_prompts on builtins** — when 1760000000008
 *      ran originally, builtin roles were inserted with `role_prompt: ''`.
 *      The v0.34.1 default prompts are now part of `BUILTIN_ROLES`, so we
 *      copy them onto any existing builtin row whose `role_prompt` is
 *      still blank. Workspaces that customized their prompts are left
 *      strictly alone — only blank rows are touched.
 *
 *      Description text is treated the same way: only updated if the row
 *      currently has an empty description (cheap defensive check; v1
 *      always seeded a non-empty one but customizations may have cleared
 *      it).
 *
 * Constraint matrix (locked by v0.34 work):
 * - D-02: data only, no schema DDL.
 * - D-04: idempotent — re-running is a no-op once Planner exists and the
 *   prompts are populated.
 */
export class AddPlannerRoleAndPrompts1760000000009 implements MigrationInterface {
  name = 'AddPlannerRoleAndPrompts1760000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const wsRepo = manager.getRepository(Workspace);
    const roleRepo = manager.getRepository(WorkspaceRole);

    const workspaces = await wsRepo.find();
    let inserted = 0;
    let updated = 0;

    for (const ws of workspaces) {
      // ── Pass 1: insert Planner if missing ─────────────────────────
      const plannerDef = BUILTIN_ROLES.find(r => r.slug === 'planner');
      if (plannerDef) {
        const existing = await roleRepo.findOne({
          where: { workspace_id: ws.id, slug: 'planner' },
        });
        if (!existing) {
          await roleRepo.save(roleRepo.create({
            workspace_id: ws.id,
            slug: plannerDef.slug,
            name: plannerDef.name,
            role_prompt: plannerDef.role_prompt,
            description: plannerDef.description,
            position: plannerDef.position,
            is_builtin: true,
          }));
          inserted++;
        }
      }

      // ── Pass 2: fill empty role_prompts/descriptions on builtins ──
      // Match by slug, only overwrite if current value is empty so any
      // operator-customized prompt stays intact.
      for (const def of BUILTIN_ROLES) {
        const row = await roleRepo.findOne({
          where: { workspace_id: ws.id, slug: def.slug, is_builtin: true },
        });
        if (!row) continue;
        const patch: Partial<WorkspaceRole> = {};
        if (!row.role_prompt) patch.role_prompt = def.role_prompt;
        if (!row.description) patch.description = def.description;
        if (Object.keys(patch).length === 0) continue;
        await roleRepo.update({ id: row.id }, patch);
        updated++;
      }
    }

    console.log(
      `[v0.34.1 migration] inserted ${inserted} planner role(s) and ` +
      `populated empty prompt/description on ${updated} builtin row(s) ` +
      `across ${workspaces.length} workspace(s)`,
    );
  }

  public async down(): Promise<void> {
    // Data migrations don't have a true inverse — see prior migrations'
    // empty down() for precedent. Rolling back this migration would
    // require deleting Planner rows and any TicketRoleAssignment rows
    // pointing at them, which the entity cascade rules don't enforce; we
    // leave the rows in place so down() is a no-op.
  }
}
