import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

const AGENT = 'agent-context-preflight';
const TICKET = 'ticket-context-preflight';
let originalFetch;
let acks;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  acks = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/api/agent/tickets/')) {
      return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      acks.push(JSON.parse(init?.body || '{}'));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context() {
  return {
    agent_id: AGENT,
    name: 'Context preflight agent',
    cli: 'claude',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    workspace_id: 'workspace-1',
    cli_home_dir: '/cli-home',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

function trigger() {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trigger-1',
    trigger_source: 'column_move',
    current_column_id: 'column-1',
    current_column_name: '진행 중',
    current_column_kind: 'active',
    worktree_mode: 'shared',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
  });
}

function dependencies({ persistent }) {
  const calls = { persistent: 0, stateless: 0 };
  const repositoryContext = {
    resourceId: 'repo-1', cwd: '/workspace/.awb/wt/ticket', baseBranch: 'main',
    baseSha: 'base-sha', currentSha: 'head-sha', workingBranch: 'ticket/context-work',
    dirty: false, ahead: 0, behind: 0, resumed: false,
  };
  const deps = {
    managedAgentContexts: {
      get: (id) => (id === AGENT ? context() : null),
      has: (id) => id === AGENT,
      list: () => [context()],
    },
    worktreeManager: {
      enabled: true,
      async resolveCwd() {
        return { isWorktree: true, cwd: repositoryContext.cwd, mode: 'shared', reused: false, repositoryContext };
      },
      async verifyCheckout() { return { ok: true }; },
      async verifyPushReadiness() { return { ok: true }; },
      async removeTicketWorktrees() { return 0; },
      async removeTicketRunWorkspace() { return false; },
    },
    subagentManager: {
      canSpawn: () => true,
      async spawn() { calls.stateless += 1; return { spawned: true, pid: 42 }; },
    },
  };
  if (persistent) {
    deps.ticketSessionManager = {
      async dispatchTrigger() { calls.persistent += 1; return { dispatched: true, pid: 41, firstTurn: true }; },
    };
  }
  return { deps, calls };
}

async function waitForAck() {
  for (let i = 0; i < 20 && acks.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('ticket 조회 null이면 persistent 세션 실행 전에 preflight nack한다', async () => {
  const { deps, calls } = dependencies({ persistent: true });
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true, persistentTicketSessions: true } },
    deps,
  );

  await dispatcher.handleTrigger(trigger());
  await waitForAck();

  assert.equal(calls.persistent, 0);
  assert.equal(calls.stateless, 0);
  assert.deepEqual(acks.map(({ outcome, reason }) => ({ outcome, reason })), [
    { outcome: 'nack', reason: 'agent_context_ticket_missing' },
  ]);
});

test('ticket 조회 null이면 stateless spawn 전에 preflight nack한다', async () => {
  const { deps, calls } = dependencies({ persistent: false });
  const dispatcher = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true, persistentTicketSessions: false } },
    deps,
  );

  await dispatcher.handleTrigger(trigger());
  await waitForAck();

  assert.equal(calls.stateless, 0);
  assert.deepEqual(acks.map(({ outcome, reason }) => ({ outcome, reason })), [
    { outcome: 'nack', reason: 'agent_context_ticket_missing' },
  ]);
});
