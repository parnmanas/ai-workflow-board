// A ticket / chat runtime gets its credential the same way spawn_agent and
// Agent Sessions do (runtime-credential.ts + materializeRuntimeIdentity).
//
// Production (rolf, 2026-10-22): a ticket assigned to a runtime with a
// claude_oauth_token credential reached the host as two events — the server's
// fire-and-forget spawn_agent and the agent_trigger. The trigger won, the
// dispatcher built a credential-less context of its own ("operator credential
// fallback"), and the CLI died ~1s into its first turn, while the same
// credential worked in Agent Sessions and missions. These tests drive the REAL
// EventDispatcher and AgentManagerCommandHandler sharing one context registry.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-runtime-credential-'));
writeFileSync(join(process.env.AWB_AGENT_MANAGER_HOME, 'agent.json'), JSON.stringify({ agent_id: 'legacy-host-id', host_id: 'host-1' }));

const { EventDispatcher, runtimeIdentityKey, RUNTIME_CREDENTIAL_BLOCKER } = await import('../dist/lib/event-dispatcher.js');
const { AgentManagerCommandHandler } = await import('../dist/lib/agent-manager-commands.js');
const { ManagedAgentContextRegistry } = await import('../dist/lib/managed-agent-context.js');
const { _drainTrustSeedLocksForTests } = await import('../dist/lib/cli-adapters/claude.js');

const operatorConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'awb-test-operator-'));
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({
  claudeAiOauth: { accessToken: 'test-operator-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000 },
}));

const TICKET = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'account-1';
const WORKDIR = mkdtempSync(join(tmpdir(), 'awb-runtime-credential-work-'));

let originalFetch;
let server;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  server = {
    credential: { status: 200, body: { credential_id: 'cred-1', provider: 'claude_oauth_token', fields: { oauth_token: 'sk-ant-oat-ticket' } } },
    credentialFetches: 0,
    rejectedKeys: new Set(),
    provisions: [],
    credentialTargets: [],
    chatPosts: [],
    comments: [],
    acks: [],
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200, headers: { 'mcp-session-id': 'sid', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        if (body.params?.name === 'add_comment') server.comments.push(body.params.arguments);
        return Response.json({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } });
      }
      return new Response('', { status: 202 });
    }
    if (u.endsWith('/runtime-keys/validate')) {
      const key = new Headers(init.headers).get('X-Agent-Key');
      if (server.validationStatus) return new Response(null, { status: server.validationStatus });
      if (server.rejectedKeys.has(key)) return new Response(null, { status: 403 });
      return Response.json({ account_id: ACCOUNT, runtime_key: key.replace(/^key-/, ''), host_id: 'host-1' });
    }
    if (u.endsWith('/runtime-keys/provision')) {
      const { key, account_id } = JSON.parse(init.body);
      server.provisions.push({ key, account_id });
      return Response.json({ raw_key: `key-${key}`, key_id: 'k', key, account_id });
    }
    if (/\/managed-agents\/[^/]+\/credential\?/.test(u)) {
      server.credentialFetches += 1;
      server.credentialTargets.push(decodeURIComponent(u.match(/managed-agents\/([^/]+)/)[1]));
      // A slow server makes the race the production log showed: the trigger's
      // context resolution and spawn_agent overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { status, body } = server.credential;
      return status === 200 ? Response.json(body) : new Response(null, { status });
    }
    if (/\/chat-rooms\/[^/]+\/messages$/.test(u) && method === 'POST') {
      server.chatPosts.push(JSON.parse(init.body));
      return Response.json({});
    }
    if (u.endsWith('/api/agent-manager/dispatch/ack')) {
      server.acks.push(JSON.parse(init.body));
      return Response.json({});
    }
    if (u.includes('/api/agent/tickets/')) {
      return Response.json({ id: TICKET, title: 'Fix', account_id: ACCOUNT, status: 'in_progress', comments: [] });
    }
    return Response.json({});
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await _drainTrustSeedLocksForTests();
});

