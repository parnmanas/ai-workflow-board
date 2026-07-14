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
  writeManagedAgentConfig,
} = await import('../dist/lib/managed-agent-store.js');

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
