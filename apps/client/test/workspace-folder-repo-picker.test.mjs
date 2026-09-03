// 작업폴더 옵션의 repo_ref 피커 회귀 테스트 (티켓 af31e92d).
//
// 예전엔 Action/QA/Security 편집 폼에서 작업 저장소를 지정하려면 repo 리소스의
// UUID 를 자유 텍스트로 직접 타이핑해야 했다. 이 파일은 그 자리를 대신한
// 검색형 드롭다운이 실제로 사용자 동작으로 굴러가는지를 고정한다.
//
// 소스 문자열/정규식 검사가 아니라 jsdom 으로 실제 컴포넌트를 렌더링해
// 클릭·입력·선택을 태우고, 그 결과로 화면 상태와 create/update 페이로드를 단언한다
// (보드 교훈: UI 동작 완료 기준은 렌더링 상호작용으로 검증).
//
// 고정하는 계약:
//   1. UUID 타이핑 없이 드롭다운만으로 repo 를 지정해 저장할 수 있고, 재편집 시
//      그 선택이 그대로 복원된다 (Action / QA / Security 세 화면 모두).
//   2. 목록에 없는 resource_id(삭제된 리소스, 직접 입력된 값)도 보존해 표시하고,
//      편집·저장해도 유실되지 않는다.
//   3. 리소스 목록을 못 받는 사용자(권한 없음 등)도 폼이 동작한다 — 조용한 빈 목록
//      폴백 + 수동 입력 유지.
//   4. 브랜치는 리소스를 고르면 listRepoBranches 로 선택할 수 있고, 실패하면
//      자유 입력으로 폴백한다.
//   5. repo_ref 페이로드 규칙(resource_id 우선 → url+branch → null)이 유지된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import ActionManager from '../src/components/admin/ActionManager.tsx';
import QaManager from '../src/components/admin/QaManager.tsx';
import SecurityManager from '../src/components/admin/SecurityManager.tsx';

const WS = 'ws-1';

const REPOS = [
  { id: 'repo-awb', workspace_id: WS, name: 'AWB', type: 'repository', url: 'https://github.com/parnmanas/ai-workflow-board.git', default_branch: 'main' },
  { id: 'repo-game', workspace_id: WS, name: 'GameClient', type: 'repository', url: 'https://github.com/example/game-client.git', default_branch: 'develop' },
];

const BRANCHES = { branches: [{ name: 'main', sha: 'a1' }, { name: 'release', sha: 'b2' }], default_branch: 'main' };

const AGENTS = [{ id: 'agent-1', name: 'Programmer', manager_name: 'Rolf' }];

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** controlled <select> / <input> 의 값을 네이티브 setter 로 바꾸고 change 를 태운다. */
function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter, 'change: 네이티브 value setter 를 찾지 못했습니다.');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
    || [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  assert.ok(found, `"${label}" 버튼을 찾을 수 없습니다.`);
  return found;
}

/** 공용 Input/Select 는 label 요소에 htmlFor 가 없어서 래퍼 div 를 거쳐 찾는다. */
function fieldByLabel(container, labelText, tag = 'input') {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨을 찾을 수 없습니다.`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 라벨에 대응하는 <${tag}> 를 찾을 수 없습니다.`);
  return field;
}

function repoSelect(container) {
  const el = container.querySelector('select[aria-label="저장소 리소스 선택"]');
  assert.ok(el, '저장소 리소스 드롭다운이 없습니다.');
  return el;
}

function repoSearch(container) {
  const el = container.querySelector('input[aria-label="저장소 리소스 검색"]');
  assert.ok(el, '저장소 리소스 검색 입력이 없습니다.');
  return el;
}

function optionLabels(select) {
  return [...select.options].map((o) => o.textContent);
}

/** 화면별 api 스텁을 설치하고 테스트 종료 시 원복한다. */
function stubApi(t, stubs) {
  const originals = {};
  for (const key of Object.keys(stubs)) originals[key] = api[key];
  Object.assign(api, stubs);
  t.after(() => { Object.assign(api, originals); });
}

// ─── Actions 화면 ─────────────────────────────────────────────────────────

