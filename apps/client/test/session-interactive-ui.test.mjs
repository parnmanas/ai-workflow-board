import { ui, uiPattern } from './helpers/i18n.mjs';
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
    assert.deepEqual(sent, [{ text: '/review focus on auth', images: [] }], 'Enter now sends the slash command verbatim');

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
    assert.deepEqual(sent, [{ text: '/status', images: [] }]);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('composer: busy Enter sends straight away — the manager hands it to the running turn, nothing is held on screen', async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = mount(h(SessionComposer, {
      disabled: false, busy: true, placeholder: 'Prompt…', commands: [],
      onSend: (t) => { sent.push(t); },
      onCancel() {},
    }));
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    assert.equal(textarea.disabled, false, 'typing is not blocked while busy');
    const send = document.querySelector('button.awb-composer-send');
    assert.equal(send.textContent, 'Send', 'busy: the button still sends — there is no Queue mode');

    typeInto(textarea, 'first question');
    keydown('Enter', { target: textarea });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent, [{ text: 'first question', images: [] }], 'busy: Enter sends immediately');
    assert.equal(textarea.value, '', 'the composer clears once sent');

    typeInto(textarea, 'second question');
    keydown('Enter', { target: textarea });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent, [{ text: 'first question', images: [] }, { text: 'second question', images: [] }], 'a second message also goes out right away');
    assert.equal(Boolean(document.querySelector('[aria-label="Queued prompts"]')), false, 'no on-screen queue');

    // 턴이 끝나도(busy → false) 다시 보내지 않는다 — 화면에는 붙잡아 둔 것이 없다.
    act(() => { view.rerender(h(SessionComposer, {
      disabled: false, busy: false, placeholder: 'Prompt…', commands: [],
      onSend: (t) => { sent.push(t); },
      onCancel() {},
    })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(sent.length, 2, 'the busy→idle edge does not flush anything');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('composer: attach button takes images; text-empty image-only prompt still sends', async () => {
  const dom = setupDom();
  // jsdom 의 File 은 Node Blob 이 아니라 URL.createObjectURL 이 던진다 — 썸네일용으로만 스텁한다.
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(16).slice(2)}`;
  URL.revokeObjectURL = () => {};
  // setupDom 은 FileReader 를 전역에 올리지 않는다 — jsdom 구현을 빌려 쓴다.
  const hadFileReader = 'FileReader' in globalThis;
  if (!hadFileReader) globalThis.FileReader = window.FileReader;
  try {
    const sent = [];
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands: [], onSend: (p) => { sent.push(p); }, onCancel() {} }));
    const attachBtn = document.querySelector('button[aria-label="Attach images"]');
    assert.ok(attachBtn, 'paperclip button exists');
    const input = document.querySelector('input[aria-label="Attach images"]');
    assert.ok(input);
    assert.match(input.getAttribute('accept') || '', /image\/png/);
    assert.match(input.getAttribute('accept') || '', /^(?!.*svg).*$/, 'SVG 는 받지 않는다');

    const sendBtn0 = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    assert.equal(sendBtn0.disabled, true, '빈 텍스트 + 첨부 없음에는 전송이 막힌다');

    // PNG 선택 흉내 — input.files 는 읽기전용이라 defineProperty 로 꽂는다.
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const file = new window.File([pngBytes], 'shot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    const started = Date.now();
    const sendBtnNow = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    // 썸네일(읽는 중) → base64 resolve(전송 가능) 순서로 열린다.
    while (!document.querySelector('[aria-label="Attached images"] img') || sendBtnNow().disabled) {
      if (Date.now() - started > 5000) throw new Error('attachment never became sendable');
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
    // 보내기 전에 썸네일을 누르면 같은 라이트박스로 크게 본다.
    const thumbSrc = document.querySelector('[aria-label="Attached images"] img').getAttribute('src');
    click(document.querySelector('button[aria-label="Preview image shot.png"]'));
    const lightbox = document.querySelector('[data-testid="media-lightbox"]');
    assert.ok(lightbox, '첨부 썸네일이 라이트박스를 연다');
    assert.equal(lightbox.querySelector('[data-testid="zoom-stage"] img').getAttribute('src'), thumbSrc);
    click([...lightbox.querySelectorAll('button')].find((b) => /Close/.test(b.textContent)));
    assert.equal(Boolean(document.querySelector('[data-testid="media-lightbox"]')), false);

    const sendBtn = sendBtnNow();
    assert.equal(sendBtn.disabled, false, '그림만 있어도 전송이 열린다');
    click(sendBtn);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, '');
    assert.equal(sent[0].images.length, 1);
    assert.equal(sent[0].images[0].mime_type, 'image/png');
    assert.ok(sent[0].images[0].base64.length > 0);
    assert.equal(Boolean(document.querySelector('[aria-label="Attached images"]')), false, '전송되면 스트립이 비워진다');
    view.unmount();
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    if (!hadFileReader) delete globalThis.FileReader;
    dom.cleanup();
  }
});

test('composer: SVG 는 첨부 단계에서 거절된다', async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands: [], onSend: (p) => { sent.push(p); }, onCancel() {} }));
    const input = document.querySelector('input[aria-label="Attach images"]');
    const file = new window.File(['<svg/>'], 'v.svg', { type: 'image/svg+xml' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(Boolean(document.querySelector('[aria-label="Attached images"]')), false, 'SVG 는 첨부되지 않아 스트립이 생기지 않는다');
    const sendBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    assert.equal(sendBtn.disabled, true);
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

test('transcript: 토큰 줄 끝에 응답을 받은 시각이 붙는다', () => {
  const dom = setupDom();
  try {
    const now = new Date();
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5, 7);
    const blocks = buildTranscript([
      { id: 'p1', seq: 1, turn_id: 't1', type: 'user_prompt', created_at: at.toISOString(), payload: { text: 'q' } },
      { id: 'u1', seq: 2, turn_id: 't1', type: 'usage', created_at: at.toISOString(), payload: { input_tokens: 4, output_tokens: 493, cached_read_tokens: 159000, total_tokens: 159497 } },
    ]);
    const view = mount(h(SessionTranscript, { blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {} }));
    const line = document.querySelector('[data-block="usage"]');
    assert.ok(line, 'usage 줄이 그려진다');
    assert.match(line.textContent, /159k tokens/);
    assert.match(line.textContent, / · 09:05:07$/, '같은 날이면 시각만 붙는다');
    assert.match(line.getAttribute('title'), /received /, '툴팁에는 전체 날짜·시각');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('composer: command browser exposes all CLI commands and never replaces a draft', async () => {
  const dom = setupDom();
  try {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}`, description: `Skill ${i}` }));
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands: many, onSend() {}, onCancel() {} }));
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    const browse = document.querySelector('button[aria-label="Browse slash commands"]');
    click(browse);
    assert.equal(textarea.value, '/');
    assert.equal(document.querySelectorAll('[role="option"]').length, 25, 'commands past the old 12-item cap are selectable');
    for (let i = 0; i < 24; i++) keydown('ArrowDown', { target: textarea });
    keydown('Tab', { target: textarea });
    assert.equal(textarea.value, '/skill-24');
    typeInto(textarea, 'keep this draft');
    assert.equal(browse.disabled, true);
    click(browse);
    assert.equal(textarea.value, 'keep this draft');
    view.unmount();
  } finally { dom.cleanup(); }
});

