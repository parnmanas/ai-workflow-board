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
//      failure rather than after the full threshold;
//   ④ (ticket b2e88390) a successful probe against an already-OPEN breaker
//      does NOT auto-close it — only an operator's resetAgent()
//      (restart_agent) may fully clear a breaker that already pended a
//      ticket for a human.
//
// We mock globalThis.fetch to capture both the MCP tool surface (add_comment /
// pend_ticket go through the JSON-RPC /mcp endpoint) and the REST silent-exit
// endpoint, so we can prove exactly which comments were written and under which
// identity (MCP add_comment = agent identity; REST silent-exit = system).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';
import { STOP_GRACE_MS, STOP_FORCE_KILL_SETTLE_MS } from '../dist/lib/constants.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0, // skip the real grace delay (ticket 2fd06686) in tests
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

// Claude `--print --output-format stream-json`가 내는 turn별 assistant
// 이벤트로 MCP tool_use를 담고 있다 — ticket 3feaf80f의 수정이 oneshot에서
// 실제로 내보내게 만드는 shape이다(이전에는 `--output-format json`이라 stdout에
// 최종 `result` 한 줄만 나왔고, one-shot 실행에서는 `assistant`/tool_use가
// 전혀 나타나지 않았다).
function claudeAssistantToolUseLine(toolName) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-1', name: toolName, input: {} }],
    },
    session_id: 'sess-1',
  });
}

// pi's awb-mcp-bridge.ts extension sentinel (ticket d5a6100d review round-2
// fix) — the exact literal shape emitted by cli-adapters/pi.ts after a
// successful AWB tool call.
function piBridgeToolCallLine(tool, error = null) {
  return JSON.stringify({ type: 'awb_mcp_bridge_tool_call', server: 'awb', tool, error });
}

