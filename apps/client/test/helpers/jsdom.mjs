// 경량 jsdom 마운트 하네스 (티켓 98d0936e · F2-1 · §회귀 안전망).
//
// Phase 1 은 브라우저/jsdom 러너 부재로 카드 클릭·`?ticket=` 딥링크·모바일 패널·
// 포커스트랩이 SSR/순수 로직 계약으로만 커버됐다(실브라우저 상호작용 미검증).
// 이 하네스는 기존 러너 관례(`node --import tsx --test`)를 그대로 쓰면서 jsdom 위에
// react-dom/client + act 로 실제 컴포넌트를 마운트해 그 상호작용을 실검증한다.
// vitest/playwright 같은 신규 프레임워크는 도입하지 않는다(jsdom devDep 하나만 추가).
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

// react-dom 이 act() 경고 없이 동작하도록 하는 표준 플래그.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React 18.3 은 react 패키지에서 act 를 직접 노출한다(react-dom/test-utils 는 deprecated).
const act = React.act;

/** max-width 미디어쿼리를 뷰포트 폭으로 판정하는 matchMedia 스텁(useMediaQuery 용). */
function makeMatchMedia(width) {
  return (query) => {
    const m = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches = m ? width <= Number(m[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    };
  };
}

/**
 * jsdom 문서를 새로 만들고 전역(window/document/DOM 생성자/matchMedia)을 배선한다.
 * `width` 로 모바일/데스크톱 브레이크포인트를 스텁한다(모바일 스모크: width<=767).
 * 반환된 cleanup 으로 창을 닫아 테스트 간 격리를 유지한다.
 */
export function setupDom({ width = 1280, url = 'http://localhost/' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  // navigator 는 Node 전역이 read-only 라 덮어쓰지 않는다(React 는 전역 navigator 로 충분).
  for (const key of [
    'HTMLElement',
    'HTMLButtonElement',
    'Node',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'CustomEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    if (window[key]) globalThis[key] = window[key];
  }
  window.matchMedia = makeMatchMedia(width);
  globalThis.matchMedia = window.matchMedia;

  return {
    window,
    cleanup() {
      window.close();
    },
  };
}

/** act() 로 감싼 마운트. container 를 body 에 붙이고 root/rerender/unmount 를 돌려준다. */
export function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** act() 안에서 임의 동작(클릭·키다운 등)을 실행해 effect flush 를 보장한다. */
export function run(fn) {
  act(() => {
    fn();
  });
}

/** 버튼 등에 실제 click 이벤트를 디스패치(bubbles)한다. */
export function click(el) {
  run(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** 대상(기본 window)에 keydown 을 디스패치한다(Esc·Tab 등). */
export function keydown(key, { target = window, shiftKey = false } = {}) {
  run(() => {
    target.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

export { React, act };
