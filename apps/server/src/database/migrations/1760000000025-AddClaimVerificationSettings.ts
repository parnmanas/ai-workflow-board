import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `workspaces.claim_verification_enabled` + `claim_verification_grace_ms`
 * for `ClaimVerificationService` (ticket dcb9d661), and adds the per-ticket
 * branch-tip snapshot columns (`branch_tip_sha_at_trigger`,
 * `branch_tip_snapshot_at`) populated by `TriggerLoopService` on assignee
 * triggers in active columns and consumed by the sweep to enrich pend
 * reasons with evidence.
 *
 * SQLite (dev) gets these columns via synchronize=true on the entity. This
 * DDL only runs on Postgres (production) where synchronize is disabled.
 */
export class AddClaimVerificationSettings1760000000025 implements MigrationInterface {
  name = 'AddClaimVerificationSettings1760000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS claim_verification_enabled INTEGER NOT NULL DEFAULT 0"
    );
    await queryRunner.query(
      "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS claim_verification_grace_ms INTEGER NOT NULL DEFAULT 600000"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS branch_tip_sha_at_trigger VARCHAR NOT NULL DEFAULT ''"
    );
    await queryRunner.query(
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS branch_tip_snapshot_at TIMESTAMP DEFAULT NULL"
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
