import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bring `skills` / `skill_versions` into the catalog scope model documented in
 * `docs/catalog-scopes.md` (Global = `workspace_id NULL`, Workspace = uuid),
 * and add the provenance columns the built-in pack seeder and the tap sync
 * need to recognise rows they own.
 *
 * Skills were built after the catalog-scope unification (migration ...068) and
 * never adopted it: `workspace_id` was NOT NULL and every query was a plain
 * equality, so a global skill was not merely absent — it was unrepresentable.
 *
 * Uniqueness is the subtle half. The entity keeps
 * `@Index(['workspace_id','slug'], {unique:true})` for the sql.js dev backend,
 * but on Postgres that index does NOT constrain global rows: `NULL != NULL`
 * there, so it would accept unlimited duplicate global slugs. The guarantee
 * comes from the two PARTIAL unique indexes below — the same split
 * `workflow_functions` uses (migration ...068).
 *
 * sql.js is synchronized from entity metadata before lifecycle migrations run,
 * so the DDL here is Postgres-only and written to be idempotent.
 */
export class GlobalSkillScope1760000000077 implements MigrationInterface {
  name = 'GlobalSkillScope1760000000077';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query('ALTER TABLE "skills" ALTER COLUMN "workspace_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "skill_versions" ALTER COLUMN "workspace_id" DROP NOT NULL');

    for (const [column, type, def] of [
      ['source_kind', 'varchar', "'local'"],
      ['source_id', 'varchar', "''"],
      ['source_path', 'varchar', "''"],
      ['source_version', 'varchar', "''"],
      ['source_license', 'varchar', "''"],
      ['source_author', 'varchar', "''"],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "${column}" ${type} NOT NULL DEFAULT ${def}`,
      );
    }

    // The non-partial composite index cannot express "one global row per slug"
    // (see the class doc). Replace it with the two partial indexes.
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_skills_workspace_id_slug"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_skills_global_slug"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_skills_workspace_slug"');
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_skills_global_slug" ON "skills" ("slug") WHERE "workspace_id" IS NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_skills_workspace_slug" ON "skills" ("workspace_id", "slug") WHERE "workspace_id" IS NOT NULL',
    );
  }

  async down(): Promise<void> {
    // Restoring NOT NULL would delete every global skill (and every version of
    // one), which is real operator content — the built-in pack can be re-seeded
    // but a tap-synced or hand-forked global skill cannot. Rollback is
    // deliberately data-preserving; a genuine downgrade must first relocate
    // global rows into a workspace.
  }
}
