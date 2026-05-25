// Smoke tests for GeminiCliAdapter — covers the spawn-args / config-home /
// credential-path / MCP-settings fixes from the "Gemini Agent 가능 하도록"
// ticket. Real fork is out of scope (CLI not always installed on CI); we
// validate the descriptor shape, env-var name, file layout, and parsers
// against synthetic inputs that mirror gemini-cli's actual stream-json
// emissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeminiCliAdapter } from '../dist/lib/cli-adapters/gemini.js';

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'gemini-adapter-test-'));
}

test('configDirEnv is GEMINI_CLI_HOME (not GEMINI_HOME)', () => {
  const a = new GeminiCliAdapter();
  assert.equal(a.configDirEnv(), 'GEMINI_CLI_HOME');
});

test('buildOneshotSpawn uses -p + --yolo + --skip-trust + stream-json + stdin pipe', () => {
  const a = new GeminiCliAdapter();
  const d = a.buildOneshotSpawn({
    rolePrompt: 'You are helpful.',
    taskText: 'What is 1+1?',
    mcpConfigPath: null,
  });
  // -p switches gemini into non-interactive mode; empty value because the
  // real prompt is piped to stdin (kept off argv to allow long prompts).
  const pIdx = d.args.indexOf('-p');
  assert.ok(pIdx >= 0, 'expected -p flag in args');
  assert.equal(d.args[pIdx + 1], '');
  assert.ok(d.args.includes('--yolo'), 'expected --yolo for auto-approval');
  // --skip-trust is required for headless operation; without it gemini
  // refuses to run in untrusted cwd and silently downgrades --yolo.
  assert.ok(d.args.includes('--skip-trust'), 'expected --skip-trust');
  const fmtIdx = d.args.indexOf('--output-format');
  assert.ok(fmtIdx >= 0, 'expected --output-format');
  assert.equal(d.args[fmtIdx + 1], 'stream-json');
  assert.deepEqual(d.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(d.needsMcpConfig, false);
  assert.equal(typeof d.writePrompt, 'function');
});

test('parseStdoutLine recognises assistant message as composing stage', () => {
  const a = new GeminiCliAdapter();
  const r = a.parseStdoutLine(
    JSON.stringify({ type: 'message', role: 'assistant', content: 'hello' }),
  );
  assert.equal(r.stage, 'composing');
  assert.equal(r.isResult, false);
});

test('parseStdoutLine treats unknown JSON event as thinking stage', () => {
  const a = new GeminiCliAdapter();
  const r = a.parseStdoutLine(
    JSON.stringify({ type: 'init', session_id: 'abc' }),
  );
  assert.equal(r.stage, 'thinking');
});

test('parseStdoutLine flags isResult on done / result events', () => {
  const a = new GeminiCliAdapter();
  assert.equal(a.parseStdoutLine(JSON.stringify({ type: 'done' })).isResult, true);
  assert.equal(a.parseStdoutLine(JSON.stringify({ type: 'result' })).isResult, true);
});

test('parseStdoutLine flags isError on error event', () => {
  const a = new GeminiCliAdapter();
  const r = a.parseStdoutLine(
    JSON.stringify({ type: 'error', message: 'quota exhausted' }),
  );
  assert.equal(r.isError, true);
});

test('collectOneshotResult concatenates assistant message text', () => {
  const a = new GeminiCliAdapter();
  const lines = [
    JSON.stringify({ type: 'init', session_id: 'x' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Part one.' }),
    JSON.stringify({ type: 'tool_use', tool_name: 'read_file' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Part two.' }),
    JSON.stringify({ type: 'done' }),
  ];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'Part one.\n\nPart two.');
});

test('collectOneshotResult surfaces error message when no assistant text', () => {
  const a = new GeminiCliAdapter();
  const lines = [
    JSON.stringify({ type: 'init' }),
    JSON.stringify({ type: 'error', message: 'quota exhausted' }),
  ];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, '[gemini error] quota exhausted');
});

test('collectOneshotResult strips noise warnings when falling back to raw', () => {
  const a = new GeminiCliAdapter();
  const lines = [
    'Warning: 256-color support not detected. Using a terminal with…',
    'Ripgrep is not available. Falling back to GrepTool.',
    'plain answer',
  ];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'plain answer');
});

test('prepareCliHome creates .gemini subdir and writes subscription creds', async () => {
  const a = new GeminiCliAdapter();
  const home = freshHome();
  const { extraEnv } = await a.prepareCliHome(home, {
    credential_id: 'c1',
    provider: 'gemini_subscription',
    fields: { oauth_creds_json: '{"access_token":"deadbeef"}' },
  });
  const oauth = await fsp.readFile(join(home, '.gemini', 'oauth_creds.json'), 'utf8');
  assert.equal(oauth, '{"access_token":"deadbeef"}');
  assert.deepEqual(extraEnv, {});
});

test('prepareCliHome with api_key sets GEMINI_API_KEY + GOOGLE_API_KEY env', async () => {
  const a = new GeminiCliAdapter();
  const home = freshHome();
  const { extraEnv } = await a.prepareCliHome(home, {
    credential_id: 'c2',
    provider: 'gemini_api_key',
    fields: { api_key: 'AIza-fake-key' },
  });
  assert.equal(extraEnv.GEMINI_API_KEY, 'AIza-fake-key');
  assert.equal(extraEnv.GOOGLE_API_KEY, 'AIza-fake-key');
  // No oauth file in api_key mode.
  await assert.rejects(fsp.readFile(join(home, '.gemini', 'oauth_creds.json'), 'utf8'));
});

test('prepareCliHome writes AWB MCP server into settings.json when mcp ctx given', async () => {
  const a = new GeminiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, {
    url: 'https://awb.example.com/',
    apiKey: 'sk-agent-123',
  });
  const settings = JSON.parse(
    await fsp.readFile(join(home, '.gemini', 'settings.json'), 'utf8'),
  );
  // AWB's /mcp is Streamable HTTP — Gemini CLI's schema uses `httpUrl`
  // for that transport; `url` would be parsed as SSE on older CLIs.
  assert.equal(settings.mcpServers.awb.httpUrl, 'https://awb.example.com/mcp');
  assert.equal(settings.mcpServers.awb.url, undefined, 'must not emit `url` — that key means SSE on older gemini-cli');
  assert.equal(settings.mcpServers.awb.type, undefined, '`type` is only meaningful with `url`, not `httpUrl`');
  assert.equal(settings.mcpServers.awb.headers.Authorization, 'Bearer sk-agent-123');
  assert.equal(settings.mcpServers.awb.headers['X-AWB-Client-Type'], 'managed-subagent');
  assert.equal(settings.mcpServers.awb.trust, true);
});

test('prepareCliHome merges AWB MCP server with existing settings.json', async () => {
  const a = new GeminiCliAdapter();
  const home = freshHome();
  // Seed an operator-curated settings file.
  await fsp.mkdir(join(home, '.gemini'), { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    join(home, '.gemini', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
      mcpServers: { existing: { type: 'stdio', command: '/bin/foo' } },
    }),
  );
  await a.prepareCliHome(home, null, { url: 'http://localhost:7701', apiKey: 'k' });
  const settings = JSON.parse(
    await fsp.readFile(join(home, '.gemini', 'settings.json'), 'utf8'),
  );
  // Operator settings preserved.
  assert.equal(settings.security.auth.selectedType, 'oauth-personal');
  assert.equal(settings.mcpServers.existing.command, '/bin/foo');
  // AWB entry added — via the Streamable-HTTP `httpUrl` key, not `url`.
  assert.equal(settings.mcpServers.awb.httpUrl, 'http://localhost:7701/mcp');
  assert.equal(settings.mcpServers.awb.url, undefined);
});

test('prepareCliHome erases stale oauth file on api_key switch', async () => {
  const a = new GeminiCliAdapter();
  const home = freshHome();
  // First spawn with subscription credential.
  await a.prepareCliHome(home, {
    credential_id: 'c1',
    provider: 'gemini_subscription',
    fields: { oauth_creds_json: '{"old":true}' },
  });
  // Second spawn with api_key — oauth file must be removed so api_key wins.
  await a.prepareCliHome(home, {
    credential_id: 'c2',
    provider: 'gemini_api_key',
    fields: { api_key: 'AIza-new' },
  });
  await assert.rejects(fsp.readFile(join(home, '.gemini', 'oauth_creds.json'), 'utf8'));
});

test('authEnvKeys includes both GEMINI_API_KEY and GOOGLE_API_KEY', () => {
  const a = new GeminiCliAdapter();
  const keys = a.authEnvKeys();
  assert.ok(keys.includes('GEMINI_API_KEY'));
  assert.ok(keys.includes('GOOGLE_API_KEY'));
});
