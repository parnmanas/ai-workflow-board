// Regression guard for ticket 876b7679 — the agent-manager health watchdog
// must not SIGTERM a worker that is actively working.
//
// The bug (commit 8930a6f, v0.6.4): `BaseSessionManager`'s watchdog reset its
// unresponded-turn counter ONLY when the CLI emitted a `result` line. A worker
// mid-long-turn emits no `result` until it finishes, but its own "starting
// work" comment + ticket move bounce back as board-update SSE events that get
// injected as turns 2/3/4 on the SAME session. With a result-only reset the
// counter raced to UNHEALTHY_TURN_THRESHOLD (5) in ~85s and the still-working
// child was killed (exit 143) before writing a line of code. The fix resets
// the counter on ANY model output (thinking/composing stage OR result), so
// only a genuinely silent CLI (no output at all → stage===null) can trip it.
//
// These tests pin both halves of that contract against the REAL code:
//   1. `_writeTurn` + `#killUnhealthy`  — N silent turns DO kill at exactly the
//      threshold (the watchdog's intended "LLM went silent" behaviour).
//   2. The REAL claude parser + the wireStdio reset predicate — every JSON
//      output line is a liveness signal, so a worker that keeps emitting
//      survives unbounded self-echoed turns.
//   3. The claude parser characterization — what counts as "output" vs
//      "silence" for the watchdog.
//   4. A source guard that locks the landed reset to "any stage OR result",
//      so a future edit can't silently revert it to result-only.
//
// `#wireStdio`/`#killUnhealthy` are hard-private, so 1 drives the kill through
// the protected `_writeTurn` seam, and 2 mirrors the single wireStdio reset
// line (guarded verbatim by test 4) using the REAL adapter to decide liveness.
// No real CLI child is spawned; `process.kill` is stubbed and the fake pid is
// out of range, so the suite issues no OS signals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Compiled JS — agent-manager builds via `npm run build`; `node --test` runs
// against the dist tree, mirroring session-dedup.test.mjs.
import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';
import { createAdapter } from '../dist/lib/cli-adapters/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A pid guaranteed not to map to a live process (just below INT32_MAX), so the
// watchdog's process.kill never reaches a real child even if the stub is gone.
const DEAD_PID = 0x7fffffff;

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

// A session record shaped like the one `_spawnSession` builds, with a fake
// child whose stdin swallows writes. Uses the REAL claude adapter so
// `_writeTurn`'s formatTurn and the liveness parser are the production code.
function makeFakeSession(pid) {
  return {
    sessionKey: `tkt-${pid}:assignee`,
    pid,
    cli_type: 'claude',
    adapter: createAdapter('claude'),
    child: {
      pid,
      stdin: { write: () => true, end: () => {} },
      stdout: null,
      stderr: null,
      once: () => {},
    },
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 0,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
  };
}

// Expose the protected `_writeTurn` seam (dispatch a turn onto a session).
class Harness extends TicketSessionManager {
  pump(sess) {
    this._writeTurn(sess, 'do some long-running work');
  }
}

// Mirror of base-session-manager.ts `#wireStdio` liveness reset. Kept here so
// the test can drive it per-line; the REAL line it copies is locked verbatim
// by the "source guard" test below.
function applyLivenessReset(sess, parsed) {
  if (parsed.stage || parsed.isResult) {
    sess.unrespondedTurnCount = 0;
    sess.unrespondedSince = null;
  }
}

