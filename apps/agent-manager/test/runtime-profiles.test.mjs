import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import {
  runtimeCredentialEnv,
  shutdownRuntimeProfiles,
  startRuntimeProfile,
  validateRuntimeProfile,
} from '../dist/lib/runtime-profiles.js';

const fixtureRoot = join(process.cwd(), '.test-claude-backend');
const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-awb-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: false, maxConcurrent: 2, ttlMinutes: 1 },
};

async function makeClaudeFixture(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(path, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  auth: process.env.ANTHROPIC_AUTH_TOKEN,
  model: process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null,
  anthropicModel: process.env.ANTHROPIC_MODEL,
  smallFastModel: process.env.ANTHROPIC_SMALL_FAST_MODEL,
  defaultHaiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  defaultSonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  defaultOpus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  defaultFable: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
  contextWindowEnv: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  maxOutputEnv: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  awb: process.env.AWB_API_KEY,
  response: process.env.REQUEST_THROUGH_ADAPTER
    ? await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          model: process.argv[process.argv.indexOf('--model') + 1],
          max_tokens: 32,
          messages: [{role: 'user', content: 'translate me'}]
        })
      }).then(r => r.json())
    : null
}));
process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'ok'}) + '\\n');
`);
  await chmod(path, 0o755);
  return path;
}

// ticket 41dc37cb 리뷰 라운드1 — 매번 동일하게 fallback-eligible 실패로
// 죽는 CLI. 재-spawn(모델 폴백)이 실제로 트리거되는지/안 되는지를
// SubagentManager.onExit 카운트로 관찰하는 테스트 전용.
async function makeAlwaysFailFixture(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(path, `#!/usr/bin/env node
process.stderr.write('unrecognized model\\n');
process.exit(1);
`);
  await chmod(path, 0o755);
  return path;
}

async function spawnFixture(profile, captureFile, extra = {}) {
  const manager = new SubagentManager(config);
  const exited = new Promise(resolve => { manager.onExit = resolve; });
  const result = await manager.spawn({
    kind: 'trigger',
    taskText: 'fixture task',
    rolePrompt: 'fixture role',
    triggerId: `trigger-${profile.id}`,
    ticketId: `ticket-${profile.id}`,
    agentId: 'agent-fixture',
    role: 'assignee',
    runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
    agentContext: {
      agent_id: 'agent-fixture',
      api_key: 'agent-awb-key',
      cwd: fixtureRoot,
      mcp_config_path: join(fixtureRoot, 'missing-mcp.json'),
      cli: 'claude',
      cli_home_dir: join(fixtureRoot, 'claude-home'),
      ...extra,
    },
  });
  assert.equal(result.spawned, true);
  await Promise.race([exited, delay(5_000).then(() => assert.fail('Claude fixture did not exit'))]);
  return JSON.parse(await readFile(captureFile, 'utf8'));
}

test.after(async () => {
  await shutdownRuntimeProfiles();
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('Anthropic-compatible profile launches the real Claude CLI path with endpoint/model and AWB lifecycle env', async () => {
  const executable = await makeClaudeFixture('claude-direct.mjs');
  const capture = await spawnFixture({
    id: 'direct-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40101',
    model: 'fixture-model-a',
    claude_executable: executable,
  }, join(fixtureRoot, 'direct.json'), { model: 'anthropic-agent-default' });
  assert.equal(capture.baseUrl, 'http://127.0.0.1:40101');
  // ticket 41dc37cb — raw profile.model 은 --model argv로 나가지 않는다
  // (CLI가 unrecognized_model 로 거부); CLI가 인식하는 기본 alias만 실린다.
  assert.equal(capture.model, 'sonnet');
  assert.equal(capture.awb, 'agent-awb-key');
  assert.ok(capture.argv.includes('--mcp-config'), 'AWB MCP config remains attached');
});

// ticket 41dc37cb — Claude Code CLI는 `--model`에 낯선 값이 오면 내부 보조
// 요청(generate_session_title 등)을 unrecognized_model 로 거부해 첫 턴부터
// 실패시킨다. profile.model(raw provider id, 예: vLLM served-model-name)이
// 그대로 argv에 실리면 안 되고, CLI가 스스로 인정하는 alias(기본값
// 'sonnet')가 실려야 한다 — 실제 백엔드 라우팅은 바로 아래 aux-call env
// 테스트가 검증하는 ANTHROPIC_DEFAULT_*_MODEL 오버라이드가 담당한다.
//
// round 2(운영 실측 재발) — round 1은 이 argv 불변식만 고치고 ANTHROPIC_MODEL/
// ANTHROPIC_SMALL_FAST_MODEL env는 그대로 raw profile.model로 남겨뒀다. 이
// 두 변수는 Claude Code 내부 보조 요청이 --model argv를 거치지 않고 직접
// 읽는 "모델 선택" 값이라, argv만 고쳐도 generate_session_title은 여전히
// unrecognized_model로 거부됐다(실제 vLLM 프로덕션에서 재현). 아래
// anthropicModel/smallFastModel 단언이 바로 그 재발을 잡는다.
test('Anthropic-compatible profile는 --model / ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL 그 어디에도 raw provider model id를 흘리지 않는다 (unrecognized_model 회귀)', async () => {
  const executable = await makeClaudeFixture('claude-alias-model.mjs');
  const capture = await spawnFixture({
    id: 'alias-model-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40106',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'alias-model.json'));
  assert.equal(capture.model, 'sonnet', '--model must carry a CLI-recognized alias, never the raw provider id');
  assert.equal(capture.anthropicModel, 'sonnet', 'ANTHROPIC_MODEL은 내부 보조 호출(예: generate_session_title)이 직접 읽는 값이라 이것도 alias여야 한다 — raw id면 안 된다');
  assert.equal(capture.smallFastModel, 'sonnet', 'ANTHROPIC_SMALL_FAST_MODEL도 ANTHROPIC_MODEL과 동일한 종류의 보조-호출 선택 변수다');
  assert.equal(capture.defaultSonnet, 'qwen3-coder-next', 'the sonnet-tier override still routes requests to the real backend model');
});

test('profile.model_alias overrides the default --model alias', async () => {
  const executable = await makeClaudeFixture('claude-custom-alias.mjs');
  const capture = await spawnFixture({
    id: 'custom-alias-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40107',
    model: 'qwen3-coder-next',
    model_alias: 'haiku',
    claude_executable: executable,
  }, join(fixtureRoot, 'custom-alias.json'));
  assert.equal(capture.model, 'haiku');
  // ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL도 'sonnet' 기본값이 아니라
  // --model과 동일하게 선택된 alias를 따라가야 한다 (ticket 41dc37cb round 2).
  assert.equal(capture.anthropicModel, 'haiku');
  assert.equal(capture.smallFastModel, 'haiku');
  assert.equal(capture.defaultHaiku, 'qwen3-coder-next');
});

// ticket 41dc37cb round 2 리뷰 지적 — CLAUDE_MODEL_ALIASES/model_alias 스키마는
// 'fable'을 정상 alias로 허용하지만, MODEL_OVERRIDE_ENV_KEYS에는 처음에
// opus/sonnet/haiku 3종만 있고 ANTHROPIC_DEFAULT_FABLE_MODEL이 빠져 있었다 —
// model_alias:'fable' profile은 selection env(ANTHROPIC_MODEL 등)에 'fable'이
// 실려도 실제 백엔드 모델로의 매핑이 보장되지 않는 상태였다. Claude Code 공식
// 문서(code.claude.com/docs/en/model-config, "Restrict model selection" 섹션)로
// ANTHROPIC_DEFAULT_FABLE_MODEL이 실재하는 공식 env var임을 확인하고
// MODEL_OVERRIDE_ENV_KEYS에 추가했다 — 이 테스트가 그 매핑을 직접 증명한다.
test('profile.model_alias: "fable"도 ANTHROPIC_DEFAULT_FABLE_MODEL로 실제 백엔드 모델에 매핑된다', async () => {
  const executable = await makeClaudeFixture('claude-fable-alias.mjs');
  const capture = await spawnFixture({
    id: 'fable-alias-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40108',
    model: 'qwen3-coder-next',
    model_alias: 'fable',
    claude_executable: executable,
  }, join(fixtureRoot, 'fable-alias.json'));
  assert.equal(capture.model, 'fable', '--model에는 raw id가 아니라 fable alias가 실려야 한다');
  assert.equal(capture.anthropicModel, 'fable', 'ANTHROPIC_MODEL도 동일하게 fable alias를 따라가야 한다');
  assert.equal(capture.defaultFable, 'qwen3-coder-next', 'ANTHROPIC_DEFAULT_FABLE_MODEL이 fable alias를 실제 백엔드 모델로 매핑해야 한다');
});

// ticket 41dc37cb 리뷰 라운드1 — 리뷰 지적: 최초 spawn은 alias를 쓰지만,
// 폴백-적격 실패(unrecognized_model 등) 후 exit 핸들러의 model-fallback
// 체인(ticket 61f4dd18)이 harness.fallback_models의 raw 값으로 재-spawn하면
// 바로 위 두 테스트가 지키는 불변식이 재시도 경로에서 깨진다 — 같은 endpoint에
// CLI가 검증한 적 없는 임의 문자열이 다시 --model로 실린다. resolveModelChain()
// (cli-adapters/base.ts, 단위 테스트는 cli-error-signatures.test.mjs)이 profile
// 활성화 시 harness.fallback_models를 통째로 무시해 체인 길이를 1로 고정하므로,
// 폴백 respawn 자체가 트리거되지 않는다 — 이 테스트는 실제
// SubagentManager.spawn()으로 그걸 end-to-end 증명한다: 첫 시도가
// fallback-eligible 실패로 죽어도 두 번째 프로세스는 절대 뜨지 않는다.
test('ticket 41dc37cb: a Claude backend profile session never retries with a different --model on a fallback-eligible death', async () => {
  const executable = await makeAlwaysFailFixture('claude-always-fail-fallback.mjs');
  const manager = new SubagentManager(config);
  let exitCount = 0;
  let resolveFirstExit;
  const firstExit = new Promise((resolve) => {
    resolveFirstExit = resolve;
  });
  manager.onExit = () => {
    exitCount += 1;
    if (exitCount === 1) resolveFirstExit();
  };
  const result = await manager.spawn({
    kind: 'trigger',
    taskText: 'fixture task',
    rolePrompt: 'fixture role',
    triggerId: 'trigger-fallback-suppress-a',
    ticketId: 'ticket-fallback-suppress-a',
    agentId: 'agent-fixture',
    role: 'assignee',
    runtimeProfile: {
      id: 'fallback-suppress-a',
      kind: 'claude-backend',
      protocol: 'anthropic-compatible',
      base_url: 'http://127.0.0.1:40109',
      model: 'qwen3-coder-next',
      claude_executable: executable,
    },
    // Not a CLI-recognized alias on purpose — proves it can never reach
    // --model, whether on attempt 1 (already covered above) or a fallback
    // retry (what this test guards).
    harness: { fallback_models: ['claude-opus-4-1-not-a-cli-alias'] },
    agentContext: {
      agent_id: 'agent-fixture',
      api_key: 'agent-awb-key',
      cwd: fixtureRoot,
      mcp_config_path: join(fixtureRoot, 'missing-mcp.json'),
      cli: 'claude',
      cli_home_dir: join(fixtureRoot, 'claude-home'),
    },
  });
  assert.equal(result.spawned, true);
  await Promise.race([
    firstExit,
    delay(5_000).then(() => assert.fail('fallback-suppression fixture did not exit')),
  ]);
  // A pre-fix build fires the second spawn synchronously inside the same
  // close-handler tick (attemptModel = the raw fallback string) — give it a
  // beat to land before asserting it never happened.
  await delay(500);
  assert.equal(
    exitCount,
    1,
    'a profile-bound session has exactly one model to retry with — the fallback chain must not extend past it',
  );
});

// ticket 7d8ea7c9 후속, ticket 41dc37cb round 2 로 세분화 — Claude Code 내부
// 보조 호출(세션 제목 생성 등)은 --model argv 를 거치지 않고 env 로 모델을
// 고른다. 하지만 그 env 는 두 종류로 나뉜다: ANTHROPIC_MODEL/
// ANTHROPIC_SMALL_FAST_MODEL 은 "지금 어떤 모델을 쓰는지" 자체를 CLI가
// 검증하는 선택 값이라 --model 과 동일한 alias 여야 하고(raw id를 넣으면
// round 1 수정 후에도 실측에서 unrecognized_model 이 재발했다),
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL 은 그 alias 를 실제 어떤
// 모델로 요청할지 매핑하는 공식 override 라 raw provider id 가 정답이다.
test('Anthropic-compatible profile: ANTHROPIC_MODEL/ANTHROPIC_SMALL_FAST_MODEL은 alias를 기본값으로, ANTHROPIC_DEFAULT_*_MODEL은 profile.model을 기본값으로 삼는다', async () => {
  const executable = await makeClaudeFixture('claude-aux-model.mjs');
  const capture = await spawnFixture({
    id: 'aux-model-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40102',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'aux-model.json'));
  assert.equal(capture.anthropicModel, 'sonnet', '모델 선택 변수는 CLI가 인식하는 alias여야 한다 — raw id이면 안 된다');
  assert.equal(capture.smallFastModel, 'sonnet', '모델 선택 변수는 CLI가 인식하는 alias여야 한다 — raw id이면 안 된다');
  assert.equal(capture.defaultHaiku, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultSonnet, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultOpus, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultFable, 'qwen3-coder-next', 'fable도 나머지 3종과 동일하게 방어적으로 override된다(선택된 alias가 아니어도)');
});

test('profile.env still overrides the default aux-call model env vars', async () => {
  const executable = await makeClaudeFixture('claude-aux-model-override.mjs');
  const capture = await spawnFixture({
    id: 'aux-model-override',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40103',
    model: 'qwen3-coder-next',
    claude_executable: executable,
    env: { ANTHROPIC_SMALL_FAST_MODEL: 'qwen3-coder-next-fast' },
  }, join(fixtureRoot, 'aux-model-override.json'));
  assert.equal(capture.anthropicModel, 'sonnet', 'profile.env로 unset — alias 기본값을 유지한다');
  assert.equal(capture.smallFastModel, 'qwen3-coder-next-fast', 'profile.env가 raw id라도 기본값을 이긴다');
});

// ticket 7d8ea7c9 후속(컨텍스트 윈도우 초과) — profile.context_window 이
// 설정되면 실제 spawn 된 자식 프로세스 env 에 CLAUDE_CODE_MAX_CONTEXT_TOKENS
// 와 동적으로 clamp 된 CLAUDE_CODE_MAX_OUTPUT_TOKENS 가 둘 다 실려야 한다.
test('profile.context_window 가 CLAUDE_CODE_MAX_CONTEXT_TOKENS 와 clamp 된 CLAUDE_CODE_MAX_OUTPUT_TOKENS 를 둘 다 주입한다', async () => {
  const executable = await makeClaudeFixture('claude-context-window.mjs');
  const capture = await spawnFixture({
    id: 'context-window-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40104',
    model: 'qwen3-coder-next',
    claude_executable: executable,
    context_window: 10_000,
    max_output_tokens: 5_000,
    safety_margin_tokens: 5_000,
  }, join(fixtureRoot, 'context-window.json'));
  assert.equal(capture.contextWindowEnv, '10000');
  // rolePrompt='fixture role' + taskText='fixture task'(각 12자)는 known-input
  // 추정치가 작게 나온다; 여기서는 context_window - safety_margin_tokens 가
  // max_output_tokens 와 정확히 같으므로, clamp 는 정확히 그 known-input 만큼만
  // 깎는다: effective = 5000 - knownInput.
  const knownInput = Math.ceil('fixture role'.length / 4) + Math.ceil('fixture task'.length / 4);
  assert.equal(Number(capture.maxOutputEnv), 5_000 - knownInput);
});

test('profile 에 context_window 없으면 → CLAUDE_CODE_MAX_CONTEXT_TOKENS/MAX_OUTPUT_TOKENS 없음 (회귀 안전)', async () => {
  const executable = await makeClaudeFixture('claude-no-context-window.mjs');
  const capture = await spawnFixture({
    id: 'no-context-window-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40105',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'no-context-window.json'));
  assert.equal(capture.contextWindowEnv, undefined);
  assert.equal(capture.maxOutputEnv, undefined);
});

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('OpenAI-compatible profile translates a representative Claude request through its declared adapter', async () => {
  const executable = await makeClaudeFixture('claude-adapter.mjs');
  const adapterPort = await unusedPort();
  let forwarded;
  const backend = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'openai-fixture',
      choices: [{ message: { role: 'assistant', content: 'translated response' } }],
    }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;

  const adapterExecutable = join(fixtureRoot, 'anthropic-openai-adapter.mjs');
  await writeFile(adapterExecutable, `#!/usr/bin/env node
