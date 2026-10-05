// Projects 화면의 순수 로직(projects/projectForm.logic.ts) — 폼 ⇄ payload, 검증,
// 자격증명 후보, 연결 테스트 표시, Host 폴더 행, 삭제 409(project_in_use) 집계.
// 컴포넌트가 실제로 import 하는 모듈을 그대로 검증한다(docs/tickets.md → Project).
//
// Run: node --import tsx --test apps/client/test/projects-form-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectPayload,
  defaultBranchOptions,
  describeProjectUsage,
  emptyProjectForm,
  hostFolderPathError,
  hostFolderRows,
  isProjectFormDirty,
  isProjectInUseError,
  mergeSavedProject,
  projectCredentialChoices,
  projectInUseCounts,
  projectToForm,
  testConnectionView,
} from '../src/projects/projectForm.logic.ts';

function project(overrides = {}) {
  return {
    id: 'p-1',
    account_id: 'ws-1',
    name: 'AWB',
    description: 'board-less',
    repo_url: 'https://github.com/parnmanas/ai-workflow-board.git',
    default_branch: 'main',
    credential_id: 'cred-1',
    clone_policy: { clone_depth: 1, single_branch: true },
    use_pr: true,
    instructions: 'npm run build',
    default_assignee: null,
    host_folders: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const SPEC = {
  manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/repo', folder_scope: 'shared',
  credential_id: null, cli_runtime_profile: null, runtime_config: { strategy: 'single', permission_mode: 'approve' },
  label: '', role_prompt: '',
};

// ── form ⇄ payload ──────────────────────────────────────────────────────────

test('새 프로젝트 폼은 비어 있고, 이름·URL 없이는 저장되지 않는다', () => {
  const r = buildProjectPayload(emptyProjectForm());
  assert.equal(r.ok, false);
  assert.ok(r.errors.name, '이름 누락을 알린다');
  assert.ok(r.errors.repoUrl, 'URL 누락을 알린다');
  assert.equal(r.errors.clonePolicy, undefined, '빈 clone 정책은 오류가 아니다');
});

test('URL 에 공백이 있으면 거부한다', () => {
  const r = buildProjectPayload({ ...emptyProjectForm(), name: 'x', repoUrl: 'https://a b/c.git' });
  assert.equal(r.ok, false);
  assert.match(r.errors.repoUrl, /공백/);
});

test('저장된 프로젝트 → 폼 → payload 왕복은 모든 필드를 보존한다', () => {
  const p = project({ default_assignee: SPEC });
  const form = projectToForm(p);
  const r = buildProjectPayload(form);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    name: 'AWB',
    repo_url: 'https://github.com/parnmanas/ai-workflow-board.git',
    description: 'board-less',
    default_branch: 'main',
    credential_id: 'cred-1',
    clone_policy: { clone_depth: 1, single_branch: true },
    use_pr: true,
    instructions: 'npm run build',
    default_assignee: SPEC,
  });
  assert.equal(isProjectFormDirty(form, p), false, '그대로면 dirty 가 아니다');
});

test('비운 필드는 PATCH 에서도 실제로 비워진다 — credential/clone 정책/기본 담당자는 null', () => {
  const form = {
    ...projectToForm(project({ default_assignee: SPEC })),
    credentialId: '',
    clonePolicy: { timeout: '', idleTimeout: '', depth: '', filter: '', singleBranch: false },
    defaultAssignee: null,
    name: '  AWB 2  ',
    repoUrl: ' https://x.test/r.git ',
    defaultBranch: '  ',
  };
  const r = buildProjectPayload(form);
  assert.equal(r.ok, true);
  assert.equal(r.value.credential_id, null);
  assert.equal(r.value.clone_policy, null);
  assert.equal(r.value.default_assignee, null);
  assert.equal(r.value.name, 'AWB 2', '이름은 trim');
  assert.equal(r.value.repo_url, 'https://x.test/r.git', 'URL 은 trim');
  assert.equal(r.value.default_branch, '', '빈 기본 브랜치 = origin/HEAD');
});

test('잘못된 clone 정책은 그 칸의 오류로 돌아온다', () => {
  const form = { ...projectToForm(project()), clonePolicy: { timeout: '5', idleTimeout: '', depth: '', filter: '', singleBranch: false } };
  const r = buildProjectPayload(form);
  assert.equal(r.ok, false);
  assert.match(r.errors.clonePolicy, /Clone timeout/);
});

test('isProjectFormDirty — 편집하면 dirty, 새 프로젝트는 무엇이든 입력하면 dirty', () => {
  const p = project();
  assert.equal(isProjectFormDirty({ ...projectToForm(p), instructions: 'changed' }, p), true);
  assert.equal(isProjectFormDirty(emptyProjectForm(), null), false);
  assert.equal(isProjectFormDirty({ ...emptyProjectForm(), name: 'n' }, null), true);
});

// ── credentials ─────────────────────────────────────────────────────────────

test('credential 후보는 global + 이 워크스페이스 것, 현재 값은 목록 밖이어도 남는다', () => {
  const creds = [
    { id: 'g', account_id: null, scope: 'global', name: 'G', provider: 'github' },
    { id: 'w', account_id: 'ws-1', scope: 'account', name: 'W', provider: 'github' },
    { id: 'other', account_id: 'ws-2', scope: 'account', name: 'O', provider: 'github' },
  ];
  assert.deepEqual(projectCredentialChoices(creds, 'ws-1').map((c) => c.id), ['g', 'w']);
  assert.deepEqual(projectCredentialChoices(creds, 'ws-1', 'other').map((c) => c.id), ['g', 'w', 'other']);
});

// ── test connection ─────────────────────────────────────────────────────────