let piPidSeq = 80000;
function makePiRecord(overrides = {}) {
  return makeCodexRecord({
    pid: ++piPidSeq,
    cli_type: 'pi',
    captureOutput: false,
    outLines: [],
    tailLines: [],
    ...overrides,
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

/** Routes the GET ticket-context fetch (`fetchTicketContext` /
 *  `hasAuditTrailSince`) to `ticketPayload` while keeping the same /mcp +
 *  REST recording behavior as the shared beforeEach handler. */
function mockTicketFetch(ticketPayload) {
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
      return new Response('', { status: 202 });
    }
    const body = init?.body ? JSON.parse(init.body) : null;
    restPosts.push({ url: u, method, body });
    if (u.includes('/api/agent/tickets/') && !u.endsWith('/silent-exit-comment')) {
      return new Response(JSON.stringify(ticketPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
}

/** ticket 6abe2b79: 공용 beforeEach 목은 tools/call 이름만 기록한다(mcpToolCalls).
 *  run-completion 호출의 args(run_id/status/summary) 까지 검사해야 하는 stop()
 *  회귀 테스트를 위해, 이름+args 를 모두 담는 로컬 fetch override 를 하나로
 *  묶어 둔다 — mockTicketFetch 와 동일한 로컬 override 패턴. */
function makeArgsCapturingFetch() {
  const toolCalls = [];
  const fetchImpl = async (url, init) => {
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
        toolCalls.push({ name: body.params?.name, args: body.params?.arguments });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    const body = init?.body ? JSON.parse(init.body) : null;
    restPosts.push({ url: u, method, body });
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, toolCalls };
}

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

test('ticket 970d6692: a precomputed circuitBreakerDecision=null bypasses spawn()\'s own shouldBlock() re-check', async () => {
  // event-dispatcher.ts's dispatchTrigger→one-shot fallback (ticket 970d6692
  // review round 2) threads dispatchTrigger's OWN already-granted verdict
  // into the fallback spawn() call instead of letting spawn() re-query the
  // breaker — a second independent shouldBlock() call for the SAME attempt
  // would see the lastProbeAt the first call just stamped and re-block it.
  // maxConcurrent: 0 makes canSpawn() fail deterministically right after the
  // breaker gate, isolating exactly that boundary without forking a real CLI.
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');
  cb.record(key, 1);
  cb.record(key, 1); // opens
  cb.getOpenBreakers()[0].entry.openedAt = Date.now() - 200; // cooldown elapsed

  // Simulates gate ① (e.g. dispatchTrigger) already having consumed the
  // single half-open probe grant for this logical attempt.
  assert.equal(cb.shouldBlock(key), null, "precondition: gate ①'s own check granted the probe");

  const mgr = new SubagentManager(
    { url: 'http://127.0.0.1:0', apiKey: 'k', delegation: { enabled: true, maxConcurrent: 0 } },
    cb,
  );
  const res = await mgr.spawn({
    kind: 'trigger',
    taskText: 'x',
    rolePrompt: '',
    triggerId: 'trig-2',
    ticketId: 'ticket-1',
    agentId: 'agent-1',
    role: 'assignee',
    circuitBreakerDecision: null, // event-dispatcher's fallback hand-off
  });

  assert.equal(res.spawned, false);
  assert.equal(
    res.reason,
    'cap_reached',
    'reached past the circuit-breaker gate (blocked by an unrelated cap check, not re-blocked by the breaker)',
  );
});

test('ticket 970d6692: WITHOUT a precomputed decision, a second shouldBlock() call re-blocks the just-granted probe', async () => {
  // Contrast case documenting the bug the fix above avoids: calling spawn()
  // with no circuitBreakerDecision makes it query shouldBlock() itself — the
  // SAME key gate ① (e.g. dispatchTrigger) already granted moments earlier.
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
  const key = CircuitBreaker.key('agent-1', 'ticket-1', 'assignee');
  cb.record(key, 1);
  cb.record(key, 1); // opens
  cb.getOpenBreakers()[0].entry.openedAt = Date.now() - 200; // cooldown elapsed

  assert.equal(cb.shouldBlock(key), null, 'gate ① granted the probe');

  const mgr = new SubagentManager(
    { url: 'http://127.0.0.1:0', apiKey: 'k', delegation: { enabled: true, maxConcurrent: 0 } },
    cb,
  );
  const res = await mgr.spawn({
    kind: 'trigger',
    taskText: 'x',
    rolePrompt: '',
    triggerId: 'trig-2',
    ticketId: 'ticket-1',
    agentId: 'agent-1',
    role: 'assignee',
    // circuitBreakerDecision intentionally omitted.
  });

  assert.equal(res.spawned, false);
  assert.equal(
    res.reason,
    'circuit_breaker_open',
    "gate ②'s own fresh shouldBlock() call sees the lastProbeAt gate ① just stamped and re-blocks — " +
      'exactly why event-dispatcher.ts must thread the decision instead of letting spawn() re-query',
  );
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

test('successful answer resets a NOT-yet-open (partially-tripped) breaker', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  // Two bare-codex-error failures (retryable) — count toward threshold, but
  // 2 < the default threshold of 5, so the breaker never actually opened.
  for (let i = 0; i < 2; i++) {
    const rec = makeCodexRecord({
      outLines: [JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } })],
    });
    await mgr._handleOneshotExit(rec, 1);
  }
  assert.equal(cb.size, 1, 'breaker is tracking the key');

  // Now a clean success → recordSuccess() clears the (never-open) key, same
  // as the old unconditional reset() did.
  const ok = makeCodexRecord({ outLines: codexCleanLines('Done.') });
  await mgr._handleOneshotExit(ok, 0);
  assert.equal(cb.shouldBlock(key), null);
});

test('ticket b2e88390: a successful answer does NOT auto-close an already-OPEN breaker', async () => {
  // Contrast with the test above: here the breaker already tripped (crossed
  // threshold) and pend_ticket already fired for a human. A single lucky
  // half-open probe succeeding must not silently undo that — only an
  // operator's resetAgent() (restart_agent) may fully close it.
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  for (let i = 0; i < 2; i++) {
    const rec = makeCodexRecord({
      outLines: [JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } })],
    });
    await mgr._handleOneshotExit(rec, 1);
  }
  assert.ok(cb.shouldBlock(key), 'breaker is open after crossing the (lowered) threshold');
  assert.ok(mcpToolCalls.includes('pend_ticket'), 'the open crossing already pended the ticket for a human');

  mcpToolCalls.length = 0; // isolate the success dispatch below

  const ok = makeCodexRecord({ outLines: codexCleanLines('Half-open probe: done.') });
  await mgr._handleOneshotExit(ok, 0);

  assert.ok(
    cb.shouldBlock(key),
    'a single successful probe must NOT silently close an already-open breaker',
  );
  assert.equal(
    mcpToolCalls.includes('pend_ticket'),
    false,
    'no NEW pend on a probe success either — the ticket is already parked',
  );
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

test('pi bridge sentinel: add_comment success is recognized and suppresses the silent-exit fallback', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makePiRecord();

  for (const line of [
    '',
    '[awb-mcp-bridge] registered 1 AWB MCP tool(s)',
    piBridgeToolCallLine('add_comment'),
    '완료: add_comment 호출함.',
  ]) {
    mgr._scanForCommentTool(rec, line);
  }
  assert.equal(rec.commentSent, true, 'pi bridge tool-call sentinel counts as a persisted comment');

  await mgr._handleOneshotExit(rec, 0);

  assert.equal(silentExit(), undefined, 'no false system comment after the pi bridge posts add_comment');
});

test('pi bridge sentinel: a failed tool call does NOT set commentSent', () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makePiRecord();

  mgr._scanForCommentTool(rec, piBridgeToolCallLine('add_comment', 'AWB MCP add_comment failed: HTTP 500'));

  assert.equal(rec.commentSent, false);
});

