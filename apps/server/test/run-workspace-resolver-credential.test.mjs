// Server-side wiring — QA/security run dispatch must ship the repo Resource's
// git credential in `run_provision.repo.credential` so the agent-manager's
// run-provisioner can clone/fetch a PRIVATE repo (ticket 4f4d5df2, the residual
// server half of 622bc350's run-provisioner credential path).
//
// 622bc350 built + tested the MANAGER consumption of `run_provision.repo.
// credential` (injection through the shared repo-credential helper, token
// non-exposure in steps/log/on-disk). The gap this test closes is the SERVER
// PRODUCTION of that field: `buildRunProvision` → `resolveRunRepo` must decrypt
// the repo Resource's Credential and attach `{ username?, token }` to the repo
// spec — for the resource_id path AND the environment_config-inherit path — while
// keeping a direct-url repo anonymous and NEVER wedging the run when the
// credential is missing / foreign-workspace / undecryptable (availability-first).
//
// Behavioural (not a static guard): drives the real compiled `buildRunProvision`
// against a fake DataSource + the real encryption service, so a regression that
// stops attaching the credential (or leaks a foreign-workspace token) fails here.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'run-provision-cred-test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunProvision } from '../dist/common/run-workspace-resolver.js';
import { encrypt } from '../dist/services/encryption.service.js';

// --- fake DataSource --------------------------------------------------------
// getRepository(Entity) dispatches by the compiled class name; findOne matches
// every key in `where` (id / workspace_id), mirroring the real TypeORM calls
// resolveRunRepo makes (Resource / Credential / Board / Workspace).

function makeRepo(rows) {
  return {
    async findOne({ where }) {
      return (
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ) || null
      );
    },
  };
}

function makeDataSource({ resources = [], credentials = [], boards = [], workspaces = [] }) {
  const repos = {
    Resource: makeRepo(resources),
    Credential: makeRepo(credentials),
    Board: makeRepo(boards),
    Workspace: makeRepo(workspaces),
  };
  return {
    getRepository(entity) {
      const name = entity?.name || String(entity);
      const repo = repos[name];
      if (!repo) throw new Error(`unexpected entity ${name}`);
      return repo;
    },
  };
}

