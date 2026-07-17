// Integration test — shared warm-pool exhaustion recovery + durable signal (ticket d34075b5).
//
// Drives the REAL EventDispatcher across its worktree-provisioning gate to prove the
// pool_exhausted fast-path AND the review follow-up: a manager-owned bounded-backoff
// RETRY QUEUE that recovers a starved dispatch WITHOUT a lucky server re-push.
//   (1) a shared-mode dispatch that hits `pool_exhausted` kicks an ON-DEMAND lease
//       reclaim; if that frees a slot the dispatch retries provisioning INLINE and
//       recovers autonomously in the SAME pass — one strand, no re-push, no comment;
//   (2) every exhaustion is recorded on the durable, server-visible heartbeat metric
//       (`dispatch_block_counts['worktree:pool_exhausted']`);
//   (3) when nothing is reclaimable the dispatch is QUEUED (pool-specific comment, no
//       first-abort pend) and then recovers with EXACTLY ONE spawn when a slot frees —
//       driven by the retry's own backoff (grace-passed on-demand reclaim) OR a
//       slot-release wake — with NO server re-push;
//   (4) a duplicate trigger while a retry is queued dedupes (no twin);
//   (5) a moved / pended / terminal ticket cancels the queued retry;
//   (6) a persistently-exhausted pool gives up after the attempt bound → pends for
//       the operator (e7c87517's 24h no-progress backstop remains the ultimate net).
//
// Harness mirrors provisioning-block-pend.test.mjs: a stateful /mcp mock so the pend
// transition + comment text are asserted for real, a faithful single-flight
// subagentManager fake, and an injected manual scheduler so the backoff is driven
// deterministically (no real wall-clock waits).

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
let ticketState;  // served for GET /api/agent/tickets/:id — drives the retry verify

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  ticketState = { pending_user_action: false, terminal_entered_at: null };
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
    // Ticket-context REST (the retry's pre-replay eligibility check reads this).
    if (u.includes('/api/agent/tickets/')) {
      return new Response(JSON.stringify(ticketState), { status: 200, headers: { 'content-type': 'application/json' } });
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

// A manual scheduler so the backoff timer fires on demand (no real wall-clock). The
// retry's #attempt is async (verify + handleTrigger replay), so fire() drains enough
// macrotask cycles to let the whole immediate-fake chain settle.
const settle = () => new Promise((r) => setImmediate(r));
function manualScheduler() {
  const timers = new Map();
  let id = 0;
  return {
    api: {
      set(fn, ms) { const h = ++id; timers.set(h, { fn, ms }); return h; },
      clear(h) { timers.delete(h); },
    },
    armed: () => timers.size,
    async fire() {
      const snap = [...timers.values()];
      timers.clear();
      for (const t of snap) t.fn();
      for (let i = 0; i < 8; i++) await settle();
    },
  };
}

// worktreeManager fake: resolveCwd returns pool_exhausted while the pool is FULL, a
// valid worktree once a slot is free. The on-demand reclaim (poolReclaimTrigger) frees
// `reclaimFrees` slots — set 0 to model "nothing reclaimable".
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
    poolRetryScheduler: state.scheduler.api,
  };
  if (state.maxAttempts != null) deps.poolRetryMaxAttempts = state.maxAttempts;
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
    scheduler: manualScheduler(),
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
  assert.deepEqual(
    d.dispatchBlockCounts(),
    { 'worktree:pool_exhausted': 1 },
    'the exhaustion is counted on the heartbeat metric (recovered or not)',
  );
  // Autonomous inline recovery is silent and queues nothing.
  assert.equal(countTool('add_comment'), 0, 'a recovered dispatch posts no blocker comment');
  assert.equal(countTool('pend_ticket'), 0, 'a recovered dispatch never pends');
  assert.equal(d.pendingPoolRetryCount(), 0, 'nothing left queued');
  assert.equal(ticketState.pending_user_action, false);
});

// ── (2) nothing reclaimable → QUEUE a retry: pool-specific comment, no first-abort pend ──

