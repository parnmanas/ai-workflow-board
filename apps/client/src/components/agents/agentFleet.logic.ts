// Agent 목록을 "카테고리별로" 보여주기 위한 순수 로직.
//
// 화면이 아니라 여기에 있는 이유: 상태 분류(무엇이 "작업 중"인가)와 그룹 순서는
// 필터 칩·그룹 헤더·빈 상태 문구가 **모두 같은 답**을 써야 하는 규칙이라, 컴포넌트
// 안에 흩어두면 칩의 개수와 실제 그룹 크기가 어긋난다. DOM 없이 테스트한다.

import type { AgentLifecycleState, DashboardAgent } from '../../types';
import { cliLabel } from '../../cli/catalog';
import { formatAgentDisplayName } from '../../utils/agentName';

/**
 * 운영자가 실제로 구분해서 행동하는 단위. 서버의 `lifecycle_state` 5개를 그대로 쓰지
 * 않는 이유는 하나뿐이다 — online 은 "지금 티켓을 물고 있다"와 "붙어는 있는데 논다"를
 * 합쳐 버리는데, 그 둘은 운영자에게 전혀 다른 상태다.
 */
export type AgentStatusCategory =
  | 'error'
  | 'working'
  | 'starting'
  | 'idle'
  | 'offline'
  | 'never_started';

/** 칩과 그룹이 쓰는 표시 순서 — 손볼 것이 먼저 온다(오류 → 작업 중 → … → 미시작). */
export const AGENT_STATUS_ORDER: readonly AgentStatusCategory[] = [
  'error',
  'working',
  'starting',
  'idle',
  'offline',
  'never_started',
];

export const AGENT_STATUS_META: Record<
  AgentStatusCategory,
  { label: string; variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral' }
> = {
  error: { label: '오류', variant: 'danger' },
  working: { label: '작업 중', variant: 'info' },
  starting: { label: '시작 중', variant: 'warning' },
  idle: { label: '대기', variant: 'success' },
  offline: { label: '오프라인', variant: 'neutral' },
  never_started: { label: '미시작', variant: 'neutral' },
};

/** 카드가 세는 것과 같은 규칙 — active_tasks 우선, 구버전 서버는 current_task 하나. */
export function agentTaskCount(agent: DashboardAgent): number {
  if (agent.active_tasks && agent.active_tasks.length) return agent.active_tasks.length;
  return agent.current_task ? 1 : 0;
}

/** 서버가 lifecycle_state 를 안 보내는 경우(구버전)의 폴백 — AgentCard 와 같은 규칙. */
function resolveLifecycle(agent: DashboardAgent): AgentLifecycleState {
  if (agent.lifecycle_state) return agent.lifecycle_state;
  if (agent.is_online) return 'online';
  if (!agent.last_seen_at && !agent.connected_at) return 'never_started';
  return 'offline';
}

export function agentStatusCategory(agent: DashboardAgent): AgentStatusCategory {
  const state = resolveLifecycle(agent);
  if (state === 'error') return 'error';
  if (state === 'starting') return 'starting';
  if (state === 'never_started') return 'never_started';
  if (state === 'offline') return 'offline';
  // online: 물고 있는 일이 있으면 "작업 중", 없으면 "대기".
  return agentTaskCount(agent) > 0 ? 'working' : 'idle';
}

export function countByStatus(agents: readonly DashboardAgent[]): Record<AgentStatusCategory, number> {
  const counts: Record<AgentStatusCategory, number> = {
    error: 0, working: 0, starting: 0, idle: 0, offline: 0, never_started: 0,
  };
  for (const agent of agents) counts[agentStatusCategory(agent)] += 1;
  return counts;
}

// ─── 검색 ─────────────────────────────────────────────────────────────────

/** 이름(매니저 접두 포함) · 설명 · 작업 폴더 · CLI · 모델에 걸린다. */
export function agentMatchesQuery(agent: DashboardAgent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    formatAgentDisplayName(agent),
    agent.name,
    agent.description,
    agent.working_dir,
    agent.type,
    agent.model,
  ];
  return haystack.some((value) => !!value && String(value).toLowerCase().includes(q));
}

export interface AgentFilter {
  query?: string;
  /** null = 전체. */
  status?: AgentStatusCategory | null;
}

export function filterAgents(
  agents: readonly DashboardAgent[],
  filter: AgentFilter = {},
): DashboardAgent[] {
  const { query = '', status = null } = filter;
  return agents.filter(
    (agent) =>
      (!status || agentStatusCategory(agent) === status) && agentMatchesQuery(agent, query),
  );
}

// ─── 그룹 ─────────────────────────────────────────────────────────────────

export type AgentGroupBy = 'host' | 'status' | 'cli';

export const AGENT_GROUP_BY_OPTIONS: ReadonlyArray<{ value: AgentGroupBy; label: string }> = [
  { value: 'host', label: 'Runtime Host' },
  { value: 'status', label: '상태' },
  { value: 'cli', label: 'CLI' },
];

