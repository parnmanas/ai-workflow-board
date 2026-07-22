// Unit test — TicketSessionManager (persistent ticket-session) circuit-breaker
// integration, ticket b2e88390.
//
// oneshot-circuit-breaker.test.mjs covers the one-shot SubagentManager side.
// This file is the persistent-session mirror: TicketSessionManager has its
// OWN two circuitBreaker.recordSuccess() call sites (mid-stream, the instant a
// comment-creating tool_use is parsed off stdout; and on exit, when the
// session ends with `commented=true`) — both used to call the unconditional
// reset(), which fully closed an already-OPEN breaker on nothing more than a
// single lucky half-open probe succeeding. That silently undid the human
// signal pend_ticket had already raised. Same seam as watchdog-respawn.test.mjs:
// drive `_onStdoutParsed` / `_onChildExit` directly on a fake session.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';
import { CircuitBreaker } from '../dist/lib/circuit-breaker.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: {
      enabled: true,
      maxConcurrent: 10,
      idleMinutes: 999,
      maxTurnsPerSession: 999,
    },
  };
}

function makeFakeSession(pid, overrides = {}) {
  const child = {
    pid,
    stdin: { write: () => true, end: () => {} },
    stdout: null,
    stderr: null,
    once: () => {},
  };
  return {
    sessionKey: 'ticket-cb:assignee:agent-1',
    pid,
    ticketId: 'ticket-cb',
    role: 'assignee',
    agentId: 'agent-1',
    cli_type: 'claude',
    adapter: {
      cliType: 'claude',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
    },
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 1,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    chainAttempt: 0,
    modelChain: [null],
    tap: null,
    ...overrides,
  };
}

function makeAssistantToolUseLine(toolName, input = {}) {
  return {
    stage: 'composing',
    isResult: false,
    isError: false,
    raw: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: toolName, input }] },
    },
  };
}

test('mid-stream: a comment tool_use while the breaker is OPEN does not auto-close it', () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const mgr = new TicketSessionManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-1', 'ticket-cb', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens — this is what pend_ticket already fired against
  assert.ok(cb.shouldBlock(key), 'breaker open before the probe');

  const sess = makeFakeSession(31001);
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__add_comment', { content: 'half-open probe succeeded' }),
    '',
  );

  assert.ok(
    cb.shouldBlock(key),
    'a single successful comment must NOT silently close an already-open breaker',
  );
});

test('on exit: a post-comment session end while the breaker is OPEN does not auto-close it', async () => {
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const mgr = new TicketSessionManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-1', 'ticket-cb', 'assignee');

  cb.record(key, 0);
  cb.record(key, 0); // opens
  assert.ok(cb.shouldBlock(key), 'breaker open before the probe');

  const sess = makeFakeSession(31002);
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__add_comment', { content: 'probe succeeded, then exited' }),
    '',
  );
  await mgr._onChildExit(sess, 0, null);

  assert.ok(
    cb.shouldBlock(key),
    'a post-comment clean exit must NOT silently close an already-open breaker — ' +
      'only a human/operator resetAgent() (restart_agent) may fully clear it',
  );
});

test('regression: a comment tool_use on a NOT-yet-open (sub-threshold) streak still clears it', () => {
  const cb = new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 });
  const mgr = new TicketSessionManager(makeConfig(), cb);
  const key = CircuitBreaker.key('agent-1', 'ticket-cb', 'assignee');

  cb.record(key, 41, 'boom');
  cb.record(key, 41, 'boom'); // 2/5 — well below threshold, never opened
  assert.equal(cb.shouldBlock(key), null);

  const sess = makeFakeSession(31003);
  mgr._onStdoutParsed(
    sess,
    makeAssistantToolUseLine('mcp__awb__add_comment', { content: 'recovered before ever tripping' }),
    '',
  );

  assert.equal(cb.size, 0, 'ordinary recovery below the threshold still fully clears — unaffected by ticket b2e88390');
});
