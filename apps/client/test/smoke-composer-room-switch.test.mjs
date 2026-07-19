// 실브라우저(jsdom) 스모크: 채팅 컴포저의 다중 작업(룸) 전환 리셋 계약
// (종합 상태 설계 · F2-3 §다중 작업 전환 · 98d0936e).
//
// ChatMessageInput 은 roomId 가 바뀌면 이전 룸의 draft·첨부·오류를 초기화한다
// (전송 전 행이 다른 룸에 orphan 되는 것 방지). Phase 1 composer 테스트는 jsdom
// 부재로 이 효과(React glue)를 실행하지 못했는데(composer-send.test 주석 참조),
// F2-1 하네스로 실마운트해 "룸 전환 → 컴포저 draft 비워짐" 계약을 고정한다.
//
// 워크스페이스 미설정 시 멘션 후보 fetch 는 early-return 하므로 네트워크 없이 마운트된다.
//
// 실행:  node --import tsx --test apps/client/test/smoke-composer-room-switch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, run, React } from './helpers/jsdom.mjs';
import ChatMessageInput from '../src/components/chat/ChatMessageInput.tsx';

const h = React.createElement;

// React 제어 컴포넌트의 textarea 에 "실제 타이핑"을 흉내낸다(네이티브 value 세터 +
// input 이벤트 → React onChange 발화).
function typeInto(textarea, value) {
  const proto = Object.getPrototypeOf(textarea);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  run(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('룸 전환 시 컴포저 draft 가 초기화된다(다중 작업 전환 리셋 계약)', () => {
  const dom = setupDom({ width: 1280 });
  // 워크스페이스 미설정 → 멘션 후보 fetch 없음(네트워크 격리).
  globalThis.localStorage = dom.window.localStorage;
  // 첨부 미리보기 URL API — 마운트/리셋 경로에서 호출될 수 있어 no-op 스텁.
  dom.window.URL.createObjectURL = () => 'blob:stub';
  dom.window.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL = dom.window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = dom.window.URL.revokeObjectURL;

  try {
    const view = mount(h(ChatMessageInput, { roomId: 'room-A', onSent: () => {}, isMobile: true }));
    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, '컴포저 textarea 가 렌더돼야 함');

    typeInto(textarea, '작성 중이던 초안');
    assert.equal(textarea.value, '작성 중이던 초안', '입력이 반영됨');

    // 다른 룸으로 전환 → roomId 효과가 draft 를 비운다.
    view.rerender(h(ChatMessageInput, { roomId: 'room-B', onSent: () => {}, isMobile: true }));
    const after = view.container.querySelector('textarea');
    assert.equal(after.value, '', '룸 전환 후 이전 룸 draft 는 남지 않는다');

    view.unmount();
  } finally {
    dom.cleanup();
  }
});
