import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-command-test-'));

const { AgentManagerCommandHandler } = await import('../dist/lib/agent-manager-commands.js');
const {
  cliHomeDirFor,
  ensureCliHomeDir,
  writeApiKey,
  readApiKey,
  readApiKeyForRehydrate,
  apiKeyPathFor,
  mcpConfigPathFor,
  writeMcpConfig,
  readMcpConfigServerNames,
  eraseSecrets,
  writeManagedAgentConfig,
} = await import('../dist/lib/managed-agent-store.js');

test('rehydration migrates the legacy unscoped key into the persisted workspace', async () => {
  const agentId = 'legacy-rehydrate-agent';
  await writeApiKey(agentId, 'legacy-key');

  assert.equal(await readApiKey(agentId, 'workspace-a'), null);
  assert.equal(await readApiKeyForRehydrate(agentId, 'workspace-a'), 'legacy-key');
  assert.equal(await readApiKey(agentId, 'workspace-a'), 'legacy-key');

  // Ordinary reads for another workspace remain isolated. Only the explicit
  // boot migration helper is allowed to consume the legacy key.
  assert.equal(await readApiKey(agentId, 'workspace-b'), null);
});

test('global agent secrets are isolated by workspace and erased together', async () => {
  const agentId = 'global-agent-scope';
  await writeApiKey(agentId, 'key-a', 'workspace-a');
  await writeApiKey(agentId, 'key-b', 'workspace-b');
  assert.equal(await readApiKey(agentId, 'workspace-a'), 'key-a');
  assert.equal(await readApiKey(agentId, 'workspace-b'), 'key-b');
  assert.notEqual(apiKeyPathFor(agentId, 'workspace-a'), apiKeyPathFor(agentId, 'workspace-b'));
  assert.notEqual(mcpConfigPathFor(agentId, 'workspace-a'), mcpConfigPathFor(agentId, 'workspace-b'));
  await writeMcpConfig(agentId, 'https://awb.example', 'key-a', 'workspace-a');
  await writeMcpConfig(agentId, 'https://awb.example', 'key-b', 'workspace-b');
  assert.deepEqual(
    await readMcpConfigServerNames(mcpConfigPathFor(agentId, 'workspace-a')),
    ['awb', 'host'],
    '진단 계약은 실제 관리형 MCP 설정의 서버 이름을 사용한다',
  );
  await eraseSecrets(agentId);
  assert.equal(await readApiKey(agentId, 'workspace-a'), null);
  assert.equal(await readApiKey(agentId, 'workspace-b'), null);
});

let originalFetch;
let requests;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function registryStub() {
  return {
    upsert() {},
    markRunning() {},
    markStopped() {},
    setWorkingDir() {},
    get() { return undefined; },
  };
}

test('refresh_mcp_config refreshes Codex native config without persisting the API key', async () => {
  const agentId = 'codex-agent-1';
  const apiKey = 'sk-refresh-secret';
  await ensureCliHomeDir(agentId);
  await writeApiKey(agentId, apiKey);
  const cliHome = cliHomeDirFor(agentId);
  const context = {
    agent_id: agentId,
    name: 'Codex Agent',
    cli: 'codex',
    working_dir: tmpdir(),
    mcp_config_path: '',
    api_key: apiKey,
    subagent_log_path: '',
    cli_home_dir: cliHome,
    model: null,
    registered_at: new Date().toISOString(),
  };
  const handler = new AgentManagerCommandHandler(
    { url: 'https://awb.refresh.example/', apiKey: 'manager-key', delegation: {} },
    {
      getInstanceId: () => 'instance-1',
      registry: registryStub(),
      contextRegistry: { get: (id) => id === agentId ? context : null },
    },
  );

  await handler.handle(JSON.stringify({
    command_id: 'refresh-1',
    command: 'refresh_mcp_config',
    args: { agent_id: agentId },
  }));

  const configText = await fsp.readFile(join(cliHome, 'config.toml'), 'utf8');
  const config = parse(configText);
  assert.equal(config.mcp_servers.awb.url, 'https://awb.refresh.example/mcp');
  assert.equal(config.mcp_servers.awb.required, true);
  assert.equal(config.mcp_servers.awb.bearer_token_env_var, 'AWB_API_KEY');
  assert.ok(!configText.includes(apiKey));
  const ack = requests.find((request) => request.url.endsWith('/command/ack'));
  assert.ok(ack);
  assert.equal(JSON.parse(ack.init.body).status, 'ok');
});

