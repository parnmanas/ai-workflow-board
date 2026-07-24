import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStuckAlertCause1760000000064 implements MigrationInterface {
  name = 'AddStuckAlertCause1760000000064';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('stuck_alerts', 'cause'))) {
      await queryRunner.query(
        "ALTER TABLE stuck_alerts ADD COLUMN cause varchar NOT NULL DEFAULT 'stale_wait'"
      );
    }
    // Rows with the no-progress sentinel predate the explicit cause column.
    await queryRunner.query(
      "UPDATE stuck_alerts SET cause = 'no_progress' " +
      "WHERE last_cycle_count = 0 AND last_comment_id = ''"
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('stuck_alerts', 'cause')) {
      await queryRunner.query('ALTER TABLE stuck_alerts DROP COLUMN cause');
    }
  }
}
