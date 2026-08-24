// Regression guard for ticket 6ff827cb — idle/maxTurns/keep-alive session
// reaping must CHECK for progress evidence before killing, not just fire on
// a clock. Governing principle: a timer expiring means CHECK, not KILL — see
// session-progress.ts (the 3-signal gate) and
// BaseSessionManager#_onIdleTimerFired.
//
// All idle/maxTurns checks are driven directly through the protected
// `_onIdleTimerFired` / `_maybeCloseForMaxTurns` test seams — the suite never
// waits on a real (unref'd) setTimeout firing, so it can't hang CI the way
// waiting out a real idle/recheck window would (mirrors the existing
// `_writeTurn` / `_trackSessionForTest` seam convention in
// watchdog-liveness.test.mjs / cycle-comment-attribution.test.mjs).
//
// `process.kill` is stubbed in every test that could reach a kill/terminate
// path, and every fake pid is either the out-of-range DEAD_PID sentinel or,
// for the one test that needs a REAL live descendant (signal 2 shells out to
// the real `ps`), this test process's own pid with a short-lived spawned
// child that is killed in `finally` — that test only exercises the DEFER
// branch, which never calls process.kill.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';
import { createAdapter } from '../dist/lib/cli-adapters/index.js';
import { encodeProjectDirName } from '../dist/lib/session-progress.js';

// Every cli-home fixture below writes into THIS session-scoped subtree —
// signal 3 is scoped to `<cliHomeDir>/projects/<encodeProjectDirName(cwd)>/`
// (ticket 6ff827cb round-1 review, P1), not the cli-home root, so a fixture
// must supply BOTH `_cliHomeDir` and `_cwd` and write under this helper's
// path, or it is testing a directory signal 3 no longer scans.
function scopedCliHomeDir(cliHomeDir, cwd) {
  return join(cliHomeDir, 'projects', encodeProjectDirName(cwd));
}

const DEAD_PID = 0x7fffffff;

function makeConfig(overrides = {}) {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: {
      enabled: true,
      maxConcurrent: 10,
      idleMinutes: 10,
      idleRecheckSeconds: 1,
      maxTurnsPerSession: 30,
      chatKeepAliveMaxMinutes: 120,
      progressEscalationHours: 4,
      ...overrides,
    },
  };
}

let pidSeq = 82000;
function makeFakeSession(overrides = {}) {
  const pid = overrides.pid ?? ++pidSeq;
  return {
    sessionKey: `sess-${pid}`,
    pid,
    cli_type: 'claude',
    adapter: createAdapter('claude'),
    child: {
      pid,
      stdin: { end: () => {} },
      stdout: null,
      stderr: null,
      once: () => {},
    },
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
    ...overrides,
  };
}

// A real EventEmitter + PassThrough child so #wireStdio/#wireExit (wired via
// the public `_trackSessionForTest` seam) run the REAL stdio/readline path —
// same technique as cycle-comment-attribution.test.mjs.
let childPidSeq = 91000;
function fakeChild() {
  const child = new EventEmitter();
  child.pid = ++childPidSeq;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

class Harness extends BaseSessionManager {
  constructor(config) {
    super(config, { keyField: 'sessionKey', logTag: '[test-session]', cfgPrefix: 'cfg-test-', kindLabel: 'chat_session' });
  }
  checkIdle(sess, idleWindowMs) {
    return this._onIdleTimerFired(sess, idleWindowMs);
  }
  checkMaxTurns(sess, maxTurns) {
    return this._maybeCloseForMaxTurns(sess, maxTurns);
  }
  checkUnhealthy(sess, reason) {
    return this._maybeKillUnhealthy(sess, reason);
  }
  writeTurn(sess, text) {
    return this._writeTurn(sess, text);
  }
}

let originalFetch;
let posts;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const m = u.match(/\/api\/agent\/chat-rooms\/([^/]+)\/messages$/);
    if (m && (init?.method || 'GET') === 'POST') {
      posts.push({ roomId: decodeURIComponent(m[1]), body: JSON.parse(init.body) });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const settle = () => delay(30);

// `settle()`'s fixed 30ms assumes the fire-and-forget `_maybeKillUnhealthy`
// gate (checkSessionProgress → findLiveBackgroundTasks) resolves within that
// window. On windows-latest CI, findLiveBackgroundTasks shells out to
// PowerShell (`Get-CimInstance Win32_Process`) to enumerate every process,
// which routinely takes well over 30ms to spawn/complete — the fixed delay
// races a genuinely slow-but-correct gate and asserts before it resolves.
// Poll for the actual outcome instead, bounded so a real hang still fails
// fast.
async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil: condition not met within timeout');
    await delay(intervalMs);
  }
}

