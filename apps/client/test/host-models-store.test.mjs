// src/cli/hostModels.ts — 모델 목록 스토어의 순수 규칙.
//
//   - withHostModelOption: ACP 가 보고한 model 옵션은 표시 이름·현재값을 지키고, 호스트만
//     아는 id 만 덧붙인다. 옵션이 없으면 합성한다. (서버 withModelFallback 과 같은 규칙)
//   - isHostModelsStale: 재열거 시각이 없거나(구버전 매니저) STALE_MS 보다 오래됐으면 stale.

import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_MODELS_STALE_MS, isHostModelsStale, withHostModelOption } from '../src/cli/hostModels.ts';

const modeOption = { config_id: 'mode', name: 'Approval', category: 'mode', type: 'select', current_value: 'ask', options: [{ value: 'ask', name: 'Ask' }] };

test('withHostModelOption: ACP 목록에 없는 호스트 모델만 덧붙이고 기존 항목은 그대로 둔다', () => {
  const acp = { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'opencode/big-pickle', options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] };
  const merged = withHostModelOption([modeOption, acp], ['opencode/big-pickle', 'opencode-go/glm-5.3']);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], modeOption, '다른 옵션은 건드리지 않는다');
  assert.equal(merged[1].current_value, 'opencode/big-pickle', '현재값 유지');
  assert.deepEqual(merged[1].options, [
    { value: 'opencode/big-pickle', name: 'Big Pickle' },
    { value: 'opencode-go/glm-5.3', name: 'opencode-go/glm-5.3' },
  ]);
  const same = withHostModelOption([modeOption, acp], ['opencode/big-pickle']);
  assert.deepEqual(same, [modeOption, acp], '덧붙일 것이 없으면 그대로');
});

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
