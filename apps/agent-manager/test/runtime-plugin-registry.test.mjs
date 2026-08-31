import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimePluginRegistry } from '../dist/lib/runtime/composition/plugin-registry.js';
import { defineRuntimePlugin } from '../dist/lib/runtime/composition/plugin-manifest.js';
import { negotiateCapabilities } from '../dist/lib/runtime/application/negotiate-capabilities.js';
import { requestCapabilities } from '../dist/lib/runtime/domain/capabilities.js';

const base = { protocol: 'jsonl', session: 'oneshot', native_mcp: false, native_approvals: false, steering: false, cancellation: true, usage: 'none', collaboration: [], skill_delivery: ['prompt'] };

test('fixture 플러그인은 코어 수정 없이 등록·탐색·생성된다', () => {
  const adapter = { id: 'fixture' };
  const registry = new RuntimePluginRegistry().register(defineRuntimePlugin({
    id: 'fixture', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => adapter,
  })).seal();
  assert.deepEqual(registry.ids(), ['fixture']);
  assert.equal(registry.createCliAdapter('FIXTURE'), adapter);
  assert.equal(registry.descriptor('fixture').capabilities.session, 'oneshot');
});

test('중복 id와 transport factory 누락은 composition 시점에 거부된다', () => {
  const plugin = defineRuntimePlugin({ id: 'fixture', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}) });
  const registry = new RuntimePluginRegistry().register(plugin);
  assert.throws(() => registry.register(plugin), /Duplicate runtime plugin id/);
  assert.throws(() => new RuntimePluginRegistry().register(defineRuntimePlugin({ id: 'broken', transport: 'cli', capabilities: requestCapabilities(base) })), /requires createCliAdapter/);
});

test('미지원 option은 최종 adapter 경계 전에 제거된다', () => {
  const request = negotiateCapabilities({ prompt: 'hello', mode: 'oneshot', model: 'm', effort: 'high', sessionId: 's', mcpServers: ['awb'], streaming: true }, requestCapabilities(base));
  assert.equal(request.model, 'm');
  assert.equal(request.effort, undefined);
  assert.equal(request.sessionId, undefined);
  assert.equal(request.mcpServers, undefined);
  assert.equal(request.streaming, undefined);
  assert.deepEqual(request.omitted, ['effort', 'sessionId', 'mcpServers', 'streaming']);
});
