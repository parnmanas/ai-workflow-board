// Smoke tests for PiCliAdapter (ticket d72282ad, MCP bridge added in
// d5a6100d) — covers the spawn-args / config-home / operator-HOME-inherit
// behaviour for the credential-free `pi` CLI adapter, plus the
// awb-mcp-bridge extension prepareCliHome writes so pi can call AWB MCP
// tools itself. Real fork is out of scope (CLI not always installed on CI);
// we validate the descriptor shape, env-var name, file layout, and parsers
// against synthetic inputs that mirror pi's documented `-p` plain-text
// output. The bridge's actual wire behaviour against a live AWB server (and
// a real spawned pi process autonomously calling get_ticket/add_comment/
// move_ticket through it) was verified manually — see the ticket comment on
// d5a6100d for the transcript — rather than re-installing the real `pi`
// package + a live server in this unit suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiCliAdapter } from '../dist/lib/cli-adapters/pi.js';

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'pi-adapter-test-'));
}

test('configDirEnv is HOME (pi has no dedicated config-dir env var, reads ~/.pi/agent/)', () => {
  const a = new PiCliAdapter();
  assert.equal(a.configDirEnv(), 'HOME');
});

test('capabilities are NATIVE_MCP only (stateless one-shot; the awb-mcp-bridge extension gives pi real MCP tools)', () => {
  const a = new PiCliAdapter();
  assert.deepEqual([...a.capabilities], ['native_mcp']);
});

test('buildOneshotSpawn uses -p + --approve + --no-session', () => {
  const a = new PiCliAdapter();
  const d = a.buildOneshotSpawn({
    rolePrompt: 'You are helpful.',
    taskText: 'What is 1+1?',
    mcpConfigPath: null,
  });
  const pIdx = d.args.indexOf('-p');
  assert.ok(pIdx >= 0, 'expected -p flag in args');
  assert.ok(d.args[pIdx + 1].includes('You are helpful.'), 'prompt should contain role prompt');
  assert.ok(d.args[pIdx + 1].includes('What is 1+1?'), 'prompt should contain task text');
  assert.ok(d.args.includes('--approve'), 'expected --approve (auto-trust project-local .pi/, no interactive prompt possible here)');
  assert.ok(d.args.includes('--no-session'), 'expected --no-session (ephemeral one-shot, no accumulating history)');
  assert.ok(!d.args.includes('--model'), 'no --model flag when model is unset');
  assert.deepEqual(d.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(d.needsMcpConfig, false);
});

test('buildOneshotSpawn adds --model only when a per-agent model is set', () => {
  const a = new PiCliAdapter();
  const d = a.buildOneshotSpawn({
    rolePrompt: '',
    taskText: 'task',
    mcpConfigPath: null,
    model: 'my-favorite-model',
  });
  const mIdx = d.args.indexOf('--model');
  assert.ok(mIdx >= 0, 'expected --model flag when a model is set');
  assert.equal(d.args[mIdx + 1], 'my-favorite-model');
});

test('parseStdoutLine treats non-empty lines as composing', () => {
  const a = new PiCliAdapter();
  const r = a.parseStdoutLine('hello world');
  assert.equal(r.stage, 'composing');
  assert.equal(r.isResult, false);
  assert.equal(r.isError, false);
});

test('parseStdoutLine treats empty lines as null stage', () => {
  const a = new PiCliAdapter();
  const r = a.parseStdoutLine('');
  assert.equal(r.stage, null);
});

test('collectOneshotResult concatenates plain text output', () => {
  const a = new PiCliAdapter();
  const lines = ['Part one of the answer.', '', 'Part two of the answer.'];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'Part one of the answer.\nPart two of the answer.');
});

test('collectOneshotResult strips Warning lines', () => {
  const a = new PiCliAdapter();
  const lines = ['Warning: some cli warning', 'actual answer'];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'actual answer');
});

