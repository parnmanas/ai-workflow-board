// helpers/jsdom.mjs 의 typeInto() 가 실제로 React controlled input 의 onChange 를
// 태우는지 검증하는 하네스 자체 회귀 테스트 (티켓 a9e2b1af).
//
// 배경: 네이티브 value setter 직접 호출 + 'input' 이벤트 dispatch 로 타이핑을 흉내내는
// 기존 관례(credential-reveal-ui.test.mjs 의 enterRevealPassword 등)가 이 저장소의
// jsdom 하네스에서 React onChange 를 전혀 태우지 못하는 근본 버그가 있었다 — react-dom 은
// 모듈 최초 평가 시점의 canUseDOM(전역 window/document 존재 여부)으로 isInputEventSupported
// 를 영구 고정하는데, jsdom.mjs 가 react-dom 을 setupDom() 호출보다 먼저 static import 해
// canUseDOM 이 false 로 고정돼 있었다(자세한 내용은 helpers/jsdom.mjs 상단 주석 참고).
// Provider/Context 트리와 무관하게 재현되므로 이 테스트는 순수 React.useState 컴포넌트만
// 마운트해 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, typeInto, React } from './helpers/jsdom.mjs';

function TextProbe({ onValue }) {
  const [value, setValue] = React.useState('');
  onValue(value);
  return React.createElement('input', {
    type: 'text',
    value,
    onChange: (e) => setValue(e.target.value),
  });
}

test('typeInto() 는 DOM 값뿐 아니라 React controlled state 도 onChange 를 거쳐 갱신한다', () => {
  const dom = setupDom();
  try {
    let lastValue = '';
    const view = mount(React.createElement(TextProbe, { onValue: (v) => { lastValue = v; } }));
    const input = view.container.querySelector('input');

    typeInto(input, 'hello world');

    assert.equal(input.value, 'hello world', 'DOM value 는 반영되어야 한다');
    assert.equal(lastValue, 'hello world', 'React state 도 onChange 를 거쳐 갱신되어야 한다');

    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('typeInto() 로 입력한 값은 이후 리렌더에도 되돌아가지 않는다 (React state 가 실제 source of truth)', () => {
  const dom = setupDom();
  try {
    let lastValue = '';
    const renderProbe = () => React.createElement(TextProbe, { onValue: (v) => { lastValue = v; } });
    const view = mount(renderProbe());
    const input = view.container.querySelector('input');

    typeInto(input, 'first');
    assert.equal(input.value, 'first');

    // onChange 가 태워지지 않았다면 React state 는 '' 로 남아있고, 아래 rerender 로
    // controlled input 이 '' 로 되돌아간다 — 이게 티켓이 설명한 은폐된 실패 모드다.
    view.rerender(renderProbe());
    assert.equal(input.value, 'first', 'onChange 로 React state 에 반영됐어야 리렌더 후에도 값이 유지된다');
    assert.equal(lastValue, 'first');

    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('typeInto() 는 textarea 에도 동일하게 동작한다', () => {
  const dom = setupDom();
  try {
    let lastValue = '';
    function TextareaProbe() {
      const [value, setValue] = React.useState('');
      lastValue = value;
      return React.createElement('textarea', {
        value,
        onChange: (e) => setValue(e.target.value),
      });
    }
    const view = mount(React.createElement(TextareaProbe));
    const textarea = view.container.querySelector('textarea');

    typeInto(textarea, 'multi\nline');

    assert.equal(textarea.value, 'multi\nline');
    assert.equal(lastValue, 'multi\nline');

    view.unmount();
  } finally {
    dom.cleanup();
  }
});
