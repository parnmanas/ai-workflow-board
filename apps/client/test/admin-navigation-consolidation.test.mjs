import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sidebarSource, adminPageSource, agentsPageSource] = await Promise.all([
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/admin/AdminPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/AgentsPage.tsx', import.meta.url), 'utf8'),
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
  assert.match(agentsPageSource, /id="agent-manager-runtime"/);
  assert.match(agentsPageSource, /<AgentManagerPage \/>/);
});
