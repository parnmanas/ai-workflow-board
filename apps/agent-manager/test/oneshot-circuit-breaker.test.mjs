// Unit test — one-shot SubagentManager exit handling (ticket 27806095).
//
// Reproduces the 2026-06-07 production meltdown in miniature and asserts the
// three fixes:
//   ① a codex immediate-failure (exit 1, usage-limit stdout) is NOT posted as
//      an agent-identity comment — only the system-attributed silent-exit
//      fallback fires (which the server trigger-loop guard drops);
//   ② the circuit-breaker counts one-shot failures and, once open, blocks
//      re-spawn and pends the ticket;
//   ③ a codex usage-limit (non-retryable) opens the breaker on the FIRST
//      failure rather than after the full threshold.
//
// We mock globalThis.fetch to capture both the MCP tool surface (add_comment /
// pend_ticket go through the JSON-RPC /mcp endpoint) and the REST silent-exit
// endpoint, so we can prove exactly which comments were written and under which
// identity (MCP add_comment = agent identity; REST silent-exit = system).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
  };
}

let pidSeq = 70000;
function makeCodexRecord(overrides = {}) {
  return {
    pid: ++pidSeq,
    kind: 'trigger',
    cli_type: 'codex',
    trigger_id: 'trig-1',
    chat_request_id: null,
    ticket_id: 'ticket-loop',
    agent_id: 'agent-rolf',
    role: 'assignee',
    room_id: null,
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    captureOutput: true, // codex is non-NATIVE_MCP → stdout is aggregated
    outLines: [],
    tailLines: ['Reading prompt from stdin...', '[codex error] usage limit'],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

// codex `exec --json` JSONL for a usage-limit turn failure (collectOneshotResult
// turns this into "[codex error] You've hit your usage limit...").
function codexUsageLimitLines() {
  return [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit. Upgrade to Pro to continue." },
    }),
  ];
}

// A clean codex turn with a real agent_message reply.
function codexCleanLines(text) {
  return [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed' }),
  ];
}

function codexMcpToolCompletedLine(tool) {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-mcp-1',
      type: 'mcp_tool_call',
      server: 'awb',
      tool,
      arguments: { ticket_id: 'ticket-loop', content: 'work done' },
      result: { content: [{ type: 'text', text: '{}' }] },
      error: null,
    },
  });
}

let originalFetch;
let mcpToolCalls; // names of tools/call invoked over /mcp
let restPosts; // { url, body } for non-MCP REST endpoints

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  restPosts = [];
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
      // notifications/initialized and anything else
      return new Response('', { status: 202 });
    }
    // REST endpoints (silent-exit-comment, chat, ...)
    const body = init?.body ? JSON.parse(init.body) : null;
    restPosts.push({ url: u, method, body });
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const silentExit = () => restPosts.find((r) => r.url.endsWith('/silent-exit-comment'));

test('① codex usage-limit exit 1: NO agent add_comment, only system silent-exit', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({ outLines: codexUsageLimitLines() });

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(
    mcpToolCalls.includes('add_comment'),
    false,
    'the codex error text must NOT be posted as an agent-identity comment',
  );
  const se = silentExit();
  assert.ok(se, 'system-attributed silent-exit fallback was posted');
  assert.equal(se.body.exit_code, 1);
  assert.equal(se.body.actor_name, 'agent-manager');
});

test('③ codex usage-limit opens the breaker on the FIRST failure + pends ticket', async () => {
  const cb = new CircuitBreaker(); // default threshold 5
  const mgr = new SubagentManager(makeConfig(), cb);
  const rec = makeCodexRecord({ outLines: codexUsageLimitLines() });
  const key = CircuitBreaker.key(rec.agent_id, rec.ticket_id, rec.role);

  await mgr._handleOneshotExit(rec, 1);

  assert.ok(cb.shouldBlock(key), 'breaker opened after a single non-retryable failure');
  assert.ok(mcpToolCalls.includes('pend_ticket'), 'ticket was pended when the breaker opened');
});

test('② open breaker blocks re-spawn (no fork, returns circuit_breaker_open)', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const rec = makeCodexRecord({ outLines: codexUsageLimitLines() });

  await mgr._handleOneshotExit(rec, 1); // opens the breaker

  const res = await mgr.spawn({
    kind: 'trigger',
    taskText: 'do the thing',
    rolePrompt: '',
    triggerId: 'trig-2',
    ticketId: rec.ticket_id,
    agentId: rec.agent_id,
    role: rec.role,
  });
  assert.equal(res.spawned, false);
  assert.equal(res.reason, 'circuit_breaker_open');
});

test('② generic exit-1 (no signature) opens only after 5 consecutive failures', async () => {
  const cb = new CircuitBreaker(); // threshold 5
  const mgr = new SubagentManager(makeConfig(), cb);
  // claude-style: NATIVE_MCP, no stdout aggregation; exit 1 with no comment.
  const key = CircuitBreaker.key('agent-x', 'ticket-x', 'reviewer');

  for (let i = 1; i <= 4; i++) {
    const rec = makeCodexRecord({
      cli_type: 'claude',
      captureOutput: false,
      agent_id: 'agent-x',
      ticket_id: 'ticket-x',
      role: 'reviewer',
      outLines: [],
    });
    await mgr._handleOneshotExit(rec, 1);
    assert.equal(cb.shouldBlock(key), null, `still closed after ${i} failures`);
  }
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no pend before threshold');

  const rec5 = makeCodexRecord({
    cli_type: 'claude',
    captureOutput: false,
    agent_id: 'agent-x',
    ticket_id: 'ticket-x',
    role: 'reviewer',
    outLines: [],
  });
  await mgr._handleOneshotExit(rec5, 1);

  assert.ok(cb.shouldBlock(key), 'breaker open on the 5th consecutive failure');
  assert.ok(mcpToolCalls.includes('pend_ticket'), 'ticket pended on open');
});

