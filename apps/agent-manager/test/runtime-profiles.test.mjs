import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { resolveClaudeSessionId } from '../dist/lib/cli-adapters/claude.js';
import { cleanupOrphanSubagents } from '../dist/lib/orphan-cleanup.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import {
  applyClaudeRuntimeProfileEnvPolicy,
  resolveClaudeExecutionEffort,
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

test('Claude one-shot과 persistent spawn은 모두 공통 최종 effort 계약만 사용한다', async () => {
  for (const relativePath of [
    '../src/lib/subagent-manager.ts',
    '../src/lib/base-session-manager.ts',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.equal((source.match(/resolveClaudeExecutionEffort\(/g) ?? []).length, 2, relativePath);
    assert.equal(source.includes('.omit_effort'), false, relativePath);
  }
});

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
  effort: process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : null,
  effortLevelEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL,
  alwaysEnableEffortEnv: process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT,
  legacyEffortEnv: process.env.CLAUDE_EFFORT,
  anthropicModel: process.env.ANTHROPIC_MODEL,
  smallFastModel: process.env.ANTHROPIC_SMALL_FAST_MODEL,
  defaultHaiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  defaultSonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  defaultOpus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  defaultFable: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
  contextWindowEnv: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  maxOutputEnv: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  autoCompactWindowEnv: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
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
if (process.env.SIMULATE_AUX_FAILURE) {
  process.stderr.write('[claude-code:title_generation_failed] simulated auxiliary failure\\n');
}
// 부모가 spawn 반환값에 결과 관찰자를 연결할 시간을 보장한다.
await new Promise(resolve => setTimeout(resolve, 100));
process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'ok'}) + '\\n');
`);
  await chmod(path, 0o755);
  return path;
}

async function makePersistentClaudeFixture(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const sessionFlag = argv.includes('--resume') ? '--resume' : '--session-id';
const sessionId = argv[argv.indexOf(sessionFlag) + 1];
appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  type: 'spawn', pid: process.pid, argv, sessionId, at: Date.now()
}) + '\\n');
if (sessionFlag === '--session-id') {
  const projectDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fixture-workspace');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, sessionId + '.jsonl'), JSON.stringify({ type: 'user' }) + '\\n');
}
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (!line) continue;
    appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
      type: 'turn', pid: process.pid, body: JSON.parse(line), at: Date.now()
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
  }
});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
process.on('exit', () => appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  type: 'exit', pid: process.pid, at: Date.now()
}) + '\\n'));
`);
  await chmod(path, 0o755);
  return path;
}

function readJsonLines(path) {
  return readFile(path, 'utf8')
    .then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse))
    .catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
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
    effortPreset: extra.effortPreset,
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
  await withHangDeadline(exited, 'Claude fixture did not exit');
  return JSON.parse(await readFile(captureFile, 'utf8'));
}

async function spawnBaseSessionFixture(profile, captureFile, extra = {}) {
  const manager = new BaseSessionManager(config, {
    keyField: 'roomId',
    logTag: '[runtime-profile-base-fixture]',
    cfgPrefix: 'runtime-profile-base-fixture',
    kindLabel: 'chat_session',
  });
  const sess = await manager._spawnSession(
    `room-${profile.id}`,
    'fixture role',
    'fixture first turn',
    {
      onProgress: () => {},
      effortPreset: extra.effortPreset,
      runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
      agentContext: {
        agent_id: 'agent-base-fixture',
        api_key: 'agent-awb-key',
        cwd: fixtureRoot,
        mcp_config_path: join(fixtureRoot, 'missing-base-mcp.json'),
        cli: 'claude',
        cli_home_dir: join(fixtureRoot, 'claude-base-home'),
        model: 'anthropic-agent-default',
      },
    },
  );
  assert.ok(sess, 'BaseSessionManager fixture 세션이 생성되어야 한다');
  const result = new Promise(resolve => { sess.onResult = resolve; });
  const exited = once(sess.child, 'exit');
  const [captured, mainResult] = await Promise.all([
    withHangDeadline(
      exited.then(async () => JSON.parse(await readFile(captureFile, 'utf8'))),
      'BaseSessionManager Claude fixture가 종료되지 않았다',
    ),
    withHangDeadline(result, 'BaseSessionManager가 주 응답을 전달하지 않았다'),
  ]);
  return { capture: captured, mainResult };
}

