import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, act, typeInto, React } from './helpers/jsdom.mjs';
import { renderToStaticMarkup } from 'react-dom/server';
import RuntimeSelectionFields, { applyAgentTemplate } from '../src/components/runtime/RuntimeSelectionFields.tsx';

test('applying a template copies preferences without cwd or shared nested configuration', () => {
  const template = { id: 't', name: 'Code', host_id: 'h', cli: 'codex', model: 'm', effort: 'high', runtime_config: { strategy: 'single', permission_mode: 'approve', extra: { max_depth: 2 } }, working_dir: '/legacy' };
  const copied = applyAgentTemplate(template);
  assert.equal(copied.effort, 'high');
  assert.equal('working_dir' in copied, false);
  copied.runtime_config.extra.max_depth = 8;
  assert.equal(template.runtime_config.extra.max_depth, 2);
});

test('shared runtime selection renders host, CLI, model, effort and editable template selector', () => {
  const markup = renderToStaticMarkup(React.createElement(RuntimeSelectionFields, {
    value: { host_id: 'h', cli: 'codex', model: 'saved-model', effort: 'high', runtime_config: { strategy: 'single', permission_mode: 'approve' } },
    hosts: [{ id: 'h', name: 'Host', clis: ['codex'] }], onChange() {},
  }));
  for (const label of ['Agent template', 'Runtime Host', 'Model', 'Effort', 'saved-model']) assert.ok(markup.includes(label), label);
  assert.equal(markup.includes('Working dir'), false);
});

test('a saved template can be loaded and edited without changing the original', async (t) => {
  const { api } = await import('../src/api.ts');
  const dom = setupDom();
  const template = { id: 'saved', name: 'Review', host_id: 'template-host', cli: 'codex', model: 'saved-model', effort: 'high', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
  const originalList = api.listAgentTemplates;
  const originalModels = api.getHostModels;
  api.listAgentTemplates = async () => [template];
  api.getHostModels = async () => ({ models: ['saved-model'], labels: {}, available_models_at: new Date().toISOString() });
  let latest;
  function Form() {
    const [value, setValue] = React.useState({ host_id: '', cli: '', model: null, effort: null, runtime_config: { strategy: 'single', permission_mode: 'approve' } });
    latest = value;
    return React.createElement(RuntimeSelectionFields, { value, onChange: setValue, hosts: [{ id: 'template-host', name: 'Host', clis: ['codex'] }] });
  }
  let view;
  t.after(() => { view?.unmount(); api.listAgentTemplates = originalList; api.getHostModels = originalModels; dom.cleanup(); });
  view = mount(React.createElement(Form));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const picker = document.querySelector('select');
  act(() => { picker.value = 'saved'; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(latest.host_id, 'template-host');
  assert.equal(latest.model, 'saved-model');
  assert.equal(latest.effort, 'high');
  const effort = [...document.querySelectorAll('input')].find((input) => input.value === 'high');
  assert.ok(effort && !effort.disabled);
  typeInto(effort, 'medium');
  assert.equal(latest.effort, 'medium');
  assert.equal(template.effort, 'high');
});
