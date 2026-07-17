// Integration test — shared warm-pool exhaustion recovery + durable signal (ticket d34075b5).
//
// Drives the REAL EventDispatcher across its worktree-provisioning gate to prove
// the pool_exhausted fast-path:
//   (1) a shared-mode dispatch that hits `pool_exhausted` kicks an ON-DEMAND lease
//       reclaim; if that frees a slot the dispatch retries provisioning INLINE and
//       recovers autonomously in the SAME pass — exactly one strand spawns, no
//       server re-push, no comment, no pend;
//   (2) every exhaustion is recorded on the durable, server-visible heartbeat
//       metric (`dispatch_block_counts['worktree:pool_exhausted']`) — the signal
//       that was previously invisible until e7c87517's 24h backstop;
//   (3) when nothing is reclaimable the dispatch falls through to the blocker path,
//       posts a POOL-SPECIFIC comment (not the misleading "Git 체크아웃 실패" one),
//       and does NOT pend on the first abort (pool_exhausted is transient);
//   (4) with no poolReclaimTrigger wired the fast-path degrades to the legacy abort
//       but still records the signal.
//
// Harness mirrors provisioning-block-pend.test.mjs: a stateful /mcp mock so the
// pend transition + comment text are asserted for real, and a faithful
// single-flight subagentManager fake.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { DispatchBlockTracker } from '../dist/lib/dispatch-preflight.js';
import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';

const AGENT = 'agent-rolf';
const TICKET = 'ticket-pool';

function makeCtx() {
  return {
    agent_id: AGENT,
    name: 'Rolf',
    cli: 'claude',
    working_dir: '/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    cli_home_dir: '/cli-home/rolf',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

let originalFetch;
let mcpToolCalls; // [{ name, args }] of tools/call invoked over /mcp
let ticketState;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  ticketState = { pending_user_action: false };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-test', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        mcpToolCalls.push({ name, args: body.params?.arguments ?? {} });
        if (name === 'pend_ticket') ticketState.pending_user_action = true;
        if (name === 'unpend_ticket') ticketState.pending_user_action = false;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful single-flight subagentManager (same as provisioning-block-pend).
function makeSubagentManager(state) {
  const records = new Map();
  let resCounter = 0;
  return {
    canSpawn: () => true,
    async spawn(spec) {
      const dup = findDuplicateSpawn(records.values(), spec);
      if (dup) {
        state.dedups.push({ trigger: spec.triggerId, reason: dup });
        return { spawned: false, reason: dup };
      }
      const id = --resCounter;
      records.set(id, {
        kind: spec.kind,
        trigger_id: spec.triggerId || null,
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        role: spec.role || null,
        agent_id: spec.agentId || null,
      });
      state.spawns.push(spec);
      return { spawned: true, pid: 4200 - id };
    },
  };
}

// worktreeManager fake: resolveCwd returns pool_exhausted while the pool is FULL,
// a valid worktree once a slot is free. The on-demand reclaim (poolReclaimTrigger)
// frees `reclaimFrees` slots — set 0 to model "nothing reclaimable".
function makeDispatcher(state) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      state.resolveCalls += 1;
      if (state.poolFull) return { isWorktree: false, reason: 'pool_exhausted' };
      return { isWorktree: true, cwd: '/ws/.awb/wt/shared-0', mode: 'shared', reused: false };
    },
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
  const deps = {
    worktreeManager,
    subagentManager: makeSubagentManager(state),
    managedAgentContexts,
    dispatchBlockTracker: state.blockTracker,
  };
  if (!state.noReclaimTrigger) {
    deps.poolReclaimTrigger = async () => {
      state.reclaimCalls += 1;
      if (state.reclaimFrees > 0) {
        state.poolFull = false; // a slot just freed
        return state.reclaimFrees;
      }
      return 0;
    };
  }
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    deps,
  );
}

function newState(overrides = {}) {
  return {
    resolveCalls: 0,
    reclaimCalls: 0,
    spawns: [],
    dedups: [],
    poolFull: true,
    reclaimFrees: 1,
    blockTracker: new DispatchBlockTracker(),
    ...overrides,
  };
}

// worktree_mode='shared' so resolveCwd is asked for a pool slot.
function makeEvent(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'column_move',
    worktree_mode: 'shared',
    max_concurrent_tickets_per_agent: 1,
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const countTool = (name) => mcpToolCalls.filter((c) => c.name === name).length;
const commentContent = () => mcpToolCalls.filter((c) => c.name === 'add_comment').map((c) => c.args.content).join('\n');

// ── (1) on-demand reclaim frees a slot → inline recovery, one strand, signal recorded ──

test('pool_exhausted + reclaimable lease → on-demand reclaim + inline retry recovers in the same dispatch', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 1 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  assert.equal(state.reclaimCalls, 1, 'on-demand pool reclaim was kicked exactly once');
  assert.equal(state.resolveCalls, 2, 'provisioning retried INLINE after the reclaim freed a slot');
  assert.equal(state.spawns.length, 1, 'the dispatch recovered autonomously — exactly one strand spawned');
  assert.equal(state.spawns[0].ticketId, TICKET);
  // Durable server-visible signal recorded even though the dispatch recovered.
  assert.deepEqual(
    d.dispatchBlockCounts(),
    { 'worktree:pool_exhausted': 1 },
    'the exhaustion is counted on the heartbeat metric (recovered or not)',
  );
  // Autonomous recovery is silent: no comment, no pend.
  assert.equal(countTool('add_comment'), 0, 'a recovered dispatch posts no blocker comment');
  assert.equal(countTool('pend_ticket'), 0, 'a recovered dispatch never pends');
  assert.equal(ticketState.pending_user_action, false);
});

