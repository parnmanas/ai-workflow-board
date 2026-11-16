import { ui } from './helpers/i18n.mjs';
// Render the actual New session → session header flow. Compare every option's value,
// name and order, and keep the two lists equal after a live ACP update.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupDom, mount, React, act, click, typeInto } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { ConfirmProvider } from '../src/contexts/ConfirmContext.tsx';
import { api } from '../src/api.ts';
import { cliCatalog } from '../src/cli/catalog.ts';
import { resetHostModelsStore } from '../src/cli/hostModels.ts';
import SessionsPage, { SessionView } from '../src/components/sessions/SessionsPage.tsx';

const h = React.createElement;
const fixtures = {
  codex: [['gpt-6.1-sol', '6.1 Sol'], ['gpt-6-astra', '6 Astra'], ['gpt-6-sol', '6 Sol'],
    ['gpt-6-luna', '6 Luna'], ['gpt-5.6-sol', '5.6 Sol'], ['gpt-5.6-terra', '5.6 Terra'], ['gpt-5.6-luna', '5.6 Luna']],
  claude: [['default', 'Default (recommended)'], ['sonnet', 'Sonnet 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['opus', 'Opus 5.5'], ['haiku', 'Haiku 4.5']],
};
const choices = (select) => [...select.options].map((option) => [option.value, option.textContent]);
const modelSelect = (scope = document) => scope.querySelector('select[data-config-category="model"]');
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === ui(label));
const menuItem = (label) => [...document.querySelectorAll('.awb-session-menu-item')].find((node) => node.textContent.includes(ui(label)));
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
function change(select, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value').set.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

for (const [cli, initialChoices] of Object.entries(fixtures)) {
  test(`${cli}: New session and its live header have identical model IDs, names and order`, async (t) => {
    const dom = setupDom();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = window.localStorage;
    localStorage.setItem('auth_token', 'model-list-test');
    resetHostModelsStore();
    const { FakeEventSource, uninstall } = installFakeEventSource();
    const hostId = `models-${cli}`;
    const host = { manager_id: hostId, instance_id: 'instance', name: 'Host', hostname: 'machine', clis: [cli], cli_settings: {} };
    let catalogChoices = initialChoices;
    const config = (list) => [{ config_id: 'model', category: 'model', type: 'select', name: 'Model',
      current_value: list[0][0], options: list.map(([value, name]) => ({ value, name })) }];
    let live = { manager_id: hostId, manager_name: 'Host', cli, session_id: 'created', cwd: '/srv/app', title: '', status: 'ready',
      current_mode: null, available_modes: [], config_options: config(initialChoices), available_commands: [],
      pending_permissions: [], pending_elicitations: [], resume_supported: true, auth: null, last_error: null,
      updated_at: new Date().toISOString() };
    t.mock.method(api, 'getMe', async () => ({ id: 'u', status: 'active', role: 'admin', resolved_permissions: [], accounts: [{ id: 'account', name: 'Account' }] }));
    t.mock.method(api, 'getCliCatalog', async () => ({ clis: cliCatalog() }));
    t.mock.method(api, 'listAgentTemplates', async () => []);
    t.mock.method(api, 'listAgentSessionHosts', async () => [host]);
    t.mock.method(api, 'getVoiceConfig', async () => null);
    t.mock.method(api, 'listSessionProposals', async () => ({ proposals: [] }));
    t.mock.method(api, 'getHostModels', async () => ({ manager_agent_id: hostId, is_online: true, refreshed_at: new Date().toISOString(),
      models: { [cli]: catalogChoices.map(([id]) => id) }, labels: { [cli]: Object.fromEntries(catalogChoices) } }));
    t.mock.method(api, 'getHostCliSettings', async () => ({ manager_id: hostId, cli, supports_credential: true, credential: null,
      candidates: [], default_config: {}, known_config_options: config([['retired-model', 'Old cache'], ...initialChoices].reverse()) }));
    const put = t.mock.method(api, 'setHostCliSettings', async () => ({}));
    const open = t.mock.method(api, 'openHostSession', async () => live);
    t.mock.method(api, 'getHostSession', async () => ({ session: { session_id: live.session_id, cwd: live.cwd, title: '', cli }, live, events: [] }));
    const setModel = t.mock.method(api, 'setHostSessionConfigOption', async (_host, _cli, _session, id, value) => {
      assert.equal(id, 'model');
      assert.ok(catalogChoices.some(([model]) => model === value), `the adapter accepts ${value}`);
      live = { ...live, config_options: [{ ...live.config_options[0], current_value: value }], updated_at: new Date(Date.now() + 100).toISOString() };
      return live;
    });
    let view;
    t.after(() => { view?.unmount(); uninstall(); resetHostModelsStore(); dom.cleanup(); globalThis.localStorage = previousStorage; });
    view = mount(h(MemoryRouter, { initialEntries: ['/sessions?new=1'] }, h(AuthProvider, null,
      h(BoardStreamProvider, null, h(Routes, null,
        h(Route, { path: '/sessions', element: h(SessionsPage) }),
        h(Route, { path: '/sessions/:managerId/:cli/:sessionId', element: h(SessionsPage) }))))));
    await settle();
    const creationDialog = document.querySelector('[role="dialog"]');
    const before = choices(modelSelect(creationDialog));
    assert.deepEqual(before, cli === 'claude' ? initialChoices : [['', 'CLI default'], ...initialChoices]);
    change(modelSelect(document.querySelector('[role="dialog"]')), initialChoices.at(-1)[0]);
    typeInto(document.querySelector('input[placeholder="/path/to/repo"]'), '/srv/app');
    click(button('Start session'));
    await settle();
    assert.equal(open.mock.callCount(), 1, [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join('\n'));
    // 고른 모델은 이 세션에만 고정된다 — 호스트 기본값 저장은 사용자가 따로 골라야 한다.
    assert.equal(open.mock.calls[0].arguments[2].config_overrides.model, initialChoices.at(-1)[0]);
    assert.equal(put.mock.callCount(), 0, '세션 시작이 호스트 CLI 기본값을 덮어쓰면 안 된다');
    assert.deepEqual(choices(modelSelect()), before, 'the newly created header must be exactly equal to the creation selector');
    change(modelSelect(), initialChoices[1][0]);
    await settle();
    assert.equal(setModel.mock.callCount(), 1);

    // Remove retired models, change names, and reorder the live adapter's report.
    catalogChoices = [initialChoices.at(-1), [initialChoices[1][0], 'Updated label']];
    live = { ...live, config_options: config(catalogChoices), updated_at: new Date(Date.now() + 1000).toISOString() };
    act(() => FakeEventSource.instances.at(-1).emit('agent_session_update', { session: live }));
    await settle();
    const updatedHeader = choices(modelSelect());
    // 헤더에는 폴더·세션 id 가 없고, 햄버거 메뉴를 열어야 보인다. New 도 메뉴 안에 있다.
    const bar = document.querySelector('.awb-session-bar');
    assert.ok(bar.querySelector('.awb-session-controls select[data-config-category="model"]'), 'model stays in the header');
    assert.ok(!bar.textContent.includes('/srv/app'), 'the folder is not in the header bar');
    click(document.querySelector('button[aria-label="Session menu"]'));
    const panel = document.querySelector('.awb-session-menu-panel');
    assert.ok(panel.textContent.includes('/srv/app') && panel.textContent.includes('created'), 'folder and session id live in the menu');
    click(menuItem('New session'));
    await settle();
    const nextDialog = document.querySelector('[role="dialog"]');
    assert.deepEqual(choices(modelSelect(nextDialog)), updatedHeader,
      'opening New after a live update must immediately show the same choices, labels and order');
    assert.ok(!updatedHeader.some(([id]) => id === 'retired-model'));
  });
}

test('paged history preserves live arrivals and prepends without a scroll jump', async (t) => {
  const dom = setupDom();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  localStorage.setItem('auth_token', 'paged-history-test');
  const { FakeEventSource, uninstall } = installFakeEventSource();
  t.mock.method(api, 'getMe', async () => ({ id: 'u', status: 'active', role: 'admin', resolved_permissions: [], accounts: [{ id: 'account', name: 'Account' }] }));
  t.mock.method(api, 'getVoiceConfig', async () => null);
  t.mock.method(api, 'listSessionProposals', async () => ({ proposals: [] }));
  t.mock.method(api, 'getHostSessionUsageLimits', async () => ({ events: [] }));
  const live = { manager_id: 'host', manager_name: 'Host', cli: 'codex', session_id: 'paged', cwd: '/repo', title: 'Paged session',
    status: 'ready', config_options: [], available_modes: [], available_commands: [], current_mode: null,
    pending_permissions: [], pending_elicitations: [], auth: null, last_error: null, updated_at: new Date().toISOString() };
  const event = (id, text) => ({ id, seq: Number(id), type: 'text', turn_id: id, payload: { text }, created_at: new Date().toISOString() });
  const latest = event('3', 'Recent answer');
  const reads = [];
  t.mock.method(api, 'getHostSession', (_host, _cli, _session, before) => new Promise((resolve) => reads.push({ before, resolve })));
  const view = mount(h(MemoryRouter, null, h(AuthProvider, null, h(BoardStreamProvider, null,
    h(SessionView, { accountId: 'account', managerId: 'host', cli: 'codex', sessionId: 'paged', host: null, onNew() {} })))));
  t.after(() => { view.unmount(); uninstall(); dom.cleanup(); globalThis.localStorage = previousStorage; });
  await settle();
  const emit = (item) => act(() => FakeEventSource.instances.at(-1).emit('agent_session_event', {
    manager_id: 'host', cli: 'codex', session_id: 'paged', event: item,
  }));
  emit(event('4', 'Arrived during initial load'));
  await act(async () => reads[0].resolve({ session: { session_id: 'paged', cwd: '/repo', title: 'Paged session' }, live, events: [latest], next_before: '3' }));
  await settle();
  const transcript = view.container.querySelector('.awb-session-transcript');
  assert.match(transcript.textContent, /Recent answer/);
  assert.match(transcript.textContent, /Arrived during initial load/);
  const older = button('이전 기록 더 보기');
  click(older); click(older);
  assert.equal(reads.length, 2, 'two clicks must not create two page requests');
  assert.equal(reads[1].before, '3');
  emit(event('5', 'Arrived during older load'));
  await settle();
  Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => transcript.textContent.includes('Earlier answer') ? 1200 : 1000 });
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 });
  transcript.scrollTop = 10;
  await act(async () => reads[1].resolve({ session: null, live, events: [event('1', 'Earlier answer'), latest], next_before: null }));
  await settle();
  assert.equal((transcript.textContent.match(/Recent answer/g) ?? []).length, 1);
  assert.match(transcript.textContent, /Earlier answer[\s\S]*Recent answer[\s\S]*Arrived during initial load[\s\S]*Arrived during older load/);
  assert.equal(transcript.scrollTop, 210, 'prepend preserves the content the reader was looking at');
  assert.equal(button('이전 기록 더 보기'), undefined);
});