// ── 1. idle expired + live background task → does not close stdin, rearms ──

test('idle expired + a live background task → stdin stays open, timer rearms (defer, not kill)', async () => {
  const mgr = new Harness(makeConfig());
  let ended = false;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const sess = makeFakeSession({
    pid: process.pid, // findLiveBackgroundTasks walks descendants of THIS pid
    child: { pid: process.pid, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
  });
  try {
    mgr._sessions.set(sess.sessionKey, sess);
    await delay(200); // let the spawned child register in the OS process table
    await mgr.checkIdle(sess, 10 * 60_000);
    assert.equal(ended, false, 'must NOT close stdin while a live background task exists');
    assert.ok(sess.idleTimer, 'timer re-armed for a recheck instead of waiting a full idleMinutes again');
    assert.ok(mgr._sessions.has(sess.sessionKey), 'session record kept alive');
  } finally {
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    child.kill('SIGKILL');
  }
});

// ── 2. idle expired + no background task, no output, no cli-home → closes stdin (regression guard) ──

test('idle expired + zero progress evidence → closes stdin exactly like before (no resource regression)', async () => {
  const mgr = new Harness(makeConfig());
  let ended = false;
  const sess = makeFakeSession({
    pid: DEAD_PID,
    child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
  });
  mgr._sessions.set(sess.sessionKey, sess);
  await mgr.checkIdle(sess, 10 * 60_000);
  assert.equal(ended, true, 'a genuinely idle session (no output/tasks/cli-home activity) still reaps');
  // ticket b831b896 round 3: tagged before stdin.end() so a run-completion
  // backstop can report the real cause instead of guessing.
  assert.equal(sess.stopReason, 'idle');
});

// ── 3. stdout activity resets the idle gate (signal 1) ──

test('any stdout line unconditionally records signal 1 and alone defers the reap', async () => {
  const mgr = new Harness(makeConfig());
  const child = fakeChild();
  const sess = makeFakeSession({ pid: child.pid, child });
  mgr._trackSessionForTest(sess.sessionKey, sess);

  assert.equal(sess._lastOutputAtMs, undefined, 'no output observed yet');
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    }) + '\n',
  );
  await delay(30); // let the readline 'line' handler run
  assert.ok(sess._lastOutputAtMs, 'a real stdout line unconditionally records _lastOutputAtMs');

  let ended = false;
  sess.child.stdin.end = () => { ended = true; };
  await mgr.checkIdle(sess, 10 * 60_000);
  assert.equal(ended, false, 'fresh model output alone (no background task, no cli-home) defers the reap');
});

test('stdout activity actually resets the idle timer itself (non-blocking review observation)', async () => {
  // Requirement 1 asks for idle = time since last ACTIVITY. Signal 1 alone
  // (previous test) makes the progress GATE defer correctly, but without
  // this the idle timer still fires on the old cadence and re-scans the
  // whole process-tree + cli-home every recheck interval even while output
  // keeps flowing. Resetting the timer on real output avoids that.
  const mgr = new Harness(makeConfig());
  const child = fakeChild();
  const sess = makeFakeSession({ pid: child.pid, child });
  mgr._trackSessionForTest(sess.sessionKey, sess);
  mgr._resetIdleTimer(sess);
  const timerBefore = sess.idleTimer;
  assert.ok(timerBefore, 'idle timer armed');

  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
    }) + '\n',
  );
  await delay(30); // let the readline 'line' handler run

  assert.notEqual(sess.idleTimer, timerBefore, 'a fresh stdout line rearms the idle timer, not just _lastOutputAtMs');
  assert.equal(sess.idleTimer.hasRef(), false, 'the freshly-armed timer stays unref-ed');
  clearTimeout(sess.idleTimer);
});

// ── 3b. cli-home mtime (signal 3) — the ★최우선 fix: an in-process Workflow ──
// tool call blocks the parent turn (no stdout) and runs in-process (no child
// process), so signals 1+2 are BOTH blind to it — this was the exact blind
// spot in the incident that opened this ticket. Signal 3 is the only
// observable evidence for that case: the Workflow's own subagents keep
// writing transcript files under the session's cli-home dir.

