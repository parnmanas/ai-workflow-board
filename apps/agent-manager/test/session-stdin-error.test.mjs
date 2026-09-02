// 회귀 테스트: 세션 자식의 stdin 에서 난 비동기 에러가 매니저 프로세스를 죽이면 안 된다.
//
// 인시던트(티켓 6fd625bb, Windows CI 실측): `_spawnSession` 이 첫 턴을 쓰는 순간
// CLI 자식이 죽어 `write EPIPE` 가 발생했고, 그게 **uncaughtException** 으로 승격돼
// agent-manager 프로세스 전체가 내려갔다.
//
//   failureType: 'uncaughtException'   error: 'write EPIPE'   code: 'EPIPE'
//     BaseSessionManager._writeTurn (dist/lib/base-session-manager.js:481:30)
//     #spawnSessionUnlocked (…:349:18)
//
// 원인: `_writeTurn` 의 try/catch 는 **동기 throw** 만 잡는다. 스트림 write 실패는
// 비동기 'error' 이벤트로 보고되고, 리스너가 하나도 없으면 Node 가 그것을
// uncaughtException 으로 승격시킨다. 자식이 죽는 것은 정상적으로 처리 가능한
// 사건(exit/close 핸들러가 이미 세션을 정리한다)이므로, 매니저가 같이 죽을 이유가 없다.
//
// 수정: `#wireStdio` 가 stdout/stderr 와 함께 stdin 에도 'error' 리스너를 붙인다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { createAdapter } from '../dist/lib/cli-adapters/index.js';

const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-key',
  delegation: { enabled: true, maxConcurrent: 4 },
};

/** `_writeTurn` 은 protected 라 서브클래스 seam 으로 실제 production 경로를 부른다 —
 *  테스트 안에서 write 를 흉내내면 정작 고친 지점을 지나가지 않는다. */
class Harness extends BaseSessionManager {
  constructor() {
    super(config, {
      keyField: 'sessionKey',
      logTag: '[test-stdin-error]',
      cfgPrefix: 'cfg-stdin-err-',
      kindLabel: 'chat_session',
    });
  }
  writeTurn(sess, text) {
    return this._writeTurn(sess, text);
  }
}

let pidSeq = 77000;
function fakeChild() {
  const child = new EventEmitter();
  child.pid = ++pidSeq;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

function makeSession(child, sessionKey) {
  return {
    sessionKey,
    pid: child.pid,
    cli_type: 'claude',
    adapter: createAdapter('claude'),
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    ticketId: 't-stdin-err',
    agentId: 'a-stdin-err',
    role: 'assignee',
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

test('세션 배선 직후 stdin 에는 error 리스너가 있다 — 없으면 EPIPE 가 프로세스를 죽인다', () => {
  const mgr = new Harness();
  const child = fakeChild();
  const sess = makeSession(child, 'sess-stdin-listener');
  mgr._trackSessionForTest(sess.sessionKey, sess);

  assert.ok(
    child.stdin.listenerCount('error') > 0,
    'stdin 에 error 리스너가 붙어야 한다 (stdout/stderr 와 같은 배선 시점)',
  );

  // EventEmitter 는 리스너 없는 'error' emit 을 **동기 throw** 로 바꾼다. 즉 이
  // 호출이 던지지 않는다는 것 자체가 승격 차단의 직접 증거다.
  assert.doesNotThrow(() => {
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  }, 'stdin 의 비동기 error 가 그대로 던져지면 안 된다');
});

/** 깨진 파이프를 흉내내는 stdin. `_write` 콜백에 에러를 넘기면 실제 EPIPE 와
 *  **같은 경로**로 스트림이 비동기 'error' 를 emit 한다 — `_writeTurn` 의
 *  try/catch 는 이걸 잡을 수 없다는 것이 이 회귀의 핵심이다.
 *  (`PassThrough` 를 destroy 하는 방식은 'error' 를 내지 않아 공허하게 통과한다.) */
function brokenPipeStdin() {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
}

test('죽어가는 stdin 으로 턴을 써도 매니저는 살아남고 세션 정리 경로가 그대로 돈다', async () => {
  const mgr = new Harness();
  const child = fakeChild();
  child.stdin = brokenPipeStdin();
  const sess = makeSession(child, 'sess-stdin-dead-write');
  mgr._trackSessionForTest(sess.sessionKey, sess);

  // 프로덕션 write 경로를 그대로 통과시킨다 — 동기 throw 는 없고, 에러는
  // 다음 tick 에 스트림 'error' 로 올라온다.
  mgr.writeTurn(sess, 'first turn');

  // 비동기 error 가 도달할 틈을 준다. 리스너가 없으면 이 사이에
  // uncaughtException 으로 승격돼 이 테스트가 실패한다.
  await delay(20);

  // 그리고 정상 종료 경로는 그대로 살아 있어야 한다 — 매니저가 죽지 않았으므로
  // exit/close 가 세션을 회수한다.
  child.stdout.end();
  child.stderr.end();
  child.emit('exit', 1, null);
  child.emit('close', 1, null);
  for (let i = 0; i < 100 && mgr._sessions.has(sess.sessionKey); i++) await delay(5);
  assert.equal(mgr._sessions.has(sess.sessionKey), false, '세션은 close 후 회수돼야 한다');
});
