// Integration test — durable provisioning-failure block (ticket 52eedadf).
//
// Reproduces the c47194d9 field incident in miniature and asserts the fix
// end-to-end through EventDispatcher.handleTrigger:
//   ① a worktree provisioning failure aborts WITHOUT spawning a subagent, and
//      repeated failing triggers never spawn a (twin) strand — "반복 trigger 없음"
//      at the strand level;
//   ② once the abort episode is confirmed DURABLE (re-aborts reach the pend
//      threshold) the ticket is pended — the server then stops the supervisor's
//      normal AND forced re-triggers because getAllocatedTickets skips a pending
//      ticket (the hole that looped the incident for ~6h: a pre-spawn abort never
//      reaches an exit handler, so it never fed the circuit-breaker);
//   ③ a supervisor re-trigger inside the cooldown is dropped BEFORE re-running
//      the racy provisioning (the manager-side storm/twin-window damper);
//   ④ after explicit recovery (env fixed + a non-supervisor trigger, i.e. the
//      operator unpend wake) provisioning succeeds and EXACTLY ONE strand spawns.
//
// globalThis.fetch is mocked to capture the MCP tool surface (add_comment /
// pend_ticket go through the JSON-RPC /mcp endpoint) and to satisfy the two REST
// GETs the dispatch path makes (repository git-credential, ticket context).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
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
        mcpToolCalls.push(body.params?.name);
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

function makeDispatcher(state) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      state.resolveCalls += 1;
      if (state.broken) return { isWorktree: false, reason: 'not_a_git_repo' };
      return { isWorktree: true, cwd: '/ws/.awb/wt/ok', mode: 'per_ticket', reused: false };
    },
    async verifyCheckout() {
      return { ok: true };
    },
    async verifyPushReadiness() {
      return { ok: true };
    },
    async removeTicketWorktrees() {
      return 0;
    },
    async removeTicketRunWorkspace() {
      return false;
    },
  };
  const subagentManager = {
    canSpawn: () => true,
    async spawn(opts) {
      state.spawns.push(opts);
      return { spawned: true, pid: 4242 };
    },
  };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? makeCtx() : null),
    has: (id) => id === AGENT,
    list: () => [{ working_dir: '/ws' }],
  };
  // No ticketSessionManager → the dispatcher falls to the one-shot subagent path,
  // whose spawn() we count. delegation.enabled true, everything else default.
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager, managedAgentContexts },
  );
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

test('provisioning failure → durable pend + no repeated spawn → explicit recovery → exactly one strand', async () => {
  const state = { resolveCalls: 0, spawns: [], broken: true };
  const d = makeDispatcher(state);

  // Two consecutive aborts (< DEFAULT_PEND_AFTER_ABORTS): spawn nothing, comment
  // once (de-duped), and do NOT pend yet — a transient still gets a cooldown
  // self-heal window before the hard stop.
  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  await d.handleTrigger(makeEvent({ field_changed: 'a2' }));
  assert.equal(state.spawns.length, 0, 'no strand spawned while provisioning is broken');
  assert.equal(countTool('add_comment'), 1, 'the abort comment is de-duped to a single ticket comment');
  assert.equal(countTool('pend_ticket'), 0, 'no pend before the durable threshold (transient still self-heals)');

  // Third consecutive abort → confirmed DURABLE → pend the ticket. In production
  // getAllocatedTickets then skips the pending ticket, so the supervisor stops
  // emitting BOTH normal and forced re-triggers.
  await d.handleTrigger(makeEvent({ field_changed: 'a3' }));
  assert.equal(state.spawns.length, 0, 'still no strand at the pend boundary');
  assert.ok(countTool('pend_ticket') >= 1, 'ticket pended once the block is durable');
  assert.equal(countTool('add_comment'), 1, 'still a single de-duped abort comment (no spam)');

  // A supervisor re-trigger inside the cooldown is dropped BEFORE re-running the
  // racy provisioning — the manager-side storm/twin-window damper (belt to the
  // server-side pending-drop).
  const resolveBefore = state.resolveCalls;
  await d.handleTrigger(makeEvent({ trigger_source: 'supervisor', field_changed: 'sup1' }));
  assert.equal(state.resolveCalls, resolveBefore, 'supervisor re-trigger suppressed before re-provisioning');
  assert.equal(state.spawns.length, 0, 'a suppressed supervisor trigger spawns nothing');

  // Explicit recovery: the operator fixes the environment and unpends — the
  // resumed dispatch is a non-supervisor (state-changed) trigger that always
  // passes the backoff. Provisioning now succeeds.
  state.broken = false;
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));

  // EXACTLY ONE strand across the whole failure→recovery lifecycle.
  assert.equal(state.spawns.length, 1, 'recovery spawned exactly one strand (정확히 한 strand)');
  assert.equal(state.spawns[0].ticketId, TICKET);
  assert.equal(state.spawns[0].role, 'assignee');
});

test('a recovered ticket-role re-arms: a fresh break later backs off again (no stale instant-pend)', async () => {
  const state = { resolveCalls: 0, spawns: [], broken: true };
  const d = makeDispatcher(state);

  // Drive it to a durable pend, then recover (green preflight clears the episode).
  for (const id of ['b1', 'b2', 'b3']) await d.handleTrigger(makeEvent({ field_changed: id }));
  assert.ok(countTool('pend_ticket') >= 1, 'durable block pended');
  state.broken = false;
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));
  assert.equal(state.spawns.length, 1, 'recovered with one strand');

  // A brand-new break after recovery must start a FRESH backoff — the first
  // abort of the new episode does not instantly re-pend (count reset by clear()).
  const pendsBefore = countTool('pend_ticket');
  state.broken = true;
  await d.handleTrigger(makeEvent({ field_changed: 'c1' }));
  assert.equal(countTool('pend_ticket'), pendsBefore, 'a single fresh abort does not re-pend (episode re-armed)');
  assert.equal(state.spawns.length, 1, 'the fresh abort spawns nothing new');
});
