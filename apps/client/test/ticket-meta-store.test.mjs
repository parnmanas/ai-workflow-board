// 순수 로직 테스트 — F2-4 ⓐ (ticket d21b28fc) 티켓 상태-카드 스토어.
//
// 같은 ticket_id 카드가 채팅에 여럿 떠도 getTicket 은 1회로 합쳐야 하고(N+1 방지),
// 결과는 캐시되며, SSE board_update 무효화는 화면에 구독자가 남은 id 만 즉시 재조회한다.
// React 없이 DI fetcher + deferred 로 응답 순서를 통제해 이 계약을 커밋 검증한다
// (board memory: client 로직 DI-extract node:test).
//
// 실행:  node --import tsx --test apps/client/test/ticket-meta-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTicketMetaStore } from '../src/contexts/ticketMetaStore.ts';

// 응답 순서를 명시적으로 통제하는 deferred.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('ensure: 동일 id 동시 요청을 1회 fetch 로 합친다(N+1 방지)', async () => {
  let calls = 0;
  const d = deferred();
  const store = createTicketMetaStore((id) => { calls++; return d.promise; });
  // 같은 티켓 카드 3개가 각자 ensure — fetch 는 단 1회여야.
  store.ensure('T-1');
  store.ensure('T-1');
  store.ensure('T-1');
  await tick();
  assert.equal(calls, 1, '진행 중 fetch 가 있으면 추가 ensure 는 no-op(1회만 fetch)');
  d.resolve({ status: 'In Review', priority: 'high' });
  await tick();
  assert.deepEqual(store.get('T-1'), { status: 'In Review', priority: 'high' }, '결과 캐시');
  // 캐시된 뒤 ensure 는 다시 fetch 하지 않는다.
  store.ensure('T-1');
  assert.equal(calls, 1, '캐시 hit → 재fetch 없음');
});

test('subscribe: fetch 완료 시 구독자에게 통지, 해지 후엔 통지 없음', async () => {
  const d = deferred();
  const store = createTicketMetaStore(() => d.promise);
  let notified = 0;
  const unsub = store.subscribe('T-2', () => { notified++; });
  store.ensure('T-2');
  d.resolve({ status: 'Done' });
  await tick();
  assert.equal(notified, 1, '완료 시 1회 통지');
  assert.deepEqual(store.get('T-2'), { status: 'Done' });
  unsub();
  store.invalidate('T-2'); // 구독자 없음 → 즉시 재조회 안 함(다음 ensure 로 lazy)
  await tick();
  assert.equal(notified, 1, '해지된 구독자에겐 통지 없음');
});

test('invalidate: 구독자 있으면 즉시 재조회, 없으면 lazy(다음 ensure)', async () => {
  let calls = 0;
  let current = { status: 'Todo' };
  const store = createTicketMetaStore(() => { calls++; return Promise.resolve(current); });
  // (a) 구독자 있는 상태에서 무효화 → 즉시 재조회.
  const unsub = store.subscribe('T-3', () => {});
  store.ensure('T-3');
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(store.get('T-3'), { status: 'Todo' });
  current = { status: 'In Review' };
  store.invalidate('T-3');
  await tick();
  assert.equal(calls, 2, '구독자 존재 → invalidate 가 즉시 재조회');
  assert.deepEqual(store.get('T-3'), { status: 'In Review' }, '새 값으로 갱신');
  // (b) 구독 해지 후 무효화 → 재조회 없이 캐시만 비운다.
  unsub();
  store.invalidate('T-3');
  await tick();
  assert.equal(calls, 2, '구독자 없음 → 즉시 재조회 안 함');
  assert.equal(store.get('T-3'), undefined, '무효화로 캐시 비워짐');
  // 다음 ensure 가 lazy 재조회.
  store.ensure('T-3');
  await tick();
  assert.equal(calls, 3, '다음 ensure 로 재조회');
});

test('fetch 실패/null 은 조용히 무시(칩 미표시, 카드 본체는 그대로)', async () => {
  const store = createTicketMetaStore((id) =>
    id === 'boom' ? Promise.reject(new Error('네트워크')) : Promise.resolve(null),
  );
  let notified = 0;
  store.subscribe('boom', () => { notified++; });
  store.ensure('boom');
  await tick();
  assert.equal(store.get('boom'), undefined, 'fetch 실패 → 캐시 없음');
  assert.equal(notified, 0, '실패는 통지하지 않는다');
  // null 결과도 캐시하지 않는다(티켓 없음).
  store.ensure('missing');
  await tick();
  assert.equal(store.get('missing'), undefined, 'null 결과 → 캐시 없음');
});

test('서로 다른 id 는 독립적으로 fetch/캐시된다', async () => {
  const seen = [];
  const store = createTicketMetaStore((id) => { seen.push(id); return Promise.resolve({ status: id }); });
  store.ensure('A');
  store.ensure('B');
  await tick();
  assert.deepEqual(seen.sort(), ['A', 'B'], '두 id 각각 fetch');
  assert.deepEqual(store.get('A'), { status: 'A' });
  assert.deepEqual(store.get('B'), { status: 'B' });
});