test('fresh cli-home activity alone defers the reap — the in-process Workflow blind spot', async () => {
  const mgr = new Harness(makeConfig());
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'awb-cli-home-'));
  const cwd = '/workspace/ticket-6ff827cb';
  let ended = false;
  let sess;
  try {
    sess = makeFakeSession({
      pid: DEAD_PID,
      _cliHomeDir: cliHomeDir,
      _cwd: cwd,
      child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(sess.sessionKey, sess);
    // Simulate an in-process Workflow subagent still appending its transcript
    // under THIS session's own scoped subtree — zero stdout on the parent
    // turn, zero child processes, but the file just changed.
    const scopedDir = scopedCliHomeDir(cliHomeDir, cwd);
    await mkdir(scopedDir, { recursive: true });
    await writeFile(join(scopedDir, 'agent-abc123.jsonl'), '{"line":1}\n');

    await mgr.checkIdle(sess, 10 * 60_000);
    assert.equal(ended, false, 'a session with no output/tasks but fresh cli-home activity must not be reaped');
  } finally {
    if (sess?.idleTimer) clearTimeout(sess.idleTimer);
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});

test('stale cli-home (no recent writes) does NOT count as progress (regression: an old dir alone can\'t immortalize a session)', async () => {
  const mgr = new Harness(makeConfig());
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'awb-cli-home-'));
  const cwd = '/workspace/ticket-6ff827cb';
  let ended = false;
  try {
    const scopedDir = scopedCliHomeDir(cliHomeDir, cwd);
    await mkdir(scopedDir, { recursive: true });
    const oldFile = join(scopedDir, 'old.json');
    await writeFile(oldFile, '{}');
    // Backdate the mtime deterministically (not a wall-clock race against a
    // tiny freshness window — mtime resolution/scheduling jitter made an
    // earlier version of this test flaky).
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(oldFile, old, old);
    const sess = makeFakeSession({
      pid: DEAD_PID,
      _cliHomeDir: cliHomeDir,
      _cwd: cwd,
      child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(sess.sessionKey, sess);
    await mgr.checkIdle(sess, 10 * 60_000); // normal 10-minute freshness window — the file is an hour old
    assert.equal(ended, true, 'cli-home activity outside the freshness window is not evidence');
  } finally {
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});

// ── 3c. P1 fix — signal 3 is SESSION-scoped, not agent-scoped (round-1 review) ──
// Two sessions of the same agent normally run in two different cwds (each
// ticket/room gets its own dedicated workspace folder), so they land in two
// different `projects/<encoded-cwd>/` subtrees under the SAME shared
// cli-home root. Session B's writes must not read as session A's evidence.

test('P1 regression: a busy sibling session sharing the same cli-home does NOT keep an idle session alive', async () => {
  const mgr = new Harness(makeConfig());
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'awb-cli-home-'));
  const cwdA = '/workspace/ticket-aaaaaaaa';
  const cwdB = '/workspace/ticket-bbbbbbbb';
  let endedA = false;
  let sessA;
  try {
    sessA = makeFakeSession({
      pid: DEAD_PID,
      _cliHomeDir: cliHomeDir,
      _cwd: cwdA,
      child: { pid: DEAD_PID, stdin: { end: () => { endedA = true; } }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(sessA.sessionKey, sessA);

    // Session B (a different ticket, same agent/cli-home) is busy RIGHT NOW —
    // fresh write in ITS OWN scoped subtree only.
    const scopedDirB = scopedCliHomeDir(cliHomeDir, cwdB);
    await mkdir(scopedDirB, { recursive: true });
    await writeFile(join(scopedDirB, 'agent-busy.jsonl'), '{"line":1}\n');

    await mgr.checkIdle(sessA, 10 * 60_000);
    assert.equal(
      endedA,
      true,
      'session A must still be reaped — a sibling session B writing under the shared cli-home root is not A\'s evidence',
    );
  } finally {
    if (sessA?.idleTimer) clearTimeout(sessA.idleTimer);
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});

test('P1 control: encodeProjectDirName pins the exact Claude Code directory-name convention', () => {
  // Real cwd → cli-home directory-name pairs observed on disk (dash-encodes
  // every non-alphanumeric character; consecutive dashes are NOT collapsed).
  // This is an external CLI convention, not something AWB defines — pin it so
  // a silent mismatch degrades to "signal 3 finds nothing" instead of
  // resurrecting the cross-session bug this test file guards against.
  assert.equal(
    encodeProjectDirName('/mnt/data/awb-agents/awb.programmer/.awb/wt/c76a8201-968c-4dec-8b03-f5d19421c227/6ff827cb'),
    '-mnt-data-awb-agents-awb-programmer--awb-wt-c76a8201-968c-4dec-8b03-f5d19421c227-6ff827cb',
  );
  assert.equal(
    encodeProjectDirName('/mnt/data/awb-agents/awb.programmer/.awb/base/c76a8201-968c-4dec-8b03-f5d19421c227'),
    '-mnt-data-awb-agents-awb-programmer--awb-base-c76a8201-968c-4dec-8b03-f5d19421c227',
  );
});

// ── 4. maxTurns hits the same progress gate (requirement 4) ──

test('maxTurns reached but progress detected → defers the respawn instead of closing stdin', async () => {
  const mgr = new Harness(makeConfig());
  let ended = false;
  const sess = makeFakeSession({
    pid: DEAD_PID,
    child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
    _lastOutputAtMs: Date.now(), // fresh output evidence
  });
  mgr._sessions.set(sess.sessionKey, sess);
  await mgr.checkMaxTurns(sess, 30);
  assert.equal(ended, false, 'maxTurns alone must not cut off a session with fresh progress evidence');
});

test('maxTurns reached + zero progress evidence → closes stdin for respawn (regression guard)', async () => {
  const mgr = new Harness(makeConfig());
  let ended = false;
  const sess = makeFakeSession({
    pid: DEAD_PID,
    child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
  });
  mgr._sessions.set(sess.sessionKey, sess);
  await mgr.checkMaxTurns(sess, 30);
  assert.equal(ended, true, 'a genuinely idle session at maxTurns still respawns as before');
  // ticket b831b896 round 3: distinct from 'idle' — this is a turn-count
  // cap, not an activity timeout, and a run-completion backstop should say so.
  assert.equal(sess.stopReason, 'max_turns');
});

// ── 4b. unhealthy watchdog hits the same progress gate (P0, round-1 review) ──
// Both unhealthy-kill triggers (#healthSweep's 30m time threshold and
// _writeTurn's 5-consecutive-turn threshold) used to call #killUnhealthy
// directly, bypassing checkSessionProgress/_keepAliveUntilMs entirely — a
// session blocked on a long in-process Workflow tool call emits ZERO stdout
// by definition, so the exact blind spot fixed for the idle timer (section
// 3b) was still wide open here. `checkUnhealthy` drives the SAME
// `_maybeKillUnhealthy` gate both `#healthSweep` and `_writeTurn` call.

test('P0 regression: unhealthy time-threshold hit but fresh cli-home activity → defers the kill', async () => {
  const mgr = new Harness(makeConfig());
  const origKill = process.kill;
  let killed = false;
  process.kill = () => { killed = true; };
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'awb-cli-home-'));
  const cwd = '/workspace/ticket-unhealthy-a';
  let sess;
  try {
    sess = makeFakeSession({
      pid: DEAD_PID,
      _cliHomeDir: cliHomeDir,
      _cwd: cwd,
      unrespondedSince: Date.now() - 31 * 60_000, // 31m silent — past UNHEALTHY_DURATION_MS (30m)
    });
    mgr._sessions.set(sess.sessionKey, sess);
    const scopedDir = scopedCliHomeDir(cliHomeDir, cwd);
    await mkdir(scopedDir, { recursive: true });
    await writeFile(join(scopedDir, 'agent-workflow.jsonl'), '{"line":1}\n'); // in-process Workflow still writing

    await mgr.checkUnhealthy(sess, '31m elapsed without an LLM response');
    assert.equal(killed, false, 'must NOT SIGTERM a session with fresh cli-home (in-process Workflow) evidence');
    assert.equal(sess.unhealthyKilled, false, 'not flagged unhealthy-killed');
    assert.ok(mgr._sessions.has(sess.sessionKey), 'session record kept alive');
  } finally {
    process.kill = origKill;
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});

test('P0 regression: unhealthy turn-threshold hit but active keep-alive → defers the kill', async () => {
  const mgr = new Harness(makeConfig({ chatKeepAliveMaxMinutes: 120 }));
  const origKill = process.kill;
  let killed = false;
  // applyKeepAlive resolves through _getLiveSession's OS-level liveness probe
  // (process.kill(pid, 0), signal 0 — "does this pid exist?", never a real
  // kill). Only flag a REAL termination signal, or this stub would also trip
  // on that harmless probe and false-fail the test before the actual gate
  // under test ever runs.
  process.kill = (_pid, sig) => { if (sig) killed = true; };
  try {
    // applyKeepAlive resolves through the OS-level _getLiveSession check —
    // use this test process's own (genuinely alive) pid, same as the
    // existing applyKeepAlive tests above.
    const sess = makeFakeSession({ pid: process.pid, unrespondedTurnCount: 5 });
    mgr._sessions.set(sess.sessionKey, sess);
    const grant = mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 60, reason: 'long workflow' });
    assert.equal(grant.ok, true);

    await mgr.checkUnhealthy(sess, '5 consecutive turns without an LLM response');
    assert.equal(killed, false, 'must NOT SIGTERM a session with an active keep-alive grant');
    assert.equal(sess.unhealthyKilled, false, 'not flagged unhealthy-killed');
    assert.ok(mgr._sessions.has(sess.sessionKey), 'session record kept alive');
  } finally {
    process.kill = origKill;
  }
});

test('P0 control: unhealthy hit + zero progress evidence + no keep-alive → still kills exactly like before (no regression)', async () => {
  const mgr = new Harness(makeConfig());
  const origKill = process.kill;
  let killed = null;
  process.kill = (pid, sig) => { killed = { pid, sig }; };
  try {
    const sess = makeFakeSession({ pid: DEAD_PID, unrespondedSince: Date.now() - 31 * 60_000 });
    mgr._sessions.set(sess.sessionKey, sess);
    await mgr.checkUnhealthy(sess, '31m elapsed without an LLM response');
    assert.ok(killed && killed.pid === DEAD_PID && killed.sig === 'SIGTERM', 'a genuinely silent session is still SIGTERM-ed');
    assert.equal(sess.unhealthyKilled, true);
    assert.equal(mgr._sessions.has(sess.sessionKey), false, 'session record dropped');
    // ticket b831b896 round 3: tagged before SIGTERM so a run-completion
    // backstop can report the real cause instead of guessing.
    assert.equal(sess.stopReason, 'health_watchdog');
  } finally {
    process.kill = origKill;
  }
});

// ── 4c. P0 integration — the same gate through the REAL _writeTurn wiring, ──
// not just the extracted _maybeKillUnhealthy method, so a future refactor
// that stops _writeTurn from calling the gate at all still gets caught.

test('P0 integration: 5 consecutive unresponded turns via _writeTurn + fresh cli-home evidence → session survives', async () => {
  const mgr = new Harness(makeConfig());
  const origKill = process.kill;
  let killed = false;
  process.kill = () => { killed = true; };
  const cliHomeDir = await mkdtemp(join(tmpdir(), 'awb-cli-home-'));
  const cwd = '/workspace/ticket-unhealthy-b';
  let sess;
  try {
    sess = makeFakeSession({
      pid: DEAD_PID,
      _cliHomeDir: cliHomeDir,
      _cwd: cwd,
      child: { pid: DEAD_PID, stdin: { write: () => true, end: () => {} }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(sess.sessionKey, sess);
    const scopedDir = scopedCliHomeDir(cliHomeDir, cwd);
    await mkdir(scopedDir, { recursive: true });
    await writeFile(join(scopedDir, 'agent-workflow.jsonl'), '{"line":1}\n');

    for (let i = 0; i < 5; i++) mgr.writeTurn(sess, `turn ${i}`); // UNHEALTHY_TURN_THRESHOLD = 5
    assert.equal(sess.unrespondedTurnCount, 5, 'threshold reached');
    await settle(); // let the fire-and-forget _maybeKillUnhealthy gate resolve

    assert.equal(killed, false, 'progress evidence must defer the kill even through the real dispatch path');
    assert.equal(sess.unhealthyKilled, false);
    assert.ok(mgr._sessions.has(sess.sessionKey), 'session record kept alive');
  } finally {
    process.kill = origKill;
    await rm(cliHomeDir, { recursive: true, force: true });
  }
});

test('P0 integration control: 5 consecutive unresponded turns via _writeTurn + zero evidence → session still killed (no regression)', async () => {
  const mgr = new Harness(makeConfig());
  const origKill = process.kill;
  let killed = null;
  process.kill = (pid, sig) => { killed = { pid, sig }; };
  try {
    const sess = makeFakeSession({
      pid: DEAD_PID,
      child: { pid: DEAD_PID, stdin: { write: () => true, end: () => {} }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(sess.sessionKey, sess);

    for (let i = 0; i < 5; i++) mgr.writeTurn(sess, `turn ${i}`);
    await waitUntil(() => killed !== null);

    assert.ok(
      killed && killed.pid === DEAD_PID && killed.sig === 'SIGTERM',
      'a genuinely silent session at the turn threshold is still SIGTERM-ed',
    );
    assert.equal(sess.unhealthyKilled, true);
    assert.equal(mgr._sessions.has(sess.sessionKey), false);
  } finally {
    process.kill = origKill;
  }
});

// ── 5. explicit keep-alive: grant clamps to the hard ceiling, defers unconditionally ──

test('applyKeepAlive: grant is clamped to the hard ceiling, and defers the idle reap unconditionally', async () => {
  const mgr = new Harness(makeConfig({ chatKeepAliveMaxMinutes: 30 }));
  let ended = false;
  // applyKeepAlive resolves through _getLiveSession (an OS-level pid-alive
  // check) — use this test process's own (genuinely alive) pid. Safe: unlike
  // #forceTerminate, applyKeepAlive never signals the process.
  const sess = makeFakeSession({
    pid: process.pid,
    child: { pid: process.pid, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
  });
  mgr._sessions.set(sess.sessionKey, sess);

  const grant = mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 200, reason: 'long workflow' });
  assert.equal(grant.ok, true);
  assert.ok(
    grant.until <= Date.now() + 30 * 60_000 + 500,
    'a 200-minute request is clamped to the 30-minute hard ceiling, not granted in full',
  );

  await mgr.checkIdle(sess, 10 * 60_000); // zero progress evidence otherwise — keep-alive alone must save it
  assert.equal(ended, false, 'an active keep-alive grant defers the reap regardless of the progress gate');

  const released = mgr.applyKeepAlive(sess.sessionKey, { action: 'release' });
  assert.equal(released.ok, true);
  assert.equal(sess._keepAliveUntilMs, null, 'release clears the active grant');
});

test('applyKeepAlive: release does not reset the hard-ceiling clock (no release+re-extend loophole)', () => {
  const mgr = new Harness(makeConfig({ chatKeepAliveMaxMinutes: 30 }));
  const sess = makeFakeSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);

  const first = mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 10 });
  assert.equal(first.ok, true);
  const firstDeclaredAt = sess._keepAliveFirstDeclaredAtMs;
  assert.ok(firstDeclaredAt, 'first declaration timestamp stamped');

  mgr.applyKeepAlive(sess.sessionKey, { action: 'release' });
  mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 10 });
  assert.equal(
    sess._keepAliveFirstDeclaredAtMs,
    firstDeclaredAt,
    'a release+re-extend cycle must NOT push the ceiling clock forward — "무기한 keep-alive 금지"',
  );
});

test('applyKeepAlive: extend is rejected once the hard ceiling is already reached', () => {
  const mgr = new Harness(makeConfig({ chatKeepAliveMaxMinutes: 30 }));
  const sess = makeFakeSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);
  const first = mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 5 });
  assert.equal(first.ok, true, 'first declaration succeeds');
  // Backdate the first declaration past the ceiling.
  sess._keepAliveFirstDeclaredAtMs = Date.now() - 31 * 60_000;

  const result = mgr.applyKeepAlive(sess.sessionKey, { action: 'extend', minutes: 5 });
  assert.equal(result.ok, false, 'cannot extend past the ceiling no matter how many times it is called');
  assert.match(result.error ?? '', /ceiling/, 'rejection reason names the ceiling, not an unrelated failure');
});

