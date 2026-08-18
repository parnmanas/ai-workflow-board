// 뷰포트 기반 @멘션 읽음 처리의 서버측 단위 가드.
//
// 규칙: 티켓 스레드/채팅방을 "열었다"는 사실만으로는 멘션을 지우지 않는다.
// 그 멘션이 실린 코멘트/메시지가 실제로 화면에 들어와야 지운다. 방을 열면
// 최신 메시지로 스크롤되므로 "방 읽음"은 200개 위의 멘션에 대해 아무것도
// 증명하지 못하고, 티켓 패널을 2초 열었다 닫으면 정작 열어본 이유였던 멘션이
// 조용히 사라진다. 멘션은 사람에게 일을 배정하는 수단이라 기준을 높게 둔다.
//
// 서버가 제공하는 두 프리미티브:
//   listUnreadBySource — 이 티켓/방 안에서 아직 안 읽은 멘션을 {id, source_id}로
//   markManyRead       — 실제로 본 것들만 배치로 읽음 처리
//
// 지키는 불변식 (깨지면 남의 인박스를 지우거나, 못 본 멘션을 삼킨다):
//   1. 두 경로 모두 user_id 스코프
//   2. read_at IS NULL (이미 읽은 행의 read_at 보존)
//   3. 소스 스코프 (ticket_id 또는 room_id) — 워크스페이스 전체 금지
//   4. 소스가 없으면 쿼리 자체를 실행하지 않는다
//   5. markManyRead 는 빈/중복 입력을 안전하게 처리한다

import test from 'node:test';
import assert from 'node:assert/strict';

const { MentionsService } = await import('../dist/modules/mentions/mentions.service.js');

/** Chainable QueryBuilder stub recording every clause + parameter. */
function fakeRepo({ affected = 0, rows = [] } = {}) {
  const calls = { where: [], params: {}, executed: 0, selected: null, setCalled: false };
  const qb = {
    select(v) { calls.selected = v; return qb; },
    update() { return qb; },
    set(v) { calls.setCalled = true; calls.set = v; return qb; },
    where(clause, params) { calls.where.push(clause); Object.assign(calls.params, params || {}); return qb; },
    andWhere(clause, params) { calls.where.push(clause); Object.assign(calls.params, params || {}); return qb; },
    async getRawMany() { calls.executed++; return rows; },
    async execute() { calls.executed++; return { affected }; },
  };
  return { calls, repo: { createQueryBuilder: () => qb } };
}

const svcWith = (repo) => new MentionsService(repo, null, null);

test('listUnreadBySource: 소스가 없으면 쿼리를 실행하지 않는다', async () => {
  const { repo, calls } = fakeRepo({ rows: [{ id: 'm1', source_id: 'c1' }] });
  assert.deepEqual(await svcWith(repo).listUnreadBySource('u-1', {}), []);
  assert.equal(calls.executed, 0, '불변식 4: 소스 스코프 없이 조회하면 안 된다');
});

test('listUnreadBySource(ticket): user/unread/ticket 스코프 + {id, source_id} 투영', async () => {
  const { repo, calls } = fakeRepo({ rows: [{ id: 'm1', source_id: 'c1' }, { id: 'm2', source_id: 'c2' }] });
  const items = await svcWith(repo).listUnreadBySource('u-1', { ticketId: 't-1' });

  const sql = calls.where.join(' AND ');
  assert.match(sql, /m\.user_id = :uid/, '불변식 1');
  assert.match(sql, /m\.read_at IS NULL/, '불변식 2');
  assert.match(sql, /m\.ticket_id = :tid/, '불변식 3');
  assert.doesNotMatch(sql, /room_id/, '티켓 경로가 room_id 로도 스코프되면 안 된다');
  assert.equal(calls.params.uid, 'u-1');
  assert.equal(calls.params.tid, 't-1');

  // source_id 는 클라이언트가 화면의 행과 대조하는 키다 — 빠지면 뷰포트 매칭 불가.
  assert.deepEqual(items, [{ id: 'm1', source_id: 'c1' }, { id: 'm2', source_id: 'c2' }]);
});

test('listUnreadBySource(room): room_id 로 스코프된다', async () => {
  const { repo, calls } = fakeRepo({ rows: [] });
  await svcWith(repo).listUnreadBySource('u-2', { roomId: 'r-9' });
  const sql = calls.where.join(' AND ');
  assert.match(sql, /m\.room_id = :rid/);
  assert.doesNotMatch(sql, /ticket_id/, '채팅 경로가 ticket_id 로도 스코프되면 안 된다');
  assert.equal(calls.params.rid, 'r-9');
});

test('markManyRead: id 목록 + user + unread 로만 스코프된다', async () => {
  const { repo, calls } = fakeRepo({ affected: 2 });
  const n = await svcWith(repo).markManyRead(['m1', 'm2'], 'u-1');

  assert.equal(n, 2, 'affected 를 그대로 돌려줘야 클라이언트 뱃지가 정확히 차감된다');
  const sql = calls.where.join(' AND ');
  assert.match(sql, /id IN \(:\.\.\.ids\)/);
  assert.match(sql, /user_id = :uid/, '불변식 1: id 를 추측해 남의 인박스를 지울 수 없어야 한다');
  assert.match(sql, /read_at IS NULL/, '불변식 2: 이미 읽은 행의 read_at 을 덮어쓰면 안 된다');
  assert.deepEqual(calls.params.ids, ['m1', 'm2']);
  assert.equal(calls.params.uid, 'u-1');
  assert.ok(calls.setCalled);
});

test('markManyRead: 중복을 제거하고, 빈 입력은 쿼리 없이 0', async () => {
  const { repo, calls } = fakeRepo({ affected: 1 });
  assert.equal(await svcWith(repo).markManyRead(['m1', 'm1', '', null], 'u-1'), 1);
  assert.deepEqual(calls.params.ids, ['m1']);

  const empty = fakeRepo({ affected: 5 });
  assert.equal(await svcWith(empty.repo).markManyRead([], 'u-1'), 0);
  assert.equal(empty.calls.executed, 0, '불변식 5: 빈 목록으로 UPDATE 가 나가면 안 된다');
});
