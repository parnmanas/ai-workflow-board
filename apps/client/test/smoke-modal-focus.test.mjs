// 실브라우저(jsdom) 스모크: 공용 Modal 포커스 관리 통일 — F2-5 (ticket 10987a81).
//
// Modal 은 그동안 Esc 만 처리하고 초기 포커스·Tab 트랩·opener 복귀가 없었다. F2-5 에서
// ArtifactPanel 과 동일한 공용 훅(useDialogFocus)으로 통일했다. 이 스모크는 그 세 계약을
// react-dom/client 실마운트로 고정한다: (a) 열면 다이얼로그 내부 첫 포커스 요소로 이동,
// (b) Tab 이 배경으로 새지 않고 모달 안을 순환, (c) 닫으면 열었던 opener 로 포커스 복귀.
//
// 실행:  node --import tsx --test apps/client/test/smoke-modal-focus.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, click, keydown, React } from './helpers/jsdom.mjs';
import { Modal } from '../src/components/common/Modal.tsx';

const h = React.createElement;

// opener 버튼 + 상태로 여닫는 Modal. Modal 컴포넌트 자체는 항상 마운트돼 있어(열림만
// isOpen 으로 토글) 닫힐 때 훅의 복귀 effect 가 정상 실행된다. 다이얼로그 내부 포커스
// 가능한 요소는 필드(버튼) + 저장 버튼 2개. (input 대신 button 을 써 jsdom 의 React
// input value-change 폴리필 경고 노이즈를 피한다 — 포커스 계약 검증엔 무관.)
function ModalHarness() {
  const [open, setOpen] = React.useState(false);
  return h(
    React.Fragment,
    null,
    h('button', { 'data-testid': 'opener', onClick: () => setOpen(true) }, '열기'),
    h(
      Modal,
      {
        isOpen: open,
        onClose: () => setOpen(false),
        title: '샘플 모달',
        footer: h('button', { 'data-testid': 'save' }, '저장'),
      },
      h('button', { 'data-testid': 'field' }, '이름'),
    ),
  );
}

test('① 열면 다이얼로그(role=dialog·aria-modal) + 내부 첫 포커스 요소로 이동', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(ModalHarness));

    // 초기: 모달 닫힘
    assert.equal(document.querySelector('[role="dialog"]'), null);

    const opener = container.querySelector('[data-testid="opener"]');
    opener.focus(); // 복귀 대상으로 기억되도록 포커스 선점
    click(opener);

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, '클릭 후 모달이 열려야 함');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');

    // 열리면 내부 첫 포커스 요소(입력 필드)로 이동
    const field = document.querySelector('[data-testid="field"]');
    assert.equal(document.activeElement, field, '열리면 다이얼로그 내부 첫 요소에 포커스');
  } finally {
    dom.cleanup();
  }
});

test('② Tab 이 모달 안에 트랩된다(배경으로 새지 않고 순환)', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(ModalHarness));
    const opener = container.querySelector('[data-testid="opener"]');
    opener.focus();
    click(opener);

    const field = document.querySelector('[data-testid="field"]');
    const save = document.querySelector('[data-testid="save"]');
    assert.equal(document.activeElement, field, '초기 포커스: 필드');

    // 필드에서 Tab → 저장 버튼(다이얼로그 내부 다음 요소)
    keydown('Tab', { target: field });
    assert.equal(document.activeElement, save, 'Tab → 다음 내부 요소(저장)');

    // 저장에서 Tab → 랩어라운드하여 필드로(배경으로 새지 않음)
    keydown('Tab', { target: save });
    assert.equal(document.activeElement, field, '마지막에서 Tab → 처음으로 랩(트랩 유지)');

    // 필드에서 Shift+Tab → 역방향 랩하여 저장으로
    keydown('Tab', { target: field, shiftKey: true });
    assert.equal(document.activeElement, save, 'Shift+Tab → 역방향 랩(저장)');
  } finally {
    dom.cleanup();
  }
});

test('③ Esc 로 닫으면 opener 로 포커스 복귀', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(ModalHarness));
    const opener = container.querySelector('[data-testid="opener"]');
    opener.focus();
    click(opener);
    assert.ok(document.querySelector('[role="dialog"]'), '모달 열림');

    keydown('Escape');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'Esc 로 모달 닫힘');
    assert.equal(document.activeElement, opener, '닫으면 열었던 opener 로 포커스 복귀');
  } finally {
    dom.cleanup();
  }
});

test('④ 푸터 버튼 클릭(onClose)으로 닫아도 opener 로 복귀', () => {
  const dom = setupDom({ width: 1280 });
  try {
    const { container } = mount(h(ModalHarness));
    const opener = container.querySelector('[data-testid="opener"]');
    opener.focus();
    click(opener);

    // 저장 버튼이 onClose 를 부르도록 하네스를 바꾸는 대신, 배경 클릭으로 닫는다:
    // 오버레이(딤) 클릭 → onClose. (Modal 배경 onClick 계약)
    const backdrop = document.querySelector('[role="dialog"]').parentElement;
    click(backdrop);

    assert.equal(document.querySelector('[role="dialog"]'), null, '배경 클릭으로 닫힘');
    assert.equal(document.activeElement, opener, '닫으면 opener 로 복귀');
  } finally {
    dom.cleanup();
  }
});