test('refresh_mcp_config repairs an on-disk Codex agent before its context is rehydrated', async () => {
  const agentId = 'codex-agent-on-disk';
  const apiKey = 'sk-disk-secret';
  await ensureCliHomeDir(agentId);
  await writeApiKey(agentId, apiKey);
  await writeManagedAgentConfig({
    agent_id: agentId,
    name: 'Disk Codex Agent',
    cli: 'codex',
    working_dir: tmpdir(),
    model: null,
  });
  const handler = new AgentManagerCommandHandler(
    { url: 'https://awb.disk.example', apiKey: 'manager-key', delegation: {} },
    {
      getInstanceId: () => 'instance-1',
      registry: registryStub(),
      contextRegistry: { get: () => null },
    },
  );

  await handler.handle(JSON.stringify({
    command_id: 'refresh-disk-1',
    command: 'refresh_mcp_config',
    args: { agent_id: agentId },
  }));

  const configText = await fsp.readFile(join(cliHomeDirFor(agentId), 'config.toml'), 'utf8');
  const config = parse(configText);
  assert.equal(config.mcp_servers.awb.url, 'https://awb.disk.example/mcp');
  assert.ok(!configText.includes(apiKey));
});

test('spawn_agent rejects Codex when its required native MCP config cannot be prepared', async () => {
  const agentId = 'codex-agent-invalid-config';
  const apiKey = 'sk-invalid-config-secret';
  await ensureCliHomeDir(agentId);
  await writeApiKey(agentId, apiKey);
  await fsp.writeFile(join(cliHomeDirFor(agentId), 'config.toml'), '[broken\n', 'utf8');

  let record;
  let markedRunning = false;
  const registry = {
    upsert(value) {
      record = { ...value, status: 'stopped' };
      return record;
    },
    markRunning() { markedRunning = true; },
    markStopped(_id, reason) {
      if (record) {
        record.status = 'stopped';
        record.last_error = reason;
      }
      return record;
    },
    setWorkingDir() {},
    get() { return record; },
  };
  const handler = new AgentManagerCommandHandler(
    { url: 'https://awb.spawn.example', apiKey: 'manager-key', delegation: {} },
    {
      getInstanceId: () => 'instance-1',
      registry,
      contextRegistry: { upsert() {}, get: () => null },
    },
  );

  await handler.handle(JSON.stringify({
    command_id: 'spawn-invalid-1',
    instance_id: 'instance-1',
    command: 'spawn_agent',
    args: {
      agent_id: agentId,
      name: 'Broken Codex Agent',
      cli: 'codex',
      working_dir: tmpdir(),
    },
  }));

  const ack = requests.find((request) => request.url.endsWith('/command/ack'));
  assert.ok(ack);
  assert.equal(JSON.parse(ack.init.body).status, 'error');
  assert.equal(markedRunning, false, 'a Codex agent without required AWB MCP must not be marked running');
  assert.equal(record.status, 'stopped');
  assert.match(record.last_error, /cli-home prep failed/i);
});

// ─── ticket 40110b64 — refresh_available_models ─────────────────────────────
//
// 호스트에서 CLI 를 업그레이드한 뒤 매니저를 재시작하지 않고 모델 목록만
// 갱신하는 커맨드. 실제 열거/전송은 main.ts 가 배선한 dep 이 하고, 여기서는
// 디스패치 · ack detail · 미배선/실패 처리 계약을 본다.

/** refreshAvailableModels dep 을 배선한 핸들러. */
function refreshHandler(refreshAvailableModels) {
  return new AgentManagerCommandHandler(
    { url: 'https://awb.models.example', apiKey: 'manager-key', delegation: {} },
    {
      getInstanceId: () => 'instance-1',
      registry: registryStub(),
      refreshAvailableModels,
    },
  );
}

