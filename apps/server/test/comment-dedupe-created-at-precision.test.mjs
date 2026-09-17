// "같은 시각" 판정의 드라이버별 정밀도 계약 (ticket 62407d4e).
//
// add_comment 의 합치기와 write-seq 채번은 "이 티켓의 최신 created_at 과 같은 시각인
// 행들"(tied group)을 다시 조회해 결정한다. 그 조회 조건을 등호 하나로 쓰면 Postgres
// 에서 조용히 0건이 된다 — @CreateDateColumn 은 CURRENT_TIMESTAMP(마이크로초)로 저장되는데
// 엔티티로 읽으면 JS Date 라 밀리초까지만 남아, 그 값을 등호로 되돌리면 자기 자신조차
// 일치하지 않는다. 라이브 Postgres 에서 _comment_write_seq 가 전부 1 로 고정되고 같은
// dedupe_key 자동 알림이 중복 발행된 원인이다.
//
// 이 파일은 그 조건 생성기의 계약만 좁게 고정한다(순수 로직이라 어느 환경에서도 돈다).
// 실제 Postgres 동작은 test/qa-flows/comment-dedupe-pg.test.mjs 가, sqljs 동작은
// test/comment-tools-dedupe.test.mjs 가 각각 진짜 DB 로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { tiedCreatedAtWhere, sinceBoundaryParam } = await import(
  'file://' + path.join(DIST, 'common', 'created-at-since-param.js')
);

// tiedCreatedAtWhere 가 읽는 것은 드라이버 종류뿐이라 실제 커넥션이 필요 없다.
const fakeDataSource = (type) => ({ options: { type } });

test('Postgres: 밀리초로 잘린 값으로도 마이크로초 꼬리를 가진 원래 행을 집는다', () => {
  const storedMicros = Date.UTC(2026, 8, 17, 5, 11, 20, 689) + 0.432; // 05:11:20.689432
  const readBack = new Date(Math.floor(storedMicros));               // 엔티티가 보는 값

  const { clause, params } = tiedCreatedAtWhere(fakeDataSource('postgres'), 'c', readBack);

  assert.match(clause, /c\.created_at >= :tiedCreatedAtFrom/);
  assert.match(clause, /c\.created_at < :tiedCreatedAtTo/);
  // 핵심 속성: 잘려나간 원본이 구간 안에 있어야 한다. 등호였다면 아래 첫 줄이 깨진다.
  assert.equal(params.tiedCreatedAtFrom.getTime() <= storedMicros, true);
  assert.equal(storedMicros < params.tiedCreatedAtTo.getTime(), true);
  assert.notEqual(
    params.tiedCreatedAtFrom.getTime(), storedMicros,
    '등호 비교가 왜 실패했는지 그대로 보여준다 — 읽어온 값과 저장된 값이 애초에 같지 않다',
  );
});

test('Postgres: 창은 1밀리초 반개구간이라 옆 밀리초의 행은 들어오지 않는다', () => {
  const at = new Date(Date.UTC(2026, 8, 17, 5, 11, 20, 689));
  const { params } = tiedCreatedAtWhere(fakeDataSource('postgres'), 'c', at);

  assert.equal(params.tiedCreatedAtFrom.getTime(), at.getTime());
  assert.equal(params.tiedCreatedAtTo.getTime(), at.getTime() + 1);
  // 직전 밀리초의 끝(…688.999)과 다음 밀리초의 시작(…690)은 모두 창 밖이다.
  assert.equal(at.getTime() - 0.001 < params.tiedCreatedAtFrom.getTime(), true);
  assert.equal(at.getTime() + 1 < params.tiedCreatedAtTo.getTime(), false);
});

test('sqljs: 초 단위 저장 포맷에 맞춘 등호 비교를 그대로 유지한다', () => {
  const at = new Date(Date.UTC(2026, 8, 17, 5, 11, 20, 689));
  const ds = fakeDataSource('sqljs');
  const { clause, params } = tiedCreatedAtWhere(ds, 'c', at);

  // sqljs 는 반대 방향의 문제다 — 저장값이 초 단위 문자열이라 범위 비교(사전식)로
  // 바꾸면 같은 초의 행을 놓친다. 기존 계약(초 단위 등호)을 그대로 지킨다.
  assert.equal(clause, 'c.created_at = :tiedCreatedAtEq');
  assert.equal(params.tiedCreatedAtEq, '2026-09-17 05:11:20');
  assert.equal(params.tiedCreatedAtEq, sinceBoundaryParam(ds, at));
});
