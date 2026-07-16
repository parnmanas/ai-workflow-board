// Integration test — durable provisioning-failure block + single-strand (ticket 52eedadf).
//
// Rewritten for the review (blockers #1/#2). The previous version drove a
// tool-NAME-only /mcp mock and a trivial spawn() that could never twin, so it
// proved neither the durable-FIRST-abort pend nor the (ticket,role) single-flight
// under a transition race. This version stitches the REAL manager pieces across
// the server↔manager boundary:
//   • the /mcp mock is STATEFUL — pend_ticket flips pending_user_action=true and
//     unpend_ticket clears it, so the test asserts the real pend transition, not
//     just "a tool named pend_ticket was invoked". (The SERVER half of the
//     boundary — getAllocatedTickets dropping BOTH normal and forced triggers for
//     a pending ticket — is proven against the real gate in
//     apps/server/test/provisioning-pending-allocation-gate.test.mjs.)
//   • the subagentManager fake runs the PRODUCTION findDuplicateSpawn over a
//     synchronous dedup-scan → identity reservation, exactly like
//     SubagentManager.spawn(), so two concurrent triggers for the same
//     (ticket,role,agent) collapse to one spawn — the real inflight single-flight,
//     not a stub that can never twin.
//
// What it proves (maps to the review asks):
//   (1) a DURABLE provisioning failure (not_a_git_repo) pends on the FIRST abort
//       — no repeated provisioning/spawn — and after explicit recovery exactly
//       ONE strand spawns;
//   (b) concurrent triggers racing the pend transition pend exactly once and
//       spawn zero twins;
//   (c) concurrent recovery triggers (distinct trigger ids, same ticket/role/
//       agent) spawn EXACTLY ONE strand via the real single-flight;
//   (4) a TRANSIENT blocker (path_conflict) does NOT pend on the first abort — it
//       keeps the cooldown self-heal and only pends after the threshold.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';

const AGENT = 'agent-rolf';
const TICKET = 'ticket-prov';

// A fully-bootstrapped managed-agent context so #resolveAgentContext returns a
// real cwd/apiKey (otherwise #applyWorktreeCwd early-returns ok:true and the
// provisioning path is never exercised).
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
let mcpToolCalls; // names of tools/call invoked over /mcp (add_comment, pend_ticket, …)
let ticketState;  // the (mocked) server-side ticket row the pend/unpend transition mutates

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
        mcpToolCalls.push(name);
        // Stateful boundary: the manager's pend_ticket call actually flips the
        // server ticket's pending flag (and unpend clears it), so the test can
        // assert the real transition rather than just the tool name.
        if (name === 'pend_ticket') ticketState.pending_user_action = true;
        if (name === 'unpend_ticket') ticketState.pending_user_action = false;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 }); // notifications/initialized, etc.
    }
    // REST GETs: repository git-credential (→ no token) and ticket context (→ {}).
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful subagentManager: mirrors SubagentManager.spawn()'s SYNCHRONOUS
// dedup-scan (production findDuplicateSpawn) → identity reservation, so a second
// near-simultaneous spawn for the same (ticket,role,agent) — even with a
// DIFFERENT trigger id — collapses to duplicate_trigger before it can twin. The
// reservation stays in `records` (modelling a live strand) so a later trigger
// while the strand is alive also dedups.
function makeSubagentManager(state) {
  const records = new Map(); // reservationId → SpawnIdentityRecord
  let resCounter = 0;
  return {
    canSpawn: () => true,
    async spawn(spec) {
      const dup = findDuplicateSpawn(records.values(), spec);
      if (dup) {
        state.dedups.push({ trigger: spec.triggerId, reason: dup });
        return { spawned: false, reason: dup };
      }
      const id = --resCounter; // reserve SYNCHRONOUSLY (no await before this)
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

function makeDispatcher(state) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      state.resolveCalls += 1;
      if (state.broken) return { isWorktree: false, reason: state.reason };
      return { isWorktree: true, cwd: '/ws/.awb/wt/ok', mode: 'per_ticket', reused: false };
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
  // No ticketSessionManager → the dispatcher falls to the one-shot subagent path,
  // whose spawn() (our faithful single-flight fake) we count.
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager: makeSubagentManager(state), managedAgentContexts },
  );
}

function newState(overrides = {}) {
  return { resolveCalls: 0, spawns: [], dedups: [], broken: true, reason: 'not_a_git_repo', ...overrides };
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'column_move', // non-supervisor by default (always runs preflight)
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const countTool = (name) => mcpToolCalls.filter((n) => n === name).length;

// ── (1) durable → first-abort pend, no repeated spawn, recovery → one strand ──

test('durable failure pends on the FIRST abort, spawns nothing, and recovers to exactly one strand', async () => {
  const state = newState(); // broken, not_a_git_repo (durable)
  const d = makeDispatcher(state);

  // ONE durable failure → pend immediately (review blocker #1: no waiting out the
  // 3-probe threshold). No strand spawned; the abort comment posts once.
  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(state.spawns.length, 0, 'no strand spawned while provisioning is broken');
  assert.equal(countTool('pend_ticket'), 1, 'a durable blocker pends on the FIRST abort');
  assert.equal(countTool('add_comment'), 1, 'the abort posts a single ticket comment');
  assert.equal(ticketState.pending_user_action, true, 'the pend transition actually set pending_user_action');

  // While pended, a supervisor re-trigger is dropped BEFORE re-provisioning — the
  // manager-side damper (belt to the server-side getAllocatedTickets drop that the
  // server test exercises against the real gate). No new provisioning, no spawn,
  // no duplicate pend.
  const resolveBefore = state.resolveCalls;
  await d.handleTrigger(makeEvent({ trigger_source: 'supervisor', field_changed: 'sup1' }));
  assert.equal(state.resolveCalls, resolveBefore, 'supervisor re-trigger suppressed before re-provisioning');
  assert.equal(state.spawns.length, 0, 'a suppressed supervisor trigger spawns nothing');
  assert.equal(countTool('pend_ticket'), 1, 'no duplicate pend while already pended');

  // Explicit recovery: operator fixes the env and unpends. The resumed dispatch is
  // a non-supervisor (state-changed) trigger that always passes the backoff.
  state.broken = false;
  ticketState.pending_user_action = false; // operator unpend
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));

  assert.equal(state.spawns.length, 1, 'recovery spawned exactly one strand');
  assert.equal(state.spawns[0].ticketId, TICKET);
  assert.equal(state.spawns[0].role, 'assignee');
});

