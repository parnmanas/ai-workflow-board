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
// 무관하게 항상 존재하는 고정 옵션(condition select)과 순수 텍스트 input(repo_ref)의
// 값으로 라운드트립을 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { MissionFormModal } from '../src/components/orchestration/OrchestrationPage.tsx';

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
    counts: { total: 0, done: 0, failed: 0, inFlight: 0, pending: 0 },
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

async function mountModal(t, { mission = null } = {}) {
  const dom = setupDom();
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
  assert.match(container.textContent, /Repo \(optional\)/);

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_success'),
  );
  assert.ok(conditionSelect, 'condition select가 렌더링된다');
  assert.equal(conditionSelect.value, 'on_success', '기존 post_action의 condition이 그대로 반영된다');

  const resourceInput = [...container.querySelectorAll('input')].find((i) => i.value === 'res-42');
  assert.ok(resourceInput, 'repo_ref.resource_id가 텍스트 input에 반영된다');
  const branchInput = [...container.querySelectorAll('input')].find((i) => i.value === 'main');
  assert.ok(branchInput, 'repo_ref.branch가 텍스트 input에 반영된다');

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

  const addPostAction = [...container.querySelectorAll('button')].find((b) => /Add post-action/.test(b.textContent || ''));
  assert.ok(addPostAction, '"+ Add post-action" 버튼이 있다 — 이전엔 이 입력 자체가 없었다');
  click(addPostAction);

  const conditionSelect = [...container.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'on_failure'),
  );
  assert.ok(conditionSelect, '행 추가 후 condition select가 나타난다');
  assert.equal(conditionSelect.value, 'always', '새 post-action의 condition 기본값은 always다');

  const repoUrlInput = [...container.querySelectorAll('input')].find(
    (i) => i.placeholder === 'or raw git URL',
  );
  assert.ok(repoUrlInput, 'repo_ref용 URL input이 존재한다');
  typeInto(repoUrlInput, 'https://example.test/repo.git');
  assert.equal(repoUrlInput.value, 'https://example.test/repo.git', 'repo_ref URL을 타이핑으로 채울 수 있다');
});