// ── 6. keep-alive ceiling reached during an idle check → force-terminate + visible room notice ──

test('keep-alive ceiling reached → force-terminates the session and posts a room notice (never silent)', async () => {
  const mgr = new ChatSessionManager(makeConfig({ chatKeepAliveMaxMinutes: 30 }));
  const origKill = process.kill;
  let killed = null;
  process.kill = (pid, sig) => { killed = { pid, sig }; };
  try {
    const roomId = 'room-ka';
    const agentId = 'agent-ka';
    const key = `${roomId}|${agentId}`;
    const sess = makeFakeSession({
      pid: DEAD_PID,
      sessionKey: key,
      roomId,
      agentId,
      _effectiveApiKey: 'test-key',
      child: { pid: DEAD_PID, stdin: { end: () => {} }, stdout: null, stderr: null, once: () => {} },
    });
    mgr._sessions.set(key, sess);

    mgr.applyRoomKeepAlive(roomId, agentId, { action: 'extend', minutes: 200, reason: 'stress test' });
    // Simulate the ceiling having been reached (backdate the first declaration).
    sess._keepAliveFirstDeclaredAtMs = Date.now() - 31 * 60_000;

    await mgr._onIdleTimerFired(sess, 10 * 60_000);
    await settle();

    assert.ok(killed && killed.pid === DEAD_PID && killed.sig === 'SIGTERM', 'ceiling breach signals the CLI child');
    assert.equal(mgr._sessions.has(key), false, 'session record dropped immediately (drop-first, like #killUnhealthy)');
    // ticket b831b896 round 3: tagged before SIGTERM (on the retained local
    // `sess` reference — the map entry is already gone by this point).
    assert.equal(sess.stopReason, 'keep_alive_ceiling');

    const notices = posts.filter((p) => p.roomId === roomId);
    assert.equal(notices.length, 1, 'exactly one room notice posted — never a silent kill');
    assert.match(notices[0].body.content, /keep-alive/i, 'notice explains the ceiling was the reason');
    assert.match(notices[0].body.content, /stress test/, 'notice surfaces the declared reason');
  } finally {
    process.kill = origKill;
  }
});

