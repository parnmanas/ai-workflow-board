// Smoke tests for AntigravityCliAdapter — covers the spawn-args / config-home /
// credential-path / MCP-config fixes for the Gemini → Antigravity migration.
// Real fork is out of scope (CLI not always installed on CI); we validate the
// descriptor shape, env-var name, file layout, and parsers against synthetic
// inputs that mirror antigravity's actual plain-text output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AntigravityCliAdapter } from '../dist/lib/cli-adapters/antigravity.js';

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'antigravity-adapter-test-'));
}

test('configDirEnv is HOME (antigravity reads ~/.antigravity/)', () => {
  const a = new AntigravityCliAdapter();
  assert.equal(a.configDirEnv(), 'HOME');
});

test('buildOneshotSpawn uses -p + --dangerously-skip-permissions', () => {
  const a = new AntigravityCliAdapter();
  const d = a.buildOneshotSpawn({
    rolePrompt: 'You are helpful.',
    taskText: 'What is 1+1?',
    mcpConfigPath: null,
  });
  // -p passes the full prompt for non-interactive mode
  const pIdx = d.args.indexOf('-p');
  assert.ok(pIdx >= 0, 'expected -p flag in args');
  assert.ok(d.args[pIdx + 1].includes('You are helpful.'), 'prompt should contain role prompt');
  assert.ok(d.args[pIdx + 1].includes('What is 1+1?'), 'prompt should contain task text');
  assert.ok(d.args.includes('--dangerously-skip-permissions'), 'expected --dangerously-skip-permissions');
  assert.deepEqual(d.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(d.needsMcpConfig, false);
});

test('parseStdoutLine treats non-empty lines as composing', () => {
  const a = new AntigravityCliAdapter();
  const r = a.parseStdoutLine('hello world');
  assert.equal(r.stage, 'composing');
  assert.equal(r.isResult, false);
});

test('parseStdoutLine treats empty lines as null stage', () => {
  const a = new AntigravityCliAdapter();
  const r = a.parseStdoutLine('');
  assert.equal(r.stage, null);
});

test('collectOneshotResult concatenates plain text output', () => {
  const a = new AntigravityCliAdapter();
  const lines = [
    'Part one of the answer.',
    '',
    'Part two of the answer.',
  ];
  const ans = a.collectOneshotResult(lines);
  // Empty lines are filtered, so parts join with single \n
  assert.equal(ans, 'Part one of the answer.\nPart two of the answer.');
});

test('collectOneshotResult strips Warning lines', () => {
  const a = new AntigravityCliAdapter();
  const lines = [
    'Warning: some cli warning',
    'actual answer',
  ];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'actual answer');
});

test('collectOneshotResult strips ANSI escape sequences', () => {
  const a = new AntigravityCliAdapter();
  const lines = ['\x1b[32mgreen text\x1b[0m'];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'green text');
});

test('collectOneshotResult returns null for empty output', () => {
  const a = new AntigravityCliAdapter();
  assert.equal(a.collectOneshotResult([]), null);
  assert.equal(a.collectOneshotResult(['']), null);
});

test('prepareCliHome creates .antigravity subdir and writes subscription creds', async () => {
  const a = new AntigravityCliAdapter();
  const home = freshHome();
  const { extraEnv } = await a.prepareCliHome(home, {
    credential_id: 'c1',
    provider: 'antigravity_subscription',
    fields: { oauth_creds_json: '{"access_token":"deadbeef"}' },
  });
  const oauth = await fsp.readFile(join(home, '.antigravity', 'oauth_creds.json'), 'utf8');
  assert.equal(oauth, '{"access_token":"deadbeef"}');
  assert.deepEqual(extraEnv, {});
});

test('prepareCliHome with api_key sets GEMINI_API_KEY + GOOGLE_API_KEY env', async () => {
  const a = new AntigravityCliAdapter();
  const home = freshHome();
  const { extraEnv } = await a.prepareCliHome(home, {
    credential_id: 'c2',
    provider: 'antigravity_api_key',
    fields: { api_key: 'AIza-fake-key' },
  });
  assert.equal(extraEnv.GEMINI_API_KEY, 'AIza-fake-key');
  assert.equal(extraEnv.GOOGLE_API_KEY, 'AIza-fake-key');
  // No oauth file in api_key mode.
  await assert.rejects(fsp.readFile(join(home, '.antigravity', 'oauth_creds.json'), 'utf8'));
});

test('prepareCliHome writes AWB MCP server into mcp_config.json when mcp ctx given', async () => {
  const a = new AntigravityCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, {
    url: 'https://awb.example.com/',
    apiKey: 'sk-agent-123',
  });
  const config = JSON.parse(
    await fsp.readFile(join(home, '.antigravity', 'mcp_config.json'), 'utf8'),
  );
  assert.equal(config.mcpServers.awb.url, 'https://awb.example.com/mcp');
  assert.equal(config.mcpServers.awb.headers.Authorization, 'Bearer sk-agent-123');
  assert.equal(config.mcpServers.awb.headers['X-AWB-Client-Type'], 'managed-subagent');
});

test('prepareCliHome merges AWB MCP server with existing mcp_config.json', async () => {
  const a = new AntigravityCliAdapter();
  const home = freshHome();
  // Seed an operator-curated config file.
  await fsp.mkdir(join(home, '.antigravity'), { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    join(home, '.antigravity', 'mcp_config.json'),
    JSON.stringify({
      mcpServers: { existing: { type: 'stdio', command: '/bin/foo' } },
    }),
  );
  await a.prepareCliHome(home, null, { url: 'http://localhost:7701', apiKey: 'k' });
  const config = JSON.parse(
    await fsp.readFile(join(home, '.antigravity', 'mcp_config.json'), 'utf8'),
  );
  // Operator settings preserved.
  assert.equal(config.mcpServers.existing.command, '/bin/foo');
  // AWB entry added.
  assert.equal(config.mcpServers.awb.url, 'http://localhost:7701/mcp');
});

test('prepareCliHome erases stale oauth file on api_key switch', async () => {
  const a = new AntigravityCliAdapter();
  const home = freshHome();
  // First spawn with subscription credential.
  await a.prepareCliHome(home, {
    credential_id: 'c1',
    provider: 'antigravity_subscription',
    fields: { oauth_creds_json: '{"old":true}' },
  });
  // Second spawn with api_key — oauth file must be removed so api_key wins.
  await a.prepareCliHome(home, {
    credential_id: 'c2',
    provider: 'antigravity_api_key',
    fields: { api_key: 'AIza-new' },
  });
  await assert.rejects(fsp.readFile(join(home, '.antigravity', 'oauth_creds.json'), 'utf8'));
});

test('authEnvKeys includes both GEMINI_API_KEY and GOOGLE_API_KEY', () => {
  const a = new AntigravityCliAdapter();
  const keys = a.authEnvKeys();
  assert.ok(keys.includes('GEMINI_API_KEY'));
  assert.ok(keys.includes('GOOGLE_API_KEY'));
});
