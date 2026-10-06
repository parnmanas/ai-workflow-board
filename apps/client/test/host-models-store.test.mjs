// src/cli/hostModels.ts — 모델 목록 스토어의 순수 규칙.
//
//   - withHostModelOption: the shared catalog replaces cached choices; no per-screen unions.
//   - isHostModelsStale: 재열거 시각이 없거나(구버전 매니저) STALE_MS 보다 오래됐으면 stale.

import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_MODELS_STALE_MS, isHostModelsStale, withHostModelOption, noteHostSessionModels, loadHostModels,
  refreshHostModels, hostModelsFor, hostModelLabelsFor, resetHostModelsStore } from '../src/cli/hostModels.ts';
import { api } from '../src/api.ts';

const modeOption = { config_id: 'mode', name: 'Approval', category: 'mode', type: 'select', current_value: 'ask', options: [{ value: 'ask', name: 'Ask' }] };

test('withHostModelOption replaces stale choices, names and order with the shared catalog', () => {
  const acp = { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'opencode/big-pickle', options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] };
  const merged = withHostModelOption([modeOption, acp], ['opencode-go/glm-5.3', 'opencode/big-pickle'], {
    'opencode-go/glm-5.3': 'GLM 5.3', 'opencode/big-pickle': 'Current Pickle',
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0], modeOption, '다른 옵션은 건드리지 않는다');
  assert.equal(merged[1].current_value, 'opencode/big-pickle', '현재값 유지');
  assert.deepEqual(merged[1].options, [
    { value: 'opencode-go/glm-5.3', name: 'GLM 5.3' },
    { value: 'opencode/big-pickle', name: 'Current Pickle' },
  ]);
  const narrowed = withHostModelOption([modeOption, acp], ['opencode-go/glm-5.3']);
  assert.deepEqual(narrowed[1].options.map((option) => option.value), ['opencode-go/glm-5.3'], 'retired cached choices are removed');
});

for (const operation of ['loadHostModels', 'refreshHostModels']) {
  for (const alreadyReported of [false, true]) {
    test(`${operation}: an older response cannot overwrite a ${alreadyReported ? 'repeated' : 'new'} live ACP report`, async (t) => {
      resetHostModelsStore();
      t.after(resetHostModelsStore);
      const report = [{ category: 'model', type: 'select', options: [
        { value: 'gpt-6.1-sol', name: '6.1 Sol' }, { value: 'gpt-6-astra', name: '6 Astra' },
      ] }];
      if (alreadyReported) noteHostSessionModels('cache-race', 'codex', report);
      let resolve;
      let started;
      const ready = new Promise((done) => { started = done; });
      t.mock.method(api, operation === 'loadHostModels' ? 'getHostModels' : 'refreshHostModels', () => {
        started(); return new Promise((done) => { resolve = done; });
      });
      const pending = (operation === 'loadHostModels' ? loadHostModels : refreshHostModels)('cache-race');
      await ready;
      noteHostSessionModels('cache-race', 'codex', report);
      resolve({ manager_agent_id: 'cache-race', models: { codex: ['retired'] }, labels: { codex: { retired: 'Old' } } });
      await pending;
      assert.deepEqual(hostModelsFor('cache-race', 'codex'), ['gpt-6.1-sol', 'gpt-6-astra']);
      assert.deepEqual(hostModelLabelsFor('cache-race', 'codex'), { 'gpt-6.1-sol': '6.1 Sol', 'gpt-6-astra': '6 Astra' });
    });
  }
}

test('withHostModelOption: model 옵션이 없으면 합성하고, 호스트 목록이 비면 아무것도 하지 않는다', () => {
  const synthesized = withHostModelOption([modeOption], ['opus', 'sonnet']);
  assert.equal(synthesized.length, 2);
  assert.equal(synthesized[1].config_id, 'model');
  assert.equal(synthesized[1].category, 'model');
  assert.deepEqual(synthesized[1].options.map((o) => o.value), ['opus', 'sonnet']);
  assert.deepEqual(withHostModelOption([modeOption], []), [modeOption]);
});

test('isHostModelsStale: 시각이 없거나 오래됐으면 stale', () => {
  const now = Date.parse('2026-09-26T00:00:00.000Z');
  const view = (refreshed_at) => ({ manager_agent_id: 'm', manager_name: 'm', is_online: true, instance_id: 'i', refreshed_at, models: {} });
  assert.equal(isHostModelsStale(null, now), true);
  assert.equal(isHostModelsStale(view(null), now), true, '구버전 매니저(시각 없음)는 stale 로 본다');
  assert.equal(isHostModelsStale(view('garbage'), now), true);
  assert.equal(isHostModelsStale(view(new Date(now - 1000).toISOString()), now), false);
  assert.equal(isHostModelsStale(view(new Date(now - HOST_MODELS_STALE_MS - 1).toISOString()), now), true);
});

test('effort reports match only the selected CLI/model; missing, empty and CLI default stay distinct', async () => {
  const { hostEffortReport } = await import('../src/cli/hostEfforts.ts');
  const reported = { model: 'm1', config_id: 'thinking', options: [{ value: 'high', label: 'High' }] };
  const absent = { model: 'm2', config_id: null, options: [] };
  const view = { effort_options: { cli: [reported, absent] } };
  assert.equal(hostEffortReport(view, 'cli', 'm1'), reported);
  assert.equal(hostEffortReport(view, 'cli', 'm2'), absent);
  assert.equal(hostEffortReport(view, 'cli', 'unknown'), null);
  assert.equal(hostEffortReport(view, 'cli', null), null);
  assert.equal(hostEffortReport(view, 'different-cli', 'm1'), null);
  assert.equal(hostEffortReport(null, 'cli', 'm1'), null);
});
