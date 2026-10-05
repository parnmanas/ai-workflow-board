// Real SQLite/Postgres DDL: preserve ownership before synchronize, including
// the independent ontology database and installations still needing 0091.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DataSource, EntitySchema } from 'typeorm';
import { preSyncAccountOwnership, migrateAccountOwnership } from '../dist/database/pre-sync-account-ownership.js';
import { AccountOwnership1760000000092 } from '../dist/database/migrations/1760000000092-AccountOwnership.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const execFileAsync = promisify(execFile);
const OLD_JSON = JSON.stringify([{
  id: 'operator-existing-session', workspace_id: OWNER, manager_id: 'host-1', session_id: 'native-session-1',
  nested: { owner_workspace_id: OTHER_OWNER, allowed_workspace_ids: [OWNER, OTHER_OWNER], scope: 'workspace' },
  workspace_folder: '/srv/workspaces/project', prompt: 'workspace_id must stay inside this user text',
}]);
const NEW_JSON = [{
  id: 'operator-existing-session', account_id: OWNER, manager_id: 'host-1', session_id: 'native-session-1',
  nested: { owner_account_id: OTHER_OWNER, allowed_account_ids: [OWNER, OTHER_OWNER], scope: 'account' },
  workspace_folder: '/srv/workspaces/project', prompt: 'workspace_id must stay inside this user text',
}];

const varchar = { type: 'varchar' };
const nullable = { type: 'varchar', nullable: true };
function entity(tableName, columns, extras = {}) {
  return new EntitySchema({ name: tableName, tableName, columns: { id: { ...varchar, primary: true }, ...columns }, ...extras });
}
const CURRENT_ENTITIES = [
  entity('accounts', { name: varchar, description: { type: 'text' }, language: nullable }),
  entity('tickets', { account_id: varchar, title: varchar, description: { type: 'text' } }),
  entity('projects', { account_id: varchar, repo_url: varchar }),
  entity('credentials', { account_id: nullable, encrypted_data: { type: 'text' } }),
  entity('users', { requested_account_id: nullable, name: varchar }),
  entity('orchestration_teams', {
    account_id: nullable, owner_account_id: nullable, allowed_account_ids: { type: 'text', nullable: true },
  }),
  entity('automation_schedules', { account_id: varchar, task_prompt: { type: 'text' }, next_run_at: varchar }),
  entity('agent_session_cli_settings', { account_id: varchar, manager_id: varchar, cli: varchar, credential_id: nullable }),
  new EntitySchema({ name: 'system_settings', tableName: 'system_settings', columns: { key: { ...varchar, primary: true }, value: { type: 'text' } } }),
  entity('relation_tuples', { subject_type: varchar, subject_id: varchar, relation: varchar, object_type: varchar, object_id: varchar }),
];

async function seedLegacy(source) {
  for (const sql of [
    'CREATE TABLE workspaces (id varchar PRIMARY KEY, name varchar NOT NULL, description text NOT NULL, language varchar)',
    'CREATE TABLE tickets (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, title varchar NOT NULL, description text NOT NULL)',
    'CREATE INDEX idx_legacy_ticket_owner ON tickets (workspace_id)',
    'CREATE TABLE projects (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, repo_url varchar NOT NULL)',
    'CREATE TABLE credentials (id varchar PRIMARY KEY, workspace_id varchar, encrypted_data text NOT NULL)',
    'CREATE UNIQUE INDEX uq_legacy_private_credential ON credentials (workspace_id, encrypted_data) WHERE workspace_id IS NOT NULL',
    'CREATE TABLE users (id varchar PRIMARY KEY, requested_workspace_id varchar, name varchar NOT NULL)',
    'CREATE TABLE orchestration_teams (id varchar PRIMARY KEY, workspace_id varchar, owner_workspace_id varchar, allowed_workspace_ids text)',
    'CREATE TABLE workspace_schedules (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, task_prompt text NOT NULL, next_run_at varchar NOT NULL)',
    'CREATE TABLE agent_session_cli_settings (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, manager_id varchar NOT NULL, cli varchar NOT NULL, credential_id varchar)',
    'CREATE UNIQUE INDEX uq_legacy_session_binding ON agent_session_cli_settings (workspace_id, manager_id, cli)',
    'CREATE TABLE system_settings (key varchar PRIMARY KEY, value text NOT NULL)',
    'CREATE TABLE relation_tuples (id varchar PRIMARY KEY, subject_type varchar NOT NULL, subject_id varchar NOT NULL, relation varchar NOT NULL, object_type varchar NOT NULL, object_id varchar NOT NULL)',
    'CREATE TABLE activity_logs (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, entity_type varchar NOT NULL, note text NOT NULL)',
    'CREATE TABLE owner_children (id varchar PRIMARY KEY, workspace_id varchar NOT NULL REFERENCES workspaces(id), note text)',
    'CREATE TABLE board_removal_repo_snapshot (id varchar PRIMARY KEY, workspace_id varchar, name varchar)',
  ]) await source.query(sql);
  const parameter = source.options.type === 'postgres' ? (n) => `$${n}` : () => '?';
  const insert = (table, values) => source.query(`INSERT INTO "${table}" VALUES (${values.map((_, i) => parameter(i + 1)).join(', ')})`, values);
  await insert('workspaces', [OWNER, 'Personal', 'Keep this description', 'Korean']);
  await insert('workspaces', [OTHER_OWNER, 'Organization', 'Separate existing owner', 'English']);
  await insert('tickets', ['ticket-1', OWNER, 'Existing ticket', '{"workspace_id":"user-authored-json"}']);
  await insert('projects', ['project-1', OTHER_OWNER, 'https://example.com/repo.git']);
  await insert('credentials', ['private-credential', OWNER, 'ciphertext-private']);
  await insert('credentials', ['global-credential', null, 'ciphertext-global']);
  await insert('users', ['user-1', OWNER, 'Operator']);
  await insert('orchestration_teams', ['team-1', null, OTHER_OWNER, JSON.stringify([OWNER, OTHER_OWNER])]);
  await insert('workspace_schedules', ['schedule-1', OWNER, 'Do the existing task', '2026-10-07T10:00:00Z']);
  await insert('agent_session_cli_settings', ['binding-1', OWNER, 'host-1', 'codex', 'private-credential']);
  await insert('system_settings', ['operator.sessions', OLD_JSON]);
  await insert('system_settings', ['unchanged.scalar', 'literal workspace_id value']);
  await insert('relation_tuples', ['membership-1', 'user', 'user-1', 'owner', 'workspace', OWNER]);
  await insert('relation_tuples', ['membership-2', 'workspace', OWNER, 'parent', 'resource', 'resource-1']);
  await insert('activity_logs', ['audit-1', OWNER, 'workspace', 'Existing ownership settings audit']);
  await insert('activity_logs', ['audit-2', OWNER, 'ticket', 'User text mentioning workspace']);
  await insert('owner_children', ['child-1', OWNER, 'FK must survive']);
  await insert('board_removal_repo_snapshot', ['snapshot-1', OTHER_OWNER, 'Pending legacy snapshot']);
}

