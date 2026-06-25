import { MigrationInterface, QueryRunner, IsNull } from 'typeorm';
import { createHash } from 'crypto';
import { ApiKey } from '../../entities/ApiKey';

/**
 * Migrate existing plaintext `api_keys.key` rows to SHA-256 hashes and populate
 * the new `key_prefix` display column (security finding: secrets — full-scope
 * agent/manager keys were stored & matched in plaintext).
 *
 * The `key` column is REUSED to hold the hash (no schema change to it) so we
 * keep its unique index and avoid a NOT-NULL drop on Postgres. The nullable
 * `key_prefix` column is added by synchronize:true from the entity (which runs
 * before migrations, D-02/P-03); this migration only backfills DATA.
 *
 * Idempotent: only rows whose key_prefix is still NULL are touched, so a second
 * run — or a row already created by the hashing service — is a no-op. Uses the
 * TypeORM repository so it stays DB-agnostic (sqlite dev + postgres prod).
 *
 * One-way: the raw keys are unrecoverable post-hash, so `down()` is a no-op.
 */
function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '***';
  return key.slice(0, 8) + '***' + key.slice(-4);
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class HashApiKeys1760000000037 implements MigrationInterface {
  name = 'HashApiKeys1760000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const repo = queryRunner.manager.getRepository(ApiKey);
    // Only un-migrated rows: key still plaintext, key_prefix not yet set.
    const rows = await repo.find({ where: { key_prefix: IsNull() } });
    for (const row of rows) {
      if (!row.key) continue;
      await repo.update(row.id, {
        key: sha256Hex(row.key),
        key_prefix: maskKey(row.key),
      });
    }
  }

  public async down(): Promise<void> {
    // Hashing is one-way — the original raw keys are gone. Nothing to restore.
  }
}