async function renderActions(t, {
  actions = [],
  listResources = async () => REPOS,
  listRepoBranches = async () => BRANCHES,
} = {}) {
  const dom = setupDom();
  const created = [];
  const updated = [];
  stubApi(t, {
    listActions: async () => actions,
    getAgents: async () => AGENTS,
    listResources,
    listRepoBranches,
    createAction: async (payload) => { created.push(payload); return { ...payload, id: 'new-action' }; },
    updateAction: async (id, payload) => { updated.push({ id, payload }); return { ...payload, id }; },
  });
  const view = mount(React.createElement(ActionManager, { workspaceId: WS }));
  await flush();
  t.after(() => { view.unmount(); dom.cleanup(); });
  return { container: view.container, created, updated };
}

function makeAction(overrides = {}) {
  return {
    id: 'action-1', workspace_id: WS, name: '배포', description: '', prompt: 'deploy',
    target_agent_id: 'agent-1', schedule_cron: '', trigger: '', trigger_label: '',
    enabled: true, max_runs: 10, last_run_at: null, run_count: 0,
    workspace_folder: '', repo_ref: null, checkout_mode: 'reuse',
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test('Actions: UUID 를 타이핑하지 않고 드롭다운만으로 repo 와 브랜치를 지정해 저장한다', async (t) => {
  const { container, created } = await renderActions(t);
  click(button(container, '+ New Action'));
  await flush();

  typeInto(fieldByLabel(container, 'Name'), '야간 빌드');

  // 검색으로 후보를 좁힌 뒤 드롭다운에서 고른다 — 어디에도 UUID 를 입력하지 않는다.
  typeInto(repoSearch(container), 'game');
  assert.deepEqual(optionLabels(repoSelect(container)), [
    '— 지정 안 함 (board/workspace 환경설정 repo 재사용) —',
    'GameClient · https://github.com/example/game-client.git',
  ], '검색어가 리소스 목록을 좁혀야 합니다.');

  change(repoSelect(container), 'repo-game');
  await flush();

  // 리소스를 고르면 브랜치도 목록에서 고를 수 있어야 한다.
  const branch = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.ok(branch, '리소스를 고른 뒤에는 브랜치 드롭다운이 나와야 합니다.');
  assert.deepEqual(optionLabels(branch), ['— 저장소 기본 브랜치 (main) —', 'main', 'release']);
  change(branch, 'release');

  click(button(container, 'Create Action'));
  await flush();

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].repo_ref, { resource_id: 'repo-game', branch: 'release' });
  // 사용자가 UUID 를 친 적이 없다 — 어떤 자유 텍스트 입력에도 resource id 가 남지 않는다.
  assert.equal(container.querySelector('input[aria-label="resource_id 직접 입력"]'), null);
});

test('Actions: 저장된 repo 선택이 재편집 시 이름·URL 라벨로 복원된다', async (t) => {
  const action = makeAction({ repo_ref: { resource_id: 'repo-awb' } });
  const { container } = await renderActions(t, { actions: [action] });

  click(button(container, 'Edit'));
  await flush();

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-awb', '저장된 resource_id 가 선택 상태로 복원돼야 합니다.');
  assert.ok(
    optionLabels(select).includes('AWB · https://github.com/parnmanas/ai-workflow-board.git'),
    '리소스는 이름 + URL 로 식별 가능하게 표시돼야 합니다.',
  );
  assert.ok(
    !optionLabels(select).some((l) => l.includes('알 수 없는 리소스')),
    '목록에 있는 리소스를 "알 수 없는 리소스" 로 표시하면 안 됩니다.',
  );
});

test('Actions: 삭제된(목록에 없는) resource_id 도 보존해 표시하고 저장해도 유실되지 않는다', async (t) => {
  const action = makeAction({ repo_ref: { resource_id: 'repo-deleted' } });
  const { container, updated } = await renderActions(t, { actions: [action] });

  click(button(container, 'Edit'));
  await flush();

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-deleted');
  assert.ok(
    optionLabels(select).includes('알 수 없는 리소스 (repo-deleted)'),
    `보존 문구가 없습니다: ${JSON.stringify(optionLabels(select))}`,
  );

  // repo 는 그대로 두고 다른 필드만 고쳐 저장한다.
  typeInto(fieldByLabel(container, 'Name'), '배포 v2');
  click(button(container, 'Save Changes'));
  await flush();

  assert.equal(updated.length, 1);
  assert.equal(updated[0].payload.name, '배포 v2');
  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-deleted' },
    '알 수 없는 resource_id 가 저장 시 유실되면 안 됩니다.');
});

