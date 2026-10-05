import { MigrationInterface, QueryRunner } from 'typeorm';
import { migrateAccountOwnership } from '../pre-sync-account-ownership';

/**
 * Boot pre-sync has already renamed ownership before TypeORM synchronize.
 * Keep the same idempotent operation in the migration ledger for explicit
 * migration runs and for any legacy metadata written by earlier migrations.
 */
export class AccountOwnership1760000000092 implements MigrationInterface {
  name = 'AccountOwnership1760000000092';

  async up(runner: QueryRunner): Promise<void> {
    await migrateAccountOwnership(runner);
  }

  async down(): Promise<void> {
    throw new Error('Account ownership is a one-way schema contract; restore the pre-deploy database backup to roll back');
  }
}
