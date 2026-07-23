import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  EventDispatcher,
  PI_TICKET_DISPATCH_BLOCK_REASON,
} from '../dist/lib/event-dispatcher.js';

const AGENT = 'agent-pi-guard';
let originalFetch;
let toolCalls;
let dispatchAcks;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  toolCalls = [];
  dispatchAcks = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'pi-guard', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        toolCalls.push({ name: body.params?.name, args: body.params?.arguments });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      dispatchAcks.push(JSON.parse(init?.body || '{}'));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context(cli) {
  return {
    agent_id: AGENT,
    name: 'PI guard agent',
    cli,
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

function harness(cli) {
  const state = { spawns: [], worktrees: 0 };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context(cli) : null),
    has: (id) => id === AGENT,
    list: () => [context(cli)],
  };
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      state.worktrees += 1;
      return { isWorktree: true, cwd: '/workspace/.awb/wt/ticket', mode: 'per_ticket', reused: false };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const subagentManager = {
    canSpawn: () => true,
    async spawn(args) {
      state.spawns.push(args);
      return { spawned: true, pid: 4242 };
    },
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts, worktreeManager, subagentManager },
  );
  return { dispatcher, state };
}

function ticketTrigger() {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: 'ticket-pi-guard',
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trigger-1',
    trigger_source: 'column_move',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
  });
}

function chatRequest() {
  return JSON.stringify({
    event_type: 'chat_request',
    timestamp: '2026-07-23T00:00:00.000Z',
    payload: {
      agent_id: AGENT,
      room_id: 'room-1',
      user_id: 'user-1',
      new_message: 'hello PI',
    },
  });
}

test('PI ticket dispatch is rejected before worktree/spawn with an actionable comment and durable nack', async () => {
  const { dispatcher, state } = harness('pi');

  await dispatcher.handleTrigger(ticketTrigger());

  assert.equal(state.worktrees, 0, 'PI ticket guard runs before worktree provisioning');
  assert.equal(state.spawns.length, 0, 'PI ticket never spawns');
  assert.equal(toolCalls.filter((call) => call.name === 'add_comment').length, 1);
  assert.match(toolCalls.find((call) => call.name === 'add_comment').args.content, /MCP.*지원하지 않아/);
  assert.match(toolCalls.find((call) => call.name === 'add_comment').args.content, /chat 전용/);
  assert.equal(toolCalls.filter((call) => call.name === 'pend_ticket').length, 1);
  for (let i = 0; i < 4 && dispatchAcks.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'nack', reason: PI_TICKET_DISPATCH_BLOCK_REASON }],
  );
});

test('PI chat dispatch remains supported and spawns a chat one-shot', async () => {
  const { dispatcher, state } = harness('pi');

  await dispatcher.handleChatRequest(chatRequest());

  assert.equal(state.spawns.length, 1);
  assert.equal(state.spawns[0].kind, 'chat');
  assert.equal(state.spawns[0].agentContext.cli, 'pi');
  assert.equal(toolCalls.some((call) => call.name === 'pend_ticket'), false);
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} ticket dispatch is unaffected and still spawns`, async () => {
    const { dispatcher, state } = harness(cli);

    await dispatcher.handleTrigger(ticketTrigger());

    assert.equal(state.worktrees, 1);
    assert.equal(state.spawns.length, 1);
    assert.equal(state.spawns[0].kind, 'trigger');
    assert.equal(state.spawns[0].agentContext.cli, cli);
    assert.equal(toolCalls.some((call) => call.name === 'pend_ticket'), false);
  });
}