export interface AgentGroup {
  key: string;
  label: string;
  /** 헤더 옆에 붙는 한 줄 부연(없으면 생략). */
  hint?: string;
  agents: DashboardAgent[];
}

/** Runtime Host 가 **지정되지 않은** Agent 들의 그룹. 항상 마지막에 온다. */
export const UNASSIGNED_HOST_KEY = '__no_host__';
/** CLI 를 모르는 Agent 들의 그룹(구버전 서버). 역시 마지막. */
export const UNKNOWN_CLI_KEY = '__no_cli__';

export interface GroupOptions {
  /** manager_agent_id → 사람이 읽는 호스트 이름. 서버가 `manager_name` 을 빼먹은
   *  경우(구버전 dashboard)를 메운다. */
  hostNames?: ReadonlyMap<string, string>;
}

/**
 * 그룹 키는 **manager_agent_id** 다 — 이름이 아니다. 호스트 이름을 바꿔도 그룹이
 * 갈라지지 않고, 이름이 아직 안 실려 온 Agent 도 같은 호스트로 모인다.
 *
 * "미지정" 은 `manager_agent_id` 자체가 없을 때만이다. 예전엔 `manager_name` 만 보고
 * 갈라서, 이름을 못 받은 정상 Agent 까지 "spawn 되지 않는다" 그룹에 넣어 멀쩡한 것을
 * 고장난 것처럼 보여 줬다.
 */
function hostGroup(agent: DashboardAgent, options: GroupOptions): { key: string; label: string } {
  const managerId = (agent.manager_agent_id || '').trim();
  if (!managerId) return { key: UNASSIGNED_HOST_KEY, label: '런타임 호스트 미지정' };
  const name =
    (agent.manager_name || '').trim()
    || (options.hostNames?.get(managerId) || '').trim()
    || `호스트 ${managerId.slice(0, 8)}`;
  return { key: managerId, label: name };
}

function cliGroup(agent: DashboardAgent): { key: string; label: string } {
  const cli = (agent.type || '').trim();
  if (!cli) return { key: UNKNOWN_CLI_KEY, label: 'CLI 미지정' };
  return { key: cli, label: cliLabel(cli) };
}

/**
 * 그룹 순서 규칙:
 *   - status: AGENT_STATUS_ORDER (손볼 것 먼저)
 *   - host / cli: 이름 오름차순, 단 "미지정" 그룹은 언제나 마지막
 * 빈 그룹은 만들지 않는다 — 필터가 비운 그룹의 헤더만 남는 화면을 막는다.
 */
export function groupAgents(
  agents: readonly DashboardAgent[],
  groupBy: AgentGroupBy,
  options: GroupOptions = {},
): AgentGroup[] {
  const buckets = new Map<string, AgentGroup>();
  const push = (key: string, label: string, agent: DashboardAgent, hint?: string) => {
    const existing = buckets.get(key);
    if (existing) existing.agents.push(agent);
    else buckets.set(key, { key, label, hint, agents: [agent] });
  };

  for (const agent of agents) {
    if (groupBy === 'status') {
      const category = agentStatusCategory(agent);
      push(category, AGENT_STATUS_META[category].label, agent);
    } else if (groupBy === 'cli') {
      const { key, label } = cliGroup(agent);
      push(key, label, agent);
    } else {
      const { key, label } = hostGroup(agent, options);
      push(key, label, agent, key === UNASSIGNED_HOST_KEY ? '실행할 Runtime Host 가 없어 spawn 되지 않는다' : undefined);
    }
  }

  const groups = [...buckets.values()];
  for (const group of groups) {
    // 그룹 안에서도 손볼 것이 먼저 — 같은 상태면 이름순.
    //
    // 정렬 키가 표시 이름(`매니저/이름`)이 아니라 **맨 이름**인 이유: 호스트 그룹에서
    // 매니저 접두는 이미 헤더에 있어 정렬에 보태는 정보가 없고, 그 접두가 아직 안
    // 실려 온 행만 통째로 앞으로 튀어 순서가 데이터 도착 순서에 따라 흔들린다.
    // 같은 이름이 둘이면 id 로 묶어 렌더가 항상 같은 순서를 내게 한다.
    group.agents.sort((a, b) => {
      const byStatus =
        AGENT_STATUS_ORDER.indexOf(agentStatusCategory(a)) -
        AGENT_STATUS_ORDER.indexOf(agentStatusCategory(b));
      if (byStatus !== 0) return byStatus;
      const byName = (a.name || formatAgentDisplayName(a)).localeCompare(b.name || formatAgentDisplayName(b));
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });
  }

  if (groupBy === 'status') {
    groups.sort(
      (a, b) =>
        AGENT_STATUS_ORDER.indexOf(a.key as AgentStatusCategory) -
        AGENT_STATUS_ORDER.indexOf(b.key as AgentStatusCategory),
    );
    return groups;
  }

  const unassigned = (key: string) => key === UNASSIGNED_HOST_KEY || key === UNKNOWN_CLI_KEY;
  groups.sort((a, b) => {
    if (unassigned(a.key) !== unassigned(b.key)) return unassigned(a.key) ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
  return groups;
}
