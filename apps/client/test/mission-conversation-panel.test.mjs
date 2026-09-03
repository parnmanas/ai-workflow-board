// Mission 대화 패널 렌더링 회귀 테스트 (티켓 4d065f82).
//
// 보드 교훈 1번을 따른다: 사용자 동작 뒤의 화면 상태가 완료 기준이므로 소스 문자열
// 검사가 아니라 **실제 컴포넌트를 jsdom 에 마운트해** 단언한다. `{cond && <div/>}`
// 가 false 로 접혀 조용히 사라지는 실버그가 이 저장소에 이미 있었다
// (orchestration-plan-graph-view.test.mjs 헤더 참고).
//
// 커버 범위:
//   • 대화 메시지와 실행 이벤트가 **서로 다른 렌더러**로, 시간순으로 엮여 나온다
//   • 사용자가 보낸 메시지가 POST 응답과 SSE 브로드캐스트로 중복 도착해도 한 번만 그려진다
//   • SSE 로 도착한 다른 방 메시지는 이 패널에 새지 않는다
//   • 참여자가 아니면 observer 로 강등되고 입력창 대신 사유가 표시된다
//   • 종료된 미션은 입력창이 없고 기록 보존 안내가 나온다
//   • 미션이 시작 전(room 없음)이면 안내만 나오고 조회를 시도하지 않는다
//   • 긴 로그는 잘라 렌더링해 패널이 멈추지 않는다(pagination 상한)
//   • needs_recovery step 이 "Waiting" 으로 조용히 오표시되지 않는다

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import Panel from '../src/components/orchestration/MissionConversationPanel.tsx';

const h = React.createElement;

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const ROOM = 'room-mission-1';

function msg(id, content, overrides = {}) {
  return {
    id,
    room_id: ROOM,
    content,
    sender_type: 'user',
    sender_id: 'user-1',
    sender_name: 'Operator',
    type: 'text',
    attachments: [],
    created_at: '2026-06-01T00:00:10.000Z',
    ...overrides,
  };
}

function evt(id, type, message, createdAt) {
  return {
    id,
    type,
    step_id: null,
    step_key: '',
    actor_type: 'system',
    actor_id: '',
    actor_name: '',
    message,
    data: null,
    created_at: createdAt,
  };
}

/**
 * 패널 하나를 실제 BoardStreamProvider 아래에 띄우고, 정리까지 책임진다.
 * `getChatRoomMessages` 만 스텁하면 되므로 별도 DI 를 만들지 않고 api 모듈에 직접
 * 대입한다(이 저장소의 smoke-ticket-artifact-realtime.test.mjs 와 같은 관례).
 */
async function withPanel({ props, getChatRoomMessages }, body) {
  const dom = setupDom({ width: 1280 });
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const original = api.getChatRoomMessages;
  if (getChatRoomMessages) api.getChatRoomMessages = getChatRoomMessages;

  try {
    const view = mountWithBoardStream(h(Panel, props), { withAuth: false });
    await settle();
    await body({ view, es: () => FakeEventSource.instances[0] });
    view.unmount();
  } finally {
    api.getChatRoomMessages = original;
    uninstall();
    dom.cleanup();
  }
}