/** fixture 서브프로세스가 끝나기를 기다리되, hang 이면 무한 대기 대신 실패시킨다.
 *
 *  상한은 **성능 단언이 아니라 hang 진단용**이다. 예전에는 5초였는데, 이 파일의
 *  테스트들은 실제 자식 프로세스를 띄우고 `node --test` 는 파일을
 *  `os.availableParallelism()` 만큼 동시에 돌린다 — 4-vCPU Windows 러너에서는
 *  정상 종료(측정 5172ms, 자식 exit code 0)가 그 상한을 그냥 넘겼다(main CI
 *  run 33705300976). 실제 소요보다 넉넉히 잡고, 승부가 나면 AbortController 로
 *  타이머를 취소한다 — 취소하지 않으면 `--test-force-exit` 없이 도는 로컬
 *  `npm test` 가 남은 타이머만큼 늦게 끝난다. */
const HANG_DEADLINE_MS = 30_000;

function withHangDeadline(promise, failureMessage) {
  const ac = new AbortController();
  return Promise.race([
    promise,
    delay(HANG_DEADLINE_MS, null, { signal: ac.signal }).then(() => assert.fail(failureMessage)),
  ]).finally(() => ac.abort());
}

async function waitFor(check, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail(failureMessage);
}

/**
 * 설치된 Claude Code 자체가 만드는 요청을 관찰하는 선택적 통합 검증이다.
 * fixture가 payload를 합성하면 원래 회귀를 숨길 수 있으므로, 이 경로에서는
 * 로컬 Anthropic endpoint가 실제 HTTP body를 수신한다.
 */
