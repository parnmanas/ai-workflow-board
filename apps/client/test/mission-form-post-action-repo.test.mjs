// Mission 생성/편집 모달 — post_actions / projects 라운드트립 회귀 테스트
// (리뷰 지적 반영, 티켓 2dc3c62f). 반려 사유: API 타입에는 post_actions/repo_ref가
// 있는데도 생성 모달 상태·submit이 이를 다루지 않았고 별도 편집 UI도 없었다.
//
// 이 파일이 고정하는 것:
//   - 기존 미션을 편집(mission prop이 채워짐)하면 그 미션의 post_actions/projects가
//     폼 필드에 그대로 반영된다(post_actions 가 있으면 Advanced 섹션이 자동으로 펼쳐진 상태로).
//   - 새 미션 생성(mission=null)에서도 "+ Add post-action" 버튼으로 행을 추가하고
//     action/condition 을 채울 수 있다 — 이전엔 이 입력 자체가 없었다. project 와 브랜치도
//     같은 폼에서 고른다.
//
// api.listActions는 실제 서버 없이(jsdom, 네트워크 없음) 항상 실패해 빈 배열로
// 폴백한다(MissionFormModal 자체가 이미 .catch(() => setActions([]))로 처리) —
// 그래서 여기서는 데이터 의존적인 action <select>의 옵션이 아니라, 실제 서버 응답과
// 무관하게 항상 존재하는 고정 옵션(condition select)과 projects 행의 값으로
// 라운드트립을 검증한다.
//
// 작업 저장소는 예전엔 Advanced 안의 단일 repo_ref(RepoRefPicker)였다. 팀이 재사용되면서
// 작업 폴더가 팀 slot 에서 미션의 PROJECT 들로 옮겨 갔고(각 멤버는 그 project 의 자기 Host
// 폴더에서 일한다), 선택 UI 도 Advanced 밖의 Projects 섹션이 됐다. 여기서는 projects 가
// post-action·실행 그래프와 같은 payload 로 함께 오가는지만 보고, Projects 섹션 자체의 계약
// (여러 개 선택·primary·멤버별 폴더·시작 차단)은 mission-form-projects.test.mjs 가 다룬다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, run, typeInto, React, act } from './helpers/jsdom.mjs';
import { MissionFormModal } from '../src/components/orchestration/OrchestrationPage.tsx';
import { api } from '../src/api.ts';

