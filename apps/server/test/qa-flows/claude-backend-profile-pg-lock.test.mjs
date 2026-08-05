import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_PG = process.env.DB_TYPE === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';
const SCHEMA = `qa_profile_lock_${process.pid}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');
let ds1;
let ds2;

function withTimeout(promise, message, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function adminQuery(sql) {
  const { Client } = await import('pg');
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

async function waitForProfileUpdateLockWait(applicationName, timeoutMs = 10_000) {
  const { Client } = await import('pg');
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await client.connect();
  const deadline = Date.now() + timeoutMs;
  const observed = new Set();
  try {
    while (Date.now() < deadline) {
      const result = await client.query(`
        SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
        FROM pg_stat_activity
        WHERE application_name = $1
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
        ORDER BY query_start DESC
        LIMIT 1
      `, [applicationName]);
      if (result.rows[0]) return result.rows[0];
      const activity = await client.query(`
        SELECT state, wait_event_type, wait_event, left(query, 160) AS query
        FROM pg_stat_activity
        WHERE application_name = $1
      `, [applicationName]);
      for (const row of activity.rows) observed.add(JSON.stringify(row));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`assign UPDATE was not observed waiting on a Postgres row lock; activity=${[...observed].join(',')}`);
  } finally {
    await client.end();
  }
}

after(async () => {
  try { if (ds1?.isInitialized) await ds1.destroy(); } catch { /* best effort */ }
  try { if (ds2?.isInitialized) await ds2.destroy(); } catch { /* best effort */ }
  if (IS_PG) {
    try { await adminQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); } catch { /* best effort */ }
  }
});

test('Postgres row lock serializes update and assign across independent connections', { skip: SKIP }, async () => {
  assert.match(SCHEMA, /^[a-z_][a-z0-9_]*$/);
  process.env.NODE_ENV = 'test';
  await adminQuery('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await adminQuery(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE; CREATE SCHEMA "${SCHEMA}"`);
  process.env.DB_SCHEMA = SCHEMA;

  const { DataSource } = await import('typeorm');
  const { buildDataSourceOptions } = await import(pathToFileURL(path.join(DIST, 'db.js')));
  const toolUrl = pathToFileURL(path.join(DIST, 'modules', 'mcp', 'tools', 'claude-backend-profile-tools.js')).href;
  // The second DataSource bypasses the process-local queue to model another server process.
  const tools1 = await import(`${toolUrl}?instance=update`);
  const tools2 = await import(`${toolUrl}?instance=assign`);
  ds1 = new DataSource(buildDataSourceOptions());
  const assignApplicationName = `qa-profile-assign-${process.pid}`;
  ds2 = new DataSource({ ...buildDataSourceOptions(), applicationName: assignApplicationName });
  await ds1.initialize();
  await ds2.initialize();
  tools2.setProfileQueueBypassForTests(ds2);
  assert.equal((await ds1.query('SELECT current_schema() AS schema'))[0].schema, SCHEMA);
  assert.equal((await ds2.query('SELECT current_schema() AS schema'))[0].schema, SCHEMA);

  const workspaceRepo = ds1.getRepository('Workspace');
  const owner = await workspaceRepo.save(workspaceRepo.create({ name: 'PG credential owner' }));
  const foreign = await workspaceRepo.save(workspaceRepo.create({ name: 'PG foreign workspace' }));
  const created = await tools1.upsertClaudeBackendProfile(ds1, {
    name: 'Postgres contended profile', base_url: 'http://pg-contended.invalid',
    model: 'pg-contended-model', protocol: 'anthropic-compatible',
  });
  const credentialRepo = ds1.getRepository('Credential');
  const credential = await credentialRepo.save(credentialRepo.create({
    workspace_id: owner.id, name: 'PG owner credential', provider: 'anthropic', encrypted_data: 'test-only',
  }));

  let assignEntered = false;
  tools2.setProfileLockHookForTests(async (operation, profileId) => {
    if (operation === 'assign' && profileId === created.profile.id) assignEntered = true;
  });

  const updateRunner = ds1.createQueryRunner();
  await updateRunner.connect();
  try {
    await updateRunner.startTransaction();
    await updateRunner.manager.createQueryBuilder()
      .update('claude_backend_profiles')
      .set({ id: () => 'id' })
      .where('id = :profileId', { profileId: created.profile.id })
      .execute();
    await updateRunner.manager.getRepository('ClaudeBackendProfile').update(
      { id: created.profile.id },
      { credential_ref: credential.id },
    );
    const assignment = tools2.assignWorkspaceBackendProfile(ds2, foreign.id, created.profile.id, false);
    let assignmentSettled = false;
    assignment.then(
      () => { assignmentSettled = true; },
      () => { assignmentSettled = true; },
    );
    const lockWait = await Promise.race([
      waitForProfileUpdateLockWait(assignApplicationName),
      assignment.then(
        () => { throw new Error('assignment settled before PostgreSQL lock wait was observed'); },
        error => { throw error; },
      ),
    ]);
    assert.equal(lockWait.wait_event_type, 'Lock');
    assert.ok(lockWait.blocking_pids.length > 0, 'assign backend must have a PostgreSQL blocker');
    assert.equal(assignEntered, false, 'assign entered while update held the row lock');
    assert.equal(assignmentSettled, false, 'assign settled while its UPDATE was waiting on the row lock');

    await updateRunner.commitTransaction();
    await assert.rejects(
      withTimeout(assignment, 'assignment did not finish after row-lock release'),
      /credential is not owned by this workspace/,
    );
    assert.equal(assignEntered, true, 'assign must enter after the update commits');
    assert.equal(await ds1.getRepository('WorkspaceClaudeBackendProfile').count({
      where: { workspace_id: foreign.id, profile_id: created.profile.id },
    }), 0, 'foreign workspace link must not be inserted');
  } finally {
    if (updateRunner.isTransactionActive) await updateRunner.rollbackTransaction();
    await updateRunner.release();
    tools2.setProfileLockHookForTests();
    tools2.setProfileQueueBypassForTests(ds2, false);
  }
});
