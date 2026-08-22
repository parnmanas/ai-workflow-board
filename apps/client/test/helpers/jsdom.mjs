// 경량 jsdom 마운트 하네스 (티켓 98d0936e · F2-1 · §회귀 안전망).
//
// Phase 1 은 브라우저/jsdom 러너 부재로 카드 클릭·`?ticket=` 딥링크·모바일 패널·
// 포커스트랩이 SSR/순수 로직 계약으로만 커버됐다(실브라우저 상호작용 미검증).
// 이 하네스는 기존 러너 관례(`node --import tsx --test`)를 그대로 쓰면서 jsdom 위에
// react-dom/client + act 로 실제 컴포넌트를 마운트해 그 상호작용을 실검증한다.
// vitest/playwright 같은 신규 프레임워크는 도입하지 않는다(jsdom devDep 하나만 추가).
import { JSDOM } from 'jsdom';

// react-dom 은 모듈이 최초 평가되는 시점에 canUseDOM(전역 window/document 존재 여부)을
// 딱 한 번만 검사해 isInputEventSupported 등 여러 동작을 그 결과로 영구 고정한다
// (react-dom/cjs/react-dom.development.js 의 `var canUseDOM = ...`). 이 파일이 react/
// react-dom 을 최상단에서 곧장 static import 하면 그 시점엔 아직 setupDom() 이 호출되지
// 않아 전역 window/document 가 없고, 그러면 react-dom 은 텍스트 input 의 네이티브 'input'
// 이벤트를 영구히 무시하는 IE9 이하용 propertychange 폴리필 경로로 고정돼버려 이후 몇 번을
// setupDom() 으로 진짜 jsdom window 를 마련해도 controlled input 의 onChange 가 다시는
// 발화하지 않는다(티켓 a9e2b1af — 네이티브 value setter 우회 기법 자체는 올바른데도 재현됨).
// 그래서 react/react-dom import 를 부트스트랩 jsdom window 설치 뒤로 미룬다 — canUseDOM 이
// 한 번이라도 true 로 평가되고 나면 이후 setupDom() 이 window/document 를 다른 인스턴스로
// 교체해도 이미 고정된 react-dom 내부 플래그에는 영향이 없다.
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');

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

/**
 * controlled 텍스트 input/textarea 에 실제 타이핑을 시뮬레이션한다. React 는 mount 시
 * 해당 DOM 노드의 `value` 프로퍼티를 자체 트래커로 감싸(인스턴스 own-property), 이후
 * `node.value = x` 대입이나 인스턴스에서 얻은 setter 호출은 트래커까지 함께 갱신해버려
 * onChange 가 "변경 없음"으로 판정돼 발화하지 않는다. 프로토타입에서 얻은 네이티브
 * setter 를 직접 `.call()`하면 트래커를 건드리지 않고 실제 DOM 값만 바뀌므로, 뒤이은
 * 'input' 이벤트에서 React 가 트래커-값 불일치를 감지해 onChange 를 정상적으로 태운다.
 */
export function typeInto(element, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (!setter) throw new Error('typeInto: no native value setter found on element prototype');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

export { React, act };
