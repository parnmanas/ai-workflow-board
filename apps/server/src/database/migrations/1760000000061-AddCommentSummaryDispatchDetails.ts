import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddCommentSummaryDispatchDetails1760000000061 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    if (!await queryRunner.hasColumn('comment_summary_runs', 'error_code')) {
      await queryRunner.addColumn('comment_summary_runs', new TableColumn({ name: 'error_code', type: 'varchar', default: "''" }));
    }
    if (!await queryRunner.hasColumn('comment_summary_runs', 'dispatch_trigger_id')) {
      await queryRunner.addColumn('comment_summary_runs', new TableColumn({ name: 'dispatch_trigger_id', type: 'varchar', default: "''" }));
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('comment_summary_runs', 'dispatch_trigger_id');
    await queryRunner.dropColumn('comment_summary_runs', 'error_code');
  }
}