test('clean codex answer (exit 0): posted as agent add_comment, no silent-exit, no pend', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const rec = makeCodexRecord({ outLines: codexCleanLines('Here is the finished work.') });

  await mgr._handleOneshotExit(rec, 0);

  assert.ok(mcpToolCalls.includes('add_comment'), 'a clean answer is posted under the agent identity');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no pend on success');
  assert.equal(silentExit(), undefined, 'no silent-exit fallback on a clean answered exit');
});

test('FP regression: clean exit-0 answer mentioning 403/quota → agent comment, breaker untouched, no pend', async () => {
  // Reviewer blocker: classifyCliError runs on the full answer text, so a
  // legitimate exit-0 codex reply about auth/rate-limit work used to trip the
  // fatal/non-retryable path → suppressed answer + force-open breaker + pend.
  // With exit-code anchoring this must behave like any other clean success.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');
  const rec = makeCodexRecord({
    outLines: codexCleanLines(
      'Done — added a 403 Forbidden response for unauthorized users and 429/quota handling to the rate limiter.',
    ),
  });

  await mgr._handleOneshotExit(rec, 0);

  assert.ok(mcpToolCalls.includes('add_comment'), 'the real answer is posted under the agent identity');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'breaker must not pend on a clean answer');
  assert.equal(silentExit(), undefined, 'no system silent-exit fallback — the answer was posted');
  assert.equal(cb.shouldBlock(key), null, 'breaker untouched by a successful answer');
});

test('successful answer resets a partially-tripped breaker', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  // Two bare-codex-error failures (retryable) — count toward threshold.
  for (let i = 0; i < 2; i++) {
    const rec = makeCodexRecord({
      outLines: [JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } })],
    });
    await mgr._handleOneshotExit(rec, 1);
  }
  assert.equal(cb.size, 1, 'breaker is tracking the key');

  // Now a clean success → reset clears the key.
  const ok = makeCodexRecord({ outLines: codexCleanLines('Done.') });
  await mgr._handleOneshotExit(ok, 0);
  assert.equal(cb.shouldBlock(key), null);
});

test('post-comment crash (ticket 7e7e23bf): commentSent + non-zero exit → NO silent-exit, breaker reset, no pend', async () => {
  // The one-shot mirror of the reviewer false-positive: a NATIVE_MCP (claude)
  // strand fired add_comment during its turn — its deliverable is persisted —
  // then the CLI crashed post-hoc (exit 1) with a benign, non-fatal tail. This
  // must NOT surface the "exited without leaving a ticket comment" warning, must
  // NOT pend, and must RESET the breaker (the strand made forward progress).
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  // Pre-trip the breaker with two retryable failures so a reset is observable.
  for (let i = 0; i < 2; i++) {
    const rec = makeCodexRecord({
      outLines: [JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } })],
    });
    await mgr._handleOneshotExit(rec, 1);
  }
  assert.equal(cb.size, 1, 'breaker is tracking the key after two failures');

  // The pre-trip failures each posted their own (legitimate) silent-exit
  // fallback — drop those captures so the assertion below only sees what the
  // post-comment crash dispatch does.
  restPosts.length = 0;
  mcpToolCalls.length = 0;

  // claude one-shot: NATIVE_MCP → captureOutput false (no stdout aggregation),
  // commentSent already true from an add_comment tool_use during the turn, then
  // a post-hoc non-zero exit with a benign (non-fatal) tail.
  const crashed = makeCodexRecord({
    cli_type: 'claude',
    captureOutput: false,
    outLines: [],
    tailLines: ['post-hoc echo re-read', 'exit 1'],
    commentSent: true,
  });
  await mgr._handleOneshotExit(crashed, 1);

  assert.equal(silentExit(), undefined, 'no silent-exit fallback when a comment was already surfaced');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no pend on a post-comment crash');
  assert.equal(cb.size, 0, 'breaker entry cleared — the progress-making strand reset it');
});

test('post-comment usage-limit (ticket 7e7e23bf): commentSent + non-retryable tail still pends but stays silent', async () => {
  // Edge of the same rule: if the post-comment exit carries a NON-RETRYABLE
  // signature (usage-limit / auth), the immediate pend still protects against
  // burning respawns on a hard external block — but the scary silent-exit
  // warning is still suppressed because a real comment already landed.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const rec = makeCodexRecord({
    outLines: codexUsageLimitLines(), // codex stdout → classifyCliError = non-retryable
    commentSent: true,
  });

  await mgr._handleOneshotExit(rec, 1);

  assert.equal(silentExit(), undefined, 'no silent-exit fallback — a comment was already surfaced');
  assert.ok(mcpToolCalls.includes('pend_ticket'), 'a hard external block still pends the ticket');
});

test('Codex native MCP add_comment completion suppresses the silent-exit fallback', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({ captureOutput: false, outLines: [], tailLines: [] });

  mgr._scanForCommentTool(rec, codexMcpToolCompletedLine('add_comment'));
  assert.equal(rec.commentSent, true, 'Codex mcp_tool_call completion counts as a persisted comment');

  await mgr._handleOneshotExit(rec, 0);

  assert.equal(silentExit(), undefined, 'no false system comment after Codex add_comment succeeds');
});
