import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddOperationalRecurrenceDedupe1760000000060 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Non-Postgres test/dev databases use synchronize=true, so the entity
    // declaration has already created this column and index.
    if (queryRunner.connection.options.type !== 'postgres') return;
    // Production also runs TypeORM synchronize before lifecycle migrations.
    // On an upgrade boot, synchronize may therefore have already created the
    // entity column and index. Keep this migration rollout-safe and idempotent
    // instead of failing the entire application boot with PostgreSQL 42701.
    if (!(await queryRunner.hasColumn('comments', 'operational_recurrence_key'))) {
      await queryRunner.addColumn('comments', new TableColumn({
        name: 'operational_recurrence_key', type: 'varchar', isNullable: true,
      }));
    }

    const comments = await queryRunner.getTable('comments');
    const hasIndex = comments?.indices.some(
      (index) => index.name === 'IDX_comments_operational_recurrence_key',
    ) ?? false;
    if (!hasIndex) {
      await queryRunner.createIndex('comments', new TableIndex({
        name: 'IDX_comments_operational_recurrence_key',
        columnNames: ['operational_recurrence_key'], isUnique: true,
      }));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.dropIndex('comments', 'IDX_comments_operational_recurrence_key');
    await queryRunner.dropColumn('comments', 'operational_recurrence_key');
  }
}
