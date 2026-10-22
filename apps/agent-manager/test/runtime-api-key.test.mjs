import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-key-validation-'));
const { validateRuntimeApiKey } = await import('../dist/lib/runtime-api-key.js');
const { AgentManagerCommandHandler } = await import('../dist/lib/agent-manager-commands.js');
const { writeApiKey, readApiKey, writeMcpConfig, mcpConfigPathFor } = await import('../dist/lib/managed-agent-store.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { url: 'https://awb.test', apiKey: 'manager-key', account_id: 'account', delegation: {} };
const agentId = 'rt-0123456789abcdef';
const identity = { account_id: 'account', runtime_key: agentId, host_id: 'host' };

test('probe uses the runtime key and checks account and runtime identity', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://awb.test/api/agent-manager/runtime-keys/validate');
    assert.equal(init.headers['X-Agent-Key'], 'runtime-key');
    return Response.json(identity);
  };
  assert.equal(await validateRuntimeApiKey(config, 'runtime-key', 'account', agentId), true);
  assert.equal(await validateRuntimeApiKey(config, 'runtime-key', 'other-account', agentId), false);
  assert.equal(await validateRuntimeApiKey(config, 'runtime-key', 'account', 'rt-fedcba9876543210'), false);
});

test('only auth rejection returns false; transient or malformed responses throw', async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal(await validateRuntimeApiKey(config, 'key', 'account', agentId), false);
  }
  for (const status of [404, 429, 500, 503]) {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(validateRuntimeApiKey(config, 'key', 'account', agentId), /validation HTTP/);
  }
  globalThis.fetch = async () => { throw new Error('network offline'); };
  await assert.rejects(validateRuntimeApiKey(config, 'key', 'account', agentId), /network offline/);
  globalThis.fetch = async () => Response.json({});
  await assert.rejects(validateRuntimeApiKey(config, 'key', 'account', agentId), /invalid identity/);
});

function handler() {
  return new AgentManagerCommandHandler(config, {
    getInstanceId: () => 'instance',
    registry: { upsert: () => ({}), markRunning() {}, markStopped() {} },
  });
}
const input = { agent_id: agentId, name: 'runtime', cli: 'claude', working_dir: tmpdir(), model: '', runtime_config: null, credential_id: 'selected', account_id: 'account' };

test('rejected disk key is replaced and checked before use, valid key is reused', async () => {
  for (const rejectedStatus of [401, 403]) {
    await writeApiKey(agentId, 'old-key', 'account');
    await writeMcpConfig(agentId, config.url, 'old-key', 'account', { 'X-AWB-Tool-Profile': 'compact' });
    let provisions = 0;
    const checked = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/validate')) {
        checked.push(init.headers['X-Agent-Key']);
        return init.headers['X-Agent-Key'] === 'old-key'
          ? new Response(null, { status: rejectedStatus }) : Response.json(identity);
      }
      if (url.endsWith('/runtime-keys/provision')) {
        provisions++;
        return Response.json({ raw_key: 'new-key', account_id: 'account', key: agentId });
      }
      // Stop after key preparation, avoiding any operator CLI-home dependencies.
      if (url.includes('/credential?')) return new Response(null, { status: 503 });
      throw new Error(`Unexpected URL: ${url}`);
    };
    await assert.rejects(handler().materializeRuntimeIdentity(input), /credential/);
    assert.equal(await readApiKey(agentId, 'account'), 'new-key');
    assert.equal(provisions, 1);
    const compact = JSON.parse(readFileSync(mcpConfigPathFor(agentId, 'account', 'compact'), 'utf8'));
    assert.equal(compact.mcpServers.awb.headers.Authorization, 'Bearer new-key');
    assert.equal(compact.mcpServers.awb.headers['X-AWB-Tool-Profile'], 'compact');
    assert.deepEqual(checked, ['old-key', 'new-key']);
    await assert.rejects(handler().materializeRuntimeIdentity(input), /credential/);
    assert.equal(provisions, 1, 'healthy cached key must not rotate');
    assert.deepEqual(checked, ['old-key', 'new-key', 'new-key']);
  }
});

test('server outage and rejected newly issued key never publish replacement', async () => {
  for (const mode of ['outage', 'new-rejected']) {
    await writeApiKey(agentId, 'old-key', 'account');
    let provisions = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/validate')) return new Response(null, { status: mode === 'outage' ? 503 : 403 });
      if (url.endsWith('/runtime-keys/provision')) {
        provisions++;
        return Response.json({ raw_key: 'rejected-new-key' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    await assert.rejects(handler().materializeRuntimeIdentity(input), mode === 'outage' ? /validation HTTP 503/ : /provisioned apiKey rejected/);
    assert.equal(provisions, mode === 'outage' ? 0 : 1);
    assert.equal(await readApiKey(agentId, 'account'), 'old-key');
  }
});

test('foreign account materialization stops before storage or network access', async () => {
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(handler().materializeRuntimeIdentity({ ...input, account_id: 'foreign' }), /account does not match/);
});


test('runtime hashes are also bound to the paired host when available', async () => {
  const agentPath = join(process.env.AWB_AGENT_MANAGER_HOME, 'agent.json');
  writeFileSync(agentPath, JSON.stringify({ host_id: 'local-host', agent_id: 'legacy-alias' }));
  try {
    globalThis.fetch = async () => Response.json(identity);
    assert.equal(await validateRuntimeApiKey(config, 'key', 'account', agentId), false);
    globalThis.fetch = async () => Response.json({ ...identity, host_id: 'local-host' });
    assert.equal(await validateRuntimeApiKey(config, 'key', 'account', agentId), true);
  } finally {
    unlinkSync(agentPath);
  }
});
