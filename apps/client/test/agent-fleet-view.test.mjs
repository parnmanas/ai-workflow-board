// AI Agents 화면 — Agent 를 카테고리로 묶어 보여주는 표면.
//
// 고치는 증상: 예전 화면은 같은 URL 이 사람마다 다른 것을 보여 줬다. 관리자에게는
// Runtime Host 콘솔이 뜨고 Agent 는 인스턴스 상세 안에 묻혔으며, 비관리자에게는
// 그룹도 필터도 검색도 없는 평면 목록 하나만 나왔다. 어느 쪽도 "무엇이 고장났나 /
// 어느 장비가 무엇을 돌리나" 를 답하지 못했다.
//
// 그래서 고정하는 것:
//   1) 상태 분류가 `lifecycle_state` 하나가 아니라 **작업 유무까지** 본다(online 이
//      "일하는 중" 과 "노는 중" 을 합쳐 버리면 칩이 쓸모없어진다).
//   2) 칩 숫자 = 그 카테고리를 눌렀을 때 실제로 남는 카드 수. 검색 중에도 같다.
//   3) 호스트 그룹 키는 manager_agent_id — 이름이 아직 안 실려 온 정상 Agent 를
//      "spawn 되지 않는다" 그룹에 넣지 않는다.
//   4) 프레임은 하나다: 왼쪽 Runtime Host 목록 + 오른쪽 내용. 호스트를 고르지 않은
//      기본 상태의 내용이 이 Agent 그리드다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  AGENT_STATUS_ORDER,
  UNASSIGNED_HOST_KEY,
  agentStatusCategory,
  agentTaskCount,
  countByStatus,
  filterAgents,
  groupAgents,
} from '../src/components/agents/agentFleet.logic.ts';

const task = (title) => ({
  kind: 'ticket',
  ticket_id: `t-${title}`,
  ticket_title: title,
  claimed_at: '2026-09-27T00:00:00.000Z',
  role: 'assignee',
});

function agent(over = {}) {
  return {
    id: over.id || 'a',
    name: over.name || 'Agent',
    manager_agent_id: 'mgr-rolf',
    manager_name: 'rolf',
    is_online: true,
    last_seen_at: '2026-09-27T00:00:00.000Z',
    connected_at: '2026-09-27T00:00:00.000Z',
    workspace_id: 'ws',
    pending_trigger_count: 0,
    active_tasks: [],
    ...over,
  };
}

test('상태 분류: online 은 물고 있는 일이 있느냐로 갈린다', () => {
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'online', active_tasks: [task('x')] })), 'working');
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'online', active_tasks: [] })), 'idle');
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'error' })), 'error');
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'starting' })), 'starting');
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'offline' })), 'offline');
  assert.equal(agentStatusCategory(agent({ lifecycle_state: 'never_started' })), 'never_started');
  // 구버전 서버(lifecycle_state 없음)도 같은 축으로 떨어진다.
  assert.equal(agentStatusCategory(agent({ lifecycle_state: undefined, is_online: true, active_tasks: [task('y')] })), 'working');
  assert.equal(
    agentStatusCategory(agent({ lifecycle_state: undefined, is_online: false, last_seen_at: null, connected_at: null })),
    'never_started',
  );
  assert.equal(agentStatusCategory(agent({ lifecycle_state: undefined, is_online: false })), 'offline');
  // 레거시 단수 current_task 만 오는 경우도 "작업 중" 이다.
  assert.equal(
    agentStatusCategory(agent({ lifecycle_state: 'online', active_tasks: undefined, current_task: task('legacy') })),
    'working',
  );
  assert.equal(agentTaskCount(agent({ active_tasks: undefined, current_task: task('legacy') })), 1);
});

test('손볼 것이 먼저 온다 — 칩·그룹 순서는 오류부터', () => {
  assert.deepEqual([...AGENT_STATUS_ORDER], ['error', 'working', 'starting', 'idle', 'offline', 'never_started']);
});

