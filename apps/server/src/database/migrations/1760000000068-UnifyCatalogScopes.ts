import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the reusable catalog tables share the same nullable
 * (workspace_id, board_id) scope shape. sql.js is synchronized from the entity
 * metadata before lifecycle migrations; the explicit DDL protects PostgreSQL
 * upgrades and is idempotent.
 */
export class UnifyCatalogScopes1760000000068 implements MigrationInterface {
  name = 'UnifyCatalogScopes1760000000068';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query('ALTER TABLE "workflow_functions" ADD COLUMN IF NOT EXISTS "board_id" varchar NULL');
    await queryRunner.query('ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "board_id" varchar NULL');
    await queryRunner.query('ALTER TABLE "prompt_templates" ADD COLUMN IF NOT EXISTS "board_id" varchar NULL');
    await queryRunner.query('ALTER TABLE "resources" ALTER COLUMN "workspace_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "prompt_templates" ALTER COLUMN "workspace_id" DROP NOT NULL');

    await queryRunner.query('DROP INDEX IF EXISTS "uq_workflow_functions_global_key"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_workflow_functions_workspace_key"');
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_functions_global_key" ON "workflow_functions" ("key") WHERE "workspace_id" IS NULL AND "board_id" IS NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_functions_workspace_key" ON "workflow_functions" ("workspace_id", "key") WHERE "workspace_id" IS NOT NULL AND "board_id" IS NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_functions_board_key" ON "workflow_functions" ("board_id", "key") WHERE "board_id" IS NOT NULL',
    );
  }

  async down(): Promise<void> {
    // Scope narrowing would destroy valid global/board rows, so rollback is
    // intentionally data-preserving. A manual downgrade must first relocate
    // those rows.
  }
}
