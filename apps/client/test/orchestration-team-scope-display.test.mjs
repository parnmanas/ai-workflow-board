// 팀 Edit 모달 스코프 표시 회귀 테스트 (티켓 3e4765bb).
//
// 실버그는 `team.is_global && <div/>` 형태라 workspace 종속 팀(is_global===false)이면
// 표현식이 false 로 평가되어 JSX 자체는 소스에 있어도 아무것도 렌더되지 않는다.
// 소스 정규식 단언만으로는 이 버그를 잡지 못하므로(파일에 코드가 여전히 존재) 실제
// DOM 마운트로 렌더 결과를 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { TeamFormModal } from '../src/components/orchestration/OrchestrationTeamsPage.tsx';

function baseTeam(overrides) {
  return {
    id: 'team-1',
    workspace_id: null,
    is_global: false,
    owner_workspace_id: null,
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
    ...overrides,
  };
}

async function mountModal(t, { team, workspaces = [] }) {
  const dom = setupDom();
  const view = mount(
    React.createElement(TeamFormModal, {
      isOpen: true,
      wsId: 'ws-1',
      agents: [],
      globalAgents: [],
      workspaces,
      team,
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

test('workspace 종속 팀 Edit은 Scope와 workspace 이름을 보여준다', async (t) => {
  const team = baseTeam({ is_global: false, workspace_id: 'ws-1', owner_workspace_id: 'ws-1' });
  const { container } = await mountModal(t, {
    team,
    workspaces: [{ id: 'ws-1', name: 'Platform' }],
  });
  assert.match(container.textContent, /Scope/);
  assert.match(container.textContent, /This workspace/);
  assert.match(container.textContent, /Platform/);
});

test('글로벌 팀 Edit은 workspace 종속 팀과 동일한 Scope 라벨/레이아웃으로 Global을 보여준다', async (t) => {
  const team = baseTeam({ is_global: true, workspace_id: null, owner_workspace_id: 'ws-1' });
  const { container } = await mountModal(t, { team, workspaces: [] });
  assert.match(container.textContent, /Scope/);
  assert.match(container.textContent, /Global/);

  const labels = [...container.querySelectorAll('label')].map((l) => l.textContent?.trim());
  assert.ok(labels.includes('Scope'));
});

test('workspace 이름 해석에 실패해도 (undefined)나 빈 괄호를 출력하지 않는다', async (t) => {
  const team = baseTeam({ is_global: false, workspace_id: 'ws-missing', owner_workspace_id: 'ws-missing' });
  const { container } = await mountModal(t, { team, workspaces: [] });
  assert.match(container.textContent, /This workspace/);
  assert.doesNotMatch(container.textContent, /\(undefined\)/);
  assert.doesNotMatch(container.textContent, /This workspace \(\)/);
});