import { createServer } from 'node:http';
createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200).end('ok');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/messages') {
    response.writeHead(404).end();
    return;
  }
  let text = '';
  for await (const chunk of request) text += chunk;
  const anthropic = JSON.parse(text);
  const upstream = await fetch(process.env.AWB_BACKEND_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      model: process.env.AWB_BACKEND_MODEL,
      messages: anthropic.messages,
      max_tokens: anthropic.max_tokens
    })
  }).then(r => r.json());
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(JSON.stringify({
    id: 'anthropic-adapter',
    type: 'message',
    role: 'assistant',
    content: [{type: 'text', text: upstream.choices[0].message.content}],
    model: anthropic.model,
    stop_reason: 'end_turn'
  }));
}).listen(Number(process.env.ADAPTER_PORT), '127.0.0.1');
`);
  await chmod(adapterExecutable, 0o755);

  try {
    const capture = await spawnFixture({
      id: 'openai-via-adapter',
      kind: 'claude-backend',
      protocol: 'openai-compatible',
      base_url: `http://127.0.0.1:${backendPort}/v1`,
      model: 'fixture-model-b',
      claude_executable: executable,
      env: { REQUEST_THROUGH_ADAPTER: '1' },
      adapter: {
        executable: adapterExecutable,
        env: { ADAPTER_PORT: String(adapterPort) },
        base_url: `http://127.0.0.1:${adapterPort}`,
        startup_timeout_ms: 10_000,
      },
    }, join(fixtureRoot, 'adapter.json'));
    assert.equal(capture.baseUrl, `http://127.0.0.1:${adapterPort}`);
    // ticket 41dc37cb — argv --model은 alias('sonnet')로 나가지만, adapter가
    // 실제로 백엔드에 전달하는 model(아래 forwarded)은 여전히 raw
    // profile.model(AWB_BACKEND_MODEL 경유) — 백엔드 라우팅은 회귀 없음.
    assert.equal(capture.model, 'sonnet');
    assert.equal(capture.auth, 'awb-local-adapter');
    assert.equal(capture.response.content[0].text, 'translated response');
    assert.deepEqual(forwarded, {
      model: 'fixture-model-b',
      messages: [{ role: 'user', content: 'translate me' }],
      max_tokens: 32,
    });
  } finally {
    await new Promise(resolve => backend.close(resolve));
  }
});