test('칩 숫자는 그 칩을 눌렀을 때 실제로 남는 카드 수와 같다 (검색 중에도)', () => {
  const agents = [
    agent({ id: '1', name: 'alpha', lifecycle_state: 'error' }),
    agent({ id: '2', name: 'alpha-two', lifecycle_state: 'online', active_tasks: [task('t')] }),
    agent({ id: '3', name: 'beta', lifecycle_state: 'online' }),
    agent({ id: '4', name: 'gamma', lifecycle_state: 'offline' }),
  ];
  const counts = countByStatus(agents);
  assert.equal(counts.error, 1);
  assert.equal(counts.working, 1);
  assert.equal(counts.idle, 1);
  assert.equal(counts.offline, 1);
  for (const category of AGENT_STATUS_ORDER) {
    assert.equal(filterAgents(agents, { status: category }).length, counts[category], category);
  }

  // 검색으로 좁힌 뒤의 숫자도 그 안에서 맞아야 한다 — 전체 기준으로 세면
  // "오류 1" 을 눌렀는데 빈 화면이 되는 조합이 생긴다.
  const searched = filterAgents(agents, { query: 'alpha' });
  assert.deepEqual(searched.map((a) => a.id), ['1', '2']);
  const searchedCounts = countByStatus(searched);
  assert.equal(searchedCounts.offline, 0);
  assert.equal(filterAgents(searched, { status: 'offline' }).length, 0);
});

test('검색은 이름·매니저 접두·폴더·CLI·모델에 걸린다', () => {
  const a = agent({ id: '1', name: 'Builder', type: 'opencode', model: 'glm-5.3', working_dir: '/srv/checkout' });
  assert.equal(filterAgents([a], { query: 'builder' }).length, 1);
  assert.equal(filterAgents([a], { query: 'rolf/' }).length, 1, '매니저 접두로도 찾는다');
  assert.equal(filterAgents([a], { query: 'opencode' }).length, 1);
  assert.equal(filterAgents([a], { query: 'glm' }).length, 1);
  assert.equal(filterAgents([a], { query: 'checkout' }).length, 1);
  assert.equal(filterAgents([a], { query: 'nothing' }).length, 0);
});

test('호스트 그룹 키는 manager_agent_id — 이름이 없다고 "미지정" 으로 보내지 않는다', () => {
  const groups = groupAgents(
    [
      agent({ id: '1', manager_agent_id: 'mgr-a', manager_name: 'ralf' }),
      // 같은 호스트인데 이름만 아직 안 실려 왔다. 예전 코드는 이 행을
      // "런타임 호스트 미지정" 으로 보내 멀쩡한 Agent 를 고장난 것처럼 보여 줬다.
      agent({ id: '2', manager_agent_id: 'mgr-a', manager_name: undefined }),
      agent({ id: '3', manager_agent_id: '', manager_name: undefined }),
    ],
    'host',
    { hostNames: new Map([['mgr-a', 'ralf']]) },
  );
  assert.deepEqual(groups.map((g) => g.key), ['mgr-a', UNASSIGNED_HOST_KEY]);
  assert.deepEqual(groups[0].agents.map((a) => a.id), ['1', '2']);
  assert.equal(groups[0].label, 'ralf');
  // 진짜로 호스트가 없는 것만 경고 문구를 단다.
  assert.match(groups[1].hint, /spawn 되지 않는다/);
  assert.equal(groups[0].hint, undefined);

  // 이름을 어디서도 못 구하면 id 앞자리로라도 그룹을 구분한다(같은 통에 섞지 않는다).
  const unnamed = groupAgents(
    [agent({ id: '1', manager_agent_id: 'mgr-aaaaaaaa1' }), agent({ id: '2', manager_agent_id: 'mgr-bbbbbbbb2' })],
    'host',
  );
  assert.equal(unnamed.length, 2);
});

