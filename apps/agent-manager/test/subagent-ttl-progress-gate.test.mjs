// Unit test — SubagentManager#sweep's one-shot TTL progress gate (ticket
// b972b28c).
//
// Source ticket 6ff827cb moved BaseSessionManager's idle/maxTurns reaper
// behind a governing principle: a timer expiring means CHECK, not KILL —
// killing is justified only by the ABSENCE of progress evidence, never by
// elapsed wall-clock alone. This ticket ports the MINIMUM slice of that same
// principle onto the one-shot subagent path: #sweep's `now >=
// expected_completion_at` hard-kill (subagent-manager.ts) now checks signal 2
// (a live non-benign descendant process — findLiveBackgroundTasks) first. If
// found, the deadline slides instead of reaping the subagent out from under
// real work it's waiting on.
//
// session-progress.ts (ticket 6ff827cb's checkSessionProgress) is NOT
// imported here — that branch is still unmerged at the time of writing, and
// SubagentManager's SubagentRecord has no SessionRecord-shaped fields to feed
// it anyway (see the ticket's own scope-out). findLiveBackgroundTasks itself
// is already on main (ticket 89716f04, process-tree.ts) and is reused as-is.
//
// Each test builds its own SubagentManager + a hand-built SubagentRecord and
// drives the REAL #sweep pass via _sweepNow() + _trackForTest() (board lesson
// 742d86f1 / ticket c555fbb6) — never _handleOneshotExit directly — so the
// real kill-path gating (drop-first, live-task probe, in-flight guard) is
// actually exercised, not just the accounting it feeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import { SubagentManager } from '../dist/lib/subagent-manager.js';

function makeConfig(delegation = {}) {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0,
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15, ...delegation },
  };
}

let pidSeq = 90000;

/** A baseline SubagentRecord-shaped plain object. `pid` defaults to a
 *  synthetic (never-real) pid — override with `process.pid` when a test
 *  needs findLiveBackgroundTasks to walk REAL descendants. */
function makeRecord(overrides = {}) {
  return {
    kind: 'trigger',
    pid: ++pidSeq,
    cli_type: 'claude',
    trigger_id: 'trig-1',
    chat_request_id: null,
    ticket_id: 'ticket-1',
    agent_id: 'agent-1',
    role: 'assignee',
    room_id: null,
    started_at: Date.now() - 5_000,
    expected_completion_at: Date.now() - 1_000, // already past TTL
    config_path: null,
    config_path_is_temp: false,
    process_handle: new EventEmitter(),
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(check, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

test('signal 2 (live background task) found → slides expected_completion_at, does NOT kill', async () => {
  const mgr = new SubagentManager(makeConfig());
  // A real child of THIS test process — findLiveBackgroundTasks(process.pid)
  // walks the real ps tree and finds it, exactly like session-progress-gate's
  // established pattern (ticket 6ff827cb) for simulating "live background
  // work" without mocking process-tree.ts.
  const bgChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const record = makeRecord({ pid: process.pid, started_at: Date.now() - 5_000 });

  // Safety net: `record.pid` is THIS test process. Intercept any actual
  // termination signal so a latent bug in the gate can never SIGTERM/SIGKILL
  // the test runner itself. Signal 0 (liveness probe) passes through real —
  // it never sends anything, just checks existence.
  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  const killed = [];
  process.kill = (pid, sig) => {
    if (pid === process.pid && sig !== 0) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };

  try {
    mgr._trackForTest(record);
    const before = record.expected_completion_at;

    await mgr._sweepNow();

    assert.equal(killed.length, 0, 'no SIGTERM/SIGKILL while a live background task exists');
    assert.ok(record.expected_completion_at > before, 'expected_completion_at slid forward');
    assert.ok(
      mgr._snapshot().some((r) => r.pid === process.pid),
      'record stays tracked — not reaped',
    );
    assert.equal(record.progressEscalatedAt, undefined, 'no escalation this early (age << default 4h)');
  } finally {
    process.kill = originalKill;
    bgChild.kill('SIGKILL');
  }
});

test('negative control — TTL exceeded + NO live background task → still reaps (unchanged behavior)', async (t) => {
  const mgr = new SubagentManager(makeConfig());
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const record = makeRecord({ pid: child.pid, process_handle: child });

  try {
    mgr._trackForTest(record);
    assert.equal(isDead(child.pid), false, 'the real child is alive before the sweep');

    await mgr._sweepNow();

    assert.equal(
      mgr._snapshot().some((r) => r.pid === child.pid),
      false,
      '#sweep dropped the record — the no-live-task path still reaps exactly as before',
    );
    const died = await waitFor(() => isDead(child.pid));
    assert.equal(died, true, 'the real child received the SIGTERM and exited');
  } finally {
    if (!isDead(child.pid)) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});

test('still-alive one-shot past subagentProgressEscalationHours → ONE log-only escalation, never killed', async () => {
  // hours=0 makes the age check trivially true without needing a fake clock
  // or a real multi-hour wait — any non-negative age qualifies.
  const mgr = new SubagentManager(makeConfig({ subagentProgressEscalationHours: 0 }));
  const bgChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const record = makeRecord({ pid: process.pid, started_at: Date.now() - 5_000 });

  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  const killed = [];
  process.kill = (pid, sig) => {
    if (pid === process.pid && sig !== 0) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };

  try {
    mgr._trackForTest(record);

    await mgr._sweepNow();
    assert.equal(killed.length, 0, 'still not killed — escalation is notify-only, same as BaseSessionManager gap-4');
    assert.ok(record.progressEscalatedAt, 'progressEscalatedAt set on first qualifying sweep');
    const firstEscalatedAt = record.progressEscalatedAt;

    // A second qualifying tick must NOT re-escalate (one-time notice, not
    // spammed on every 60s recheck for the life of a long-running one-shot).
    record.expected_completion_at = Date.now() - 1_000; // re-arm past TTL for this tick
    await mgr._sweepNow();
    assert.equal(record.progressEscalatedAt, firstEscalatedAt, 'escalation timestamp unchanged — fired at most once');
    assert.equal(killed.length, 0, 'still not killed on the second qualifying tick either');
  } finally {
    process.kill = originalKill;
    bgChild.kill('SIGKILL');
  }
});

test('overlapping #sweep ticks are guarded — a synchronous second call does not double-reap the same pid', async (t) => {
  // No real descendants for this synthetic pid, so the live-task probe
  // resolves empty and (absent the in-flight guard) BOTH overlapping calls
  // would independently reach the kill branch for the same record.
  const mgr = new SubagentManager(makeConfig());
  const record = makeRecord();

  const originalKill = process.kill;
  const realKill = originalKill.bind(process);
  const killed = [];
  process.kill = (pid, sig) => {
    if (pid === record.pid) {
      killed.push(sig);
      return true;
    }
    return realKill(pid, sig);
  };
  // Neutralize the SIGKILL-grace timer(s) the kill branch schedules so the
  // test doesn't hang the runner waiting on a real 5s timer (mirrors the
  // c555fbb6 gating test's own convention).
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    mgr._trackForTest(record);

    const p1 = mgr._sweepNow(); // runs synchronously up to its live-task-probe await, then yields
    const p2 = mgr._sweepNow(); // re-enters #sweep synchronously WHILE p1 is mid-probe — must be a guarded no-op
    await Promise.all([p1, p2]);

    assert.equal(
      killed.filter((s) => s === 'SIGTERM').length,
      1,
      'the in-flight guard prevents a second overlapping pass from double-reaping the same pid',
    );
  } finally {
    process.kill = originalKill;
    t.mock.timers.reset();
  }
});
