import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  awb: process.env.AWB_API_KEY
}));
process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'ok'}) + '\\n');
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
  assert.equal(capture.model, 'fixture-model-a');
  assert.equal(capture.awb, 'agent-awb-key');
  assert.ok(capture.argv.includes('--mcp-config'), 'AWB MCP config remains attached');
});

test('OpenAI-compatible profile starts only its declared adapter and points Claude at the converted endpoint', async () => {
  const executable = await makeClaudeFixture('claude-adapter.mjs');
  const port = 42_000 + (process.pid % 10_000);
  const capture = await spawnFixture({
    id: 'openai-via-adapter',
    kind: 'claude-backend',
    protocol: 'openai-compatible',
    base_url: 'http://127.0.0.1:9999/v1',
    model: 'fixture-model-b',
    claude_executable: executable,
    adapter: {
      executable: process.execPath,
      args: [
        '-e',
        `require('http').createServer((q,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},'127.0.0.1')`,
      ],
      base_url: `http://127.0.0.1:${port}`,
      startup_timeout_ms: 10_000,
    },
  }, join(fixtureRoot, 'adapter.json'));
  assert.equal(capture.baseUrl, `http://127.0.0.1:${port}`);
  assert.equal(capture.model, 'fixture-model-b');
  assert.equal(capture.auth, 'awb-local-adapter');
});

test('credential reference is bound without exposing unrelated env', () => {
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
    ANTHROPIC_API_KEY: 'selected',
    OPENAI_API_KEY: 'must-not-leak',
  }), { BACKEND_API_KEY: 'selected' });
  assert.throws(
    () => runtimeCredentialEnv(profile, '00000000-0000-4000-8000-000000000002', { ANTHROPIC_API_KEY: 'x' }),
    /does not match/,
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
