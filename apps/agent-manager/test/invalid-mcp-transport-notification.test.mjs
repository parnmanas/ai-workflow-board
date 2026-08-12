// Integration test — invalid_mcp_transport durable-blocker notification + pend
// + nack, driven through the REAL EventDispatcher (ticket da4358ee review
// round 2, blocker #2).
//
// The prior regression coverage for this ticket split across two files, and
// NEITHER exercised the actual new wiring end to end:
//   - dispatch-preflight.test.mjs unit-tests classifySpawnException() in
//     isolation (no EventDispatcher, no notification text, no MCP calls).
//   - apps/server/test/qa-flows/dispatch-reconciler-loop.test.mjs's subtest 14
//     writes `pending_user_action: true` directly onto the ticket row instead
//     of driving a real pend, so it only re-proves "a parked ticket freezes
//     dispatch_generation" — an assertion that would pass even if
//     EventDispatcher never posted a comment, never called pend_ticket, and
//     never named the right config key.
//
// This test closes that gap on the manager side: it drives EventDispatcher.
// handleTrigger() through the ACTUAL one-shot delegation path with a
// subagentManager.spawn() that reproduces exactly what production
// SubagentManager.spawn()'s catch block does (subagent-manager.ts) — run a
// REAL config through the REAL validateCodexMcpServers() validator, catch the
// REAL InvalidMcpTransportError it throws, and classify it with the REAL
// classifySpawnException(). Only the child_process spawn itself is faked (no
// test in this repo shells out to a real codex binary).
//
// It proves the review's minimum bar:
//   - exactly ONE ticket comment naming the ACTUAL offending config key (a
//     broken `mcp_servers.github` must say "github", not a hardcoded "awb" —
//     the exact bug review blocker #1 reported) and the last error;
//   - exactly ONE pend_ticket call;
//   - the dispatch ack sent to the server is a 'nack' with reason
//     'invalid_mcp_transport' (what lets the reconciler in
//     dispatch-reconciler-loop.test.mjs's subtest 14 resolve the intent as
//     'parked' instead of re-dispatching);
//   - a supervisor re-trigger racing the async pend_ticket call is suppressed
//     before it can re-comment or re-spawn (no repeat storm).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { validateCodexMcpServers, InvalidMcpTransportError } from '../dist/lib/cli-adapters/codex.js';
import { classifySpawnException } from '../dist/lib/dispatch-preflight.js';

const AGENT = 'agent-codex';
const TICKET = 'ticket-mcp-transport';

function makeCtx() {
  return {
    agent_id: AGENT,
    name: 'Codex agent',
    cli: 'codex', // requiresWorkspaceTrust() is false for every non-claude adapter (base.ts default)
    working_dir: '/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    cli_home_dir: '/cli-home/codex',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

let originalFetch;
let mcpToolCalls; // { name, args }
let dispatchAcks; // POSTed /api/agent-manager/dispatch/ack bodies

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  dispatchAcks = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-mcp-transport', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        mcpToolCalls.push({ name: body.params?.name, args: body.params?.arguments });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    if (u.endsWith('/api/agent-manager/dispatch/ack')) {
      dispatchAcks.push(JSON.parse(init?.body || '{}'));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful subagentManager.spawn(): runs a REAL broken codex config through
// the REAL validateCodexMcpServers() validator and the REAL
// classifySpawnException(), exactly mirroring SubagentManager.spawn()'s catch
// block (subagent-manager.ts: `const { reason, detail, serverKey } =
// classifySpawnException(err); return { spawned: false, reason, detail,
// serverKey };`). `serverName` lets each test pick which mcp_servers.<name>
// table is broken.
function makeSubagentManager(state, serverName) {
  return {
    canSpawn: () => true,
    async spawn(spec) {
      state.spawns.push(spec);
      try {
        validateCodexMcpServers(
          { mcp_servers: { [serverName]: { http_headers: { 'X-AWB-Client-Type': 'managed-subagent' } } } },
          `/cli-home/codex/${serverName}-config.toml`,
        );
        throw new Error('test setup bug: validateCodexMcpServers should have thrown');
      } catch (err) {
        if (!(err instanceof InvalidMcpTransportError)) throw err;
        const { reason, detail, serverKey } = classifySpawnException(err);
        return { spawned: false, reason, detail, serverKey };
      }
    },
  };
}

function makeDispatcher(state, serverName) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() { return { isWorktree: true, cwd: '/ws/.awb/wt/ok', mode: 'per_ticket', reused: false }; },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? makeCtx() : null),
    has: (id) => id === AGENT,
    list: () => [{ working_dir: '/ws' }],
  };
  // No ticketSessionManager → the one-shot subagent path runs, whose spawn()
  // (our faithful fake) is what raises invalid_mcp_transport.
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager: makeSubagentManager(state, serverName), managedAgentContexts },
  );
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'column_move',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const toolCalls = (name) => mcpToolCalls.filter((c) => c.name === name);

