// ConfirmRequestPanel — 사용자 Pass/Fail 화면의 렌더링·상호작용 회귀 테스트
// (티켓 5dbe4aa2).
//
// 소스에 JSX 가 있다는 사실은 이 화면이 동작한다는 증거가 못 된다 — 이 저장소에는
// `{cond && <div/>}` 가 false 로 접혀 화면에서 통째로 사라진 실버그 전례가 있다
// (orchestration-team-scope-display 테스트 헤더 참고). 그래서 정규식/소스 검사가
// 아니라 실제 DOM 마운트 뒤 사용자 동작을 흉내 내고, **전송된 payload** 와 **화면
// 상태**를 단언한다.
//
// 이 파일이 고정하는 계약:
//   1. `awaiting_user` step 만 카드로 뜬다(다른 상태는 이 화면의 대상이 아니다).
//   2. 증거가 링크 나열이 아니라 실제로 판정 가능한 형태로 그려진다 — 이미지는
//      <img>, 동영상은 <video>, 나머지 http(s) 는 링크.
//   3. Pass/Fail 이 각각 올바른 verdict 로, 입력한 피드백과 **그 step 의 visit** 과
//      함께 전송된다. visit 이 빠지면 서버의 stale-화면 방어가 통째로 무력해진다.
//   4. 제출 중에는 두 버튼이 모두 잠기고(중복 제출 방지), 어느 쪽을 눌렀는지 화면에
//      남는다.
//   5. 실패하면 카드가 사라지지 않고 다시 시도할 수 있다 — 사라지면 사용자가 자기
//      판정이 접수됐는지 알 수 없다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import ConfirmRequestPanel from '../src/components/orchestration/ConfirmRequestPanel.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { api } from '../src/api.ts';

const h = React.createElement;

const SCREENSHOT = { kind: 'screenshot', ref: 'https://cdn.example.com/preview-42.png', label: 'home page' };
const RECORDING = { kind: 'video', ref: 'https://cdn.example.com/flow.mp4', label: 'checkout flow' };
// kind 가 일반적인 'file' 이어도 확장자로 이미지임을 알아내야 한다. 서명된 스토리지
// URL 처럼 쿼리스트링이 붙은 경우까지 포함한다.
const SIGNED_IMAGE = { kind: 'file', ref: 'https://s3.example.com/shot.jpeg?sig=abc123&exp=99', label: '' };
const PREVIEW_URL = { kind: 'url', ref: 'https://preview.example.com/pr-42', label: 'live preview' };
const PLAIN_PATH = { kind: 'path', ref: 'apps/client/src/App.tsx', label: 'entry point' };

function step(overrides = {}) {
  return {
    id: 'step-gate',
    step_key: 'gate',
    title: 'Does the page look right?',
    instructions: 'Compare the screenshot against the mockup.',
    acceptance_criteria: '',
    depends_on: [],
    assignee_agent_id: null,
    assignee_name: '',
    assignee_online: false,
    status: 'awaiting_user',
    position: 1,
    plan_version: 1,
    room_id: null,
    result_summary: '',
    artifacts: [],
    attempt: 0,
    max_attempts: 2,
    dispatched_at: null,
    started_at: null,
    finished_at: null,
    workspace_folder: '',
    visit: 1,
    verdict: '',
    retry_policy: 'auto',
    recovery_reason: '',
    last_heartbeat_at: null,
    confirm_decision: null,
    ...overrides,
  };
}

/** api.submitOrchestrationStepConfirm 을 가로채 호출 인자를 기록한다. */
function stubSubmit(t, impl) {
  const calls = [];
  const original = api.submitOrchestrationStepConfirm;
  api.submitOrchestrationStepConfirm = async (stepId, data) => {
    calls.push({ stepId, data });
    return impl ? impl(stepId, data) : { already_decided: false };
  };
  t.after(() => {
    api.submitOrchestrationStepConfirm = original;
  });
  return calls;
}

async function render(t, { steps, onDecided = () => {} }) {
  const dom = setupDom();
  // ToastProvider 는 마운트 즉시 알림음 <audio> 를 만든다 — jsdom 에 Audio 가 없다.
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() {
      this.volume = 0;
      this.currentTime = 0;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  };
  const view = mount(
    h(ToastProvider, null, h(ConfirmRequestPanel, { steps, wsId: 'ws-1', onDecided })),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
    globalThis.Audio = previousAudio;
  });
  return view;
}

/**
 * 카드 안의 버튼을 라벨로 찾는다.
 *
 * `container` 전체가 아니라 카드 안에서만 찾는 이유: ToastProvider 가 자기 알림음
 * 토글 버튼(🔔)을 같은 트리에 렌더하므로, container 기준으로 "모든 버튼" 을 단언하면
 * 이 기능과 무관한 버튼까지 끌려들어와 단언이 거짓으로 넓어진다.
 */
const cardOf = (container) => {
  const card = container.querySelector('[data-testid="confirm-card"]');
  assert.ok(card, 'confirm 카드가 렌더돼야 한다');
  return card;
};
const cardButtons = (container) => [...cardOf(container).querySelectorAll('button')];
const buttonNamed = (container, label) =>
  cardButtons(container).find((b) => (b.textContent || '').trim() === label);

