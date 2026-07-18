// Integration test — harness session-limit defer, driven through the REAL
// EventDispatcher (ticket 467f714a).
//
// Proves the completion criteria end-to-end against the real handleTrigger /
// handleCommentMention / handleBoardUpdate paths + the injected durable store:
//   (1) a session-limit exit (recordHarnessSessionLimit — the seam main.ts wires
//       the ticket-session / one-shot exit handlers to) opens a per-agent defer
//       window; every supervisor/mention re-dispatch in the window is COALESCED
//       into a SINGLE pending intent per (ticket, role, agent) — NO spawn, NO twin
//       — with exactly one audit-visible defer comment per deferred ticket-role;
//   (2) at the reset instant each coalesced ticket-role resumes EXACTLY ONCE
//       (replayed through handleTrigger, which re-acquires the twin reservation),
//       the window clears, and nothing is left queued;
//   (3) an explicit operator `manual` trigger BYPASSES the window (escape hatch);
//   (4) a comment_mention is suppressed while deferred (no futile one-shot spawn);
//   (5) a moved ticket cancels its pending resume intent.
//
// Harness mirrors pool-exhausted-recovery.test.mjs: a stateful /mcp mock so the
// audit comment is asserted for real, a faithful single-flight subagentManager
// fake (findDuplicateSpawn) so a twin would be observable, and an injected manual
// scheduler + clock on the defer store so the reset is driven deterministically.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { SessionLimitDeferStore } from '../dist/lib/session-limit-defer.js';
import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';

const AGENT = 'agent-rolf';
const T0 = Date.UTC(2026, 6, 18, 10, 0, 0);
const settle = () => new Promise((r) => setImmediate(r));

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
let mcpToolCalls;
let ticketState;

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
        mcpToolCalls.push({ name: body.params?.name, args: body.params?.arguments ?? {} });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    if (u.includes('/api/agent/tickets/')) {
      return new Response(JSON.stringify(ticketState), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful single-flight subagentManager — a twin would show as a second spawn.
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

function makeHarness() {
  const nowRef = { v: T0 };
  const sched = manualScheduler();
  const state = { spawns: [], dedups: [] };
  const store = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: sched.api, persistPath: null });
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      return { isWorktree: true, cwd: '/ws/.awb/wt/t', mode: 'per_ticket', reused: false };
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
  const d = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager: makeSubagentManager(state), managedAgentContexts, sessionLimitDeferStore: store },
  );
  return { d, store, sched, nowRef, state };
}

