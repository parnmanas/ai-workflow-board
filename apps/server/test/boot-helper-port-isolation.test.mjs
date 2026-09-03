// bootApp() 포트 격리 회귀 테스트 (ticket 6a9a3fe4).
//
// operational-capability-ticket.test.mjs 는 한 파일에서 NestJS 앱을 네 번
// 부팅하면서 전부 같은 고정 포트(7827)를 다시 바인딩했다. 앞 서버의 close() 가
// 아직 소켓을 놓지 못한 상태에서 다음 bind 가 들어가면 EADDRINUSE 로 깨지는데,
// 한가한 머신에서는 재사용이 제때 끝나 통과하고 부하가 걸린 전체 스위트에서만
// 재현되는 flake 였다.
//
// 해결책은 고정 지연(sleep)이 아니라 `port: 0` 이다 — OS 가 빈 포트를 배정하고
// bootApp() 이 그 **실제** 포트를 회수해 돌려준다. 이 파일은 그 계약을 잠근다.
// bootApp() 이 다시 "요청한 포트를 그대로 되돌려주는" 구현으로 돌아가면
// 반환값이 0 이 되어 아래 단언과 HTTP 요청이 즉시 깨진다.

import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';

// 하드코딩된 포트 상수를 새로 만들지 않기 위한 빈 포트 탐색. 커넥션을 한 번도
// 받지 않은 리스닝 소켓이라 close() 가 끝나면 포트가 곧바로 다시 바인딩 가능한
// 상태가 된다(TIME_WAIT 는 established 커넥션에만 걸린다).
async function findFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('bootApp({ port: 0 }) 는 실제 바인딩 포트를 돌려주고, 앞 서버를 닫지 않은 채 다음 부팅이 이어져도 포트가 겹치지 않는다', async (t) => {
  const first = await bootApp({ port: 0 });
  t.after(() => { void first.app.close().catch(() => {}); });

  assert.ok(
    Number.isInteger(first.port) && first.port > 0,
    '요청한 0 이 아니라 OS 가 배정한 실제 포트를 돌려준다',
  );
  assert.equal(
    first.port,
    first.app.getHttpServer().address().port,
    '반환 포트가 실제 리스닝 소켓의 포트와 일치한다',
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${first.port}/api/health`)).status,
    200,
    '반환된 포트로 실제 HTTP 응답이 온다 — 지어낸 숫자가 아니다',
  );

  // 회귀의 핵심: 첫 앱을 **닫지 않은 채** 두 번째 앱을 부팅한다. 고정 포트를
  // 재바인딩하던 예전 방식이었다면 여기서 EADDRINUSE 가 난다. 실패한 원본
  // 시나리오(close 는 했지만 소켓이 아직 안 풀린 상태)보다 더 강한 조건이라
  // 타이밍에 기대지 않고 결정적으로 재현된다.
  const second = await bootApp({ port: 0 });
  t.after(() => { void second.app.close().catch(() => {}); });

  assert.ok(
    Number.isInteger(second.port) && second.port > 0,
    '두 번째 부팅도 실제 포트를 돌려준다',
  );
  assert.notEqual(
    second.port,
    first.port,
    '앞 서버가 아직 살아 있으므로 OS 는 반드시 다른 포트를 배정한다',
  );
  assert.equal(
    second.port,
    second.app.getHttpServer().address().port,
    '두 번째 반환 포트도 실제 리스닝 소켓과 일치한다',
  );

  assert.equal(
    (await fetch(`http://127.0.0.1:${second.port}/api/health`)).status,
    200,
    '두 번째 앱이 자기 포트에서 응답한다',
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${first.port}/api/health`)).status,
    200,
    '두 번째 부팅이 첫 앱의 소켓을 빼앗지 않는다 — 두 앱이 동시에 살아 있다',
  );
});

test('고정 포트를 넘긴 기존 호출자는 그대로 그 포트에 바인딩된다', async (t) => {
  // 실제 포트 회수를 추가하면서 기존 고정 포트 호출자(스위트 대부분)의 동작이
  // 바뀌면 안 된다. 이 저장소에 포트 상수를 하나 더 늘리지 않으려고 빈 포트를
  // 런타임에 찾아 그 번호를 명시적으로 넘긴다.
  const fixedPort = await findFreePort();

  const { app, port } = await bootApp({ port: fixedPort });
  t.after(() => { void app.close().catch(() => {}); });

  assert.equal(port, fixedPort, '고정 포트를 넘기면 요청한 그 포트를 돌려준다');
  assert.equal(
    (await fetch(`http://127.0.0.1:${fixedPort}/api/health`)).status,
    200,
    '요청한 고정 포트에서 실제로 서빙한다',
  );
});

test.after(() => exitAfterTests());
