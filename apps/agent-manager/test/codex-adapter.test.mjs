import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';

const tempDirs = [];

async function freshDir(prefix = 'awb-codex-adapter-') {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readConfig(home) {
  const text = await fsp.readFile(join(home, 'config.toml'), 'utf8');
  return { text, config: parse(text) };
}

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('Codex declares native MCP without claiming persistent-session support', () => {
  const adapter = new CodexCliAdapter();
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION), false);
});

test('buildOneshotSpawn adds ticket attribution as a TOML config override', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    mcpAttribution: {
      ticketId: 'ticket-123',
      role: 'reviewer',
      triggerSource: 'ticket_done_review',
    },
  });
  const configIndex = descriptor.args.indexOf('-c');
  assert.ok(configIndex >= 0);
  const override = descriptor.args[configIndex + 1];
  const prefix = 'mcp_servers.awb.http_headers=';
  assert.ok(override.startsWith(prefix));
  const headers = parse(`headers = ${override.slice(prefix.length)}`).headers;
  assert.deepEqual(headers, {
    'X-AWB-Client-Type': 'managed-subagent',
    'X-AWB-Subagent-Ticket-Id': 'ticket-123',
    'X-AWB-Subagent-Role': 'reviewer',
    'X-AWB-Subagent-Trigger-Source': 'ticket_done_review',
  });
});

test('buildOneshotSpawn omits per-run MCP override for unattributed chat runs', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
  });
  assert.equal(descriptor.args.includes('-c'), false);
});

test('buildOneshotSpawn pins Codex workspace root to the manager-selected cwd', () => {
  const adapter = new CodexCliAdapter();
  const cwd = '/repo/.awb/wt/12345678';
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    cwd,
  });
  const cdIndex = descriptor.args.indexOf('--cd');
  assert.ok(cdIndex >= 0, 'Codex must receive an explicit workspace root');
  assert.equal(descriptor.args[cdIndex + 1], cwd);
});

test('buildOneshotSpawn omits --cd when no cwd was resolved', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
  });
  assert.equal(descriptor.args.includes('--cd'), false);
});

test('prepareCliHome writes required AWB and optional host MCP without persisting the API key', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();

  await adapter.prepareCliHome(home, null, {
    url: 'https://awb.example.com/',
    apiKey: 'sk-agent-123',
  });

  const { text, config } = await readConfig(home);
  assert.equal(config.mcp_servers.awb.url, 'https://awb.example.com/mcp');
  assert.equal(config.mcp_servers.awb.bearer_token_env_var, 'AWB_API_KEY');
  assert.equal(config.mcp_servers.awb.required, true);
  assert.equal(config.mcp_servers.awb.http_headers['X-AWB-Client-Type'], 'managed-subagent');
  assert.equal(config.mcp_servers.host.required, undefined);
  assert.equal(typeof config.mcp_servers.host.command, 'string');
  assert.ok(config.mcp_servers.host.args.at(-1) === 'mcp-host');
  assert.ok(!text.includes('sk-agent-123'));
  assert.equal((await fsp.stat(join(home, 'config.toml'))).isFile(), true);
});

test('prepareCliHome preserves unrelated Codex settings and MCP servers while refreshing managed entries', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  await fsp.writeFile(
    join(home, 'config.toml'),
    [
      'model = "gpt-5.4"',
      '[mcp_servers.existing]',
      'command = "/bin/existing"',
      '[mcp_servers.awb]',
      'url = "https://stale.example/mcp"',
      '',
    ].join('\n'),
  );

  await adapter.prepareCliHome(home, null, {
    url: 'http://localhost:7701',
    apiKey: 'secret-not-for-toml',
  });
  await adapter.prepareCliHome(home, null, {
    url: 'https://new.example/',
    apiKey: 'rotated-secret',
  });

  const { text, config } = await readConfig(home);
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(config.mcp_servers.existing.command, '/bin/existing');
  assert.equal(config.mcp_servers.awb.url, 'https://new.example/mcp');
  assert.equal((text.match(/\[mcp_servers\.awb\]/g) ?? []).length, 1);
  assert.ok(!text.includes('secret-not-for-toml'));
  assert.ok(!text.includes('rotated-secret'));
});

test('prepareCliHome rejects invalid TOML without overwriting it', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  const configPath = join(home, 'config.toml');
  const invalid = '[mcp_servers.awb\nurl = "broken"';
  await fsp.writeFile(configPath, invalid);

  await assert.rejects(
    adapter.prepareCliHome(home, null, { url: 'https://awb.example.com', apiKey: 'key' }),
  );
  assert.equal(await fsp.readFile(configPath, 'utf8'), invalid);
});

test('prepareCliHome replaces an inherited config symlink without modifying the operator target', async (t) => {
  const adapter = new CodexCliAdapter();
  const operatorHome = await freshDir('awb-codex-operator-');
  const agentHome = await freshDir('awb-codex-agent-');
  const operatorConfig = join(operatorHome, 'config.toml');
  const agentConfig = join(agentHome, 'config.toml');
  const originalOperatorText = 'model = "gpt-5.4"\n';
  await fsp.writeFile(operatorConfig, originalOperatorText);
  try {
    await fsp.symlink(operatorConfig, agentConfig, 'file');
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      t.skip(`file symlinks unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  await adapter.prepareCliHome(agentHome, null, {
    url: 'https://awb.example.com',
    apiKey: 'key',
  });

  assert.equal((await fsp.lstat(agentConfig)).isSymbolicLink(), false);
  assert.equal(await fsp.readFile(operatorConfig, 'utf8'), originalOperatorText);
  const { config } = await readConfig(agentHome);
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(config.mcp_servers.awb.required, true);
});
