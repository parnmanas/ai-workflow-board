import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, act, click, React } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { api } from '../src/api.ts';
import { cliCatalog } from '../src/cli/catalog.ts';
import HostsPage from '../src/components/HostsPage.tsx';

const host = {
  instance_id: 'instance-host', host_id: 'runtime-host', agent_id: 'legacy-manager',
  agent_name: 'Build host', hostname: 'machine', account_id: null,
  mode: 'manager', cli: 'mixed', cli_adapters: ['codex'], pid: 123,
  plugin_version: '1.0.0', started_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
  working_dirs: ['/legacy/agent-folder'], agent_ids: ['retired-agent'],
};
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);

async function renderHosts(t, { width = 1280, admin = true, entry = '/hosts' } = {}) {
  const dom = setupDom({ width });
  const previousStorage = globalThis.localStorage;
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  globalThis.localStorage = window.localStorage;
  localStorage.setItem('auth_token', 'hosts-test');
  const { uninstall } = installFakeEventSource();
  t.mock.method(api, 'getMe', async () => ({ id: 'u', status: 'active', resolved_permissions: admin ? ['admin.access'] : [], accounts: [{ id: 'w', name: 'Account' }] }));
  t.mock.method(api, 'getCliCatalog', async () => ({ clis: cliCatalog() }));
  const list = t.mock.method(api, 'listAgentManagerInstances', async () => [host]);
  const legacy = t.mock.method(api, 'getAgentManagerInstanceSubagents', async () => []);
  t.mock.method(api, 'getAgentManagerInstanceLogs', async () => []);
  t.mock.method(api, 'listPrivilegedCommands', async () => []);
  t.mock.method(api, 'listAgentTemplates', async () => []);
  t.mock.method(api, 'listTemplateHosts', async () => [{ id: host.host_id, name: host.agent_name, clis: ['codex'] }]);
  t.mock.method(api, 'listAgentManagerPairings', async () => []);
  let view;
  t.after(() => { view?.unmount(); uninstall(); dom.cleanup(); globalThis.localStorage = previousStorage; globalThis.Audio = previousAudio; });
  view = mount(React.createElement(MemoryRouter, { initialEntries: [entry] },
    React.createElement(AuthProvider, null,
      React.createElement(BoardStreamProvider, null,
        React.createElement(ToastProvider, null, React.createElement(HostsPage))))));
  await flush();
  await flush();
  return { view, list, legacy };
}

test('Hosts separates connection management from templates and ignores retired Agent metadata', async (t) => {
  const { view, legacy } = await renderHosts(t);
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Runtime Hosts');
  assert.equal(document.querySelector('[role="tabpanel"]').style.overflow, 'hidden');
  assert.equal(document.querySelector('h2').textContent, 'Build host');
  assert.ok(view.container.textContent.includes('runtime-host'));
  for (const retired of ['Working directories', '/legacy/agent-folder', 'Agent identities supervised', '이름 미확인', 'Status unavailable', 'Restart all agents', 'Agent details']) {
    assert.equal(view.container.textContent.includes(retired), false, retired);
  }
  assert.equal(legacy.mock.callCount(), 0);
  for (const label of ['Host 연결', 'Refresh models', '매니저 재시작']) assert.equal(Boolean(button(label)), true, label);
  click([...document.querySelectorAll('[role="tab"]')].find(node => node.textContent === 'Agent 템플릿'));
  await flush();
  assert.equal(document.querySelector('[role="tabpanel"]').style.overflow, 'auto');
  assert.equal(Boolean(button('Host 연결')), false);
  click(button('템플릿 등록'));
  assert.equal(document.querySelector('[role="dialog"] h2').textContent, 'Agent 템플릿 등록');
});

test('mobile Hosts returns from details to the Host list and pairing uses Host terminology', async (t) => {
  await renderHosts(t, { width: 390 });
  assert.equal(document.querySelector('[data-testid="runtime-hosts-list"]').parentElement.style.display, 'flex');
  click([...document.querySelectorAll('button')].find(node => node.textContent.includes('Build host')));
  assert.equal(document.querySelector('[data-testid="runtime-hosts-list"]').parentElement.style.display, 'none');
  click(button('← Host 목록'));
  assert.equal(document.querySelector('[data-testid="runtime-hosts-list"]').parentElement.style.display, 'flex');
  click(button('Host 연결'));
  await flush();
  assert.equal(document.querySelector('[role="dialog"] h2').textContent, 'Runtime Host 연결');
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes('Host 이름 (선택 사항)'));
});

test('Hosts retains its admin permission boundary even on the template URL', async (t) => {
  const { list } = await renderHosts(t, { admin: false, entry: '/hosts?tab=templates' });
  assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
  assert.ok(document.body.textContent.includes('관리자 권한이 필요합니다'));
  assert.equal(list.mock.callCount(), 0);
});

test('template tab can be opened directly without mounting the Runtime Hosts console', async (t) => {
  const { list } = await renderHosts(t, { entry: '/hosts?tab=templates' });
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Agent 템플릿');
  assert.equal(Boolean(button('템플릿 등록')), true);
  assert.equal(list.mock.callCount(), 0);
});