async function assertMigrated(source, query = (sql, params) => source.query(sql, params)) {
  assert.deepEqual(await query('SELECT id, name, description, language FROM accounts ORDER BY id'), [
    { id: OWNER, name: 'Personal', description: 'Keep this description', language: 'Korean' },
    { id: OTHER_OWNER, name: 'Organization', description: 'Separate existing owner', language: 'English' },
  ]);
  assert.deepEqual(await query('SELECT id, account_id, title, description FROM tickets'), [{
    id: 'ticket-1', account_id: OWNER, title: 'Existing ticket', description: '{"workspace_id":"user-authored-json"}',
  }]);
  assert.deepEqual(await query('SELECT account_id, encrypted_data FROM credentials ORDER BY id'), [
    { account_id: null, encrypted_data: 'ciphertext-global' }, { account_id: OWNER, encrypted_data: 'ciphertext-private' },
  ]);
  assert.equal((await query('SELECT requested_account_id FROM users'))[0].requested_account_id, OWNER);
  const team = (await query('SELECT * FROM orchestration_teams'))[0];
  assert.equal(team.account_id, null);
  assert.equal(team.owner_account_id, OTHER_OWNER);
  assert.deepEqual(JSON.parse(team.allowed_account_ids), [OWNER, OTHER_OWNER]);
  const schedule = (await query('SELECT * FROM automation_schedules'))[0];
  assert.equal(schedule.id, 'schedule-1');
  assert.equal(schedule.account_id, OWNER);
  assert.equal(schedule.next_run_at, '2026-10-07T10:00:00Z');
  const binding = (await query('SELECT * FROM agent_session_cli_settings'))[0];
  assert.equal(binding.account_id, OWNER);
  assert.equal(binding.manager_id, 'host-1');
  assert.equal(binding.credential_id, 'private-credential');
  assert.deepEqual(JSON.parse((await query("SELECT value FROM system_settings WHERE key = 'operator.sessions'"))[0].value), NEW_JSON);
  assert.equal((await query("SELECT value FROM system_settings WHERE key = 'unchanged.scalar'"))[0].value, 'literal workspace_id value');
  assert.deepEqual(await query('SELECT subject_type, object_type, object_id FROM relation_tuples ORDER BY id'), [
    { subject_type: 'user', object_type: 'account', object_id: OWNER },
    { subject_type: 'account', object_type: 'resource', object_id: 'resource-1' },
  ]);
  assert.equal((await query('SELECT account_id FROM owner_children'))[0].account_id, OWNER);
  assert.equal((await query('SELECT account_id FROM board_removal_repo_snapshot'))[0].account_id, OTHER_OWNER);
  assert.deepEqual(await query('SELECT account_id, entity_type, note FROM activity_logs ORDER BY id'), [
    { account_id: OWNER, entity_type: 'account', note: 'Existing ownership settings audit' },
    { account_id: OWNER, entity_type: 'ticket', note: 'User text mentioning workspace' },
  ]);
}