test('Actions: 리소스 목록 조회가 실패해도 폼이 동작하고 기존 값이 유실되지 않는다', async (t) => {
  const action = makeAction({ repo_ref: { resource_id: 'repo-awb' } });
  const { container, updated } = await renderActions(t, {
    actions: [action],
    listResources: async () => { throw new Error('Forbidden'); },
  });

  click(button(container, 'Edit'));
  await flush();

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-awb', '조회 실패해도 저장된 값은 선택 상태로 남아야 합니다.');
  assert.ok(
    optionLabels(select).includes('repo-awb (리소스 목록을 불러오지 못했습니다)'),
    '목록을 못 받은 것을 "알 수 없는 리소스" 로 단정하면 안 됩니다: '
      + JSON.stringify(optionLabels(select)),
  );

  // 목록을 못 쓰는 사용자를 위한 수동 입력 경로가 남아 있어야 한다.
  const manual = container.querySelector('input[aria-label="resource_id 직접 입력"]');
  assert.ok(manual, '목록 조회 실패 시 resource_id 수동 입력이 제공돼야 합니다.');
  assert.equal(manual.value, 'repo-awb');

  click(button(container, 'Save Changes'));
  await flush();
  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-awb' });
});

test('Actions: 브랜치 조회가 실패하면 자유 입력으로 폴백하고 그 값이 저장된다', async (t) => {
  const action = makeAction({ repo_ref: { resource_id: 'repo-awb' } });
  const { container, updated } = await renderActions(t, {
    actions: [action],
    listRepoBranches: async () => { throw new Error('ls-remote timeout'); },
  });

  click(button(container, 'Edit'));
  await flush();

  assert.equal(container.querySelector('select[aria-label="브랜치 선택"]'), null,
    '브랜치 목록을 못 받았으면 드롭다운을 강요하면 안 됩니다.');
  const manualBranch = container.querySelector('input[aria-label="브랜치 직접 입력"]');
  assert.ok(manualBranch, '브랜치 자유 입력 폴백이 없습니다.');

  typeInto(manualBranch, 'hotfix/urgent');
  click(button(container, 'Save Changes'));
  await flush();

  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-awb', branch: 'hotfix/urgent' });
});

test('Actions: 원격에서 사라진 저장 브랜치도 선택 상태로 보존된다', async (t) => {
  const action = makeAction({ repo_ref: { resource_id: 'repo-awb', branch: 'gone-upstream' } });
  const { container } = await renderActions(t, { actions: [action] });

  click(button(container, 'Edit'));
  await flush();

  const branch = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.ok(branch);
  assert.equal(branch.value, 'gone-upstream');
  assert.ok(optionLabels(branch).includes('gone-upstream (목록에 없음)'),
    `보존 문구가 없습니다: ${JSON.stringify(optionLabels(branch))}`);
});

test('Actions: repo_ref 우선순위 — resource_id 가 있으면 URL 은 무시된다', async (t) => {
  const action = makeAction({ repo_ref: { url: 'https://github.com/legacy/raw.git', branch: 'trunk' } });
  const { container, updated } = await renderActions(t, { actions: [action] });

  click(button(container, 'Edit'));
  await flush();

  // 기존 url 경로 값은 고급 섹션에 그대로 살아 있다.
  assert.equal(container.querySelector('input[aria-label="repo URL"]').value, 'https://github.com/legacy/raw.git');

  change(repoSelect(container), 'repo-awb');
  await flush();
  click(button(container, 'Save Changes'));
  await flush();

  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-awb' },
    'resource_id 가 선택되면 url+branch 는 페이로드에서 빠져야 합니다.');
});

