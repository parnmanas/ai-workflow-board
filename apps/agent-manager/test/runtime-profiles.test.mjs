import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
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
    assert.equal(capture.model, 'fixture-model-b');
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
    const manager = new SubagentManager(config);
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
    await Promise.race([exited, delay(5_000).then(() => assert.fail('Codex fixture did not exit'))]);
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
