import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the no-holder decision an editable per-column policy. The backfill
 * preserves the pre-migration behaviour without using a column name: workflow
 * gates halt, ordinary active stages skip.
 */
export class AddColumnUnassignedPolicy1760000000050 implements MigrationInterface {
  name = 'AddColumnUnassignedPolicy1760000000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      "ALTER TABLE columns ADD COLUMN IF NOT EXISTS unassigned_policy VARCHAR NOT NULL DEFAULT 'halt'",
    );
    await queryRunner.query(
      "UPDATE columns SET unassigned_policy = CASE WHEN kind IN ('review', 'merging', 'terminal', 'intake') THEN 'halt' ELSE 'skip_if_ticket_staffed' END",
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
