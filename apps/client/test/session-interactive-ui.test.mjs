// Agent Session 의 상호작용 UI — jsdom 실렌더 단언.
//   1. 컴포저: `/` 를 치면 어댑터가 준 slash command 목록이 뜨고, Enter/Tab 은 전송이 아니라 선택이다.
//      이름 뒤에 인자를 치면 팝업이 닫히고 Enter 가 그대로 전송한다. Esc 는 팝업만 닫는다.
//   2. 트랜스크립트: 에이전트의 질문(ACP elicitation 폼)이 schema 대로 그려지고, 필수 필드를 채워야
//      Submit 이 열리며, 답이 요청 schema 의 타입으로 onAnswerElicitation 에 전달된다. Decline 도 된다.
// 실행: node --import tsx --test apps/client/test/session-interactive-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, keydown, typeInto, React, act } from './helpers/jsdom.mjs';
import SessionComposer from '../src/components/sessions/SessionComposer.tsx';
import SessionTranscript from '../src/components/sessions/SessionTranscript.tsx';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';

const h = React.createElement;

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter, 'change: 네이티브 value setter 를 찾지 못했습니다.');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const commands = [
  { name: 'review', description: 'Review the working tree', input_hint: 'optional focus' },
  { name: 'compact', description: 'Compact the context' },
  { name: 'review-branch', description: 'Review a branch' },
];

test('composer: slash popup lists matching commands; Enter picks instead of sending; arguments close it; Esc dismisses', async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands, onSend: (t) => { sent.push(t); }, onCancel() {} }));
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    assert.ok(textarea);
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), false, 'no popup before typing');

    typeInto(textarea, '/re');
    const items = () => [...document.querySelectorAll('[role="option"]')].map((el) => el.getAttribute('data-command'));
    assert.deepEqual(items(), ['review', 'review-branch'], 'prefix-filtered popup');
    assert.equal(String(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-command')), 'review', 'first match is selected');

    keydown('ArrowDown', { target: textarea });
    assert.equal(String(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-command')), 'review-branch', 'ArrowDown moves the selection');
    keydown('ArrowUp', { target: textarea });
    keydown('Enter', { target: textarea });
    assert.equal(sent.length, 0, 'Enter with the popup open does not send');
    assert.equal(textarea.value, '/review ', 'the command is filled in with a trailing space for its argument');
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), false, 'popup closes after picking');

    typeInto(textarea, '/review focus on auth');
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), false, 'typing arguments keeps the popup closed');
    keydown('Enter', { target: textarea });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent, ['/review focus on auth'], 'Enter now sends the slash command verbatim');

    typeInto(textarea, '/co');
    assert.deepEqual(items(), ['compact']);
    keydown('Escape', { target: textarea });
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), false, 'Esc closes the popup');
    assert.equal(textarea.value, '/co', 'text is untouched');
    keydown('Tab', { target: textarea });
    assert.equal(textarea.value, '/co', 'after Esc the popup stays closed for the same text');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('composer without commands never shows a popup and Enter sends', async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands: [], onSend: (t) => { sent.push(t); }, onCancel() {} }));
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    typeInto(textarea, '/status');
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), false, 'no popup without commands');
    keydown('Enter', { target: textarea });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent, ['/status']);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('transcript: an elicitation form renders from its schema, gates Submit on required fields, and reports typed answers', () => {
  const dom = setupDom();
  try {
    const answers = [];
    const blocks = buildTranscript([{
      id: 'e1', seq: 1, turn_id: 't1', type: 'elicitation_request', created_at: '2026-09-19T00:00:00.000Z',
      payload: {
        elicitation_id: 'elic-1', mode: 'form', message: 'Which environment should I deploy to?',
        schema: {
          type: 'object', title: 'Deployment target',
          properties: {
            env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] },
            replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 5, default: 2 },
            notes: { type: 'string', title: 'Notes', maxLength: 120 },
            dry_run: { type: 'boolean', title: 'Dry run' },
          },
          required: ['env'],
        },
      },
    }]);
    const view = mount(h(SessionTranscript, {
      blocks, decidingRequestId: null, permissionsEnabled: true,
      onDecidePermission() {},
      onAnswerElicitation: (id, action, content) => { answers.push({ id, action, content }); },
    }));
    const card = document.querySelector('[data-block="elicitation"]');
    assert.ok(card, 'question card rendered');
    assert.match(card.textContent, /Which environment should I deploy to\?/);
    const submit = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Submit');
    assert.ok(submit);
    assert.equal(submit.disabled, true, 'required field empty → Submit disabled');
    assert.match(card.textContent, /Fill in Environment/);

    change(card.querySelector('select[aria-label="Environment"]'), 'prod');
    assert.equal(submit.disabled, false, 'required field filled → Submit enabled');
    typeInto(card.querySelector('input[aria-label="Notes"]'), 'careful');
    click(card.querySelector('input[type="checkbox"]'));
    click(submit);
    assert.deepEqual(answers, [{ id: 'elic-1', action: 'accept', content: { env: 'prod', replicas: 2, notes: 'careful', dry_run: true } }], 'answer carries schema-typed values (integer default kept, boolean toggled)');

    // 답한 카드는 요약으로 바뀐다
    const answered = buildTranscript([
      ...[{ id: 'e1', seq: 1, turn_id: 't1', type: 'elicitation_request', created_at: '2026-09-19T00:00:00.000Z', payload: { elicitation_id: 'elic-1', mode: 'form', message: 'Q', schema: { type: 'object', properties: { env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] } }, required: ['env'] } } }],
      { id: 'e2', seq: 2, turn_id: 't1', type: 'elicitation_decision', created_at: '2026-09-19T00:00:01.000Z', payload: { elicitation_id: 'elic-1', action: 'accept', content: { env: 'prod' }, decided_by: 'user' } },
    ]);
    view.rerender(h(SessionTranscript, { blocks: answered, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {}, onAnswerElicitation() {} }));
    const done = document.querySelector('[data-block="elicitation"]');
    assert.equal(Boolean(done.querySelector('form')), false, 'no form once answered');
    assert.match(done.textContent, /Environment: prod/);
    assert.match(done.textContent, /by you/);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('transcript: Decline sends a decline without content, and a dead session locks the form', () => {
  const dom = setupDom();
  try {
    const answers = [];
    const blocks = buildTranscript([{ id: 'e1', seq: 1, turn_id: 't1', type: 'elicitation_request', created_at: '2026-09-19T00:00:00.000Z', payload: { elicitation_id: 'elic-2', mode: 'form', message: 'Proceed?', schema: { type: 'object', properties: { why: { type: 'string', title: 'Why' } } } } }]);
    const view = mount(h(SessionTranscript, { blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {}, onAnswerElicitation: (id, action, content) => { answers.push({ id, action, content }); } }));
    const card = document.querySelector('[data-block="elicitation"]');
    click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Decline'));
    assert.deepEqual(answers, [{ id: 'elic-2', action: 'decline', content: null }]);
    view.rerender(h(SessionTranscript, { blocks, decidingRequestId: null, permissionsEnabled: false, onDecidePermission() {}, onAnswerElicitation() {} }));
    const locked = document.querySelector('[data-block="elicitation"]');
    assert.ok([...locked.querySelectorAll('button')].every((b) => b.disabled), 'buttons locked when the session is not live');
    assert.match(locked.textContent, /Session is not live/);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});