test('pi bridge sentinel: a non-comment tool does NOT set commentSent', () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makePiRecord();

  mgr._scanForCommentTool(rec, piBridgeToolCallLine('get_ticket'));

  assert.equal(rec.commentSent, false);
});

test('pi bridge sentinel: malformed brace-prefixed prose is ignored', () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makePiRecord();

  mgr._scanForCommentTool(rec, '{not actually json, just a stray brace in pi\'s prose reply}');

  assert.equal(rec.commentSent, false);
});

test('pi bridge sentinel: recorded add_comment resets a partially-tripped breaker', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  for (let i = 0; i < 2; i++) {
    await mgr._handleOneshotExit(makePiRecord({ agent_id: 'agent-rolf' }), 1);
  }
  assert.equal(cb.size, 1);

  restPosts.length = 0;

  const ok = makePiRecord({ agent_id: 'agent-rolf' });
  mgr._scanForCommentTool(ok, piBridgeToolCallLine('add_comment'));
  await mgr._handleOneshotExit(ok, 0);

  assert.equal(cb.shouldBlock(key), null, 'a real bridge-posted comment resets the breaker');
  assert.equal(silentExit(), undefined, 'no silent-exit fallback on the successful dispatch');
});

// ── ticket 3feaf80f: Claude one-shot의 commentSent는 구조적으로 항상 false
// 였다(NATIVE_MCP + 배치 `--output-format json` 조합이라 #wireStdioCapture가
// tool_use 이벤트를 아예 보지 못했다) — 그래서 실제로 성공한 티켓-멘션
// dispatch조차 (a) "exited without leaving a ticket comment" 오탐 경고를
// 받았고 (b) circuit breaker의 recordSuccess() 대신 실패 경로로 계상됐다.
// buildOneshotSpawn을 stream-json으로 전환해 고쳤다 — 아래 테스트들은 CLI가
// 이제 실제로 내보내는 이벤트 shape을 받았을 때 _scanForCommentTool + exit
// 핸들러가 올바르게 동작함을 증명한다.

test('Claude native MCP add_comment tool_use (stream-json) suppresses the silent-exit fallback', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({ cli_type: 'claude', captureOutput: false, outLines: [], tailLines: [] });

  mgr._scanForCommentTool(rec, claudeAssistantToolUseLine('mcp__awb__add_comment'));
  assert.equal(rec.commentSent, true, 'Claude stream-json assistant tool_use counts as a persisted comment');

  await mgr._handleOneshotExit(rec, 0);

  assert.equal(silentExit(), undefined, 'no false system comment after Claude add_comment succeeds');
});

test('Claude native MCP move_ticket alone counts as audit trail (ticket 2fd06686)', async () => {
  // Was "does NOT count" pre-fix — a session that only moved the ticket (no
  // add_comment) was always misflagged as silent. move_ticket generates a
  // system "moved from X to Y" Comment row server-side, so it is not silent.
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({ cli_type: 'claude', captureOutput: false, outLines: [], tailLines: [] });

  mgr._scanForCommentTool(rec, claudeAssistantToolUseLine('mcp__awb__move_ticket'));
  assert.equal(rec.commentSent, true, 'move_ticket is now in TICKET_COMMENT_TOOL_SUFFIXES');
});

test('silent-exit: another concurrent spawn comment does not excuse this silent cycle', async () => {
  // The local scanner saw nothing for this spawn while another same-ticket
  // strand posted during its lifetime. Server time-window evidence is not
  // cycle attribution and must not suppress this spawn's warning.
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({
    cli_type: 'claude',
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
  });
  mockTicketFetch({
    comments: [
      {
        id: 'c1',
        content: 'landing comment',
        created_at: new Date(rec.started_at + 5_000).toISOString(),
        metadata: {},
      },
    ],
  });

  await mgr._handleOneshotExit(rec, 0);

  assert.ok(silentExit(), 'the spawn must not borrow another strand comment');
});

test('silent-exit: server re-verification ALSO finds nothing → fallback still fires (genuine silent exit, no regression)', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({
    cli_type: 'claude',
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
  });
  mockTicketFetch({ comments: [] });

  await mgr._handleOneshotExit(rec, 0);

  assert.ok(silentExit(), 'a genuinely silent exit must still be detected after the grace re-verification');
});

test('silent-exit: a comment from BEFORE this spawn started does not count (stale, ticket 2fd06686)', async () => {
  const mgr = new SubagentManager(makeConfig());
  const rec = makeCodexRecord({
    cli_type: 'claude',
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
  });
  mockTicketFetch({
    comments: [
      {
        id: 'c-old',
        content: 'earlier unrelated ticket activity',
        created_at: new Date(rec.started_at - 60_000).toISOString(),
        metadata: {},
      },
    ],
  });

  await mgr._handleOneshotExit(rec, 0);

  assert.ok(silentExit(), 'a stale comment predating this spawn must not suppress the fallback');
});

