// boot-concurrent-sessions.test.mjs 가 fork 하는 자식 — "또 하나의 테스트 세션"
// 한 개를 흉내낸다.
//
// 부모와 IPC 로만 동기화한다(sleep 없음):
//   1. 부팅 준비가 끝나면 `ready` 를 보내고 멈춘다.
//   2. 부모가 두 자식의 `ready` 를 모두 받은 뒤 `go` 를 보낸다 — 이 지점이
//      배리어다. 두 부팅이 실제로 겹치는 것을 이 신호가 보장한다.
//   3. 부팅 결과(실제 바인딩 포트 + 격리 키)를 `booted` 로 보고한 뒤, 부모가
//      두 포트에 HTTP 를 찔러볼 때까지 살아 있는다.
//   4. `shutdown` 을 받으면 앱을 닫고 나간다.

import { bootApp, closeTestApp } from './boot.mjs';

function send(msg) {
  process.send?.(msg);
}

let app = null;

process.on('message', async (msg) => {
  if (msg === 'go') {
    try {
      const booted = await bootApp({ port: 0 });
      app = booted.app;
      send({
        type: 'booted',
        pid: process.pid,
        port: booted.port,
        // 이 두 값이 프로세스마다 달라야 두 세션이 같은 DB 를 밟지 않는다.
        // 포트 자리가 0 으로 고정된 뒤로는 pid 만이 유일성을 지탱한다.
        sqljsDbPath: process.env.SQLJS_DB_PATH,
        ontologyDbPath: process.env.SQLJS_ONTOLOGY_DB_PATH,
        pgSchema: process.env.DB_SCHEMA ?? null,
      });
    } catch (err) {
      send({ type: 'boot-failed', pid: process.pid, error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (msg === 'shutdown') {
    if (app) await closeTestApp(app);
    process.exit(0);
  }
});

send({ type: 'ready', pid: process.pid });