function host() {
  const contexts = new ManagedAgentContextRegistry();
  const registry = {
    upsert: () => ({ status: 'spawning' }),
    markRunning() {},
    markStopped() {},
    get() { return undefined; },
  };
  const config = { account_id: ACCOUNT, url: 'http://awb.test', apiKey: 'manager-key', delegation: { enabled: true } };
  const commands = new AgentManagerCommandHandler(config, {
    getInstanceId: () => 'instance-1',
    registry,
    contextRegistry: contexts,
  });
  const spawns = [];
  const chatSpawns = [];
  const history = [];
  const dispatcher = new EventDispatcher(config, {
    managedAgentContexts: contexts,
    chatSessionManager: {
      recordRoomMessage(p) { history.push(p); },
      async dispatch(args) { chatSpawns.push(args); return { dispatched: true, pid: 4242 }; },
    },
    agentManagerCommandHandler: commands,
    worktreeManager: {
      enabled: true,
      async resolveCwd() {
        return {
          isWorktree: true, cwd: WORKDIR, mode: 'per_ticket', reused: false,
          repositoryContext: {
            resourceId: 'project-1', cwd: WORKDIR, baseBranch: 'main', baseSha: 'a', currentSha: 'a',
            workingBranch: `ticket/${TICKET}-work`, dirty: false, ahead: 0, behind: 0, resumed: false,
          },
        };
      },
      async verifyCheckout() { return { ok: true }; },
      async verifyPushReadiness() { return { ok: true }; },
    },
    subagentManager: {
      canSpawn: () => true,
      async spawn(args) { spawns.push(args); return { spawned: true, pid: 4242 }; },
    },
  });
  return { commands, dispatcher, contexts, spawns, chatSpawns, history };
}

function spec(credentialId) {
  return {
    manager_agent_id: 'host-1', cli: 'claude', model: 'opus', working_dir: WORKDIR,
    credential_id: credentialId, runtime_config: null, label: 'ticket/claude',
  };
}

function trigger(runtime) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: runtimeIdentityKey(runtime),
    agent_id: runtimeIdentityKey(runtime),
    field_changed: `trigger-${Math.random()}`,
    trigger_source: 'start',
    account_id: ACCOUNT,
    status: 'in_progress',
    runtime,
    base_repo: { id: 'project-1', name: 'Web', url: 'https://github.com/acme/web.git', default_branch: 'main', main_clone_dir: WORKDIR },
    base_branch: 'main',
    worktree_mode: 'per_ticket',
  });
}

async function waitFor(pred, label) {
  for (let i = 0; i < 200 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(pred(), label);
}

test('a trigger for a runtime the host has never prepared runs with its selected credential', async () => {
  const { dispatcher, spawns } = host();
  await dispatcher.handleTrigger(trigger(spec('cred-1')));
  await waitFor(() => spawns.length === 1, JSON.stringify(server.acks));
  const ctx = spawns[0].agentContext;
  assert.equal(ctx.credential_id, 'cred-1');
  assert.equal(ctx.credential_provider, 'claude_oauth_token');
  assert.equal(ctx.extra_env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-ticket', 'the CLI process gets the credential');

  // Another model is the same identity (the key has no model): reused, not re-prepared.
  assert.equal(server.credentialFetches, 1);
  await dispatcher.handleTrigger(trigger({ ...spec('cred-1'), model: 'sonnet' }));
  await waitFor(() => spawns.length === 2, JSON.stringify(server.acks));
  assert.equal(server.credentialFetches, 1);
  assert.equal(spawns[1].agentContext.model, 'sonnet');
  assert.equal(spawns[1].agentContext.extra_env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-ticket');
});

test('the trigger racing the server\'s spawn_agent still runs with the credential', async () => {
  const { commands, dispatcher, spawns } = host();
  const runtime = spec('cred-1');
  await Promise.all([
    dispatcher.handleTrigger(trigger(runtime)),
    commands.handle(JSON.stringify({
      command_id: 'spawn-1', command: 'spawn_agent',
      args: { agent_id: runtimeIdentityKey(runtime), name: 'ticket/claude', cli: 'claude', working_dir: WORKDIR, model: 'opus', account_id: ACCOUNT, credential_id: 'cred-1' },
    })),
  ]);
  await waitFor(() => spawns.length === 1, JSON.stringify(server.acks));
  assert.equal(spawns[0].agentContext.extra_env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-ticket');
});

test('a selected credential that cannot be applied is refused, never run on the operator login', async () => {
  server.credential = { status: 503 };
  const { dispatcher, spawns, contexts } = host();
  const runtime = { ...spec('cred-gone'), working_dir: mkdtempSync(join(tmpdir(), 'awb-runtime-credential-gone-')) };
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => server.acks.length === 1, 'the trigger is answered');
  assert.equal(spawns.length, 0, 'nothing runs');
  assert.equal(contexts.get(runtimeIdentityKey(runtime)), null, 'nothing is registered');
  assert.deepEqual(server.acks.map((a) => [a.outcome, a.reason]), [['nack', RUNTIME_CREDENTIAL_BLOCKER]], 'nack → the server retries with backoff');
  assert.equal(server.comments.length, 1);
  assert.match(server.comments[0].content, /credential 적용 실패/);
  assert.match(server.comments[0].content, /cred-gon/);

  // The same failure again does not spam the ticket.
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => server.acks.length === 2, 'second trigger answered');
  assert.equal(server.comments.length, 1);
});

test('a runtime with no credential selected still runs on the operator login', async () => {
  server.credential = { status: 204 };
  const { dispatcher, spawns } = host();
  const runtime = { ...spec(null), working_dir: mkdtempSync(join(tmpdir(), 'awb-runtime-credential-none-')) };
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => spawns.length === 1, JSON.stringify(server.acks));
  assert.equal(spawns[0].agentContext.credential_id, null);
  assert.equal(spawns[0].agentContext.extra_env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('Agent Sessions and runtime identities refuse the same incomplete credential with the same code', async () => {
  const { acceptRuntimeCredential } = await import('../dist/lib/runtime-credential.js');
  const incomplete = { credential_id: 'cred-1', provider: 'claude_oauth_token', fields: { oauth_token: '  ' } };
  assert.throws(() => acceptRuntimeCredential('claude', 'cred-1', incomplete, 'test'), { code: 'credential_incomplete' });
  assert.throws(() => acceptRuntimeCredential('claude', 'cred-1', null, 'test'), { code: 'credential_unavailable' });
  assert.throws(
    () => acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, provider: 'codex_api_key', fields: { account_id: ACCOUNT, api_key: 'k' } }, 'test'),
    { code: 'credential_provider_mismatch' },
  );
  assert.throws(() => acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, credential_id: 'cred-2' }, 'test'), { code: 'credential_unavailable' });
  const wrapped = acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, fields: { oauth_token: 'sk-ant-oat-a\n b' } }, 'test');
  assert.equal(wrapped.fields.oauth_token, 'sk-ant-oat-ab');
});