test('collectOneshotResult strips ANSI escape sequences', () => {
  const a = new PiCliAdapter();
  const lines = ['\x1b[32mgreen text\x1b[0m'];
  const ans = a.collectOneshotResult(lines);
  assert.equal(ans, 'green text');
});

test('collectOneshotResult returns null for empty output', () => {
  const a = new PiCliAdapter();
  assert.equal(a.collectOneshotResult([]), null);
  assert.equal(a.collectOneshotResult(['']), null);
});

test('prepareCliHome ignores the credential param entirely (pi has no credential concept)', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  const { extraEnv } = await a.prepareCliHome(home, {
    credential_id: 'should-be-ignored',
    provider: 'pi_subscription',
    fields: { api_key: 'should-never-be-written-anywhere' },
  });
  assert.deepEqual(extraEnv, {}, 'pi never contributes env from a credential — it has none');
});

test('prepareCliHome creates the .pi/agent subdir even with no operator files to inherit', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  const emptyRealHome = mkdtempSync(join(tmpdir(), 'pi-empty-real-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = emptyRealHome;
  try {
    await a.prepareCliHome(home);
    const stat = await fsp.stat(join(home, '.pi', 'agent'));
    assert.ok(stat.isDirectory());
    await assert.rejects(fsp.readFile(join(home, '.pi', 'agent', 'auth.json'), 'utf8'));
  } finally {
    process.env.HOME = prevHome;
  }
});

test('prepareCliHome symlinks (or copies) auth.json + settings.json from the operator real ~/.pi/agent', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'pi-real-home-'));
  await fsp.mkdir(join(realHome, '.pi', 'agent'), { recursive: true });
  await fsp.writeFile(join(realHome, '.pi', 'agent', 'auth.json'), '{"token":"real-operator-token"}');
  await fsp.writeFile(join(realHome, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"llama.cpp"}');

  const prevHome = process.env.HOME;
  process.env.HOME = realHome;
  try {
    const a = new PiCliAdapter();
    const agentHome = freshHome();
    const { extraEnv } = await a.prepareCliHome(agentHome);
    assert.deepEqual(extraEnv, {});
    const auth = await fsp.readFile(join(agentHome, '.pi', 'agent', 'auth.json'), 'utf8');
    assert.equal(auth, '{"token":"real-operator-token"}');
    const settings = await fsp.readFile(join(agentHome, '.pi', 'agent', 'settings.json'), 'utf8');
    assert.equal(settings, '{"defaultProvider":"llama.cpp"}');
  } finally {
    process.env.HOME = prevHome;
  }
});

test('prepareCliHome only inherits whichever of auth.json/settings.json actually exist', async () => {
  const realHome = mkdtempSync(join(tmpdir(), 'pi-real-home-partial-'));
  await fsp.mkdir(join(realHome, '.pi', 'agent'), { recursive: true });
  await fsp.writeFile(join(realHome, '.pi', 'agent', 'settings.json'), '{"defaultProvider":"anthropic"}');
  // No auth.json on the operator side (e.g. only env-var auth configured).

  const prevHome = process.env.HOME;
  process.env.HOME = realHome;
  try {
    const a = new PiCliAdapter();
    const agentHome = freshHome();
    await a.prepareCliHome(agentHome);
    const settings = await fsp.readFile(join(agentHome, '.pi', 'agent', 'settings.json'), 'utf8');
    assert.equal(settings, '{"defaultProvider":"anthropic"}');
    await assert.rejects(fsp.readFile(join(agentHome, '.pi', 'agent', 'auth.json'), 'utf8'));
  } finally {
    process.env.HOME = prevHome;
  }
});

test('prepareCliHome writes no awb-mcp-bridge.ts when no mcp context is given', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home);
  await assert.rejects(
    fsp.readFile(join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'), 'utf8'),
  );
});

