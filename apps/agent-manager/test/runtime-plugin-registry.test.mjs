import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { composeRuntime } from '../dist/lib/runtime/composition/compose-runtime.js';
import fixturePlugin from './fixtures/runtime-plugins/fixture-cli.mjs';
import fixtureLlmPlugin from './fixtures/runtime-plugins/fixture-llm.mjs';
import { RuntimePluginRegistry } from '../dist/lib/runtime/composition/plugin-registry.js';
import { RuntimeAdapterResolver } from '../dist/lib/runtime/composition/runtime-adapter-resolver.js';
import { defineRuntimePlugin } from '../dist/lib/runtime/composition/plugin-manifest.js';
import { negotiateCapabilities } from '../dist/lib/runtime/application/negotiate-capabilities.js';
import { requestCapabilities } from '../dist/lib/runtime/domain/capabilities.js';
import { createDefaultRuntimePorts } from '../dist/lib/runtime/adapters/infrastructure/default-runtime-ports.js';

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

test('별도 fixture manifest 등록만으로 실제 facade 실행이 되며 코어와 기존 adapter는 불변이다', () => {
  const protectedFiles = [
    '../src/lib/runtime/application/runtime-execution-facade.ts',
    '../src/lib/cli-adapters/claude.ts',
    '../src/lib/cli-adapters/codex.ts',
  ].map(path => new URL(path, import.meta.url));
  const digest = () => createHash('sha256').update(protectedFiles.map(file => readFileSync(file)).join('\0')).digest('hex');
  const before = digest();
  const runtime = composeRuntime([fixturePlugin]);
  const execution = runtime.facade.prepareOneshot('fixture', {
    rolePrompt: '제거될 system prompt', taskText: '실제 요청', mcpConfigPath: null, model: '제거될 모델', effort: 'high',
  });
  assert.deepEqual(execution.descriptor.args, ['run', '실제 요청']);
  assert.deepEqual(execution.request.omitted, ['model', 'effort', 'systemPrompt', 'streaming']);
  assert.equal(digest(), before);
});

test('Claude와 Codex normalized request는 capability 협상 뒤 최종 argv가 된다', () => {
  const { facade } = composeRuntime();
  const input = { rolePrompt: '시스템', taskText: '본문', mcpConfigPath: '/tmp/mcp.json', model: '모델', effort: 'high' };
  const claude = facade.prepareOneshot('claude', input);
  assert.ok(claude.descriptor.args.includes('--effort'));
  assert.ok(claude.descriptor.args.includes('high'));
  assert.ok(claude.descriptor.args.includes('--mcp-config'));
  const codex = facade.prepareOneshot('codex', input);
  assert.equal(codex.request.effort, undefined);
  assert.ok(codex.request.omitted.includes('effort'));
  assert.ok(!codex.descriptor.args.includes('--effort'));
  assert.deepEqual(codex.descriptor.args.slice(0, 3), ['exec', '--model', '모델']);
});

test('persistent·resume·title 요청도 동일 facade contract를 사용한다', () => {
  const { facade } = composeRuntime();
  for (const mode of ['persistent', 'resume']) {
    const execution = facade.prepareSession('claude', mode, {
      rolePrompt: '세션 시스템', mcpConfigPath: '/tmp/session-mcp.json', model: '모델', effort: 'high',
    }, 'thread-1');
    assert.equal(execution.request.mode, mode);
    assert.equal(execution.request.sessionId, 'thread-1');
    assert.ok(execution.descriptor.args.includes('--input-format'));
    assert.ok(execution.descriptor.args.includes('stream-json'));
  }
  const title = facade.prepareOneshot('claude', {
    rolePrompt: '제목 생성', taskText: 'generate_session_title', mcpConfigPath: null, effort: 'high',
  });
  assert.equal(title.request.mode, 'oneshot');
  assert.ok(title.descriptor.args.includes('generate_session_title'));
});

