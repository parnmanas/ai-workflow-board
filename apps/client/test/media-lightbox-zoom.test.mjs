// 첨부 미디어 라이트박스의 확대 · 이동 (2026-10-17).
//
// 안드로이드 앱의 WebView 는 페이지 확대가 꺼져 있어, 채팅 · 세션에서 사진을 열어도 두 손가락으로
// 키울 방법이 없었다. 라이트박스가 직접 핀치 · 드래그 · 더블탭을 계산한다 — 이 테스트는 그 계산과
// 실제 포인터 이벤트 경로(맞춤 상태의 스와이프 넘기기/닫기, 드래그 뒤 click 삼키기, 영상의 네이티브
// 컨트롤 양보, 뒤로 가기로 닫기)를 같이 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import MediaLightbox from '../src/components/common/MediaLightbox.tsx';
import {
  IDENTITY,
  MAX_SCALE,
  clampView,
  classifySwipe,
  pinchView,
  toggleZoomAt,
  wheelZoomFactor,
  zoomAt,
} from '../src/components/common/zoomPan.logic.ts';

const STAGE = { width: 400, height: 800 };
const CONTENT = { width: 400, height: 300 };

/** 화면 좌표의 점(무대 가운데 기준)이 가리키는 미디어 위의 점. */
function contentPointAt(view, p) {
  return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
}

test('zoomAt: 손가락(커서) 아래의 점은 확대해도 그 자리에 머문다', () => {
  const view = { scale: 1.5, x: 20, y: -10 };
  const focal = { x: 90, y: 40 };
  const before = contentPointAt(view, focal);
  const after = contentPointAt(zoomAt(view, 4, focal), focal);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(view, 100, focal).scale, MAX_SCALE, '상한에서 멈춘다');
  assert.equal(zoomAt(view, 0.2, focal).scale, 1, '맞춤보다 작아지지 않는다');
});

test('pinchView: 벌리면 커지고, 두 손가락 가운데를 따라 함께 움직인다', () => {
  const start = IDENTITY;
  const startMid = { x: 50, y: 0 };
  const grabbed = contentPointAt(start, startMid);
  const view = pinchView(start, startMid, 100, { x: 80, y: 30 }, 250);
  assert.equal(view.scale, 2.5);
  const now = contentPointAt(view, { x: 80, y: 30 });
  assert.ok(Math.abs(now.x - grabbed.x) < 1e-9 && Math.abs(now.y - grabbed.y) < 1e-9, '잡은 점이 손가락 가운데에 붙어 있다');
});

test('clampView: 가장자리가 무대 안쪽으로 들어오지 않고, 무대보다 작은 축은 가운데에 고정된다', () => {
  assert.deepEqual(clampView({ scale: 1, x: 120, y: -50 }, CONTENT, STAGE), IDENTITY, '맞춤 상태는 끌어 치울 수 없다');
  // 2배: 가로 800 → ±200 까지, 세로 600 < 800 → 0 고정.
  assert.deepEqual(clampView({ scale: 2, x: 999, y: 999 }, CONTENT, STAGE), { scale: 2, x: 200, y: 0 });
  // 4배: 세로 1200 → ±200.
  assert.deepEqual(clampView({ scale: 4, x: -999, y: -999 }, CONTENT, STAGE), { scale: 4, x: -600, y: -200 });
});

test('toggleZoomAt: 더블탭은 맞춤 ↔ 확대를 오간다', () => {
  const zoomed = toggleZoomAt(IDENTITY, { x: 40, y: 10 });
  assert.ok(zoomed.scale > 1);
  assert.deepEqual(toggleZoomAt(zoomed, { x: 0, y: 0 }), IDENTITY);
});

test('classifySwipe: 가로는 넘기기, 세로는 닫기, 대각선과 짧은 손짓은 아무것도 아니다', () => {
  assert.equal(classifySwipe(-120, 10, STAGE), 'next');
  assert.equal(classifySwipe(120, -10, STAGE), 'prev');
  assert.equal(classifySwipe(5, 200, STAGE), 'close');
  assert.equal(classifySwipe(-90, -90, STAGE), null);
  assert.equal(classifySwipe(-30, 0, STAGE), null);
});

