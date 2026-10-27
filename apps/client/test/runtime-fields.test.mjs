import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, act, click, React } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { api } from '../src/api.ts';
import { resetHostModelsStore, noteHostSessionModels } from '../src/cli/hostModels.ts';
import RuntimeSelectionFields from '../src/components/runtime/RuntimeSelectionFields.tsx';
import RuntimeSpecEditor, { emptyRuntimeSpec } from '../src/components/runtime/RuntimeSpecEditor.tsx';
import RuntimeOptionControl from '../src/components/runtime/RuntimeOptionControl.tsx';
import RuntimeConnectionFields from '../src/components/runtime/RuntimeConnectionFields.tsx';
import WorkingDirectoryField from '../src/components/runtime/WorkingDirectoryField.tsx';
import AgentTemplatesPanel from '../src/components/runtime/AgentTemplatesPanel.tsx';
import TeamSlotRuntimeFields, { emptySlotDraft, slotDraftToSpec } from '../src/components/orchestration/TeamSlotRuntimeFields.tsx';
import NewSessionModal from '../src/components/sessions/NewSessionModal.tsx';
import CliSettingsPanel from '../src/components/sessions/CliSettingsPanel.tsx';
import { BusinessWorkStartForm } from '../src/components/business/BusinessWorkExecution.tsx';

const h = React.createElement;
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
function change(node, value) {
  assert.ok(node);
  act(() => { node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
const hosts = [{ id: 'shared-host', name: 'Shared host', clis: ['codex', 'claude'] }, { id: 'second-host', name: 'Second', clis: ['codex'] }];
const model = { config_id: 'model', name: 'Model', type: 'select', category: 'model', current_value: 'model-z',
  options: [{ value: 'default', name: 'Recommended' }, { value: 'model-z', name: 'Z model' }, { value: 'model-a', name: 'A model' }] };
const settings = { manager_id: hosts[0].id, cli: 'codex', supports_credential: true, candidates: [], credential: null,
  supports_backend: false, backend: null, backend_candidates: [], default_config: { model: 'model-z' }, known_config_options: [model] };
const selection = { host_id: hosts[0].id, cli: 'codex', model: 'model-z', effort: null, runtime_config: { strategy: 'single', permission_mode: 'approve', extra: { custom_flag: true } } };
const spec = { ...emptyRuntimeSpec(), manager_agent_id: hosts[0].id, cli: 'codex', model: 'model-z', working_dir: '/work', runtime_config: selection.runtime_config };
const template = { ...selection, id: 'template', name: 'Reusable agent' };
function setup(t) {
  const dom = setupDom();
  const oldAudio = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} load() {} };
  resetHostModelsStore();
  t.mock.method(api, 'listAgentTemplates', async () => [template]);
  t.mock.method(api, 'listTemplateHosts', async () => hosts);
  t.mock.method(api, 'getHostModels', async () => ({ manager_agent_id: hosts[0].id, is_online: true,
    models: { codex: model.options.map(o => o.value) }, labels: { codex: Object.fromEntries(model.options.map(o => [o.value, o.name])) }, refreshed_at: new Date().toISOString() }));
  t.mock.method(api, 'getHostCliSettings', async () => settings);
  return () => { resetHostModelsStore(); globalThis.Audio = oldAudio; dom.cleanup(); };
}
const wrap = (node) => h(MemoryRouter, {}, h(ToastProvider, {}, node));
const optionsOf = () => [...document.querySelector('select[data-config-category="model"]').options].map(o => [o.value, o.textContent]);

test('Business, templates, team slots, custom execution, new sessions, defaults and live controls use identical model choices', async t => {
  const cleanup = setup(t);
  t.after(cleanup);
  const surfaces = [
    ['custom', h(RuntimeSelectionFields, { value: selection, hosts, onChange() {} })],
    ['spec', h(RuntimeSpecEditor, { value: spec, hosts, onChange() {}, showProjectFolderHelper: false })],
    ['business', h(BusinessWorkStartForm, { company: { id: 'company', account_id: 'account', agent_runtime: spec }, onClose() {}, onStarted() {} })],
    ['team', h(TeamSlotRuntimeFields, { value: { ...emptySlotDraft(), manager_agent_id: hosts[0].id, model: 'model-z', runtime: { runtime: 'codex', strategy: 'single', permissionMode: 'approve' } },
      hosts: [{ manager_agent_id: hosts[0].id, manager_name: 'Shared host', clis: ['codex'], available_models: { codex: ['wrong-model'] } }], credentials: [], backendProfiles: [], onChange() {} })],
    ['new session', h(NewSessionModal, { open: true, hosts: [{ manager_id: hosts[0].id, name: 'Shared host', clis: ['codex'] }], onClose() {}, onCreated() {} })],
    ['defaults', h(CliSettingsPanel, { accountId: 'account', managerId: hosts[0].id, cli: 'codex', hostName: 'Shared host' })],
    ['live', h(RuntimeOptionControl, { option: model, value: 'model-z', onChange() {} })],
    ['template', h(AgentTemplatesPanel)],
  ];
  for (const [name, node] of surfaces) {
    const view = mount(wrap(node));
    try {
      await flush();
      if (name === 'template') { click([...document.querySelectorAll('button')].find(b => b.textContent === 'Edit')); await flush(); }
      assert.deepEqual(optionsOf(), model.options.map(o => [o.value, o.name]), name);
    } finally { view.unmount(); }
  }
});

test('live catalog updates replace choices everywhere without erasing an existing saved model', async t => {
  const cleanup = setup(t);
  const view = mount(h(RuntimeSelectionFields, { value: selection, hosts, onChange() {} }));
  t.after(() => { view.unmount(); cleanup(); }); await flush();
  act(() => noteHostSessionModels(hosts[0].id, 'codex', [{ ...model, options: [{ value: 'new-model', name: 'New model' }] }]));
  assert.deepEqual(optionsOf().map(o => o[0]), ['', 'new-model', 'model-z']);
  assert.match(optionsOf()[2][1], /not listed by this host/);
  assert.equal(document.querySelector('select[data-config-category="model"]').value, 'model-z');
});

test('editing custom runtime options preserves extras; changing CLI or host clears incompatible choices', async t => {
  const cleanup = setup(t); let latest;
  function Editor() {
    const [value, setValue] = React.useState({ ...spec, credential_id: 'cred', cli_runtime_profile: 'backend' }); latest = value;
    return h(RuntimeSpecEditor, { value, hosts, onChange: setValue, showProjectFolderHelper: false });
  }
  const view = mount(h(Editor)); t.after(() => { view.unmount(); cleanup(); }); await flush();
  const permission = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'trusted'));
  change(permission, 'trusted');
  assert.equal(latest.runtime_config.extra.custom_flag, true);
  assert.equal(latest.runtime_config.permission_mode, 'trusted');
  change(document.querySelector('select[aria-label="CLI"]'), 'claude');
  assert.equal(latest.model, null); assert.equal(latest.credential_id, null); assert.equal(latest.cli_runtime_profile, null);
  assert.equal(latest.working_dir, '/work');
  change(document.querySelector('select[id$="-host"]'), hosts[1].id); await flush();
  assert.equal(latest.working_dir, ''); assert.equal(latest.cli, 'codex');
});

