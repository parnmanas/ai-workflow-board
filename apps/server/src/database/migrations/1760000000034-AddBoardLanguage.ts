import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `boards.language` (ticket ae28dcaf) — a nullable human-readable
 * language name (e.g. "Korean"). At dispatch TriggerLoopService synthesises a
 * "Respond in <language>…" instruction onto harness_config.system_prompt_append
 * so the board's agent writes its output in that language. null = no override
 * (agent default, English) — existing boards keep their current behaviour.
 *
 * SQLite (dev) gets this column via synchronize=true on the entity. This DDL
 * only runs on Postgres (production) where synchronize is disabled.
 */
export class AddBoardLanguage1760000000034 implements MigrationInterface {
  name = 'AddBoardLanguage1760000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query(
      'ALTER TABLE boards ADD COLUMN IF NOT EXISTS language VARCHAR DEFAULT NULL'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
