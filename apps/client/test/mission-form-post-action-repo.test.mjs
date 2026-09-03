// Mission 생성/편집 모달 — post_actions / repo_ref 라운드트립 회귀 테스트
// (리뷰 지적 반영, 티켓 2dc3c62f). 반려 사유: API 타입에는 post_actions/repo_ref가
// 있는데도 생성 모달 상태·submit이 이를 다루지 않았고 별도 편집 UI도 없었다.
//
// 이 파일이 고정하는 것:
//   - 기존 미션을 편집(mission prop이 채워짐)하면 그 미션의 post_actions/repo_ref가
//     폼 필드에 그대로 반영된다(Advanced 섹션이 자동으로 펼쳐진 상태로).
//   - 새 미션 생성(mission=null)에서도 "+ Add post-action" 버튼으로 행을 추가하고
//     action/condition/repo 필드를 채울 수 있다 — 이전엔 이 입력 자체가 없었다.
//
// api.listActions는 실제 서버 없이(jsdom, 네트워크 없음) 항상 실패해 빈 배열로
// 폴백한다(MissionFormModal 자체가 이미 .catch(() => setActions([]))로 처리) —
// 그래서 여기서는 데이터 의존적인 action <select>의 옵션이 아니라, 실제 서버 응답과
// 무관하게 항상 존재하는 고정 옵션(condition select)과 repo_ref 필드의 값으로
// 라운드트립을 검증한다.
//
// repo_ref 입력은 티켓 eb9cdd1c 에서 원시 텍스트 3개 → 공용 RepoRefPicker(검색형
// 드롭다운)로 바뀌었다. 여기서는 목록을 빈 배열로 스텁해 폴백 경로를 결정적으로
// 고정하고, 드롭다운 자체의 계약은 mission-form-repo-picker.test.mjs 가 다룬다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, run, typeInto, React, act } from './helpers/jsdom.mjs';
import { MissionFormModal } from '../src/components/orchestration/OrchestrationPage.tsx';
import { api } from '../src/api.ts';

function baseMission(overrides) {
  return {
    id: 'mission-1',
    workspace_id: 'ws-1',
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
    workspace_id: 'ws-1',
    is_global: false,
    owner_workspace_id: 'ws-1',
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

async function mountModal(t, { mission = null, listResources = async () => [], listRepoBranches = async () => ({ branches: [], default_branch: '' }) } = {}) {
  const dom = setupDom();
  const originalListResources = api.listResources;
  const originalListRepoBranches = api.listRepoBranches;
  api.listResources = listResources;
  api.listRepoBranches = listRepoBranches;
  t.after(() => {
    api.listResources = originalListResources;
    api.listRepoBranches = originalListRepoBranches;
  });
  const view = mount(
    React.createElement(MissionFormModal, {
      isOpen: true,
      wsId: 'ws-1',
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

test('기존 미션 편집 — post_actions/repo_ref가 채워진 미션은 Advanced가 자동으로 펼쳐지고 그 값이 폼에 반영된다', async (t) => {
  const mission = baseMission({
    post_actions: [
      { action_id: 'action-1', order: 1, condition: 'on_success', status: 'pending', run_id: null, room_id: null, error: '', dispatched_at: null },
    ],
    repo_ref: { resource_id: 'res-42', branch: 'main' },
  });
  const { container } = await mountModal(t, { mission });

  assert.match(container.textContent, /Post-completion actions/, 'Advanced 섹션이 자동으로 펼쳐져 post-action 편집기가 보인다');
  assert.match(container.textContent, /repo_ref \(작업폴더로 체크아웃할 저장소/, '공용 repo 피커 블록이 렌더링된다');

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_success'),
  );
  assert.ok(conditionSelect, 'condition select가 렌더링된다');
  assert.equal(conditionSelect.value, 'on_success', '기존 post_action의 condition이 그대로 반영된다');

  // 목록이 비어 있으면(권한 없음/등록된 repo 리소스 없음) 예전처럼 id 를 직접 넣을 수
  // 있어야 하고, 저장된 값이 거기에 그대로 실려 있어야 한다.
  const resourceInput = container.querySelector('input[aria-label="resource_id 직접 입력"]');
  assert.ok(resourceInput, '리소스 목록이 비면 resource_id 수동 입력이 제공된다');
  assert.equal(resourceInput.value, 'res-42', 'repo_ref.resource_id가 폼에 반영된다');
  const branchSelect = container.querySelector('select[aria-label="브랜치 선택"]');
  assert.ok(branchSelect, 'repo_ref.branch는 브랜치 드롭다운으로 편집한다');
  assert.equal(branchSelect.value, 'main', 'repo_ref.branch가 폼에 반영된다');

  // Team select는 편집 중엔 바뀌면 안 되므로 비활성화되어 있어야 한다.
  const teamSelect = [...container.querySelectorAll('select')].find((s) => s.value === 'team-1');
  assert.ok(teamSelect?.disabled, '편집 중에는 Team select가 비활성화된다');
});

test('새 미션 생성 — post-action 행을 추가하고 action/condition, repo_ref 필드를 채울 수 있다', async (t) => {
  const { container } = await mountModal(t, { mission: null });

  // Advanced는 기본적으로 접혀 있다 — 펼쳐야 필드가 나타난다.
  assert.doesNotMatch(container.textContent, /Post-completion actions/);
  const toggle = [...container.querySelectorAll('button')].find((b) => /Advanced/.test(b.textContent || ''));
  assert.ok(toggle, 'Advanced 토글 버튼이 있다');
  click(toggle);
  assert.match(container.textContent, /Post-completion actions/, '토글 후 post-action 편집기가 나타난다');
  // 토글로 새로 마운트된 repo 피커의 목록 조회를 act 안에서 끝낸다.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const addPostAction = [...container.querySelectorAll('button')].find((b) => /Add post-action/.test(b.textContent || ''));
  assert.ok(addPostAction, '"+ Add post-action" 버튼이 있다 — 이전엔 이 입력 자체가 없었다');
  click(addPostAction);

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_failure'),
  );
  assert.ok(conditionSelect, '행 추가 후 condition select가 나타난다');
  assert.equal(conditionSelect.value, 'always', '새 post-action의 condition 기본값은 always다');

  const repoUrlInput = container.querySelector('input[aria-label="repo URL"]');
  assert.ok(repoUrlInput, 'repo_ref용 URL input이 존재한다');
  typeInto(repoUrlInput, 'https://example.test/repo.git');
  assert.equal(repoUrlInput.value, 'https://example.test/repo.git', 'repo_ref URL을 타이핑으로 채울 수 있다');
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

  const save = [...container.querySelectorAll('button')].find((b) => /Create & brief/.test(b.textContent || ''));
  assert.ok(save, '저장 버튼이 있다');
  click(save);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(calls.created.length, 1, '생성이 실제로 전송된다');
  assert.equal(calls.created[0].graph_enabled, true, '체크박스 값이 payload 에 실려야 한다');
  assert.equal(calls.created[0].confirm_policy, 'key_steps', '고른 정책이 payload 에 실려야 한다');
});

test('기존 draft 편집 — 저장된 graph_enabled/confirm_policy 가 폼에 반영되고 PATCH 로 되돌아간다', async (t) => {
  const calls = stubMissionApi(t);
  const mission = baseMission({ graph_enabled: true, confirm_policy: 'every_step' });
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
});
