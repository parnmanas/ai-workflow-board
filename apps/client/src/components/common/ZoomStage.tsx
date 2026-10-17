import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  IDENTITY,
  ZOOM_STEP,
  TAP_SLOP_PX,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  classifySwipe,
  clampView,
  distance,
  isZoomed,
  midpoint,
  pinchView,
  toggleZoomAt,
  wheelZoomFactor,
  zoomAt,
  type Point,
  type ZoomView,
} from './zoomPan.logic';

/**
 * 라이트박스 안의 미디어 한 장을 확대·이동하는 무대. `MediaLightbox` · `EvidenceLightbox` 가
 * 같이 쓴다 — 제스처는 여기서 한 번만 다룬다.
 *
 * - 두 손가락 핀치(안드로이드 앱 WebView 는 페이지 줌이 꺼져 있어 직접 계산한다), 확대 상태에서
 *   한 손가락 · 마우스 드래그로 이동, 더블탭 · 더블클릭으로 확대/맞춤 전환, 휠 · 트랙패드 핀치,
 *   −/+ 버튼과 키보드(+ − 0).
 * - 확대하지 않은 상태의 터치 스와이프: 가로는 이전/다음, 세로는 닫기.
 * - 영상은 맞춤 상태에서 한 손가락 입력을 **네이티브 컨트롤에 양보한다**(재생 막대를 끌다가
 *   다음 영상으로 넘어가면 안 된다). 두 손가락이 닿을 때만 확대를 잡고, 확대 중에는 컨트롤을
 *   숨기고 탭으로 재생/정지한다 — 확대된 컨트롤 막대는 화면 밖으로 밀려나 쓸 수 없다.
 *
 * 무대 바탕을 탭하면 click 이 부모(라이트박스 바탕)로 올라가 닫힌다. 드래그 · 핀치 · 스와이프
 * 뒤에 따라오는 click 은 여기서 삼킨다 — 그림을 옮기고 손을 뗀 곳이 바탕이어도 닫히지 않게.
 */

interface ZoomStageProps {
  kind: 'image' | 'video';
  src: string;
  alt: string;
  onError: () => void;
  /** 확대하지 않은 상태의 가로 스와이프. 없으면 끝에 닿은 듯 조금만 따라온다. */
  onPrev?: () => void;
  onNext?: () => void;
  /** 확대하지 않은 상태의 세로 스와이프. */
  onDismiss?: () => void;
}

type Mode = 'none' | 'pan' | 'swipe' | 'pinch';

interface Gesture {
  mode: Mode;
  /** 시작점(무대 가운데 기준). 핀치는 두 손가락의 가운데. */
  start: Point;
  from: ZoomView;
  startDist: number;
  t0: number;
  /** 탭이 아니게 된 제스처 — 손을 떼도 탭으로 치지 않고, 따라오는 click 을 삼킨다. */
  moved: boolean;
  onContent: boolean;
  axis: 'x' | 'y' | null;
  /** 맞춤 상태 영상 위의 한 손가락 — 네이티브 컨트롤 몫이라 지켜보기만 한다. */
  native: boolean;
}

const IDLE: Gesture = {
  mode: 'none', start: { x: 0, y: 0 }, from: IDENTITY, startDist: 0, t0: 0, moved: false, onContent: false, axis: null, native: false,
};

/**
 * 스와이프로 넘기기 · 닫기는 그 터치가 완전히 끝난 뒤에 한다. pointerup 안에서 바로 바꾸면
 * 손가락이 닿은 미디어 요소가 touchend 전에 DOM 에서 빠지고, Chromium(안드로이드 WebView 포함)은
 * 그 뒤 첫 탭의 click 을 만들지 않는다 — 넘기거나 닫은 다음 누른 버튼이 한 번 먹통이 된다.
 * touchend 는 pointerup 과 다른 태스크로 올 때가 있어 setTimeout(0) 으로는 모자라다(실측 2/8 유실).
 */
function afterTouchEnds(fn: () => void) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('touchend', onEnd, true);
    window.removeEventListener('touchcancel', onEnd, true);
    clearTimeout(fallback);
    setTimeout(fn, 0);
  };
  const onEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) finish();
  };
  window.addEventListener('touchend', onEnd, true);
  window.addEventListener('touchcancel', onEnd, true);
  // touchend 가 이미 지나갔거나 오지 않는 환경에서 영원히 기다리지 않게.
  const fallback = setTimeout(finish, 300);
}