test('연결 테스트 성공은 브랜치 수와 원격 기본 브랜치를 보여준다', () => {
  const v = testConnectionView({ ok: true, branches: [{ name: 'main', sha: 'a' }, { name: 'dev', sha: 'b' }], default_branch: 'main' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.branches, ['main', 'dev']);
  assert.equal(v.suggestedDefault, 'main');
  assert.match(v.message, /브랜치 2개/);
  assert.match(v.message, /기본: main/);
});

test('연결 테스트 실패는 서버 오류 문구를 그대로 보여준다', () => {
  const v = testConnectionView({ ok: false, error: 'Authentication failed' });
  assert.equal(v.ok, false);
  assert.equal(v.message, 'Authentication failed');
  assert.deepEqual(v.branches, []);
  assert.equal(testConnectionView(null).ok, false);
});

test('빈 원격도 성공이다 — 브랜치 없음 안내', () => {
  const v = testConnectionView({ ok: true, branches: [] });
  assert.equal(v.ok, true);
  assert.match(v.message, /브랜치가 없습니다/);
});

test('기본 브랜치 선택지는 원격 목록에 없는 현재 값도 보존한다', () => {
  assert.deepEqual(defaultBranchOptions(['main', 'dev'], 'release').map((o) => o.value), ['', 'release', 'main', 'dev']);
  assert.deepEqual(defaultBranchOptions(['main', 'dev'], 'main').map((o) => o.value), ['', 'main', 'dev']);
});

// ── host folders ────────────────────────────────────────────────────────────

test('Host 폴더 행: Host 마다 한 행 + 목록에 없는 Host 의 폴더도 지울 수 있게 남긴다', () => {
  const rows = hostFolderRows(
    [{ id: 'h1', name: 'rolf' }, { id: 'h2', name: 'ragnar' }],
    [
      { host_id: 'h2', path: '/srv/awb' },
      { host_id: 'gone', path: 'C:\\repos\\awb', host_name: 'ralf' },
    ],
  );
  assert.deepEqual(rows, [
    { host_id: 'h1', host_name: 'rolf', saved_path: '', known: true },
    { host_id: 'h2', host_name: 'ragnar', saved_path: '/srv/awb', known: true },
    { host_id: 'gone', host_name: 'ralf', saved_path: 'C:\\repos\\awb', known: false },
  ]);
});

test('Host 폴더 경로는 절대 경로여야 한다 (POSIX · Windows · UNC)', () => {
  assert.ok(hostFolderPathError(''));
  assert.ok(hostFolderPathError('repos/awb'), '상대 경로 거부');
  assert.equal(hostFolderPathError('/home/u/awb'), null);
  assert.equal(hostFolderPathError('C:\\repos\\awb'), null);
  assert.equal(hostFolderPathError('\\\\nas\\share\\awb'), null);
});

// ── delete 409 project_in_use ───────────────────────────────────────────────

function apiError(code, body) {
  const e = new Error('Project is in use');
  e.code = code;
  e.status = 409;
  e.body = body;
  return e;
}

test('409 project_in_use 의 counts 를 그대로 펼친다 — 아는 키는 한국어, 모르는 키는 키 이름, 0 은 생략', () => {
  const err = apiError('project_in_use', { error: 'project_in_use', counts: { tickets: 3, qa_scenarios: 1, actions: 0, widgets: 2 } });
  assert.equal(isProjectInUseError(err), true);
  assert.deepEqual(projectInUseCounts(err), [
    { key: 'tickets', label: '티켓', count: 3 },
    { key: 'qa_scenarios', label: 'QA 시나리오', count: 1 },
    { key: 'widgets', label: 'widgets', count: 2 },
  ]);
  assert.equal(describeProjectUsage(projectInUseCounts(err)), '티켓 3 · QA 시나리오 1 · widgets 2');
});

test('counts 가 목록 형태여도 읽는다', () => {
  const err = apiError('project_in_use', { counts: [{ kind: 'missions', count: 2 }, { key: 'security_profiles', count: '1' }] });
  assert.deepEqual(projectInUseCounts(err).map((c) => `${c.label}:${c.count}`), ['미션:2', '보안 프로파일:1']);
});

test('slug 가 body 에만 있어도 project_in_use 로 본다, counts 가 없으면 빈 목록', () => {
  const err = apiError(undefined, { error: 'project_in_use' });
  assert.deepEqual(projectInUseCounts(err), []);
  assert.match(describeProjectUsage([]), /참조/);
});

test('다른 오류는 project_in_use 가 아니다', () => {
  assert.equal(projectInUseCounts(apiError('not_found', { error: 'not_found' })), null);
  assert.equal(projectInUseCounts(new Error('boom')), null);
  assert.equal(projectInUseCounts(null), null);
});

// ── list ⇄ last write ───────────────────────────────────────────────────────

test('mergeSavedProject — 더 새 저장본이 목록을 덮고, 목록이 따라오면 목록이 이긴다, 새 프로젝트는 뒤에 붙는다', () => {
  const listed = [project(), project({ id: 'p-2', name: 'Other' })];
  const saved = project({ name: 'AWB renamed', updated_at: '2026-10-02T00:00:00.000Z' });
  assert.equal(mergeSavedProject(listed, null), listed);
  assert.equal(mergeSavedProject(listed, saved)[0].name, 'AWB renamed');
  const caughtUp = [saved, listed[1]];
  assert.equal(mergeSavedProject(caughtUp, saved), caughtUp);
  const created = project({ id: 'p-new', name: 'New' });
  assert.deepEqual(mergeSavedProject(listed, created).map((p) => p.id), ['p-1', 'p-2', 'p-new']);
});
