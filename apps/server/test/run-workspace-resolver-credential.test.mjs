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
import { pickBaseRepoResourceId } from '../dist/common/base-repo-binding.js';

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

// ── 티켓 9fd27487: kind:'action' 엔드투엔드 (폴더 루트 + credential 포함 repo) ──
// buildRunProvision 자체에는 resolveWorkspaceFolder의 루트 결정(이미
// workspace-folder-traversal-guard.test.mjs에 고정돼 있음) 외에 kind별 분기가
// 따로 없다 — 이 테스트는 폴더 해석과, 위 'qa'에서 이미 증명된 credential 포함
// repo 경로가 각각 따로가 아니라 새로운 'action' kind에 대해 전체 파이프라인
// 차원에서 엔드투엔드로 함께 성립함을 증명한다.
test('kind:"action" resolves the .awb/act/ folder AND still ships a credentialed repo', async () => {
  const ds = makeDataSource({ resources: [resourceRow()], credentials: [credRow()] });
  const rp = await buildRunProvision(ds, {
    ...baseInput,
    kind: 'action',
    id: 'action-1234',
    repoRef: { resource_id: 'res-1' },
  });

  assert.equal(rp.kind, 'action');
  assert.equal(rp.workspace_folder, '.awb/act/action-1');
  assert.ok(rp.repo, 'repo must resolve');
  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' });
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

// ── 티켓 fff842c6: 통합 감사 — dispatch 경로(pickBaseRepoResourceId)와의 정책 일치 ──
// 이전엔 inherit 단계가 `repositories[0]`만 봐서, 레거시 multi-entry 환경설정에서
// url-only entry가 0번을 차지하면 뒤쪽 resource_id entry(credential 보유)를 영영
// 고르지 못했다 — dispatch 경로(pickBaseRepoResourceId, resource_id 없는 entry는
// 건너뛰고 스캔)와 서로 다른 repo를 선택할 수 있는 실제 gap이었다. 같은 배열을 두
// 함수에 동시에 먹여 반드시 같은 resource_id로 수렴함을 고정한다.
test('multi-entry env-config: run-resolver picks the SAME resource_id entry as the dispatch path, not an earlier url-only entry', async () => {
  const repositories = [{ url: 'https://github.com/legacy/anon.git' }, { resource_id: 'res-1' }];

  const dispatchPick = pickBaseRepoResourceId('', repositories);
  assert.equal(dispatchPick.resourceId, 'res-1', 'sanity: dispatch path skips the url-only entry and picks the resource_id entry');

  const ds = makeDataSource({
    resources: [resourceRow()],
    credentials: [credRow()],
    boards: [{ id: 'board-1', environment_config: JSON.stringify({ repositories }) }],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git', 'run-resolver must land on the resource_id entry (res-1), matching the dispatch path — not the earlier url-only entry');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' }, 'the resource_id entry carries a credential the url-only entry never would have');
});

test('multi-entry env-config with NO resource_id anywhere: run-resolver still falls back to the first url-only entry (a tier dispatch has no equivalent for)', async () => {
  const repositories = [{ url: 'https://github.com/legacy/anon-1.git' }, { url: 'https://github.com/legacy/anon-2.git' }];

  const dispatchPick = pickBaseRepoResourceId('', repositories);
  assert.equal(dispatchPick.resourceId, '', 'sanity: dispatch path has nothing to bind here (would leave base_repo unbound)');

  const ds = makeDataSource({
    boards: [{ id: 'board-1', environment_config: JSON.stringify({ repositories }) }],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo.url, 'https://github.com/legacy/anon-1.git', 'still picks the first entry in array order when no entry has a resource_id');
  assert.equal(rp.repo.credential, undefined);
});

// ── 리뷰 라운드1 지적(ticket fff842c6): resource_id + 인라인 url이 함께 있는
// 레거시 entry에서도 dispatch 경로와 수렴해야 한다. 고친 chosen 선택 로직이
// resource_id 있는 entry를 우선 고르더라도, 정작 그 entry에 인라인 url이 같이
// 있으면 예전 코드는 Resource 조회를 건너뛰고 인라인 url을 그대로 썼다 —
// dispatch는 resource_id를 고른 뒤 항상 Resource row(canonical url/branch/
// credential)를 읽으므로 이 지점에서 여전히 어긋났다. resource_id가 있으면
// 인라인 url 유무와 무관하게 무조건 Resource가 canonical source여야 한다.
test('resource_id + 인라인 url이 함께 있는 entry: Resource가 canonical source — 인라인 url/기본 branch가 아니라 Resource의 url·default_branch·credential을 쓴다', async () => {
  const repositories = [{ resource_id: 'res-1', url: 'https://github.com/legacy/stale-inline.git' }];

  const ds = makeDataSource({
    resources: [resourceRow({ default_branch: 'develop' })],
    credentials: [credRow()],
    boards: [{ id: 'board-1', environment_config: JSON.stringify({ repositories }) }],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo.url, 'https://github.com/parnmanas/private.git', 'entry의 stale한 인라인 url이 아니라 Resource의 canonical url을 써야 한다');
  assert.equal(rp.repo.branch, 'develop', 'Resource의 default_branch를 써야 한다(dispatch 경로의 Resource 조회 결과와 동일)');
  assert.deepEqual(rp.repo.credential, { username: 'x-access-token', token: 'ghp_SECRET_TOKEN' }, '인라인 url만으로는 절대 나올 수 없는 credential이 Resource 경유로 실려야 한다');
});

test('resource_id + 인라인 url이 함께 있는 entry: Resource를 찾을 수 없으면 인라인 url로 조용히 폴백하지 않고 repo:null로 hard-fail한다', async () => {
  const repositories = [{ resource_id: 'missing-res', url: 'https://github.com/legacy/stale-inline.git' }];

  const ds = makeDataSource({
    resources: [],
    boards: [{ id: 'board-1', environment_config: JSON.stringify({ repositories }) }],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo, null, 'resource_id가 존재하지 않으면 인라인 url이 있어도 폴백하지 않는다 — dispatch가 이 경우 바인딩을 포기하는 것과 동일한 계약');
});

test('resource_id + 인라인 url이 함께 있는 entry: Resource가 타 workspace 소유면 마찬가지로 인라인 url 폴백 없이 repo:null로 hard-fail한다', async () => {
  const repositories = [{ resource_id: 'res-1', url: 'https://github.com/legacy/stale-inline.git' }];

  const ds = makeDataSource({
    resources: [resourceRow({ workspace_id: 'ws-OTHER' })],
    boards: [{ id: 'board-1', environment_config: JSON.stringify({ repositories }) }],
    workspaces: [{ id: 'ws-1', environment_config: null }],
  });
  const rp = await buildRunProvision(ds, { ...baseInput, repoRef: null });

  assert.equal(rp.repo, null, 'Resource가 다른 workspace 소유면(스코프 위반) 인라인 url로도 폴백하지 않는다');
});