test('credential reference uses the declared auth env without exposing unrelated env', () => {
  const ref = '00000000-0000-4000-8000-000000000001';
  const profile = {
    id: 'secure',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'm',
    credential_ref: ref,
    auth_env: 'BACKEND_API_KEY',
  };
  assert.deepEqual(runtimeCredentialEnv(profile, ref, {
    BACKEND_API_KEY: 'selected',
    ANTHROPIC_API_KEY: 'must-not-leak',
  }), { BACKEND_API_KEY: 'selected' });
  assert.throws(
    () => runtimeCredentialEnv(profile, '00000000-0000-4000-8000-000000000002', { ANTHROPIC_API_KEY: 'x' }),
    /does not match/,
  );
});

test('OpenAI adapter credential binds OPENAI_API_KEY without requiring or exposing Anthropic env', () => {
  const ref = '00000000-0000-4000-8000-000000000003';
  const profile = {
    id: 'secure-openai-adapter',
    protocol: 'openai-compatible',
    base_url: 'http://127.0.0.1:1/v1',
    model: 'm',
    credential_ref: ref,
    credential_required: true,
    auth_env: 'OPENAI_API_KEY',
  };
  assert.deepEqual(
    runtimeCredentialEnv(profile, ref, { OPENAI_API_KEY: 'openai-only' }),
    { OPENAI_API_KEY: 'openai-only' },
  );
});