test('invalid_mcp_transport on a NON-awb server key: the comment names the actual key, not a hardcoded "awb"', async () => {
  const state = { spawns: [] };
  const d = makeDispatcher(state, 'github');

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  assert.equal(state.spawns.length, 1, 'the one-shot spawn attempt ran');
  const comments = toolCalls('add_comment');
  assert.equal(comments.length, 1, 'exactly one ticket comment posted');
  const content = comments[0].args.content;
  assert.match(content, /mcp_servers\.github/, 'names the ACTUAL broken key (github)');
  assert.doesNotMatch(content, /mcp_servers\.awb/, 'must NOT hardcode "awb" when a different key is broken');
  assert.match(content, /has no resolvable transport/, 'includes the last validator error');

  assert.equal(toolCalls('pend_ticket').length, 1, 'exactly one pend_ticket call');

  assert.equal(dispatchAcks.length, 1, 'exactly one dispatch ack sent');
  assert.equal(dispatchAcks[0].outcome, 'nack', 'nacked so the server outbox stops treating it as owed');
  assert.equal(dispatchAcks[0].reason, 'invalid_mcp_transport');
  assert.equal(dispatchAcks[0].ticket_id, TICKET);
});

test('invalid_mcp_transport on the awb server key: still correctly named (no regression for the common case)', async () => {
  const state = { spawns: [] };
  const d = makeDispatcher(state, 'awb');

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  const comments = toolCalls('add_comment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].args.content, /mcp_servers\.awb/);
  assert.equal(dispatchAcks[0].reason, 'invalid_mcp_transport');
});

test('a supervisor re-trigger during the same still-broken episode is suppressed before it can re-comment or re-spawn (no storm)', async () => {
  // Mirrors provisioning-block-pend.test.mjs's "While pended, a supervisor
  // re-trigger is dropped BEFORE re-provisioning": this is the actual repeat
  // path a durably-blocked ticket sees in production — TriggerLoopService
  // drops human/state-changed triggers for a pended ticket server-side, so
  // the only re-trigger source the manager itself must still damp is a
  // supervisor sweep racing the async pend_ticket call.
  const state = { spawns: [] };
  const d = makeDispatcher(state, 'github');

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(toolCalls('add_comment').length, 1);
  assert.equal(toolCalls('pend_ticket').length, 1);
  const spawnsAfterFirst = state.spawns.length;

  await d.handleTrigger(makeEvent({ trigger_source: 'supervisor', field_changed: 'sup1' }));
  assert.equal(state.spawns.length, spawnsAfterFirst, 'supervisor re-trigger suppressed before it can reach spawn()');
  assert.equal(toolCalls('add_comment').length, 1, 'no duplicate comment');
  assert.equal(toolCalls('pend_ticket').length, 1, 'no duplicate pend');
});