for (const choice of [
  { selector: 'select[aria-label="Session credential"]', value: 'second', patch: { credential_id: 'second' } },
  { selector: 'select[aria-label="Session backend"]', value: 'alternate', patch: { backend_profile_id: 'alternate' } },
  { selector: 'select[data-session-launch-option="__permission_mode"]', value: 'skip', patch: { config_overrides: { __permission_mode: 'skip' } } },
]) test(`session process settings confirm before applying ${Object.keys(choice.patch)[0]}`, async (t) => {
  const dom = setupDom();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  localStorage.setItem('auth_token', 'process-settings-test');
  const { uninstall } = installFakeEventSource();
  const host = { manager_id: 'host', instance_id: 'instance', name: 'Host', hostname: 'machine', clis: ['claude'] };
  const live = { manager_id: 'host', manager_name: 'Host', cli: 'claude', session_id: 'same-session', cwd: '/repo', title: 'Session',
    status: 'ready', config_options: [], available_modes: [], available_commands: [], auth: null, last_error: null, updated_at: new Date().toISOString() };
  const settings = { manager_id: 'host', cli: 'claude', session_id: 'same-session', revision: 'revision-1',
    supports_credential: true, credential_id: 'first', credential: { id: 'first', name: 'First', provider: 'claude_api_key' },
    candidates: [{ id: 'first', name: 'First', provider: 'claude_api_key' }, { id: 'second', name: 'Second', provider: 'claude_api_key' }],
    supports_backend: true, backend: null, backend_candidates: [{ id: 'alternate', name: 'Alternate' }],
    default_config: {}, known_config_options: [], launch_options: [{ config_id: '__permission_mode', name: 'Permissions', type: 'select',
      options: [{ value: 'skip', name: 'Skip' }] }] };
  t.mock.method(api, 'getMe', async () => ({ id: 'u', status: 'active', role: 'admin', resolved_permissions: [], accounts: [{ id: 'account', name: 'Account' }] }));
  t.mock.method(api, 'getVoiceConfig', async () => null);
  t.mock.method(api, 'listSessionProposals', async () => ({ proposals: [] }));
  t.mock.method(api, 'getHostSessionUsageLimits', async () => ({ events: [] }));
  t.mock.method(api, 'getHostSession', async () => ({ session: live, live, events: [] }));
  const reads = t.mock.method(api, 'getHostSessionSettings', async () => settings);
  const hostWrite = t.mock.method(api, 'setHostCliSettings', async () => { throw new Error('Must not change host settings'); });
  const restart = t.mock.method(api, 'restartHostSession', async () => ({ ...live, status: 'starting', updated_at: new Date(Date.now() + 1000).toISOString() }));
  const view = mount(h(MemoryRouter, null, h(AuthProvider, null, h(BoardStreamProvider, null, h(ConfirmProvider, null,
    h(SessionView, { accountId: 'account', managerId: 'host', cli: 'claude', sessionId: live.session_id, host, onNew() {} }))))));
  t.after(() => { view.unmount(); uninstall(); dom.cleanup(); globalThis.localStorage = previousStorage; });
  await settle();
  assert.equal(reads.mock.callCount(), 0, 'settings load only when the menu is opened');
  click(document.querySelector('button[aria-label="Session menu"]'));
  await settle();
  const previous = document.querySelector(choice.selector).value;
  change(document.querySelector(choice.selector), choice.value);
  await settle();
  assert.ok(document.querySelector('[role="dialog"]')?.textContent.includes(ui('Restart required')));
  assert.equal(restart.mock.callCount(), 0, 'selecting an option alone must not stop a running process');
  click(button('Cancel'));
  await settle();
  assert.equal(restart.mock.callCount(), 0);
  click(document.querySelector('button[aria-label="Session menu"]'));
  await settle();
  assert.equal(document.querySelector(choice.selector).value, previous, 'cancelling preserves the actual saved choice');
  change(document.querySelector(choice.selector), choice.value);
  await settle();
  click(button('Yes, restart'));
  await settle();
  assert.equal(restart.mock.callCount(), 1);
  assert.deepEqual(restart.mock.calls[0].arguments, ['host', 'claude', 'same-session', { ...choice.patch, expected_revision: 'revision-1' }]);
  assert.equal(hostWrite.mock.callCount(), 0);
});
