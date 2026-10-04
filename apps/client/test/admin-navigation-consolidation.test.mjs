import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sidebarSource, adminPageSource, agentManagerPageSource, appSource] = await Promise.all([
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AdminPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AgentManagerPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
]);

test('ADMIN navigation omits standalone QA, Column Policies, and Agent Manager items', () => {
  assert.doesNotMatch(sidebarSource, /label:\s*'QA Tests'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'Column Policies'/);
  assert.doesNotMatch(sidebarSource, /label:\s*'Agent Manager'/);
});

test('legacy Agent Manager URL redirects into workspace HOSTS management', () => {
  assert.match(
    adminPageSource,
    /path="agent-manager"[\s\S]*WorkspaceRouteRedirect path="hosts"/,
  );
  assert.doesNotMatch(adminPageSource, /path="qa"/);
  assert.doesNotMatch(adminPageSource, /path="column-policies"/);
});

test('HOSTS is reachable above Sessions and uses the guarded runtime management page', async () => {
  const hostsPage = await readFile(new URL('../src/components/HostsPage.tsx', import.meta.url), 'utf8');
  const nav = sidebarSource.slice(sidebarSource.indexOf('aria-label="Primary navigation"'));
  assert.match(nav, /canAdmin && renderNavItem\(\{[\s\S]*?path: `\$\{workspaceBase\}\/hosts`,[\s\S]*?label: 'HOSTS'/);
  assert.ok(nav.indexOf("label: 'HOSTS'") < nav.indexOf('sidebar-sessions-heading'));
  assert.match(appSource, /path="hosts" element=\{<HostsPage \/>\}/);
  assert.match(hostsPage, /hasPermission\('admin.access'\)/);
  assert.match(hostsPage, /canManage \? \([\s\S]*<AgentManagerPage \/>/);
});

// P4c-4: AgentsPage 삭제 (Agent 테이블 없음) — agents 경로는 세션으로
// 리다이렉트되고, 런타임 콘솔은 AgentManagerPage 에 남는다.
test('P4c-4: agents surface is gone — nav has no AI Agents item, route redirects to sessions', () => {
  assert.doesNotMatch(sidebarSource, /label:\s*'AI Agents'/);
  assert.match(
    appSource,
    /path="agents" element=\{<WorkspacedRedirect to="sessions" \/>\}/,
  );
});

test('runtime console survives on AgentManagerPage without the agent list', () => {
  assert.match(agentManagerPageSource, /function AgentStatusSummary/);
  assert.match(agentManagerPageSource, /title="Without a live runtime"/);
  assert.match(agentManagerPageSource, /<AgentStatusSummary agent=\{dashboardAgent\} \/>/);
});
