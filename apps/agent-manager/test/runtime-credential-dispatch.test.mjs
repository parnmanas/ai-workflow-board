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
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-runtime-credential-'));

const { EventDispatcher, runtimeIdentityKey, RUNTIME_CREDENTIAL_BLOCKER } = await import('../dist/lib/event-dispatcher.js');
const { AgentManagerCommandHandler } = await import('../dist/lib/agent-manager-commands.js');
const { ManagedAgentContextRegistry } = await import('../dist/lib/managed-agent-context.js');
const { _drainTrustSeedLocksForTests } = await import('../dist/lib/cli-adapters/claude.js');

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
    if (u.endsWith('/runtime-keys/provision')) {
      const { key, account_id } = JSON.parse(init.body);
      return Response.json({ raw_key: `key-${key}`, key_id: 'k', key, account_id });
    }
    if (/\/managed-agents\/[^/]+\/credential\?/.test(u)) {
      server.credentialFetches += 1;
      // A slow server makes the race the production log showed: the trigger's
      // context resolution and spawn_agent overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { status, body } = server.credential;
      return status === 200 ? Response.json(body) : new Response(null, { status });
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
  const config = { url: 'http://awb.test', apiKey: 'manager-key', delegation: { enabled: true } };
  const commands = new AgentManagerCommandHandler(config, {
    getInstanceId: () => 'instance-1',
    registry,
    contextRegistry: contexts,
  });
  const spawns = [];
  const dispatcher = new EventDispatcher(config, {
    managedAgentContexts: contexts,
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
  return { commands, dispatcher, contexts, spawns };
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
    () => acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, provider: 'codex_api_key', fields: { api_key: 'k' } }, 'test'),
    { code: 'credential_provider_mismatch' },
  );
  assert.throws(() => acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, credential_id: 'cred-2' }, 'test'), { code: 'credential_unavailable' });
  const wrapped = acceptRuntimeCredential('claude', 'cred-1', { ...incomplete, fields: { oauth_token: 'sk-ant-oat-a\n b' } }, 'test');
  assert.equal(wrapped.fields.oauth_token, 'sk-ant-oat-ab');
});

test.after(async () => {
  await fsp.rm(process.env.AWB_AGENT_MANAGER_HOME, { recursive: true, force: true });
});