test('composer: exact slash commands send on Enter; Shift+Enter does not pick or send', async () => {
  const dom = setupDom();
  try {
    const sent = [];
    const view = mount(h(SessionComposer, { disabled: false, busy: false, placeholder: 'Prompt…', commands, onSend: (p) => sent.push(p), onCancel() {} }));
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    typeInto(textarea, '/compact');
    keydown('Enter', { target: textarea, shiftKey: true });
    assert.equal(sent.length, 0);
    assert.equal(Boolean(document.querySelector('[role="listbox"]')), true);
    keydown('Enter', { target: textarea });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(sent, [{ text: '/compact', images: [] }]);
    view.unmount();
  } finally { dom.cleanup(); }
});


test('automatic continuation is a labelled note with a distinct appearance and expandable original text', () => {
  const dom = setupDom();
  try {
    const notice = '[Your previous response had no visible output. Please continue and produce a user-visible response.]';
    const blocks = buildTranscript([
      { id: 'history:1', seq: 1, turn_id: 't1', type: 'user_prompt', created_at: '', payload: { text: 'Continue my task' } },
      { id: 'history:2', seq: 2, turn_id: 't2', type: 'user_prompt', created_at: '', payload: { text: notice } },
    ]);
    const view = mount(h(SessionTranscript, { blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {} }));
    const user = document.querySelector('[data-block="prompt"]');
    const automatic = document.querySelector('[data-block="automatic-prompt"]');
    assert.equal(document.querySelectorAll('[data-block="prompt"]').length, 1);
    assert.match(user.textContent, /Continue my task/);
    assert.equal(automatic.getAttribute('role'), 'note');
    assert.equal(automatic.getAttribute('aria-label'), ui("자동 이어쓰기"));
    assert.match(automatic.textContent, uiPattern("표시된 응답이 없어 자동으로 이어쓰기를 요청했습니다."));
    assert.notEqual(automatic.style.background, user.style.background);
    const details = automatic.querySelector('details');
    assert.equal(details.open, false);
    assert.equal(details.querySelector('summary').textContent, ui("전송된 원문 보기"));
    click(details.querySelector('summary'));
    assert.equal(details.open, true);
    assert.ok(details.textContent.includes(notice), 'the sent prompt remains inspectable');
    view.unmount();
  } finally { dom.cleanup(); }
});

