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
  // Query strings create independent module-local queues, modelling two server processes.
  const tools1 = await import(`${toolUrl}?instance=update`);
  const tools2 = await import(`${toolUrl}?instance=assign`);
  ds1 = new DataSource(buildDataSourceOptions());
  ds2 = new DataSource(buildDataSourceOptions());
  await ds1.initialize();
  await ds2.initialize();

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

  let releaseUpdate;
  const updateBlocked = new Promise(resolve => { releaseUpdate = resolve; });
  let updateLocked;
  const updateLockObserved = new Promise(resolve => { updateLocked = resolve; });
  let assignAttempted;
  const assignAttemptObserved = new Promise(resolve => { assignAttempted = resolve; });
  let assignEntered = false;
  tools1.setProfileLockHookForTests(async (operation, profileId) => {
    if (operation === 'update' && profileId === created.profile.id) {
      updateLocked();
      await updateBlocked;
    }
  });
  tools2.setProfileLockAttemptHookForTests((operation, profileId) => {
    if (operation === 'assign' && profileId === created.profile.id) assignAttempted();
  });
  tools2.setProfileLockHookForTests(async (operation, profileId) => {
    if (operation === 'assign' && profileId === created.profile.id) assignEntered = true;
  });

  try {
    const update = tools1.updateClaudeBackendProfile(ds1, created.profile.id, { credential_ref: credential.id });
    await withTimeout(
      Promise.race([updateLockObserved, update]),
      'update did not acquire the Postgres row lock',
    );
    const assignment = tools2.assignWorkspaceBackendProfile(ds2, foreign.id, created.profile.id, false);
    await withTimeout(assignAttemptObserved, 'assign did not attempt the Postgres row lock');
    assert.equal(assignEntered, false, 'assign entered while update held the row lock');

    releaseUpdate();
    await withTimeout(update, 'credential update did not commit');
    await assert.rejects(
      withTimeout(assignment, 'assignment did not finish after row-lock release'),
      /credential is not owned by this workspace/,
    );
    assert.equal(assignEntered, true, 'assign must enter after the update commits');
    assert.equal(await ds1.getRepository('WorkspaceClaudeBackendProfile').count({
      where: { workspace_id: foreign.id, profile_id: created.profile.id },
    }), 0, 'foreign workspace link must not be inserted');
  } finally {
    releaseUpdate?.();
    tools1.setProfileLockHookForTests();
    tools2.setProfileLockAttemptHookForTests();
    tools2.setProfileLockHookForTests();
  }
});