test('the shared folder browser uses the selected host and cannot retain a picker across host changes', async t => {
  const cleanup = setup(t); let latest = '';
  const roots = t.mock.method(api, 'getAgentFsRoots', async () => ({ roots: ['/work'], cwd: '/work/company', enabled: true }));
  t.mock.method(api, 'listAgentFs', async (host, path) => ({ path, entries: [], truncated: false }));
  const props = { hostId: hosts[0].id, value: '', onChange: value => { latest = value; } };
  const view = mount(h(WorkingDirectoryField, props)); t.after(() => { view.unmount(); cleanup(); });
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Browse…')); await flush();
  assert.equal(roots.mock.calls[0].arguments[0], hosts[0].id);
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Use this directory'));
  assert.equal(latest, '/work/company'); assert.equal(document.querySelector('[role="dialog"]') === null, true);
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Browse…')); await flush();
  view.rerender(h(WorkingDirectoryField, { ...props, hostId: hosts[1].id }));
  assert.equal(document.querySelector('[role="dialog"]') === null, true);
  view.rerender(h(WorkingDirectoryField, props)); assert.equal(document.querySelector('[role="dialog"]') === null, true);
  view.rerender(h(WorkingDirectoryField, { ...props, value: 'relative/path' }));
  assert.equal(document.querySelector('input').getAttribute('aria-invalid'), 'true');
  view.rerender(h(WorkingDirectoryField, { ...props, value: 'C:\\work\\company' }));
  assert.equal(document.querySelector('input').getAttribute('aria-invalid'), 'false');
});

test('all credential controls filter by CLI, preserve unavailable saved credentials and show scoped-load errors', async t => {
  const cleanup = setup(t);
  const credentials = [{ id: 'codex-key', name: 'Codex account', provider: 'codex_api_key' }, { id: 'claude-key', name: 'Claude account', provider: 'claude_api_key' }];
  const props = { hostId: hosts[0].id, cli: 'codex', credentialId: 'old-key', onCredentialChange() {}, credentials };
  const view = mount(h(RuntimeConnectionFields, props)); t.after(() => { view.unmount(); cleanup(); });
  const control = () => document.querySelector('select[aria-label="Session credential"]');
  assert.deepEqual([...control().options].map(o => o.value), ['', 'old-key', 'codex-key']);
  assert.equal(control().value, 'old-key');
  api.getHostCliSettings = async () => { throw new Error('Host settings unavailable'); };
  view.rerender(h(RuntimeConnectionFields, { ...props, credentials: undefined })); await flush();
  assert.match(document.querySelector('[role="alert"]').textContent, /Host settings unavailable/);
});


test('a team slot retains template-specific custom options through editing and serialization', async t => {
  const cleanup = setup(t); let latest;
  function Editor() {
    const [value, setValue] = React.useState(emptySlotDraft()); latest = value;
    return h(TeamSlotRuntimeFields, { value, onChange: setValue, credentials: [], backendProfiles: [],
      hosts: [{ manager_agent_id: hosts[0].id, manager_name: 'Shared host', clis: ['codex'] }] });
  }
  const view = mount(h(Editor)); t.after(() => { view.unmount(); cleanup(); }); await flush();
  change(document.querySelector('select[id$="-template"]'), template.id); await flush();
  change([...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'trusted')), 'trusted');
  assert.equal(slotDraftToSpec(latest).runtime_config.extra.custom_flag, true);
  assert.equal(slotDraftToSpec(latest).runtime_config.permission_mode, 'trusted');
  assert.equal(template.runtime_config.permission_mode, 'approve');
});
