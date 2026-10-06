// Render the actual New session → session header flow. Compare every option's value,
// name and order, and keep the two lists equal after a live ACP update.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupDom, mount, React, act, click, typeInto } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { api } from '../src/api.ts';
import { cliCatalog } from '../src/cli/catalog.ts';
import { resetHostModelsStore } from '../src/cli/hostModels.ts';
import SessionsPage from '../src/components/sessions/SessionsPage.tsx';

const h = React.createElement;
const fixtures = {
  codex: [['gpt-6.1-sol', '6.1 Sol'], ['gpt-6-astra', '6 Astra'], ['gpt-6-sol', '6 Sol'],
    ['gpt-6-luna', '6 Luna'], ['gpt-5.6-sol', '5.6 Sol'], ['gpt-5.6-terra', '5.6 Terra'], ['gpt-5.6-luna', '5.6 Luna']],
  claude: [['default', 'Default (recommended)'], ['sonnet', 'Sonnet 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['opus', 'Opus 5.5'], ['haiku', 'Haiku 4.5']],
};
const choices = (select) => [...select.options].map((option) => [option.value, option.textContent]);
const modelSelect = (scope = document) => scope.querySelector('select[data-config-category="model"]');
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
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
    assert.equal(put.mock.calls[0].arguments[3].model, initialChoices.at(-1)[0]);
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
    click(button('New'));
    await settle();
    const nextDialog = document.querySelector('[role="dialog"]');
    assert.deepEqual(choices(modelSelect(nextDialog)), updatedHeader,
      'opening New after a live update must immediately show the same choices, labels and order');
    assert.ok(!updatedHeader.some(([id]) => id === 'retired-model'));
  });
}
