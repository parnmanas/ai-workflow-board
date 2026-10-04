// Server-side wiring — QA/security run dispatch must ship the repo Project's
// git credential in `run_provision.repo.credential` so the agent-manager's
// run-provisioner can clone/fetch a PRIVATE repo (ticket 4f4d5df2, the residual
// server half of 622bc350's run-provisioner credential path).
//
// 622bc350 built + tested the MANAGER consumption of `run_provision.repo.
// credential` (injection through the shared repo-credential helper, token
// non-exposure in steps/log/on-disk). The gap this test closes is the SERVER
// PRODUCTION of that field: `buildRunProvision` → `resolveRunRepo` must decrypt
// the Project's Credential and attach `{ username?, token }` to the repo spec —
// for `repo_ref.project_id` (and the legacy `resource_id` alias, since
// repository Resources were migrated to Projects with the same id) — while
// keeping a direct-url repo anonymous and NEVER wedging the run when the
// credential is missing / foreign-workspace / undecryptable (availability-first).
// There is no inherited repo any more: the board ⊕ workspace environment_config
// fallback went away with boards, so a run without a repo_ref gets `repo: null`.
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
// resolveRunRepo makes (Project via ProjectsService / Credential / Workspace).

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

function makeDataSource({ projects = [], credentials = [], workspaces = [{ id: 'ws-1', clone_policy: null }] }) {
  const repos = {
    Project: makeRepo(projects),
    Credential: makeRepo(credentials),
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

function projectRow(over = {}) {
  return {
    id: over.id || 'proj-1',
    workspace_id: 'workspace_id' in over ? over.workspace_id : 'ws-1',
    repo_url: 'repo_url' in over ? over.repo_url : 'https://github.com/parnmanas/private.git',
    default_branch: over.default_branch || 'main',
    credential_id: 'credential_id' in over ? over.credential_id : 'cred-1',
    clone_policy: over.clone_policy ?? null,
  };
}

const baseInput = {
  kind: 'qa',
  id: 'scenario-1234',
  runId: 'run-1',
  workspaceId: 'ws-1',
  workspaceFolder: null,
  checkoutMode: 'reuse',
};

// --- project_id path --------------------------------------------------------

test('project_id repo ships the decrypted credential', async () => {
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.ok(rp.repo, 'repo must resolve');
  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('legacy repo_ref.resource_id resolves the migrated Project of the same id (credential included)', async () => {
  // Repository Resources were migrated to Projects WITH THE SAME ID, so a
  // scenario/profile saved before the migration still names `resource_id`.
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { resource_id: 'proj-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('credential with no username omits the username key (manager defaults x-access-token)', async () => {
  const ds = makeDataSource({
    projects: [projectRow()],
    credentials: [credRow({ fields: { token: 'ghp_TOKEN_ONLY' } })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.deepEqual(rp.repo.credential, { token: 'ghp_TOKEN_ONLY' });
  assert.ok(!('username' in rp.repo.credential), 'username must be omitted, not undefined-valued');
});

test('project with no credential_id → anonymous (no credential field)', async () => {
  const ds = makeDataSource({ projects: [projectRow({ credential_id: null })], credentials: [] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.equal(rp.repo.credential, undefined);
});

// ── 티켓 9fd27487: kind:'action' 엔드투엔드 (폴더 루트 + credential 포함 repo) ──
// buildRunProvision 자체에는 resolveWorkspaceFolder의 루트 결정(이미
// workspace-folder-traversal-guard.test.mjs에 고정돼 있음) 외에 kind별 분기가
// 따로 없다 — 이 테스트는 폴더 해석과, 위 'qa'에서 이미 증명된 credential 포함
// repo 경로가 각각 따로가 아니라 새로운 'action' kind에 대해 전체 파이프라인
// 차원에서 엔드투엔드로 함께 성립함을 증명한다.
test('kind:"action" resolves the .awb/act/ folder AND still ships a credentialed repo', async () => {
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, {
    ...baseInput,
    kind: 'action',
    id: 'action-1234',
    repoRef: { project_id: 'proj-1' },
  });

  assert.equal(rp.kind, 'action');
  assert.equal(rp.workspace_folder, '.awb/act/action-1');
  assert.ok(rp.repo, 'repo must resolve');
  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('project path: branch falls back to the project default_branch; explicit ref.branch wins', async () => {
  // Guards the project-path return object — a regression to
  // `branch: ref.branch || undefined` (dropping the default_branch fallback)
  // must fail here even while the credential still ships.
  const ds = makeDataSource({ projects: [projectRow({ default_branch: 'develop' })], credentials: [credRow()] });

  const fallback = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });
  assert.equal(fallback.repo.branch, 'develop', 'default_branch fills in when ref.branch is absent');
  assert.deepEqual(fallback.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });

  const explicit = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1', branch: 'feature-x' } });
  assert.equal(explicit.repo.branch, 'feature-x', 'explicit ref.branch overrides the project default');
});

test('global credential (workspace_id = null) is accepted (instance-wide shared)', async () => {
  // resolveGitCredential accepts a GLOBAL credential (workspace_id null); the
  // run-provision path must ship it too, not treat null as foreign-workspace.
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow({ workspace_id: null })] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
});

test('repoRef with BOTH url and project_id → direct url wins, stays anonymous', async () => {
  // Path 1 (direct url) is checked before path 2 (project_id): a repoRef that
  // carries both never consults the Project, so its credential is not attached —
  // the url author owns any auth. Guards against reordering the precedence.
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, {
    ...baseInput,
    repoRef: { url: 'https://github.com/x/y.git', project_id: 'proj-1' },
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
    projects: [projectRow()],
    credentials: [credRow({ workspace_id: 'ws-OTHER' })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git', 'url must still resolve');
  assert.equal(rp.repo.credential, undefined, 'a foreign-workspace token must NOT be shipped');
});

test('undecryptable credential blob degrades to anonymous', async () => {
  const ds = makeDataSource({
    projects: [projectRow()],
    credentials: [credRow({ encrypted_data: 'enc:not-a-real-blob' })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.equal(rp.repo.credential, undefined);
});

// --- project scope + no inherited repo ---------------------------------------

test('a project of ANOTHER workspace never ships its url or credential (repo: null, run still provisions)', async () => {
  const ds = makeDataSource({
    projects: [projectRow({ workspace_id: 'ws-OTHER' })],
    credentials: [credRow({ workspace_id: 'ws-OTHER' })],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.equal(rp.repo, null, 'a stale project id pointing at another workspace must not leak that repo');
  assert.equal(rp.workspace_folder, '.awb/qa/scenario', 'the folder still resolves — only the clone is skipped');
});

test('a missing project degrades to repo: null instead of throwing', async () => {
  const ds = makeDataSource({});
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'missing-proj' } });

  assert.equal(rp.repo, null);
  assert.equal(rp.run_id, 'run-1');
});

test('a project with no repo_url resolves to repo: null (nothing to clone)', async () => {
  const ds = makeDataSource({ projects: [projectRow({ repo_url: '' })], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: { project_id: 'proj-1' } });

  assert.equal(rp.repo, null);
});

test('no repo_ref → repo: null — there is no inherited board/workspace environment repo any more', async () => {
  const ds = makeDataSource({ projects: [projectRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo, null);
});
