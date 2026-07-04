import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `features` (Feature/Epic intake — ticket aae7644c). Same shape/rationale
 * as CreateWorkspaceSchedules: in dev (sql.js) synchronize:true auto-creates the
 * table from the entity, so this only runs DDL on Postgres (production). All
 * statements are IF NOT EXISTS so they are harmless even if synchronize already
 * produced the schema.
 *
 * requirement/feedback are TEXT (free-form). proposal / generated_ticket_ids are
 * JSON stored in TEXT (TypeORM `simple-json` maps to text on Postgres).
 */
export class CreateFeatures1760000000047 implements MigrationInterface {
  name = 'CreateFeatures1760000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) {
      // dev (sql.js) uses synchronize:true; table auto-created from the entity.
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS features (
        id UUID PRIMARY KEY,
        workspace_id VARCHAR NOT NULL,
        board_id VARCHAR NULL,
        title VARCHAR NOT NULL,
        requirement TEXT NOT NULL DEFAULT '',
        status VARCHAR NOT NULL DEFAULT 'draft',
        planner_agent_id VARCHAR NOT NULL DEFAULT '',
        proposal TEXT NULL,
        generated_ticket_ids TEXT NULL,
        planning_room_id VARCHAR NOT NULL DEFAULT '',
        feedback TEXT NOT NULL DEFAULT '',
        source_chat_room_id VARCHAR NOT NULL DEFAULT '',
        created_by VARCHAR NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_features_ws_status ON features(workspace_id, status)'
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
