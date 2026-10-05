import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '../src/contexts/AuthContext.tsx';
import { LegacyWorkspaceRedirect } from '../src/App.tsx';
import { api, getActiveAccountId, setActiveAccountId } from '../src/api.ts';

const accounts = [
  { id: 'personal', name: 'Personal', slug: null, relations: ['owner'] },
  { id: 'organization', name: 'Organization', slug: null, relations: ['member'] },
];

test('multiple accounts do not block sign-in, and a bookmarked work URL cannot select credentials', async (t) => {
  const dom = setupDom({ url: 'http://localhost/ws/organization/sessions/host/codex/native' });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  localStorage.setItem('auth_token', 'token');
  setActiveAccountId(null);
  const originalGetMe = api.getMe;
  api.getMe = async () => ({ id: 'u1', name: 'User', status: 'active', accounts });
  let auth;
  function Probe() {
    auth = useAuth();
    return React.createElement('span', null, auth.isAuthenticated ? 'Ready' : 'Waiting');
  }
  const view = mount(React.createElement(AuthProvider, null, React.createElement(Probe)));
  t.after(() => { view.unmount(); api.getMe = originalGetMe; setActiveAccountId(null); dom.cleanup(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(auth.isAuthenticated, true);
  assert.equal(auth.currentAccountId, 'personal');
  assert.equal(auth.availableAccounts.length, 2);
  assert.equal(getActiveAccountId(), 'personal');
});

test('legacy workspace URLs keep resource ids, queries and fragments on canonical work routes', (t) => {
  const dom = setupDom();
  let location;
  function Probe() { location = useLocation(); return null; }
  const view = mount(React.createElement(MemoryRouter, {
    initialEntries: ['/ws/organization/orchestration/missions/mission-9?step=s1#evidence'],
  }, React.createElement(Routes, null,
    React.createElement(Route, { path: '/ws/:wsId/*', element: React.createElement(LegacyWorkspaceRedirect) }),
    React.createElement(Route, { path: '/missions/:missionId', element: React.createElement(Probe) }),
  )));
  t.after(() => { view.unmount(); dom.cleanup(); });
  assert.equal(location.pathname, '/missions/mission-9');
  assert.equal(location.search, '?step=s1');
  assert.equal(location.hash, '#evidence');
});

test('work lists request all accessible ownership accounts while creation keeps an explicit owner', async (t) => {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  localStorage.setItem('auth_token', 'token');
  setActiveAccountId('personal');
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = previous; setActiveAccountId(null); dom.cleanup(); });
  await api.listTickets('personal', { status: ['todo'] });
  await api.listProjects('personal');
  await api.listTicketTags('personal');
  await api.listOrchestrationTeams('personal');
  await api.listOrchestrationMissions('personal', { status: 'running' });
  await api.getUnreadMentions('personal');
  await api.markAllMentionsRead('personal');
  await api.listActions('personal');
  await api.listQaScenarios('personal');
  await api.listQaSchedules('personal');
  await api.listSecurityProfiles('personal');
  await api.listSecuritySchedules('personal');
  await api.listAutomationSchedules('personal');
  await api.searchChatMessages('personal', 'query');
  await api.createTicket('organization', { title: 'Task' });
  assert.deepEqual(calls.map(({ url }) => url), ['/api/tickets?status=todo', '/api/projects', '/api/ticket-tags', '/api/orchestration/teams', '/api/orchestration/missions?status=running', '/api/mentions/unread', '/api/mentions/read-all', '/api/actions', '/api/qa/scenarios', '/api/qa/schedules', '/api/security/profiles', '/api/security/schedules', '/api/automation-schedules', '/api/chat-rooms/search?q=query', '/api/tickets']);
  assert.equal(calls[14].init.headers['X-Account-Id'], 'organization');
  assert.deepEqual(JSON.parse(calls[14].init.body), { title: 'Task' });
});