test('regression (ticket 3feaf80f): a full Claude oneshot turn sequence resets the breaker via recordSuccess, not the failure path', async () => {
  // 실제 `--print --output-format stream-json --verbose` 실행에서
  // #wireStdioCapture가 _scanForCommentTool에 한 줄씩 먹이는 것을 그대로
  // 재현한다: init 배너, add_comment를 호출하는 assistant turn, 이어서
  // move_ticket, 마지막 result. recordSuccess()의 효과를 관찰할 수 있도록
  // 수정 전과 동일한 shape의 silent failure 2회로 미리 breaker를 트립시켜 둔다.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  for (let i = 0; i < 2; i++) {
    const rec = makeCodexRecord({ cli_type: 'claude', captureOutput: false, outLines: [], tailLines: [] });
    await mgr._handleOneshotExit(rec, 0); // clean exit, no comment tool seen — counts as silent failure
  }
  assert.equal(cb.size, 1, 'breaker is tracking the key after two silent (pre-fix-shaped) exits');

  restPosts.length = 0;
  mcpToolCalls.length = 0;

  const rec = makeCodexRecord({ cli_type: 'claude', captureOutput: false, outLines: [], tailLines: [] });
  for (const line of [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    claudeAssistantToolUseLine('mcp__awb__add_comment'),
    claudeAssistantToolUseLine('mcp__awb__move_ticket'),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'Done.' }),
  ]) {
    mgr._scanForCommentTool(rec, line);
  }
  assert.equal(rec.commentSent, true);

  await mgr._handleOneshotExit(rec, 0);

  assert.equal(silentExit(), undefined, 'no false silent-exit warning on the successful dispatch');
  assert.equal(cb.shouldBlock(key), null, 'recordSuccess() cleared the streak — NOT counted as a 3rd failure');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'a genuinely successful dispatch must never pend');
});