test('silent turns kill at exactly UNHEALTHY_TURN_THRESHOLD (watchdog still works)', () => {
  const origKill = process.kill;
  const signals = [];
  process.kill = (pid, sig) => {
    signals.push({ pid, sig });
  };
  try {
    const mgr = new Harness(makeConfig());
    const sess = makeFakeSession(DEAD_PID);
    mgr._sessions.set(sess.sessionKey, sess);

    // Four silent turns (no model output between them) must NOT kill.
    for (let i = 1; i <= 4; i++) {
      mgr.pump(sess);
      assert.equal(sess.unrespondedTurnCount, i, `counter tracks turn ${i}`);
      assert.equal(sess.unhealthyKilled, false, `must not kill before threshold (turn ${i})`);
    }
    // The fifth silent turn reaches the threshold → kill for respawn.
    mgr.pump(sess);
    assert.equal(sess.unhealthyKilled, true, 'killed at threshold');
    assert.ok(
      signals.some((s) => s.pid === DEAD_PID && s.sig === 'SIGTERM'),
      'SIGTERM issued to the silent child',
    );
    assert.equal(mgr._sessions.has(sess.sessionKey), false, 'killed session removed from map');
  } finally {
    process.kill = origKill;
  }
});

test('any model output resets liveness — a busy worker survives self-echoed turns', () => {
  const origKill = process.kill;
  process.kill = () => {};
  try {
    const mgr = new Harness(makeConfig());
    const sess = makeFakeSession(DEAD_PID - 1);
    mgr._sessions.set(sess.sessionKey, sess);
    const adapter = createAdapter('claude');

    // Real-world loop: each injected turn (the worker's own board-update echo)
    // is interleaved with the worker emitting output lines while it works.
    const outputLines = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}',
    ];
    for (let i = 0; i < 12; i++) {
      mgr.pump(sess); // turn injected (would push counter toward the threshold)
      const parsed = adapter.parseStdoutLine(outputLines[i % outputLines.length]);
      applyLivenessReset(sess, parsed); // worker is alive → counter cleared
      assert.equal(sess.unhealthyKilled, false, `turn ${i + 1} must stay alive`);
      assert.ok(sess.unrespondedTurnCount <= 1, `counter never accumulates (turn ${i + 1})`);
    }
    assert.equal(sess.unrespondedTurnCount, 0, 'counter sits at 0 while output flows');
    assert.equal(sess.unrespondedSince, null, 'duration-watchdog clock cleared too');
  } finally {
    process.kill = origKill;
  }
});

test('claude parser: every JSON line signals liveness; only non-JSON is silence', () => {
  const a = createAdapter('claude');

  // Any well-formed JSON CLI event proves the LLM is responding.
  for (const line of [
    '{"type":"assistant","message":{}}',
    '{"type":"system","subtype":"init"}',
    '{"type":"user","message":{}}',
    '{"type":"tool_use","name":"Bash"}',
  ]) {
    const p = a.parseStdoutLine(line);
    assert.ok(p.stage || p.isResult, `JSON event must signal liveness: ${line}`);
  }

  const result = a.parseStdoutLine('{"type":"result","subtype":"success"}');
  assert.equal(result.isResult, true, 'result line is a liveness signal');

  // Non-JSON / blank lines are the ONLY thing the watchdog treats as silence —
  // these are what let a genuinely hung CLI trip the kill as intended.
  for (const line of ['', '   ', 'not json at all', 'thinking…', '<<partial chunk']) {
    const p = a.parseStdoutLine(line);
    assert.equal(p.stage, null, `non-JSON must NOT signal liveness: ${JSON.stringify(line)}`);
    assert.equal(p.isResult, false, `non-JSON is not a result: ${JSON.stringify(line)}`);
  }
});

test('source guard: wireStdio resets liveness on any stage, not result-only', () => {
  // Locks the landed fix: the reset branch must consider `parsed.stage`, not
  // just `parsed.isResult`. A revert to result-only reintroduces the exit-143
  // self-kill, so fail loudly if the predicate narrows.
  const src = readFileSync(
    join(__dirname, '..', 'dist', 'lib', 'base-session-manager.js'),
    'utf8',
  );
  assert.match(
    src,
    /parsed\.stage\s*\|\|\s*parsed\.isResult/,
    'liveness reset must trigger on stage OR result (regression lock for ticket 876b7679)',
  );
});
