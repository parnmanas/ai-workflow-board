// Action fan-out UI (티켓 fc3906c5).
//
// 두 가지를 검증한다:
//   1. 실행 이력의 배치 묶음 판정 — 전체 성공 / 부분 실패 / 전체 실패 / 진행 중.
//      에이전트별 최종 결과는 재시도 체인의 마지막 시도여야 한다.
//   2. 편집 화면에서 대상 에이전트를 2개 이상 선택해 저장할 수 있고, 저장
//      페이로드가 `target_agent_ids` 로 나간다.
//
// (2)는 실제 컴포넌트를 mount 해서 확인한다 — "체크박스를 렌더한다"가 아니라
// "체크한 결과가 서버로 나간다"까지 봐야 배선 회귀를 잡는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import ActionManager, { groupRunsIntoBatches } from '../src/components/admin/ActionManager.tsx';
import { formatAgentDisplayName } from '../src/utils/agentName.ts';

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

// 같은 leaf 이름('deployer')을 쓰는 두 매니저 소속 에이전트 — 접두사가 없으면
// 어느 호스트인지 구분할 수 없는, 이 티켓이 겨냥하는 형상 그대로다.
const AGENTS = [
  { id: 'agent-a', name: 'deployer', manager_name: 'rolf' },
  { id: 'agent-b', name: 'deployer', manager_name: 'ragnar' },
];