// 미션 계정(ws-1)의 project. 이 파일의 팀은 멤버·orchestrator 런타임이 없으므로 폴더 유무가
// 시작을 막지 않는다 — 그 규칙은 mission-form-projects.test.mjs 의 몫이다.
const AWB = {
  id: 'p-awb',
  account_id: 'ws-1',
  name: 'AWB',
  description: '',
  repo_url: 'https://github.com/parnmanas/ai-workflow-board.git',
  default_branch: 'main',
  credential_id: null,
  clone_policy: null,
  use_pr: false,
  instructions: '',
  default_assignee: null,
  host_folders: [],
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

function baseMission(overrides) {
  return {
    id: 'mission-1',
    account_id: 'ws-1',
    team_id: 'team-1',
    team_name: 'Platform squad',
    title: 'Ship the billing export',
    status: 'draft',
    orchestrator_agent_id: null,
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
    excluded_member_ids: [],
    extra_members: [],
    projects: [],
    folder_scope: 'shared',
    roster: null,
    resolved_workspace_folder: '',
    workspace_folder: '',
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
    user_chat_mode: 'open',
    steps: [],
    events: [],
    ...overrides,
  };
}

const TEAMS = [
  {
    id: 'team-1',
    account_id: 'ws-1',
    is_global: false,
    owner_account_id: 'ws-1',
    allowed_account_ids: [],
    name: 'Platform squad',
    description: '',
    orchestrator_name: 'Orchestrator',
    orchestrator_online: true,
    orchestrator_runtime: null,
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

async function mountModal(t, { mission = null, listProjects = async () => [AWB] } = {}) {
  const dom = setupDom();
  const originalListProjects = api.listProjects;
  api.listProjects = listProjects;
  t.after(() => {
    api.listProjects = originalListProjects;
  });
  const view = mount(
    React.createElement(MissionFormModal, {
      isOpen: true,
      accountId: 'ws-1',
      teams: TEAMS,
      mission,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

/** controlled <select> 의 값을 네이티브 setter 로 바꾸고 change 를 태운다. */
function change(element, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** Projects 섹션의 "Add a project" 드롭다운으로 project 하나를 고른다. */
function addProject(container, projectId) {
  const select = container.querySelector('select[aria-label="Add a project"]');
  assert.ok(select, '"Add a project" 드롭다운이 있다');
  change(select, projectId);
}

test('기존 미션 편집 — post_actions/projects가 채워진 미션은 Advanced가 자동으로 펼쳐지고 그 값이 폼에 반영된다', async (t) => {
  const mission = baseMission({
    post_actions: [
      { action_id: 'action-1', order: 1, condition: 'on_success', status: 'pending', run_id: null, room_id: null, error: '', dispatched_at: null },
    ],
    projects: [{ project_id: 'p-awb', branch: 'main', name: 'AWB' }],
  });
  const { container } = await mountModal(t, { mission });

  assert.match(container.textContent, /Post-completion actions/, 'Advanced 섹션이 자동으로 펼쳐져 post-action 편집기가 보인다');
  assert.equal(
    Boolean(container.querySelector('select[aria-label="프로젝트 선택"]')),
    false,
    '구 repo_ref 피커(RepoRefPicker)는 더 이상 렌더링되지 않는다',
  );

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_success'),
  );
  assert.ok(conditionSelect, 'condition select가 렌더링된다');
  assert.equal(conditionSelect.value, 'on_success', '기존 post_action의 condition이 그대로 반영된다');

  // projects 는 Projects 섹션의 행으로 돌아온다 — project 마다 브랜치 입력이 하나씩이다.
  const branchInput = container.querySelector('[data-testid="mission-projects"] input[aria-label="Branch for AWB"]');
  assert.ok(branchInput, '저장된 project 가 이름으로 된 행으로 반영된다');
  assert.equal(branchInput.value, 'main', 'projects[].branch가 폼에 반영된다');

  // Team select는 편집 중엔 바뀌면 안 되므로 비활성화되어 있어야 한다.
  const teamSelect = [...container.querySelectorAll('select')].find((s) => s.value === 'team-1');
  assert.ok(teamSelect?.disabled, '편집 중에는 Team select가 비활성화된다');
});

test('projects 는 Advanced 밖에 있다 — project 만 채워진 미션은 Advanced 를 펼치지 않아도 보인다', async (t) => {
  // 예전 repo_ref 는 Advanced 안에 있어서 저장돼 있으면 Advanced 를 자동으로 펼쳐야 했다.
  // 이제 작업 폴더는 미션의 project 들이 정하고, 그 선택은 항상 보이는 섹션에 있다.
  const mission = baseMission({ projects: [{ project_id: 'p-awb', branch: '', name: 'AWB' }] });
  const { container } = await mountModal(t, { mission });

  assert.doesNotMatch(container.textContent, /Post-completion actions/, '다른 실행 계약이 없으면 Advanced 는 접힌 채로 열린다');
  assert.ok(
    container.querySelector('[data-testid="mission-projects"] input[aria-label="Branch for AWB"]'),
    'Advanced 를 펼치지 않아도 저장된 project 가 보인다',
  );
});

test('새 미션 생성 — post-action 행을 추가하고 action/condition 을, project 와 브랜치를 채울 수 있다', async (t) => {
  const { container } = await mountModal(t, { mission: null });

  // Advanced는 기본적으로 접혀 있다 — 펼쳐야 필드가 나타난다.
  assert.doesNotMatch(container.textContent, /Post-completion actions/);
  const toggle = [...container.querySelectorAll('button')].find((b) => /Advanced/.test(b.textContent || ''));
  assert.ok(toggle, 'Advanced 토글 버튼이 있다');
  click(toggle);
  assert.match(container.textContent, /Post-completion actions/, '토글 후 post-action 편집기가 나타난다');

  const addPostAction = [...container.querySelectorAll('button')].find((b) => /Add post-action/.test(b.textContent || ''));
  assert.ok(addPostAction, '"+ Add post-action" 버튼이 있다 — 이전엔 이 입력 자체가 없었다');
  click(addPostAction);

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_failure'),
  );
  assert.ok(conditionSelect, '행 추가 후 condition select가 나타난다');
  assert.equal(conditionSelect.value, 'always', '새 post-action의 condition 기본값은 always다');

  // repo_ref 의 URL·브랜치 입력 대신 project 를 고르고 그 project 의 브랜치를 적는다.
  assert.equal(Boolean(container.querySelector('input[aria-label="repo URL"]')), false, 'repo_ref용 URL input은 없어졌다');
  addProject(container, 'p-awb');
  const branchInput = container.querySelector('[data-testid="mission-projects"] input[aria-label="Branch for AWB"]');
  assert.ok(branchInput, 'project 를 고르면 그 project 의 브랜치 입력이 생긴다');
  typeInto(branchInput, 'release');
  assert.equal(branchInput.value, 'release', 'project 브랜치를 타이핑으로 채울 수 있다');
});

// ── 실행 그래프 + 사용자 확인 강도 (티켓 5dbe4aa2) ──────────────────────────
//
// 이 두 컨트롤은 반드시 **함께** 존재해야 한다: confirm 노드는 graph 모드에서만
// 만들 수 있으므로, 정책 select 만 노출하면 골라도 아무 일도 일어나지 않는 죽은
// 컨트롤이 된다(이 저장소에서 이미 한 번 발생한 실패 유형). 그리고 고른 값이
// **실제 create/PATCH payload 에 실려야** 의미가 있다 — 화면에만 있고 전송되지
// 않으면 증상이 정확히 같다.

/** api 호출을 가로채 payload 를 기록한다. */
function stubMissionApi(t) {
  const created = [];
  const updated = [];
  const originalCreate = api.createOrchestrationMission;
  const originalUpdate = api.updateOrchestrationMission;
  api.createOrchestrationMission = async (data) => {
    created.push(data);
    return baseMission({ ...data, id: 'mission-new' });
  };
  api.updateOrchestrationMission = async (id, data) => {
    updated.push({ id, data });
    return baseMission({ ...data, id });
  };
  t.after(() => {
    api.createOrchestrationMission = originalCreate;
    api.updateOrchestrationMission = originalUpdate;
  });
  return { created, updated };
}

const selectWithOption = (container, value) =>
  [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === value));

test('새 미션 생성 — 실행 그래프 토글과 확인 강도 select 가 함께 있고, 고른 값이 payload 에 실린다', async (t) => {
  const calls = stubMissionApi(t);
  const { container } = await mountModal(t, { mission: null });

  const toggle = [...container.querySelectorAll('button')].find((b) => /Advanced/.test(b.textContent || ''));
  click(toggle);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const graphCheckbox = [...container.querySelectorAll('input[type="checkbox"]')].find((i) =>
    /Execution graph/.test(i.closest('label')?.textContent || ''),
  );
  assert.ok(graphCheckbox, '실행 그래프 체크박스가 있어야 한다 — 없으면 정책 select 가 죽은 컨트롤이 된다');
  assert.equal(graphCheckbox.checked, false, '기본값은 꺼짐 — 기존 미션 동작을 바꾸지 않는다');

  const policySelect = selectWithOption(container, 'every_step');
  assert.ok(policySelect, '확인 강도 select 가 있다');
  assert.equal(policySelect.value, 'auto', '기본 정책은 auto');
  assert.deepEqual(
    [...policySelect.options].map((o) => o.value),
    ['none', 'auto', 'key_steps', 'every_step'],
    '서버의 CONFIRM_POLICIES 와 같은 어휘여야 한다',
  );

  // graph 가 꺼져 있으면 그 사실을 알려야 한다 — 안 그러면 고르고도 왜 안 되는지 모른다.
  assert.match(container.textContent, /Turn on the execution graph above/);

  run(() => {
    graphCheckbox.click();
  });
  assert.match(container.textContent, /pauses at each gate until you answer/, '켜면 실제 동작을 설명한다');

  typeInto(container.querySelector('input'), 'Ship the export');
  const objective = [...container.querySelectorAll('textarea')][0];
  typeInto(objective, 'Do the thing.');

  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(policySelect), 'value')?.set;
    setter.call(policySelect, 'key_steps');
    policySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(policySelect.value, 'key_steps');

  // "즉시 브리핑" 생성은 project 가 하나는 있어야 보낸다(없으면 폼이 요청 없이 막는다).
  addProject(container, 'p-awb');

  const save = [...container.querySelectorAll('button')].find((b) => /Create & brief/.test(b.textContent || ''));
  assert.ok(save, '저장 버튼이 있다');
  click(save);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(calls.created.length, 1, '생성이 실제로 전송된다');
  assert.equal(calls.created[0].graph_enabled, true, '체크박스 값이 payload 에 실려야 한다');
  assert.equal(calls.created[0].confirm_policy, 'key_steps', '고른 정책이 payload 에 실려야 한다');
  assert.deepEqual(calls.created[0].projects, [{ project_id: 'p-awb' }], '고른 project 가 같은 payload 로 나간다');
  assert.equal('repo_ref' in calls.created[0], false, 'repo_ref 는 더 이상 보내지 않는다');
});

test('기존 draft 편집 — 저장된 graph_enabled/confirm_policy 가 폼에 반영되고 PATCH 로 되돌아간다', async (t) => {
  const calls = stubMissionApi(t);
  const mission = baseMission({
    graph_enabled: true,
    confirm_policy: 'every_step',
    projects: [{ project_id: 'p-awb', branch: 'main', name: 'AWB' }],
    folder_scope: 'isolated',
  });
  const { container } = await mountModal(t, { mission });

  // graph 가 켜진 미션은 Advanced 가 자동으로 펼쳐져야 한다 — 접혀 있으면 사용자가
  // 자기가 설정한 값을 다시 볼 수 없다.
  const graphCheckbox = [...container.querySelectorAll('input[type="checkbox"]')].find((i) =>
    /Execution graph/.test(i.closest('label')?.textContent || ''),
  );
  assert.ok(graphCheckbox, 'graph 가 켜진 미션은 Advanced 가 펼쳐진 채로 열린다');
  assert.equal(graphCheckbox.checked, true, '저장된 값이 반영된다');

  const policySelect = selectWithOption(container, 'every_step');
  assert.equal(policySelect.value, 'every_step', '저장된 정책이 반영된다');

  const save = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Save');
  click(save);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].data.graph_enabled, true, '편집 저장에도 값이 보존돼야 한다');
  assert.equal(calls.updated[0].data.confirm_policy, 'every_step');
  // 실행 계약을 고쳐 저장해도 미션의 project 들과 폴더 범위가 함께 되돌아간다.
  assert.deepEqual(calls.updated[0].data.projects, [{ project_id: 'p-awb', branch: 'main' }]);
  assert.equal(calls.updated[0].data.folder_scope, 'isolated');
  assert.equal('repo_ref' in calls.updated[0].data, false, '편집 경로도 repo_ref 를 보내지 않는다');
});