const toolButton: React.CSSProperties = {
  minWidth: 34,
  height: 34,
  padding: '0 8px',
  border: 'none',
  background: 'transparent',
  color: '#fff',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default function ZoomStage({ kind, src, alt, onError, onPrev, onNext, onDismiss }: ZoomStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLImageElement & HTMLVideoElement>(null);
  const [state, setState] = useState<{ view: ZoomView; animate: boolean }>({ view: IDENTITY, animate: false });
  const viewRef = useRef<ZoomView>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ ...IDLE });
  const lastTap = useRef<{ t: number; p: Point } | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  const sizes = useCallback(() => {
    const stage = stageRef.current;
    const media = mediaRef.current;
    return {
      stage: { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 },
      // transform 이 걸리기 전의 레이아웃 크기 — 맞춤 크기다.
      content: { width: media?.offsetWidth ?? 0, height: media?.offsetHeight ?? 0 },
    };
  }, []);

  /** `free` 는 스와이프 중의 "손가락을 따라오는" 위치 — 이동 범위로 묶지 않는다. */
  const commit = useCallback((next: ZoomView, animate: boolean, free = false) => {
    const { stage, content } = sizes();
    const view = free ? next : clampView(next, content, stage);
    viewRef.current = view;
    setState({ view, animate });
  }, [sizes]);

  const toLocal = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  const capture = useCallback((pointerId: number) => {
    const stage = stageRef.current;
    if (!stage || typeof stage.setPointerCapture !== 'function') return;
    try {
      stage.setPointerCapture(pointerId);
    } catch {
      // 이미 떨어진 포인터 — 잡을 것이 없다.
    }
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const view = viewRef.current;
    commit(zoomAt(view, view.scale * factor, { x: 0, y: 0 }), true);
  }, [commit]);

  const reset = useCallback(() => commit(IDENTITY, true), [commit]);

  const togglePlay = useCallback(() => {
    const video = mediaRef.current;
    if (!video || kind !== 'video') return;
    if (video.paused) void video.play()?.catch?.(() => undefined);
    else video.pause();
  }, [kind]);

  // React 의 onWheel 은 passive 라 preventDefault 가 안 된다 — 직접 단다. iOS Safari 의 gesture*
  // 이벤트는 페이지 자체 확대를 막으려고 끈다(touch-action 만으로 안 막히는 판이 있다).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      commit(zoomAt(view, view.scale * wheelZoomFactor(e.deltaY, e.deltaMode), toLocal(e.clientX, e.clientY)), false);
    };
    const stopNative = (e: Event) => e.preventDefault();
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('gesturestart', stopNative);
    stage.addEventListener('gesturechange', stopNative);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', stopNative);
      stage.removeEventListener('gesturechange', stopNative);
    };
  }, [commit, toLocal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
      else if (e.key === '0') reset();
    };
    // 화면을 돌리거나 창 크기가 바뀌면 이동 범위도 바뀐다.
    const onResize = () => commit(viewRef.current, false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [zoomBy, reset, commit]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest?.('button, a, [data-zoom-ignore]')) return;
    const p = toLocal(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 1) {
      const onContent = !!mediaRef.current?.contains(target);
      const zoomed = isZoomed(viewRef.current);
      const native = kind === 'video' && !zoomed && onContent;
      const touch = e.pointerType !== 'mouse';
      const mode: Mode = native ? 'none' : zoomed ? 'pan' : touch ? 'swipe' : 'none';
      gesture.current = { ...IDLE, mode, start: p, from: viewRef.current, t0: Date.now(), onContent, native };
      if (!native) capture(e.pointerId);
      if (mode === 'pan') setDragging(true);
      return;
    }

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      // 스와이프로 따라오던 위치에서 핀치로 넘어가면 그 위치를 먼저 제자리로 묶는다.
      const { stage, content } = sizes();
      const from = clampView(viewRef.current, content, stage);
      gesture.current = { ...IDLE, mode: 'pinch', start: midpoint(a, b), startDist: distance(a, b), from, moved: true };
      for (const id of pointers.current.keys()) capture(id);
      setDragging(true);
      e.preventDefault();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = toLocal(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;

    if (g.mode === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      commit(pinchView(g.from, g.start, g.startDist, midpoint(a, b), distance(a, b)), false);
      return;
    }

    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true;
    if (!g.moved) return;

    if (g.mode === 'pan') {
      commit({ scale: g.from.scale, x: g.from.x + dx, y: g.from.y + dy }, false);
    } else if (g.mode === 'swipe') {
      if (!g.axis) g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      // 갈 곳이 없는 방향은 끝에 닿은 것처럼 조금만 따라온다.
      const follow = g.axis === 'x' ? (onPrev && onNext ? 1 : 0.25) : (onDismiss ? 1 : 0.25);
      commit({ scale: 1, x: g.axis === 'x' ? dx * follow : 0, y: g.axis === 'y' ? dy * follow : 0 }, false, true);
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = toLocal(e.clientX, e.clientY);
    pointers.current.delete(e.pointerId);
    const g = gesture.current;

    if (g.mode === 'pinch') {
      if (pointers.current.size === 1) {
        // 남은 한 손가락은 이어서 이동만 한다 — 탭이나 스와이프로 바뀌지 않는다.
        const [rest] = [...pointers.current.values()];
        const zoomed = isZoomed(viewRef.current);
        gesture.current = { ...IDLE, mode: zoomed ? 'pan' : 'none', start: rest, from: viewRef.current, moved: true };
        setDragging(zoomed);
      }
      commit(viewRef.current, true);
      if (pointers.current.size === 0) finish(true);
      return;
    }
    if (pointers.current.size > 0) return;

    if (g.mode === 'swipe' && g.moved) {
      const swiped = cancelled ? null : classifySwipe(p.x - g.start.x, p.y - g.start.y, sizes().stage);
      const action = swiped === 'close' ? (onDismiss ? swiped : null) : swiped && onPrev && onNext ? swiped : null;
      if (action === null) {
        // 아무 일도 안 일어나면 제자리로 미끄러져 돌아간다.
        commit(IDENTITY, true);
      } else {
        const run = () => {
          if (action === 'prev') onPrev?.();
          else if (action === 'next') onNext?.();
          else onDismiss?.();
        };
        if (e.pointerType === 'touch') afterTouchEnds(run);
        else setTimeout(run, 0);
      }
    } else if (!g.moved && !cancelled && !g.native) {
      tap(p, g.onContent);
    }
    // 영상 컨트롤(재생 막대 등)의 손짓이었다면 그 click 은 컨트롤 몫이다.
    finish(g.moved && !g.native);
  };

  function finish(moved: boolean) {
    // 진행 중 제스처 객체는 고쳐 쓰므로(moved · axis) 공용 IDLE 을 그대로 넘기지 않는다.
    gesture.current = { ...IDLE };
    setDragging(false);
    if (moved) {
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    }
  }

  function tap(p: Point, onContent: boolean) {
    if (!onContent) return; // 바탕 탭은 click 으로 부모가 닫는다.
    if (kind === 'video') {
      if (isZoomed(viewRef.current)) togglePlay();
      return;
    }
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.t <= DOUBLE_TAP_MS && distance(last.p, p) <= DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      commit(toggleZoomAt(viewRef.current, p), true);
      return;
    }
    lastTap.current = { t: now, p };
  }

  const { view, animate } = state;
  const zoomed = isZoomed(view);
  const swipeFade = !zoomed && view.y !== 0 ? Math.max(0.35, 1 - Math.abs(view.y) / 400) : 1;
  const mediaStyle: React.CSSProperties = {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 6,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transformOrigin: 'center center',
    transition: animate ? 'transform 180ms ease-out, opacity 180ms ease-out' : 'none',
    opacity: swipeFade,
    pointerEvents: 'auto',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : kind === 'image' ? 'zoom-in' : undefined,
  } as React.CSSProperties;

  return (
    <div
      ref={stageRef}
      data-testid="zoom-stage"
      data-zoom-scale={view.scale.toFixed(2)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // 브라우저 · WebView 의 스크롤/페이지 확대 대신 이 무대가 손가락을 받는다.
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: '8px clamp(8px, 4vw, 56px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {kind === 'video' ? (
          <video
            ref={mediaRef}
            src={src}
            controls={!zoomed}
            autoPlay
            playsInline
            preload="metadata"
            onError={onError}
            onClick={(e) => e.stopPropagation()}
            style={{ ...mediaStyle, background: '#000' }}
          />
        ) : (
          <img
            ref={mediaRef}
            src={src}
            alt={alt}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onError={onError}
            onClick={(e) => e.stopPropagation()}
            style={mediaStyle}
          />
        )}
      </div>
      <div
        data-zoom-ignore
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.25)',
          background: 'rgba(0,0,0,0.55)',
        }}
      >
        <button type="button" aria-label="Zoom out" title="축소 (−)" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!zoomed} style={{ ...toolButton, opacity: zoomed ? 1 : 0.4 }}>
          −
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          title="맞춤 (0)"
          data-testid="zoom-stage-level"
          onClick={reset}
          style={{ ...toolButton, fontSize: 12, minWidth: 52, fontVariantNumeric: 'tabular-nums' }}
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" title="확대 (+)" onClick={() => zoomBy(ZOOM_STEP)} style={toolButton}>
          +
        </button>
      </div>
    </div>
  );
}