test('pool_exhausted + nothing reclaimable → queues a manager-owned retry with a POOL-specific comment, no pend', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'b1' }));

  assert.equal(state.reclaimCalls, 1, 'reclaim was still attempted');
  assert.equal(state.resolveCalls, 1, 'no inline retry when the reclaim freed nothing');
  assert.equal(state.spawns.length, 0, 'no strand spawned while the pool stays exhausted');
  assert.equal(d.pendingPoolRetryCount(), 1, 'the dispatch is queued for the manager-owned retry');
  assert.deepEqual(d.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'counted exactly once (no fast-path/fall-through double count)');
  assert.equal(countTool('add_comment'), 1, 'the queued episode posts a single comment');
  const c = commentContent();
  assert.match(c, /pool_exhausted|풀 고갈/, 'the comment is pool-specific, not the generic checkout-failure message');
  assert.match(c, /자동 재시도|서버 재푸시가 필요 없/, 'states that recovery is autonomous (no server re-push)');
  assert.doesNotMatch(c, /유효한 Git 체크아웃/, 'must NOT reuse the misleading broken-checkout copy for pool exhaustion');
  // pool_exhausted is a TRANSIENT blocker → no pend on the first abort.
  assert.equal(countTool('pend_ticket'), 0, 'pool_exhausted does NOT pend on the first abort');
  assert.equal(ticketState.pending_user_action, false);
});

// ── (3a) queued retry recovers when the retry's OWN backoff attempt reclaims a now- ──
//        past-grace leaked lease — WITHOUT any server re-push. ("grace 경과 후 reclaim")

test('queued retry recovers via its own backoff attempt (grace-passed reclaim) — one spawn, no re-push', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 }); // initially nothing reclaimable
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'g1' }));
  assert.equal(state.spawns.length, 0, 'first pass: exhausted, nothing to spawn');
  assert.equal(d.pendingPoolRetryCount(), 1, 'retry queued');
  assert.equal(state.scheduler.armed(), 1, 'a backoff timer is armed');

  // The 20-min reclaim grace elapses → the leaked lease is now reclaimable. Fire the
  // backoff attempt: its OWN on-demand reclaim frees the slot and it recovers inline.
  state.reclaimFrees = 1;
  await state.scheduler.fire();

  assert.equal(state.spawns.length, 1, 'the queued retry recovered — exactly one strand, no server re-push');
  assert.equal(state.spawns[0].ticketId, TICKET);
  assert.equal(d.pendingPoolRetryCount(), 0, 'the queued retry resolved on recovery');
  assert.equal(countTool('pend_ticket'), 0, 'recovered → never pended');
});

// ── (3b) queued retry recovers the instant a slot frees (terminal move / reconcile) ──
//        via wakePoolRetries — the "slot release → re-dispatch" path, no re-push.

test('queued retry recovers on a slot-release wake — one spawn, no server re-push', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 's1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'retry queued');

  // Another ticket went terminal / a reconcile reclaimed a lease → a slot is free now.
  state.poolFull = false;
  d.wakePoolRetries('slot_release:test');
  for (let i = 0; i < 8; i++) await settle();

  assert.equal(state.spawns.length, 1, 'the wake re-drove the queued retry to recovery — exactly one strand');
  assert.equal(d.pendingPoolRetryCount(), 0, 'resolved on recovery');
  assert.equal(countTool('pend_ticket'), 0);
});

// ── (4) a duplicate trigger while a retry is queued dedupes — no twin ──

test('a duplicate same-key trigger while a retry is queued dedupes (no twin), then recovers with ONE spawn', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'd1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'first trigger queued a retry');

  // A supervisor re-push for the SAME (ticket, role, agent) arrives while queued. It
  // re-enters, re-hits pool_exhausted, and must only REFRESH the queued entry — never
  // stack a second one (that would spawn a twin when the pool frees).
  await d.handleTrigger(makeEvent({ field_changed: 'd2' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'still exactly one queued retry — no twin');
  assert.equal(state.spawns.length, 0, 'nothing spawned while exhausted');
  assert.equal(state.dedups.length, 0, 'no spawn-level dedup needed — the twin was prevented before provisioning');

  // Free the pool and wake: exactly ONE strand spawns despite the two triggers.
  state.poolFull = false;
  d.wakePoolRetries('slot_release:test');
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(state.spawns.length, 1, 'exactly one strand across both triggers — no twin');
  assert.equal(d.pendingPoolRetryCount(), 0);
});

// ── (5a) a moved ticket cancels its queued retry (board_update path) ──

test('a moved ticket cancels its queued pool_exhausted retry (board_update)', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'm1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'retry queued');

  // The ticket moves (any column) → its stale pre-move trigger must not replay.
  d.handleBoardUpdate(JSON.stringify({ entity_type: 'ticket', action: 'moved', ticket_id: TICKET }));
  assert.equal(d.pendingPoolRetryCount(), 0, 'the queued retry was cancelled on move');

  // Even if a slot frees afterward, there is nothing to re-drive → no spawn.
  state.poolFull = false;
  d.wakePoolRetries('slot_release:test');
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(state.spawns.length, 0, 'a cancelled retry never spawns');
});