test('Actions: repo_ref 우선순위 — resource 없이 URL 만 있으면 url+branch, 둘 다 비면 null', async (t) => {
  const action = makeAction({ repo_ref: null });
  const { container, updated } = await renderActions(t, { actions: [action] });

  click(button(container, 'Edit'));
  await flush();

  // 아무것도 지정하지 않은 상태 → null (환경설정 repo 재사용).
  assert.equal(repoSelect(container).value, '');
  click(button(container, 'Save Changes'));
  await flush();
  assert.equal(updated[0].payload.repo_ref, null);

  // URL 직접 입력 경로만 채우면 url+branch 로 나간다.
  click(button(container, 'Edit'));
  await flush();
  typeInto(container.querySelector('input[aria-label="repo URL"]'), 'https://github.com/example/raw.git');
  typeInto(container.querySelector('input[aria-label="브랜치 직접 입력"]'), 'trunk');
  click(button(container, 'Save Changes'));
  await flush();

  assert.deepEqual(updated[1].payload.repo_ref, { url: 'https://github.com/example/raw.git', branch: 'trunk' });
});

// ─── QA 시나리오 화면 ──────────────────────────────────────────────────────

test('QA 시나리오 폼도 같은 드롭다운으로 repo 를 지정하고 알 수 없는 id 를 보존한다', async (t) => {
  const dom = setupDom();
  const updated = [];
  const scenario = {
    id: 'qa-1', workspace_id: WS, name: '로그인 시나리오', description: '',
    target_agent_id: 'agent-1', qa_driver: 'browser', qa_driver_config: {}, steps: [], tags: [],
    enabled: true, target_environment: '', on_failure_ticket: null, qa_phases: null,
    workspace_folder: '', repo_ref: { resource_id: 'repo-deleted' },
    checkout_mode: 'reuse', build_mode: 'cold_then_warm', last_built_commit: null,
    last_run_at: null, last_run_status: null, run_count: 0,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
  stubApi(t, {
    listQaScenarios: async () => [scenario],
    getAgents: async () => AGENTS,
    listQaSchedules: async () => [],
    listDeployments: async () => [],
    listResources: async () => REPOS,
    listRepoBranches: async () => BRANCHES,
    updateQaScenario: async (id, payload) => { updated.push({ id, payload }); return { ...scenario, ...payload }; },
  });
  const view = mount(React.createElement(QaManager, { workspaceId: WS }));
  await flush();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  click(button(container, 'Edit'));
  await flush();

  // 목록에 없는 기존 값이 보존된 채로 열린다.
  assert.equal(repoSelect(container).value, 'repo-deleted');
  assert.ok(optionLabels(repoSelect(container)).includes('알 수 없는 리소스 (repo-deleted)'));

  // 드롭다운만으로 실제 리소스로 교체한다.
  change(repoSelect(container), 'repo-awb');
  await flush();
  click(button(container, 'Save'));
  await flush();

  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-awb' });
});

// ─── Security 프로파일 화면 ────────────────────────────────────────────────

test('Security 프로파일 폼도 같은 드롭다운으로 repo·브랜치를 지정한다', async (t) => {
  const dom = setupDom();
  const updated = [];
  const profile = {
    id: 'sec-1', workspace_id: WS, name: '월간 감사', description: '',
    target_agent_id: 'agent-1', target_resource_id: null, scan_driver: 'code-audit',
    scan_driver_config: {}, scope_mode: 'incremental', checklist: [], tags: [],
    enabled: true, max_runs: 20, on_failure_ticket: null,
    workspace_folder: '', repo_ref: null,
    checkout_mode: 'reuse', build_mode: 'cold_then_warm', last_built_commit: null,
    last_run_at: null, last_run_status: null, last_scope_used: null, run_count: 0,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
  stubApi(t, {
    listSecurityProfiles: async () => [profile],
    getAgents: async () => AGENTS,
    listSecuritySchedules: async () => [],
    listSecurityRuns: async () => [],
    listResources: async () => REPOS,
    listRepoBranches: async () => BRANCHES,
    updateSecurityProfile: async (id, payload) => { updated.push({ id, payload }); return { ...profile, ...payload }; },
  });
  const view = mount(React.createElement(SecurityManager, { workspaceId: WS }));
  await flush();
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  click(button(container, 'Edit'));
  await flush();

  change(repoSelect(container), 'repo-game');
  await flush();
  const branch = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.ok(branch, 'Security 폼에도 브랜치 드롭다운이 있어야 합니다.');
  change(branch, 'release');

  click(button(container, 'Save'));
  await flush();

  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].payload.repo_ref, { resource_id: 'repo-game', branch: 'release' });
});
