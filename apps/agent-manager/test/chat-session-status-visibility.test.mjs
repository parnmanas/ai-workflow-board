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
import { findLiveBackgroundTasks } from '../dist/lib/process-tree.js';

// Review round 2, P1 #1 — a fixed `delay(200)` before asserting on a spawned
// child's OS-process visibility races the real enumeration (on windows-latest
// CI, findLiveBackgroundTasks shells out to PowerShell/CIM and can routinely
// take well over 200ms). Poll the actual observable condition instead,
// bounded so a genuine hang still fails fast, and report what was last
// observed so a timeout is diagnosable.
async function waitUntil(predicate, describe, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (true) {
    last = await predicate();
    if (last.ok) return last;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms — last observed: ${describe(last)}`);
    }
    await delay(intervalMs);
  }
}

// ─── 교차 테스트 누수 차단 (ticket d03d2d33) ──────────────────────────────
// 이 파일의 idle-recheck 테스트는 "진행 신호가 있으면 죽이지 않고 다시 확인한다"는
// 실제 경로를 탄다 — 그 경로는 idle 타이머를 `idleRecheckSeconds` 간격으로
// 재무장한다. 재무장된 타이머는 테스트가 끝나도 살아남아 다음 테스트가 도는
// 도중 발화하고, 같은 `_onIdleTimerFired` 경로로 세션-상태 POST 를 한 번 더
// 밀어넣는다. 그 늦은 POST 가 현재 테스트의 배열에 담기면 다음 테스트의
// `statusPosts.length` 단언이 조용히 어긋난다(windows CI 실측: expected 1 /
// actual 2).
//
// 두 겹으로 막는다.
//   (1) 예방 — 모든 매니저를 레지스트리에 등록하고 afterEach 에서 세션과
//       재무장된 idle 타이머를 걷어낸다. `_onIdleTimerFired` 는 진입 시점과
//       await 직후 두 번 `_sessions.get(key) === sess` 를 확인하므로, 세션을
//       떼어내면 살아남은 타이머가 발화해도 POST 없이 즉시 반환한다.
//   (2) 출처 격리 — 그래도 새는 POST 가 생기면 현재 테스트의 sink 대신
//       `strayPosts` 로 보내고 afterEach 가 실패시킨다. 스텁이 배열을 값으로
//       잡든 바인딩으로 잡든 `globalThis.fetch` 는 호출 시점에 해석되므로
//       늦은 POST 는 언제나 "현재" 스텁으로 들어온다 — 이를 걸러낼 수 있는
//       신호는 요청에 실려 오는 발신자 정보뿐이다. 그래서 매니저 config 의
//       apiKey 에 테스트 epoch 를 박아 두고 스텁이 `X-Agent-Key` 헤더에서
//       그 값을 되읽는다.
let testEpoch = 0;
let currentEpoch = 0;
const strayPosts = [];          // 다른 epoch 의 매니저가 보낸 POST = 누수의 직접 증거
const liveManagers = new Set(); // afterEach 가 정리할 매니저들

/** epoch 태그가 박힌 config 로 매니저를 만들고 afterEach teardown 에 등록한다.
 *  이 파일의 테스트는 `new ChatSessionManager(...)` 대신 항상 이 헬퍼를 쓴다 —
 *  등록을 빠뜨리면 그 매니저의 재무장 타이머가 그대로 다음 테스트로 샌다. */
function newManager(overrides = {}) {
  const mgr = new ChatSessionManager(makeConfig(overrides));
  liveManagers.add(mgr);
  return mgr;
}

/** 매니저가 들고 있는 세션과 (재무장된) idle 타이머를 끊는다.
 *  BaseSessionManager#stop() 은 쓸 수 없다 — 이 파일의 페이크 세션은 pid 가
 *  테스트 러너 자신(process.pid)이라 stop() 의 process.kill(SIGTERM) 이
 *  러너를 죽인다. */
function teardownManager(mgr) {
  for (const sess of mgr._sessions.values()) {
    if (sess.idleTimer) {
      clearTimeout(sess.idleTimer);
      sess.idleTimer = null;
    }
  }
  mgr._sessions.clear();
}

/** 요청 헤더에 실린 발신 epoch 를 되읽는다. 태그가 없으면 -1 → stray 로 격리. */
function epochOf(init) {
  const key = init?.headers?.['X-Agent-Key'];
  const tag = typeof key === 'string' ? key.split('#')[1] : undefined;
  return tag === undefined ? -1 : Number(tag);
}

function makeConfig(overrides = {}) {
  return {
    url: 'http://127.0.0.1:0',
    // rest.ts 가 이 값을 그대로 `X-Agent-Key` 헤더로 보내므로, 여기 박은
    // 테스트 epoch 가 fetch 스텁이 POST 의 출처를 판별하는 근거가 된다.
    apiKey: `test-key#${currentEpoch}`,
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
// 살아있을 리 없는 pid — 진행 신호가 전혀 없는 idle recheck 을 만들 때 쓴다.
const DEAD_PID = 0x7fffffff;

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
  currentEpoch = ++testEpoch;
  statusPosts = [];
  messagePosts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    // 앞선 테스트의 매니저가 보낸 늦은 POST 는 현재 sink 에 절대 넣지 않는다.
    const epoch = epochOf(init);
    const stale = epoch !== currentEpoch;
    if (u.includes('/session-status') && (init?.method || 'GET') === 'POST') {
      if (stale) strayPosts.push({ kind: 'session-status', epoch, body });
      else statusPosts.push({ roomId: decodeURIComponent(u.match(/chat-rooms\/([^/]+)\/session-status$/)[1]), body });
    } else if (u.endsWith('/messages') && (init?.method || 'GET') === 'POST') {
      if (stale) strayPosts.push({ kind: 'messages', epoch, body });
      else messagePosts.push(body);
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  // 예방이 먼저 — 남은 매니저의 세션/재무장 타이머를 끊은 뒤에 스텁을 되돌린다.
  for (const mgr of liveManagers) teardownManager(mgr);
  liveManagers.clear();
  globalThis.fetch = originalFetch;
  // 이 테스트가 도는 동안 앞선 테스트의 매니저가 보낸 POST 가 하나라도
  // 있었다면 teardown 이 새고 있는 것이다 — 조용히 넘기지 않고 실패시킨다.
  const strays = strayPosts.splice(0);
  assert.equal(
    strays.length, 0,
    `이 테스트가 도는 동안 앞선 테스트(epoch ${strays.map((x) => x.epoch).join(', ')})의 `
      + `매니저가 보낸 POST ${strays.length}건이 도착했다 — 매니저 teardown 이 새고 있다`,
  );
});

// 아래 idle-recheck 테스트가 남기는 재무장 idle 타이머 핸들. afterEach 의 동작은
// 테스트 안에서 관측할 수 없으므로(훅은 테스트가 끝나야 돈다), 프로브를 여기
// 걸어두고 바로 다음 테스트가 "실제로 끊겼는지"를 확인한다 — 두 테스트는 한 쌍이다.
let rearmProbe = null;

test('applyRoomKeepAlive extend pushes an absolute keep_alive_until_ms (not a pre-computed remaining-minutes string)', async () => {
  const mgr = newManager();
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
  const mgr = newManager();
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
  const mgr = newManager();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const sess = makeFakeChatSession({ pid: process.pid });
  mgr._sessions.set(sess.sessionKey, sess);
  try {
    // Poll findLiveBackgroundTasks itself (the same enumeration
    // _onIdleTimerFired's progress gate calls) until the spawned child is
    // actually observable, instead of guessing a fixed delay.
    const seen = await waitUntil(
      async () => {
        const tasks = await findLiveBackgroundTasks(process.pid);
        return { ok: tasks.some((t) => t.pid === child.pid), tasks };
      },
      (last) => `${last.tasks.length} live descendant(s) of pid ${process.pid}: [${last.tasks.map((t) => t.pid).join(', ')}], waiting for child pid ${child.pid}`,
    );
    assert.ok(seen.ok, 'spawned child must become visible to findLiveBackgroundTasks before proceeding');

    await mgr._onIdleTimerFired(sess, 10 * 60_000);

    const last = statusPosts[statusPosts.length - 1];
    assert.ok(last, 'idle recheck must push a session-status snapshot');
    assert.ok(last.body.background_task_count >= 1,
      `must report the live background task, got ${last.body.background_task_count}`);
    assert.equal(sess._lastBackgroundTaskCount, last.body.background_task_count,
      'the cached count on the session record must match what was pushed');

    // ticket d03d2d33 — 이 테스트가 곧 누수 발생원이다: 진행 신호가 잡히면
    // 매니저는 세션을 죽이는 대신 idle 타이머를 `idleRecheckSeconds` 간격으로
    // 재무장하고, 그 타이머는 테스트 경계를 넘어 발화한다. 재무장이 실제로
    // 일어났음을 여기서 못박아 두 다음 테스트가 공허해지지 않게 하고
    // (재무장이 없으면 teardown 이 끊을 대상 자체가 없다), 그 타이머를
    // afterEach 가 정말 끊었는지는 바로 다음 테스트가 확인한다.
    assert.ok(sess.idleTimer, '진행 신호가 있으면 idle 타이머가 재무장돼야 한다');
    rearmProbe = { mgr, sess };
  } finally {
    child.kill();
  }
});

test('afterEach teardown 이 직전 테스트의 재무장된 idle 타이머를 실제로 끊는다 (늦은 POST 원천 차단)', async () => {
  // afterEach 의 효과는 테스트 안에서 관측할 수 없어(훅은 테스트가 끝나야
  // 돈다) 직전 테스트가 남긴 프로브로 확인한다 — 두 테스트는 한 쌍이고,
  // 선언 순서가 곧 실행 순서다.
  assert.ok(rearmProbe, '직전 테스트가 재무장 프로브를 설치했어야 한다 — 이 테스트는 그 테스트와 한 쌍이다');
  const { mgr, sess } = rearmProbe;
  rearmProbe = null;

  assert.equal(sess.idleTimer, null, 'afterEach 는 재무장된 idle 타이머를 해제해야 한다');
  assert.equal(mgr._sessions.size, 0, 'afterEach 는 매니저의 세션 레지스트리를 비워야 한다');

  // 타이머가 teardown 직전에 이미 발화했다면 그 콜백은 지금 도착한다(경계
  // 레이스). 세션이 레지스트리에서 떨어져 나갔으므로 `_onIdleTimerFired` 는
  // POST 없이 즉시 반환해야 한다 — 실제 타이머를 기다리지 않고 같은 콜백을
  // 직접 호출해 시간 의존 없이 단언한다.
  const before = statusPosts.length;
  await mgr._onIdleTimerFired(sess, 10 * 60_000);
  assert.equal(statusPosts.length, before,
    '정리된 매니저에서 살아남은 idle 타이머가 발화해도 세션-상태 POST 가 나가면 안 된다');
  assert.equal(strayPosts.length, 0, '정리된 매니저는 stray POST 도 만들지 않아야 한다');
});

test('앞선 테스트의 매니저가 보낸 늦은 POST 는 현재 테스트의 statusPosts 를 오염시키지 않는다', async () => {
  // teardown 이 놓친 매니저(= 이전 epoch 태그를 단 config)를 만들어 지금
  // 세션-상태 POST 를 밀어넣는다. 수정 전에는 이 POST 가 그대로 statusPosts
  // 로 들어가 다음 테스트의 `assert.equal(statusPosts.length, 1)` 을 2 로
  // 만들었다(windows CI 실측 증상).
  const staleEpoch = currentEpoch - 1;
  const staleMgr = new ChatSessionManager({ ...makeConfig(), apiKey: `test-key#${staleEpoch}` });
  const staleSess = makeFakeChatSession({ pid: DEAD_PID });
  staleMgr._sessions.set(staleSess.sessionKey, staleSess);

  const mgr = newManager();
  const sess = makeFakeChatSession({ pid: DEAD_PID });
  mgr._sessions.set(sess.sessionKey, sess);

  await mgr._onIdleTimerFired(sess, 10 * 60_000);
  assert.equal(statusPosts.length, 1, '현재 테스트의 idle recheck 은 정확히 1건을 밀어넣는다');

  // 늦은 POST 도착 — 현재 테스트가 도는 도중이라 `globalThis.fetch` 는
  // 현재 스텁으로 해석된다. 그래도 sink 는 갈라져야 한다.
  await staleMgr._onIdleTimerFired(staleSess, 10 * 60_000);

  assert.equal(statusPosts.length, 1, '늦은 POST 가 현재 테스트의 sink 에 들어오면 안 된다');
  // splice 로 소비한다 — afterEach 의 누수 감시 단언이 이 의도된 stray 로 실패하지 않도록.
  const strays = strayPosts.splice(0);
  assert.equal(strays.length, 1, '늦은 POST 는 stray 로 격리돼 관측 가능해야 한다');
  assert.equal(strays[0].epoch, staleEpoch, 'stray 는 보낸 매니저의 epoch 로 귀속돼야 한다');
  assert.equal(strays[0].kind, 'session-status', 'stray 는 세션-상태 POST 로 분류돼야 한다');

  teardownManager(staleMgr);
});

test('idle recheck with no evidence still pushes background_task_count: 0 (not silently skipped)', async () => {
  const mgr = newManager();
  const sess = makeFakeChatSession({ pid: DEAD_PID });
  mgr._sessions.set(sess.sessionKey, sess);

  await mgr._onIdleTimerFired(sess, 10 * 60_000);

  assert.equal(statusPosts.length, 1);
  assert.equal(statusPosts[0].body.background_task_count, 0);
  assert.equal(statusPosts[0].body.keep_alive_until_ms, null);
});

test('session exit clears the badge even when a keep-alive grant was still active', async () => {
  const mgr = newManager();
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
