import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddColumnProcessSubtasks1760000000082 implements MigrationInterface {
  name = 'AddColumnProcessSubtasks1760000000082';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('columns', 'process_subtasks'))) {
      await queryRunner.query('ALTER TABLE columns ADD COLUMN process_subtasks BOOLEAN NOT NULL DEFAULT false');
    }
    await queryRunner.query("UPDATE columns SET process_subtasks = true WHERE kind = 'active' AND LOWER(name) = 'in progress'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('columns', 'process_subtasks')) {
      await queryRunner.query('ALTER TABLE columns DROP COLUMN process_subtasks');
    }
  }
}
