// @멘션은 "그 코멘트/메시지가 실제로 화면에 있었을 때"만 읽음 처리된다 — 회귀 가드.
//
// 왜 이 규칙인가: 티켓 패널을 열었다는 사실, 채팅방을 열었다는 사실만으로 멘션을
// 지우면 안 된다. 방은 최신 메시지로 스크롤된 채 열리므로 200개 위의 멘션에 대해
// 아무것도 증명하지 못하고, 패널을 2초 열었다 닫으면 정작 열어본 이유였던 멘션이
// 사라진다. 멘션은 사람에게 일을 배정하는 수단이라 "근처에 있었다"가 아니라
// "화면에 있었다"가 기준이다.
//
// 여기서 고정하는 동작:
//   - dwell: 잠깐 스쳐 지나간 행은 읽은 게 아니다 (dwell 전에 벗어나면 취소)
//   - 탭 가시성: 백그라운드 탭에서 "보이는" 행은 읽은 게 아니다
//   - 대기 목록에 없는 행은 아무 요청도 만들지 않는다
//   - 서버가 실제로 지운 수(updated)만큼만 뱃지를 차감한다 (보낸 수가 아니라)
//   - 실패한 배치는 재큐되어 유실되지 않는다

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const act = React.act;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// `navigator` is a getter-only global on modern Node — copy the rest only.
for (const key of ['Node', 'HTMLElement', 'Element', 'Event', 'CustomEvent', 'MutationObserver']) {
  if (dom.window[key]) globalThis[key] = dom.window[key];
}

// ── Controllable IntersectionObserver ───────────────────────────────────────
let observers = [];
class FakeIntersectionObserver {
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); observers = observers.filter((o) => o !== this); }
  /** Drive an intersection change for the row carrying `id`. */
  fire(id, ratio) {
    const target = [...this.targets].find(
      (el) => el.getAttribute('data-comment-id') === id || el.getAttribute('data-message-id') === id,
    );
    if (!target) throw new Error(`no observed row for ${id}`);
    this.cb([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
}
globalThis.IntersectionObserver = FakeIntersectionObserver;
dom.window.IntersectionObserver = FakeIntersectionObserver;

// ── api stub (the hook imports the module directly) ─────────────────────────
const apiModule = await import('../src/api.ts');
let pendingItems = [];
let markCalls = [];
let markImpl = async (ids) => ({ updated: ids.length });
apiModule.api.getUnreadMentionsBySource = async () => ({ items: pendingItems });
apiModule.api.markMentionsRead = async (ids) => {
  markCalls.push(ids);
  return markImpl(ids);
};

const { useMentionViewportReader } = await import('../src/hooks/useMentionViewportReader.ts');

const DWELL = 20;

function Harness({ ids, cleared }) {
  const ref = React.useRef(null);
  useMentionViewportReader({
    containerRef: ref,
    source: { ticketId: 't-1' },
    anchorAttribute: 'data-comment-id',
    renderSignal: ids.join(','),
    dwellMs: DWELL,
    threshold: 0.5,
    flushDelayMs: 5,
    onCleared: (n) => cleared.push(n),
  });
  return React.createElement(
    'div',
    { ref },
    ids.map((id) => React.createElement('div', { key: id, 'data-comment-id': id }, id)),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mount(ids, cleared) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness, { ids, cleared })); });
  // let the pending-set fetch resolve
  await act(async () => { await sleep(0); });
  return { root, host };
}

function reset() {
  observers = [];
  markCalls = [];
  markImpl = async (ids) => ({ updated: ids.length });
  Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
}

test('행이 dwell 만큼 화면에 머무르면 읽음 처리된다', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  const cleared = [];
  const { root } = await mount(['c1', 'c2'], cleared);

  await act(async () => { observers[0].fire('c1', 1); });
  await act(async () => { await sleep(DWELL + 40); });

  assert.deepEqual(markCalls, [['m1']], '보인 멘션 하나만 배치로 보내야 한다');
  assert.deepEqual(cleared, [1], '서버가 지운 수만큼 뱃지를 차감한다');
  await act(async () => { root.unmount(); });
});

