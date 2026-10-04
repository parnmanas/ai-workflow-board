import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import { SubtaskBoardRows } from '../src/components/TicketCard.tsx';

const grandchild = { id: 'gc-1', title: '하위 검증', status: 'done', children: [] };
// Children have no assignee of their own (docs/tickets.md) — the row shows the
// status label (from tickets/status.ts), title and progress.
const child = {
  id: 'child-1', title: 'API 구현', status: 'in_progress', assignee: null, assignee_key: '',
  children: [grandchild],
};

test('실제 렌더링한 child 행에 상태 라벨·제목·진행률과 비드래그 구조가 보인다', () => {
  const html = renderToStaticMarkup(React.createElement(SubtaskBoardRows, { children: [child] }));
  assert.match(html, /In Progress/);
  assert.doesNotMatch(html, /in_progress/, '상태는 raw 값이 아니라 라벨로 그린다');
  assert.match(html, /API 구현/);
  assert.doesNotMatch(html, /미할당/, 'child 에는 담당자 칸이 없다');
  assert.match(html, />1\/1</);
  assert.match(html, /data-subtask-id="child-1"/);
  assert.doesNotMatch(html, /data-rbd-draggable/);
});

test('child 클릭은 상세 패널 콜백으로 해당 child를 전달하고 root 클릭으로 전파하지 않는다', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let selected = null;
  let rootClicks = 0;
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement('div', { onClick: () => { rootClicks += 1; } },
      React.createElement(SubtaskBoardRows, { children: [child], onChildClick: value => { selected = value; } })));
  });
  await act(async () => {
    document.querySelector('[data-subtask-id="child-1"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(selected?.id, 'child-1');
  assert.equal(rootClicks, 0);
  await act(async () => root.unmount());
  dom.window.close();
});