function ackBody() {
  const ack = requests.find((request) => request.url.endsWith('/command/ack'));
  assert.ok(ack, '커맨드는 항상 ack 되어야 한다');
  return JSON.parse(ack.init.body);
}

test('refresh_available_models 는 CLI별 갱신 결과를 ack detail 에 담아 ok 로 ack 한다', async () => {
  let called = 0;
  const handler = refreshHandler(async () => {
    called++;
    return {
      models: { codex: ['gpt-5', 'gpt-5-mini'], claude: ['opus', 'sonnet', 'haiku'] },
      heartbeatPosted: true,
    };
  });

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-1',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  assert.equal(called, 1);
  const ack = ackBody();
  assert.equal(ack.status, 'ok');
  // CLI 순서는 정렬해 안정적으로 보고한다.
  assert.equal(ack.detail, 'refreshed 2 CLI(s): claude=3, codex=2');
});

test('일부 어댑터가 실패해 부분 결과만 와도 커맨드 전체는 성공으로 ack 된다 (best-effort 유지)', async () => {
  // gatherAvailableModels 는 실패한 CLI 의 키를 아예 빼고 돌려준다 —
  // 핸들러는 그 부분 결과를 정상으로 취급해야 한다.
  const handler = refreshHandler(async () => ({
    models: { claude: ['opus'] },
    heartbeatPosted: true,
  }));

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-partial',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'ok');
  assert.equal(ack.detail, 'refreshed 1 CLI(s): claude=1');
});

test('설치된 CLI 가 모델을 하나도 보고하지 않아도 에러가 아니라 0건으로 ack 된다', async () => {
  const handler = refreshHandler(async () => ({ models: {}, heartbeatPosted: true }));

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-empty',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'ok');
  assert.match(ack.detail, /refreshed 0 CLI\(s\)/);
});

test('즉시 하트비트 전송이 실패해도 ok 로 ack 하고 그 사실만 detail 에 덧붙인다', async () => {
  // 다음 정기 하트비트가 같은 값을 다시 싣고 가므로 커맨드를 실패시킬 이유가 없다.
  const handler = refreshHandler(async () => ({
    models: { claude: ['opus'] },
    heartbeatPosted: false,
  }));

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-no-post',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'ok');
  assert.match(ack.detail, /refreshed 1 CLI\(s\): claude=1/);
  assert.match(ack.detail, /immediate heartbeat post failed/);
});

test('refreshAvailableModels dep 이 배선되지 않은 매니저는 명확한 사유로 error ack 한다', async () => {
  const handler = new AgentManagerCommandHandler(
    { url: 'https://awb.models.example', apiKey: 'manager-key', delegation: {} },
    { getInstanceId: () => 'instance-1', registry: registryStub() },
  );

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-unwired',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'error');
  assert.match(ack.detail, /not wired/);
});

test('열거가 throw 하면 error 로 ack 된다 — 실패가 조용히 성공으로 둔갑하지 않는다', async () => {
  const handler = refreshHandler(async () => {
    throw new Error('adapter registry unavailable');
  });

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-throw',
    instance_id: 'instance-1',
    command: 'refresh_available_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'error');
  assert.match(ack.detail, /adapter registry unavailable/);
});

test('다른 인스턴스로 향한 refresh_available_models 는 조용히 버려진다 (ack 없음)', async () => {
  let called = 0;
  const handler = refreshHandler(async () => {
    called++;
    return { models: {}, heartbeatPosted: true };
  });

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-other-instance',
    instance_id: 'instance-2',
    command: 'refresh_available_models',
  }));

  assert.equal(called, 0);
  assert.equal(requests.length, 0, '내 인스턴스가 아니면 ack 도 보내지 않는다');
});

test('알 수 없는 verb 는 기존대로 error ack 된다 (KNOWN_COMMANDS 회귀 가드)', async () => {
  const handler = refreshHandler(async () => ({ models: {}, heartbeatPosted: true }));

  await handler.handle(JSON.stringify({
    command_id: 'refresh-models-typo',
    instance_id: 'instance-1',
    command: 'refresh_avaliable_models',
  }));

  const ack = ackBody();
  assert.equal(ack.status, 'error');
  assert.match(ack.detail, /unknown command/);
});
