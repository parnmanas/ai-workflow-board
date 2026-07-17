import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * High-impact run approval evidence (ticket 524bb434, scope 5). Adds the columns
 * that record who approved a high-impact Action run and when, so the
 * pre-execution approval gate in ActionsService.dispatch is auditable:
 *
 *   - action_runs.approved_by — approving user id ('' = not approved / low-impact)
 *   - action_runs.approved_at — approval timestamp (NULL = not approved)
 *
 * SQLite (dev/test) gets these via synchronize=true on the ActionRun entity;
 * this DDL only runs on Postgres (production) where synchronize is disabled.
 * ADD COLUMN IF NOT EXISTS makes a re-run a no-op. Existing rows backfill to
 * ''/NULL — an inert "no approval recorded" that matches every legacy run.
 */
export class AddActionRunApproval1760000000055 implements MigrationInterface {
  name = 'AddActionRunApproval1760000000055';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS approved_by VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      'ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP DEFAULT NULL',
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