test('regression (ticket 68cda8eb): pi stderr sentinel suppresses silent exit and resets the breaker', async () => {
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  for (let i = 0; i < 2; i++) {
    await mgr._handleOneshotExit(makePiRecord(), 0);
  }
  assert.equal(cb.size, 1, 'precondition: two silent pi exits are tracked');

  restPosts.length = 0;
  mcpToolCalls.length = 0;

  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const rec = makePiRecord({ process_handle: child });
  mgr._wireStdioForTest(rec);

  // Literal stream split observed from real pi 0.81.1 `-p`: only the final
  // response reaches stdout; extension console.log and diagnostics are on
  // stderr. Feed the true stdio path rather than calling the scanner seam.
  child.stdout.write('작업을 완료했습니다.\n');
  child.stderr.write('[awb-mcp-bridge] registered 174 AWB MCP tool(s)\n');
  child.stderr.write(`${piBridgeToolCallLine('add_comment')}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rec.commentSent, true, 'pi stderr sentinel must reach the comment scanner');
  await mgr._handleOneshotExit(rec, 0);

  assert.equal(silentExit(), undefined, 'successful pi dispatch must not get a false fallback comment');
  assert.equal(cb.shouldBlock(key), null, 'recordSuccess() resets the prior silent-exit streak');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'successful pi dispatch must not pend');
});

test('respawn-storm regression (ticket c555fbb6): silent exit_code=null opens the breaker + pends', async () => {
  // The 2026-07-14 field incident: an antigravity one-shot (benchmark ticket
  // 2c2c4eb1) died by signal every trigger — exit_code=null, no buffered CLI
  // output, no ticket comment — and the supervisor re-fired it ~2755× because
  // isTransientExit(null) === true kept it OUT of the circuit breaker forever,
  // so the ticket never pended. A silent exit is a failure to deliver
  // regardless of the (transient-looking) code, so N consecutive silent
  // null-exits must now open the breaker and pend the ticket.
  const cb = new CircuitBreaker(); // threshold 5
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-antigravity', 'ticket-2c2c4eb1', 'assignee');

  const makeSilentNullExit = () =>
    makeCodexRecord({
      cli_type: 'antigravity', // plain-text oneshot; empty output → no answer
      captureOutput: true,
      agent_id: 'agent-antigravity',
      ticket_id: 'ticket-2c2c4eb1',
      role: 'assignee',
      outLines: [],
      tailLines: [],
      commentSent: false,
    });

  for (let i = 1; i <= 4; i++) {
    await mgr._handleOneshotExit(makeSilentNullExit(), null);
    assert.equal(cb.shouldBlock(key), null, `breaker still closed after ${i} silent null-exit(s)`);
  }
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no pend before the threshold');
  assert.ok(silentExit(), 'each silent null-exit still posts the system silent-exit fallback');

  await mgr._handleOneshotExit(makeSilentNullExit(), null);

  assert.ok(cb.shouldBlock(key), 'breaker OPEN on the 5th consecutive silent null-exit (was: never)');
  assert.ok(mcpToolCalls.includes('pend_ticket'), 'the storming ticket is finally pended → supervisor stops re-triggering');
});

test('one-off transient null-exit does NOT pend when a later run succeeds (reset)', async () => {
  // Safety rail for the fix above: a single signal-death that is followed by a
  // successful answered run must clear the counter, so a genuinely transient
  // kill never accumulates toward a pend.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-rolf', 'ticket-loop', 'assignee');

  await mgr._handleOneshotExit(
    makeCodexRecord({ cli_type: 'antigravity', captureOutput: true, outLines: [], tailLines: [], commentSent: false }),
    null,
  );
  assert.equal(cb.size, 1, 'the silent null-exit is now tracked (previously it was invisible)');

  const ok = makeCodexRecord({ outLines: codexCleanLines('Recovered and finished the work.') });
  await mgr._handleOneshotExit(ok, 0);

  assert.equal(cb.shouldBlock(key), null, 'a successful run reset the breaker — no pend for a one-off transient');
  assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no pend after recovery');
});

test('gating regression (ticket c555fbb6): a #sweep TTL idle-timeout is dropped BEFORE the exit handler → NOT counted', async (t) => {
  // Reviewer 🟡 gap: the storm tests above call _handleOneshotExit directly, so
  // they only prove "a silent null REACHING the handler is counted" — never the
  // safety core that keeps the storm fix from mis-firing: a manager-initiated
  // reap drops the record from #map first, so its SIGTERM-driven exit
  // early-returns in #wireExitHandler and is NEVER counted. The TTL/idle reaper
  // #sweep is exactly such a reap (circuit-breaker contract: SIGTERM
  // idle-timeout = transient, re-dispatched normally). Without the drop-first,
  // a healthy-but-slow subagent (commentSent=false) TTL-killed at 15min every
  // dispatch would count 5× and falsely pend a working ticket.
  //
  // This drives the REAL #sweep (via _sweepNow) and the REAL exit handler (wired
  // by _trackForTest) with a fake child + a TTL already in the past. It has
  // teeth on BOTH invariants: remove the `#map.delete(pid)` from #sweep and the
  // drop assertion fails; let the exit reach _handleOneshotExit and cb.size flips
  // to 1.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-slow', 'ticket-slow', 'assignee');

  // Fake child we fully control — an EventEmitter carrying a pid.
  const child = new EventEmitter();
  child.pid = ++pidSeq;

  // A HEALTHY-but-slow trigger subagent: no comment yet (commentSent=false) and
  // already past its TTL, so #sweep's TTL branch reaps it.
  const record = {
    pid: child.pid,
    kind: 'trigger',
    cli_type: 'claude',
    trigger_id: 'trig-slow',
    chat_request_id: null,
    ticket_id: 'ticket-slow',
    agent_id: 'agent-slow',
    role: 'assignee',
    room_id: null,
    started_at: Date.now() - 60_000,
    expected_completion_at: Date.now() - 1_000, // already past TTL
    config_path: null,
    config_path_is_temp: false,
    process_handle: child,
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
  };

  // Stub process.kill so the sweep liveness-probe (signal 0) reports ALIVE — so
  // the TTL branch runs, not the ESRCH-cleanup branch — and SIGTERM/SIGKILL are
  // captured, never delivered to the fake pid. Delegate every other pid to the
  // real implementation.
  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  const killed = [];
  process.kill = (pid, sig) => {
    if (pid === child.pid) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };
  // Mock only setTimeout so the 5s SIGKILL-grace timer #sweep schedules neither
  // fires nor keeps the test process alive.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    mgr._trackForTest(record);
    assert.ok(
      mgr._snapshot().some((r) => r.pid === child.pid),
      'record is tracked before the sweep',
    );

    // ticket b972b28c: #sweep now awaits an async live-task probe
    // (findLiveBackgroundTasks) before reaping a TTL-expired record — this
    // fake pid has no real descendants, so the probe finds none and the
    // TTL branch proceeds exactly as before, just after that await.
    await mgr._sweepNow();

    // Drop-first proven: the record is gone from #map (by the time the probe
    // resolved and the kill branch ran), BEFORE the exit event — which is
    // exactly what makes the exit handler early-return.
    assert.equal(
      mgr._snapshot().some((r) => r.pid === child.pid),
      false,
      '#sweep dropped the record from #map before the exit lands',
    );
    assert.ok(
      killed.includes('SIGTERM'),
      'the TTL branch SIGTERM-reaped the pid (proves the TTL branch ran, not ESRCH-cleanup)',
    );

    // Now the SIGTERM lands: a signal death reports code=null.
    child.emit('exit', null, 'SIGTERM');
    await new Promise((r) => setImmediate(r)); // flush the async exit handler

    // Gating proven: the exit handler found no record (dropped) and
    // early-returned, so _handleOneshotExit never ran → breaker untouched, no
    // false pend, no silent-exit fallback.
    assert.equal(cb.size, 0, 'a TTL idle-timeout SIGTERM is NOT counted toward the breaker');
    assert.equal(cb.shouldBlock(key), null, 'breaker stays closed after a TTL reap');
    assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'no false pend from a TTL reap');
    assert.equal(silentExit(), undefined, 'no silent-exit fallback for a TTL reap');
  } finally {
    process.kill = originalKill;
    t.mock.timers.reset();
  }
});