// ── (5b) a pended / terminal ticket cancels the retry at its pre-replay verify ──

test('a pended ticket cancels the queued retry at the pre-replay eligibility check', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'p1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'retry queued');

  // A human pends the ticket (no inbound pend SSE — verify is the only signal).
  ticketState.pending_user_action = true;
  await state.scheduler.fire();

  assert.equal(state.spawns.length, 0, 'a pended ticket never replays');
  assert.equal(d.pendingPoolRetryCount(), 0, 'the queued retry was cancelled by verify');
});

test('a terminal ticket cancels the queued retry at the pre-replay eligibility check', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 't1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'retry queued');

  ticketState.terminal_entered_at = '2026-07-18T00:00:00.000Z';
  await state.scheduler.fire();

  assert.equal(state.spawns.length, 0, 'a terminal ticket never replays');
  assert.equal(d.pendingPoolRetryCount(), 0, 'the queued retry was cancelled by verify');
});

// ── (6) a persistently-exhausted pool gives up after the attempt bound → pends ──

test('a persistent pool_exhausted gives up after the retry bound → pends for the operator (one pend)', async () => {
  const state = newState({ poolFull: true, reclaimFrees: 0, maxAttempts: 3 });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'x1' }));
  assert.equal(d.pendingPoolRetryCount(), 1, 'queued');
  assert.equal(countTool('pend_ticket'), 0, 'no pend while retries remain');

  await state.scheduler.fire(); // attempt 1
  assert.equal(countTool('pend_ticket'), 0, 'no pend at attempt 1');
  await state.scheduler.fire(); // attempt 2
  assert.equal(countTool('pend_ticket'), 0, 'no pend at attempt 2');
  await state.scheduler.fire(); // attempt 3 → bound reached → give up
  assert.equal(countTool('pend_ticket'), 1, 'a sustained exhaustion pends exactly once after the bound');

  assert.equal(state.spawns.length, 0, 'no strand across the whole exhausted episode');
  assert.equal(d.pendingPoolRetryCount(), 0, 'the queue dropped the entry on give-up');
  assert.equal(state.scheduler.armed(), 0, 'no timer left armed after give-up');
  const c = commentContent();
  assert.match(c, /한도 초과|재시도.*지속|과다구독/, 'the give-up comment explains sustained over-subscription');
  assert.match(c, /e7c87517/, 'references the 24h no-progress backstop');
  assert.equal(ticketState.pending_user_action, true);
});

// ── (7) no poolReclaimTrigger wired → still records the signal and queues a retry ──

test('pool_exhausted with no reclaim trigger wired → signal recorded, retry still queued', async () => {
  const state = newState({ poolFull: true, noReclaimTrigger: true });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'c1' }));

  assert.equal(state.reclaimCalls, 0, 'no reclaim trigger → none invoked');
  assert.equal(state.resolveCalls, 1, 'no inline retry without a reclaim');
  assert.equal(state.spawns.length, 0, 'no strand spawned');
  assert.equal(d.pendingPoolRetryCount(), 1, 'the retry queue still engages (recovers via slot-release wake)');
  assert.deepEqual(d.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'the durable signal is recorded regardless');
});

// ── (8) reclaim throws → treated as 0 freed, dispatch still degrades to a queued retry ──

test('on-demand reclaim that throws is swallowed (treated as 0 freed) — dispatch queues a retry, never wedges', async () => {
  const throwState = newState({ poolFull: true, scheduler: manualScheduler() });
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
      poolRetryScheduler: throwState.scheduler.api,
      poolReclaimTrigger: async () => { throw new Error('reclaim boom'); },
    },
  );

  await throwing.handleTrigger(makeEvent({ field_changed: 'e1' }));
  assert.equal(throwState.resolveCalls, 1, 'a throwing reclaim → no inline retry (0 freed), no crash');
  assert.equal(throwState.spawns.length, 0, 'no strand spawned');
  assert.equal(throwing.pendingPoolRetryCount(), 1, 'still queues a retry despite the reclaim error');
  assert.deepEqual(throwing.dispatchBlockCounts(), { 'worktree:pool_exhausted': 1 }, 'signal still recorded despite the reclaim error');
});
