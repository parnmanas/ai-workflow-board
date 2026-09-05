// 동시 세션 회귀 테스트 — ticket f2d82793.
//
// 이 티켓 전까지 apps/server/test 의 152 개 파일이 부팅 포트를 고정 리터럴로
// 선언했고, 고유값 105 개 중 32 개가 중복이었다(최다 7842 는 7 개 파일 공유).
// `run-suite.mjs` 가 파일을 **순차로** 돌리기 때문에 겹침이 드러나지 않았을 뿐,
// 두 번째 테스트 세션이 동시에 돌거나 데스크톱 앱이 그 번호를 잡고 있으면 그대로
// EADDRINUSE 였다.
//
// 고정 포트를 전부 없앤 뒤(선언은 0, 실제 번호는 OS 가 배정) 이 파일이 그 계약을
// **정적 가드가 아니라 실제 프로세스로** 잠근다. boot-port-guard.test.mjs 는
// "소스에 리터럴이 없다" 만 말할 수 있고, 두 세션이 정말 공존하는지는 말하지 못한다.
//
// 함께 잠그는 두 번째 계약: sql.js / Postgres 격리 키다. 두 키는
// `awb-qa-<pid>-<port>.db` 와 `qa_<pid>_<port>` 인데, 포트가 늘 0 이 된 지금
// **유일성이 pid 하나에만 걸려 있다**. 누군가 pid 를 키에서 빼면 두 세션이 같은
// DB 파일을 밟게 되므로 여기서 함께 단언한다.
//
// 동기화는 고정 지연이 아니라 happens-before 다 — 두 자식이 각자 `ready` 를 보낸
// 뒤에야 부모가 공통 `go` 를 쏜다. 그래야 두 부팅이 실제로 겹친다. timeout 은
// 정상 동기화 수단이 아니라 hang 진단용 상한으로만 둔다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { exitAfterTests } from './helpers/boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'helpers', 'concurrent-boot-child.mjs');

// hang 진단용 상한. 정상 경로는 IPC 신호로만 진행하므로 이 값에 의존하지 않는다.
const HANG_LIMIT_MS = 120_000;

function forkSession() {
  // 두 개의 **독립된 테스트 세션**을 흉내내는 것이 목적이므로, 이 프로세스가
  // 이미 들고 있을 수 있는 격리 키를 물려주지 않는다. 물려주면 bootApp 의
  // "이미 있으면 건너뛴다" 분기 때문에 두 자식이 같은 DB 를 공유해버려, 정작
  // 검증하려는 pid 기반 유일성이 시험되지 않는다.
  const env = { ...process.env };
  delete env.SQLJS_DB_PATH;
  delete env.SQLJS_ONTOLOGY_DB_PATH;
  delete env.DB_SCHEMA;
  delete env.PORT;

  const child = fork(CHILD, [], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const inbox = [];
  const waiters = [];
  child.on('message', (msg) => {
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  return {
    child,
    next() {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

test('두 테스트 세션이 동시에 부팅해도 포트와 DB 격리 키가 겹치지 않는다', async (t) => {
  t.diagnostic('두 자식 프로세스를 fork 해 공통 배리어에서 동시에 부팅시킨다');

  const a = forkSession();
  const b = forkSession();
  t.after(() => {
    for (const s of [a, b]) {
      try { s.child.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
    }
  });

  const timer = setTimeout(() => {
    throw new Error(`동시 부팅이 ${HANG_LIMIT_MS}ms 안에 끝나지 않았다 — 배리어나 부팅이 걸렸다`);
  }, HANG_LIMIT_MS);
  timer.unref();
  t.after(() => clearTimeout(timer));

  // 1) 두 자식이 모두 준비될 때까지 기다린다 — 여기까지가 배리어의 앞쪽이다.
  const readyA = await a.next();
  const readyB = await b.next();
  assert.equal(readyA.type, 'ready', `자식 A 가 ready 를 보내야 한다: ${JSON.stringify(readyA)}`);
  assert.equal(readyB.type, 'ready', `자식 B 가 ready 를 보내야 한다: ${JSON.stringify(readyB)}`);
  assert.notEqual(readyA.pid, readyB.pid, '두 자식은 서로 다른 프로세스여야 한다');

  // 2) 공통 시작 신호 — 이 시점 이후 두 부팅은 겹친다.
  a.child.send('go');
  b.child.send('go');

  const bootedA = await a.next();
  const bootedB = await b.next();
  for (const [label, msg] of [['A', bootedA], ['B', bootedB]]) {
    assert.equal(
      msg.type,
      'booted',
      `자식 ${label} 가 부팅에 실패했다 — 동시 세션이 겹치면 EADDRINUSE 가 여기서 난다: ${JSON.stringify(msg)}`,
    );
  }

  // 3) 포트: 둘 다 실제 번호를 받았고 서로 다르다.
  for (const [label, msg] of [['A', bootedA], ['B', bootedB]]) {
    assert.ok(
      Number.isInteger(msg.port) && msg.port > 0,
      `자식 ${label} 는 0 이 아니라 OS 가 배정한 실제 포트를 보고해야 한다 (받은 값: ${msg.port})`,
    );
  }
  assert.notEqual(bootedA.port, bootedB.port, '동시에 살아 있는 두 세션이 같은 포트일 수 없다');

  // 4) 두 서버가 **동시에** 각자의 포트에서 응답한다 — 포트가 다르다는 것만으로는
  //    한쪽이 이미 죽었을 가능성을 배제하지 못한다.
  const [resA, resB] = await Promise.all([
    fetch(`http://127.0.0.1:${bootedA.port}/api/health`),
    fetch(`http://127.0.0.1:${bootedB.port}/api/health`),
  ]);
  assert.ok(resA.ok, `자식 A 포트(${bootedA.port})가 응답해야 한다 — 받은 status ${resA.status}`);
  assert.ok(resB.ok, `자식 B 포트(${bootedB.port})가 응답해야 한다 — 받은 status ${resB.status}`);

  // 5) DB 격리 키: 포트 자리가 0 으로 고정된 뒤 유일성은 pid 에만 걸려 있다.
  assert.ok(bootedA.sqljsDbPath && bootedB.sqljsDbPath, '두 세션 모두 sql.js 격리 경로를 잡아야 한다');
  assert.notEqual(
    bootedA.sqljsDbPath,
    bootedB.sqljsDbPath,
    'sql.js DB 경로가 같으면 두 세션이 같은 파일에 써서 서로를 오염시킨다',
  );
  assert.notEqual(
    bootedA.ontologyDbPath,
    bootedB.ontologyDbPath,
    'Ontology sql.js DB 경로도 세션마다 달라야 한다',
  );
  if (bootedA.pgSchema !== null || bootedB.pgSchema !== null) {
    assert.notEqual(
      bootedA.pgSchema,
      bootedB.pgSchema,
      'Postgres 매트릭스에서 두 세션의 스키마가 같으면 테이블이 충돌한다',
    );
  }

  a.child.send('shutdown');
  b.child.send('shutdown');
  await Promise.all([
    new Promise((resolve) => a.child.once('exit', resolve)),
    new Promise((resolve) => b.child.once('exit', resolve)),
  ]);
});

exitAfterTests();