test('주입한 prompt·session·tool port 산출물이 모든 CLI 최종 argv를 바꾼다', () => {
  const basePorts = createDefaultRuntimePorts();
  const calls = [];
  const ports = {
    ...basePorts,
    prompt: { encode(request) { calls.push(`prompt:${request.mode}`); return request.prompt ? `전송:${request.prompt}` : ''; } },
    session: { sessionId(request) { calls.push(`session:${request.mode}`); return request.sessionId ? `세션:${request.sessionId}` : undefined; } },
    tools: { configure(request) { calls.push(`tools:${request.mode}`); return { mcpServers: request.mcpServers?.map(path => `${path}.주입`) }; } },
  };
  const { facade } = composeRuntime([], ports);
  const one = facade.prepareOneshot('claude', {
    rolePrompt: '역할', taskText: '본문', mcpConfigPath: '/tmp/one.json', effort: 'high',
  });
  assert.ok(one.descriptor.args.includes('전송:본문'));
  assert.ok(one.descriptor.args.includes('/tmp/one.json.주입'));

  for (const mode of ['persistent', 'resume']) {
    const session = facade.prepareSession('claude', mode, {
      rolePrompt: '역할', mcpConfigPath: '/tmp/session.json', effort: 'high',
    }, 'thread');
    assert.equal(session.request.sessionId, '세션:thread');
    assert.equal(session.spec.sessionId, '세션:thread');
    const lifecycleFlag = mode === 'resume' ? '--resume' : '--session-id';
    const lifecycleFlagIndex = session.descriptor.args.indexOf(lifecycleFlag);
    assert.notEqual(lifecycleFlagIndex, -1);
    assert.equal(session.descriptor.args[lifecycleFlagIndex + 1], '세션:thread');
    assert.ok(session.descriptor.args.includes('/tmp/session.json.주입'));
  }
  const title = facade.prepareOneshot('claude', {
    rolePrompt: '제목', taskText: 'generate_session_title', mcpConfigPath: null,
  });
  assert.ok(title.descriptor.args.includes('전송:generate_session_title'));
  assert.equal(calls.length, 12);
});

test('production facade의 공통 error/retry policy가 실패 뒤 두 번째 provider 실행을 구동한다', async () => {
  let attempts = 0;
  const retrying = defineRuntimePlugin({
    id: 'retrying-llm', transport: 'llm', capabilities: requestCapabilities(base),
    createLlmProvider: () => ({ async complete() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('일시 오류'), { code: 'temporary', retryable: true });
      return { text: '성공' };
    } }),
  });
  const result = await composeRuntime([retrying]).facade.complete('retrying-llm', { prompt: '본문', mode: 'oneshot' });
  assert.equal(result.text, '성공');
  assert.equal(attempts, 2);
});

test('LLM fixture도 manifest 등록만으로 capability 제거 후 최종 body를 받는다', async () => {
  const runtime = composeRuntime([fixtureLlmPlugin]);
  const result = await runtime.facade.complete('fixture-llm', {
    prompt: '본문', mode: 'oneshot', effort: 'high', systemPrompt: '제거', mcpServers: ['awb'], streaming: true,
  });
  const body = JSON.parse(result.text);
  assert.equal(body.prompt, '본문');
  assert.equal(body.effort, undefined);
  assert.equal(body.systemPrompt, undefined);
  assert.equal(body.mcpServers, undefined);
  assert.equal(body.streaming, undefined);
  assert.deepEqual(body.omitted, ['effort', 'systemPrompt', 'mcpServers', 'streaming']);
});

test('adapter resolver는 실행 소유자 안에서 plugin factory 결과를 재사용한다', () => {
  let creations = 0;
  const registry = new RuntimePluginRegistry().register(defineRuntimePlugin({
    id: 'fixture-cache',
    transport: 'cli',
    capabilities: requestCapabilities(base),
    createCliAdapter: () => {
      creations += 1;
      return {};
    },
  })).seal();
  const firstOwner = new RuntimeAdapterResolver(registry, createDefaultRuntimePorts());
  const secondOwner = new RuntimeAdapterResolver(registry, createDefaultRuntimePorts());

  assert.equal(firstOwner.resolve('FIXTURE-CACHE'), firstOwner.resolve('fixture-cache'));
  assert.notEqual(firstOwner.resolve('fixture-cache'), secondOwner.resolve('fixture-cache'));
  assert.equal(creations, 2);
});

test('중복 id와 transport factory 누락은 composition 시점에 거부된다', () => {
  const plugin = defineRuntimePlugin({ id: 'fixture', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}) });
  const registry = new RuntimePluginRegistry().register(plugin);
  assert.throws(() => registry.register(plugin), /Duplicate runtime plugin id/);
  assert.throws(() => new RuntimePluginRegistry().register(defineRuntimePlugin({ id: 'broken', transport: 'cli', capabilities: requestCapabilities(base) })), /requires createCliAdapter/);
  assert.throws(() => new RuntimePluginRegistry().register(defineRuntimePlugin({ id: 'broken-llm', transport: 'llm', capabilities: requestCapabilities(base) })), /createLlmProvider가 필요/);
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
