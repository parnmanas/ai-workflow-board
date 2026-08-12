import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket 38fba2d3: #dispatchTriggerBody (column-trigger Hermes dispatch, distinct
// from handleCommentMention's mention-dispatch path e8105c84 already fixed) had the
// same unguarded pattern — dispatchHermes() resolving without throwing was ack'd
// 'processed' regardless of result.stopReason, so a non-end_turn stop (refusal,
// max_tokens, a denied tool call, …) silently counted as success: no
// spawnFailureTracker signal, no nack, nothing for the dispatch-intent retry/backoff
// machinery to react to. This mirrors hermes-mention-dispatch-outcome.test.mjs's
// stopReason-driven cases via the same real RuntimeSupervisor + fake-acp-server.mjs
// fixture, but through handleTrigger()/#ackDispatch (the trigger path's existing ack
// channel) instead of a ticket comment (the mention path has no ack channel).
//
// NOTE: this test's agent context deliberately omits `cli_home_dir` — with it set
// (the real production shape; agent-manager-commands.ts always populates it
// regardless of cli type), #dispatchTriggerBody's CLI-readiness gate (~line 2278)
// calls createAdapter('hermes'), which throws before ever reaching the Hermes branch
// this ticket fixes. That's a separate, pre-existing bug, filed as
// #[ticket:73772059-fd17-486f-b195-ca7ed6db75bb|#dispatchTriggerBody CLI-readiness 게이트가 Hermes cli 트리거를 spawn 전에 무조건 크래시시킴 (ack 전무)].

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-hermes-trigger-outcome';
const TICKET = 'ticket-hermes-trigger-outcome';

let originalFetch;
let mcpToolCalls;
let dispatchAcks;
let ticketGetCount;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  dispatchAcks = [];
  ticketGetCount = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-trigger-outcome', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        mcpToolCalls.push(body.params?.name);
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
    if (target.includes('/api/agent/tickets/')) {
      ticketGetCount += 1;
      return new Response(
        JSON.stringify({ id: TICKET, comments: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context(permissionMode) {
  return {
    agent_id: AGENT,
    name: 'Hermes trigger outcome agent',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    // deliberately no cli_home_dir — see file header note.
    extra_env: {},
    credential_provider: null,
    model: null,
    runtime_config: { strategy: 'single', permission_mode: permissionMode, profile: 'coding' },
  };
}

async function harness(t, permissionMode) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-trigger-outcome-'));
  const runtimeSupervisor = new RuntimeSupervisor({
    rootDir,
    command: process.execPath,
    args: [fixture],
    awbUrl: 'http://127.0.0.1:0',
  });
  t.after(async () => {
    await runtimeSupervisor.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context(permissionMode) : null),
    has: (id) => id === AGENT,
    list: () => [context(permissionMode)],
  };
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      return { isWorktree: true, cwd: '/workspace/.awb/wt/ticket', mode: 'per_ticket', reused: false };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts, worktreeManager, runtimeSupervisor },
  );
  return { dispatcher };
}

function ticketTrigger() {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trigger-1',
    trigger_source: 'column_move',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
  });
}

async function waitForAck() {
  for (let i = 0; i < 8 && dispatchAcks.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('case 1: stop=end_turn → ack processed, degraded signal clears', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleTrigger(ticketTrigger());
  await waitForAck();

  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'processed', reason: '' }],
  );
  assert.ok(ticketGetCount >= 1, 'expected the prompt-composition ticket fetch');

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('case 2 (ticket 38fba2d3): stop=refusal (non-end_turn) → ack nack, spawnFailureTracker records failure, no ticket-comment channel used', async (t) => {
  const { dispatcher } = await harness(t, 'strict');

  await dispatcher.handleTrigger(ticketTrigger());
  await waitForAck();

  // Previously: unconditionally ack'd 'processed' regardless of stopReason — this
  // pins the fix down as a regression test.
  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'nack', reason: 'refusal' }],
  );

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /refusal/);

  // The trigger path has no chat room / ticket-comment channel wired for this
  // failure (unlike the pre-spawn worktree/CLI-readiness/push-credential blockers) —
  // #ackDispatch('nack', ...) is the whole signal, matching every other in-function
  // failure path's existing convention (e.g. the runtime_protocol_error catch below).
  assert.equal(mcpToolCalls.filter((name) => name === 'add_comment').length, 0);
});