// ── (2) nothing reclaimable → fall through: pool-specific comment, no first-abort pend ──

test('pool_exhausted + nothing reclaimable → falls through with a POOL-specific comment, no first-abort pend', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'b1' }));

  assert.equal(state.reclaimCalls, 1, 'reclaim was still attempted');
  assert.equal(state.resolveCalls, 1, 'no inline retry when the reclaim freed nothing');
  assert.equal(state.spawns.length, 0, 'no strand spawned while the pool stays exhausted');
  assert.deepEqual(d.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'counted exactly once (no fast-path/fall-through double count)');
  assert.equal(countTool('add_comment'), 1, 'the block posts a single comment');
  const c = commentContent();
  assert.match(c, /pool_exhausted|풀 고갈/, 'the comment is pool-specific, not the generic checkout-failure message');
  assert.doesNotMatch(c, /유효한 Git 체크아웃/, 'must NOT reuse the misleading broken-checkout copy for pool exhaustion');
  // pool_exhausted is a TRANSIENT blocker → no pend on the first abort (contrast to
  // a durable not_a_git_repo, which pends immediately).
  assert.equal(countTool('pend_ticket'), 0, 'pool_exhausted does NOT pend on the first abort');
  assert.equal(ticketState.pending_user_action, false);
});

// ── (3) no poolReclaimTrigger wired → legacy abort, but the signal is still recorded ──

test('pool_exhausted with no reclaim trigger wired → legacy abort, signal still recorded', async () => {
  const state = newState({ poolFull: true, noReclaimTrigger: true });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'c1' }));

  assert.equal(state.reclaimCalls, 0, 'no reclaim trigger → none invoked');
  assert.equal(state.resolveCalls, 1, 'no inline retry without a reclaim');
  assert.equal(state.spawns.length, 0, 'no strand spawned');
  assert.deepEqual(d.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'the durable signal is recorded regardless');
});

// ── (4) persistent pool_exhausted eventually pends after the transient threshold ──

test('a persistent pool_exhausted pends only after the transient threshold, counting each abort', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  // Three non-supervisor (state-changed) aborts reach DEFAULT_PEND_AFTER_ABORTS (3).
  await d.handleTrigger(makeEvent({ field_changed: 'p1' }));
  assert.equal(countTool('pend_ticket'), 0, 'no pend at abort 1');
  await d.handleTrigger(makeEvent({ field_changed: 'p2' }));
  assert.equal(countTool('pend_ticket'), 0, 'no pend at abort 2');
  await d.handleTrigger(makeEvent({ field_changed: 'p3' }));
  assert.equal(countTool('pend_ticket'), 1, 'a persistent pool_exhausted finally pends after the threshold');

  assert.equal(state.spawns.length, 0, 'no strand across the whole exhausted episode');
  assert.equal(d.dispatchBlockCounts()['worktree:pool_exhausted'], 3, 'each exhaustion abort is counted');
  assert.equal(state.reclaimCalls, 3, 'each abort attempts an on-demand reclaim first');
});

// ── (5) reclaim throws → treated as 0 freed, dispatch still degrades gracefully ──

test('on-demand reclaim that throws is swallowed (treated as 0 freed) — dispatch never wedges', async () => {
  // A dispatcher whose poolReclaimTrigger rejects — the fast-path must .catch() it.
  const throwState = newState({ poolFull: true });
  const throwing = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    {
      worktreeManager: {
        async resolveCwd() { throwState.resolveCalls += 1; return { isWorktree: false, reason: 'pool_exhausted' }; },
        async verifyCheckout() { return { ok: true }; },
        async verifyPushReadiness() { return { ok: true }; },
        async removeTicketWorktrees() { return 0; },
        async removeTicketRunWorkspace() { return false; },
      },
      subagentManager: makeSubagentManager(throwState),
      managedAgentContexts: {
        get: (id) => (id === AGENT ? makeCtx() : null),
        has: (id) => id === AGENT,
        list: () => [{ working_dir: '/ws' }],
      },
      dispatchBlockTracker: throwState.blockTracker,
      poolReclaimTrigger: async () => { throw new Error('reclaim boom'); },
    },
  );

  await throwing.handleTrigger(makeEvent({ field_changed: 'e1' }));
  assert.equal(throwState.resolveCalls, 1, 'a throwing reclaim → no inline retry (0 freed), no crash');
  assert.equal(throwState.spawns.length, 0, 'no strand spawned');
  assert.deepEqual(throwing.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'signal still recorded despite the reclaim error');
});