test('profile validation reports protocol and adapter mistakes', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'bad',
      protocol: 'openai-compatible',
      base_url: 'http://127.0.0.1:1',
      model: 'm',
    }),
    /adapter is required/,
  );
});

// ticket 41dc37cb
test('profile validation rejects an unrecognized model_alias', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'bad-alias',
      protocol: 'anthropic-compatible',
      base_url: 'http://127.0.0.1:1',
      model: 'm',
      model_alias: 'gpt-5',
    }),
    /model_alias must be one of/,
  );
});

test('profile validation accepts each known model_alias', () => {
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
    assert.doesNotThrow(() => validateRuntimeProfile({
      id: `alias-${alias}`,
      protocol: 'anthropic-compatible',
      base_url: 'http://127.0.0.1:1',
      model: 'm',
      model_alias: alias,
    }));
  }
});

test('non-Claude spawn ignores a workspace Claude profile including model, cwd, env, args, and credential contract', async () => {
  const binDir = join(fixtureRoot, 'npm');
  const originalCwd = join(fixtureRoot, 'codex-work');
  const profileCwd = join(fixtureRoot, 'claude-profile-work');
  const codexCliHome = join(fixtureRoot, 'codex-home-regression');
  const captureFile = join(fixtureRoot, 'codex-regression.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(originalCwd, { recursive: true });
  await mkdir(profileCwd, { recursive: true });
  await mkdir(codexCliHome, { recursive: true });
  await writeFile(
    join(codexCliHome, 'config.toml'),
    '[mcp_servers.awb]\nurl = "http://127.0.0.1:0/mcp"\n',
  );
  const executable = join(binDir, 'codex');
  const fixtureScript = process.platform === 'win32'
    ? join(binDir, 'codex-fixture.mjs')
    : executable;
  await writeFile(fixtureScript, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  profileEnv: process.env.CLAUDE_PROFILE_ONLY
}));
process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
`);
  if (process.platform === 'win32') {
    await writeFile(
      `${executable}.cmd`,
      `@echo off\r\n"${process.execPath}" "%~dp0codex-fixture.mjs" %*\r\n`,
    );
  } else {
    await chmod(executable, 0o755);
  }

  const previous = {
    PATH: process.env.PATH,
    CAPTURE_FILE: process.env.CAPTURE_FILE,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    CLAUDE_PROFILE_ONLY: process.env.CLAUDE_PROFILE_ONLY,
    CODEX_HOME: process.env.CODEX_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  const isolatedCodexHome = join(fixtureRoot, 'isolated-codex-home');
  await mkdir(isolatedCodexHome, { recursive: true });
  process.env.PATH = process.platform === 'win32'
    ? binDir
    : `${binDir}${delimiter}${previous.PATH ?? ''}`;
  process.env.CAPTURE_FILE = captureFile;
  process.env.CODEX_HOME = isolatedCodexHome;
  if (process.platform === 'win32') {
    process.env.APPDATA = fixtureRoot;
    process.env.LOCALAPPDATA = join(fixtureRoot, 'local-appdata');
  }
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAUDE_PROFILE_ONLY;
  try {
    // ticket ce65cf25: well-known install paths now resolve before a bare
    // PATH lookup, so a host with a real codex under e.g. ~/.npm-global/bin
    // would otherwise shadow this PATH-only fixture. Pin the fixture via the
    // new delegation.codexBin override instead — deterministic regardless of
    // what's actually installed on the runner.
    const manager = new SubagentManager({
      ...config,
      delegation: { ...config.delegation, codexBin: executable },
    });
    const exited = new Promise(resolve => { manager.onExit = resolve; });
    const result = await manager.spawn({
      kind: 'trigger',
      taskText: 'fixture task',
      rolePrompt: 'fixture role',
      triggerId: 'trigger-codex-regression',
      ticketId: '',
      agentId: 'agent-codex',
      runtimeProfile: {
        id: 'workspace-claude',
        kind: 'claude-backend',
        protocol: 'anthropic-compatible',
        base_url: 'http://127.0.0.1:49999',
        model: 'claude-profile-model',
        cwd: profileCwd,
        env: { CLAUDE_PROFILE_ONLY: 'must-not-appear' },
        args: ['--claude-profile-arg'],
        credential_required: true,
        credential_ref: 'missing-claude-credential',
      },
      agentContext: {
        agent_id: 'agent-codex',
        api_key: 'agent-awb-key',
        cwd: originalCwd,
        cli: 'codex',
        cli_home_dir: codexCliHome,
        model: 'original-codex-model',
      },
    });
    assert.equal(result.spawned, true);
    await Promise.race([exited, delay(5_000).then(() => assert.fail('Codex fixture did not exit'))]);
    const capture = JSON.parse(await readFile(captureFile, 'utf8'));
    assert.equal(capture.cwd, originalCwd);
    assert.equal(capture.baseUrl, undefined);
    assert.equal(capture.profileEnv, undefined);
    assert.ok(capture.argv.includes('original-codex-model'));
    assert.ok(!capture.argv.includes('claude-profile-model'));
    assert.ok(!capture.argv.includes('--claude-profile-arg'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('no profile keeps the Claude adapter argv and environment byte-for-byte unchanged', async () => {
  const executable = await makeClaudeFixture('claude-regression.mjs');
  const captureFile = join(fixtureRoot, 'regression.json');
  const previous = process.env.CAPTURE_FILE;
  process.env.CAPTURE_FILE = captureFile;
  try {
    const manager = new SubagentManager({
      ...config,
      delegation: { ...config.delegation, claudeBin: executable },
    });
    const exited = new Promise(resolve => { manager.onExit = resolve; });
    const result = await manager.spawn({
      kind: 'trigger',
      taskText: 'fixture task',
      rolePrompt: 'fixture role',
      triggerId: 'trigger-regression',
      ticketId: 'ticket-regression',
      agentId: 'agent-regression',
      role: 'assignee',
    });
    assert.equal(result.spawned, true);
    await exited;
    const capture = JSON.parse(await readFile(captureFile, 'utf8'));
    assert.equal(capture.baseUrl, process.env.ANTHROPIC_BASE_URL);
    assert.equal(capture.auth, process.env.ANTHROPIC_AUTH_TOKEN);
    assert.equal(capture.model, null);
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_FILE;
    else process.env.CAPTURE_FILE = previous;
  }
});