function credRow(over = {}) {
  const fields = over.fields || { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' };
  return {
    id: over.id || 'cred-1',
    workspace_id: 'workspace_id' in over ? over.workspace_id : 'ws-1',
    encrypted_data: 'encrypted_data' in over ? over.encrypted_data : encrypt(JSON.stringify(fields)),
  };
}

function resourceRow(over = {}) {
  return {
    id: over.id || 'res-1',
    workspace_id: 'workspace_id' in over ? over.workspace_id : 'ws-1',
    url: 'url' in over ? over.url : 'https://github.com/parnmanas/private.git',
    default_branch: over.default_branch || 'main',
    credential_id: 'credential_id' in over ? over.credential_id : 'cred-1',
  };
}

const baseInput = {
  kind: 'qa',
  id: 'scenario-1234',
  runId: 'run-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  workspaceFolder: null,
  checkoutMode: 'reuse',
};

// --- resource_id path -------------------------------------------------------

test('resource_id repo ships the decrypted credential', async () => {
  const ds = makeDataSource({ resources: [resourceRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.ok(rp.repo, 'repo must resolve');
  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('credential with no username omits the username key (manager defaults x-access-token)', async () => {
  const ds = makeDataSource({
    resources: [resourceRow()],
    credentials: [credRow({ fields: { token: 'ghp_TOKEN_ONLY' } })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.deepEqual(rp.repo.credential, { token: 'ghp_TOKEN_ONLY' });
  assert.ok(!('username' in rp.repo.credential), 'username must be omitted, not undefined-valued');
});

test('resource with no credential_id → anonymous (no credential field)', async () => {
  const ds = makeDataSource({ resources: [resourceRow({ credential_id: null })], credentials: [] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.equal(rp.repo.credential, undefined);
});

test('resource path: branch falls back to the resource default_branch; explicit ref.branch wins', async () => {
  // Guards the rewritten resource-path return object — a regression to
  // `branch: ref.branch || undefined` (dropping the default_branch fallback)
  // must fail here even while the credential still ships.
  const ds = makeDataSource({ resources: [resourceRow({ default_branch: 'develop' })], credentials: [credRow()] });

  const fallback = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });
  assert.equal(fallback.repo.branch, 'develop', 'default_branch fills in when ref.branch is absent');
  assert.deepEqual(fallback.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });

  const explicit = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1', branch: 'feature-x' } });
  assert.equal(explicit.repo.branch, 'feature-x', 'explicit ref.branch overrides the resource default');
});

test('global credential (workspace_id = null) is accepted (instance-wide shared)', async () => {
  // resolveGitCredential accepts a GLOBAL credential (workspace_id null); the
  // run-provision path must ship it too, not treat null as foreign-workspace.
  const ds = makeDataSource({ resources: [resourceRow()], credentials: [credRow({ workspace_id: null })] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('repoRef with BOTH url and resource_id → direct url wins, stays anonymous', async () => {
  // Path 1 (direct url) is checked before path 2 (resource_id): a repoRef that
  // carries both never consults the Resource, so its credential is not attached —
  // the url author owns any auth. Guards against reordering the precedence.
  const ds = makeDataSource({ resources: [resourceRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, {
    ...baseInput,
    repoRef: { url: 'https://github.com/x/y.git', resource_id: 'res-1' },
  });

  assert.equal(rp.repo.url, 'https://github.com/x/y.git');
  assert.equal(rp.repo.credential, undefined);
});

// --- direct url path (escape hatch) — stays anonymous -----------------------

test('direct-url repo_ref never carries a credential', async () => {
  const ds = makeDataSource({});
  const rp = await buildRunProvision(ds, {
    ...baseInput,
    repoRef: { url: 'https://github.com/x/y.git', branch: 'dev' },
  });

  assert.equal(rp.repo.url, 'https://github.com/x/y.git');
  assert.equal(rp.repo.branch, 'dev');
  assert.equal(rp.repo.credential, undefined);
});

// --- availability-first: a bad credential degrades to anonymous, never wedges -

test('foreign-workspace credential degrades to anonymous (run still dispatches)', async () => {
  // Credential belongs to another workspace → resolveGitCredential throws →
  // resolveRepoCredential swallows to null → repo keeps its url, drops auth.
  const ds = makeDataSource({
    resources: [resourceRow()],
    credentials: [credRow({ workspace_id: 'ws-OTHER' })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git', 'url must still resolve');
  assert.equal(rp.repo.credential, undefined, 'a foreign-workspace token must NOT be shipped');
});

test('undecryptable credential blob degrades to anonymous', async () => {
  const ds = makeDataSource({
    resources: [resourceRow()],
    credentials: [credRow({ encrypted_data: 'enc:not-a-real-blob' })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'res-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.equal(rp.repo.credential, undefined);
});

// --- environment_config inherit path (repoRef = null) -----------------------

test('inherited env-config repo (resource_id) ships the credential too', async () => {
  const ds = makeDataSource({
    resources: [resourceRow()],
    credentials: [credRow()],
    boards: [
      { id: 'board-1', environment_config: JSON.stringify({ repositories: [{ resource_id: 'res-1' }] }) },
    ],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.ok(rp.repo, 'inherited repo must resolve');
  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('inherited env-config DIRECT url stays anonymous', async () => {
  const ds = makeDataSource({
    boards: [
      { id: 'board-1', environment_config: JSON.stringify({ repositories: [{ url: 'https://github.com/x/y.git' }] }) },
    ],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.ok(rp.repo);
  assert.equal(rp.repo.url, 'https://github.com/x/y.git');
  assert.equal(rp.repo.credential, undefined);
});