/** 다음 마이크로태스크까지 흘려보내 제출 후 상태 갱신을 반영한다. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ── 무엇이 뜨는가 ────────────────────────────────────────────────────────────

test('awaiting_user step 이 없으면 패널 자체가 렌더되지 않는다', async (t) => {
  const { container } = await render(t, {
    steps: [step({ status: 'done' }), step({ id: 'x', step_key: 'ship', status: 'dispatched' })],
  });
  assert.equal(container.querySelector('[data-testid="confirm-panel"]'), null);
  assert.equal(container.querySelector('[data-testid="confirm-card"]'), null);
});

test('awaiting_user step 만 카드로 뜨고, 질문과 pass 번호가 화면에 읽힌다', async (t) => {
  const { container } = await render(t, {
    steps: [
      step({ id: 'done-1', step_key: 'build', status: 'done' }),
      step({ visit: 2 }),
      step({ id: 'other', step_key: 'ship', status: 'pending' }),
    ],
  });
  const cards = [...container.querySelectorAll('[data-testid="confirm-card"]')];
  assert.equal(cards.length, 1, 'awaiting_user 인 것만 카드가 된다');
  assert.equal(cards[0].getAttribute('data-step-key'), 'gate');
  assert.match(cards[0].textContent, /Does the page look right\?/, '질문(title)이 보인다');
  assert.match(cards[0].textContent, /Compare the screenshot against the mockup\./, 'instructions 가 보인다');
  assert.match(cards[0].textContent, /pass 2/, 'loop 재진입 중이면 몇 번째 pass 인지 보여야 한다');
  assert.ok(buttonNamed(container, 'Pass'), 'Pass 버튼이 있다');
  assert.ok(buttonNamed(container, 'Fail'), 'Fail 버튼이 있다');
});

test('여러 게이트가 동시에 열려 있으면 각각 카드가 뜬다', async (t) => {
  const { container } = await render(t, {
    steps: [step(), step({ id: 'step-gate-2', step_key: 'gate2', title: 'And the mobile layout?' })],
  });
  const cards = [...container.querySelectorAll('[data-testid="confirm-card"]')];
  assert.deepEqual(
    cards.map((c) => c.getAttribute('data-step-key')),
    ['gate', 'gate2'],
  );
});

// ── 증거 렌더링(요구사항 2) ──────────────────────────────────────────────────

test('증거는 링크 나열이 아니라 실제로 판정 가능한 형태로 그려진다', async (t) => {
  const { container } = await render(t, {
    steps: [step({ artifacts: [SCREENSHOT, RECORDING, SIGNED_IMAGE, PREVIEW_URL, PLAIN_PATH] })],
  });

  const images = [...container.querySelectorAll('img')];
  assert.deepEqual(
    images.map((el) => el.getAttribute('src')).sort(),
    [SCREENSHOT.ref, SIGNED_IMAGE.ref].sort(),
    'kind=screenshot 과 쿼리스트링 붙은 .jpeg 가 모두 인라인 이미지로 그려져야 한다',
  );
  assert.equal(images[0].getAttribute('alt'), SCREENSHOT.label, '캡션이 alt 로 들어간다');

  const videos = [...container.querySelectorAll('video')];
  assert.equal(videos.length, 1);
  assert.equal(videos[0].getAttribute('src'), RECORDING.ref);
  assert.ok(videos[0].hasAttribute('controls'), '재생할 수 없는 동영상은 판정 근거가 되지 못한다');

  const links = [...container.querySelectorAll('a')];
  assert.deepEqual(links.map((el) => el.getAttribute('href')), [PREVIEW_URL.ref], 'http(s) 는 링크로');
  assert.equal(links[0].getAttribute('target'), '_blank', '미션 화면을 떠나지 않고 열려야 한다');
  assert.match(links[0].getAttribute('rel') || '', /noopener/);

  // http 가 아닌 참조(파일 경로)는 링크로 만들면 깨진 링크가 된다 — 텍스트로 보여준다.
  assert.match(container.textContent, /apps\/client\/src\/App\.tsx/);
  assert.ok(
    !links.some((el) => (el.getAttribute('href') || '').includes('App.tsx')),
    '파일 경로를 링크로 만들면 안 된다',
  );
});

test('증거가 하나도 없어도 카드는 뜨고 판정할 수 있다', async (t) => {
  const { container } = await render(t, { steps: [step({ artifacts: [] })] });
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.match(container.textContent, /did not attach anything to look at/, '왜 비었는지 설명한다');
  assert.ok(buttonNamed(container, 'Pass'), '증거가 없다고 판정 자체를 막지는 않는다');
});

// ── 제출 payload(요구사항 3·6) ───────────────────────────────────────────────

test('Pass 제출 — verdict/visit 이 그대로 실려 나가고, 빈 피드백은 보내지 않는다', async (t) => {
  const calls = stubSubmit(t);
  const decided = [];
  const { container } = await render(t, {
    steps: [step({ visit: 3 })],
    onDecided: () => decided.push(true),
  });

  click(buttonNamed(container, 'Pass'));
  await settle();

  assert.equal(calls.length, 1, '한 번만 전송된다');
  assert.equal(calls[0].stepId, 'step-gate');
  assert.equal(calls[0].data.workspace_id, 'ws-1');
  assert.equal(calls[0].data.verdict, 'pass');
  // visit 이 빠지면 서버의 stale-화면 대조가 통째로 무력해진다.
  assert.equal(calls[0].data.visit, 3, '화면이 본 pass 번호가 그대로 실려야 한다');
  assert.equal(calls[0].data.feedback, undefined, '빈 피드백은 필드 자체를 보내지 않는다');
  assert.equal(decided.length, 1, '성공하면 상위가 상세를 다시 읽도록 알린다');
});

test('Fail 제출 — 입력한 사유가 payload 에 그대로 들어간다(요구사항 5의 입력단)', async (t) => {
  const calls = stubSubmit(t);
  const { container } = await render(t, { steps: [step()] });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea, '사유 입력란이 있다');
  const FEEDBACK = 'The footer overlaps the CTA at 1280px.';
  typeInto(textarea, FEEDBACK);
  assert.equal(textarea.value, FEEDBACK, 'controlled input 이 실제로 반영된다');

  click(buttonNamed(container, 'Fail'));
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.verdict, 'fail');
  assert.equal(calls[0].data.feedback, FEEDBACK, '사용자가 쓴 문장이 잘리거나 바뀌면 안 된다');
});

test('제출 중에는 두 버튼이 모두 잠긴다 — 중복 클릭이 두 번 전송되지 않는다', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = stubSubmit(t, async () => {
    await gate;
    return { already_decided: false };
  });
  const { container } = await render(t, { steps: [step()] });

  click(buttonNamed(container, 'Pass'));
  await settle();

  const buttons = cardButtons(container);
  assert.deepEqual(
    buttons.map((b) => (b.textContent || '').trim()),
    ['Pass', 'Fail'],
    '카드 안의 버튼은 Pass/Fail 둘뿐이다',
  );
  assert.ok(
    buttons.every((b) => b.disabled),
    '진행 중에는 Pass/Fail 이 모두 잠겨야 한다 — 안 그러면 다른 판정이 겹쳐 들어간다',
  );
  // 어느 쪽을 눌렀는지가 화면에 남아야 한다 — 둘 다 똑같이 죽으면 사용자가 자기
  // 선택을 확인할 방법이 없다. Button 은 loading 일 때만 스피너를 그린다.
  const passButton = buttons.find((b) => (b.textContent || '').trim() === 'Pass');
  const failButton = buttons.find((b) => (b.textContent || '').trim() === 'Fail');
  assert.equal(passButton.querySelectorAll('span[aria-hidden="true"]').length, 1, '누른 쪽에 진행 표시가 뜬다');
  assert.equal(failButton.querySelectorAll('span[aria-hidden="true"]').length, 0, '누르지 않은 쪽엔 뜨지 않는다');

  // 잠긴 동안 다시 눌러도 전송되지 않는다.
  click(buttons[0]);
  click(buttons[1]);
  await settle();
  assert.equal(calls.length, 1, '진행 중 재클릭은 전송되지 않는다');

  release();
  await settle();
  assert.ok(cardButtons(container).every((b) => !b.disabled), '끝나면 다시 조작할 수 있어야 한다');
});

test('제출이 실패하면 카드가 사라지지 않고 다시 시도할 수 있다', async (t) => {
  let attempt = 0;
  const calls = stubSubmit(t, async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('stale confirmation for step "gate"');
    return { already_decided: false };
  });
  const decided = [];
  const { container } = await render(t, { steps: [step()], onDecided: () => decided.push(true) });

  click(buttonNamed(container, 'Pass'));
  await settle();

  assert.equal(decided.length, 0, '실패했는데 상위에 성공을 알리면 안 된다');
  assert.ok(container.querySelector('[data-testid="confirm-card"]'), '카드가 남아 있어야 재시도할 수 있다');
  assert.ok(
    cardButtons(container).every((b) => !b.disabled),
    '실패 후 버튼이 잠긴 채로 남으면 사용자가 영영 답할 수 없다',
  );

  click(buttonNamed(container, 'Pass'));
  await settle();
  assert.equal(calls.length, 2, '두 번째 시도가 실제로 전송된다');
  assert.equal(decided.length, 1);
});

test('이미 판정된 응답(already_decided)도 성공으로 다뤄 화면을 갱신한다', async (t) => {
  // 새로고침 후 같은 버튼을 다시 누른 경우다. 서버가 200 + already_decided 로
  // 답하므로, 이걸 실패로 다루면 사용자가 자기 판정이 접수되지 않았다고 오해한다.
  stubSubmit(t, async () => ({ already_decided: true }));
  const decided = [];
  const { container } = await render(t, { steps: [step()], onDecided: () => decided.push(true) });

  click(buttonNamed(container, 'Pass'));
  await settle();
  assert.equal(decided.length, 1, '상위가 상세를 다시 읽어 최신 상태를 그린다');
});
