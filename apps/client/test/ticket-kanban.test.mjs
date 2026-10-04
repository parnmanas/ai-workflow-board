// Tickets Kanban — 상태 lane 묶기 + 드래그 위치 계산 + 낙관적 이동 (docs/tickets.md).
//
// 서버 move 의미(PATCH /tickets/:id/move { status, position? }): 티켓을 원래 lane 에서
// 빼고(그 위 position 들 -1), 목적 lane 의 `position` 에 끼운다(≥ position +1). position 은
// "이동하는 티켓을 뺀 목적 lane" 의 인덱스이고, 생략하면 끝에 붙는다. 화면은 필터로 lane 의
// 일부만 보여줄 수 있으므로, 보이는 목록의 drop 인덱스를 이웃의 저장된 position 으로 번역한다.
//
// 실행: node --import tsx --test test/ticket-kanban.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMove,
  compareLaneOrder,
  computeMovePosition,
  findTicketInTree,
  groupByStatus,
  treeIds,
} from '../src/tickets/kanban.ts';

const t = (id, status, position, extra = {}) => ({ id, status, position, created_at: `2026-01-0${(position % 9) + 1}`, ...extra });

const order = (tickets, status) => groupByStatus(tickets)[status].map((x) => x.id);

test('groupByStatus: 5 lane 전부, root 만, position → created_at 순', () => {
  const lanes = groupByStatus([
    t('b', 'todo', 1),
    t('a', 'todo', 0),
    t('child', 'todo', 0, { parent_id: 'a' }),
    t('c', 'done', 0),
    { id: 'tie2', status: 'review', position: 0, created_at: '2026-02-02' },
    { id: 'tie1', status: 'review', position: 0, created_at: '2026-02-01' },
  ]);
  assert.deepEqual(Object.keys(lanes), ['backlog', 'todo', 'in_progress', 'review', 'done']);
  assert.deepEqual(lanes.todo.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(lanes.review.map((x) => x.id), ['tie1', 'tie2']);
  assert.deepEqual(lanes.backlog, []);
  assert.ok(compareLaneOrder(t('x', 'todo', 0), t('y', 'todo', 1)) < 0);
});

test('같은 lane 안에서 아래로: 빼고 난 뒤의 인덱스를 보낸다', () => {
  const lane = [t('A', 'todo', 0), t('B', 'todo', 1), t('C', 'todo', 2), t('D', 'todo', 3)];
  // A 를 C 다음(보이는 인덱스 2)으로 → B, C, A, D
  assert.equal(computeMovePosition(lane, lane[0], 'todo', 2), 2);
  const after = applyMove(lane, 'A', 'todo', 2);
  assert.deepEqual(order(after, 'todo'), ['B', 'C', 'A', 'D']);
  // 맨 끝으로
  assert.equal(computeMovePosition(lane, lane[0], 'todo', 3), 3);
  assert.deepEqual(order(applyMove(lane, 'A', 'todo', 3), 'todo'), ['B', 'C', 'D', 'A']);
});

test('같은 lane 안에서 위로', () => {
  const lane = [t('A', 'todo', 0), t('B', 'todo', 1), t('C', 'todo', 2), t('D', 'todo', 3)];
  assert.equal(computeMovePosition(lane, lane[3], 'todo', 0), 0);
  assert.deepEqual(order(applyMove(lane, 'D', 'todo', 0), 'todo'), ['D', 'A', 'B', 'C']);
  assert.equal(computeMovePosition(lane, lane[2], 'todo', 1), 1);
  assert.deepEqual(order(applyMove(lane, 'C', 'todo', 1), 'todo'), ['A', 'C', 'B', 'D']);
});

test('다른 lane 으로: 목적 lane 의 이웃 position 을 그대로 쓴다', () => {
  const all = [t('A', 'todo', 0), t('B', 'todo', 1), t('X', 'in_progress', 0), t('Y', 'in_progress', 1)];
  const dest = groupByStatus(all).in_progress;
  assert.equal(computeMovePosition(dest, all[0], 'in_progress', 1), 1);
  const after = applyMove(all, 'A', 'in_progress', 1);
  assert.deepEqual(order(after, 'in_progress'), ['X', 'A', 'Y']);
  assert.deepEqual(order(after, 'todo'), ['B']);
  // 원래 lane 은 빈자리 없이 당겨진다.
  assert.equal(after.find((x) => x.id === 'B').position, 0);
});

test('필터로 일부만 보이면 보이는 인덱스를 저장된 position 으로 번역한다', () => {
  // 전체 todo lane: A0 B1 C2 D3 E4 — 화면에는 A, C, E 만 보인다.
  const full = ['A', 'B', 'C', 'D', 'E'].map((id, i) => t(id, 'todo', i));
  const visible = [full[0], full[2], full[4]];
  // 보이는 목록에서 A 를 C 와 E 사이(인덱스 1 → 빼고 나면 [C, E] 의 1 = E 자리)로
  // → E 앞: 서버 인덱스는 E(4) 에서 A 를 뺀 3.
  assert.equal(computeMovePosition(visible, full[0], 'todo', 1), 3);
  assert.deepEqual(order(applyMove(full, 'A', 'todo', 3), 'todo'), ['B', 'C', 'D', 'A', 'E']);
  // 다른 lane 의 티켓을 보이는 목록 맨 끝에 → 마지막 보이는 티켓 바로 뒤.
  const moved = t('Z', 'backlog', 0);
  assert.equal(computeMovePosition(visible, moved, 'todo', 3), 5);
});

test('보이는 목적 lane 이 비었으면 position 을 생략(서버가 끝에 붙인다)', () => {
  assert.equal(computeMovePosition([], t('A', 'todo', 0), 'done', 0), undefined);
  // 같은 lane 에 자기 자신만 보이는 경우도 같다.
  const self = t('A', 'todo', 4);
  assert.equal(computeMovePosition([self], self, 'todo', 0), undefined);
  const all = [self, t('B', 'done', 0), t('C', 'done', 1)];
  const after = applyMove(all, 'A', 'done', undefined);
  assert.deepEqual(order(after, 'done'), ['B', 'C', 'A']);
  assert.equal(after.find((x) => x.id === 'A').position, 2);
});

test('applyMove: 범위 밖 position 은 lane 길이로 자르고, 관계없는 행과 child 는 그대로 둔다', () => {
  const child = t('k', 'todo', 0, { parent_id: 'A' });
  const other = t('O', 'review', 0);
  const all = [t('A', 'todo', 0), t('B', 'todo', 1), child, other];
  const after = applyMove(all, 'A', 'todo', 99);
  assert.deepEqual(order(after, 'todo'), ['B', 'A']);
  assert.equal(after.find((x) => x.id === 'k'), child, 'child 행은 같은 객체');
  assert.equal(after.find((x) => x.id === 'O'), other, '다른 lane 행은 같은 객체');
  assert.deepEqual(applyMove(all, 'missing', 'done', 0).map((x) => x.id), all.map((x) => x.id));
});

test('findTicketInTree / treeIds 는 손자까지 내려간다', () => {
  const tree = [{ id: 'r', children: [{ id: 'c', children: [{ id: 'g', children: [] }] }] }, { id: 'r2', children: [] }];
  assert.equal(findTicketInTree(tree, 'g').id, 'g');
  assert.equal(findTicketInTree(tree, 'nope'), null);
  assert.equal(findTicketInTree(tree, null), null);
  assert.deepEqual([...treeIds(tree[0])].sort(), ['c', 'g', 'r']);
  assert.equal(treeIds(null).size, 0);
});