function run(over = {}) {
  return {
    id: over.id || 'run-1',
    action_id: 'action-1',
    workspace_id: 'ws-1',
    room_id: over.room_id || 'room-1',
    triggered_by_type: 'system',
    triggered_by_id: '',
    prompt_rendered: '',
    created_at: over.created_at || '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

test('배치 묶음: 전체 성공 / 부분 실패 / 전체 실패 / 진행 중을 구분한다', () => {
  const batches = groupRunsIntoBatches([
    run({ id: 'ok-1', batch_id: 'b-ok', agent_id: 'agent-a', status: 'succeeded' }),
    run({ id: 'ok-2', batch_id: 'b-ok', agent_id: 'agent-b', status: 'succeeded' }),
    run({ id: 'mix-1', batch_id: 'b-mix', agent_id: 'agent-a', status: 'succeeded' }),
    run({ id: 'mix-2', batch_id: 'b-mix', agent_id: 'agent-b', status: 'failed' }),
    run({ id: 'bad-1', batch_id: 'b-bad', agent_id: 'agent-a', status: 'failed' }),
    run({ id: 'bad-2', batch_id: 'b-bad', agent_id: 'agent-b', status: 'failed' }),
    run({ id: 'live-1', batch_id: 'b-live', agent_id: 'agent-a', status: 'succeeded' }),
    run({ id: 'live-2', batch_id: 'b-live', agent_id: 'agent-b', status: 'running' }),
  ]);
  const byKey = Object.fromEntries(batches.map((b) => [b.key, b]));

  assert.equal(byKey['b-ok'].verdict, 'succeeded');
  assert.equal(byKey['b-mix'].verdict, 'partial');
  assert.equal(byKey['b-mix'].succeeded, 1);
  assert.equal(byKey['b-mix'].total, 2);
  assert.equal(byKey['b-bad'].verdict, 'failed');
  assert.equal(byKey['b-live'].verdict, 'running', 'run 하나라도 돌고 있으면 배치는 미완이다');
});

test('에이전트별 최종 결과는 재시도 체인의 마지막 시도다', () => {
  const [batch] = groupRunsIntoBatches([
    run({ id: 'a1', batch_id: 'b', agent_id: 'agent-a', status: 'failed', attempt: 1 }),
    run({ id: 'a2', batch_id: 'b', agent_id: 'agent-a', status: 'succeeded', attempt: 2 }),
    run({ id: 'b1', batch_id: 'b', agent_id: 'agent-b', status: 'succeeded', attempt: 1 }),
  ]);
  assert.equal(batch.total, 2, '재시도는 대상 수를 늘리지 않는다');
  assert.equal(batch.verdict, 'succeeded', '1회차 실패가 최종 판정을 오염시키면 안 된다');
  assert.deepEqual(batch.finals.map((r) => r.id).sort(), ['a2', 'b1']);
});

test('batch_id 가 없는 레거시 run 은 각자 독립 배치로 취급된다', () => {
  const batches = groupRunsIntoBatches([
    run({ id: 'legacy-1', agent_id: '', batch_id: '', status: 'succeeded' }),
    run({ id: 'legacy-2', agent_id: '', batch_id: '', status: 'failed' }),
  ]);
  assert.equal(batches.length, 2, '레거시 run 을 한 배치로 뭉치면 없던 부분 실패가 생긴다');
  assert.ok(batches.every((b) => b.total === 1));
});

test('배치는 최신 실행이 위로 정렬된다', () => {
  const batches = groupRunsIntoBatches([
    run({ id: 'old', batch_id: 'b-old', agent_id: 'agent-a', created_at: '2026-09-01T00:00:00.000Z' }),
    run({ id: 'new', batch_id: 'b-new', agent_id: 'agent-a', created_at: '2026-09-05T00:00:00.000Z' }),
  ]);
  assert.deepEqual(batches.map((b) => b.key), ['b-new', 'b-old']);
});

test('목록이 target_agent_ids 를 JSON 문자열로 받아도 화면이 터지지 않는다', async () => {
  setupDom();
  const originals = { listActions: api.listActions, getAgents: api.getAgents };
  // 정규화를 빠뜨린 서버 경로(또는 캐시된 구 응답)를 재현한다 — 이 컬럼은 DB 에
  // JSON 문자열로 저장되므로 엔티티가 그대로 흘러나오면 이 형태가 된다.
  api.listActions = async () => [{
    id: 'action-1', workspace_id: 'ws-1', board_id: null, name: 'CLI 최신화',
    description: '', prompt: '', target_agent_id: 'agent-a',
    target_agent_ids: '["agent-a","agent-b"]',
    schedule_cron: '', trigger: '', trigger_label: '', enabled: true, max_runs: 10,
    last_run_at: null, workspace_folder: '', repo_ref: null, checkout_mode: 'reuse',
    created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
  }];
  api.getAgents = async () => AGENTS;

  try {
    const { container, unmount } = mount(React.createElement(ActionManager, { workspaceId: 'ws-1' }));
    await flush();
    // 문자열에 .filter 를 부르면 렌더가 통째로 죽어 이름조차 안 보인다.
    assert.match(container.textContent, /CLI 최신화/);
    assert.match(container.textContent, /2개 에이전트/, '문자열도 대상 2개로 해석돼야 한다');
    unmount();
  } finally {
    Object.assign(api, originals);
  }
});

test('편집 화면에서 대상 2개를 선택해 저장하면 target_agent_ids 로 나간다', async () => {
  setupDom();
  const saved = [];
  const originals = {
    listActions: api.listActions,
    getAgents: api.getAgents,
    createAction: api.createAction,
  };
  api.listActions = async () => [];
  api.getAgents = async () => AGENTS;
  api.createAction = async (payload) => { saved.push(payload); return { id: 'action-new', ...payload }; };

  try {
    const { container, unmount } = mount(React.createElement(ActionManager, { workspaceId: 'ws-1' }));
    await flush();

    // "+ New Action" 으로 폼을 연다.
    const newButton = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('New Action'));
    assert.ok(newButton, '신규 생성 버튼을 찾지 못했다');
    click(newButton);
    await flush();

    const picker = container.querySelector('[data-testid="action-target-agents"]');
    assert.ok(picker, '대상 에이전트 다중 선택 컨트롤이 없다');

    const boxes = [...picker.querySelectorAll('input[type="checkbox"]')];
    assert.equal(boxes.length, 2, '워크스페이스의 에이전트마다 체크박스가 있어야 한다');

    // 두 대상이 `<Manager>/<Agent>` 로 구분돼 보여야 한다 — bare name 이면
    // 'deployer' 두 줄이라 어느 호스트인지 고를 수 없다.
    const labels = [...picker.querySelectorAll('label')].map((l) => l.textContent.trim());
    assert.deepEqual(labels.sort(), AGENTS.map(formatAgentDisplayName).sort());

    // 첫 대상은 startCreate 가 기본 선택해 두므로, 두 번째만 추가로 체크한다.
    assert.equal(boxes[0].checked, true, '첫 에이전트가 기본 선택되어야 한다');
    click(boxes[1]);
    await flush();

    const nameInput = container.querySelector('input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, 'CLI 최신화');
      nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    const createButton = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create Action');
    assert.ok(createButton, '저장 버튼을 찾지 못했다');
    click(createButton);
    await flush();

    assert.equal(saved.length, 1, '저장이 호출되지 않았다');
    assert.deepEqual(saved[0].target_agent_ids, ['agent-a', 'agent-b']);
    unmount();
  } finally {
    Object.assign(api, originals);
  }
});