// ── (b) concurrent triggers racing the pend transition → one pend, zero twins ──

test('concurrent durable triggers racing the pend transition pend exactly once and spawn no twin', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  // Two triggers arrive together (distinct trigger ids) as the block becomes
  // durable. note() is synchronous, so exactly ONE crosses the pend threshold;
  // both abort at preflight, so neither spawns.
  await Promise.all([
    d.handleTrigger(makeEvent({ field_changed: 'race-a' })),
    d.handleTrigger(makeEvent({ field_changed: 'race-b' })),
  ]);

  assert.equal(state.spawns.length, 0, 'no strand spawned during the pend-transition race');
  assert.equal(countTool('pend_ticket'), 1, 'exactly one pend across the concurrent race (no duplicate)');
  assert.equal(ticketState.pending_user_action, true, 'the ticket ended up pended');
});

// ── (c) concurrent recovery triggers → exactly one strand (real single-flight) ─

test('concurrent recovery triggers spawn EXACTLY ONE strand via the real (ticket,role,agent) single-flight', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  // Drive to a durable pend first.
  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(countTool('pend_ticket'), 1);

  // Recover: env fixed + operator unpend.
  state.broken = false;
  ticketState.pending_user_action = false;

  // TWO recovery triggers arrive together with DIFFERENT trigger ids but the SAME
  // (ticket, role, agent). Only rule-3 single-flight (NOT exact-trigger-id dedup)
  // can collapse them — this is the transition-race twin the ticket must prevent.
  await Promise.all([
    d.handleTrigger(makeEvent({ field_changed: 'recover-a' })),
    d.handleTrigger(makeEvent({ field_changed: 'recover-b' })),
  ]);

  assert.equal(state.spawns.length, 1, 'concurrent recovery spawned exactly one strand (정확히 한 strand)');
  assert.equal(state.dedups.length, 1, 'the twin was deduped by the real findDuplicateSpawn');
  assert.equal(state.dedups[0].reason, 'duplicate_trigger', 'deduped on (ticket,role,agent), not exact trigger id');
});

// ── (4) transient blocker keeps the cooldown self-heal (contrast to durable) ───

test('a TRANSIENT blocker does NOT pend on the first abort — it pends only after the threshold', async () => {
  const state = newState({ reason: 'path_conflict' }); // transient (a sibling ticket may free the path)
  const d = makeDispatcher(state);

  // First abort: no pend (unlike a durable blocker) — a sibling ticket might free
  // the path, so the cooldown gets a self-heal window first.
  await d.handleTrigger(makeEvent({ field_changed: 't1' }));
  assert.equal(state.spawns.length, 0, 'transient block: no spawn');
  assert.equal(countTool('pend_ticket'), 0, 'transient block: NOT pended on the first abort');
  assert.equal(ticketState.pending_user_action, false, 'transient block: ticket not pended yet');

  // Two more state-changed (non-supervisor, so never cooldown-suppressed) aborts
  // reach DEFAULT_PEND_AFTER_ABORTS (3). Only then does even a transient block
  // pend. (In the field a transient is mostly re-probed by cooldown-gated
  // supervisor triggers; driving state-changed ones here reaches the threshold
  // deterministically without a fake clock — the pend mechanism is identical.)
  await d.handleTrigger(makeEvent({ field_changed: 't2' }));
  assert.equal(countTool('pend_ticket'), 0, 'still no pend at abort 2');
  await d.handleTrigger(makeEvent({ field_changed: 't3' }));
  assert.equal(countTool('pend_ticket'), 1, 'a persistent transient finally pends after the threshold');
  assert.equal(state.spawns.length, 0, 'still no strand across the whole transient episode');
});

// ── re-arm: a recovered ticket-role backs off afresh on a later break ──────────

test('a recovered ticket-role re-arms: a later durable break pends afresh (no stale carry)', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(countTool('pend_ticket'), 1, 'durable block pended');

  // Recover (green preflight clears the suppressor episode).
  state.broken = false;
  ticketState.pending_user_action = false;
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));
  assert.equal(state.spawns.length, 1, 'recovered with one strand');

  // A brand-new durable break after recovery pends afresh (episode re-armed) —
  // exactly once, not a stale double-count.
  const pendsBefore = countTool('pend_ticket');
  state.broken = true;
  await d.handleTrigger(makeEvent({ field_changed: 'c1' }));
  assert.equal(countTool('pend_ticket'), pendsBefore + 1, 'the fresh durable break pends again on its first abort');
  assert.equal(state.spawns.length, 1, 'the fresh break spawns nothing new');
});