test('wheelZoomFactor: 위로 굴리면 커지고 아래로 굴리면 작아진다 — 줄 단위 휠도 같은 방향', () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.ok(wheelZoomFactor(-3, 1) > 1);
});

// ── 실제 라이트박스 ────────────────────────────────────────────────────────

const ITEMS = [
  { src: 'blob:one', kind: 'image', caption: 'one.png' },
  { src: 'blob:two', kind: 'image', caption: 'two.png' },
  { src: 'blob:clip', kind: 'video', caption: 'clip.webm' },
];

function Harness({ items = ITEMS, start = 0, onClosed }) {
  const [index, setIndex] = React.useState(start);
  const [open, setOpen] = React.useState(true);
  if (!open) return React.createElement('div', { 'data-testid': 'closed' });
  return React.createElement(MediaLightbox, {
    items,
    index,
    onIndexChange: setIndex,
    onClose: () => {
      setOpen(false);
      onClosed?.();
    },
  });
}

function setup(t, props = {}) {
  const dom = setupDom({ width: 400 });
  globalThis.PointerEvent = dom.window.PointerEvent;
  const view = mount(React.createElement(Harness, props));
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return { dom, view };
}

/** jsdom 은 레이아웃이 없다 — 무대 400×800, 맞춤 이미지 400×300 으로 고정한다. */
function layout(container) {
  const stage = container.querySelector('[data-testid="zoom-stage"]');
  assert.ok(stage, '무대가 그려진다');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800, x: 0, y: 0 });
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: STAGE.width });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: STAGE.height });
  const media = stage.querySelector('img, video');
  Object.defineProperty(media, 'offsetWidth', { configurable: true, value: CONTENT.width });
  Object.defineProperty(media, 'offsetHeight', { configurable: true, value: CONTENT.height });
  return { stage, media };
}

function pointer(target, type, id, x, y, pointerType = 'touch') {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, clientX: x, clientY: y, button: 0 }));
  });
}

function scaleOf(container) {
  return Number(container.querySelector('[data-testid="zoom-stage"]').getAttribute('data-zoom-scale'));
}

function transformOf(container) {
  return container.querySelector('[data-testid="zoom-stage"] img, [data-testid="zoom-stage"] video').style.transform;
}

function counter(container) {
  return container.querySelector('[data-testid="media-lightbox-counter"]')?.textContent;
}

test('두 손가락 핀치로 확대하고, 확대된 그림은 한 손가락으로 끌어 옮긴다', (t) => {
  const { view } = setup(t);
  const { media, stage } = layout(view.container);
  // 무대 가운데(200,400) 양옆에서 100px → 300px 로 벌린다.
  pointer(media, 'pointerdown', 1, 150, 400);
  pointer(media, 'pointerdown', 2, 250, 400);
  pointer(stage, 'pointermove', 1, 50, 400);
  pointer(stage, 'pointermove', 2, 350, 400);
  assert.equal(scaleOf(view.container), 3, '손가락 사이가 세 배가 되면 세 배');
  pointer(stage, 'pointerup', 1, 50, 400);
  pointer(stage, 'pointerup', 2, 350, 400);
  assert.equal(scaleOf(view.container), 3, '손을 떼도 확대는 유지된다');

  pointer(media, 'pointerdown', 3, 200, 400);
  pointer(stage, 'pointermove', 3, 260, 420);
  pointer(stage, 'pointerup', 3, 260, 420);
  assert.match(transformOf(view.container), /translate\(60px, 20px\) scale\(3\)/, '확대 상태의 드래그는 넘기기가 아니라 이동');
  assert.equal(counter(view.container), '1 / 3', '이동이 다음 장으로 넘기지 않는다');
});

test('더블탭으로 확대하고, 다시 더블탭하면 맞춤으로 돌아간다', (t) => {
  const { view } = setup(t);
  const { media, stage } = layout(view.container);
  for (let i = 0; i < 2; i++) {
    pointer(media, 'pointerdown', 1, 200, 400);
    pointer(stage, 'pointerup', 1, 200, 400);
  }
  assert.ok(scaleOf(view.container) > 1, '더블탭 확대');
  for (let i = 0; i < 2; i++) {
    pointer(media, 'pointerdown', 1, 200, 400);
    pointer(stage, 'pointerup', 1, 200, 400);
  }
  assert.equal(scaleOf(view.container), 1, '두 번째 더블탭은 맞춤');
});