test('shutdown 회귀 (ticket 8436f96f, 6abe2b79): stop() 이 SIGTERM 전에 지우는 대신 stopReason 을 태그 — breaker 는 여전히 미계상, run-completion backstop 은 사유를 보고한다', async (t) => {
  // 8436f96f 가 세운, 이 테스트가 지키는 보장: 매니저 shutdown 킬은 절대
  // circuit-breaker 배달 실패로 오계상되면 안 된다. 원래는 SIGTERM *전에*
  // #map 에서 레코드를 지우는 방식(#sweep/stopForAgent 와 같은 drop-first
  // 관용구)으로 이를 달성했는데, 그 부작용으로 #wireExitHandler 의 #map 조회가
  // 모든 shutdown 킬에서 실패해, 그 시점에 실행 중이던 oneshot Action/QA run 이
  // _runExitCompletionBackstop 에 절대 닿지 못하고 서버에서 2시간 TTL reaper
  // 까지 `running` 으로 방치됐다(ticket 6abe2b79). 이제 stop() 은 레코드를
  // 지우는 대신 stopReason 을 태그해 #map 에 남겨 둔다 — 아래 breaker 보장은
  // "레코드가 없어서"가 아니라 _handleOneshotExit 의 stopReason early-return
  // 으로 유지되고, run-completion backstop 은 실제로 발화한다.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-shutdown', 'ticket-shutdown', 'assignee');
  const child = new EventEmitter();
  child.pid = ++pidSeq;
  const killed = [];
  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  process.kill = (pid, sig) => {
    if (pid === child.pid) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };
  // _sweepOneshotRunOrphans 가 실제 `ps` 서브프로세스를 spawn 해 group 을
  // 조회한다(process-tree.ts 의 findLiveGroupBackgroundTasks) — setImmediate
  // 한 틱보다 오래 걸리므로, 아래 t.mock.timers.enable 이 전역 setTimeout 을
  // 바꾸기 전에 진짜 setTimeout 을 먼저 붙잡아 둔다.
  const realSetTimeout = globalThis.setTimeout;
  const waitUntil = async (predicate, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil: 조건이 시간 내에 충족되지 않음');
      await new Promise((r) => realSetTimeout(r, 10));
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { fetchImpl, toolCalls } = makeArgsCapturingFetch();
  globalThis.fetch = fetchImpl;

  try {
    mgr._trackForTest({
      ...makeCodexRecord({
        pid: child.pid,
        agent_id: 'agent-shutdown',
        ticket_id: 'ticket-shutdown',
        process_handle: child,
        commentSent: false,
      }),
      // ticket 6abe2b79: 죽은 oneshot Action run 의 모습 — exit 시점 backstop
      // 이 종료 처리해야 하는 서버 쪽 run 에 바인딩돼 있다.
      run: { run_id: 'oneshot-shutdown-run', workspace_id: 'ws-1', kind: 'action' },
    });

    const stopping = mgr.stop('manager_shutdown');
    const tracked = mgr._snapshot().find((r) => r.pid === child.pid);
    assert.ok(tracked, 'stop() 은 자식이 실제로 종료할 때까지 레코드를 계속 추적한다(더 이상 drop-first 아님)');
    assert.equal(tracked.stopReason, 'manager_shutdown', 'stop() 이 시그널 전에 사유를 태그한다');
    assert.deepEqual(killed, ['SIGTERM'], 'stop 은 여전히 즉시 SIGTERM 을 보낸다');

    // 실제 exit 핸들러는 'exit' 이 아니라 'close' 를 구독한다(#wireExitHandler
    // 참고) — 'close' 를 emit 해야 실제로 그 경로를 구동한다.
    child.emit('close', null, 'SIGTERM');
    // _sweepOneshotRunOrphans 의 실제 `ps` 서브프로세스 조회가 끝나고
    // _runExitCompletionBackstop 이 complete_action_run 을 호출할 때까지
    // 폴링한다 — 한 번의 setImmediate/microtask 로는 subprocess I/O 를
    // 따라잡지 못한다.
    await waitUntil(() => toolCalls.some((c) => c.name === 'complete_action_run'));

    assert.equal(cb.size, 0, 'shutdown SIGTERM 은 breaker 에 계상되지 않았다');
    assert.equal(cb.shouldBlock(key), null, '매니저 shutdown 중에도 breaker 는 닫힌 채 유지된다');
    assert.equal(mcpToolCalls.includes('pend_ticket'), false, 'shutdown 이 티켓을 잘못 pend 하지 않았다');
    assert.equal(silentExit(), undefined, 'shutdown 이 silent-exit fallback 을 내보내지 않았다');

    const completion = toolCalls.find((c) => c.name === 'complete_action_run');
    assert.ok(completion, 'run-completion backstop 이 죽은 run 에 대해 complete_action_run 을 호출했다');
    assert.equal(completion.args.run_id, 'oneshot-shutdown-run');
    assert.equal(completion.args.status, 'failed');
    assert.match(
      completion.args.summary,
      /reason=manager_shutdown/,
      'summary 가 idle-timer/TTL sweep 추측 대신 실제 사유를 보고한다',
    );

    assert.equal(mgr._snapshot().length, 0, 'exit 핸들러가 실제로 돈 뒤에야 레코드가 정리된다');

    t.mock.timers.tick(60_000);
    await stopping;
    assert.deepEqual(killed, ['SIGTERM', 'SIGKILL'], 'stop 은 grace-period 에스컬레이션을 그대로 유지한다');
  } finally {
    process.kill = originalKill;
    t.mock.timers.reset();
  }
});

test('SIGKILL 강제 경로 회귀 (ticket 6abe2b79 리뷰 반영): grace 만료로 SIGKILL 뒤 close 가 뒤늦게 와도 stop() 은 completion backstop 완료를 기다린 뒤에만 반환한다', async (t) => {
  // 리뷰 지적: SIGKILL 전송 직후 stop() 이 곧바로 반환하면, 호출자(main.ts
  // shutdown())가 곧 process.exit() 하는 사이에 SIGKILL 대상의 'close' 콜백과
  // 그 안의 run-completion backstop 이 미처 못 끝날 수 있다. 이 테스트는 SIGTERM
  // 만으로는 안 죽어(즉 grace 동안 close 를 emit 하지 않아) SIGKILL 로
  // 에스컬레이션되는 케이스를 재현하고, close 가 SIGKILL 이후에야 도착해도
  // stop() 의 반환 자체가 그 완료를 실제로 기다리는지 단언한다.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const child = new EventEmitter();
  child.pid = ++pidSeq;
  const killed = [];
  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  process.kill = (pid, sig) => {
    if (pid === child.pid) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };
  const realSetTimeout = globalThis.setTimeout;
  const waitUntil = async (predicate, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil: 조건이 시간 내에 충족되지 않음');
      await new Promise((r) => realSetTimeout(r, 10));
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { fetchImpl, toolCalls } = makeArgsCapturingFetch();
  globalThis.fetch = fetchImpl;

  try {
    mgr._trackForTest({
      ...makeCodexRecord({
        pid: child.pid,
        agent_id: 'agent-sigkill',
        ticket_id: 'ticket-sigkill',
        process_handle: child,
        commentSent: false,
      }),
      run: { run_id: 'oneshot-sigkill-run', workspace_id: 'ws-1', kind: 'action' },
    });

    const stopping = mgr.stop('manager_shutdown');

    // SIGTERM grace 만 흘려보내고 close 는 아직 emit 하지 않는다 — SIGTERM 을
    // 무시하는 프로세스를 흉내낸다. STOP_FORCE_KILL_SETTLE_MS 타이머는 SIGKILL
    // 루프 *이후*에야 등록되므로, 여기서는 정확히 grace 분량만 흘려보낸다.
    t.mock.timers.tick(STOP_GRACE_MS);
    await new Promise((r) => realSetTimeout(r, 0)); // SIGKILL 루프의 동기 이어달리기를 흘려보냄
    assert.deepEqual(killed, ['SIGTERM', 'SIGKILL'], 'SIGTERM 만으로 안 죽어 SIGKILL 로 에스컬레이션됐다');

    let resolved = false;
    stopping.then(() => {
      resolved = true;
    });
    await new Promise((r) => realSetTimeout(r, 20));
    assert.equal(resolved, false, 'close 가 아직 안 왔으므로 stop() 은 아직 반환하면 안 된다 — 이게 바로 리뷰가 지적한 race');

    // 이제 SIGKILL 이 실제로 죽인 것처럼 close 를 뒤늦게 emit.
    child.emit('close', null, 'SIGKILL');
    await waitUntil(() => toolCalls.some((c) => c.name === 'complete_action_run'));
    await stopping;

    assert.equal(resolved, true, 'stop() 은 실제 exit 핸들러(backstop 포함)가 끝난 뒤에야 반환했다');
    const completion = toolCalls.find((c) => c.name === 'complete_action_run');
    assert.ok(completion, 'SIGKILL 로 죽은 victim 의 run 도 completion backstop 이 호출됐다');
    assert.equal(completion.args.run_id, 'oneshot-sigkill-run');
    assert.match(completion.args.summary, /reason=manager_shutdown/);
    assert.equal(mgr._snapshot().length, 0, '실제 close 이벤트가 왔으므로 레코드가 정리됐다');
    assert.equal(cb.size, 0, 'SIGKILL 강제 경로도 breaker 에는 계상되지 않는다');
  } finally {
    process.kill = originalKill;
    t.mock.timers.reset();
  }
});

test('SIGKILL 이후 close 가 끝내 오지 않는 극단 케이스 (ticket 6abe2b79 리뷰 반영): 상한 만료 시 stop() 이 직접 completion backstop 을 호출해 무음 유실을 막는다', async (t) => {
  // 리뷰 지적 ④: close 콜백이 (예: SIGKILL 에도 안 죽는 병적인 프로세스처럼)
  // 끝내 오지 않으면, bounded wait 만으로는 상한에서 조용히 포기해 버려 이
  // 티켓이 고치려던 무음 유실이 다른 모습으로 재발한다. stop() 은 상한 만료 시
  // 그 victim 에 한해 직접 completion backstop 을 호출해야 한다.
  const cb = new CircuitBreaker();
  const mgr = new SubagentManager(makeConfig(), cb);
  const child = new EventEmitter();
  child.pid = ++pidSeq;
  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  process.kill = (pid, sig) => (pid === child.pid ? true : realKill(pid, sig));
  // 위 SIGKILL 회귀 테스트와 동일한 이유로 진짜 setTimeout 을 먼저 붙잡아 둔다:
  // t.mock.timers.tick() 은 tick 호출 "시점에 이미 등록된" 타이머만 동기적으로
  // 흘려보낸다 — grace 타이머의 콜백(그 안에서 SIGKILL 루프를 돌고 settle
  // 타이머를 새로 등록하는 코드)은 await 의 연속이라 마이크로태스크로 밀리므로,
  // 한 번의 tick() 호출 안에서는 settle 타이머가 아직 존재하지 않아 캐스케이드
  // 되지 않는다(먼저 이 파일의 첫 SIGKILL 테스트에서 실측 확인 — 한 번에 몰아
  // tick 했더니 settle 타이머가 등록되기도 전에 tick() 이 끝나 stop() 이 영원히
  // 안 풀렸다). 그래서 grace 만큼 tick → 진짜 시간으로 한 틱 흘려보내 SIGKILL
  // 루프가 실제로 돌고 settle 타이머가 등록되게 함 → settle 만큼 tick, 두 단계로
  // 나눈다.
  const realSetTimeout = globalThis.setTimeout;
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { fetchImpl, toolCalls } = makeArgsCapturingFetch();
  globalThis.fetch = fetchImpl;

  try {
    mgr._trackForTest({
      ...makeCodexRecord({
        pid: child.pid,
        agent_id: 'agent-wedged',
        ticket_id: 'ticket-wedged',
        process_handle: child,
        commentSent: false,
      }),
      run: { run_id: 'oneshot-wedged-run', workspace_id: 'ws-1', kind: 'security' },
    });

    const stopping = mgr.stop('manager_shutdown');
    // grace + settle 상한을 모두 흘려보내되, close 는 한 번도 emit 하지 않는다
    // — SIGKILL 조차 안 통하는 병적인 케이스를 흉내낸다. #stop() 의 fallback 은
    // 실 서브프로세스(ps)를 부르지 않고 fireAndForgetTool 만 부르므로, 목 fetch
    // 만으로 결정적으로 끝난다.
    t.mock.timers.tick(STOP_GRACE_MS);
    await new Promise((r) => realSetTimeout(r, 0)); // SIGKILL 루프 + settle 타이머 등록을 흘려보냄
    t.mock.timers.tick(STOP_FORCE_KILL_SETTLE_MS + 100);
    await stopping;

    const completion = toolCalls.find((c) => c.name === 'complete_security_run');
    assert.ok(completion, 'close 가 끝내 안 와도 stop() 이 직접 completion backstop 을 호출해야 한다');
    assert.equal(completion.args.run_id, 'oneshot-wedged-run');
    assert.equal(completion.args.status, 'error');
    assert.match(completion.args.summary, /reason=manager_shutdown/);
    assert.equal(
      mgr._snapshot().some((r) => r.pid === child.pid),
      true,
      '실제 close 이벤트는 안 왔으므로 레코드 자체는 #map 에 남아있다 — 진짜 정리는 close 가 오면 그때 일어난다',
    );
    assert.equal(cb.size, 0, '병적인 SIGKILL-면역 케이스도 breaker 에는 계상되지 않는다');
  } finally {
    process.kill = originalKill;
    t.mock.timers.reset();
  }
});