// ── gap 4: a session running past progressEscalationHours gets ONE visible ──
// escalation, but is NEVER killed for it — killing something with real
// progress evidence would violate the governing principle.

test('a session running past progressEscalationHours gets exactly ONE visible escalation, and is not killed', async () => {
  const mgr = new ChatSessionManager(makeConfig({ progressEscalationHours: 1 }));
  const roomId = 'room-esc';
  const agentId = 'agent-esc';
  const key = `${roomId}|${agentId}`;
  let ended = false;
  const sess = makeFakeSession({
    pid: DEAD_PID,
    sessionKey: key,
    roomId,
    agentId,
    _effectiveApiKey: 'test-key',
    startedAt: Date.now() - 2 * 3_600_000, // 2h ago, past the 1h threshold
    _lastOutputAtMs: Date.now(), // fresh progress evidence — must defer, not kill
    child: { pid: DEAD_PID, stdin: { end: () => { ended = true; } }, stdout: null, stderr: null, once: () => {} },
  });
  mgr._sessions.set(key, sess);

  await mgr._onIdleTimerFired(sess, 10 * 60_000);
  await settle();
  assert.equal(ended, false, 'real progress evidence — escalation is a notice, not a kill');
  assert.ok(sess._progressEscalatedAt, 'escalation timestamp stamped so it does not repeat');

  const notices = posts.filter((p) => p.roomId === roomId);
  assert.equal(notices.length, 1, 'exactly one escalation notice posted');

  // A second idle-check tick must NOT post a duplicate escalation.
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  await mgr._onIdleTimerFired(sess, 10 * 60_000);
  await settle();
  assert.equal(posts.filter((p) => p.roomId === roomId).length, 1, 'escalation fires at most once per session');
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
});

// ── 7. idle timer is unref'd (never keeps CI process alive) ──

test('idle timer is unref-ed so it can never hold the Node event loop open', () => {
  const mgr = new Harness(makeConfig());
  const sess = makeFakeSession({ pid: DEAD_PID });
  mgr._resetIdleTimer(sess);
  assert.ok(sess.idleTimer, 'timer scheduled');
  assert.equal(typeof sess.idleTimer.hasRef, 'function', 'a real Timeout object');
  assert.equal(sess.idleTimer.hasRef(), false, 'must be unref-ed — an idle chat with nobody watching must not block process exit');
  clearTimeout(sess.idleTimer);
});
