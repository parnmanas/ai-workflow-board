// BoardStreamProvider 마운트 공용 헬퍼 (티켓 474bc091 · CI red e1b44465 재발 방지).
//
// BoardStreamProvider의 내부 pub/sub 버스는 Node 전역 EventTarget이고 CustomEvent로
// 디스패치하는데, jsdom.mjs의 setupDom()이 전역 Event/CustomEvent를 jsdom 것으로 덮어쓰면
// Node EventTarget이 이를 거부한다(ERR_INVALID_ARG_TYPE). installFakeEventSource()는
// setupDom() 이후 호출되면 이 전역들을 pristine Node 버전으로 복원하는 동시에
// globalThis.EventSource를 주입한다 — 두 문제는 항상 같은 원인(BoardStreamProvider가 실제로
// EventSource를 여는 경로, 즉 auth_token이 설정된 경우)에서만 함께 발생하므로 하나로 묶는다.
// auth_token이 없으면 BoardStreamProvider effect가 EventSource를 열기 전에 early-return하므로
// (smoke-deeplink.test.mjs, ticket-ref-card.test.mjs 참고) 이 함수 자체가 불필요하다.
import { AuthProvider } from '../../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../../src/contexts/BoardStreamContext.tsx';
import { mount, React } from './jsdom.mjs';

// setupDom()이 이 모듈을 import한 테스트 파일에서 처음 호출되기 전, 모듈 로드 시점에
// pristine Node 생성자를 붙잡아 둔다.
const NodeEvent = globalThis.Event;
const NodeCustomEvent =
  globalThis.CustomEvent ||
  class CustomEvent extends NodeEvent {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail ?? null;
    }
  };

class FakeEventSource {
  static instances = [];
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.onopen = null;
    this.onerror = null;
    this._listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    if (this.onopen) this.onopen();
  }
  emit(type, dataObj) {
    for (const fn of this._listeners[type] || []) fn({ data: JSON.stringify(dataObj) });
  }
}

/**
 * globalThis.EventSource를 FakeEventSource로 주입하고 Event/CustomEvent를 Node 네이티브로
 * 복원한다. setupDom() 이후 · mount 이전에 호출할 것. 반환된 uninstall()을 t.after()(또는
 * try/finally)에서 반드시 호출해 다음 테스트로 상태가 새지 않게 한다. FakeEventSource.instances는
 * 매 호출마다 새로 비워지므로 호출부에서 수동으로 리셋할 필요가 없다.
 */
export function installFakeEventSource() {
  const previousEventSource = globalThis.EventSource;
  globalThis.Event = NodeEvent;
  globalThis.CustomEvent = NodeCustomEvent;
  FakeEventSource.instances.length = 0;
  globalThis.EventSource = FakeEventSource;
  return {
    FakeEventSource,
    uninstall() {
      globalThis.EventSource = previousEventSource;
    },
  };
}

/**
 * BoardStreamProvider(+옵션 AuthProvider)로 감싸 마운트한다. 실제 App.tsx → AppLayout 트리
 * (AuthProvider가 바깥, AppLayout 내부의 BoardStreamProvider가 안쪽)와 동일한 순서로
 * AuthProvider(outer) > BoardStreamProvider(inner) > element 를 기본으로 쓴다.
 *
 * opts.withAuth=false 면 AuthProvider 없이 BoardStreamProvider만 씌운다(AuthContext를 쓰지
 * 않는 컴포넌트를 불필요한 컨텍스트 요구 없이 테스트할 때).
 * opts.wrap(tree)이 있으면 그 바깥에 추가로 씌운다(MemoryRouter 등, BoardStreamProvider보다
 * 더 바깥에 있어야 하는 것).
 *
 * 반환된 view.rerender(nextElement)는 매번 같은 옵션으로 재래핑한다 — react-dom의
 * root.render()는 루트 엘리먼트 타입이 바뀌면 트리를 통째로 unmount+remount하므로,
 * 래핑 없이 nextElement만 넘기면 BoardStreamProvider까지 함께 날아가 리렌더가 아닌
 * "항상 깨끗한 상태의 재마운트"가 되어버려 리렌더 계약을 검증하지 못하게 된다.
 */
export function mountWithBoardStream(element, opts = {}) {
  const { withAuth = true, wrap } = opts;
  const buildTree = (el) => {
    const withStream = React.createElement(BoardStreamProvider, null, el);
    const withAuthMaybe = withAuth
      ? React.createElement(AuthProvider, null, withStream)
      : withStream;
    return wrap ? wrap(withAuthMaybe) : withAuthMaybe;
  };

  const view = mount(buildTree(element));
  return {
    ...view,
    rerender(nextElement) {
      view.rerender(buildTree(nextElement));
    },
  };
}