test('prepareCliHome writes awb-mcp-bridge.ts with the AWB /mcp URL when mcp ctx is given', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, { url: 'https://awb.example.com/', apiKey: 'sk-agent-123' });
  const content = await fsp.readFile(
    join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'),
    'utf8',
  );
  assert.match(content, /const AWB_MCP_URL = "https:\/\/awb\.example\.com\/mcp";/);
  // The client-type header that bypasses AWB's schemaVersion initialize
  // gate (mcp.controller.ts) — same value antigravity/codex already send.
  assert.match(content, /X-AWB-Client-Type['"]:\s*'managed-subagent'/);
  // apiKey is NEVER baked into the file — only read from the AWB_API_KEY
  // env var subagent-manager.ts / base-session-manager.ts inject per spawn
  // (mirrors codex's bearer_token_env_var reasoning: the key can rotate,
  // the endpoint URL is a spawn_agent-time constant).
  assert.ok(!content.includes('sk-agent-123'), 'apiKey must not be embedded in the generated file');
  assert.match(content, /process\.env\.AWB_API_KEY/);
  assert.match(content, /export default async function/);
});

test('generated awb-mcp-bridge.ts prints a stdout sentinel on tool-call success (ticket d5a6100d review round-2 fix)', async () => {
  // Without this, subagent-manager.ts's _scanForCommentTool — which only
  // reads child.stdout — can never observe a successful pi tool call: pi's
  // `-p` mode prints plain prose, not codex-style structured events, so
  // commentSent stays false forever and every dispatch trips the silent-exit
  // fallback + circuit-breaker even when the bridge actually posted the
  // comment. See test/oneshot-circuit-breaker.test.mjs for the manager-side
  // regression coverage.
  const a = new PiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, { url: 'http://localhost:7701', apiKey: 'k' });
  const content = await fsp.readFile(
    join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'),
    'utf8',
  );
  assert.match(content, /console\.log\(JSON\.stringify\(\{\s*type:\s*'awb_mcp_bridge_tool_call'/);
  // Must be console.log (real stdout), never console.error (stderr) — the
  // manager's stdout scanner can't see stderr.
  const successLineIdx = content.indexOf("type: 'awb_mcp_bridge_tool_call'");
  const precedingLine = content.slice(0, successLineIdx).split('\n').pop();
  assert.match(precedingLine, /console\.log\(/);
});

test('prepareCliHome gates the bridge extension on url only, matching codex\'s "gate on url" reasoning', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  // No apiKey at all — a missing key must never skip wiring the endpoint,
  // since the real key always arrives later via the AWB_API_KEY env var.
  await a.prepareCliHome(home, null, { url: 'http://localhost:7701' });
  const content = await fsp.readFile(
    join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'),
    'utf8',
  );
  assert.match(content, /const AWB_MCP_URL = "http:\/\/localhost:7701\/mcp";/);
});

test('prepareCliHome regenerates awb-mcp-bridge.ts on every call (overwrites, not merges)', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, { url: 'http://first.example.com', apiKey: 'k1' });
  await a.prepareCliHome(home, null, { url: 'http://second.example.com', apiKey: 'k2' });
  const content = await fsp.readFile(
    join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'),
    'utf8',
  );
  assert.match(content, /const AWB_MCP_URL = "http:\/\/second\.example\.com\/mcp";/);
  assert.ok(!content.includes('first.example.com'));
});

test('generated awb-mcp-bridge.ts is syntactically valid JS (ESM export stripped for a CJS parse check)', async () => {
  const a = new PiCliAdapter();
  const home = freshHome();
  await a.prepareCliHome(home, null, { url: 'http://localhost:7701', apiKey: 'k' });
  const content = await fsp.readFile(
    join(home, '.pi', 'agent', 'extensions', 'awb-mcp-bridge.ts'),
    'utf8',
  );
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(content.replace('export default async function', 'const _f = async function'));
  });
});

test('authEnvKeys is empty (no per-agent credential ever exists to protect from an operator env var)', () => {
  const a = new PiCliAdapter();
  assert.deepEqual(a.authEnvKeys(), []);
});

test('harnessKeys supports model only (inherits the base default, matches codex/antigravity)', () => {
  const a = new PiCliAdapter();
  assert.deepEqual(a.harnessKeys(), ['model']);
});
