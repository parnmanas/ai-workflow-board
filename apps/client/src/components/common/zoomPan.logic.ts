/**
 * 라이트박스 확대/이동 계산 — DOM 없이 숫자만 다룬다(`ZoomStage` 가 이것을 부른다).
 *
 * 좌표는 전부 **무대(stage) 가운데를 원점**으로 한 px 이다. 미디어는 무대 가운데에 "맞춤" 크기로
 * 놓이고 `translate(x, y) scale(scale)`(transform-origin 가운데)로 움직이므로, 미디어 위의 점 p 는
 * 화면에서 `(x, y) + scale * p` 에 보인다. 핀치·휠·더블탭 모두 "손가락(커서) 아래의 점이 그대로
 * 손가락 아래에 머문다" 를 이 식 하나로 푼다.
 */

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** 더블탭 · 더블클릭 한 번에 가는 배율. 폰 스크린샷이 원본 해상도 근처로 보이는 정도. */
export const DOUBLE_TAP_SCALE = 2.5;
/** − / + 버튼 · 키보드 한 번의 배율 걸음. */
export const ZOOM_STEP = 1.5;
/** 이만큼 움직이지 않았으면 탭이다(손가락 떨림). */
export const TAP_SLOP_PX = 8;
/** 두 탭이 이 시간 · 거리 안이면 더블탭. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;

export const IDENTITY: ZoomView = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  // `+ 0` 은 -0 을 0 으로 — 가운데 고정 축이 "-0px" 로 찍히지 않게.
  return Math.min(max, Math.max(min, value)) + 0;
}

export function isZoomed(view: ZoomView): boolean {
  return view.scale > MIN_SCALE + 0.01;
}

/**
 * 배율을 [MIN, MAX] 로, 이동을 "미디어 가장자리가 무대 가장자리를 넘어 안쪽으로 들어오지 않는"
 * 범위로 묶는다. 무대보다 작은 축은 가운데에 고정된다 — 확대하지 않은 그림을 끌어 치울 수 없다.
 * `content` 는 transform 이 걸리기 전의(맞춤) 크기다.
 */
export function clampView(view: ZoomView, content: Size, stage: Size): ZoomView {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const maxX = Math.max(0, (content.width * scale - stage.width) / 2);
  const maxY = Math.max(0, (content.height * scale - stage.height) / 2);
  return { scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

/** `focal`(무대 가운데 기준) 아래의 점을 고정한 채 배율만 `scale` 로 바꾼다. */
export function zoomAt(view: ZoomView, scale: number, focal: Point): ZoomView {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const k = next / view.scale;
  return {
    scale: next,
    x: focal.x - (focal.x - view.x) * k,
    y: focal.y - (focal.y - view.y) * k,
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 두 손가락 핀치. 시작 순간의 두 손가락 가운데(`startMid`) 아래에 있던 점이 지금의 가운데(`mid`)
 * 아래로 따라온다 — 벌리면 커지고, 두 손가락을 같이 끌면 그대로 이동한다.
 */
export function pinchView(start: ZoomView, startMid: Point, startDist: number, mid: Point, dist: number): ZoomView {
  const ratio = startDist > 0 ? dist / startDist : 1;
  const zoomed = zoomAt(start, start.scale * ratio, startMid);
  return { scale: zoomed.scale, x: zoomed.x + (mid.x - startMid.x), y: zoomed.y + (mid.y - startMid.y) };
}

/** 더블탭: 확대돼 있으면 맞춤으로, 아니면 그 점을 중심으로 DOUBLE_TAP_SCALE 까지. */
export function toggleZoomAt(view: ZoomView, focal: Point): ZoomView {
  return isZoomed(view) ? IDENTITY : zoomAt(view, DOUBLE_TAP_SCALE, focal);
}

/**
 * 휠 한 번의 배율 비. 트랙패드 핀치(ctrlKey 휠)와 마우스 휠이 같은 식을 탄다 — 델타가 작으면
 * 조금, 크면 많이. 줄 단위(deltaMode 1) 휠은 픽셀로 환산한다.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(px, -300, 300) * 0.002);
}

export type SwipeAction = 'prev' | 'next' | 'close' | null;

/**
 * 확대하지 않은 상태에서 한 손가락으로 끈 거리로 무엇을 할지 정한다. 가로로 충분히 밀면 넘기고
 * (손가락이 오른쪽으로 가면 이전), 세로로 충분히 밀면 닫는다. 대각선은 아무것도 하지 않는다 —
 * 애매한 손짓으로 다른 그림으로 넘어가 버리는 쪽이 더 나쁘다.
 */
export function classifySwipe(dx: number, dy: number, stage: Size): SwipeAction {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const horizontal = Math.min(80, stage.width * 0.18);
  const vertical = Math.min(120, stage.height * 0.15);
  if (ax >= horizontal && ax > ay * 1.5) return dx > 0 ? 'prev' : 'next';
  if (ay >= vertical && ay > ax * 1.5) return 'close';
  return null;
}