test('실제 Claude CLI 요청에서 disabled는 effort 0회, enabled는 정확히 1회 전송한다', {
  skip: !process.env.AWB_REAL_CLAUDE_EXECUTABLE
    && 'AWB_REAL_CLAUDE_EXECUTABLE을 지정하면 실제 Claude CLI 요청 경계를 검증합니다',
  timeout: 30_000,
}, async () => {
  const executable = process.env.AWB_REAL_CLAUDE_EXECUTABLE;
  assert.ok(executable);
  const upstreamBaseUrl = process.env.AWB_REAL_CLAUDE_UPSTREAM?.replace(/\/$/, '');
  const servedModel = process.env.AWB_REAL_CLAUDE_MODEL || 'qwen3-coder-next';
  await mkdir(fixtureRoot, { recursive: true });
  const requests = [];
  const observedUrls = [];
  const backend = createServer(async (request, response) => {
    observedUrls.push(`${request.method} ${request.url}`);
    if (request.method === 'POST' && request.url?.startsWith('/v1/messages/count_tokens')) {
      for await (const _chunk of request) { /* 요청 body를 소진한다. */ }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    requests.push({ url: request.url, body: JSON.parse(text) });
    if (upstreamBaseUrl) {
      const upstream = await fetch(`${upstreamBaseUrl}${request.url}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'integration-test-token',
          authorization: 'Bearer integration-test-token',
        },
        body: text,
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      response.end(await upstream.text());
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: servedModel,
      content: [{ type: 'text', text: requests.length === 1 ? '통합 응답' : '{"title":"통합 제목"}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address === 'object');

  const childEnv = applyClaudeRuntimeProfileEnvPolicy({
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: 'integration-test-token',
    ANTHROPIC_API_KEY: 'integration-test-token',
    ANTHROPIC_MODEL: servedModel,
    ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: servedModel,
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    CLAUDE_EFFORT: 'high',
  }, { id: '실제-cli-effort-생략', omit_effort: true });
  const child = spawn(executable, [
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ], { cwd: fixtureRoot, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.write(`${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '짧게 답해 주세요' }] },
  })}\n`);
  let enabledChild = null;

  try {
    const sdkRequest = await waitFor(
      () => requests.find(item => item.body?.output_config?.format === undefined),
      10_000,
      `일반 SDK 요청을 받지 못했습니다: urls=${observedUrls.join(',')} stdout=${stdout} stderr=${stderr}`,
    );
    assert.equal(sdkRequest.body.output_config?.effort, undefined);

    child.stdin.write(`${JSON.stringify({
      type: 'control_request',
      request_id: '통합-제목-요청',
      request: {
        subtype: 'generate_session_title',
        description: 'backend profile effort 비활성화 회귀를 수정한다',
        persist: false,
      },
    })}\n`);
    const titleRequest = await waitFor(
      () => requests.find(item => item.body?.output_config?.format !== undefined),
      10_000,
      `제목 생성 요청을 받지 못했습니다: urls=${observedUrls.join(',')} stdout=${stdout} stderr=${stderr}`,
    );
    assert.equal(titleRequest.body.output_config?.effort, undefined);

    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
    const requestBaseline = requests.length;
    enabledChild = spawn(executable, [
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--effort', 'low',
    ], {
      cwd: fixtureRoot,
      env: applyClaudeRuntimeProfileEnvPolicy({
        ...childEnv,
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
        CLAUDE_EFFORT: 'high',
      }, { id: '실제-cli-effort-활성', omit_effort: false }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    enabledChild.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '활성 effort로 답해 주세요' }] },
    })}\n`);
    const enabledSdkRequest = await waitFor(
      () => requests.slice(requestBaseline).find(item => item.body?.output_config?.format === undefined),
      10_000,
      '활성 effort 일반 SDK 요청을 받지 못했습니다',
    );
    assert.equal(enabledSdkRequest.body.output_config?.effort, 'low');
    assert.equal((JSON.stringify(enabledSdkRequest.body).match(/\"effort\"/g) ?? []).length, 1);

    enabledChild.stdin.write(`${JSON.stringify({
      type: 'control_request',
      request_id: '통합-제목-활성-요청',
      request: {
        subtype: 'generate_session_title',
        description: '활성 effort 전달을 검증한다',
        persist: false,
      },
    })}\n`);
    const enabledTitleRequest = await waitFor(
      () => requests.slice(requestBaseline).find(item => item.body?.output_config?.format !== undefined),
      10_000,
      '활성 effort 제목 요청을 받지 못했습니다',
    );
    assert.equal(enabledTitleRequest.body.output_config?.effort, 'low');
    assert.equal((JSON.stringify(enabledTitleRequest.body).match(/\"effort\"/g) ?? []).length, 1);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
    enabledChild?.kill('SIGTERM');
    if (enabledChild) await Promise.race([once(enabledChild, 'exit'), delay(2_000)]);
    await new Promise(resolve => backend.close(resolve));
  }
});

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
  // ticket 41dc37cb round 3 — claude-with-vllm.sh(운영 검증됨)는 --model을
  // 아예 넘기지 않는다; AWB도 Claude backend profile 세션에서 이 플래그를
  // 전혀 주입하지 않는다(alias든 raw id든).
  assert.equal(capture.model, null);
  assert.equal(capture.awb, 'agent-awb-key');
  assert.ok(capture.argv.includes('--mcp-config'), 'AWB MCP config remains attached');
});

test('Claude backend profile의 omit_effort 설정에 따라 실제 argv의 effort를 결정한다', async () => {
  const executable = await makeClaudeFixture('claude-effort-parity.mjs');
  const baseProfile = {
    id: 'effort-parity',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40110',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  };
  assert.equal(resolveClaudeExecutionEffort({ effort: 'high' }, { ...baseProfile, omit_effort: true }).effort, null);
  assert.equal(resolveClaudeExecutionEffort({ effort: 'high' }, { ...baseProfile, omit_effort: false }).effort, 'high');
  assert.equal(resolveClaudeExecutionEffort({ effort: 'high' }, null).effort, 'high');

  const enabled = await spawnFixture(
    {
      ...baseProfile,
      omit_effort: false,
      env: {
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
        CLAUDE_EFFORT: 'high',
      },
    },
    join(fixtureRoot, 'effort-enabled.json'),
    { effortPreset: { id: 'deep', claude: { effort: 'high' } } },
  );
  assert.equal(enabled.effort, 'high');
  assert.equal(enabled.effortLevelEnv, undefined);
  assert.equal(enabled.alwaysEnableEffortEnv, undefined);
  assert.equal(enabled.legacyEffortEnv, undefined);
  assert.equal(enabled.argv.filter(value => value === '--effort').length, 1);

  const unspecified = await spawnFixture(
    baseProfile,
    join(fixtureRoot, 'effort-unspecified.json'),
    { effortPreset: { id: 'deep', claude: { effort: 'medium' } } },
  );
  assert.equal(unspecified.effort, 'medium');

  const disabledWithoutPreset = await spawnFixture(
    { ...baseProfile, omit_effort: true },
    join(fixtureRoot, 'effort-disabled-without-preset.json'),
  );
  assert.equal(disabledWithoutPreset.effort, null);

  const disabledWithPreset = await spawnFixture({
    ...baseProfile,
    omit_effort: true,
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_EFFORT: 'high',
    },
  }, join(fixtureRoot, 'effort-disabled-with-preset.json'), {
    model: 'anthropic-agent-default',
    effortPreset: { id: 'deep', claude: { effort: 'high' } },
  });
  assert.equal(disabledWithPreset.effort, null);
  assert.equal(disabledWithPreset.effortLevelEnv, 'auto');
  assert.equal(disabledWithPreset.alwaysEnableEffortEnv, undefined);
  assert.equal(disabledWithPreset.legacyEffortEnv, undefined);
});

test('backend profile 환경 정책은 enabled 충돌 키를 제거하고 disabled 생략 제어를 고정하며 원본 환경을 변경하지 않는다', () => {
  const env = {
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
    CLAUDE_EFFORT: 'high',
    KEEP_ME: 'yes',
  };
  const profile = { id: 'env-policy', omit_effort: true };
  const sanitized = applyClaudeRuntimeProfileEnvPolicy(env, profile);

  assert.deepEqual(sanitized, { CLAUDE_CODE_EFFORT_LEVEL: 'auto', KEEP_ME: 'yes' });
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high', '호출자가 소유한 원본 환경은 변경하지 않는다');
  assert.deepEqual(applyClaudeRuntimeProfileEnvPolicy(env, { ...profile, omit_effort: false }), { KEEP_ME: 'yes' });
  assert.equal(applyClaudeRuntimeProfileEnvPolicy(env, null), env);
});

test('BaseSessionManager 채팅 spawn은 omit_effort 요청 정책과 haiku 보조 모델 매핑을 최종 자식에 적용한다', async () => {
  const executable = await makeClaudeFixture('claude-base-session-policy.mjs');
  const { capture } = await spawnBaseSessionFixture({
    id: 'base-session-policy',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40111',
    model: 'qwen3-coder-next',
    omit_effort: true,
    claude_executable: executable,
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_EFFORT: 'high',
    },
  }, join(fixtureRoot, 'base-session-policy.json'), {
    effortPreset: { id: 'deep', claude: { effort: 'high' } },
  });

  assert.equal(capture.effort, null);
  assert.equal(capture.effortLevelEnv, 'auto');
  assert.equal(capture.alwaysEnableEffortEnv, undefined);
  assert.equal(capture.legacyEffortEnv, undefined);
  assert.equal(capture.smallFastModel, 'haiku');
  assert.equal(capture.defaultHaiku, 'qwen3-coder-next');
  assert.deepEqual(capture.argv.slice(0, 2), [
    '--session-id',
    resolveClaudeSessionId('room-base-session-policy'),
  ]);
});

test('BaseSessionManager는 종료된 기존 Claude 대화를 동일 UUID의 --resume으로 재개한다', async () => {
  const executable = await makeClaudeFixture('claude-base-session-resume.mjs');
  const sessionKey = 'room-base-session-resume';
  const projectDir = join(fixtureRoot, 'claude-base-home', 'projects', '-fixture-workspace');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${resolveClaudeSessionId(sessionKey)}.jsonl`), '{"type":"user"}\n');

  const { capture } = await spawnBaseSessionFixture({
    id: 'base-session-resume',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40119',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'base-session-resume.json'));

  assert.deepEqual(capture.argv.slice(0, 2), [
    '--resume',
    resolveClaudeSessionId(sessionKey),
  ]);
});

test('Claude 세션은 최초 transcript 생성, 활성 stdin 후속 turn, 종료 후 동일 UUID resume 수명주기를 지킨다', async () => {
  const executable = await makePersistentClaudeFixture('claude-session-lifecycle.mjs');
  const captureFile = join(fixtureRoot, 'claude-session-lifecycle.jsonl');
  const cliHome = join(fixtureRoot, 'claude-lifecycle-home');
  const sessionKey = 'room-lifecycle|agent-fixture';
  const profile = {
    id: 'session-lifecycle', kind: 'claude-backend', protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40121', model: 'qwen3-coder-next', claude_executable: executable,
    env: { CAPTURE_FILE: captureFile },
  };
  const opts = {
    onProgress: () => {}, runtimeProfile: profile,
    agentContext: {
      agent_id: 'agent-fixture', api_key: 'agent-awb-key', cwd: fixtureRoot,
      mcp_config_path: join(fixtureRoot, 'missing-lifecycle-mcp.json'),
      cli: 'claude', cli_home_dir: cliHome, model: 'anthropic-agent-default',
    },
  };
  const firstManager = new BaseSessionManager(config, {
    keyField: 'roomId', logTag: '[claude-lifecycle]', cfgPrefix: 'claude-lifecycle-', kindLabel: 'chat_session',
  });
  const first = await firstManager._spawnSession(sessionKey, '역할', '첫 turn', opts);
  assert.ok(first);
  await waitFor(async () => (await readJsonLines(captureFile)).filter(e => e.type === 'turn').length === 1,
    5_000, '최초 turn이 fixture stdin에 도착하지 않았다');
  firstManager._sendFollowUp(first, '동시 후속 turn A', { onProgress: () => {} });
  firstManager._sendFollowUp(first, '동시 후속 turn B', { onProgress: () => {} });
  await waitFor(async () => (await readJsonLines(captureFile)).filter(e => e.type === 'turn').length === 3,
    5_000, '활성 프로세스가 후속 turn을 직렬로 받지 못했다');
  const activeEvents = await readJsonLines(captureFile);
  assert.equal(activeEvents.filter(e => e.type === 'spawn').length, 1, '같은 room의 활성 turn은 새 프로세스를 만들면 안 된다');
  assert.equal(new Set(activeEvents.filter(e => e.type === 'turn').map(e => e.pid)).size, 1);
  const sessionId = resolveClaudeSessionId(sessionKey);
  assert.deepEqual(activeEvents[0].argv.slice(0, 2), ['--session-id', sessionId]);

  assert.ok(first.pidPath, '실제 session manager spawn이 PID sidecar를 만들어야 한다');
  assert.ok(first.configPath, '실제 session manager spawn이 MCP config sidecar를 만들어야 한다');
  const orphanDir = join(fixtureRoot, 'orphan-restart-scan');
  await mkdir(orphanDir, { recursive: true });
  const orphanPidPath = join(orphanDir, 'claude-session.pid');
  await copyFile(first.pidPath, orphanPidPath);
  await copyFile(first.configPath, join(orphanDir, 'claude-session.json'));
  const firstExit = once(first.child, 'exit');
  const cleanup = await cleanupOrphanSubagents(orphanDir, false);
  assert.ok(cleanup.reaped >= 1, 'manager 재시작 orphan 회수가 이전 Claude 프로세스를 정리해야 한다');
  await firstExit;
  assert.notEqual(first.child.exitCode, null, '이전 Claude 프로세스의 종료가 확인돼야 한다');

  const restartedManager = new BaseSessionManager(config, {
    keyField: 'roomId', logTag: '[claude-lifecycle-restart]', cfgPrefix: 'claude-lifecycle-restart-', kindLabel: 'chat_session',
  });
  const resumed = await restartedManager._spawnSession(sessionKey, '역할', '재시작 후 turn', opts);
  assert.ok(resumed);
  await waitFor(async () => (await readJsonLines(captureFile)).filter(e => e.type === 'spawn').length === 2,
    5_000, 'manager 재시작 뒤 resume 프로세스가 생성되지 않았다');
  const events = await readJsonLines(captureFile);
  const spawns = events.filter(e => e.type === 'spawn');
  assert.deepEqual(spawns[1].argv.slice(0, 2), ['--resume', sessionId]);
  assert.notEqual(first.child.exitCode, null, '이전 프로세스 종료 확인 전에 같은 UUID를 resume하면 안 된다');

  const otherKey = 'room-isolated|agent-fixture';
  const other = await restartedManager._spawnSession(otherKey, '역할', '다른 room turn', opts);
  assert.ok(other);
  await waitFor(async () => (await readJsonLines(captureFile)).filter(e => e.type === 'spawn').length === 3,
    5_000, '다른 room 프로세스가 생성되지 않았다');
  const isolatedSpawn = (await readJsonLines(captureFile)).filter(e => e.type === 'spawn')[2];
  assert.deepEqual(isolatedSpawn.argv.slice(0, 2), ['--session-id', resolveClaudeSessionId(otherKey)]);
  assert.notEqual(isolatedSpawn.sessionId, sessionId);
  const resumedExit = once(resumed.child, 'exit');
  const otherExit = once(other.child, 'exit');
  resumed.child.stdin.end();
  other.child.stdin.end();
  await Promise.all([resumedExit, otherExit]);
});

test('BaseSessionManager enabled profile은 충돌 env를 제거하고 preset effort를 argv에 한 번만 적용한다', async () => {
  const executable = await makeClaudeFixture('claude-base-session-enabled-effort.mjs');
  const { capture } = await spawnBaseSessionFixture({
    id: 'base-session-enabled-effort',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40114',
    model: 'qwen3-coder-next',
    omit_effort: false,
    claude_executable: executable,
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_EFFORT: 'high',
    },
  }, join(fixtureRoot, 'base-session-enabled-effort.json'), {
    effortPreset: { id: 'quick', claude: { effort: 'low' } },
  });

  assert.equal(capture.effort, 'low');
  assert.equal(capture.effortLevelEnv, undefined);
  assert.equal(capture.alwaysEnableEffortEnv, undefined);
  assert.equal(capture.legacyEffortEnv, undefined);
  assert.equal(capture.argv.filter(value => value === '--effort').length, 1);
});

test('BaseSessionManager는 보조 요청 실패 stderr 뒤의 주 응답 result를 계속 전달한다', async () => {
  const executable = await makeClaudeFixture('claude-base-session-aux-failure.mjs');
  const { mainResult } = await spawnBaseSessionFixture({
    id: 'base-session-aux-failure',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40112',
    model: 'qwen3-coder-next',
    omit_effort: true,
    claude_executable: executable,
    env: { SIMULATE_AUX_FAILURE: '1' },
  }, join(fixtureRoot, 'base-session-aux-failure.json'));

  assert.equal(mainResult.type, 'result');
  assert.equal(mainResult.subtype, 'success');
  assert.equal(mainResult.result, 'ok');
});

// ticket 41dc37cb round 3 — round 1/2는 --model/ANTHROPIC_MODEL/
// ANTHROPIC_SMALL_FAST_MODEL에 CLI가 인식하는 alias를 실어 unrecognized_model
// 회귀를 막으려 했으나, 그 alias 간접화 자체가 운영에서 실제 채팅 성공을
// 막았다 — 재오픈 사유. 운영에서 정상 동작이 검증된
// /home/parn/.local/bin/claude-with-vllm.sh 기준으로 재작성: alias를 전혀
// 쓰지 않고 ANTHROPIC_MODEL에 raw served model을 그대로 노출한다.
// 주 요청의 raw 라우팅은 유지하되, 제목 생성 같은 보조 요청이 raw 모델을
// 직접 검증하지 않도록 ANTHROPIC_SMALL_FAST_MODEL에는 tier alias를 싣는다.
test('Anthropic-compatible profile: 주 요청은 raw served model, 보조 요청은 haiku alias로 선택한다', async () => {
  const executable = await makeClaudeFixture('claude-raw-model.mjs');
  const capture = await spawnFixture({
    id: 'raw-model-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40106',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'raw-model.json'));
  assert.equal(capture.model, null, '--model은 alias든 raw id든 전혀 실리지 않는다');
  assert.equal(capture.anthropicModel, 'qwen3-coder-next', 'ANTHROPIC_MODEL은 claude-with-vllm.sh와 동일하게 raw served model이어야 한다');
  assert.equal(capture.smallFastModel, 'haiku', '보조 요청은 Claude CLI가 인식하는 tier alias를 선택해야 한다');
  assert.equal(capture.defaultSonnet, 'qwen3-coder-next', 'ANTHROPIC_DEFAULT_SONNET_MODEL도 동일한 raw served model로 매핑된다');
});

// ticket 41dc37cb 리뷰 라운드1 — 리뷰 지적: 최초 spawn은 --model을 전혀 싣지
// 않지만, 폴백-적격 실패(unrecognized_model 등) 후 exit 핸들러의
// model-fallback 체인(ticket 61f4dd18)이 harness.fallback_models의 raw
// 값으로 재-spawn하면 바로 위 테스트가 지키는 불변식이 재시도 경로에서
// 깨진다 — 같은 endpoint에 CLI가 검증한 적 없는 임의 문자열이 --model로
// 실린다. resolveModelChain()
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
    // 일부러 board-설정 임의 문자열을 사용 — 첫 시도(위에서 이미 확인,
    // --model 자체가 완전히 생략됨)든 폴백 재시도(이 테스트가 지키는
    // 대상)든 --model에 절대 도달하지 않음을 증명한다.
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
  await withHangDeadline(firstExit, 'fallback-suppression fixture did not exit');
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

// ticket 7d8ea7c9 후속, ticket 41dc37cb round 3 로 세분화 — Claude Code 내부
// 보조 호출(세션 제목 생성 등)은 --model argv 를 거치지 않고 env 로 모델을
// 고른다. claude-with-vllm.sh 기준으로는 ANTHROPIC_MODEL 과
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL은 raw provider model id로
// 라우팅하되, 보조 요청 선택 키만 CLI가 인식하는 haiku alias를 사용한다.
test('Anthropic-compatible profile: ANTHROPIC_MODEL과 ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL 모두 profile.model(raw)을 기본값으로 삼는다', async () => {
  const executable = await makeClaudeFixture('claude-aux-model.mjs');
  const capture = await spawnFixture({
    id: 'aux-model-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40102',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'aux-model.json'));
  assert.equal(capture.anthropicModel, 'qwen3-coder-next', 'ANTHROPIC_MODEL은 raw served model이어야 한다 — alias가 아니다');
  assert.equal(capture.smallFastModel, 'haiku', '보조 요청 선택 키는 CLI가 인식하는 alias여야 한다');
  assert.equal(capture.defaultHaiku, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultSonnet, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultOpus, 'qwen3-coder-next', 'override 변수는 어떤 tier가 선택되든 동일한 백엔드 모델로 라우팅한다');
  assert.equal(capture.defaultFable, undefined, 'ANTHROPIC_DEFAULT_FABLE_MODEL은 claude-with-vllm.sh가 설정하지 않으므로 round 3에서 제거됐다');
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
  assert.equal(capture.anthropicModel, 'qwen3-coder-next', '이 테스트는 ANTHROPIC_MODEL을 건드리지 않으므로 raw 기본값을 유지한다');
  assert.equal(capture.smallFastModel, 'qwen3-coder-next-fast', 'profile.env는 기본 주입 대상이 아닌 키도 추가할 수 있다');
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

// ticket 41dc37cb round 3 — claude-with-vllm.sh(운영 검증됨)가 설정하는
// CLAUDE_CODE_AUTO_COMPACT_WINDOW를 profile.auto_compact_window로부터
// 그대로 주입한다.
test('profile.auto_compact_window 가 CLAUDE_CODE_AUTO_COMPACT_WINDOW 를 주입한다', async () => {
  const executable = await makeClaudeFixture('claude-auto-compact-window.mjs');
  const capture = await spawnFixture({
    id: 'auto-compact-window-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40110',
    model: 'qwen3-coder-next',
    claude_executable: executable,
    context_window: 262_144,
    auto_compact_window: 235_000,
  }, join(fixtureRoot, 'auto-compact-window.json'));
  assert.equal(capture.contextWindowEnv, '262144');
  assert.equal(capture.autoCompactWindowEnv, '235000');
});

test('profile 에 auto_compact_window 없으면 → CLAUDE_CODE_AUTO_COMPACT_WINDOW 없음 (회귀 안전)', async () => {
  const executable = await makeClaudeFixture('claude-no-auto-compact-window.mjs');
  const capture = await spawnFixture({
    id: 'no-auto-compact-window-a',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:40111',
    model: 'qwen3-coder-next',
    claude_executable: executable,
  }, join(fixtureRoot, 'no-auto-compact-window.json'));
  assert.equal(capture.autoCompactWindowEnv, undefined);
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
    // ticket 41dc37cb round 3 — argv --model은 전혀 나가지 않지만, adapter가
    // 실제로 백엔드에 전달하는 model(아래 forwarded)은 여전히 raw
    // profile.model(AWB_BACKEND_MODEL 경유) — 백엔드 라우팅은 회귀 없음.
    assert.equal(capture.model, null);
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

// ticket 41dc37cb round 3
test('profile validation rejects a non-positive-integer auto_compact_window', () => {
  assert.throws(
    () => validateRuntimeProfile({
      id: 'bad-auto-compact',
      protocol: 'anthropic-compatible',
      base_url: 'http://127.0.0.1:1',
      model: 'm',
      auto_compact_window: -1,
    }),
    /auto_compact_window must be a positive integer/,
  );
});

test('profile validation accepts a positive-integer auto_compact_window', () => {
  assert.doesNotThrow(() => validateRuntimeProfile({
    id: 'good-auto-compact',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'm',
    auto_compact_window: 235_000,
  }));
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
      delegation: {
        ...config.delegation,
        codexBin: process.platform === 'win32' ? `${executable}.cmd` : executable,
      },
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
    await withHangDeadline(exited, 'Codex fixture did not exit');
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