test('그룹 축 셋이 각각 제 순서로 나오고, 빈 그룹은 만들지 않는다', () => {
  const agents = [
    agent({ id: '1', name: 'z', manager_agent_id: 'm2', manager_name: 'zeta', type: 'codex', lifecycle_state: 'offline' }),
    agent({ id: '2', name: 'a', manager_agent_id: 'm1', manager_name: 'alpha', type: 'claude', lifecycle_state: 'error' }),
    agent({ id: '3', name: 'b', manager_agent_id: 'm1', manager_name: 'alpha', type: 'claude', lifecycle_state: 'online', active_tasks: [task('t')] }),
  ];

  // status: 손볼 것 먼저
  assert.deepEqual(groupAgents(agents, 'status').map((g) => g.key), ['error', 'working', 'offline']);
  // host: 이름 오름차순
  assert.deepEqual(groupAgents(agents, 'host').map((g) => g.label), ['alpha', 'zeta']);
  // cli: 카탈로그 라벨로 표시된다
  assert.deepEqual(groupAgents(agents, 'cli').map((g) => g.key), ['claude', 'codex']);
  assert.equal(groupAgents(agents, 'cli')[0].label, 'Claude Code');

  // 그룹 안에서도 손볼 것이 먼저
  assert.deepEqual(groupAgents(agents, 'host')[0].agents.map((a) => a.id), ['2', '3']);

  // 필터가 비운 그룹의 헤더만 남지 않는다
  const onlyError = filterAgents(agents, { status: 'error' });
  assert.deepEqual(groupAgents(onlyError, 'host').map((g) => g.label), ['alpha']);
  assert.deepEqual(groupAgents([], 'host'), []);
});

// ─── 화면 구조 ────────────────────────────────────────────────────────────

const agentsPageSource = await readFile(new URL('../src/components/AgentsPage.tsx', import.meta.url), 'utf8');

test('프레임은 Runtime Host 목록 + 내용 하나다 — 탭으로 가르지 않는다', () => {
  // 탭으로 갈랐더니 매니저 업데이트·CLI 버전 같은 호스트 조작이 통째로 다른 탭
  // 뒤로 숨어 "여기서 뭘 하라는 건지" 를 알 수 없게 됐다(사용자 피드백).
  // master/detail 한 프레임으로 되돌린다.
  assert.doesNotMatch(agentsPageSource, /<PageTabs/);
  assert.doesNotMatch(agentsPageSource, /label: 'Runtime Hosts'/);
  assert.match(agentsPageSource, /<AgentManagerPage/);
});

test('호스트를 고르지 않은 기본 상태의 내용이 Agent 그리드다', () => {
  // 탭을 없애면서 Agent 가 다시 안 보이게 되면 이 화면을 탭으로 가른 원래 이유
  // ("AI Agents 인데 Agent 가 안 보인다")로 되돌아간다. 빈 detail 자리에 넣는다.
  assert.match(agentsPageSource, /emptyDetail=\{\s*<AgentFleetPanel/);

  const managerSource = readFileSync(
    new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url),
    'utf8',
  );
  // 고른 호스트가 있으면 상세가 이기고, 없을 때만 emptyDetail 이 나온다.
  assert.match(managerSource, /\) : emptyDetail !== undefined \? \(\s*emptyDetail/);
});

test('레거시 /admin/agent-manager 리다이렉트가 갈 앵커는 남아 있다', () => {
  // AdminPage 가 보내는 해시. 화면이 하나뿐이라 탭을 고를 일은 없지만 앵커가
  // 없으면 그 링크가 아무 데도 도착하지 못한다.
  assert.match(agentsPageSource, /RUNTIME_ANCHOR_ID = 'agent-manager-runtime'/);
  assert.match(agentsPageSource, /id=\{RUNTIME_ANCHOR_ID\}/);
});

test('매니저 버전·업데이트와 CLI 버전은 제목 달린 자기 자리에 있다', () => {
  // 사용자 피드백: "agent manager 를 어떻게 업데이트할지, cli 버전이나 업데이트
  // 어떻게 할지 다 사라지고 도대체 뭘 하라는건지". 둘 다 사실 나열(<dl>) 한복판에
  // 파묻혀 있었고, 매니저 Update 버튼은 update_available 일 때만 나타나 최신인
  // 호스트에서는 "여기서 올린다" 는 사실 자체가 화면에서 사라졌다.
  const managerSource = readFileSync(
    new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url),
    'utf8',
  );
  assert.match(managerSource, /Agent Manager\s*\n\s*<\/div>/);
  assert.match(managerSource, /CLI 설치본\s*\n\s*<\/div>/);
  // 최신일 때도 버튼 자리는 남는다 — 숨기면 어디서 올리는지 알 수 없다.
  assert.match(managerSource, /\{inst\.update_available \? \(/);
  assert.match(managerSource, /'업데이트 확인 불가' : '최신'/);
});