test('transcript: 직접 입력과 시스템·다른 세션·이미지 발신자가 눈에 띄게 구분된다', () => {
  const dom = setupDom();
  try {
    const blocks = buildTranscript([
      { id: 'p1', seq: 1, turn_id: 't1', type: 'user_prompt', created_at: '2026-10-11T12:00:00.000Z', payload: { text: 'hello' } },
      { id: 'p2', seq: 2, turn_id: 't2', type: 'user_prompt', created_at: '2026-10-11T12:01:00.000Z', payload: { text: '[AWB 작업 보고] 다른 세션 소식 1건입니다.\n\n1. 완료' } },
      { id: 'p3', seq: 3, turn_id: 't3', type: 'user_prompt', created_at: '2026-10-11T12:02:00.000Z', payload: { text: '[AWB 오퍼레이터 작업] Jarvis — 사용자 승인\n테스트 돌려줘' } },
      { id: 'p4', seq: 4, turn_id: 't4', type: 'user_prompt', created_at: '2026-10-11T12:03:00.000Z', payload: { text: 'User answer to your asynchronous question (x):\nQ' } },
      { id: 'p5', seq: 8, turn_id: 't5', type: 'user_prompt', created_at: '2026-10-11T12:04:00.000Z', payload: { text: '[AWB 재개] 직전 턴이 끊겼습니다. 이어서 진행하세요.' } },
      { id: 'i1', seq: 5, turn_id: 't1', type: 'image', created_at: '2026-10-11T12:00:01.000Z', payload: { image_ref: '', mime_type: 'image/png', size: 10, uri: 'https://example.com/a.png' } },
      { id: 'a1', seq: 6, turn_id: 't1', type: 'text', created_at: '2026-10-11T12:00:02.000Z', payload: { text: 'reply' } },
      { id: 'i2', seq: 7, turn_id: 't1', type: 'image', created_at: '2026-10-11T12:00:03.000Z', payload: { image_ref: '', mime_type: 'image/png', size: 10, uri: 'https://example.com/b.png' } },
    ]);
    const view = mount(h(SessionTranscript, { blocks, decidingRequestId: null, permissionsEnabled: true, onDecidePermission() {} }));
    const user = document.querySelector('[data-block="prompt"][data-origin="user"]');
    assert.ok(user, '직접 입력은 data-origin=user 파란 말풍선이다');
    assert.match(user.parentElement.parentElement.textContent, uiPattern("👤 직접 입력"));

    const report = document.querySelector('[data-block="operator-report"]');
    assert.ok(report, '다른 세션 보고는 별도 블록이다');
    assert.match(report.parentElement.textContent, uiPattern("📋 다른 세션 소식 · AWB 자동"));
    assert.notEqual(report.style.background, user.style.background, '직접 입력과 배경이 다르다');

    const task = document.querySelector('[data-block="operator-task"]');
    assert.ok(task, 'operator 작업은 별도 블록이다');
    assert.match(task.parentElement.textContent, uiPattern("제안 · 사용자 승인 — 내가 쓴 말이 아닙니다"));

    const async = document.querySelector('[data-block="async-answer"]');
    assert.ok(async, '비동기 답변 전달은 별도 블록이다');
    assert.match(async.parentElement.textContent, uiPattern("💬 질문 답변 자동 전달 · 시스템"));

    const resume = document.querySelector('[data-block="restart-resume"]');
    assert.ok(resume, '재시작으로 끊긴 턴의 재개는 사용자 말풍선이 아니라 시스템 블록이다');
    assert.match(resume.parentElement.textContent, uiPattern("🔄 재시작으로 끊긴 턴 이어서 · AWB"));
    assert.match(resume.textContent, /^\[AWB 재개\]/, '재개 문구는 그대로 보인다');

    // 직접 입력 말풍선은 오른쪽, 시스템·다른 세션은 왼쪽이다
    const userCol = user.closest('div[style]').parentElement;
    const reportCol = report.closest('div[style]').parentElement;
    assert.notEqual(userCol?.outerHTML, reportCol?.outerHTML);

    const images = [...document.querySelectorAll('[data-block="image"]')];
    assert.deepEqual(images.map((el) => el.getAttribute('data-from')), ['user', 'agent'], '보낸 그림과 받은 그림을 구분한다');
    assert.match(images[0].parentElement.textContent, uiPattern("🖼 보낸 이미지 · 내가 첨부"));
    assert.match(images[1].parentElement.textContent, uiPattern("🖼 에이전트 이미지"));
    view.unmount();
  } finally { dom.cleanup(); }
});
