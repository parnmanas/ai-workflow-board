// Postgres-only: OrchestrationTeam.workspace_id non-null → nullable migration
// (ticket 1b62b437, completion condition 7).
//
// The ticket's entity-change is a type flip on an existing column
// (`workspace_id: string` → `string | null`), not an additive column — on
// SQLite/sql.js, TypeORM's `synchronize` has no ALTER COLUMN and instead
// rebuilds the whole `orchestration_teams` table (new table, copy rows, drop
// old, rename), which is a real, if well-trodden, data-loss risk if the copy
// step ever drops a column or a non-default value. On Postgres, the same
// change is a much narrower `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`
// with no table rewrite — but "narrower" is not "risk-free": it is still an
// unverified code path until it has actually run once against a real
// catalog. This test seeds a row against the LEGACY entity shape (mirrors
// commit b5a4a3d5's OrchestrationTeam, before this ticket), reboots
// `synchronize` against the CURRENT entity, and asserts the row survives
// verbatim, the new columns default to null on it, `workspace_id` is
// genuinely nullable at the catalog level afterward, and a real global team
// (workspace_id NULL) can then be inserted — which the pre-migration NOT NULL
// constraint would have rejected outright.
//
// Runs under `npm run test:qa:pg` (CI job `postgres-dialect-matrix`). On any
// other backend it self-skips rather than asserting something untrue — same
// posture as prompt-audit-report-pg-cast.test.mjs / skill-global-scope-pg.test.mjs.
// This sandbox has no docker/psql/postgres binary available to run it locally;
// the live-Postgres green comes from the CI pg matrix once this branch runs there.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource, EntitySchema } from 'typeorm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

// Isolated schema for this test process (mirrors helpers/boot.mjs /
// prompt-audit-report-pg-cast.test.mjs). Keyed on pid so a reused pid can't
// inherit stale tables.
const SCHEMA = `qa_orchteammig_${process.pid}`;

function pgClientOptions() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  };
}

// Legacy shape (pre-ticket 1b62b437, commit b5a4a3d5): workspace_id NOT NULL,
// no owner_workspace_id / allowed_workspace_ids columns.
const LegacyOrchestrationTeam = new EntitySchema({
  name: 'OrchestrationTeam',
  tableName: 'orchestration_teams',
  columns: {
    id: { primary: true, type: 'uuid', generated: 'uuid' },
    workspace_id: { type: 'varchar', nullable: false },
    name: { type: 'varchar' },
    description: { type: 'text', default: '' },
    orchestrator_agent_id: { type: 'varchar', nullable: true, default: null },
    orchestrator_prompt: { type: 'text', default: '' },
    max_parallel_steps: { type: 'int', default: 3 },
    max_open_missions: { type: 'int', default: 1 },
    enabled: { type: 'int', default: 1 },
    created_by: { type: 'varchar', default: '' },
    created_at: { type: 'timestamp', createDate: true },
    updated_at: { type: 'timestamp', updateDate: true },
  },
});

let legacyDs;
let currentDs;

after(async () => {
  try { if (legacyDs?.isInitialized) await legacyDs.destroy(); } catch { /* best-effort */ }
  try { if (currentDs?.isInitialized) await currentDs.destroy(); } catch { /* best-effort */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client(pgClientOptions());
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* best-effort cleanup */ }
  }
});

test('OrchestrationTeam.workspace_id non-null → nullable synchronize preserves existing rows and unlocks global teams (Postgres)', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const adminClient = new Client(pgClientOptions());
  await adminClient.connect();
  // TypeORM's uuid generator needs uuid-ossp — keep it pinned to public so this
  // disposable schema doesn't strand the extension (mirrors
  // helpers/boot.mjs's prepareIsolatedPgSchema / prompt-audit-report-pg-cast).
  await adminClient.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await adminClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await adminClient.query(`CREATE SCHEMA "${SCHEMA}"`);
  await adminClient.end();

  // schema + search_path must agree (Board Lesson 3) — buildDataSourceOptions()
  // already pairs them from DB_SCHEMA, same as every other pg qa-flow.
  process.env.DB_SCHEMA = SCHEMA;
  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const baseOptions = buildDataSourceOptions();

  // Step 1 — seed a row against the LEGACY (pre-ticket) shape: workspace_id
  // NOT NULL, no owner_workspace_id / allowed_workspace_ids.
  legacyDs = new DataSource({ ...baseOptions, entities: [LegacyOrchestrationTeam], synchronize: true });
  await legacyDs.initialize();
  const legacyRepo = legacyDs.getRepository('OrchestrationTeam');
  const seeded = await legacyRepo.save(legacyRepo.create({
    workspace_id: '11111111-1111-4111-8111-111111111111',
    name: 'Pre-migration team',
    orchestrator_agent_id: '22222222-2222-4222-8222-222222222222',
    max_parallel_steps: 5,
    max_open_missions: 2,
    enabled: 1,
    created_by: 'legacy-seed',
  }));
  await legacyDs.destroy();
  legacyDs = null;

  // Step 2 — boot the CURRENT entity (workspace_id nullable + new columns)
  // against the SAME schema/table and let synchronize run the real ALTER.
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  currentDs = new DataSource({ ...baseOptions, entities: [entities.OrchestrationTeam], synchronize: true });
  await currentDs.initialize();
  const repo = currentDs.getRepository(entities.OrchestrationTeam);

  const survived = await repo.findOne({ where: { id: seeded.id } });
  assert.ok(survived, 'the pre-migration row must survive ALTER COLUMN workspace_id DROP NOT NULL');
  assert.equal(survived.workspace_id, seeded.workspace_id, 'existing non-null workspace_id must be preserved verbatim');
  assert.equal(survived.name, 'Pre-migration team');
  assert.equal(survived.orchestrator_agent_id, seeded.orchestrator_agent_id);
  assert.equal(survived.max_parallel_steps, 5);
  assert.equal(survived.max_open_missions, 2);
  assert.equal(survived.owner_workspace_id, null, 'a new column must default to null on a pre-existing row');
  assert.equal(survived.allowed_workspace_ids, null, 'a new column must default to null on a pre-existing row');

  // Step 3 — the actual point of the migration: a genuinely global team
  // (workspace_id NULL) must now insert, which the old NOT NULL constraint
  // would have rejected outright.
  const global = await repo.save(repo.create({
    workspace_id: null,
    owner_workspace_id: '33333333-3333-4333-8333-333333333333',
    allowed_workspace_ids: ['33333333-3333-4333-8333-333333333333'],
    name: 'Global team post-migration',
    orchestrator_agent_id: null,
    created_by: 'post-migration',
  }));
  assert.equal(global.workspace_id, null);
  assert.deepEqual(global.allowed_workspace_ids, ['33333333-3333-4333-8333-333333333333']);

  const col = await currentDs.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'orchestration_teams' AND column_name = 'workspace_id'`,
    [SCHEMA],
  );
  assert.equal(col[0]?.is_nullable, 'YES', 'workspace_id must be nullable at the catalog level post-migration');
});