async function withSqlite(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-account-ownership-'));
  const options = { type: 'sqljs', location: path.join(dir, 'legacy.db'), autoSave: false, entities: [], synchronize: false };
  const source = await new DataSource(options).initialize();
  try { await fn(source, options); }
  finally {
    if (source.isInitialized) await source.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedBoardLegacy(source) {
  for (const sql of [
    'CREATE TABLE workspaces (id varchar PRIMARY KEY, name varchar NOT NULL, created_at varchar NOT NULL, language varchar, auto_archive_days integer, max_concurrent_tickets_per_agent integer NOT NULL DEFAULT 1)',
    'CREATE TABLE boards (id varchar PRIMARY KEY, workspace_id varchar, name varchar NOT NULL, language varchar, auto_archive_days integer, max_concurrent_tickets_per_agent integer, archived_at varchar, environment_config text)',
    'CREATE TABLE columns (id varchar PRIMARY KEY, board_id varchar NOT NULL, name varchar NOT NULL, kind varchar NOT NULL)',
    'CREATE TABLE tickets (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, title varchar NOT NULL, column_id varchar, labels text, base_repo_resource_id varchar)',
    'CREATE TABLE resources (id varchar PRIMARY KEY, workspace_id varchar, name varchar, description text, type varchar, url varchar, default_branch varchar, credential_id varchar)',
  ]) await source.query(sql);
  await source.query('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)', [OWNER, 'Existing owner', '2026-01-01', null, null, 1]);
  await source.query('INSERT INTO boards VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['board-1', OWNER, 'Legacy Board', 'Korean', 14, 3, null, null]);
  await source.query('INSERT INTO columns VALUES (?, ?, ?, ?)', ['column-1', 'board-1', 'Done', 'terminal']);
  await source.query('INSERT INTO resources VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['repo-1', OWNER, 'Repository', 'Keep description', 'repository', 'https://example.com/old-repo', 'main', null]);
  await source.query('INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?)', ['ticket-1', OWNER, 'Old board ticket', 'column-1', '["bug"]', 'repo-1']);
}

function isolatedSqliteEnvironment(options, ontologyLocation) {
  return {
    ...process.env, DB_TYPE: 'sqlite', SQLJS_DB_PATH: options.location,
    SQLJS_ONTOLOGY_DB_PATH: ontologyLocation, AWB_DATA_DIR: path.dirname(options.location),
    DOTENV_CONFIG_PATH: path.join(path.dirname(options.location), 'no-environment-file'),
  };
}

function within(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForCompiledHealth(child, url, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`entrypoint exited before health: ${output()}`);
    try {
      const response = await fetch(url, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(1500) });
      await response.text();
      if (response.status === 200) return;
    } catch { /* listener is not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`entrypoint failed to become healthy: ${output()}`);
}

test('SQLite pre-sync preserves all owner ids, global credentials, schedules, settings and ReBAC through synchronize and 0092', async () => {
  await withSqlite(async (legacy, options) => {
    await seedLegacy(legacy);
    await legacy.sqljsManager.saveDatabase();
    await legacy.destroy();
    await preSyncAccountOwnership(options);
    await preSyncAccountOwnership(options);
    const current = await new DataSource({ ...options, entities: CURRENT_ENTITIES, synchronize: true, migrations: [AccountOwnership1760000000092] }).initialize();
    try {
      await current.runMigrations();
      await assertMigrated(current);
      const runner = current.createQueryRunner();
      try {
        assert.equal(await runner.hasTable('workspaces'), false);
        assert.equal(await runner.hasTable('workspace_schedules'), false);
        assert.equal(await runner.hasColumn('tickets', 'workspace_id'), false);
        assert.equal(await migrateAccountOwnership(runner), false);
        // Native ALTER RENAME also rewrites unmanaged FK references and partial
        // index predicates, so those must remain usable after the owner rename.
        assert.deepEqual(await current.query('PRAGMA foreign_key_check'), []);
        const foreignKeys = await current.query('PRAGMA foreign_key_list("owner_children")');
        assert.equal(foreignKeys[0].table, 'accounts');
        assert.equal(foreignKeys[0].from, 'account_id');
        await assert.rejects(current.query("INSERT INTO owner_children VALUES ('bad', 'missing-owner', 'invalid FK')"), /FOREIGN KEY/);
      } finally { await runner.release(); }
    } finally { await current.destroy(); }
  });
});

for (const [name, extraSql, expected] of [
  ['owner table collision', 'CREATE TABLE accounts (id varchar PRIMARY KEY)', /both workspaces and accounts exist/],
  ['schedule table collision', 'CREATE TABLE automation_schedules (id varchar PRIMARY KEY)', /both workspace_schedules and automation_schedules exist/],
  ['dual owner columns', 'ALTER TABLE tickets ADD COLUMN account_id varchar', /tickets has both workspace_id and account_id/],
]) {
  test(`SQLite refuses ${name} without changing the legacy database`, async () => {
    await withSqlite(async (source) => {
      await seedLegacy(source);
      await source.query(extraSql);
      const before = Buffer.from(source.driver.databaseConnection.export());
      const runner = source.createQueryRunner();
      try { await assert.rejects(migrateAccountOwnership(runner), expected); }
      finally { await runner.release(); }
      assert.deepEqual(Buffer.from(source.driver.databaseConnection.export()), before);
      assert.equal((await source.query('SELECT workspace_id FROM tickets'))[0].workspace_id, OWNER);
    });
  });
}

test('SQLite rolls back every schema and membership change when stored ownership JSON is ambiguous', async () => {
  await withSqlite(async (source) => {
    await seedLegacy(source);
    await source.query('UPDATE system_settings SET value = ? WHERE key = ?', [JSON.stringify({ workspace_id: OWNER, account_id: OTHER_OWNER }), 'operator.sessions']);
    const runner = source.createQueryRunner();
    try {
      await assert.rejects(migrateAccountOwnership(runner), /ambiguous JSON keys workspace_id\/account_id/);
      assert.equal(await runner.hasTable('workspaces'), true);
      assert.equal(await runner.hasTable('accounts'), false);
      assert.equal(await runner.hasColumn('tickets', 'workspace_id'), true);
      assert.equal((await source.query("SELECT object_type FROM relation_tuples WHERE id = 'membership-1'"))[0].object_type, 'workspace');
    } finally { await runner.release(); }
  });
});

test('SQLite independent ontology file preserves graph ownership without an accounts table', async () => {
  await withSqlite(async (source, options) => {
    for (const table of ['ontology_graphs', 'ontology_nodes', 'ontology_edges']) {
      await source.query(`CREATE TABLE ${table} (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, graph_id varchar NOT NULL, props text NOT NULL)`);
      await source.query(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`, [table, OTHER_OWNER, 'graph-1', '{"source":"unchanged"}']);
    }
    await source.sqljsManager.saveDatabase();
    await source.destroy();
    await preSyncAccountOwnership(options);
    const current = await new DataSource({ ...options, synchronize: true, entities: ['ontology_graphs', 'ontology_nodes', 'ontology_edges'].map((table) => entity(table, { account_id: varchar, graph_id: varchar, props: { type: 'text' } })) }).initialize();
    try {
      for (const table of ['ontology_graphs', 'ontology_nodes', 'ontology_edges']) {
        assert.deepEqual(await current.query(`SELECT * FROM ${table}`), [{ id: table, account_id: OTHER_OWNER, graph_id: 'graph-1', props: '{"source":"unchanged"}' }]);
      }
    } finally { await current.destroy(); }
  });
});

test('SQLite ownership pre-sync runs before 0090 and preserves old pairing links, native settings and runtime specs', async () => {
  const { preSyncAgentCleanup } = await import('../dist/database/pre-sync-agent-cleanup.js');
  await withSqlite(async (source, options) => {
    for (const sql of [
      'CREATE TABLE workspaces (id varchar PRIMARY KEY, name varchar NOT NULL, assistant_agent_id varchar)',
      'CREATE TABLE agents (id varchar PRIMARY KEY, workspace_id varchar, name varchar NOT NULL, type varchar NOT NULL, is_active integer NOT NULL)',
      'CREATE TABLE api_keys (id varchar PRIMARY KEY, workspace_id varchar, agent_id varchar, host_id varchar, name varchar NOT NULL)',
      'CREATE TABLE agent_session_cli_settings (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, manager_id varchar NOT NULL, cli varchar NOT NULL, credential_id varchar)',
      'CREATE TABLE workspace_schedules (id varchar PRIMARY KEY, workspace_id varchar NOT NULL, target_agent_id varchar, target_runtime text)',
      'CREATE TABLE chat_room_participants (id varchar PRIMARY KEY, runtime_spec text)',
    ]) await source.query(sql);
    const managerId = '33333333-3333-4333-8333-333333333333';
    const hostId = '44444444-4444-4444-8444-444444444444';
    await source.query('INSERT INTO workspaces VALUES (?, ?, ?)', [OWNER, 'Existing owner', managerId]);
    await source.query('INSERT INTO agents VALUES (?, ?, ?, ?, ?)', [managerId, null, 'Existing paired manager', 'manager', 1]);
    await source.query('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?)', ['pairing-key', OWNER, managerId, hostId, 'Existing key']);
    await source.query('INSERT INTO agent_session_cli_settings VALUES (?, ?, ?, ?, ?)', ['setting-1', OWNER, managerId, 'codex', 'credential-1']);
    await source.query('INSERT INTO workspace_schedules VALUES (?, ?, ?, ?)', ['schedule-1', OWNER, managerId, JSON.stringify({ manager_agent_id: managerId, cli: 'codex', working_dir: '/srv/project' })]);
    await source.query('INSERT INTO chat_room_participants VALUES (?, ?)', ['participant-1', JSON.stringify({ manager_agent_id: managerId, workspace_id: OTHER_OWNER })]);
    await source.sqljsManager.saveDatabase();
    await source.destroy();
    await preSyncAccountOwnership(options);
    await preSyncAgentCleanup(options);
    await preSyncAgentCleanup(options);
    const current = await new DataSource(options).initialize();
    try {
      const host = (await current.query('SELECT * FROM runtime_hosts'))[0];
      assert.equal(host.id, hostId);
      assert.equal(host.account_id, OWNER);
      const key = (await current.query('SELECT * FROM api_keys'))[0];
      assert.equal(key.id, 'pairing-key');
      assert.equal(key.host_id, hostId);
      assert.equal(key.account_id, OWNER);
      assert.equal(Object.hasOwn(key, 'agent_id'), false);
      const setting = (await current.query('SELECT * FROM agent_session_cli_settings'))[0];
      assert.equal(setting.manager_id, hostId);
      assert.equal(setting.account_id, OWNER);
      assert.equal(setting.credential_id, 'credential-1');
      const schedule = (await current.query('SELECT * FROM automation_schedules'))[0];
      assert.equal(schedule.account_id, OWNER);
      assert.equal(JSON.parse(schedule.target_runtime).manager_agent_id, hostId);
      const participant = (await current.query('SELECT runtime_spec FROM chat_room_participants'))[0];
      assert.deepEqual(JSON.parse(participant.runtime_spec), { manager_agent_id: hostId, account_id: OTHER_OWNER });
    } finally { await current.destroy(); }
  });
});

test('SQLite upgrades pre-board-removal installations before 0091 snapshots, synchronize and 0092', async () => {
  const { preSyncBoardRemoval } = await import('../dist/database/pre-sync-board-removal.js');
  const { BoardlessTickets1760000000091 } = await import('../dist/database/migrations/1760000000091-BoardlessTickets.js');
  await withSqlite(async (source, options) => {
    await seedBoardLegacy(source);
    await source.sqljsManager.saveDatabase();
    await source.destroy();
    await preSyncAccountOwnership(options);
    await preSyncBoardRemoval(options);
    const current = await new DataSource({ ...options, synchronize: true, migrations: [BoardlessTickets1760000000091, AccountOwnership1760000000092], entities: [
      entity('accounts', { name: varchar, created_at: varchar, language: nullable, auto_archive_days: { type: 'integer', nullable: true }, max_concurrent_tickets_per_agent: { type: 'integer', default: 1 } }),
      entity('tickets', { account_id: varchar, title: varchar, status: { ...varchar, default: 'todo' }, tags: { type: 'text', default: '[]' }, project_id: nullable, assignee: { type: 'text', nullable: true }, assignee_key: { ...varchar, default: '' }, archived_at: nullable }),
      entity('projects', { account_id: varchar, name: varchar, description: { type: 'text', default: '' }, repo_url: varchar, default_branch: varchar, credential_id: nullable, clone_policy: { type: 'text', nullable: true }, use_pr: { type: 'boolean', default: false }, instructions: { type: 'text', default: '' } }),
      entity('resources', { account_id: nullable, name: varchar, description: { type: 'text' }, type: varchar, url: varchar, credential_id: nullable }),
    ] }).initialize();
    try {
      await current.runMigrations();
      const ticket = (await current.query('SELECT * FROM tickets'))[0];
      assert.equal(ticket.account_id, OWNER);
      assert.equal(ticket.status, 'done');
      assert.deepEqual(JSON.parse(ticket.tags), ['bug', 'Legacy Board']);
      assert.equal(ticket.project_id, 'repo-1');
      const project = (await current.query('SELECT * FROM projects'))[0];
      assert.equal(project.id, 'repo-1');
      assert.equal(project.account_id, OWNER);
      assert.equal(project.repo_url, 'https://example.com/old-repo');
      const account = (await current.query('SELECT * FROM accounts'))[0];
      assert.equal(account.language, 'Korean');
      assert.equal(account.auto_archive_days, 14);
      assert.equal(account.max_concurrent_tickets_per_agent, 3);
    } finally { await current.destroy(); }
  });
});

test('offline migration wrapper rejects --fake before opening or changing either SQLite database', async () => {
  await withSqlite(async (source, options) => {
    await seedBoardLegacy(source);
    await source.sqljsManager.saveDatabase();
    await source.destroy();
    const before = await fs.readFile(options.location);
    const ontology = path.join(path.dirname(options.location), 'ontology-must-not-be-created.db');
    const wrapper = fileURLToPath(new URL('../dist/database/run-migrations.js', import.meta.url));
    await assert.rejects(execFileAsync(process.execPath, [wrapper, '--fake'], {
      env: isolatedSqliteEnvironment(options, ontology), timeout: 30_000,
    }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unsupported migration arguments/);
      return true;
    });
    assert.deepEqual(await fs.readFile(options.location), before, 'legacy file remains byte-for-byte unchanged');
    await assert.rejects(fs.access(ontology), { code: 'ENOENT' });
    const fresh = { ...options, location: path.join(path.dirname(options.location), 'fresh-must-not-be-created.db') };
    await assert.rejects(execFileAsync(process.execPath, [wrapper, '--fake'], {
      env: isolatedSqliteEnvironment(fresh, ontology), timeout: 30_000,
    }), error => error.code === 1 && /Unsupported migration arguments/.test(error.stderr));
    await assert.rejects(fs.access(fresh.location), { code: 'ENOENT' });
    await assert.rejects(fs.access(ontology), { code: 'ENOENT' });
  });
});

test('standalone initDb upgrades pre-0091 SQLite data and applies the migration ledger before serving MCP', async () => {
  await withSqlite(async (source, options) => {
    await seedBoardLegacy(source);
    await source.sqljsManager.saveDatabase();
    await source.destroy();
    const ontology = path.join(path.dirname(options.location), 'ontology.db');
    const dbModule = new URL('../dist/db.js', import.meta.url).href;
    // A separate process owns the real AppDataSource singleton, exactly as the
    // standalone entry does, without starting a network server or a CLI agent.
    const script = `
      const db = await import(${JSON.stringify(dbModule)});
      try {
        await db.initDb();
        await db.flushSqljs(db.AppDataSource, true);
        if (db.AppOntologyDataSource) await db.flushOntologySqljs(db.AppOntologyDataSource, true);
      } finally {
        if (db.AppOntologyDataSource?.isInitialized) await db.AppOntologyDataSource.destroy();
        if (db.AppDataSource.isInitialized) await db.AppDataSource.destroy();
      }
    `;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: isolatedSqliteEnvironment(options, ontology), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    const persisted = await new DataSource(options).initialize();
    try {
      const ticket = (await persisted.query('SELECT account_id, status, tags, project_id FROM tickets'))[0];
      assert.equal(ticket.account_id, OWNER);
      assert.equal(ticket.status, 'done', '0091 data transformation has already run');
      assert.deepEqual(JSON.parse(ticket.tags), ['bug', 'Legacy Board']);
      assert.equal(ticket.project_id, 'repo-1');
      assert.deepEqual(await persisted.query('SELECT id, account_id, repo_url FROM projects'), [{
        id: 'repo-1', account_id: OWNER, repo_url: 'https://example.com/old-repo',
      }]);
      const account = (await persisted.query('SELECT * FROM accounts'))[0];
      assert.equal(account.language, 'Korean');
      assert.equal(account.auto_archive_days, 14);
      assert.equal(account.max_concurrent_tickets_per_agent, 3);
      const migrations = (await persisted.query('SELECT name FROM migrations')).map(row => row.name);
      assert.ok(migrations.includes('BoardlessTickets1760000000091'));
      assert.ok(migrations.includes('AccountOwnership1760000000092'));
      const retired = await persisted.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspaces', 'boards', 'columns', 'board_removal_ticket_snapshot', 'board_removal_repo_snapshot')");
      assert.deepEqual(retired, [], 'retired source tables and consumed snapshots are gone');
    } finally { await persisted.destroy(); }
  });
});

for (const [entrypoint, healthPath] of [['main.js', '/api/health'], ['mcp-server.js', '/health']]) {
  test(`compiled ${entrypoint} loads .env paths before opening DBs and recovers both corrupt SQLite files before ownership migration`, { timeout: 60_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awb-account-entrypoint-'));
    let child;
    let exited;
    try {
      // Run the unchanged compiled artifacts from an isolated tree. If dotenv
      // loading regresses, even the default database paths stay inside /tmp,
      // so the test cannot touch the repository's real database files.
      const compiled = path.join(dir, 'apps', 'server', 'dist');
      await fs.cp(fileURLToPath(new URL('../dist/', import.meta.url)), compiled, { recursive: true });
      await fs.symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const dataDir = path.join(dir, 'configured-data');
      await fs.mkdir(dataDir);
      const primary = path.join(dataDir, 'primary.db');
      const ontology = path.join(dataDir, 'ontology.db');
      const primaryBytes = Buffer.from(`corrupt primary for ${entrypoint} ownership boot`);
      const ontologyBytes = Buffer.from(`corrupt ontology for ${entrypoint} ownership boot`);
      await fs.writeFile(primary, primaryBytes);
      await fs.writeFile(ontology, ontologyBytes);
      const envFile = path.join(dir, 'entrypoint.env');
      await fs.writeFile(envFile, [
        'DB_TYPE=sqlite', `SQLJS_DB_PATH=${primary}`, `SQLJS_ONTOLOGY_DB_PATH=${ontology}`, 'AWB_DB_AUTORECOVER=1',
      ].join('\n'));
      const { findFreePort } = await import('./helpers/boot.mjs');
      const port = await findFreePort();
      const env = {
        ...process.env, DOTENV_CONFIG_PATH: envFile, NODE_ENV: 'test', AWB_DATA_DIR: dataDir,
        PORT: String(port), MCP_PORT: String(port), MCP_TRANSPORT: 'http',
        MCP_DEV_MODE: 'true', AGENT_DEV_MODE: 'true', ORCHESTRATION_REAPER_ENABLED: 'false',
      };
      for (const key of ['DB_TYPE', 'DB_SCHEMA', 'SQLJS_DB_PATH', 'SQLJS_ONTOLOGY_DB_PATH', 'AWB_DB_AUTORECOVER']) delete env[key];
      let output = '';
      child = spawn(process.execPath, [path.join(compiled, entrypoint)], {
        cwd: path.join(dir, 'apps', 'server'), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = chunk => { output = (output + chunk.toString()).slice(-16_000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      await waitForCompiledHealth(child, `http://127.0.0.1:${port}${healthPath}`, () => output);
      const files = await fs.readdir(dataDir);
      for (const [basename, bytes] of [['primary.db', primaryBytes], ['ontology.db', ontologyBytes]]) {
        const backups = files.filter(name => name.startsWith(`${basename}.corrupt-`));
        assert.equal(backups.length, 1, `${basename} is recovered once before pre-sync opens it`);
        assert.deepEqual(await fs.readFile(path.join(dataDir, backups[0])), bytes, 'recovery retains the exact original corrupt bytes');
      }
      child.kill('SIGTERM');
      const outcome = await within(exited, 10_000, `entrypoint did not stop gracefully: ${output}`);
      assert.notEqual(outcome.signal, 'SIGKILL');
      assert.ok(outcome.code === 0 || outcome.signal === 'SIGTERM', `unexpected shutdown: ${JSON.stringify(outcome)} ${output}`);
      // Graceful shutdown must persist both independently initialized files.
      for (const [location, expectedTable, excludedTable] of [[primary, 'accounts', 'ontology_graphs'], [ontology, 'ontology_graphs', 'accounts']]) {
        assert.equal((await fs.readFile(location)).subarray(0, 16).toString(), 'SQLite format 3\0');
        const source = await new DataSource({ type: 'sqljs', location, autoSave: false, entities: [], synchronize: false }).initialize();
        try {
          assert.deepEqual(await source.query('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
          const tables = (await source.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map(row => row.name);
          assert.ok(tables.includes(expectedTable));
          assert.ok(!tables.includes(excludedTable), 'primary and ontology schema ownership remain independent');
          if (location === primary) {
            const ledger = await source.query("SELECT count(*) AS n FROM migrations WHERE name = 'AccountOwnership1760000000092'");
            assert.equal(ledger[0].n, 1);
          }
        } finally { await source.destroy(); }
      }
      for (const basename of ['data.db', 'ontology.db']) {
        await assert.rejects(fs.access(path.join(dir, 'database', basename)), { code: 'ENOENT' });
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await within(exited, 5000, 'test child cleanup timed out').catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('fresh account schema and 0092 remain idempotent', async () => {
  await withSqlite(async (source) => {
    const runner = source.createQueryRunner();
    try {
      assert.equal(await migrateAccountOwnership(runner), false);
      await new AccountOwnership1760000000092().up(runner);
      assert.equal(await migrateAccountOwnership(runner), false);
    } finally { await runner.release(); }
  });
});

test('Postgres ownership DDL preserves data, indexes and FKs, isolates the configured schema and rolls back conflicts', {
  skip: process.env.DB_TYPE !== 'postgres' ? 'requires DB_TYPE=postgres (isolated CI Postgres database)' : false,
}, async () => {
  const { Client } = await import('pg');
  const connection = {
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres', password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'ai_workflow',
  };
  const schema = `qa_account_owner_${process.pid}`;
  const other = `${schema}_untouched`;
  const admin = new Client(connection);
  let source;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE SCHEMA "${other}"`);
    await admin.query(`CREATE TABLE "${other}".workspaces (id varchar PRIMARY KEY, workspace_id varchar)`);
    await admin.query(`INSERT INTO "${other}".workspaces VALUES ('sentinel', 'untouched-owner')`);
    const options = {
      type: 'postgres', host: connection.host, port: connection.port, username: connection.user,
      password: connection.password, database: connection.database, schema, entities: [], synchronize: false,
      extra: { options: `-c search_path=${schema},${other},public` },
    };
    source = await new DataSource(options).initialize();
    await seedLegacy(source);
    await preSyncAccountOwnership(options);
    await assertMigrated(source);
    // 0092 runs inside TypeORM's migration transaction; its savepoint must
    // neither commit nor roll back unrelated caller work.
    const runner = source.createQueryRunner();
    try {
      await runner.startTransaction();
      await new AccountOwnership1760000000092().up(runner);
      assert.equal(runner.isTransactionActive, true);
      await runner.commitTransaction();
      assert.equal(await migrateAccountOwnership(runner), false);
    } finally { await runner.release(); }
    assert.deepEqual((await admin.query(`SELECT * FROM "${other}".workspaces`)).rows, [{ id: 'sentinel', workspace_id: 'untouched-owner' }]);
    const index = (await admin.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [schema, 'uq_legacy_private_credential'])).rows[0];
    assert.match(index.indexdef, /account_id IS NOT NULL/);
    await assert.rejects(source.query("INSERT INTO owner_children VALUES ('bad', 'missing-owner', 'invalid FK')"), /foreign key/i);
    await source.destroy();
    source = await new DataSource({ ...options, synchronize: true, entities: CURRENT_ENTITIES }).initialize();
    await assertMigrated(source);
    await source.destroy();
    source = null;
    // A second, isolated legacy schema verifies transactional rollback AFTER
    // DDL, rather than merely the collision preflight returning an error.
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = await new DataSource(options).initialize();
    await seedLegacy(source);
    await source.query('UPDATE system_settings SET value = $1 WHERE key = $2', [JSON.stringify({ workspace_id: OWNER, account_id: OTHER_OWNER }), 'operator.sessions']);
    await assert.rejects(preSyncAccountOwnership(options), /ambiguous JSON keys/);
    assert.equal((await source.query('SELECT workspace_id FROM tickets'))[0].workspace_id, OWNER);
    assert.equal((await source.query("SELECT object_type FROM relation_tuples WHERE id = 'membership-1'"))[0].object_type, 'workspace');
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'accounts'", [schema])).rows[0].count, 0);
  } finally {
    if (source?.isInitialized) await source.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
    await admin.end();
  }
});

test('Postgres pre-sync changes only DB_SCHEMA and preserves public and foreign schema rows, FK constraints and UUID types', {
  skip: process.env.DB_TYPE !== 'postgres' ? 'requires DB_TYPE=postgres (isolated CI Postgres database)' : false,
}, async () => {
  const { Client } = await import('pg');
  const { preSyncPostgres } = await import('../dist/database/pre-sync-postgres.js');
  const admin = new Client({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres', password: process.env.DB_PASS || '', database: process.env.DB_NAME || 'ai_workflow',
  });
  const schema = `qa_presync_owner_${process.pid}`;
  const foreignSchema = `${schema}_foreign`;
  const freshSchema = `${schema}_fresh`;
  const parent = `qa_presync_parent_${process.pid}`;
  const child = `qa_presync_child_${process.pid}`;
  const previousSchema = process.env.DB_SCHEMA;
  await admin.connect();
  async function seed(schemaName) {
    await admin.query(`CREATE TABLE "${schemaName}"."${parent}" (id uuid PRIMARY KEY, note text NOT NULL)`);
    await admin.query(`CREATE TABLE "${schemaName}"."${child}" (id uuid PRIMARY KEY, parent_id uuid NOT NULL,
      CONSTRAINT "${child}_fk" FOREIGN KEY (parent_id) REFERENCES "${schemaName}"."${parent}"(id))`);
    await admin.query(`INSERT INTO "${schemaName}"."${parent}" VALUES ($1, $2)`, [OWNER, 'Keep sentinel parent']);
    await admin.query(`INSERT INTO "${schemaName}"."${child}" VALUES ($1, $2)`, [OTHER_OWNER, OWNER]);
  }
  async function facts(schemaName) {
    return {
      parents: (await admin.query(`SELECT * FROM "${schemaName}"."${parent}"`)).rows,
      children: (await admin.query(`SELECT * FROM "${schemaName}"."${child}"`)).rows,
      types: (await admin.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name IN ($2, $3) ORDER BY table_name, column_name`, [schemaName, parent, child])).rows,
      foreignKeys: (await admin.query(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1 AND c.conrelid = $2::regclass AND c.contype = 'f'`, [schemaName, `"${schemaName}"."${child}"`])).rows,
    };
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE SCHEMA "${foreignSchema}"`);
    await seed(schema);
    await seed(foreignSchema);
    await seed('public');
    const publicBefore = await facts('public');
    const foreignBefore = await facts(foreignSchema);
    process.env.DB_SCHEMA = schema;
    await preSyncPostgres();
    const selected = await facts(schema);
    assert.equal(selected.foreignKeys.length, 0, 'pre-sync actually ran in the selected schema');
    assert.equal(selected.types.find(column => column.table_name === child && column.column_name === 'parent_id').data_type, 'character varying');
    assert.deepEqual(selected.children, foreignBefore.children, 'safe UUID cast preserves the selected schema data');
    assert.deepEqual(await facts('public'), publicBefore, 'public rows, constraints and types remain unchanged');
    assert.deepEqual(await facts(foreignSchema), foreignBefore, 'unrelated schema remains unchanged');
    // A missing selected schema must be created before current_schema() is
    // used, otherwise search_path would fall through to public again.
    process.env.DB_SCHEMA = freshSchema;
    await preSyncPostgres();
    const created = await admin.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [freshSchema]);
    assert.equal(created.rows[0].n, 1);
    assert.deepEqual(await facts('public'), publicBefore);
    assert.deepEqual(await facts(foreignSchema), foreignBefore);
  } finally {
    if (previousSchema === undefined) delete process.env.DB_SCHEMA;
    else process.env.DB_SCHEMA = previousSchema;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${foreignSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${freshSchema}" CASCADE`);
    await admin.query(`DROP TABLE IF EXISTS public."${child}"`);
    await admin.query(`DROP TABLE IF EXISTS public."${parent}"`);
    await admin.end();
  }
});
