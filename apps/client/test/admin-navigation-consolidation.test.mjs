import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sidebarSource, adminPageSource, agentsPageSource, agentManagerPageSource] = await Promise.all([
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AdminPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/AgentsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url), 'utf8'),
]);

test('ADMIN navigation omits standalone QA, Column Policies, and Agent Manager items', () => {
  assert.doesNotMatch(sidebarSource, /label:\s*'QA Tests'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'Column Policies'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'Agent Manager'/);
});

test('legacy Agent Manager URL redirects into the workspace AI Agents runtime section', () => {
  assert.match(
    adminPageSource,
    /path="agent-manager"[\s\S]*WorkspaceRouteRedirect path="agents#agent-manager-runtime"/,
  );
  assert.doesNotMatch(adminPageSource, /path="qa"/);
  assert.doesNotMatch(adminPageSource, /path="column-policies"/);
});

test('AI Agents owns the admin-gated Agent Manager runtime surface', () => {
  assert.match(agentsPageSource, /import AgentManagerPage from '\.\/admin\/AgentManagerPage'/);
  assert.match(agentsPageSource, /hasPermission\('admin\.access'\)/);
  // 앵커 문자열은 상수로 뺐다 — 화면이 하나뿐이라 탭을 고르는 데 쓰이지 않고,
  // AdminPage 가 보내는 해시가 도착할 자리로만 남는다.
  assert.match(agentsPageSource, /RUNTIME_ANCHOR_ID = 'agent-manager-runtime'/);
  assert.match(agentsPageSource, /id=\{RUNTIME_ANCHOR_ID\}/);
  assert.match(agentsPageSource, /<AgentManagerPage[\s\S]*workspaceAgents=\{agents \|\| \[\]\}/);
});

// 한 화면에 목록과 호스트 콘솔을 **쌓지 않는다**는 규칙은 그대로다 — 다만 해결 수단이
// "목록을 없애고 콘솔만 남긴다" 에서 "탭으로 가른다" 로 바뀌었다(agent-fleet-view
// 테스트가 그 탭 구조를 고정한다). 여기서는 AgentsPage 가 카드 그리드를 직접 손으로
// 짜지 않는다는 것만 본다 — 그리드는 AgentFleetPanel 의 일이고, 그래야 Agent artifact
// 패널과 같은 <AgentCard> 를 계속 공유한다.
test('AI Agents delegates the card grid instead of hand-rolling one next to the runtime console', () => {
  assert.doesNotMatch(agentsPageSource, /import AgentCard from/);
  assert.doesNotMatch(agentsPageSource, /<AgentCard/);
  assert.match(agentsPageSource, /import AgentFleetPanel from '\.\/agents\/AgentFleetPanel'/);
  assert.match(agentManagerPageSource, /function AgentStatusSummary/);
  assert.match(agentManagerPageSource, /title="Without a live runtime"/);
  assert.match(agentManagerPageSource, /<AgentStatusSummary agent=\{dashboardAgent\} \/>/);
  assert.match(agentManagerPageSource, />\s*Details\s*<\/Button>/);
});