function roomEvent(runtimes, overrides = {}) {
  return JSON.stringify({ payload: {
    room_id: 'room-1', account_id: ACCOUNT, sender_type: 'user', sender_id: 'user-1', content: 'hello',
    agent_member_ids: runtimes.map(runtimeIdentityKey),
    agent_member_runtimes: Object.fromEntries(runtimes.map((r) => [runtimeIdentityKey(r), r])),
    ...overrides,
  } });
}

for (const mode of ['direct', 'group']) {
  test(`${mode} chat applies the selected credential before its first turn`, async () => {
    const { dispatcher, chatSpawns } = host();
    const runtime = spec('cred-1');
    if (mode === 'direct') {
      await dispatcher.handleChatRequest(JSON.stringify({ payload: {
        room_id: 'room-1', account_id: ACCOUNT, agent_id: runtimeIdentityKey(runtime), runtime, content: 'hello',
      } }));
    } else {
      await dispatcher.handleChatRoomMessage(roomEvent([runtime]));
    }
    assert.equal(chatSpawns.length, 1);
    assert.equal(chatSpawns[0].agentContext.extra_env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-ticket');
    assert.equal(server.credentialFetches, 1);
  });
}

test('group chat ignores remote members before fetching credentials, including stale cached identities', async () => {
  const { dispatcher, contexts, chatSpawns, history } = host();
  const local = spec('cred-1');
  const remote = { ...local, manager_agent_id: 'host-2', working_dir: WORKDIR + '-remote' };
  contexts.upsert({
    agent_id: runtimeIdentityKey(remote), cli: remote.cli, working_dir: remote.working_dir,
    api_key: 'stale-key', mcp_config_path: '/stale/mcp.json', account_id: ACCOUNT,
  });
  await dispatcher.handleChatRoomMessage(roomEvent([remote, local]));
  assert.equal(chatSpawns.length, 1);
  assert.equal(chatSpawns[0].agentId, runtimeIdentityKey(local));
  assert.deepEqual(server.credentialTargets, [runtimeIdentityKey(local)]);
  assert.equal(server.chatPosts.length, 0);

  // The local reply is broadcast again; it must not cause this host to answer
  // as the remote member or emit a bogus credential-failure message for it.
  await dispatcher.handleChatRoomMessage(roomEvent([remote, local], {
    sender_type: 'agent', sender_id: runtimeIdentityKey(local),
  }));
  assert.equal(chatSpawns.length, 1);
  assert.equal(server.credentialFetches, 1);
  assert.equal(server.chatPosts.length, 0);
  assert.equal(history.length, 2);
});

test('group chat repairs a cached context with a selected id but no applied credential', async () => {
  const { dispatcher, contexts, chatSpawns } = host();
  const runtime = spec('cred-1');
  contexts.upsert({
    agent_id: runtimeIdentityKey(runtime), cli: runtime.cli, model: runtime.model,
    working_dir: runtime.working_dir, account_id: ACCOUNT, api_key: 'old-key',
    mcp_config_path: '/old/mcp.json', credential_id: 'cred-1', credential_provider: null,
  });
  await dispatcher.handleChatRoomMessage(roomEvent([runtime]));
  assert.equal(chatSpawns.length, 1);
  assert.equal(server.credentialFetches, 1);
  assert.equal(chatSpawns[0].agentContext.extra_env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-ticket');
});

test('a local chat credential failure prevents dispatch instead of using the manager login', async () => {
  server.credential = { status: 503 };
  const { dispatcher, chatSpawns } = host();
  await dispatcher.handleChatRoomMessage(roomEvent([spec('cred-1')]));
  assert.equal(chatSpawns.length, 0);
  assert.equal(server.chatPosts.length, 1);
  assert.match(server.chatPosts[0].content, /credential 적용 실패/);
});

test('targeted chat and ticket events for another host are ignored even if the runtime key is cached', async () => {
  const { dispatcher, contexts, chatSpawns, spawns } = host();
  const runtime = { ...spec('cred-1'), manager_agent_id: 'host-2' };
  contexts.upsert({
    agent_id: runtimeIdentityKey(runtime), cli: runtime.cli, working_dir: runtime.working_dir,
    api_key: 'cached-key', mcp_config_path: '/cached/mcp.json', account_id: ACCOUNT,
  });
  await dispatcher.handleChatRequest(JSON.stringify({ payload: {
    room_id: 'room-1', account_id: ACCOUNT, agent_id: runtimeIdentityKey(runtime), runtime,
  } }));
  await dispatcher.handleTrigger(trigger(runtime));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(chatSpawns.length + spawns.length, 0);
  assert.equal(server.credentialFetches, 0);
  assert.equal(server.acks.length, 0);
  assert.equal(server.chatPosts.length, 0);
});

test.after(async () => {
  await fsp.rm(process.env.AWB_AGENT_MANAGER_HOME, { recursive: true, force: true });
  await fsp.rm(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  if (operatorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = operatorConfigDir;
});

for (const rebind of [false, true]) {
  test(`foreign rehydrated key is replaced before dispatch (server_meta=${rebind})`, async () => {
    const { dispatcher, contexts, spawns } = host();
    const runtime = spec('cred-1');
    const id = runtimeIdentityKey(runtime);
    contexts.upsert({ agent_id: id, account_id: 'old-account', api_key: 'foreign-key',
      cli: runtime.cli, working_dir: WORKDIR, mcp_config_path: '/old-account/mcp.json',
      credential_id: 'cred-1', credential_provider: 'claude_oauth_token' });
    if (rebind) {
      dispatcher.bindAccount(ACCOUNT);
      assert.equal(contexts.get(id), null, 'server_meta must discard, never relabel the old credential tuple');
    }
    await dispatcher.handleTrigger(trigger(runtime));
    await waitFor(() => spawns.length === 1, JSON.stringify(server.acks));
    const ctx = spawns[0].agentContext;
    assert.equal(ctx.account_id, ACCOUNT);
    assert.equal(ctx.api_key, `key-${id}`);
    assert.ok(ctx.mcp_config_path.includes(ACCOUNT));
    assert.equal(JSON.parse(await fsp.readFile(ctx.mcp_config_path, 'utf8')).mcpServers.awb.headers.Authorization, `Bearer key-${id}`);
  });
}

test('rejected in-memory and disk keys are repaired before a ticket session receives them', async () => {
  const { dispatcher, contexts, spawns } = host();
  const runtime = spec('cred-1');
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => spawns.length === 1, 'initial spawn');
  const id = runtimeIdentityKey(runtime);
  const { writeApiKey } = await import('../dist/lib/managed-agent-store.js');
  contexts.get(id).api_key = 'revoked-key';
  await writeApiKey(id, 'revoked-key', ACCOUNT);
  server.rejectedKeys.add('revoked-key');
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => spawns.length === 2, 'repaired spawn');
  assert.equal(spawns[1].agentContext.api_key, `key-${id}`);
  assert.equal(server.provisions.at(-1).account_id, ACCOUNT);
});

test('validation outage cannot start a session or rotate its key', async () => {
  const { dispatcher, spawns } = host();
  const runtime = spec('cred-1');
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => spawns.length === 1, 'initial spawn');
  const issued = server.provisions.length;
  server.validationStatus = 503;
  await dispatcher.handleTrigger(trigger(runtime));
  await waitFor(() => server.acks.some(a => a.outcome === 'nack' && a.reason === 'runtime_api_key_unavailable'), 'validation failure is retried');
  assert.equal(spawns.length, 1);
  assert.equal(server.provisions.length, issued);
});
