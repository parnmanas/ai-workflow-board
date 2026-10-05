import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const home = await mkdtemp(join(tmpdir(), 'awb-account-compat-'));
process.env.AWB_AGENT_MANAGER_HOME = home;
const { normalizeAccountEnvelope, normalizeAccountScope } = await import('../dist/lib/account-scope.js');
const { loadConfig, loadAgentInfo } = await import('../dist/lib/config.js');
const store = await import('../dist/lib/managed-agent-store.js');
const { EventDispatcher } = await import('../dist/lib/event-dispatcher.js');
const { parseRunProvision } = await import('../dist/lib/run-provisioner.js');
const { runSetup } = await import('../dist/lib/setup.js');

test.after(() => rm(home, { recursive: true, force: true }));

test('legacy ownership is normalized while canonical account and opaque inputs take precedence', () => {
  const raw = {
    workspace_id: 'old-owner',
    account_id: 'canonical-owner',
    payload: {
      workspace_id: 'payload-owner',
      args: { workspace_id: 'command-owner' },
      run_provision: { workspace_id: 'run-owner', workspace_folder: '.awb/chat/room' },
      tool_input: { workspace_id: 'tool-specific-value' },
      fields: { workspace_id: 'credential-specific-value' },
    },
  };
  const normalized = normalizeAccountEnvelope(raw);
  assert.equal(normalized.account_id, 'canonical-owner');
  assert.equal(normalized.payload.account_id, 'payload-owner');
  assert.equal(normalized.payload.args.account_id, 'command-owner');
  assert.equal(normalized.payload.run_provision.account_id, 'run-owner');
  assert.equal(normalized.payload.run_provision.workspace_folder, '.awb/chat/room');
  assert.deepEqual(normalized.payload.tool_input, raw.payload.tool_input);
  assert.deepEqual(normalized.payload.fields, raw.payload.fields);
  assert.equal('workspace_id' in normalized, false);
  assert.equal('workspace_id' in normalized.payload, false);
  assert.equal(raw.workspace_id, 'old-owner', 'normalization does not mutate the source');
  assert.equal(normalizeAccountScope({ account_id: null, workspace_id: 'old' }).account_id, null);
});

test('old config and agent identity load without rewriting existing files', async () => {
  const configPath = join(home, 'legacy-config.json');
  const agentPath = join(home, 'legacy-agent.json');
  const original = JSON.stringify({ url: 'https://awb.invalid', apiKey: 'fixture-key', workspace_id: 'original-uuid' });
  await writeFile(configPath, original);
  await writeFile(agentPath, JSON.stringify({ agent_id: 'host-id', workspace_id: 'original-uuid' }));
  const config = loadConfig(configPath);
  assert.equal(config.account_id, 'original-uuid');
  assert.equal('workspace_id' in config, false);
  assert.equal(loadAgentInfo(agentPath).account_id, 'original-uuid');
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('legacy managed config reuses scope key, MCP config, credential and CLI session paths', async () => {
  const agentId = 'legacy-runtime';
  const accountId = 'original-uuid';
  const agentDir = await store.ensureManagedAgentDir(agentId);
  await writeFile(store.configPathFor(agentId), JSON.stringify({
    agent_id: agentId, workspace_id: accountId, name: 'Existing runtime', cli: 'claude', working_dir: '/work/repo',
  }));
  const oldKeyPath = join(agentDir, `apikey.${accountId}`);
  const oldMcpPath = join(agentDir, `mcp-config.${accountId}.json`);
  await writeFile(oldKeyPath, 'fixture-scoped-key');
  await writeFile(oldMcpPath, '{"mcpServers":{"awb":{"url":"https://awb.invalid/mcp"}}}');
  const cliHome = await store.ensureCliHomeDir(agentId);
  const sessionDir = join(cliHome, 'projects', '-work-repo');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'native-session.jsonl'), '{"sessionId":"native-session"}\n');
  await store.writeAgentCredential(agentId, { credential_id: 'existing-credential', provider: 'claude_api_key', fields: { api_key: 'fixture-provider-key' } });

  const cfg = await store.readManagedAgentConfig(agentId);
  assert.equal(cfg.account_id, accountId);
  assert.equal(store.apiKeyPathFor(agentId, cfg.account_id), oldKeyPath);
  assert.equal(await store.readApiKeyForRehydrate(agentId, cfg.account_id), 'fixture-scoped-key');
  assert.equal(store.mcpConfigPathFor(agentId, cfg.account_id), oldMcpPath);
  assert.equal(store.mcpConfigPathFor(agentId, cfg.account_id, 'compact'), join(agentDir, `mcp-config.${accountId}.compact.json`));
  assert.equal(store.cliHomeDirFor(agentId), cliHome);
  assert.equal(await readFile(join(sessionDir, 'native-session.jsonl'), 'utf8'), '{"sessionId":"native-session"}\n');
  assert.equal((await store.readAgentCredential(agentId)).credential_id, 'existing-credential');
  await store.writeManagedAgentConfig(cfg);
  const persisted = JSON.parse(await readFile(store.configPathFor(agentId), 'utf8'));
  assert.equal(persisted.account_id, accountId);
  assert.equal('workspace_id' in persisted, false);
});