function trigger(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: 'T-1',
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'supervisor',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const RESET_UNTIL = T0 + 60 * 60_000;
function openWindow(d) {
  return d.recordHarnessSessionLimit({
    agentId: AGENT,
    deferUntilMs: RESET_UNTIL,
    reason: 'session_limit',
    resetLabel: '12:30am (Asia/Seoul)',
  });
}
const countTool = (name) => mcpToolCalls.filter((c) => c.name === name).length;
const commentContent = () =>
  mcpToolCalls.filter((c) => c.name === 'add_comment').map((c) => c.args.content).join('\n');

// ── (1) coalesce the supervisor storm into ONE intent, no spawn, one comment ──

test('session-limit window: supervisor re-dispatch storm coalesces to ONE pending intent — no spawn, no twin, one audit comment', async () => {
  const { d, state } = makeHarness();

  assert.deepEqual(openWindow(d), { opened: true }, 'the session-limit exit opened a fresh window');
  assert.equal(d.sessionDeferState(AGENT).deferred, true);

  // Six supervisor force-respawns for the SAME (ticket, role) — the d34075b5 storm.
  for (let i = 0; i < 6; i++) {
    await d.handleTrigger(trigger({ field_changed: `s${i}`, force_respawn: true }));
  }
  assert.equal(state.spawns.length, 0, 'NOTHING spawned while deferred — the doomed sessions are never started');
  assert.equal(state.dedups.length, 0, 'the twin was prevented BEFORE provisioning (no spawn-level dedup needed)');
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the six re-dispatches coalesced into exactly one pending intent');
  // The audit comment is fire-and-forget (a failed POST must never affect
  // dispatch) — let the MCP initialize→tools/call chain drain before asserting.
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(countTool('add_comment'), 1, 'exactly one audit-visible defer comment for the ticket-role');

  const c = commentContent();
  assert.match(c, /세션 한도|session limit/, 'the comment names the session-limit defer reason');
  assert.match(c, /정확히 1회/, 'states the resume-exactly-once contract');
  assert.match(c, /12:30am \(Asia\/Seoul\)/, 'surfaces the parsed reset time');
  assert.match(c, /467f714a/, 'references the ticket');
  assert.equal(countTool('pend_ticket'), 0, 'a session limit is NOT a pend — it is deferred+resumed');
});

// ── (2) reset → each deferred ticket-role resumes EXACTLY once, no twin ──

test('reset instant: each coalesced ticket-role resumes EXACTLY ONCE (no twin), window clears', async () => {
  const { d, sched, nowRef, state } = makeHarness();
  openWindow(d);

  // Two distinct tickets deferred; T-1 hit repeatedly (coalesced), T-2 once.
  for (let i = 0; i < 4; i++) await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: `a${i}` }));
  await d.handleTrigger(trigger({ ticket_id: 'T-2', field_changed: 'b0' }));
  assert.equal(state.spawns.length, 0, 'nothing spawned during the window');
  assert.equal(d.pendingSessionDeferCount(AGENT), 2, 'one intent per distinct ticket-role');

  // The reset instant arrives.
  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();

  assert.equal(state.spawns.length, 2, 'exactly one spawn per deferred ticket-role — no twin despite T-1 being triggered 4×');
  assert.equal(state.dedups.length, 0, 'no spawn-level dedup fired — coalescing made each replay unique');
  const spawnedTickets = state.spawns.map((s) => s.ticketId).sort();
  assert.deepEqual(spawnedTickets, ['T-1', 'T-2']);
  assert.equal(d.sessionDeferState(AGENT).deferred, false, 'the window cleared at reset');
  assert.equal(d.pendingSessionDeferCount(AGENT), 0, 'nothing left queued (exactly-once)');

  // A late supervisor re-push after reset is a normal dispatch again (spawns).
  await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: 'late' }));
  assert.equal(state.spawns.length, 2, 'post-reset the same-key trigger dedups against the live replay (still no twin)');
});

// ── (3) manual/operator trigger bypasses the window (escape hatch) ──

test('an explicit operator `manual` trigger bypasses the defer window (escape hatch)', async () => {
  const { d, state } = makeHarness();
  openWindow(d);
  assert.equal(d.sessionDeferState(AGENT).deferred, true);

  await d.handleTrigger(trigger({ ticket_id: 'T-op', field_changed: 'op', trigger_source: 'manual' }));
  assert.equal(state.spawns.length, 1, 'a manual trigger spawns despite the window (operator escape hatch)');
  assert.equal(state.spawns[0].ticketId, 'T-op');
  assert.equal(d.pendingSessionDeferCount('T-op'), 0, 'a bypassing trigger is not coalesced into an intent');
});

// ── (4) a comment_mention is suppressed while deferred (no futile one-shot) ──

test('a comment_mention is suppressed while deferred (no one-shot spawn)', async () => {
  const { d, state } = makeHarness();
  openWindow(d);

  await d.handleCommentMention(
    JSON.stringify({
      event_type: 'comment_mention',
      ticket_id: 'T-1',
      comment_id: 'c1',
      agent_id: AGENT,
      actor_name: 'reviewer',
      content: '@[role:assignee] please proceed',
    }),
  );
  assert.equal(state.spawns.length, 0, 'the mention did not spawn a doomed one-shot while deferred');
});

// ── (5) a moved ticket cancels its pending resume intent ──

test('a moved ticket cancels its pending resume intent (board_update), so it never replays at reset', async () => {
  const { d, sched, nowRef, state } = makeHarness();
  openWindow(d);

  await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: 'm1' }));
  await d.handleTrigger(trigger({ ticket_id: 'T-2', field_changed: 'm2' }));
  assert.equal(d.pendingSessionDeferCount(AGENT), 2);

  // T-1 moves (any column) → its stale pre-move intent must not replay.
  d.handleBoardUpdate(JSON.stringify({ entity_type: 'ticket', action: 'moved', ticket_id: 'T-1' }));
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the moved ticket’s intent was cancelled');
  assert.equal(d.sessionDeferState(AGENT).deferred, true, 'the agent window survives (T-2 still deferred)');

  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();
  assert.equal(state.spawns.length, 1, 'only the un-moved ticket resumed');
  assert.equal(state.spawns[0].ticketId, 'T-2');
});
