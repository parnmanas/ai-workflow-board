import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { PromoteBoardCatalogScopes1760000000069 } from '../dist/database/migrations/1760000000069-PromoteBoardCatalogScopes.js';

test('boot migration promotes board catalog rows and preserves conflicting Functions', async () => {
  const dataSource = new DataSource({ type: 'sqljs', entities: [], synchronize: false });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.query(
      'CREATE TABLE "workflow_functions" (' +
      '"id" varchar PRIMARY KEY, "workspace_id" varchar NULL, "board_id" varchar NULL, "key" varchar NOT NULL)',
    );
    await runner.query(
      'CREATE UNIQUE INDEX "uq_workflow_functions_workspace_key" ' +
      'ON "workflow_functions" ("workspace_id", "key") WHERE "workspace_id" IS NOT NULL AND "board_id" IS NULL',
    );
    await runner.query(
      'CREATE UNIQUE INDEX "uq_workflow_functions_board_key" ' +
      'ON "workflow_functions" ("board_id", "key") WHERE "board_id" IS NOT NULL',
    );
    const catalogTables = [
      'actions',
      'credentials',
      'prompt_templates',
      'resources',
      'qa_scenarios',
      'qa_schedules',
      'security_profiles',
      'security_schedules',
      'workspace_schedules',
    ];
    for (const table of catalogTables) {
      await runner.query(
        `CREATE TABLE "${table}" (` +
        '"id" varchar PRIMARY KEY, "workspace_id" varchar NULL, "board_id" varchar NULL, "name" varchar NOT NULL)',
      );
    }
    await runner.query(
      `INSERT INTO "workflow_functions" VALUES
       ('workspace-fn', 'ws-1', NULL, 'deploy'),
       ('board-fn-a', 'ws-1', 'board-aaaaaaaa', 'deploy'),
       ('board-fn-b', 'ws-1', 'board-bbbbbbbb', 'deploy')`,
    );
    for (const table of catalogTables) {
      await runner.query(
        `INSERT INTO "${table}" VALUES ('${table}-1', 'ws-1', 'board-aaaaaaaa', 'Migrated')`,
      );
    }

    await new PromoteBoardCatalogScopes1760000000069().up(runner);

    const functions = await runner.query(
      'SELECT "id", "workspace_id", "board_id", "key" FROM "workflow_functions" ORDER BY "id"',
    );
    assert.equal(functions.length, 3);
    assert.equal(functions.every((row) => row.workspace_id === 'ws-1' && row.board_id === null), true);
    assert.equal(new Set(functions.map((row) => row.key)).size, 3);
    assert.equal(functions.find((row) => row.id === 'workspace-fn').key, 'deploy');
    assert.match(functions.find((row) => row.id === 'board-fn-a').key, /^deploy-board-/);
    assert.match(functions.find((row) => row.id === 'board-fn-b').key, /^deploy-board-/);
    const legacyBoardIndexes = await runner.query(
      `SELECT "name" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'uq_workflow_functions_board_key'`,
    );
    assert.deepEqual(legacyBoardIndexes, [], 'legacy Board Function index removed');

    for (const table of catalogTables) {
      const rows = await runner.query(`SELECT "workspace_id", "board_id" FROM "${table}"`);
      assert.deepEqual(rows, [{ workspace_id: 'ws-1', board_id: null }], `${table} promoted`);
    }

    await new PromoteBoardCatalogScopes1760000000069().up(runner);
    const secondPass = await runner.query(
      'SELECT COUNT(*) AS "count" FROM "workflow_functions" WHERE "board_id" IS NOT NULL',
    );
    assert.equal(Number(secondPass[0].count), 0);
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
});

