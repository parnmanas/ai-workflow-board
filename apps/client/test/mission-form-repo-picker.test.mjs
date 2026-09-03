// Orchestration Mission 모달의 repo_ref 피커 회귀 테스트 (티켓 eb9cdd1c).
//
// 예전엔 이 모달만 공용 블록을 쓰지 않아, 작업 저장소를 지정하려면
// "Resource id (preferred)" placeholder 에 repo 리소스의 UUID 를 직접 타이핑해야
// 했다. 선행 티켓 af31e92d 가 Action/QA/Security 세 화면에서 없앤 원시 UUID 입력이
// 여기 한 곳에 남아 있었다.
//
// 소스 문자열/정규식 검사가 아니라 jsdom 으로 MissionFormModal 을 실제 렌더링해
// 선택·입력을 태우고, 그 결과 화면 상태와 create/update 페이로드를 단언한다
// (보드 교훈: UI 동작 완료 기준은 렌더링 상호작용으로 검증).
//
// 고정하는 계약:
//   1. UUID 를 한 글자도 타이핑하지 않고 드롭다운만으로 repo 와 브랜치를 지정해
//      저장할 수 있고, 재편집 시 그 선택이 이름·URL 라벨로 복원된다.
//   2. 목록에 없는/삭제된 resource_id 를 가진 기존 미션을 편집·저장해도 값이
//      유실되지 않는다 — 로딩 중이나 조회 실패 중에도 "알 수 없는 리소스" 로
//      오단정하지 않는다.
//   3. 목록을 못 받는 사용자(권한 없음 등)도 폼이 동작한다 — 조용한 빈 목록 폴백 +
//      수동 입력.
//   4. 페이로드 규칙(resource_id 우선 → url+branch → null)이 생성/편집 두 경로에서
//      동일하다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { MissionFormModal } from '../src/components/orchestration/OrchestrationPage.tsx';

const WS = 'ws-1';

const REPOS = [
  { id: 'repo-awb', workspace_id: WS, name: 'AWB', type: 'repository', url: 'https://github.com/parnmanas/ai-workflow-board.git', default_branch: 'main' },
  { id: 'repo-game', workspace_id: WS, name: 'GameClient', type: 'repository', url: 'https://github.com/example/game-client.git', default_branch: 'develop' },
];

const BRANCHES = { branches: [{ name: 'main', sha: 'a1' }, { name: 'release', sha: 'b2' }], default_branch: 'main' };

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
  const found = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes(label));
  assert.ok(found, `"${label}" 버튼을 찾을 수 없습니다.`);
  return found;
}

function repoSelect(container) {
  const el = container.querySelector('select[aria-label="저장소 리소스 선택"]');
  assert.ok(el, '저장소 리소스 드롭다운이 없습니다.');
  return el;
}

function selectedLabel(select) {
  return [...select.options].find((o) => o.value === select.value)?.textContent;
}

function baseMission(overrides) {
  return {
    id: 'mission-1',
    workspace_id: WS,
    team_id: 'team-1',
    team_name: 'Platform squad',
    title: 'Ship the billing export',
    status: 'draft',
    orchestrator_agent_id: 'agent-1',
    orchestrator_name: 'Orchestrator',
    plan_version: 0,
    counts: { total: 0, done: 0, failed: 0, inFlight: 0, pending: 0, awaitingUser: 0 },
    started_at: null,
    finished_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    objective: 'Ship it.',
    context: '',
    acceptance_criteria: '',
    method: '',
    completion_criteria: [],
    post_actions: [],
    resolved_workspace_folder: '.awb/orch/mission-1',
    workspace_folder: '',
    repo_ref: null,
    checkout_mode: 'reuse',
    plan_summary: '',
    result_summary: '',
    failure_reason: '',
    room_id: null,
    max_parallel_steps: 3,
    max_steps: 60,
    max_plan_versions: 6,
    step_timeout_minutes: 90,
    created_by_type: 'user',
    created_by: '',
    graph_enabled: false,
    graph_spec: null,
    total_visits: 0,
    confirm_policy: 'auto',
    steps: [],
    events: [],
    ...overrides,
  };
}

