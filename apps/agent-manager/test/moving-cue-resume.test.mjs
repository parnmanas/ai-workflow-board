// Unit test — TicketSessionManager moving-cue resume guard (ticket ce6c8d58).
//
// Validates the supervisor logic that watches Claude stream-json output for
// an `add_comment` toolcall whose body promises a `move_ticket` follow-up
// ("Moving to Merging.") and force-injects a continuation turn if the
// model ends its turn (or 30s pass) without actually firing `move_ticket`.
//
// We drive `_onStdoutParsed` directly with synthetic ParseResult objects
// matching the Claude stream-json shape, and override `_sendFollowUp` to
// capture what the supervisor would inject. No real CLI child is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0, // skip the real grace delay (ticket 2fd06686) in tests
    delegation: {
      enabled: true,
      maxConcurrent: 10,
      idleMinutes: 999,
      maxTurnsPerSession: 999,
    },
  };
}

function makeFakeSession(pid) {
  const child = {
    pid,
    stdin: { write: () => true, end: () => {} },
    once: () => {},
  };
  return {
    sessionKey: `ticket-x:reviewer`,
    pid,
    ticketId: 'ce6fb4dd-1ded-42a4-98ab-7cd9977053ac',
    role: 'reviewer',
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
    tap: null,
  };
}

function makeAssistantToolUseLine(toolName, input) {
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

function makeResultLine() {
  return { stage: null, isResult: true, isError: false, raw: { type: 'result' } };
}

function makeMgr() {
  const mgr = new TicketSessionManager(makeConfig());
  const followUps = [];
  // Replace _sendFollowUp with a capture stub — we want to observe what the
  // supervisor would inject without actually writing to a child stdin.
  mgr._sendFollowUp = (sess, text, opts) => {
    followUps.push({ pid: sess.pid, text, opts });
  };
  return { mgr, followUps };
}

test('moving cue + isResult without move_ticket → inject resume', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(1001);

  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'LGTM — approved for merge.\n\nMoving to Merging.',
  }), '');
  assert.equal(followUps.length, 0, 'no follow-up yet — turn still in progress');

  mgr._onStdoutParsed(sess, makeResultLine(), '');
  assert.equal(followUps.length, 1, 'turn ended while armed → resume injected');
  assert.match(followUps[0].text, /move_ticket/);
  assert.match(followUps[0].text, /Supervisor/);
});

test('moving cue followed by move_ticket → no injection', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(1002);

  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'LGTM. Moving to Merging.',
  }), '');
  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__move_ticket', {
    ticket_id: sess.ticketId,
    target_column_name: 'Merging',
  }), '');
  mgr._onStdoutParsed(sess, makeResultLine(), '');

  assert.equal(followUps.length, 0, 'move_ticket fired before turn end → guard disarmed cleanly');
});

test('add_comment without moving cue → no arming', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(1003);

  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'Quick observation — the test coverage looks solid.',
  }), '');
  mgr._onStdoutParsed(sess, makeResultLine(), '');

  assert.equal(followUps.length, 0, 'no moving cue in body → no guard armed');
});

test('cue both arms AND disarms in the same assistant message (batched tool_use)', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(1004);
  // Claude sometimes batches multiple tool_use blocks in one assistant turn.
  // If the same turn contains both add_comment(with cue) and move_ticket,
  // the guard arms then disarms before the turn ends — no injection.
  mgr._onStdoutParsed(
    sess,
    {
      stage: 'composing',
      isResult: false,
      isError: false,
      raw: {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__awb__add_comment', input: { content: 'LGTM. Moving to Merging.' } },
            { type: 'tool_use', name: 'mcp__awb__move_ticket', input: { ticket_id: sess.ticketId, target_column_name: 'Merging' } },
          ],
        },
      },
    },
    '',
  );
  mgr._onStdoutParsed(sess, makeResultLine(), '');

  assert.equal(followUps.length, 0, 'batched add_comment+move_ticket in one turn → no injection');
});

test('injection fires at most once per pid', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(1005);

  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'Moving to Merging.',
  }), '');
  mgr._onStdoutParsed(sess, makeResultLine(), '');
  assert.equal(followUps.length, 1);

  // Even if the model emits another add_comment + isResult on the same pid
  // (e.g. it called move_ticket after our nudge and then wrote a closing
  // note that also says "Moving to ..."), we don't re-fire.
  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'Done. Moving to Merging.',
  }), '');
  mgr._onStdoutParsed(sess, makeResultLine(), '');
  assert.equal(followUps.length, 1, 'second arming on same pid is a no-op (already injected)');
});

test('_onChildExit cleans up pending state', async () => {
  const { mgr } = makeMgr();
  const sess = makeFakeSession(1006);

  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'Moving back to In Progress.',
  }), '');

  // Call exit handler directly — should clear the in-memory state without
  // throwing. We don't have a public peek so we just exercise the path.
  await mgr._onChildExit(sess, 0, null);
  // Subsequent isResult on the same (now-stale) pid must not inject — the
  // exit handler scrubbed the cue state, so the post-exit isResult is a
  // no-op.
  const { followUps } = makeMgr();
  mgr._sendFollowUp = (sess2, text) => followUps.push({ pid: sess2.pid, text });
  mgr._onStdoutParsed(sess, makeResultLine(), '');
  assert.equal(followUps.length, 0, 'post-exit isResult is a no-op');
});

test('cue matches the documented variants', () => {
  const { mgr, followUps } = makeMgr();
  const cases = [
    'LGTM. Moving to Merging.',
    'Bouncing back — Moving back to In Progress.',
    'Now moving the ticket to Done.',
    'Move to Merging now that tests pass.',
  ];
  let pid = 2000;
  for (const body of cases) {
    const sess = makeFakeSession(pid++);
    mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
      ticket_id: sess.ticketId,
      content: body,
    }), '');
    mgr._onStdoutParsed(sess, makeResultLine(), '');
  }
  assert.equal(followUps.length, cases.length, `expected ${cases.length} injections, got ${followUps.length}`);
});

test('cue does NOT match comments that only reference the tool name', () => {
  const { mgr, followUps } = makeMgr();
  const sess = makeFakeSession(2100);
  mgr._onStdoutParsed(sess, makeAssistantToolUseLine('mcp__awb__add_comment', {
    ticket_id: sess.ticketId,
    content: 'I considered calling move_ticket but decided to leave it where it is for now.',
  }), '');
  mgr._onStdoutParsed(sess, makeResultLine(), '');
  assert.equal(followUps.length, 0, 'tool-name mention alone must not arm the guard');
});