test('boot migration preserves QA and Security failure-ticket Board targets', async () => {
  const dataSource = new DataSource({ type: 'sqljs', entities: [], synchronize: false });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    for (const table of ['qa_scenarios', 'security_profiles']) {
      await runner.query(
        `CREATE TABLE "${table}" (` +
        '"id" varchar PRIMARY KEY, "workspace_id" varchar NOT NULL, "board_id" varchar NULL, ' +
        '"on_failure_ticket" text NULL)',
      );
      await runner.query(
        `INSERT INTO "${table}" ("id", "workspace_id", "board_id", "on_failure_ticket") VALUES (?, ?, ?, ?)`,
        [`${table}-fallback`, 'ws-1', 'source-board', JSON.stringify({ enabled: true, column_name: 'Todo' })],
      );
      await runner.query(
        `INSERT INTO "${table}" ("id", "workspace_id", "board_id", "on_failure_ticket") VALUES (?, ?, ?, ?)`,
        [`${table}-explicit`, 'ws-1', 'source-board', JSON.stringify({
          enabled: true,
          board_id: 'explicit-target',
        })],
      );
    }

    const migration = new PromoteBoardCatalogScopes1760000000069();
    await migration.up(runner);
    await migration.up(runner);

    for (const table of ['qa_scenarios', 'security_profiles']) {
      const rows = await runner.query(
        `SELECT "id", "board_id", "on_failure_ticket" FROM "${table}" ORDER BY "id"`,
      );
      assert.equal(rows.every((row) => row.board_id === null), true, `${table} ownership promoted`);
      const explicit = JSON.parse(rows.find((row) => row.id.endsWith('-explicit')).on_failure_ticket);
      const fallback = JSON.parse(rows.find((row) => row.id.endsWith('-fallback')).on_failure_ticket);
      assert.equal(explicit.board_id, 'explicit-target', `${table} explicit target retained`);
      assert.equal(fallback.board_id, 'source-board', `${table} legacy Board becomes target`);
    }
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
});

test('boot migration recovers missing Workspace ownership from the source Board', async () => {
  const dataSource = new DataSource({ type: 'sqljs', entities: [], synchronize: false });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.query('CREATE TABLE "boards" ("id" varchar PRIMARY KEY, "workspace_id" varchar NOT NULL)');
    await runner.query(`INSERT INTO "boards" VALUES ('source-board', 'recovered-workspace')`);
    await runner.query(
      'CREATE TABLE "actions" (' +
      '"id" varchar PRIMARY KEY, "workspace_id" varchar NULL, "board_id" varchar NULL, "name" varchar NOT NULL)',
    );
    await runner.query(`INSERT INTO "actions" VALUES ('recoverable', NULL, 'source-board', 'Recovered')`);
    await new PromoteBoardCatalogScopes1760000000069().up(runner);
    const rows = await runner.query('SELECT "workspace_id", "board_id" FROM "actions"');
    assert.deepEqual(rows, [{ workspace_id: 'recovered-workspace', board_id: null }]);
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
});

test('boot migration refuses an unresolvable Board without partially promoting other rows', async () => {
  const dataSource = new DataSource({ type: 'sqljs', entities: [], synchronize: false });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.query('CREATE TABLE "boards" ("id" varchar PRIMARY KEY, "workspace_id" varchar NOT NULL)');
    await runner.query(
      'CREATE TABLE "actions" (' +
      '"id" varchar PRIMARY KEY, "workspace_id" varchar NULL, "board_id" varchar NULL, "name" varchar NOT NULL)',
    );
    await runner.query(
      `INSERT INTO "actions" VALUES
       ('valid', 'workspace-1', 'valid-board', 'Must stay untouched'),
       ('orphan', NULL, 'missing-board', 'Unsafe')`,
    );
    await assert.rejects(
      new PromoteBoardCatalogScopes1760000000069().up(runner),
      /refusing to guess a destination/,
    );
    const rows = await runner.query('SELECT "id", "workspace_id", "board_id" FROM "actions" ORDER BY "id"');
    assert.deepEqual(rows, [
      { id: 'orphan', workspace_id: null, board_id: 'missing-board' },
      { id: 'valid', workspace_id: 'workspace-1', board_id: 'valid-board' },
    ]);
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
});