test('dwell 전에 화면을 벗어나면 읽지 않은 것으로 남는다 (스크롤로 스쳐 지나감)', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  const cleared = [];
  const { root } = await mount(['c1'], cleared);

  await act(async () => { observers[0].fire('c1', 1); });
  await act(async () => { await sleep(DWELL / 2); });
  await act(async () => { observers[0].fire('c1', 0); });   // 스크롤로 벗어남
  await act(async () => { await sleep(DWELL + 40); });

  assert.deepEqual(markCalls, [], '스쳐 지나간 멘션을 지우면 안 된다');
  assert.deepEqual(cleared, []);
  await act(async () => { root.unmount(); });
});

test('백그라운드 탭에서는 보여도 읽음 처리하지 않는다', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  const cleared = [];
  const { root } = await mount(['c1'], cleared);

  await act(async () => { observers[0].fire('c1', 1); });
  Object.defineProperty(dom.window.document, 'hidden', { value: true, configurable: true });
  await act(async () => { await sleep(DWELL + 40); });

  assert.deepEqual(markCalls, [], '탭이 숨겨져 있으면 본 것이 아니다');
  await act(async () => { root.unmount(); });
});

test('부분 노출(threshold 미만)은 읽음으로 치지 않는다', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  const cleared = [];
  const { root } = await mount(['c1'], cleared);

  await act(async () => { observers[0].fire('c1', 0.2); });
  await act(async () => { await sleep(DWELL + 40); });

  assert.deepEqual(markCalls, [], 'threshold 미만 노출은 읽은 것이 아니다');
  await act(async () => { root.unmount(); });
});

test('멘션이 없는 행이 보여도 요청을 만들지 않는다', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  const cleared = [];
  const { root } = await mount(['c1', 'c2'], cleared);

  await act(async () => { observers[0].fire('c2', 1); });
  await act(async () => { await sleep(DWELL + 40); });

  assert.deepEqual(markCalls, [], '대기 목록에 없는 행은 무시');
  await act(async () => { root.unmount(); });
});

test('한 화면에 여러 멘션이 보이면 한 번의 배치로 묶인다', async () => {
  reset();
  pendingItems = [
    { id: 'm1', source_id: 'c1' },
    { id: 'm2', source_id: 'c2' },
  ];
  const cleared = [];
  const { root } = await mount(['c1', 'c2'], cleared);

  await act(async () => {
    observers[0].fire('c1', 1);
    observers[0].fire('c2', 1);
  });
  await act(async () => { await sleep(DWELL + 60); });

  assert.equal(markCalls.length, 1, '요청은 한 번이어야 한다');
  assert.deepEqual([...markCalls[0]].sort(), ['m1', 'm2']);
  assert.deepEqual(cleared, [2]);
  await act(async () => { root.unmount(); });
});

test('서버가 일부만 지웠으면 그만큼만 차감한다 (다른 탭이 먼저 지운 경우)', async () => {
  reset();
  pendingItems = [
    { id: 'm1', source_id: 'c1' },
    { id: 'm2', source_id: 'c2' },
  ];
  markImpl = async () => ({ updated: 1 });
  const cleared = [];
  const { root } = await mount(['c1', 'c2'], cleared);

  await act(async () => {
    observers[0].fire('c1', 1);
    observers[0].fire('c2', 1);
  });
  await act(async () => { await sleep(DWELL + 60); });

  assert.deepEqual(cleared, [1], '보낸 수가 아니라 서버가 실제로 지운 수만큼만 차감');
  await act(async () => { root.unmount(); });
});

test('배치 실패는 재큐되어 유실되지 않는다', async () => {
  reset();
  pendingItems = [{ id: 'm1', source_id: 'c1' }];
  markImpl = async () => { throw new Error('network'); };
  const cleared = [];
  const { root } = await mount(['c1'], cleared);

  await act(async () => { observers[0].fire('c1', 1); });
  await act(async () => { await sleep(DWELL + 40); });

  assert.equal(markCalls.length, 1);
  assert.deepEqual(cleared, [], '실패했으면 뱃지를 차감하면 안 된다');

  // 언마운트 시 남은 큐를 flush — 이번엔 성공.
  markImpl = async (ids) => ({ updated: ids.length });
  await act(async () => { root.unmount(); });
  await act(async () => { await sleep(10); });
  assert.equal(markCalls.length, 2, '재큐된 읽음이 다시 전송되어야 한다');
  assert.deepEqual(markCalls[1], ['m1']);
});
