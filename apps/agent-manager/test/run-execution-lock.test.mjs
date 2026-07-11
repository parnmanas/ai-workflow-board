// Run-lifetime execution lock (ticket e9d0e8bc). Covers:
//   - FolderMutex: different keys never block; same key serializes with correct
//     wasBusy; FIFO ordering; idempotent release; the key frees after the last
//     release so a later non-concurrent acquire is not "busy".
//   - resolveRunFolder: the dispatcher's lock key equals the folder
//     provisionRunWorkspace actually uses (they MUST match or the lock guards
//     the wrong path); leading-slash strip; AGENT_MANAGER_HOME fallback.
//   - ChatSessionManager._onChildExit fires the run-lock release (releaseRunLock)
//     on EVERY exit, including a path that would otherwise early-return — this is
//     the process-exit BACKSTOP of the run-exit hook. The oneshot SubagentManager
//     path stores + fires the symmetric onSpawnExit from its #wireExitHandler
//     closure (type-checked; mirrors this path).
//   - ticket 9a28bf53: ChatSessionManager._sweepTurnEndOrphans releases the lock
//     EARLY on a clean turn (folder idle — no live background descendants) so a
//     same-scenario successor stops waiting up to idleMinutes; it does NOT release
//     on the pid-dead path (there _onChildExit owns it). Idempotency (early
//     release unblocks the waiter; the process-exit backstop is a no-op) is
//     pinned at the FolderMutex level.
//
// The fallback test asserts against the AGENT_MANAGER_HOME constant directly
// (rather than repointing the env) so it is immune to ES-module import-hoist
// timing — a static import below loads constants.js before any top-level code.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FolderMutex } from '../dist/lib/run-execution-lock.js';
import { resolveRunFolder, provisionRunWorkspace } from '../dist/lib/run-provisioner.js';
import { AGENT_MANAGER_HOME } from '../dist/lib/constants.js';
import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';

const tick = () => new Promise((r) => setImmediate(r));

// ── FolderMutex ───────────────────────────────────────────────────────────────

test('FolderMutex: different keys never block each other', async () => {
  const m = new FolderMutex();
  const a = await m.acquire('/scenario-a');
  const b = await m.acquire('/scenario-b'); // different key → immediate
  assert.equal(a.wasBusy, false);
  assert.equal(b.wasBusy, false);
  assert.equal(m.activeKeyCount, 2);
  a.release();
  b.release();
  assert.equal(m.activeKeyCount, 0);
});

test('FolderMutex: same key serializes — second acquire waits for first release', async () => {
  const m = new FolderMutex();
  const order = [];
  const a = await m.acquire('/shared');
  assert.equal(a.wasBusy, false);

  let bAcquired = false;
  const bp = m.acquire('/shared').then((h) => {
    bAcquired = true;
    order.push('b-acquired');
    return h;
  });

  await tick();
  assert.equal(bAcquired, false, 'b must not acquire while a holds the lock');

  order.push('a-release');
  a.release();
  const b = await bp;
  assert.equal(b.wasBusy, true, 'b waited behind a → wasBusy true');
  assert.deepEqual(order, ['a-release', 'b-acquired'], 'b acquires only after a releases');
  b.release();
  assert.equal(m.activeKeyCount, 0);
});

test('FolderMutex: FIFO — multiple waiters proceed in acquire order', async () => {
  const m = new FolderMutex();
  const done = [];
  const a = await m.acquire('/f');
  const p1 = m.acquire('/f').then((h) => (done.push(1), h));
  const p2 = m.acquire('/f').then((h) => (done.push(2), h));

  await tick();
  assert.deepEqual(done, [], 'both waiters block while a holds');

  a.release();
  const h1 = await p1;
  assert.deepEqual(done, [1]);
  h1.release();
  const h2 = await p2;
  assert.deepEqual(done, [1, 2], 'waiters resume in order');
  h2.release();
  assert.equal(m.activeKeyCount, 0);
});

test('FolderMutex: release is idempotent and frees the key for a later acquire', async () => {
  const m = new FolderMutex();
  const a = await m.acquire('/k');
  a.release();
  a.release(); // second release is a no-op
  a.release();
  assert.equal(m.activeKeyCount, 0, 'key freed after release');

  const b = await m.acquire('/k'); // later, non-concurrent
  assert.equal(b.wasBusy, false, 'freed key is not busy for a later acquire (warm-reuse note stays quiet)');
  b.release();
  assert.equal(m.activeKeyCount, 0);
});

// ── resolveRunFolder ↔ provisioner consistency ────────────────────────────────

const RUN = (folder, over = {}) => ({
  kind: 'qa',
  run_id: 'run-1234',
  workspace_id: 'ws-1',
  workspace_folder: folder,
  checkout_mode: 'reuse',
  repo: null,
  ...over,
});

test('resolveRunFolder: absolute folder under the base working_dir; leading slash cannot escape', () => {
  const base = mkdtempSync(join(tmpdir(), 'awb-runexec-base-'));
  assert.equal(resolveRunFolder(RUN('.awb/qa/abc12345'), base), resolve(join(base, '.awb/qa/abc12345')));
  // a leading slash on workspace_folder is stripped, never escapes the base.
  assert.equal(resolveRunFolder(RUN('/.awb/qa/abc12345'), base), resolve(join(base, '.awb/qa/abc12345')));
});

