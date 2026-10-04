// Board removal data migration (docs/tickets.md) — phase 1 (pre-sync snapshot)
// + phase 2 (migration 1760000000091-BoardlessTickets) on a legacy-shaped
// sql.js database.
//
// The legacy tables below carry only the columns the migration reads; the
// rest of the schema is whatever synchronize builds for the current entities
// (the same thing a fresh database gets). What this pins:
//   - column → status, board name → tag (old labels kept), base repo / board
//     environment repo → project, assignee role RuntimeSpec → assignee;
//   - repository Resources become Projects with the SAME id and leave
//     `resources`;
//   - tickets of an archived board are archived;
//   - board settings with a workspace home move there;
//   - board-scoped workflow functions become workspace rows unless that would
//     collide, and the key indexes are rebuilt on the same boot;
//   - the retired tables and the snapshots are dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';

const require = createRequire(import.meta.url);

const WS = '11111111-1111-4111-8111-111111111111';
const BOARD = '22222222-2222-4222-8222-222222222222';
const ARCHIVED_BOARD = '33333333-3333-4333-8333-333333333333';
const REPO = '44444444-4444-4444-8444-444444444444';
const ENV_REPO = '55555555-5555-4555-8555-555555555555';
const COL = {
  backlog: 'c0000000-0000-4000-8000-000000000001',
  todo: 'c0000000-0000-4000-8000-000000000002',
  plan: 'c0000000-0000-4000-8000-000000000003',
  progress: 'c0000000-0000-4000-8000-000000000004',
  review: 'c0000000-0000-4000-8000-000000000005',
  merging: 'c0000000-0000-4000-8000-000000000006',
  done: 'c0000000-0000-4000-8000-000000000007',
  archivedTodo: 'c0000000-0000-4000-8000-000000000008',
};
const T = (n) => `a0000000-0000-4000-8000-00000000000${n}`;
const FN = {
  ws: 'f0000000-0000-4000-8000-000000000001',
  boardDup: 'f0000000-0000-4000-8000-000000000002',
  boardFree: 'f0000000-0000-4000-8000-000000000003',
  otherBoardDup: 'f0000000-0000-4000-8000-000000000004',
};
const ROLE_ASSIGNEE = 'r0000000-0000-4000-8000-000000000001';
const ROLE_REVIEWER = 'r0000000-0000-4000-8000-000000000002';
const SPEC = {
  manager_agent_id: '66666666-6666-4666-8666-666666666666',
  cli: 'claude',
  model: null,
  working_dir: '/srv/agents/awb',
  folder_scope: 'shared',
  credential_id: null,
  cli_runtime_profile: null,
  runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  label: 'Programmer',
  role_prompt: '',
};