const TEAMS = [
  {
    id: 'team-1',
    workspace_id: WS,
    is_global: false,
    owner_workspace_id: WS,
    allowed_workspace_ids: [],
    name: 'Platform squad',
    description: '',
    orchestrator_agent_id: 'agent-1',
    orchestrator_name: 'Orchestrator',
    orchestrator_online: true,
    orchestrator_prompt: '',
    max_parallel_steps: 3,
    max_open_missions: 1,
    enabled: true,
    members: [],
    active_mission_count: 0,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
];

/**
 * 모달을 열고 create/update 페이로드를 수집한다. Advanced 섹션은 repo_ref 가 없는
 * 신규 미션에서는 접혀 있으므로 여기서 펼쳐 둔다.
 */
async function mountModal(t, {
  mission = null,
  listResources = async () => REPOS,
  listRepoBranches = async () => BRANCHES,
} = {}) {
  const dom = setupDom();
  const created = [];
  const updated = [];
  const originals = {
    listResources: api.listResources,
    listRepoBranches: api.listRepoBranches,
    listActions: api.listActions,
    createOrchestrationMission: api.createOrchestrationMission,
    updateOrchestrationMission: api.updateOrchestrationMission,
  };
  api.listResources = listResources;
  api.listRepoBranches = listRepoBranches;
  api.listActions = async () => [];
  api.createOrchestrationMission = async (data) => { created.push(data); return baseMission({ ...data, id: 'mission-new' }); };
  api.updateOrchestrationMission = async (id, data) => { updated.push({ id, data }); return baseMission({ ...data, id }); };

  const view = mount(
    React.createElement(MissionFormModal, {
      isOpen: true,
      wsId: WS,
      teams: TEAMS,
      mission,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  await flush();
  const { container } = view;
  if (!container.textContent.includes('Post-completion actions')) {
    click(button(container, 'Advanced'));
  }
  await flush();

  t.after(() => {
    Object.assign(api, originals);
    view.unmount();
    dom.cleanup();
  });
  return { container, created, updated };
}

/** 생성 경로의 필수 입력(제목/목표)을 채운다. */
function fillRequired(container) {
  typeInto(container.querySelector('input'), 'Ship the export');
  typeInto([...container.querySelectorAll('textarea')][0], 'Do the thing.');
}

// ── 1. 드롭다운만으로 지정 → 저장 → 재편집 복원 ─────────────────────────────

test('새 미션 — UUID 를 타이핑하지 않고 드롭다운만으로 repo 와 브랜치를 지정해 저장한다', async (t) => {
  const { container, created } = await mountModal(t);

  const select = repoSelect(container);
  assert.deepEqual(
    [...select.options].map((o) => o.textContent),
    [
      '— 지정 안 함 (board/workspace 환경설정 repo 재사용) —',
      'AWB · https://github.com/parnmanas/ai-workflow-board.git',
      'GameClient · https://github.com/example/game-client.git',
    ],
    '등록된 repo 리소스가 이름·URL 라벨로 나열되고, 빈 값이 명시적 선택지로 있다',
  );
  assert.equal(select.value, '', '기본값은 지정 안 함 — board/workspace 환경설정 repo 재사용');

  change(select, 'repo-awb');
  await flush();

  const branchSelect = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.ok(branchSelect, '리소스를 고르면 브랜치도 드롭다운으로 고를 수 있다');
  assert.deepEqual(
    [...branchSelect.options].map((o) => o.textContent),
    ['— 저장소 기본 브랜치 (main) —', 'main', 'release'],
    'listRepoBranches 결과가 기본 브랜치 안내와 함께 나열된다',
  );
  change(branchSelect, 'release');

  fillRequired(container);
  click(button(container, 'Create & brief orchestrator'));
  await flush();

  assert.equal(created.length, 1, '생성이 실제로 전송된다');
  assert.deepEqual(
    created[0].repo_ref,
    { resource_id: 'repo-awb', branch: 'release' },
    '고른 리소스와 브랜치가 그대로 payload 에 실린다',
  );

  // UUID 를 타이핑할 자리가 애초에 없어야 한다 — 목록이 정상일 때 수동 입력은 숨는다.
  assert.equal(
    container.querySelector('input[aria-label="resource_id 직접 입력"]'),
    null,
    '목록을 정상적으로 받은 상태에서는 원시 id 입력이 노출되지 않는다',
  );
});

test('저장된 미션을 다시 열면 고른 repo/브랜치가 이름·URL 라벨로 복원된다', async (t) => {
  const mission = baseMission({ repo_ref: { resource_id: 'repo-awb', branch: 'release' } });
  const { container } = await mountModal(t, { mission });

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-awb', '저장된 resource_id 가 선택 상태로 복원된다');
  assert.equal(
    selectedLabel(select),
    'AWB · https://github.com/parnmanas/ai-workflow-board.git',
    '원시 UUID 가 아니라 사람이 읽는 이름·URL 로 보인다',
  );

  const branchSelect = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.equal(branchSelect.value, 'release', '저장된 브랜치도 복원된다');
});

// ── 2. 목록에 없는 resource_id 보존 ────────────────────────────────────────

test('삭제된/목록에 없는 resource_id 를 가진 미션을 편집·저장해도 값이 유실되지 않는다', async (t) => {
  const mission = baseMission({ repo_ref: { resource_id: 'deleted-repo', branch: 'main' } });
  const { container, updated } = await mountModal(t, { mission });

  const select = repoSelect(container);
  assert.equal(select.value, 'deleted-repo', '목록에 없어도 선택 상태로 남는다');
  assert.equal(
    selectedLabel(select),
    '알 수 없는 리소스 (deleted-repo)',
    '목록을 다 받아본 뒤이므로 "알 수 없는 리소스" 로 표시한다',
  );

  // repo 를 건드리지 않고 다른 필드만 고쳐 저장한다 — 이 경로에서 값이 날아가면
  // 사용자는 자기가 지우지 않은 설정을 잃는다.
  typeInto(container.querySelector('input'), 'Retitled mission');
  click(button(container, 'Save'));
  await flush();

  assert.equal(updated.length, 1, '편집 저장이 실제로 전송된다');
  assert.deepEqual(
    updated[0].data.repo_ref,
    { resource_id: 'deleted-repo', branch: 'main' },
    '목록에 없는 resource_id 와 branch 가 그대로 되돌아간다',
  );
});

test('리소스 목록을 불러오는 중에는 저장된 id 를 "알 수 없는 리소스" 로 오단정하지 않는다', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const mission = baseMission({ repo_ref: { resource_id: 'repo-awb', branch: 'main' } });
  const { container } = await mountModal(t, {
    mission,
    listResources: () => pending,
  });

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-awb', '로딩 중에도 저장된 값은 선택 상태다');
  assert.equal(
    selectedLabel(select),
    'repo-awb (리소스 목록 불러오는 중…)',
    '아직 목록을 못 봤으므로 없다고 단정하지 않는다',
  );

  await act(async () => { release(REPOS); await pending; });
  assert.equal(
    selectedLabel(repoSelect(container)),
    'AWB · https://github.com/parnmanas/ai-workflow-board.git',
    '목록이 도착하면 같은 선택이 이름·URL 라벨로 바뀐다',
  );
});

// ── 3. 조회 실패 폴백 ──────────────────────────────────────────────────────

test('리소스 목록 조회가 실패해도 폼이 동작한다 — 값 보존 + 수동 입력 폴백', async (t) => {
  const mission = baseMission({ repo_ref: { resource_id: 'repo-awb', branch: 'main' } });
  const { container, updated } = await mountModal(t, {
    mission,
    listResources: async () => { throw new Error('Forbidden'); },
    listRepoBranches: async () => { throw new Error('Forbidden'); },
  });

  const select = repoSelect(container);
  assert.equal(select.value, 'repo-awb', '조회 실패에도 저장된 값은 선택 상태로 남는다');
  assert.equal(
    selectedLabel(select),
    'repo-awb (리소스 목록을 불러오지 못했습니다)',
    '실패 상태에서도 "알 수 없는 리소스" 로 오단정하지 않는다',
  );

  const manual = container.querySelector('input[aria-label="resource_id 직접 입력"]');
  assert.ok(manual, '목록을 못 쓰는 상태에서는 예전처럼 id 를 직접 넣을 수 있다');
  assert.equal(manual.value, 'repo-awb');

  const branchInput = container.querySelector('input[aria-label="브랜치 직접 입력"]');
  assert.ok(branchInput, '브랜치 조회가 실패하면 자유 입력으로 폴백한다');
  typeInto(branchInput, 'hotfix');

  click(button(container, 'Save'));
  await flush();
  assert.deepEqual(
    updated[0].data.repo_ref,
    { resource_id: 'repo-awb', branch: 'hotfix' },
    '폴백 경로로 입력한 값도 그대로 전송된다',
  );
});

// ── 4. 페이로드 규칙 ───────────────────────────────────────────────────────

test('repo 를 지정하지 않으면 repo_ref 는 null 이다 — board/workspace 환경설정 repo 재사용', async (t) => {
  const { container, created } = await mountModal(t);
  fillRequired(container);
  click(button(container, 'Create & brief orchestrator'));
  await flush();

  assert.equal(created.length, 1);
  assert.equal(created[0].repo_ref, null, '빈 값은 명시적으로 null 로 나간다');
});

test('리소스를 고르면 URL 은 payload 에서 빠진다 — 화면 안내와 서버 우선순위를 일치시킨다', async (t) => {
  // 서버 resolveRunRepo() 는 url 을 resource_id 보다 먼저 본다. 둘 다 실어 보내면
  // "리소스를 선택하면 이 URL 은 무시됩니다" 라는 이 폼의 안내와 정반대로 동작한다.
  const mission = baseMission({ repo_ref: { url: 'https://legacy.test/old.git' } });
  const { container, updated } = await mountModal(t, { mission });

  const urlInput = container.querySelector('input[aria-label="repo URL"]');
  assert.equal(urlInput.value, 'https://legacy.test/old.git', '기존 url 경로는 그대로 보인다');

  change(repoSelect(container), 'repo-game');
  await flush();

  click(button(container, 'Save'));
  await flush();
  assert.deepEqual(
    updated[0].data.repo_ref,
    { resource_id: 'repo-game' },
    'resource_id 만 나간다 — url 은 동시에 실리지 않는다',
  );
});

test('리소스 없이 URL 만 지정하면 url+branch 로 나간다', async (t) => {
  const { container, created } = await mountModal(t);

  typeInto(container.querySelector('input[aria-label="repo URL"]'), 'https://example.test/repo.git');
  typeInto(container.querySelector('input[aria-label="브랜치 직접 입력"]'), 'trunk');

  fillRequired(container);
  click(button(container, 'Create & brief orchestrator'));
  await flush();

  assert.deepEqual(
    created[0].repo_ref,
    { url: 'https://example.test/repo.git', branch: 'trunk' },
    '리소스로 등록되지 않은 저장소는 url+branch 경로로 나간다',
  );
});
