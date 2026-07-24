import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddCliRuntimeProfiles1760000000065 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn('workspaces', new TableColumn({ name: 'cli_runtime_profiles', type: 'text', isNullable: true }));
    await queryRunner.addColumn('workspaces', new TableColumn({ name: 'default_cli_runtime_profile', type: 'varchar', isNullable: true }));
    await queryRunner.addColumn('boards', new TableColumn({ name: 'cli_runtime_profile', type: 'varchar', isNullable: true }));
    await queryRunner.addColumn('agents', new TableColumn({ name: 'cli_runtime_profile', type: 'varchar', isNullable: true }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('agents', 'cli_runtime_profile');
    await queryRunner.dropColumn('boards', 'cli_runtime_profile');
    await queryRunner.dropColumn('workspaces', 'default_cli_runtime_profile');
    await queryRunner.dropColumn('workspaces', 'cli_runtime_profiles');
  }
}
