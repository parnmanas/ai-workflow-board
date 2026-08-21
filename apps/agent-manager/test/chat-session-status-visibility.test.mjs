// Regression guard for ticket e18be8ff — the chat room UI's "백그라운드 작업
// N개 실행 중 · keep-alive 잔여 XX분" badge. ChatSessionManager pushes a
// keep-alive/background-task-count snapshot to
// POST /api/agent/chat-rooms/:roomId/session-status on:
//   1. every applyRoomKeepAlive grant/release (BaseSessionManager#applyKeepAlive)
//   2. every checkSessionProgress recheck (idle timer / maxTurns / unhealthy gate)
//   3. session exit (so a badge counting down client-side doesn't outlive the session)
//
// These tests drive the REAL compiled dist/ code (same convention as
// session-progress-gate.test.mjs) and assert on the actual POST body — the
// wire payload the server contract in agent-api.controller.ts expects — not
// on internal state, per the board's "verify actual wire payload" lesson.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';
import { createAdapter } from '../dist/lib/cli-adapters/index.js';

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

const ROOM_ID = 'room-e18be8ff';
const AGENT_ID = 'agent-e18be8ff';

let pidSeq = 93000;
function makeFakeChatSession(overrides = {}) {
  const pid = overrides.pid ?? ++pidSeq;
  const sessionKey = `${ROOM_ID}|${AGENT_ID}`;
  return {
    sessionKey,
    roomId: ROOM_ID,
    agentId: AGENT_ID,
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

let originalFetch;
let statusPosts;
let messagePosts;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  statusPosts = [];
  messagePosts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes('/session-status') && (init?.method || 'GET') === 'POST') {
      statusPosts.push({ roomId: decodeURIComponent(u.match(/chat-rooms\/([^/]+)\/session-status$/)[1]), body });
    } else if (u.endsWith('/messages') && (init?.method || 'GET') === 'POST') {
      messagePosts.push(body);
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('applyRoomKeepAlive extend pushes an absolute keep_alive_until_ms (not a pre-computed remaining-minutes string)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeFakeChatSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);

  const before = Date.now();
  const grant = mgr.applyRoomKeepAlive(ROOM_ID, AGENT_ID, { action: 'extend', minutes: 30, reason: 'long workflow' });
  assert.equal(grant.ok, true);

  assert.equal(statusPosts.length, 1, 'exactly one session-status push for the grant');
  const post = statusPosts[0];
  assert.equal(post.roomId, ROOM_ID);
  assert.equal(post.body.agent_id, AGENT_ID);
  assert.ok(
    post.body.keep_alive_until_ms >= before + 29 * 60_000 && post.body.keep_alive_until_ms <= before + 31 * 60_000,
    `keep_alive_until_ms must be an absolute ~30min-out deadline, got ${post.body.keep_alive_until_ms}`,
  );
  assert.equal(post.body.background_task_count, 0, 'no progress recheck has run yet, so the cached count is 0');
});

test('applyRoomKeepAlive release pushes keep_alive_until_ms: null so the client-side countdown stops', () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeFakeChatSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);

  mgr.applyRoomKeepAlive(ROOM_ID, AGENT_ID, { action: 'extend', minutes: 30 });
  const released = mgr.applyRoomKeepAlive(ROOM_ID, AGENT_ID, { action: 'release' });
  assert.equal(released.ok, true);

  assert.equal(statusPosts.length, 2, 'one push for the grant, one for the release');
  const last = statusPosts[statusPosts.length - 1];
  assert.equal(last.body.keep_alive_until_ms, null);
});

test('idle recheck with a live background task pushes the SAME count the reap-gate computed (no extra scan)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const sess = makeFakeChatSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);
  try {
    await delay(200); // let the spawned child register in the OS process table
    await mgr._onIdleTimerFired(sess, 10 * 60_000);

    const last = statusPosts[statusPosts.length - 1];
    assert.ok(last, 'idle recheck must push a session-status snapshot');
    assert.ok(last.body.background_task_count >= 1,
      `must report the live background task, got ${last.body.background_task_count}`);
    assert.equal(sess._lastBackgroundTaskCount, last.body.background_task_count,
      'the cached count on the session record must match what was pushed');
  } finally {
    child.kill();
  }
});

test('idle recheck with no evidence still pushes background_task_count: 0 (not silently skipped)', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const DEAD_PID = 0x7fffffff;
  const sess = makeFakeChatSession({ pid: DEAD_PID });
  mgr._sessions.set(sess.sessionKey, sess);

  await mgr._onIdleTimerFired(sess, 10 * 60_000);

  assert.equal(statusPosts.length, 1);
  assert.equal(statusPosts[0].body.background_task_count, 0);
  assert.equal(statusPosts[0].body.keep_alive_until_ms, null);
});

test('session exit clears the badge even when a keep-alive grant was still active', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeFakeChatSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);
  mgr.applyRoomKeepAlive(ROOM_ID, AGENT_ID, { action: 'extend', minutes: 30 });
  assert.ok(statusPosts.length >= 1);

  await mgr._onChildExit(sess, 0, null);

  const last = statusPosts[statusPosts.length - 1];
  assert.equal(last.body.keep_alive_until_ms, null, 'exit must clear the keep-alive deadline');
  assert.equal(last.body.background_task_count, 0, 'exit must clear the background-task count');
  assert.equal(sess._keepAliveUntilMs, null, 'the in-memory record itself must be cleared, not just the push');
});