async function writeLegacyDb(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const now = "datetime('now')";
  db.run(`
    CREATE TABLE workspaces (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, description varchar NOT NULL DEFAULT '',
      created_at datetime NOT NULL DEFAULT (${now}), updated_at datetime NOT NULL DEFAULT (${now}));
    CREATE TABLE boards (id varchar PRIMARY KEY NOT NULL, workspace_id varchar, name varchar NOT NULL,
      environment_config text, language varchar, auto_archive_days integer, max_concurrent_tickets_per_agent integer NOT NULL DEFAULT 1,
      use_pr boolean NOT NULL DEFAULT 0, archived_at datetime, created_at datetime NOT NULL DEFAULT (${now}));
    CREATE TABLE columns (id varchar PRIMARY KEY NOT NULL, board_id varchar NOT NULL, name varchar NOT NULL, position integer NOT NULL,
      is_terminal boolean NOT NULL DEFAULT 0, kind varchar NOT NULL DEFAULT '');
    CREATE TABLE workspace_roles (id varchar PRIMARY KEY NOT NULL, workspace_id varchar NOT NULL, slug varchar NOT NULL, name varchar NOT NULL);
    CREATE TABLE ticket_role_assignments (id varchar PRIMARY KEY NOT NULL, ticket_id varchar NOT NULL, role_id varchar NOT NULL,
      agent_id varchar, user_id varchar, holder_key varchar NOT NULL DEFAULT '', runtime_spec text, created_at datetime NOT NULL DEFAULT (${now}));
    CREATE TABLE board_lessons (id varchar PRIMARY KEY NOT NULL, board_id varchar NOT NULL, body text NOT NULL DEFAULT '');
    CREATE TABLE resources (id varchar PRIMARY KEY NOT NULL, workspace_id varchar, board_id varchar, credential_id varchar,
      name varchar NOT NULL, description varchar NOT NULL DEFAULT '', type varchar NOT NULL DEFAULT 'link', url varchar NOT NULL DEFAULT '',
      default_branch varchar NOT NULL DEFAULT '', clone_policy text, content text NOT NULL DEFAULT '', file_data text NOT NULL DEFAULT '',
      file_name varchar NOT NULL DEFAULT '', file_mimetype varchar NOT NULL DEFAULT '', tags varchar NOT NULL DEFAULT '[]',
      created_at datetime NOT NULL DEFAULT (${now}), updated_at datetime NOT NULL DEFAULT (${now}));
    CREATE TABLE tickets (id varchar PRIMARY KEY NOT NULL, workspace_id varchar DEFAULT '', column_id varchar, parent_id varchar,
      depth integer NOT NULL DEFAULT 0, title varchar NOT NULL, description varchar NOT NULL DEFAULT '', priority varchar NOT NULL DEFAULT 'medium',
      labels varchar NOT NULL DEFAULT '[]', position integer NOT NULL DEFAULT 0, status varchar NOT NULL DEFAULT 'todo',
      base_repo_resource_id varchar NOT NULL DEFAULT '', base_branch varchar NOT NULL DEFAULT '', archived_at datetime,
      created_at datetime NOT NULL DEFAULT (${now}), updated_at datetime NOT NULL DEFAULT (${now}), version integer NOT NULL DEFAULT 1);
    CREATE TABLE workflow_functions (id varchar PRIMARY KEY NOT NULL, workspace_id varchar, board_id varchar, key varchar NOT NULL,
      name varchar NOT NULL, created_at datetime NOT NULL DEFAULT (${now}), updated_at datetime NOT NULL DEFAULT (${now}));
    CREATE UNIQUE INDEX uq_workflow_functions_workspace_key ON workflow_functions (workspace_id, key)
      WHERE workspace_id IS NOT NULL AND board_id IS NULL;
    CREATE UNIQUE INDEX uq_workflow_functions_board_key ON workflow_functions (board_id, key) WHERE board_id IS NOT NULL;
  `);
  const run = (sql, params) => db.run(sql, params);
  run('INSERT INTO workspaces (id, name) VALUES (?, ?)', [WS, 'legacy']);
  run('INSERT INTO boards (id, workspace_id, name, environment_config, language, auto_archive_days, max_concurrent_tickets_per_agent, use_pr) VALUES (?,?,?,?,?,?,?,?)',
    [BOARD, WS, 'GameClient', JSON.stringify({ repositories: [{ resource_id: ENV_REPO }] }), 'Korean', 14, 2, 1]);
  run('INSERT INTO boards (id, workspace_id, name, archived_at) VALUES (?,?,?,?)', [ARCHIVED_BOARD, WS, 'Old Board', '2026-01-01 00:00:00']);
  const cols = [
    [COL.backlog, BOARD, 'Backlog', 0, 0, 'intake'],
    [COL.todo, BOARD, 'To Do', 1, 0, 'active'],
    [COL.plan, BOARD, 'Plan', 2, 0, 'active'],
    [COL.progress, BOARD, 'In Progress', 3, 0, 'active'],
    [COL.review, BOARD, 'Review', 4, 0, 'review'],
    [COL.merging, BOARD, 'Merging', 5, 0, 'merging'],
    [COL.done, BOARD, 'Done', 6, 1, 'terminal'],
    [COL.archivedTodo, ARCHIVED_BOARD, 'To Do', 0, 0, 'active'],
  ];
  for (const c of cols) run('INSERT INTO columns (id, board_id, name, position, is_terminal, kind) VALUES (?,?,?,?,?,?)', c);
  run('INSERT INTO workspace_roles (id, workspace_id, slug, name) VALUES (?,?,?,?)', [ROLE_ASSIGNEE, WS, 'assignee', 'Assignee']);
  run('INSERT INTO workspace_roles (id, workspace_id, slug, name) VALUES (?,?,?,?)', [ROLE_REVIEWER, WS, 'reviewer', 'Reviewer']);
  run('INSERT INTO board_lessons (id, board_id, body) VALUES (?,?,?)', ['l1', BOARD, 'lesson']);
  run("INSERT INTO resources (id, workspace_id, name, type, url, default_branch, clone_policy, credential_id) VALUES (?,?,?,?,?,?,?,?)",
    [REPO, WS, 'GameClient Repository', 'repository', 'https://github.com/example/gameclient', 'master', '{"clone_depth":1}', null]);
  run("INSERT INTO resources (id, workspace_id, name, type, url, default_branch) VALUES (?,?,?,?,?,?)",
    [ENV_REPO, WS, 'Env Repo', 'repository', 'https://github.com/example/env', 'main']);
  run("INSERT INTO resources (id, workspace_id, name, type, url) VALUES (?,?,?,?,?)",
    ['77777777-7777-4777-8777-777777777777', WS, 'Design doc', 'link', 'https://example.com/doc']);
  const tickets = [
    [T(1), COL.backlog, 'backlog ticket', '["bug"]', ''],
    [T(2), COL.plan, 'plan ticket', '[]', REPO],
    [T(3), COL.progress, 'in progress ticket', '["Feature"]', REPO],
    [T(4), COL.review, 'review ticket', '[]', ''],
    [T(5), COL.merging, 'merging ticket', '[]', ''],
    [T(6), COL.done, 'done ticket', '["gameclient"]', ''],
    [T(7), COL.archivedTodo, 'archived board ticket', '[]', ''],
  ];
  for (const [id, col, title, labels, repo] of tickets) {
    run('INSERT INTO tickets (id, workspace_id, column_id, title, labels, base_repo_resource_id) VALUES (?,?,?,?,?,?)', [id, WS, col, title, labels, repo]);
  }
  run('INSERT INTO tickets (id, workspace_id, column_id, parent_id, depth, title, status) VALUES (?,?,?,?,?,?,?)',
    [T(8), WS, null, T(3), 1, 'child item', 'done']);
  run('INSERT INTO ticket_role_assignments (id, ticket_id, role_id, agent_id, holder_key, runtime_spec) VALUES (?,?,?,?,?,?)',
    ['ra1', T(3), ROLE_ASSIGNEE, null, 'runtime:x', JSON.stringify(SPEC)]);
  // A reviewer holder must NOT become the assignee.
  run('INSERT INTO ticket_role_assignments (id, ticket_id, role_id, agent_id, holder_key, runtime_spec) VALUES (?,?,?,?,?,?)',
    ['ra2', T(4), ROLE_REVIEWER, null, 'runtime:y', JSON.stringify({ ...SPEC, label: 'Reviewer' })]);
  // A legacy agent-uuid holder without a spec stays unassigned.
  run('INSERT INTO ticket_role_assignments (id, ticket_id, role_id, agent_id, holder_key) VALUES (?,?,?,?,?)',
    ['ra3', T(5), ROLE_ASSIGNEE, '88888888-8888-4888-8888-888888888888', 'agent:88888888']);
  // Workspace row + a board row with the same key (collides → dropped), a board
  // row with a free key (kept as a workspace row) and a second board's copy of
  // that key (collides with the kept one → dropped).
  for (const [id, board, key] of [[FN.ws, null, 'custom.deploy'], [FN.boardDup, BOARD, 'custom.deploy'],
    [FN.boardFree, BOARD, 'custom.lint'], [FN.otherBoardDup, ARCHIVED_BOARD, 'custom.lint']]) {
    run('INSERT INTO workflow_functions (id, workspace_id, board_id, key, name) VALUES (?,?,?,?,?)', [id, WS, board, key, key]);
  }
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

const dbFile = path.join(os.tmpdir(), `awb-board-removal-${process.pid}.db`);
fs.rmSync(dbFile, { force: true });
await writeLegacyDb(dbFile);
process.env.SQLJS_DB_PATH = dbFile;
process.env.DB_TYPE = 'sqlite';

const { preSyncBoardRemoval } = await import('../dist/database/pre-sync-board-removal.js');
const { buildDataSourceOptions } = await import('../dist/db.js');
await preSyncBoardRemoval(buildDataSourceOptions());

const { app, modules } = await bootApp({ port: 0 });
const ds = app.get(modules.getDataSourceToken());

test.after(async () => {
  await app.close();
  fs.rmSync(dbFile, { force: true });
});

const ticket = async (id) => {
  const rows = await ds.query('SELECT * FROM tickets WHERE id = ?', [id]);
  return rows[0];
};

test('columns map onto the fixed status set', async () => {
  const expected = {
    [T(1)]: 'backlog', [T(2)]: 'todo', [T(3)]: 'in_progress', [T(4)]: 'review',
    [T(5)]: 'in_progress', [T(6)]: 'done', [T(7)]: 'todo',
  };
  for (const [id, status] of Object.entries(expected)) {
    assert.equal((await ticket(id)).status, status, `ticket ${id}`);
  }
  // Children keep their own done / not-done.
  assert.equal((await ticket(T(8))).status, 'done');
});

test('the board name becomes a tag next to the old labels', async () => {
  assert.deepEqual(JSON.parse((await ticket(T(1))).tags), ['bug', 'GameClient']);
  assert.deepEqual(JSON.parse((await ticket(T(3))).tags), ['Feature', 'GameClient']);
  // Case-insensitive de-duplication: an existing "gameclient" label wins.
  assert.deepEqual(JSON.parse((await ticket(T(6))).tags), ['gameclient']);
  assert.deepEqual(JSON.parse((await ticket(T(7))).tags), ['Old Board']);
});

test('repository resources become projects with the same id and leave resources', async () => {
  const projects = await ds.query('SELECT * FROM projects ORDER BY name');
  assert.deepEqual(projects.map((p) => p.id).sort(), [ENV_REPO, REPO].sort());
  const repo = projects.find((p) => p.id === REPO);
  assert.equal(repo.repo_url, 'https://github.com/example/gameclient');
  assert.equal(repo.default_branch, 'master');
  assert.equal(repo.clone_policy, '{"clone_depth":1}');
  assert.equal(repo.workspace_id, WS);
  // The board used PRs, so its environment repo's project does too.
  assert.ok(Number(projects.find((p) => p.id === ENV_REPO).use_pr) === 1 || projects.find((p) => p.id === ENV_REPO).use_pr === true);
  const remaining = await ds.query('SELECT id, type FROM resources');
  assert.deepEqual(remaining.map((r) => r.type), ['link']);
});

test('the base repo, else the board environment repo, becomes the project', async () => {
  assert.equal((await ticket(T(2))).project_id, REPO);
  assert.equal((await ticket(T(1))).project_id, ENV_REPO);
  assert.equal((await ticket(T(7))).project_id, null);
});

test('only the assignee role RuntimeSpec becomes the assignee', async () => {
  const t3 = await ticket(T(3));
  assert.equal(JSON.parse(t3.assignee).label, 'Programmer');
  assert.match(t3.assignee_key, /^rt-[0-9a-f]{16}$/);
  const t4 = await ticket(T(4));
  assert.ok(!t4.assignee, 'a reviewer holder is not the assignee');
  assert.equal(t4.assignee_key, '');
  const t5 = await ticket(T(5));
  assert.ok(!t5.assignee, 'a legacy agent uuid without a spec cannot be dispatched');
});

test('tickets of an archived board are archived', async () => {
  assert.ok((await ticket(T(7))).archived_at);
  assert.ok(!(await ticket(T(2))).archived_at);
});

test('board settings move to the workspace', async () => {
  const [ws] = await ds.query('SELECT * FROM workspaces WHERE id = ?', [WS]);
  assert.equal(ws.language, 'Korean');
  assert.equal(Number(ws.auto_archive_days), 14);
  assert.equal(Number(ws.max_concurrent_tickets_per_agent), 2);
});

test('board-scoped workflow functions fold into the workspace without key collisions', async () => {
  const rows = await ds.query("SELECT id, key FROM workflow_functions WHERE workspace_id = ? ORDER BY key", [WS]);
  assert.deepEqual(rows.map((r) => [r.key, r.id]), [['custom.deploy', FN.ws], ['custom.lint', FN.boardFree]]);
  const indexes = (await ds.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_functions'")).map((r) => r.name);
  assert.ok(indexes.includes('uq_workflow_functions_workspace_key'), indexes.join(', '));
  assert.ok(indexes.includes('uq_workflow_functions_global_key'), indexes.join(', '));
  assert.ok(!indexes.includes('uq_workflow_functions_board_key'));
});

test('retired tables and snapshots are dropped', async () => {
  const tables = (await ds.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  for (const gone of ['boards', 'columns', 'workspace_roles', 'ticket_role_assignments', 'board_lessons',
    'board_removal_ticket_snapshot', 'board_removal_repo_snapshot']) {
    assert.ok(!tables.includes(gone), `${gone} should be dropped`);
  }
});

exitAfterTests();