/** effect 안의 promise 들이 정착할 때까지 microtask 큐를 비운다. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function textOf(container) {
  return container.textContent || '';
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

test('대화 메시지와 실행 이벤트가 서로 다른 렌더러로 시간순으로 엮인다', async () => {
  await withPanel(
    {
      props: {
        missionId: 'mission-1',
        roomId: ROOM,
        live: true,
        events: [
          evt('e1', 'step_dispatched', 'Step "api" dispatched', '2026-06-01T00:00:20.000Z'),
          evt('e2', 'step_completed', 'Worker reported "api" as done', '2026-06-01T00:00:40.000Z'),
        ],
      },
      getChatRoomMessages: async () => [
        msg('m1', '이 미션 지금 어디까지 됐어?', { created_at: '2026-06-01T00:00:10.000Z' }),
        msg('m2', 'api 먼저 끝내줘', { created_at: '2026-06-01T00:00:30.000Z' }),
      ],
    },
    async ({ view }) => {
      const runs = view.container.querySelectorAll('[data-testid="mission-execution-run"]');
      const events = view.container.querySelectorAll('[data-testid="mission-execution-event"]');

      assert.equal(events.length, 2, '두 실행 이벤트가 모두 렌더링돼야 한다');
      assert.equal(
        runs.length,
        2,
        '두 이벤트 사이에 대화(00:00:30)가 끼어 있으므로 실행 구간이 두 덩어리로 나뉜다 — 시간순으로 엮인다는 증거',
      );

      // 실행 이벤트는 채팅 말풍선이 아니라 전용 렌더러로 나온다.
      assert.deepEqual(
        [...events].map((el) => el.getAttribute('data-event-type')),
        ['step_dispatched', 'step_completed'],
      );

      const text = textOf(view.container);
      assert.ok(text.includes('이 미션 지금 어디까지 됐어?'), '대화 메시지가 화면에 있어야 한다');
      assert.ok(text.includes('Step "api" dispatched'), '실행 이벤트가 화면에 있어야 한다');
    },
  );
});

test('POST 응답과 SSE 브로드캐스트로 같은 메시지가 두 번 와도 한 번만 그려진다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [],
    },
    async ({ view, es }) => {
      const sent = msg('dup-1', '중복되면 안 되는 지시');
      const source = es();
      assert.ok(source, 'BoardStreamProvider 가 EventSource 를 연다');

      await act(async () => {
        source.emit('chat_room_message', sent);
        await Promise.resolve();
      });
      await act(async () => {
        source.emit('chat_room_message', sent);
        await Promise.resolve();
      });
      await settle();

      const occurrences = textOf(view.container).split('중복되면 안 되는 지시').length - 1;
      assert.equal(occurrences, 1, '같은 id 의 메시지는 몇 번 도착하든 한 번만 그려져야 한다');
    },
  );
});

test('다른 방의 SSE 메시지는 이 패널에 새지 않는다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [],
    },
    async ({ view, es }) => {
      await act(async () => {
        es().emit('chat_room_message', msg('other-1', '남의 방 메시지', { room_id: 'room-other' }));
        await Promise.resolve();
      });
      await settle();

      assert.ok(
        !textOf(view.container).includes('남의 방 메시지'),
        '미션 room 이 아닌 메시지가 새어 들어오면 대화가 미션에 귀속된다는 계약이 깨진다',
      );
    },
  );
});

test('참여자가 아니면 observer 로 강등되고 입력창 대신 사유가 표시된다', async () => {
  const observerFlags = [];
  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async (_roomId, _limit, _before, observer) => {
        observerFlags.push(!!observer);
        if (!observer) throw new Error('not a participant of this room');
        return [msg('m1', '관전으로 읽는 메시지')];
      },
    },
    async ({ view }) => {
      assert.deepEqual(
        observerFlags,
        [false, true],
        '먼저 참여자로 시도하고, 거부될 때만 관전으로 재시도해야 한다',
      );
      assert.ok(
        view.container.querySelector('[data-testid="mission-conversation-observer-notice"]'),
        '권한이 없으면 조용히 빈 패널이 아니라 사유가 보여야 한다',
      );
      assert.ok(textOf(view.container).includes('관전으로 읽는 메시지'), '읽기는 가능해야 한다');
      assert.equal(
        view.container.querySelector('textarea'),
        null,
        '읽기 전용인데 입력창이 살아 있으면 보내지지 않는 지시를 쓰게 된다',
      );
    },
  );
});

test('종료된 미션은 입력창 없이 기록 보존 안내를 보여준다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: ROOM, live: false, events: [] },
      getChatRoomMessages: async () => [msg('m1', '완료 전 마지막 지시')],
    },
    async ({ view }) => {
      assert.ok(
        view.container.querySelector('[data-testid="mission-conversation-closed-notice"]'),
        '종료된 미션에는 보낼 orchestrator 세션이 없으므로 안내가 나와야 한다',
      );
      assert.equal(
        view.container.querySelector('textarea'),
        null,
        '종료된 미션에서 입력창이 살아 있으면 사용자가 허공에 지시를 보낸다',
      );
      assert.ok(
        textOf(view.container).includes('완료 전 마지막 지시'),
        '재시작·종료 후에도 기록은 그대로 보존돼 보여야 한다',
      );
    },
  );
});

test('아직 시작되지 않은 미션은 조회를 시도하지 않고 안내만 보여준다', async () => {
  let called = 0;
  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: null, live: true, events: [] },
      getChatRoomMessages: async () => {
        called += 1;
        return [];
      },
    },
    async ({ view }) => {
      assert.equal(called, 0, 'room 이 없는데 조회하면 매번 404 를 두드린다');
      assert.ok(textOf(view.container).includes('아직 시작되지 않아'));
    },
  );
});

test('긴 실행 로그는 상한까지만 렌더링해 패널이 멈추지 않는다', async () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    evt(`e${i}`, 'step_progress', `progress ${i}`, new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()),
  );

  await withPanel(
    {
      props: { missionId: 'mission-1', roomId: ROOM, live: true, events: many },
      getChatRoomMessages: async () => [],
    },
    async ({ view }) => {
      const rendered = view.container.querySelectorAll('[data-testid="mission-execution-event"]').length;
      assert.ok(rendered > 0, '이벤트가 있으면 뭔가는 보여야 한다');
      assert.ok(
        rendered < many.length,
        `500건을 전부 그리면 긴 미션에서 패널이 멈춘다 (렌더링된 수: ${rendered})`,
      );
      // 잘라내되 **최신** 쪽을 남겨야 운영자가 지금 상황을 본다.
      assert.ok(
        textOf(view.container).includes('progress 499'),
        '가장 최근 이벤트가 잘려나가면 지금 무슨 일이 벌어지는지 볼 수 없다',
      );
    },
  );
});

test('needs_recovery step 이 조용히 "Waiting" 으로 오표시되지 않는다', async () => {
  // stepStyle 은 모르는 상태를 pending(=Waiting, muted 회색)으로 fallback 한다.
  // 상태만 추가하고 스타일을 빠뜨리면 가장 급한 상태가 "대기 중"으로 보인다.
  const { stepStyle } = await import('../src/components/orchestration/status.ts');
  const recovery = stepStyle('needs_recovery');
  const waiting = stepStyle('pending');

  assert.notEqual(
    recovery.label,
    waiting.label,
    'needs_recovery 가 pending 으로 fallback 되면 운영자가 개입 필요를 알 수 없다',
  );
  assert.match(recovery.label, /recovery/i);
  assert.notEqual(recovery.color, waiting.color, '색까지 달라야 목록에서 눈에 띈다');
});
