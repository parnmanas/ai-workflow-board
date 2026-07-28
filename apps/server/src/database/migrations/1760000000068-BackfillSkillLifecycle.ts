import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive skill tables are created by synchronize. No legacy mutable skill
 * rows existed, so the lifecycle backfill is intentionally data-only/no-op. */
export class BackfillSkillLifecycle1760000000068 implements MigrationInterface {
  name = 'BackfillSkillLifecycle1760000000068';
  async up(_queryRunner: QueryRunner): Promise<void> {}
  async down(_queryRunner: QueryRunner): Promise<void> {}
}