test('resolveRunFolder equals the folder provisionRunWorkspace uses (lock key == provisioner dir)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'awb-runexec-base-'));
  const p = RUN('.awb/qa/keymatch1'); // repo:null → just ensures the folder, sets dir
  const key = resolveRunFolder(p, base);
  const res = await provisionRunWorkspace(p, base);
  assert.equal(res.ok, true);
  assert.equal(res.dir, key, 'the dispatcher lock key must equal the provisioner cwd, or the lock guards the wrong path');
});

test('resolveRunFolder falls back to AGENT_MANAGER_HOME when the base is empty', () => {
  assert.equal(
    resolveRunFolder(RUN('.awb/qa/def67890', { kind: 'security' }), ''),
    resolve(join(AGENT_MANAGER_HOME, '.awb/qa/def67890')),
  );
});

// ── Run-exit hook: persistent (Claude) path ──────────────────────────────────

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: { enabled: true, maxConcurrent: 10, idleMinutes: 999, maxTurnsPerSession: 999 },
  };
}

function makeChatSession(pid, overrides = {}) {
  return {
    sessionKey: `room-${pid}|agent-1`,
    pid,
    roomId: `room-${pid}`,
    agentId: 'agent-1',
    cli_type: 'claude',
    adapter: {
      cliType: 'claude',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
    },
    child: { pid, stdin: { write: () => true, end: () => {} }, once: () => {} },
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

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('ChatSessionManager._onChildExit fires releaseRunLock once on a normal exit', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  let released = 0;
  const sess = makeChatSession(30001, { releaseRunLock: () => released++ });
  await mgr._onChildExit(sess, 0, null);
  assert.equal(released, 1, 'run-lifetime lock release fired exactly once on exit');
});

test('ChatSessionManager._onChildExit fires releaseRunLock BEFORE any early-return (killed session, empty agentId)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  let released = 0;
  // agentId '' makes _onChildExit return early at `if (!roomId || !agentId)`;
  // releaseRunLock must still fire (it runs first), so a SIGTERM-killed run session
  // releases its folder lock instead of stranding it.
  const sess = makeChatSession(30002, { agentId: '', releaseRunLock: () => released++ });
  await mgr._onChildExit(sess, 143, 'SIGTERM');
  assert.equal(released, 1, 'lock released even when the fallback path early-returns');
});

test('ChatSessionManager._onChildExit is a no-op for ordinary sessions (no releaseRunLock set)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(30003); // no releaseRunLock
  await mgr._onChildExit(sess, 0, null); // must not throw
  assert.ok(true);
});

// ── ticket 9a28bf53: turn-end early release via _sweepTurnEndOrphans ──────────
//
// The sweep is driven directly (it is `protected`, not `#private`) to skip the
// ORPHAN_SWEEP_GRACE_MS timer. `_isPidAlive` is overridden so pid liveness is a
// fixed verdict; a sentinel pid has no OS descendants, so the real
// findLiveBackgroundTasks returns [] and the clean-turn branch runs
// deterministically — no real child process, no wall-clock wait.
class SweepTestManager extends ChatSessionManager {
  constructor(config, pidAlive) {
    super(config);
    this._pidAliveVerdict = pidAlive;
  }
  _isPidAlive() {
    return this._pidAliveVerdict;
  }
}

const DEAD_SENTINEL_PID = 2147483640; // no live process has this as an ancestor

test('_sweepTurnEndOrphans: clean turn (folder idle) releases the run lock EARLY', async () => {
  const mgr = new SweepTestManager(makeConfig(), true); // pid treated as alive
  let released = 0;
  const sess = makeChatSession(DEAD_SENTINEL_PID, {
    _run: { run_id: 'runclean1', workspace_id: 'ws-1', kind: 'qa' },
    releaseRunLock: () => released++,
  });
  await mgr._sweepTurnEndOrphans(sess);
  assert.equal(
    released,
    1,
    'clean turn (0 live background tasks) → run folder lock released early, without waiting for process exit',
  );
});

test('_sweepTurnEndOrphans: does NOT release when the child is already gone (backstop owns it)', async () => {
  const mgr = new SweepTestManager(makeConfig(), false); // pid already dead
  let released = 0;
  const sess = makeChatSession(DEAD_SENTINEL_PID, {
    _run: { run_id: 'rundead01', workspace_id: 'ws-1', kind: 'qa' },
    releaseRunLock: () => released++,
  });
  await mgr._sweepTurnEndOrphans(sess);
  assert.equal(
    released,
    0,
    'child gone → sweep returns before the idle branch; _onChildExit is the release owner on that path',
  );
});

test('FolderMutex: turn-end early release unblocks a waiting successor; the process-exit backstop is a no-op', async () => {
  const m = new FolderMutex();
  const events = [];
  const a = await m.acquire('/shared-run-folder'); // run A: provision→execute hold
  let bAcquired = false;
  const bp = m.acquire('/shared-run-folder').then((h) => {
    bAcquired = true;
    events.push('B-start');
    return h;
  });

  await tick();
  assert.equal(bAcquired, false, 'same-scenario successor waits while run A holds the lock');

  // Run A's turn ends cleanly → the sweep releases EARLY, before A's process exits.
  events.push('A-turn-end-release');
  a.release();
  const b = await bp;
  assert.deepEqual(
    events,
    ['A-turn-end-release', 'B-start'],
    'successor proceeds at the EARLY turn-end release, not at process exit',
  );
  assert.equal(b.wasBusy, true);

  // Later, run A's process actually exits → _onChildExit fires the SAME handle
  // again. It must be a no-op: it can neither release B's lock nor wedge the chain.
  a.release();
  assert.equal(m.activeKeyCount, 1, 'process-exit backstop double-release is a no-op; B still holds its lock');
  b.release();
  assert.equal(m.activeKeyCount, 0);
});
