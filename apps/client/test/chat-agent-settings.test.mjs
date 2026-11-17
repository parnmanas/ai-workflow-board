import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, act, click, React } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '../src/contexts/ConfirmContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { api } from '../src/api.ts';
import { resetHostModelsStore } from '../src/cli/hostModels.ts';
import ChatAgentSettingsModal from '../src/components/chat/ChatAgentSettingsModal.tsx';

const h = React.createElement;
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label && !b.disabled);
const confirmButton = label => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const node = [...(dialog?.querySelectorAll('button') || [])].find(b => b.textContent === label && !b.disabled);
  assert.ok(node, `confirmation ${label}`);
  return node;
};
function change(selector, value) {
  const node = document.querySelector(selector);
  assert.ok(node, selector);
  act(() => { node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
function initial(over = {}) {
  return { participant_row_id: 'row', participant_id: 'rt-old', revision: 'revision-1', can_restart: true, host_name: 'Host', unavailable_reason: null,
    runtime: { manager_agent_id: 'host', cli: 'claude', model: 'model-a', working_dir: '/work', credential_id: null,
      cli_runtime_profile: null, role_prompt: '', label: 'writer', runtime_config: { strategy: 'single', permission_mode: 'strict', extra: { custom: true } } },
    connection_settings: { manager_id: 'host', cli: 'claude', supports_credential: true, credential: null,
      candidates: [{ id: 'cred-new', name: 'New account', provider: 'claude_api_key' }], supports_backend: true,
      backend: null, backend_candidates: [{ id: 'custom', name: 'Custom backend' }], default_config: {}, known_config_options: [] }, ...over };
}
async function fixture(t, value = initial()) {
  const dom = setupDom();
  const oldAudio = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} load() {} };
  resetHostModelsStore();
  t.mock.method(api, 'getHostModels', async () => ({ manager_agent_id: 'host', is_online: true, models: { claude: ['model-a', 'model-b'] }, refreshed_at: new Date().toISOString() }));
  const native = t.mock.method(api, 'getHostCliSettings', async () => { throw new Error('Native session permission is unavailable'); });
  let current = value;
  const read = t.mock.method(api, 'getChatAgentSettings', async () => current);
  const restart = t.mock.method(api, 'restartChatAgent', async (_room, _account, _row, _revision, patch) => {
    current = { ...current, revision: 'revision-2', runtime: { ...current.runtime, ...patch }, application: 'restarted' };
    return current;
  });
  const props = { roomId: 'room', accountId: 'account', rowId: 'row', name: 'Writer', onClose() {}, onChanged() {} };
  const wrap = visible => h(MemoryRouter, {}, h(ToastProvider, {}, h(ConfirmProvider, {}, visible ? h(ChatAgentSettingsModal, props) : null)));
  const view = mount(wrap(true));
  t.after(() => { view.unmount(); resetHostModelsStore(); globalThis.Audio = oldAudio; dom.cleanup(); });
  await flush();
  return { view, wrap, native, read, restart, setCurrent(next) { current = next; } };
}

test('changes stay local until confirmation; Cancel keeps the running agent and Yes sends one scoped update', async t => {
  const { native, restart } = await fixture(t);
  assert.equal(native.mock.callCount(), 0, 'chat authorization supplies public credential choices');
  assert.equal(document.querySelector('select[aria-label="CLI"]').disabled, true);
  change('select[aria-label="Session credential"]', 'cred-new');
  change('select[data-config-category="model"]', 'model-b');
  change('select[aria-label="Session backend"]', 'custom');
  click(button('Save settings')); await flush();
  assert.equal(restart.mock.callCount(), 0);
  click(confirmButton('Cancel')); await flush();
  assert.equal(restart.mock.callCount(), 0);
  assert.equal(document.querySelector('select[aria-label="Session credential"]').value, 'cred-new');
  click(button('Save settings')); await flush();
  click(confirmButton('Yes, restart')); await flush();
  assert.equal(restart.mock.callCount(), 1);
  const args = restart.mock.calls[0].arguments;
  assert.deepEqual(args.slice(0, 4), ['room', 'account', 'row', 'revision-1']);
  assert.equal(args[4].credential_id, 'cred-new');
  assert.equal(args[4].model, 'model-b');
  assert.equal(args[4].cli_runtime_profile, 'custom');
  assert.equal(args[4].runtime_config.extra.custom, true);
  assert.equal(args[4].manager_agent_id, undefined);
  assert.ok(button('Restart process'));
});

test('a failed host restart reloads the saved revision before a manual retry', async t => {
  const { read, restart, setCurrent } = await fixture(t);
  restart.mock.mockImplementationOnce(async () => {
    setCurrent(initial({ revision: 'saved-after-failure', runtime: { ...initial().runtime, credential_id: 'cred-new' } }));
    throw new Error('Settings saved, but restarting failed');
  });
  change('select[aria-label="Session credential"]', 'cred-new');
  click(button('Save settings')); await flush(); click(confirmButton('Yes, restart')); await flush();
  assert.match(document.querySelector('[role="alert"]').textContent, /restarting failed/);
  assert.equal(read.mock.callCount(), 2);
  click(button('Restart process')); await flush(); click(confirmButton('Yes, restart')); await flush();
  assert.deepEqual(restart.mock.calls[1].arguments.slice(3), ['saved-after-failure', {}]);
});

test('leaving the room while the confirmation is open cannot restart the old participant', async t => {
  const { view, wrap, restart } = await fixture(t);
  click(button('Restart process')); await flush();
  view.rerender(wrap(false));
  click(confirmButton('Yes, restart')); await flush();
  assert.equal(restart.mock.callCount(), 0);
});

test('offline or outdated hosts explain why settings cannot be applied', async t => {
  const { restart } = await fixture(t, initial({ can_restart: false, unavailable_reason: 'Update Agent Manager to change chat agent settings' }));
  assert.match(document.body.textContent, /Update Agent Manager/);
  assert.equal(document.querySelector('select[aria-label="Session credential"]').disabled, true);
  assert.equal(button('Restart process'), undefined);
  assert.equal(restart.mock.callCount(), 0);
});
