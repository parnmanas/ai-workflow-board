// Credential env for agent runs (server: Credential.agent_env →
// GET /api/agent-manager/agent-env). Pinned here:
//   - the REST contract: path, account_id query, X-Agent-Key; an older server
//     (404) or a failing one yields no env instead of a refused spawn
//   - names the spawn owns never come from a credential: AWB_* and the CLI's
//     own auth vars are dropped, and the merge order keeps AWB_API_KEY ours
//   - the production spawn paths (persistent session + one-shot) actually
//     put the values on the child process env, for the run's account

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, afterEach } from 'node:test';

import {
  agentCredentialEnvFor,
  filterAgentEnv,
  setAgentEnvFetcherForTests,
} from '../dist/lib/agent-env-credentials.js';
import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { createRuntimeAdapterResolver } from '../dist/lib/runtime/runtime-registry.js';

const fixtureRoot = join(process.cwd(), '.test-agent-env-credentials');

after(async () => {
  for (let i = 1; ; i += 1) {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      const transient = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY';
      if (!transient || i >= 25) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

afterEach(() => setAgentEnvFetcherForTests(null));

test('filterAgentEnv drops AWB_* and the CLI auth names, keeps strings only', () => {
  const { env, dropped } = filterAgentEnv(
    { GOOGLE_CLIENT_ID: 'id', AWB_API_KEY: 'x', anthropic_api_key: 'y', N: 1 },
    ['ANTHROPIC_API_KEY'],
  );
  assert.deepEqual(env, { GOOGLE_CLIENT_ID: 'id' });
  assert.deepEqual(dropped.sort(), ['AWB_API_KEY', 'anthropic_api_key']);
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('fetches by account with the manager key', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-agent-key'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ env: { GOOGLE_CLIENT_SECRET: 's' }, skipped: [{ name: 'old', reason: 'r' }] }));
  }, async (url) => {
    const env = await agentCredentialEnvFor({ url, apiKey: 'mgr-key' }, 'acc-1', [], '[t]');
    assert.deepEqual(env, { GOOGLE_CLIENT_SECRET: 's' });
  });
  assert.deepEqual(seen, [{ url: '/api/agent-manager/agent-env?account_id=acc-1', key: 'mgr-key' }]);
});

test('an older server (404) or a failing one yields no env; no account → no request', async () => {
  let hits = 0;
  for (const status of [404, 500]) {
    await withServer((_req, res) => { hits += 1; res.statusCode = status; res.end('{}'); }, async (url) => {
      assert.deepEqual(await agentCredentialEnvFor({ url, apiKey: 'k' }, 'acc-1', [], '[t]'), {});
      assert.deepEqual(await agentCredentialEnvFor({ url, apiKey: 'k' }, '', [], '[t]'), {});
    });
  }
  assert.equal(hits, 2);
});

async function makeBin(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(path, '#!/usr/bin/env node\n', { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

function agentContext(cwd) {
  return {
    agent_id: 'agent-env-test',
    account_id: 'acc-run',
    api_key: 'agent-key',
    cwd,
    mcp_config_path: '',
    cli: 'claude',
    cli_home_dir: cwd,
    model: null,
    extra_env: {},
    credential_provider: null,
    credential_id: null,
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  };
}

/** Real resolver, except spawnProcess records the options and returns a pid-less child. */
function capturingResolver() {
  const real = createRuntimeAdapterResolver();
  const calls = [];
  return {
    calls,
    stub: {
      ports: real.ports,
      resolve: (...a) => real.resolve(...a),
      buildOneshot: (...a) => real.buildOneshot(...a),
      buildSession: (...a) => real.buildSession(...a),
      shouldRetry: (...a) => real.shouldRetry(...a),
      spawnProcess: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        const child = new EventEmitter();
        child.pid = undefined;
        child.unref = () => {};
        return child;
      },
    },
  };
}

const HOSTILE = { GOOGLE_CLIENT_ID: 'cid', AWB_API_KEY: 'hijack', ANTHROPIC_API_KEY: 'hijack' };

function installFetcher() {
  const accounts = [];
  setAgentEnvFetcherForTests(async (_config, accountId) => {
    accounts.push(accountId);
    return { env: { ...HOSTILE }, skipped: [] };
  });
  return accounts;
}

const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'mgr-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: true, maxConcurrent: 4, ttlMinutes: 1 },
};

test('persistent session spawn puts credential env on the child, below AWB/auth', async () => {
  const accounts = installFetcher();
  const executable = await makeBin('claude-session.mjs');
  const cwd = join(fixtureRoot, 'session');
  await mkdir(cwd, { recursive: true });
  const { stub, calls } = capturingResolver();
  const manager = new BaseSessionManager(
    { ...config, delegation: { ...config.delegation, claudeBin: executable } },
    { logTag: '[agent-env-test]', keyField: 'room_id', adapterResolver: stub },
  );
  try {
    await manager._spawnSession('room-env', 'role', 'turn', { agentContext: agentContext(cwd) });
  } finally {
    await manager?.stopAll?.().catch?.(() => {});
  }
  assert.equal(calls.length, 1, 'spawn was never reached');
  const env = calls[0].options.env;
  assert.deepEqual(accounts, ['acc-run']);
  assert.equal(env.GOOGLE_CLIENT_ID, 'cid');
  assert.equal(env.AWB_API_KEY, 'agent-key');
  assert.notEqual(env.ANTHROPIC_API_KEY, 'hijack');
});

test('one-shot spawn puts credential env on the child, below AWB/auth', async () => {
  const accounts = installFetcher();
  const executable = await makeBin('claude-oneshot.mjs');
  const cwd = join(fixtureRoot, 'oneshot');
  await mkdir(cwd, { recursive: true });
  const { stub, calls } = capturingResolver();
  const manager = new SubagentManager(
    { ...config, delegation: { ...config.delegation, persistentTicketSessions: false, claudeBin: executable } },
    undefined,
    stub,
  );
  await manager.spawn({
    kind: 'trigger',
    taskText: 'task',
    rolePrompt: 'role',
    triggerId: 'trigger-env',
    ticketId: 'ticket-env',
    agentId: 'agent-env-test',
    role: 'assignee',
    agentContext: agentContext(cwd),
  }).catch(() => {});
  assert.equal(calls.length, 1, 'spawn was never reached');
  const env = calls[0].options.env;
  assert.deepEqual(accounts, ['acc-run']);
  assert.equal(env.GOOGLE_CLIENT_ID, 'cid');
  assert.equal(env.AWB_API_KEY, 'agent-key');
  assert.notEqual(env.ANTHROPIC_API_KEY, 'hijack');
});