/** 실제 순서처럼 pointerup 다음에 touchend 를 보내고, 미뤄 둔 넘기기/닫기가 돌 때까지 기다린다. */
async function liftTouch(stage, id, x, y) {
  pointer(stage, 'pointerup', id, x, y);
  await act(async () => {
    window.dispatchEvent(new window.TouchEvent('touchend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

test('맞춤 상태에서 가로로 밀면 다음/이전, 세로로 밀면 닫힌다', async (t) => {
  let closed = 0;
  const { view } = setup(t, { onClosed: () => closed++ });
  let { media, stage } = layout(view.container);
  pointer(media, 'pointerdown', 1, 300, 400);
  pointer(stage, 'pointermove', 1, 200, 405);
  pointer(stage, 'pointermove', 1, 120, 405);
  pointer(stage, 'pointerup', 1, 120, 405);
  assert.equal(counter(view.container), '1 / 3', '터치가 끝나기(touchend) 전에는 손가락 아래 요소를 바꾸지 않는다');
  await act(async () => {
    window.dispatchEvent(new window.TouchEvent('touchend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(counter(view.container), '2 / 3', '왼쪽으로 밀면 다음 장');
  assert.equal(scaleOf(view.container), 1);

  ({ media, stage } = layout(view.container));
  pointer(media, 'pointerdown', 1, 100, 400);
  pointer(stage, 'pointermove', 1, 260, 400);
  await liftTouch(stage, 1, 260, 400);
  assert.equal(counter(view.container), '1 / 3', '오른쪽으로 밀면 이전 장');

  ({ media, stage } = layout(view.container));
  pointer(media, 'pointerdown', 1, 200, 300);
  pointer(stage, 'pointermove', 1, 205, 450);
  await liftTouch(stage, 1, 205, 450);
  assert.equal(closed, 1, '세로로 밀면 닫힌다');
  assert.ok(view.container.querySelector('[data-testid="closed"]'));
});

test('짧거나 대각선인 손짓은 아무것도 하지 않고 제자리로 돌아간다', async (t) => {
  const { view } = setup(t);
  const { media, stage } = layout(view.container);
  pointer(media, 'pointerdown', 1, 200, 400);
  pointer(stage, 'pointermove', 1, 170, 400);
  assert.match(transformOf(view.container), /translate\(-30px, 0px\)/, '미는 동안은 손가락을 따라온다');
  await liftTouch(stage, 1, 170, 400);
  assert.equal(counter(view.container), '1 / 3');
  assert.match(transformOf(view.container), /translate\(0px, 0px\) scale\(1\)/);
});

test('그림을 끌다 바탕에서 손을 떼도 닫히지 않는다 — 바탕을 그냥 누르면 닫힌다', (t) => {
  let closed = 0;
  const { view } = setup(t, { onClosed: () => closed++ });
  const { media, stage } = layout(view.container);
  pointer(media, 'pointerdown', 1, 200, 400, 'mouse');
  pointer(stage, 'pointermove', 1, 200, 700, 'mouse');
  pointer(stage, 'pointerup', 1, 200, 700, 'mouse');
  act(() => { stage.click(); });
  assert.equal(closed, 0, '드래그 뒤에 따라오는 click 은 삼킨다');

  // click 삼킴은 그 한 번뿐이다(다음 태스크에서 풀린다).
  return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
    pointer(stage, 'pointerdown', 2, 200, 750, 'mouse');
    pointer(stage, 'pointerup', 2, 200, 750, 'mouse');
    act(() => { stage.click(); });
    assert.equal(closed, 1, '바탕을 누르면 닫힌다');
  });
});

test('영상: 맞춤 상태의 한 손가락은 네이티브 컨트롤 몫, 핀치로 확대하면 컨트롤을 숨긴다', (t) => {
  const { view } = setup(t, { start: 2 });
  const { media, stage } = layout(view.container);
  assert.equal(media.tagName, 'VIDEO');
  assert.ok(media.hasAttribute('controls'));
  // 재생 막대를 끄는 손짓 — 다음 장으로 넘어가면 안 된다.
  pointer(media, 'pointerdown', 1, 300, 500);
  pointer(stage, 'pointermove', 1, 100, 500);
  pointer(stage, 'pointerup', 1, 100, 500);
  assert.equal(counter(view.container), '3 / 3', '영상 위 가로 드래그는 넘기지 않는다');

  pointer(media, 'pointerdown', 1, 180, 400);
  pointer(media, 'pointerdown', 2, 220, 400);
  pointer(stage, 'pointermove', 1, 140, 400);
  pointer(stage, 'pointermove', 2, 260, 400);
  pointer(stage, 'pointerup', 1, 140, 400);
  pointer(stage, 'pointerup', 2, 260, 400);
  assert.equal(scaleOf(view.container), 3);
  assert.equal(view.container.querySelector('video').hasAttribute('controls'), false, '확대 중에는 컨트롤을 숨긴다');
});

test('−/+ 버튼과 % 버튼(맞춤)으로도 확대를 조절한다', (t) => {
  const { view } = setup(t);
  layout(view.container);
  const button = (label) => view.container.querySelector(`button[aria-label="${label}"]`);
  act(() => { button('Zoom in').click(); });
  assert.equal(scaleOf(view.container), 1.5);
  assert.equal(view.container.querySelector('[data-testid="zoom-stage-level"]').textContent, '150%');
  act(() => { button('Zoom in').click(); });
  act(() => { button('Zoom out').click(); });
  assert.equal(scaleOf(view.container), 1.5);
  act(() => { button('Reset zoom').click(); });
  assert.equal(scaleOf(view.container), 1);
  assert.ok(view.container.querySelector('[data-testid="media-lightbox"]'), '도구 버튼은 라이트박스를 닫지 않는다');
});

test('뒤로 가기는 화면을 떠나지 않고 라이트박스를 닫는다', async (t) => {
  let closed = 0;
  const { dom, view } = setup(t, { onClosed: () => closed++ });
  await act(async () => {});
  assert.ok(dom.window.history.state?.awbOverlay, '열리면 history 에 항목 하나를 얹는다');
  await act(async () => {
    dom.window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(closed, 1);
  assert.equal(dom.window.location.href, 'http://localhost/', '주소는 그대로');
  assert.ok(view.container.querySelector('[data-testid="closed"]'));
});

test('버튼으로 닫으면 얹었던 history 항목을 걷어낸다', async (t) => {
  const { dom, view } = setup(t);
  await act(async () => {});
  assert.ok(dom.window.history.state?.awbOverlay);
  const close = [...view.container.querySelectorAll('button')].find((b) => /Close/.test(b.textContent));
  await act(async () => { close.click(); });
  // 닫힘(언마운트)은 act 가 끝날 때 반영되고, 항목 걷어내기는 그 뒤 비동기 history.back() 이다.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dom.window.history.state?.awbOverlay, undefined, '다음 뒤로 가기가 헛돌지 않는다');
});

test('Esc 는 라이트박스만 닫는다 — 아래 화면(티켓 패널 등)의 Esc 닫기로 번지지 않는다', (t) => {
  let closed = 0;
  let underneath = 0;
  // 티켓 패널은 document 에서 Esc 로 닫힌다 — 라이트박스가 떠 있으면 그 Esc 는 라이트박스 것이다.
  const { view } = setup(t, { onClosed: () => closed++ });
  // setupDom 이 전역 document 를 새로 만든 뒤에 단다.
  const onKey = (e) => { if (e.key === 'Escape') underneath++; };
  document.addEventListener('keydown', onKey);
  t.after(() => document.removeEventListener('keydown', onKey));
  act(() => {
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(closed, 1, '라이트박스는 닫힌다');
  assert.equal(underneath, 0, '아래 화면은 Esc 를 받지 않는다');
  assert.ok(view.container.querySelector('[data-testid="closed"]'));
});