test('direct SSE session handler passes legacy ownership to the runner as account_id', async () => {
  const seen = [];
  const dispatcher = new EventDispatcher({ url: 'https://awb.invalid', apiKey: 'fixture-key' }, {
    agentSessionRunner: { handle: async (request) => { seen.push(request); } },
  });
  await dispatcher.handleAgentSessionRequest(JSON.stringify({ payload: {
    manager_id: 'host-id', cli: 'claude', op: 'open', workspace_id: 'original-uuid',
  } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account_id, 'original-uuid');
  assert.equal('workspace_id' in seen[0], false);
});

test('legacy run provisioning accepts the owner alias while retaining working-folder vocabulary', () => {
  const provision = parseRunProvision({ kind: 'chat', run_id: 'room-id', workspace_id: 'original-uuid', workspace_folder: '.awb/chat/room' });
  assert.ok(provision);
  assert.equal(provision.account_id, 'original-uuid');
  assert.equal(provision.workspace_folder, '.awb/chat/room');
  assert.equal('workspace_id' in provision, false);
});

for (const ownerField of ['account_id', 'workspace_id']) {
  test(`pairing from ${ownerField} writes only canonical account ownership`, async (t) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ api_key: 'fixture-pair-key', agent_id: 'fixture-host', [ownerField]: 'original-uuid' }), { status: 200 });
    t.after(() => { globalThis.fetch = previousFetch; });
    const configPath = join(home, `paired-${ownerField}.json`);
    const result = await runSetup({ configPath, agentPath: join(home, `agent-${ownerField}.json`), url: 'https://awb.invalid', token: 'fixture-token', nonInteractive: true });
    assert.equal(result.accountId, 'original-uuid');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.account_id, 'original-uuid');
    assert.equal('workspace_id' in config, false);
  });
}

test('CLI dry-run supports account and deprecated workspace overrides without starting a manager', async () => {
  const configPath = join(home, 'cli-config.json');
  await writeFile(configPath, JSON.stringify({ url: 'https://awb.invalid', apiKey: 'fixture-key', workspace_id: 'original-uuid' }));
  const run = promisify(execFile);
  const mainPath = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  for (const [flags, expectedOwner] of [
    [[], 'original-uuid'],
    [['--account', 'canonical-override'], 'canonical-override'],
    [['--workspace', 'legacy-override'], 'legacy-override'],
    [['-w', 'short-override'], 'short-override'],
    [['--workspace', 'legacy-override', '--account', 'canonical-override'], 'canonical-override'],
  ]) {
    const { stdout } = await run(process.execPath, [mainPath, '--config', configPath, '--dry-run', ...flags], { env: { ...process.env, AWB_AGENT_MANAGER_HOME: home }, timeout: 15_000 });
    assert.ok(stdout.includes(`account:     ${expectedOwner}`), stdout);
  }
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).workspace_id, 'original-uuid', 'dry-run preserves disk config');
});
