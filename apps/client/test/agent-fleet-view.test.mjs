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
//   4) 화면은 탭 두 개다: Agents / Runtime Hosts(admin). 한 화면에 쌓지 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';
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

test('AI Agents 는 목록과 호스트 콘솔을 한 화면에 쌓지 않고 탭으로 가른다', () => {
  assert.match(agentsPageSource, /<PageTabs/);
  assert.match(agentsPageSource, /id: 'fleet'/);
  assert.match(agentsPageSource, /label: 'Runtime Hosts'/);
  // 두 표면이 동시에 렌더되면 "쌓기" 로 되돌아간 것이다 — 삼항으로 하나만 그린다.
  assert.match(agentsPageSource, /tab === 'fleet' \? \(\s*<AgentFleetPanel/);
  assert.match(agentsPageSource, /\) : \(\s*<AgentManagerPage/);
  // Runtime Hosts 탭은 admin 에게만 존재한다(비활성 탭으로 남겨 두지 않는다).
  assert.match(agentsPageSource, /canAccessAgentManager\s*\?\s*\[\{ id: 'runtime'/);
});

test('레거시 /admin/agent-manager 리다이렉트가 Runtime Hosts 탭으로 떨어진다', () => {
  // AdminPage 가 보내는 해시. 앵커만 남기고 탭을 안 맞추면 그 링크는 Agents 목록에
  // 도착해 아무것도 설명하지 못한다.
  assert.match(agentsPageSource, /RUNTIME_TAB_HASH = '#agent-manager-runtime'/);
  assert.match(agentsPageSource, /window\.location\.hash === RUNTIME_TAB_HASH \? 'runtime' : 'fleet'/);
  assert.match(agentsPageSource, /id="agent-manager-runtime"/);
});
