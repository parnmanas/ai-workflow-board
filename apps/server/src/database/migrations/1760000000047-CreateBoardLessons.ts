import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates board_lessons (per-board knowledge base — ticket 9d0d6ac4). Same
 * shape/rationale as CreateWorkspaceSchedules: in dev (sql.js) synchronize:true
 * auto-creates the table from the entity, so this only runs DDL on Postgres
 * (production). All statements are IF NOT EXISTS so they are harmless even if
 * synchronize already produced the schema.
 *
 * body/tags are TEXT (free-form multi-line runbook + JSON-array tag string).
 */
export class CreateBoardLessons1760000000047 implements MigrationInterface {
  name = 'CreateBoardLessons1760000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; table auto-created from the entity.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS board_lessons (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NULL,
        board_id VARCHAR NOT NULL,
        title VARCHAR NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        tags TEXT NULL,
        source_ticket_id VARCHAR NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_by VARCHAR NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_board_lessons_board_active ON board_lessons(board_id, active)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
